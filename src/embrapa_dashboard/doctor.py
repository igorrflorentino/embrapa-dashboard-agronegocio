"""Health-check probes for the local environment.

Run via ``embrapa doctor`` to validate ADC, GCP access, .env parsing, and
upstream API reachability before kicking off a long ingest, so credential /
connectivity issues surface immediately instead of mid-run.

**Cost, stated honestly.** A healthy run takes a few seconds. A BROKEN one does
not: the source probes are sequential and issue 10–11 HTTP requests at
``PROBE_TIMEOUT_S`` each, and since v1.95.2 each one gets ONE retry on a timeout or
dropped connection (``_probe``), so a network that times out everywhere costs around
200s (it was ~100s before the retry; a DNS failure answers at once, so it costs only
the 2s retry pause per request). The
BigQuery-backed checks add ~362 MB of scan (measured on prod, 2026-09-17), plus
10 MB — BigQuery's per-query billing minimum over a table of kilobytes — for
quality-drift since v1.91.0, all of it capped by ``_bq_job_config``. The docstrings
promised "~10 seconds … even when something is broken" for a long time, which was
wrong by an order of magnitude in exactly the case an operator sits watching the clock.
"""

from __future__ import annotations

import csv
import io
import itertools
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import google.auth
import requests
from google.cloud import bigquery, storage
from google.cloud.exceptions import Forbidden, NotFound

from embrapa_dashboard.backup import BACKUP_PREFIX, SUCCESS_MARKER
from embrapa_dashboard.bcb.client import SGS_URL
from embrapa_dashboard.config import Settings, get_credentials, get_settings
from embrapa_dashboard.discover import SIDRA_METADATA_URL

logger = logging.getLogger(__name__)

# Per-REQUEST timeout for the network probes. Not a budget for the command: the source
# probes run sequentially and issue 10–11 requests between them, each retried once on a
# transient failure, so a network that times out everywhere costs ~200s here plus the
# BigQuery reads below. `requests` applies this per
# socket operation (connect, then read), not per call, so a slow-drip server can exceed
# it. The docstrings used to promise "~10 seconds … even when something is broken",
# which was wrong by an order of magnitude in the only case anyone times.
PROBE_TIMEOUT_S = 10

# ONE retry for a failure that can clear up by itself: a timeout, a dropped connection,
# 429 or a 5xx. A 404 or 403 answers the same way twice, so it is not retried. Measured
# on 2026-09-25: the BCB SGS probe timed out (read timeout=10) in 2 of 4 local runs,
# while the ingest — which retries for up to 120 s per series — never failed on it.
# A probe that fails on a source's bad second teaches the operator to read
# "1 check(s) failed" as noise, and then the real failure is ignored too.
PROBE_RETRY_DELAY_S = 2.0
_TRANSIENT_STATUS = frozenset({429, 500, 502, 503, 504})


def _probe(method: str, url: str, **kwargs) -> tuple[requests.Response, str]:
    """GET or HEAD for a reachability probe, retried once on a transient failure.

    Returns the response and a NOTE for the check's detail: empty when the first
    attempt answered, otherwise what the first attempt got. A source that needed the
    retry is slow or flaky, and that is worth seeing even when the check passes.
    ``requests.get``/``requests.head`` are looked up at call time, so a test that
    patches them still intercepts every attempt.
    """
    kwargs.setdefault("timeout", PROBE_TIMEOUT_S)
    send = requests.head if method == "HEAD" else requests.get
    try:
        response = send(url, **kwargs)
        if response.status_code not in _TRANSIENT_STATUS:
            return response, ""
        first = f"HTTP {response.status_code}"
        response.close()
    except requests.Timeout:  # before ConnectionError: ConnectTimeout is both
        first = "timeout"
    except requests.ConnectionError:
        first = "connection error"
    time.sleep(PROBE_RETRY_DELAY_S)
    return send(url, **kwargs), f" (answered on retry; first attempt: {first})"


# How far behind today a foreign price index's LATEST observation may be before the
# series is presumed to have stopped. CPI-U for month M is released mid-M+1 and the HICP
# flash at the end of M, so a healthy series trails by at most ~2 months; 3 leaves room
# for a slipped release calendar. The ECB's `ICP` dataflow was 8 months stale when it
# was found (2026-09-23), still answering 200 with data for every window it covered.
FOREIGN_INDEX_MAX_LAG_MONTHS = 3


def _bq_job_config(settings: Settings) -> bigquery.QueryJobConfig:
    """Every BigQuery read this module makes, capped at ``BQ_MAX_BYTES_BILLED``.

    doctor is run ad hoc and repeatedly — during a debug session, before an ingest, in
    a fresh clone — and several of its checks scan Gold end to end: the
    ``gold_source_metadata`` view recomputes every counter over the five fact tables
    (171,7 MB measured on prod 2026-09-17), and the cataloged-code checks union every
    Gold code column (67,8 MB each). None of that was bounded, while the gateway and
    the catalog resolver have been passing this same ceiling all along. The cap does
    not make the scan smaller; it makes an unbounded one impossible — which is the
    property a health command that grows with the acervo actually needs.
    """
    return bigquery.QueryJobConfig(maximum_bytes_billed=settings.bq_max_bytes_billed)


def _gold_code_union(settings: Settings) -> str:
    """``(src, code)`` over every Gold fact table, as a UNION ALL subquery.

    Two checks need exactly this — "Catalog orphan lifecycle" and "Catalog → Gold
    arrival" — and each had built it from ``GOLD_CODE_SOURCES`` on its own. One copy, so
    a sixth banco cannot reach one check and miss the other. (Each still RUNS its own
    scan: they are separate registry entries with separate verdicts. Measured 67,8 MB
    apiece on prod, 2026-09-17.)
    """
    from embrapa_dashboard.serving import sql as sqlbuild

    return " union all ".join(
        f"select '{src}' as src, {col} as code from "
        f"`{sqlbuild.table_ref(settings, 'bq_gold_dataset', tbl)}`"
        for src, (tbl, col) in sqlbuild.GOLD_CODE_SOURCES.items()
    )


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


# Exceções que significam "não há dado para julgar" — instalação fria, máquina sem acesso
# ao prod, BigQuery fora do ar. Qualquer OUTRA exceção significa que o próprio check está
# quebrado. `google.auth` é importado no topo; as demais são as classes canônicas do
# api_core (`google.cloud.exceptions.NotFound` É `api_core.NotFound`, verificado).
_SEM_DADO_PARA_JULGAR: tuple[type[BaseException], ...] = (
    NotFound,  # tabela/dataset não existe
    Forbidden,  # sem permissão de leitura
    google.auth.exceptions.DefaultCredentialsError,  # sem ADC
    google.auth.exceptions.RefreshError,  # credencial expirada
)


def _skip_ou_quebra(nome: str, exc: BaseException) -> CheckResult:
    """Traduz a exceção de um check em CheckResult, separando duas coisas que um
    ``except Exception`` amplo confundia numa só.

    * **Ausência de dado** (tabela inexistente, sem permissão, sem credencial, BQ fora do
      ar): o check não tem o que julgar. Verde, ``skipped:`` — é o caso legítimo de uma
      instalação fria ou de uma máquina de dev sem acesso ao prod, e não pode pintar o
      doctor de vermelho.
    * **Check quebrado** (a consulta não compila porque uma coluna foi renomeada, ou o
      código levantou TypeError/KeyError): aqui o verde é uma MENTIRA. O guarda parou de
      guardar e informa que está tudo bem.

    Não é hipotético. ``Shared code across SIDRA tables`` consultava a coluna ``origem``,
    removida na v1.46.1, e passou a devolver verde com um ``skipped: 400 Unrecognized
    name`` que ninguém leu — o guarda do invariante daquela própria migração, cegado por
    ela, durante três versões. Um ``skipped`` verde é invisível num relatório 27/27.

    Nota deliberada: um check *advisory* quebrado também fica VERMELHO. "Advisory" governa
    o que o check faz quando CONSEGUE julgar; quando não consegue rodar, o operador precisa
    saber que o doctor está degradado — senão a próxima renomeação repete isto em silêncio.
    """
    if isinstance(exc, _SEM_DADO_PARA_JULGAR):
        return CheckResult(nome, True, f"skipped: {str(exc)[:100]}")
    return CheckResult(
        nome,
        False,
        f"CHECK QUEBRADO (não é falta de dado) — {type(exc).__name__}: {str(exc)[:110]}",
    )


def _check_env(settings: Settings) -> CheckResult:
    """The .env parsed and every per-source code mapping is well-formed.

    Touches all the lazily-parsed Settings properties (PEVS, PAM, PPM, BCB,
    COMEX, COMTRADE) — each raises ``ValueError`` on malformed input, and a
    mapping that only explodes mid-ingest is exactly what doctor exists to
    pre-empt.
    """
    try:
        infl = settings.inflation_series_map
        curr = settings.currency_series_map
        products = settings.product_codes
        pam_codes = settings.pam_product_codes_list
        ppm_herd_codes = settings.ppm_herd_product_codes_list
        ppm_animal_codes = settings.ppm_animal_product_codes_list
        ppm_herd_vars = settings.ppm_herd_variable_codes_list
        ppm_animal_vars = settings.ppm_animal_variable_codes_list
        comex_flows = settings.comex_flows_list
        comex_codes = {
            **settings.comex_ncm_map,
            **settings.comex_heading_map,
            **settings.comex_chapter_map,
        }
        comtrade_flows = settings.comtrade_flows_list
        comtrade_codes = settings.comtrade_cmd_map
        ppm_codes = len(ppm_herd_codes) + len(ppm_animal_codes)
        ppm_vars = len(ppm_herd_vars) + len(ppm_animal_vars)
        detail = (
            f"products={','.join(products)}  inflation={list(infl.keys())}  "
            f"currency={list(curr.keys())}  pam={len(pam_codes)} codes  "
            f"ppm={ppm_codes} codes/{ppm_vars} vars  "
            f"comex={'/'.join(comex_flows)} {len(comex_codes)} codes  "
            f"comtrade={'/'.join(comtrade_flows)} {len(comtrade_codes)} codes"
        )
        return CheckResult(".env parsed", True, detail)
    except Exception as exc:
        return CheckResult(".env parsed", False, str(exc)[:120])


def _check_pinned_end_years(settings: Settings) -> CheckResult:
    """No ingest window's END is pinned below the current year.

    Every ``*_END_YEAR`` defaults to the current year and should be left unset: a year a
    source has not published yet simply returns no rows, so the window can run ahead of
    the latest release. A pin below today stops the source at that year — and for IBGE it
    does worse than stop: once Bronze reaches the pin, the delta skips ENTIRELY, so the
    recent years' revisions are never re-fetched either. Measured on the production Job
    (2026-09-21): ``IBGE_END_YEAR=2024`` made every weekly PEVS-extração run a no-op while
    the silvicultura half, floating, re-fetched 2023-2026 in the same run.

    A warning, not a failure: a local pin can be deliberate (a reproducible historical
    run). It is the pin nobody remembers setting that this line exists for — the Job's
    came from an operator .env, which is why deploy.sh no longer forwards any END_YEAR.
    """
    try:
        this_year = datetime.now(UTC).year
        pinned = sorted(
            f"{name.upper()}={getattr(settings, name)}"
            for name in settings.model_fields_set
            if name.endswith("_end_year") and getattr(settings, name) < this_year
        )
        if not pinned:
            return CheckResult("Pinned END_YEAR", True, "none — every window floats to today")
        return CheckResult(
            "Pinned END_YEAR",
            True,
            f"⚠ {', '.join(pinned)} (below {this_year}): new years are never fetched, and "
            "the IBGE delta skips once Bronze reaches the pin — unset to let it float",
        )
    except Exception as exc:
        return CheckResult("Pinned END_YEAR", False, str(exc)[:120])


def _check_inflation_pivot_codes(settings: Settings) -> CheckResult:
    """Each Gold inflation pivot code must be present in BCB_INFLATION_SERIES.

    The Gold ``val_real_{ipca,igpm,igpdi}_*`` columns are built from these codes
    (read by dbt via ``env_var``). A pivot code that is not among the ingested
    series → those columns silently come out NULL. Catch the drift here instead
    of discovering empty real-value columns downstream in Looker / Gold consumers.
    """
    try:
        available = set(settings.inflation_series_map)
        missing = {
            label: code
            for label, code in settings.inflation_pivot_codes.items()
            if code not in available
        }
        if missing:
            return CheckResult(
                "Inflation pivot codes",
                False,
                f"not in BCB_INFLATION_SERIES: {missing} "
                f"(available={sorted(available)}) → Gold val_real_* would be NULL",
            )
        return CheckResult(
            "Inflation pivot codes",
            True,
            f"{settings.inflation_pivot_codes} all present",
        )
    except Exception as exc:
        return CheckResult("Inflation pivot codes", False, str(exc)[:120])


def _check_foreign_inflation_codes(settings: Settings) -> CheckResult:
    """Each foreign deflator must have a series id, and a plausible one for its API.

    The BCB counterpart checks membership in an ingested CODE:LABEL map. Here the
    ingested set IS the declared pair, so the drift worth catching is different: an
    EMPTY id (dbt would pivot on '' and NULL the column in silence), an ECB key with
    no dataflow prefix (the REST path is built by splitting at the first dot, so a
    prefix-less key would request a dataflow that does not exist and 404 forever), or a
    key still pointing at the ECB's retired `ICP` dataflow. That one is the dangerous
    case because nothing about it fails: the old key answers 200 with data up to
    2025-12 and then simply never advances, so an operator .env copied before the move
    would ingest cleanly forever while the € deflator stood still.
    """
    try:
        codes = settings.foreign_inflation_pivot_codes
        problems = [f"{label}: empty" for label, code in codes.items() if not code]
        hicp = codes.get("HICP", "")
        if hicp and "." not in hicp:
            problems.append(f"HICP: {hicp!r} has no ECB dataflow prefix (expected 'HICP.…')")
        elif hicp.startswith("ICP."):
            problems.append(
                f"HICP: {hicp!r} is in the ECB's ICP dataflow, frozen at 2025-12 — use the "
                "HICP dataflow (default 'HICP.M.U2.N.000000.4D0.INX', the same index 2025=100)"
            )
        if problems:
            return CheckResult(
                "Foreign inflation codes",
                False,
                "; ".join(problems) + " → Gold val_real_{cpi,hicp}_* would be NULL",
            )
        return CheckResult("Foreign inflation codes", True, f"{codes} all set")
    except Exception as exc:
        return CheckResult("Foreign inflation codes", False, str(exc)[:120])


# The canonical daily PTAX "venda" series (BRL per foreign unit): SGS 1 = USD,
# 21619 = EUR. The Gold FX/deflation math keys off these EXACT codes. The earlier
# 3694/4393(/20542) were wrong (3694 is annual, 4393 is not a BRL-per-unit rate),
# and a stale local .env carrying them parses fine but silently regresses every
# Gold ``val_yearfx_*`` column on the next ingest + rebuild — plausible-looking
# drift that slips review, which is exactly what this probe pre-empts.
_CANONICAL_CURRENCY_CODES = {"USD": "1", "EUR": "21619"}
_KNOWN_BAD_CURRENCY_CODES = {
    "3694": "annual USD, not the daily PTAX series",
    "4393": "not a BRL-per-unit FX rate",
    "20542": "deprecated/incorrect EUR series",
}


def _check_currency_series_codes(settings: Settings) -> CheckResult:
    """BCB_CURRENCY_SERIES must resolve to the canonical daily PTAX codes.

    A stale .env with the historical wrong codes (3694/4393/20542) parses fine but
    silently regresses the Gold FX columns on the next ingest + rebuild — the kind
    of plausible drift doctor exists to catch before it ships.
    """
    try:
        currency = settings.currency_series_map  # {code: label}
        by_label = {label.upper(): code for code, label in currency.items()}
        problems = [
            f"{label} should be series {want}, got {by_label.get(label)!r}"
            for label, want in _CANONICAL_CURRENCY_CODES.items()
            if by_label.get(label) != want
        ]
        bad = {code: why for code in currency if (why := _KNOWN_BAD_CURRENCY_CODES.get(code))}
        if bad:
            problems.append(f"known-wrong codes present: {bad}")
        if problems:
            return CheckResult(
                "Currency series codes",
                False,
                "; ".join(problems) + " → Gold val_yearfx_* would regress",
            )
        return CheckResult(
            "Currency series codes",
            True,
            f"canonical {by_label} (USD=1, EUR=21619)",
        )
    except Exception as exc:
        return CheckResult("Currency series codes", False, str(exc)[:120])


# The SIDRA variable codes silver_ibge_pam pivots, keyed to their dbt role (the
# pam_variable_* vars in dbt_project.yml). Each MUST be ingested (present in
# PAM_VARIABLE_CODES) or its Gold column comes out empty. Mirror dbt_project.yml:
# keep this in sync if a PAM variable is added/removed there.
_PAM_REQUIRED_VARIABLE_CODES = {
    "8331": "área plantada",
    "216": "área colhida",
    "214": "quantidade",
    "112": "rendimento",
    "215": "valor",
}


def _check_pam_variable_codes(settings: Settings) -> CheckResult:
    """Each PAM variable code the dbt model relies on must be in PAM_VARIABLE_CODES.

    silver_ibge_pam pivots these SIDRA variables (dbt vars pam_variable_*). A code
    dropped from PAM_VARIABLE_CODES is never fetched into Bronze, so its Gold column
    (área/quantidade/rendimento/valor) silently comes out empty. The config comment
    nominates ``embrapa doctor`` as the place for this parity check — this is it.
    """
    try:
        available = set(settings.pam_variable_codes_list)
        missing = {
            code: role
            for code, role in _PAM_REQUIRED_VARIABLE_CODES.items()
            if code not in available
        }
        if missing:
            return CheckResult(
                "PAM variable codes",
                False,
                f"not in PAM_VARIABLE_CODES: {missing} "
                f"(available={sorted(available)}) → that Gold column would be empty",
            )
        return CheckResult(
            "PAM variable codes",
            True,
            f"all {len(_PAM_REQUIRED_VARIABLE_CODES)} dbt PAM variables present",
        )
    except Exception as exc:
        return CheckResult("PAM variable codes", False, str(exc)[:120])


# The SIDRA t289 variable codes silver_ibge_pevs filters to, keyed to their dbt role
# (ibge_variable_* vars, env-bridged to config.ibge_variable_*_code). PEVS fetches
# v/all into Bronze, then Silver keeps ONLY these — a wrong code empties the matching
# Gold column silently. Mirror dbt_project.yml / config.py: keep in sync if changed.
_IBGE_REQUIRED_VARIABLE_CODES = {
    "144": "quantidade",
    "145": "valor",
}

# The silviculture half's analogues (SIDRA t291). Same failure mode as above: a mistyped
# code silently empties a Gold column instead of erroring.
_SILVICULTURA_REQUIRED_VARIABLE_CODES = {
    "142": "quantidade",
    "143": "valor",
}


def _check_ibge_variable_codes(settings: Settings) -> CheckResult:
    """The PEVS variable codes silver_ibge_pevs filters on must be the intended 144/145.

    silver_ibge_pevs keeps only ``ibge_variable_quantity``/``ibge_variable_value`` (dbt
    vars, env-bridged to ``config.ibge_variable_*_code``). A code mistyped in .env /
    dbt_project.yml silently drops that variable from Silver, emptying its Gold column
    (quantidade or valor) with no downstream error — the PEVS analogue of the PAM check.
    """
    try:
        configured = {settings.ibge_variable_quantity_code, settings.ibge_variable_value_code}
        missing = {
            code: role
            for code, role in _IBGE_REQUIRED_VARIABLE_CODES.items()
            if code not in configured
        }
        if missing:
            return CheckResult(
                "IBGE PEVS variable codes",
                False,
                f"not configured: {missing} (quantity={settings.ibge_variable_quantity_code!r}, "
                f"value={settings.ibge_variable_value_code!r}) → that Gold column would be empty",
            )
        return CheckResult(
            "IBGE PEVS variable codes",
            True,
            f"quantity={settings.ibge_variable_quantity_code}, "
            f"value={settings.ibge_variable_value_code}",
        )
    except Exception as exc:
        return CheckResult("IBGE PEVS variable codes", False, str(exc)[:120])


def _check_silvicultura_variable_codes(settings: Settings) -> CheckResult:
    """The t291 variable codes silver_ibge_silvicultura filters on must be 142/143.

    Exactly the PEVS check one table over. config.py declares the env keys and
    dbt/dbt_project.yml reads the SAME ones; nothing recomputes either from the other, so
    a typo in one drops that variable from Silver and empties its half of the Gold column
    with no downstream error.
    """
    try:
        configured = {
            settings.silvicultura_variable_quantity_code,
            settings.silvicultura_variable_value_code,
        }
        missing = {
            code: role
            for code, role in _SILVICULTURA_REQUIRED_VARIABLE_CODES.items()
            if code not in configured
        }
        if missing:
            return CheckResult(
                "IBGE silvicultura variable codes",
                False,
                f"not configured: {missing} "
                f"(quantity={settings.silvicultura_variable_quantity_code!r}, "
                f"value={settings.silvicultura_variable_value_code!r}) "
                "→ that Gold column would be empty for tabela='291' (silvicultura)",
            )
        return CheckResult(
            "IBGE silvicultura variable codes",
            True,
            f"quantity={settings.silvicultura_variable_quantity_code}, "
            f"value={settings.silvicultura_variable_value_code}",
        )
    except Exception as exc:
        return CheckResult("IBGE silvicultura variable codes", False, str(exc)[:120])


def _check_catalog_resolver_parity(settings: Settings) -> CheckResult:
    """Diff the catalog-resolved product codes vs the .env codes per IBGE banco.

    When ``catalog_authoritative_ingestion`` is on, the nightly ingestion pulls whatever the
    Curadoria catalog resolves — so before a run an operator wants to SEE any drift from the
    .env baseline (and confirm ``catalog-seed-from-env`` reproduced it). Informational
    (ok=True) even on drift: a researcher intentionally changing the catalog is the whole
    point, not an error. Reads the catalog directly (independent of the flag) so it also
    previews what a cutover WOULD change; also flags a banco that would trip the safety cap.
    """
    try:
        from embrapa_dashboard.ibge import catalog_resolver

        plan = [
            # PEVS spans two SIDRA tables since 2026-08-29, so it is compared PER TABLE
            # exactly like ppm. Comparing the token as a whole against IBGE_PRODUCT_CODES
            # (t289 only) reported the three silviculture codes as permanent DRIFT — a red
            # herring that is correct-by-design, and an operator who learns to ignore
            # doctor is the real cost.
            ("pevs", settings.ibge_table_id, settings.product_codes),
            ("pevs", settings.silvicultura_table_id, settings.silvicultura_product_codes_list),
            ("pam", None, settings.pam_product_codes_list),
            ("ppm", settings.ppm_herd_table_id, settings.ppm_herd_product_codes_list),
            ("ppm", settings.ppm_animal_table_id, settings.ppm_animal_product_codes_list),
        ]
        parts: list[str] = []
        drift = False
        for banco, tabela, env_codes in plan:
            cat = set(catalog_resolver.read_catalog_codes(settings, banco, tabela=tabela))
            label = banco + (f":{tabela}" if tabela else "")
            if not cat:
                parts.append(f"{label} vazio→.env({len(env_codes)})")
                continue
            added = sorted(cat - set(env_codes))
            removed = sorted(set(env_codes) - cat)
            if added or removed:
                drift = True
                parts.append(f"{label} +{added} -{removed}")
            else:
                parts.append(f"{label} OK({len(cat)})")
            if len(cat) > settings.catalog_resolver_max_codes:
                drift = True
                parts.append(f"{label} ACIMA-DO-CAP({len(cat)})")
        flag = "ON" if settings.catalog_authoritative_ingestion else "off"
        prefix = "DRIFT — " if drift else ""
        return CheckResult(
            "Catalog↔env product codes", True, f"[authoritative={flag}] {prefix}{' · '.join(parts)}"
        )
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Catalog↔env product codes", exc)


def _check_orphan_lifecycle(settings: Settings) -> CheckResult:
    """Soft-warn on catalog ORPHANS awaiting the auto-marker (the spec's doctor check).

    An orphan is a removal that LEFT DATA BEHIND: the entry's current state is a tombstone
    (active=false) AND its exact code still exists in that banco's Gold. Only those are
    marked by ``mark-orphans``, so only those may be counted here.

    Counting bare tombstones instead was wrong in a way that could never clear: a CLEAN
    removal (no lingering Gold rows) is never marked — correctly, there is nothing to
    purge — so `removed > marked` was the permanent steady state after any tidy-up. The
    check warned forever, blamed a build step that had in fact succeeded, and prescribed a
    `mark-orphans` run that was a guaranteed no-op. This repo's trade catalogs were migrated
    from 4-digit HS to NCM-8/HS-6 on 2026-07-02, leaving 20 such tombstones and a permanently
    red-herring advisory. An operator who learns to ignore doctor's output is the real cost.

    Advisory (ok=True): a legitimately removed product is expected, not an error. Flask-free
    (direct BQ over the small logs + a Gold semi-join) so it runs inside a bare
    ``embrapa doctor`` — hence sqlbuild.GOLD_CODE_SOURCES rather than importing gateway. Any
    fault (tables absent / perms) degrades to 'skipped'."""
    try:
        from embrapa_dashboard.gcp.clients import resolve_bq_client
        from embrapa_dashboard.serving import sql as sqlbuild

        bq = resolve_bq_client(settings)
        catalog_log = sqlbuild.table_ref(
            settings, "bq_research_inputs_dataset", settings.bq_produto_catalog_log_table
        )
        lifecycle_log = sqlbuild.table_ref(
            settings, "bq_research_inputs_dataset", settings.bq_catalog_lifecycle_log_table
        )
        # Same shape as gateway.fetch_orphan_produtos: tombstoned ⋈ Gold on the EXACT code.
        gold_union = _gold_code_union(settings)
        orphan_sql = f"""
            with tombstoned as (
              select codigo_produto, banco from (
                select codigo_produto, banco, active, row_number() over (
                  partition by {sqlbuild.CHAVE_CATALOGO} order by edited_at desc, change_id desc
                ) as _rn from `{catalog_log}`
              ) where _rn = 1 and not active
            ),
            gold_codes as ({gold_union})
            select count(*) as n from (
              select distinct t.codigo_produto, t.banco
              from tombstoned t
              join gold_codes g on g.src = t.banco and g.code = t.codigo_produto
            )
        """
        marked_sql = f"""
            select count(*) as n from (
              select status, row_number() over (
                partition by {sqlbuild.CHAVE_CICLO_DE_VIDA} order by edited_at desc, change_id desc
              ) as _rn from `{lifecycle_log}` where element_kind = 'commodity'
            ) where _rn = 1 and status in ('descontinuado', 'purged')
        """
        orphans = next(iter(bq.query(orphan_sql, job_config=_bq_job_config(settings)).result())).n
        marked = next(iter(bq.query(marked_sql, job_config=_bq_job_config(settings)).result())).n
        if orphans > marked:
            return CheckResult(
                "Catalog orphan lifecycle",
                True,
                f"{orphans} orphan(s) with Gold data, {marked} marked — {orphans - marked} "
                "unmarked; run `embrapa mark-orphans` (the build-boundary step may have failed).",
            )
        if orphans:
            return CheckResult("Catalog orphan lifecycle", True, f"{orphans} orphan(s), all marked")
        return CheckResult(
            "Catalog orphan lifecycle", True, "no orphans (no removal left Gold data behind)"
        )
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Catalog orphan lifecycle", exc)


def _check_adc(settings: Settings) -> CheckResult:
    """Application Default Credentials are present; reports impersonation target when set."""
    try:
        _credentials, project = google.auth.default()
        if settings.gcp_impersonation_sa:
            detail = f"project={project or '?'} → impersonating {settings.gcp_impersonation_sa}"
        else:
            detail = f"project={project or '?'}"
        return CheckResult("ADC credentials", True, detail)
    except Exception as exc:
        return CheckResult(
            "ADC credentials",
            False,
            f"{exc} (run `gcloud auth application-default login`)",
        )


def _check_bq(settings: Settings) -> CheckResult:
    """The configured GCP project is reachable for BigQuery."""
    try:
        creds = get_credentials(settings)
        client = bigquery.Client(
            project=settings.gcp_project_id, location=settings.bq_location, credentials=creds
        )
        sa = client.get_service_account_email()
        return CheckResult("BigQuery reachable", True, f"sa={sa}")
    except Exception as exc:
        return CheckResult("BigQuery reachable", False, str(exc)[:120])


def _check_gcs(settings: Settings) -> CheckResult:
    """The landing bucket is accessible (or will be created lazily on first ingest)."""
    try:
        creds = get_credentials(settings)
        client = storage.Client(project=settings.gcp_project_id, credentials=creds)
        # list_blobs requires only storage.objects.list (included in objectViewer).
        # bucket.exists() needs storage.buckets.get which objectViewer does not grant.
        try:
            next(client.list_blobs(settings.gcs_bucket, max_results=1), None)
            return CheckResult("GCS bucket", True, f"gs://{settings.gcs_bucket} (exists)")
        except NotFound:
            return CheckResult(
                "GCS bucket",
                True,
                f"gs://{settings.gcs_bucket} (will be created on first ingest)",
            )
    except Exception as exc:
        return CheckResult("GCS bucket", False, str(exc)[:120])


def _check_ibge(settings: Settings) -> CheckResult:
    """SIDRA metadata endpoint responds for the configured table."""
    url = SIDRA_METADATA_URL.format(table_id=settings.ibge_table_id)
    try:
        response, note = _probe("GET", url)
        response.raise_for_status()
        return CheckResult("IBGE SIDRA reachable", True, f"t{settings.ibge_table_id} 200 OK{note}")
    except Exception as exc:
        return CheckResult("IBGE SIDRA reachable", False, str(exc)[:120])


def _check_silvicultura(settings: Settings) -> CheckResult:
    """SIDRA metadata endpoint responds for the configured silviculture table (291)."""
    url = SIDRA_METADATA_URL.format(table_id=settings.silvicultura_table_id)
    try:
        response, note = _probe("GET", url)
        response.raise_for_status()
        return CheckResult(
            "IBGE SIDRA silvicultura reachable",
            True,
            f"t{settings.silvicultura_table_id} 200 OK{note}",
        )
    except Exception as exc:
        return CheckResult("IBGE SIDRA silvicultura reachable", False, str(exc)[:120])


def _check_pam(settings: Settings) -> CheckResult:
    """SIDRA metadata endpoint responds for the configured PAM table (5457)."""
    url = SIDRA_METADATA_URL.format(table_id=settings.pam_table_id)
    try:
        response, note = _probe("GET", url)
        response.raise_for_status()
        return CheckResult("IBGE PAM reachable", True, f"t{settings.pam_table_id} 200 OK{note}")
    except Exception as exc:
        return CheckResult("IBGE PAM reachable", False, str(exc)[:120])


def _check_ppm(settings: Settings) -> CheckResult:
    """SIDRA metadata endpoint responds for BOTH configured PPM tables (3939 + 74)."""
    tables = [settings.ppm_herd_table_id, settings.ppm_animal_table_id]
    try:
        notes = ""
        for table_id in tables:
            response, note = _probe("GET", SIDRA_METADATA_URL.format(table_id=table_id))
            response.raise_for_status()
            notes += f" t{table_id}{note}" if note else ""
        return CheckResult("IBGE PPM reachable", True, f"t{'+t'.join(tables)} 200 OK{notes}")
    except Exception as exc:
        return CheckResult("IBGE PPM reachable", False, str(exc)[:120])


def _check_bcb(settings: Settings) -> CheckResult:
    """BCB SGS responds for the first inflation series in .env.

    ``inflation_series_map`` is INSIDE the try, not just the ``next()`` around it: a
    malformed ``BCB_INFLATION_SERIES`` raises ``ValueError`` from ``_parse_code_label``,
    not ``StopIteration``, so catching only the latter let that escape into ``run_all``
    and kill the whole report — with the ``.env parsed`` row that had already diagnosed
    it never reaching the screen.
    """
    try:
        try:
            code = next(iter(settings.inflation_series_map))
        except StopIteration:
            return CheckResult("BCB SGS reachable", False, "BCB_INFLATION_SERIES is empty")
        # Hit the URL pattern the real client uses, with a tiny 1-year window so
        # we just verify reachability, not data correctness.
        url = SGS_URL.format(code=code, start="01/01/2024", end="31/12/2024")
        response, note = _probe("GET", url)
        response.raise_for_status()
        return CheckResult("BCB SGS reachable", True, f"sgs.{code} 200 OK{note}")
    except Exception as exc:
        return CheckResult("BCB SGS reachable", False, str(exc)[:120])


def _redact(text: str, secret: str) -> str:
    """Keep a configured API key out of a health-check line.

    The BLS key travels in the QUERY STRING, and requests puts the full URL into its
    exception messages ("404 Client Error: … for url: …&registrationkey=…"). So the
    one path that reports a failure is also the one that would print the secret to the
    operator's terminal and into whatever captures that output. Redact before
    truncating, never after: slicing a half-replaced string can leave a usable prefix.
    """
    return text.replace(secret, "***") if secret else text


def _months_behind(latest: date, today: date) -> int:
    return (today.year - latest.year) * 12 + (today.month - latest.month)


def _stale(latest: date, today: date) -> str | None:
    """The reason a series' latest observation is too old to vouch for, or None."""
    behind = _months_behind(latest, today)
    if behind <= FOREIGN_INDEX_MAX_LAG_MONTHS:
        return None
    return (
        f"latest observation {latest:%Y-%m} is {behind} months old — the series has "
        "stopped advancing (did the publisher move it?)"
    )


def _probe_bls(settings: Settings, today: date) -> tuple[bool, str]:
    cpi = settings.foreign_inflation_cpi_code
    first, last = today.year - 1, today.year
    # Probe the endpoint the INGEST will actually use. Keyless that is v1, whose 25/day
    # quota is counted per calling IP and so is shared with every other caller on that
    # address; with a key it is v2, whose 500/day quota belongs to the key. Probing v1
    # while the ingest runs keyed would spend a quota the real run never touches and
    # report a refusal it never meets — the mirror image of the false green above.
    keyed = bool(settings.bls_api_key)
    version = "v2" if keyed else "v1"
    url = (
        f"{settings.bls_api_base_url}/{version}/timeseries/data/{cpi}"
        f"?startyear={first}&endyear={last}"
    )
    if keyed:
        url = f"{url}&registrationkey={settings.bls_api_key}"
    try:
        # The URL carries the key when one is set; _probe never prints the URL.
        response, note = _probe("GET", url)
        response.raise_for_status()
        # BLS answers a throttle/quota refusal with HTTP 200 and a status string in the
        # BODY (the keyless v1 quota is 25 requests/day per calling IP), so
        # raise_for_status() alone paints an empty answer green — the single failure this
        # probe exists to catch. The ingest client learned this in _bls_window; the probe
        # has to know it too, or "Foreign inflation reachable" vouches for a refusal.
        payload = response.json()
        status = str(payload.get("status", "")) or "no status"
        if status != "REQUEST_SUCCEEDED":
            message = "; ".join(payload.get("message", []) or [])
            raise ValueError(f"{status}: {message}" if message else status)
        series = (payload.get("Results") or {}).get("series") or [{}]
        months = [
            date(int(row["year"]), int(str(row["period"])[1:]), 1)
            for row in series[0].get("data", []) or []
            if str(row.get("period", "")).startswith("M") and row.get("period") != "M13"
        ]
        if not months:
            raise ValueError("200 with no observations")
        # A 200 carrying data is still not proof the window was honoured. The keyless v1
        # GET ignores startyear/endyear and answers the latest three years whatever was
        # asked, which is why the 2026-09-14 backfill stored 3 years instead of 53 and
        # every check stayed green. Keyed, an answer outside the window is that same
        # defect on the path the ingest depends on; keyless, it is v1's known limit —
        # fine for a delta run, fatal for a backfill — so it is said, not failed.
        outside = sorted({m.year for m in months if not first <= m.year <= last})
        if outside and keyed:
            raise ValueError(
                f"BLS ignored the requested window {first}-{last} (answered {outside}) — "
                "a backfill would store the wrong years"
            )
        latest = max(months)
        reason = _stale(latest, today)
        if reason:
            raise ValueError(reason)
        detail = f"bls.{cpi} 200 OK (latest {latest:%Y-%m}){note}"
        if outside:
            detail += (
                " ⚠ keyless v1 ignores the requested years: fine for a delta, but a "
                "backfill needs BLS_API_KEY"
            )
        return True, detail
    except Exception as exc:
        return False, f"bls.{cpi} {_redact(str(exc), settings.bls_api_key)[:200]}"


def _latest_ecb_period(text: str) -> date | None:
    """The newest monthly period carrying a value in an SDMX csvdata body, or None."""
    latest: date | None = None
    for row in csv.DictReader(io.StringIO(text)):
        period = (row.get("TIME_PERIOD") or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}", period) or not (row.get("OBS_VALUE") or "").strip():
            continue
        month = date(int(period[:4]), int(period[5:]), 1)
        latest = month if latest is None or month > latest else latest
    return latest


def _probe_ecb(settings: Settings, today: date) -> tuple[bool, str]:
    hicp = settings.foreign_inflation_hicp_code
    dataflow, _, key = hicp.partition(".")
    # The LATEST observation, not a fixed past year. A fixed year cannot see a series that
    # stopped: the retired ICP key answers any window up to 2025 with data, and a probe
    # of `end_year - 1` kept vouching for it while it was eight months behind.
    url = (
        f"{settings.ecb_api_base_url}/{dataflow}/{key}"
        "?format=csvdata&detail=dataonly&lastNObservations=1"
    )
    try:
        response, note = _probe("GET", url)
        response.raise_for_status()
        # Same class of lie on the other publisher: a bogus series id is a clean 404
        # (raise_for_status catches it), but a series with nothing to report comes back
        # 200 with an EMPTY body. Require a valued observation, not just a header.
        latest = _latest_ecb_period(response.text)
        if latest is None:
            raise ValueError("200 with no observations")
        reason = _stale(latest, today)
        if reason:
            raise ValueError(reason)
        return True, f"ecb.{hicp} 200 OK (latest {latest:%Y-%m}){note}"
    except Exception as exc:
        return False, f"ecb.{hicp} {str(exc)[:200]}"


def _check_foreign_inflation(settings: Settings) -> CheckResult:
    """BLS and the ECB Data Portal each answer for their configured series — with data
    that is what was asked for, and recent.

    Two publishers, so the probe reports BOTH: a green line that hides one dead half
    would leave US$ or € silently un-deflatable — the failure this feature exists to
    remove. "Answers" means more than a 200: each publisher has shipped a 200 that was
    not the answer (BLS ignoring the requested years, the ECB serving a series that had
    stopped), so each half checks the answer against the request and against the
    calendar. Note: both hosts are blocked on Claude Code on the web.
    """
    today = datetime.now(UTC).date()
    bls_ok, bls_detail = _probe_bls(settings, today)
    ecb_ok, ecb_detail = _probe_ecb(settings, today)
    return CheckResult(
        "Foreign inflation reachable", bls_ok and ecb_ok, f"{bls_detail}; {ecb_detail}"
    )


def _check_comex(settings: Settings) -> CheckResult:
    """The Comex Stat file host serves a recent year's export file.

    A HEAD against ``EXP_<end_year>.csv`` verifies reachability without pulling
    the (100+ MB) body. Early in the year MDIC has not yet published the
    end-year file — the ingest pipeline classifies that 404 as an expected
    skip (see ``comex.pipeline``), so the probe falls back to the previous
    year's file instead of flagging a healthy environment as broken. Note:
    this host is blocked on Claude Code on the web — it only passes from a
    network with the MDIC domain reachable.

    The import and ``comex_flows_list`` are INSIDE the try: the property raises
    ``ValueError`` on an empty/invalid ``COMEX_FLOWS``, and reading it before the try
    let that escape into ``run_all`` and take the whole report down — on exactly the
    malformed ``.env`` this command exists to diagnose.
    """
    try:
        from embrapa_dashboard.comex.client import FILE_PREFIX, _ca_bundle

        flow = settings.comex_flows_list[0]
        prefix = FILE_PREFIX.get(flow, "EXP")
        end_year = settings.comex_end_year

        def _head(year: int) -> str:
            url = f"{settings.comex_csv_base_url.rstrip('/')}/{prefix}_{year}.csv"
            # The host omits its TLS intermediate — reuse the client's certifi+vendored
            # CA bundle so the probe verifies the same way the real download does.
            response, note = _probe("HEAD", url, allow_redirects=True, verify=_ca_bundle())
            response.raise_for_status()
            return note

        note = _head(end_year)
        return CheckResult("COMEX reachable", True, f"{prefix}_{end_year}.csv 200 OK{note}")
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status != 404:
            return CheckResult("COMEX reachable", False, str(exc)[:120])
    except Exception as exc:
        return CheckResult("COMEX reachable", False, str(exc)[:120])

    # 404 on the end-year file: expected when MDIC hasn't published it yet
    # (the same condition the ingest treats as a healthy skip). The host is
    # only broken if the previous year's file is unreachable too.
    try:
        note = _head(end_year - 1)
        return CheckResult(
            "COMEX reachable",
            True,
            f"{prefix}_{end_year - 1}.csv 200 OK{note} "
            f"({prefix}_{end_year}.csv not published yet — expected)",
        )
    except Exception as exc:
        return CheckResult("COMEX reachable", False, str(exc)[:120])


def _check_comtrade(settings: Settings) -> CheckResult:
    """UN Comtrade reachable + whether the API key is configured.

    The Reporters reference (keyless) confirms connectivity; the keyed ingest
    additionally needs COMTRADE_API_KEY — a missing key is a soft warning (the
    source is optional), not a hard failure.
    """
    from embrapa_dashboard.comtrade.client import REPORTERS_REF_URL

    try:
        # The reference host serves this static file over GET only — it 404s on
        # HEAD — so probe with a streamed GET and don't drain the body.
        response, note = _probe("GET", REPORTERS_REF_URL, allow_redirects=True, stream=True)
        response.close()
        response.raise_for_status()
    except Exception as exc:
        return CheckResult("COMTRADE reachable", False, str(exc)[:120])
    if not settings.comtrade_api_key:
        return CheckResult(
            "COMTRADE reachable",
            True,
            f"⚠ API 200 OK but COMTRADE_API_KEY unset (keyed ingest){note}",
        )
    return CheckResult("COMTRADE reachable", True, f"API 200 OK; key configured{note}")


def _check_bronze_tables(settings: Settings) -> CheckResult:
    """Report whether Bronze tables already exist (informational, never fails).

    Iterates ``BRONZE_TARGETS`` so new sources extend the check by appending a
    single tuple — see ``docs/adding_a_data_source.md``.
    """
    try:
        client = bigquery.Client(
            project=settings.gcp_project_id,
            location=settings.bq_location,
            credentials=get_credentials(settings),
        )
        targets = [
            (getattr(settings, dataset_attr), getattr(settings, table_attr))
            for dataset_attr, table_attr in BRONZE_TARGETS
        ]
        existing: list[str] = []
        missing: list[str] = []
        for dataset, table in targets:
            fqn = f"{settings.gcp_project_id}.{dataset}.{table}"
            try:
                client.get_table(fqn)
                existing.append(table)
            except NotFound:
                missing.append(table)
        if missing:
            detail = f"present={existing or '∅'}; missing={missing} (run ingest)"
        else:
            detail = f"all present: {existing}"
        return CheckResult("Bronze tables", True, detail)
    except Exception as exc:
        return CheckResult("Bronze tables", False, str(exc)[:120])


# ★ Extension point: each (dataset_attr, table) is an object the dashboard BFF
# reads. _check_serving_marts iterates over this list. dim_code_industrialization_scd2
# (the SCD2 curation view) is DELIBERATELY excluded: it is gated by
# `enable_curation` (make dbt-build-curation), so its absence is expected in a
# standard build and would raise a false alarm here.
SERVING_TARGETS: list[tuple[str, str]] = [
    ("bq_serving_dataset", "serving_pevs_annual"),
    ("bq_serving_dataset", "serving_pam_annual"),
    ("bq_serving_dataset", "serving_ppm_annual"),
    ("bq_serving_dataset", "serving_comex_annual"),
    ("bq_serving_dataset", "serving_comex_seasonality"),
    ("bq_serving_dataset", "serving_comtrade_annual"),
    ("bq_serving_dataset", "serving_quality_by_source"),
    # Not read by the BFF: the history `quality-drift` compares builds against. Listed so
    # the gate reports it missing/empty like any mart the build is supposed to produce.
    ("bq_serving_dataset", "serving_quality_history"),
    ("bq_gold_dataset", "gold_source_metadata"),
]


def _check_serving_marts(settings: Settings) -> CheckResult:
    """Report whether the serving objects the dashboard BFF reads exist + are populated.

    A deploy-readiness gate for the data layer: the dashboard's ``gateway.fetch_*``
    readers query these marts (+ ``gold_source_metadata`` for provenance). Informational
    like ``_check_bronze_tables`` — a fresh project has none until ``make dbt-build-prod``
    builds them, so a missing mart is reported (with the fix) rather than failing doctor.
    The emptiness check applies only to materialized marts: ``tables.get`` reports
    ``numRows: 0`` for VIEWs (e.g. ``gold_source_metadata``) regardless of their
    contents, so views are existence-only here to avoid a permanent false "empty"
    alarm.
    """
    try:
        client = bigquery.Client(
            project=settings.gcp_project_id,
            location=settings.bq_location,
            credentials=get_credentials(settings),
        )
        present, missing, empty = _classify_serving_marts(client, settings)
        parts: list[str] = []
        if missing:
            parts.append(f"missing={missing} (run `make dbt-build-prod`)")
        if empty:
            parts.append(f"⚠ empty={empty}")
        if not missing and not empty:
            parts.append(f"all present + populated: {present}")
        elif present:
            parts.append(f"present={present}")
        return CheckResult("Serving marts", True, "; ".join(parts))
    except Exception as exc:
        return CheckResult("Serving marts", False, str(exc)[:120])


def _classify_serving_marts(client, settings: Settings) -> tuple[list[str], list[str], list[str]]:
    """Sort each SERVING_TARGETS table into (present, missing, empty).

    A VIEW is existence-only (``tables.get`` reports numRows=0 for views even when
    their query yields rows); only a materialized mart with numRows==0 is "empty".
    """
    present: list[str] = []
    missing: list[str] = []
    empty: list[str] = []
    for dataset_attr, table in SERVING_TARGETS:
        dataset = getattr(settings, dataset_attr)
        fqn = f"{settings.gcp_project_id}.{dataset}.{table}"
        try:
            tbl = client.get_table(fqn)
        except NotFound:
            missing.append(table)
            continue
        present.append(table)
        if tbl.table_type == "VIEW":
            continue
        if tbl.num_rows == 0:  # 0 means an actually-empty materialized mart
            empty.append(table)
    return present, missing, empty


# ── Quality-tag drift ────────────────────────────────────────────────────────
# The window is the point, not a detail: doctor runs ad hoc, never on a schedule, so a
# check that only compared the LAST two builds would go quiet on the next identical build
# — and an operator who ran doctor three days later would never see the change. Every
# build pair inside the window is compared, so a shift stays reported until it ages out.
QUALITY_DRIFT_LOOKBACK_DAYS = 14
# A tag's share (of the banco's rows, or of its value) moving by this much between two
# builds. 2 p.p. is well above what an ingestion moves: a new PAM year adds ~2% rows,
# spread across every tag in proportion.
QUALITY_DRIFT_SHARE_PP = 0.02
# ...or its row count changing by this factor, for the tags too rare to move a share —
# PROBLEMÁTICO is 0,0002% of PAM, and 223 → 4 rows moved its share by 0,02 p.p.
QUALITY_DRIFT_FACTOR = 3.0
# Below this many rows a count is noise (PAM PROBLEMÁTICO went 4 → 6 in v1.90.0). Also the
# floor for a tag appearing or vanishing to count.
QUALITY_DRIFT_MIN_ROWS = 20
# How many builds to read. Two prod builds a week plus merges that touch dbt/ stay far
# below this inside the window; the cap only bounds the read.
_QUALITY_DRIFT_MAX_BUILDS = 60
_QUALITY_DRIFT_MAX_LINES = 8

_FlagStats = tuple[int, float, float | None]  # (n_rows, share, value_share)


def _quality_drifts(
    before: dict[tuple[str, str], _FlagStats], after: dict[tuple[str, str], _FlagStats]
) -> list[str]:
    """The (source, tag) pairs that moved between two builds, one line each.

    Three ways to move, because the tags live at very different scales. A share test alone
    misses the rare tags: the 1985 currency fix took PAM's PROBLEMÁTICO from 223 rows to 4,
    a 55× change that moved its share by 0,02 p.p. A count test alone misses the common
    ones: v1.90.0 moved PAM's OK from 843.735 to 1.029.948 rows, ×1,2, but 7,4 p.p. of the
    banco. And a tag can appear or vanish, which neither ratio expresses.
    """
    out: list[str] = []
    for key in sorted(set(before) | set(after)):
        n0, s0, v0 = before.get(key, (0, 0.0, None))
        n1, s1, v1 = after.get(key, (0, 0.0, None))
        label = f"{key[0]} {key[1]}"
        if n0 == 0 and n1 >= QUALITY_DRIFT_MIN_ROWS:
            out.append(f"{label} appeared ({n1:,} rows, {s1:.1%})")
            continue
        if n1 == 0 and n0 >= QUALITY_DRIFT_MIN_ROWS:
            out.append(f"{label} vanished (was {n0:,} rows, {s0:.1%})")
            continue
        reasons: list[str] = []
        if abs(s1 - s0) >= QUALITY_DRIFT_SHARE_PP:
            reasons.append(f"rows {n0:,} → {n1:,} ({s0:.1%} → {s1:.1%})")
        elif (
            min(n0, n1) > 0
            and max(n0, n1) / min(n0, n1) >= QUALITY_DRIFT_FACTOR
            and abs(n1 - n0) >= QUALITY_DRIFT_MIN_ROWS
        ):
            reasons.append(f"rows {n0:,} → {n1:,} (×{max(n0, n1) / min(n0, n1):.0f})")
        # value_share is NULL for a banco with no money at all; an absent side has no
        # base for a shift, so it is not read as a move from or to zero.
        if v0 is not None and v1 is not None and abs(v1 - v0) >= QUALITY_DRIFT_SHARE_PP:
            reasons.append(f"value {v0:.1%} → {v1:.1%}")
        if reasons:
            out.append(f"{label} " + ", ".join(reasons))
    return out


def _check_quality_drift(settings: Settings) -> CheckResult:
    """Did the quality donut move between two builds in the last two weeks?

    The detector's output was never watched over time, and it cost three months of wrong
    documentation: the 2026-06-26 calibration rates stayed in comments after the 1985
    currency fix (80464a3) moved PAM's PROBLEMÁTICO rows from 223 to 4 on 2026-06-27 —
    the detector doing its job, and nothing kept the 223 to compare against. Each build now
    appends the donut to `serving_quality_history`; this compares every consecutive pair
    of builds inside ``QUALITY_DRIFT_LOOKBACK_DAYS``.

    A warning, never a failure: the move can be the point of a release (v1.90.0 moved
    493.259 rows on purpose). What it guarantees is that a move is SEEN — a fix, a
    regression, or an ingestion that changed more than it should — instead of being found
    months later by someone rereading a comment.
    """
    name = "Quality-tag drift"
    try:
        client = bigquery.Client(
            project=settings.gcp_project_id,
            location=settings.bq_location,
            credentials=get_credentials(settings),
        )
        fqn = f"{settings.gcp_project_id}.{settings.bq_serving_dataset}.serving_quality_history"
        sql = f"""
            with builds as (
                select invocation_id, max(built_at) as built_at
                from `{fqn}`
                group by invocation_id
                order by built_at desc
                limit {_QUALITY_DRIFT_MAX_BUILDS}
            )
            select b.invocation_id, b.built_at, h.source, h.data_quality_flag,
                   h.n_rows, h.share, h.value_share
            from `{fqn}` h
            join builds b using (invocation_id)
        """
        rows = client.query(sql, job_config=_bq_job_config(settings)).result()
        builds: dict[str, tuple[datetime, dict[tuple[str, str], _FlagStats]]] = {}
        for row in rows:
            _, flags = builds.setdefault(row.invocation_id, (row.built_at, {}))
            flags[(row.source, row.data_quality_flag)] = (
                int(row.n_rows),
                float(row.share or 0.0),
                None if row.value_share is None else float(row.value_share),
            )
        ordered = sorted(builds.values(), key=lambda build: build[0])
        if len(ordered) < 2:
            return CheckResult(
                name,
                True,
                f"{len(ordered)} build(s) in serving_quality_history — nothing to compare yet",
            )

        since = datetime.now(UTC) - timedelta(days=QUALITY_DRIFT_LOOKBACK_DAYS)
        findings: list[str] = []
        compared = 0
        for (_, before), (built_at, after) in itertools.pairwise(ordered):
            if built_at < since:
                continue
            compared += 1
            stamp = f"{built_at:%Y-%m-%d %H:%M} UTC"
            findings += [f"{stamp} {drift}" for drift in _quality_drifts(before, after)]

        janela = (
            f"last {QUALITY_DRIFT_LOOKBACK_DAYS} days; moves of ≥{QUALITY_DRIFT_SHARE_PP:.0%} "
            f"share, or ×{QUALITY_DRIFT_FACTOR:.0f} with ≥{QUALITY_DRIFT_MIN_ROWS} rows"
        )
        if compared == 0:
            return CheckResult(
                name,
                True,
                f"no build in the last {QUALITY_DRIFT_LOOKBACK_DAYS} days to compare "
                f"(latest {ordered[-1][0]:%Y-%m-%d})",
            )
        if findings:
            shown = findings[:_QUALITY_DRIFT_MAX_LINES]
            more = len(findings) - len(shown)
            return CheckResult(
                name,
                True,  # warn, not fail — a move can be the point of a release
                "⚠ "
                + "; ".join(shown)
                + (f"; +{more} more" if more else "")
                + f" ({janela}). If the move was intended — a release that touched the "
                "detector or the data — say so in the CHANGELOG; it ages out of the window.",
            )
        return CheckResult(name, True, f"no tag moved across {compared} build pair(s) ({janela})")
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra(name, exc)


# `embrapa backup-gold` lays down prefixes shaped `backups/run=YYYYMMDDTHHMMSSZ/...`.
# The trailing slash is important — without it `list_blobs(delimiter="/")` would
# return individual blob names instead of the `run=*/` directory prefixes.
_BACKUP_PREFIX = f"{BACKUP_PREFIX}/"
# Derive the run-prefix pattern from BACKUP_PREFIX (the single source of truth in backup.py)
# rather than hardcoding 'backups/' — otherwise changing BACKUP_PREFIX would make this match
# nothing and falsely report "no snapshot" even with valid backups present.
_BACKUP_RUN_RE = re.compile(rf"^{re.escape(BACKUP_PREFIX)}/run=(\d{{8}}T\d{{6}}Z)/$")


def _list_backup_runs(client, settings: Settings) -> list[tuple[datetime, str]]:
    """All ``run=<ts>/`` prefixes under the backup root, parsed to (timestamp, prefix)."""
    # delimiter="/" turns this into a directory listing: blobs.prefixes yields the
    # run=*/ prefixes themselves, not the individual parquet parts beneath them.
    blobs = client.list_blobs(settings.gcs_bucket, prefix=_BACKUP_PREFIX, delimiter="/")
    # Iterating the page iterator is what populates `prefixes` — the
    # google-cloud-storage client only fetches them lazily.
    _ = list(blobs)
    runs: list[tuple[datetime, str]] = []
    for prefix in getattr(blobs, "prefixes", []) or []:
        match = _BACKUP_RUN_RE.match(prefix)
        if not match:
            continue
        try:
            ts = datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        except ValueError:
            continue
        runs.append((ts, prefix))
    return runs


def _snapshot_dataset(marker_blob) -> str | None:
    """The Gold dataset a sealed run snapshotted, read from its ``_SUCCESS`` manifest body;
    ``None`` if the body is unreadable or predates dataset recording (legacy snapshot)."""
    try:
        return json.loads(marker_blob.download_as_text()).get("dataset")
    except Exception:
        return None


def _latest_complete_run(client, settings: Settings, runs: list[tuple[datetime, str]]):
    """Newest run that both carries the ``_SUCCESS`` marker AND snapshotted the dataset now
    configured (``settings.bq_gold_dataset``), and how many newer runs were skipped.

    Returns ``(latest_ts_or_None, skipped)``. Partial/failed runs (no marker) are skipped — a
    crashed half-backup must not satisfy freshness. A COMPLETE run whose manifest records a
    DIFFERENT dataset is also skipped: dev (dbt_dev_gold) and prod (gold) hold identically
    named tables under one bucket prefix, so a dev-pointed-.env snapshot must never satisfy a
    prod freshness/backup gate (nor vice-versa). A legacy manifest with no recorded dataset is
    assumed to match (backward compatibility with snapshots taken before it was recorded).
    """
    bucket = client.bucket(settings.gcs_bucket)
    skipped = 0
    for ts, prefix in sorted(runs, reverse=True):  # newest first
        marker = bucket.blob(f"{prefix}{SUCCESS_MARKER}")
        if not marker.exists():
            skipped += 1
            continue
        snap_dataset = _snapshot_dataset(marker)
        if snap_dataset is not None and snap_dataset != settings.bq_gold_dataset:
            skipped += 1
            continue
        return ts, skipped
    return None, skipped


def _check_backup_freshness(settings: Settings) -> CheckResult:
    """Warn when the most recent COMPLETE Gold snapshot is older than BACKUP_STALENESS_DAYS.

    Only snapshots sealed with the ``_SUCCESS`` manifest (written by
    ``backup.run`` after the last extract) count: a crashed half-backup leaves a
    ``run=<ts>/`` prefix without the marker and must not satisfy freshness —
    the operator would believe the cold-storage rollback path is intact while
    most Gold tables are missing from it.

    Fails (ok=False) when no complete snapshot exists at all — that means the
    operator has never (successfully) run ``make dbt-build-prod-with-backup``
    (or its CLI equivalent), which is a real gap for any project past its
    first prod build.

    Stale (older than threshold) is reported with ok=True + a ⚠ marker so it
    doesn't flip `doctor` to exit-1 — matching the soft-warning pattern in
    `_check_bronze_tables`.
    """
    try:
        creds = get_credentials(settings)
        client = storage.Client(project=settings.gcp_project_id, credentials=creds)
        runs = _list_backup_runs(client, settings)
        if not runs:
            return CheckResult(
                "Gold backup freshness",
                False,
                f"no snapshot under gs://{settings.gcs_bucket}/{_BACKUP_PREFIX} "
                "(run `make dbt-build-prod-with-backup`)",
            )

        latest, incomplete_skipped = _latest_complete_run(client, settings, runs)
        if latest is None:
            return CheckResult(
                "Gold backup freshness",
                False,
                f"{len(runs)} snapshot(s) under gs://{settings.gcs_bucket}/{_BACKUP_PREFIX} "
                f"but none is a COMPLETE snapshot of dataset {settings.bq_gold_dataset!r} "
                f"(missing {SUCCESS_MARKER} marker, or a snapshot of a different dataset) "
                "(run `make dbt-build-prod-with-backup`)",
            )

        skipped_note = (
            f"; ⚠ skipped {incomplete_skipped} newer run(s) (incomplete or other-dataset)"
            if incomplete_skipped
            else ""
        )
        age = datetime.now(UTC) - latest
        age_days = age.days  # whole days, for the human-readable message
        latest_str = latest.strftime("%Y-%m-%d %H:%M UTC")
        threshold = settings.backup_staleness_days
        # Compare on the FRACTIONAL age so a snapshot 14d23h old is already stale at a
        # 14d threshold — `.days` truncates toward zero, which would let it pass for up
        # to a full extra day past the literal threshold (DOC-1).
        if age.total_seconds() / 86400 > threshold:
            return CheckResult(
                "Gold backup freshness",
                True,  # warn, not fail — matches _check_bronze_tables semantics
                f"⚠ stale: latest={latest_str} ({age_days}d ago > {threshold}d threshold)"
                f"{skipped_note}",
            )
        return CheckResult(
            "Gold backup freshness",
            True,
            f"latest={latest_str} ({age_days}d ago, threshold={threshold}d){skipped_note}",
        )
    except Exception as exc:
        return CheckResult("Gold backup freshness", False, str(exc)[:120])


def _check_curation_backup(settings: Settings) -> CheckResult:
    """Does the newest sealed snapshot COVER the researcher-authored data?

    Gold is derivable — losing it costs a ``dbt build``, because every row traces back to
    Bronze. ``research_inputs`` is authored: the produto catalog, the agrupamentos
    registry, the industrialization classifications, the lifecycle log and the editor
    allowlists. Nothing recomputes it. Until 2026-08-29 the backup introspected the Gold
    dataset ALONE, so the one irreplaceable dataset in the project was the one with no
    snapshot, while the reproducible half had a near-daily one.

    FAILS (ok=False) when the newest snapshot predates that coverage: a stale-but-present
    Gold backup would otherwise read as "backed up" on the freshness line while every
    curation decision sits unprotected. An absent ``curation_table_count`` key means "taken
    before coverage existed" — different from ``0``, which means "covered, dataset empty".
    """
    try:
        newest = _newest_sealed_manifest(settings)
        if isinstance(newest, str):
            return CheckResult("Curation backup coverage", True, f"skipped: {newest}")
        quando, corpo = newest
        n = corpo.get("curation_table_count")
        if n is None:
            return CheckResult(
                "Curation backup coverage",
                False,
                f"newest snapshot ({quando}) predates curation coverage — the authored "
                "catalog/classifications are NOT in it; run `make backup-gold`",
            )
        return CheckResult(
            "Curation backup coverage", True, f"{n} curation table(s) in {quando} snapshot"
        )
    except Exception as exc:
        return _skip_ou_quebra("Curation backup coverage", exc)


def _newest_sealed_manifest(settings: Settings) -> tuple[str, dict] | str:
    """(when, manifest) of the newest SEALED snapshot of this environment's Gold, or the
    reason there is none ("no snapshot yet" / "no sealed snapshot").

    Sealed = its ``_SUCCESS`` marker landed (a crashed run has none). A snapshot of another
    dataset (a dev .env pointed at ``dbt_dev_gold``) is skipped: it must not vouch for prod.
    """
    creds = get_credentials(settings)
    client = storage.Client(project=settings.gcp_project_id, credentials=creds)
    runs = _list_backup_runs(client, settings)
    if not runs:
        return "no snapshot yet"
    bucket = client.bucket(settings.gcs_bucket)
    for ts, prefix in sorted(runs, reverse=True):
        marker = bucket.blob(f"{prefix}{SUCCESS_MARKER}")
        if not marker.exists():
            continue
        corpo = json.loads(marker.download_as_text())
        if corpo.get("dataset") not in (None, settings.bq_gold_dataset):
            continue
        return ts.strftime("%Y-%m-%d %H:%M UTC"), corpo
    return "no sealed snapshot"


def _check_history_backup(settings: Settings) -> CheckResult:
    """Does the newest sealed snapshot cover the append-only serving tables?

    ``serving_quality_history`` (v1.91.0) accumulates one donut per build and is what the
    quality-drift check compares builds against. No build recreates it — a lost row is a
    lost build — and for its first day in production no backup included it. FAILS when the
    newest snapshot predates that coverage, the same absent-vs-zero contract as curation.
    """
    try:
        newest = _newest_sealed_manifest(settings)
        if isinstance(newest, str):
            return CheckResult("Quality history backup", True, f"skipped: {newest}")
        quando, corpo = newest
        n = corpo.get("history_table_count")
        if n is None:
            return CheckResult(
                "Quality history backup",
                False,
                f"newest snapshot ({quando}) predates quality-history coverage — "
                "serving_quality_history is NOT in it; run `make backup-gold`",
            )
        return CheckResult(
            "Quality history backup", True, f"{n} history table(s) in {quando} snapshot"
        )
    except Exception as exc:
        return _skip_ou_quebra("Quality history backup", exc)


# The sources `gold_source_metadata` is EXPECTED to emit a row for. Declared rather than
# read off the result, because the result is precisely what goes quiet: each branch of the
# view ends in `having count(*) > 0`, so a source whose Gold went empty emits nothing and
# disappears from the report. `tests/test_doctor.py` parses the dbt model and fails if the
# two drift — the list is a contract, not a copy.
_EXPECTED_METADATA_SOURCES = frozenset(
    {"ibge_pevs", "ibge_pam", "ibge_ppm", "mdic_comex", "un_comtrade"}
)


def _check_source_data_freshness(settings: Settings) -> CheckResult:
    """Is each source's latest REFERENCE PERIOD as recent as its cadence implies?

    The gap this closes: the ingestion alert fires on a FAILED Cloud Run execution, so a
    monthly job that runs green and ingests nothing looks exactly like "the source has not
    published yet". Nothing else told anyone the difference. For annual sources that quiet
    state is normal ~11 months a year, which is precisely why a silent stall could sit
    unnoticed until someone happened to look.

    So this does NOT ask "did the scheduler run" — that lives in Cloud Run/Logging, not in
    BigQuery, and the pipelines' own events go to a log file. It asks the question the
    researcher actually has: **is the newest reference period here as new as it should be?**
    A stalled cadence eventually shows up as exactly that, when a publication window passes
    and `year_end` does not move.

    Honest limit, stated so nobody over-trusts a green line: between publication windows
    this check CANNOT distinguish a healthy quiet source from a broken one, because the
    data is identical in both cases. It catches the stall at the window, not before it.

    Reads `gold_source_metadata` (one row per source, with `cadence`, `year_end` and
    `period_end`), so it costs one query and extends when a source is added there.

    **Two things it used to get wrong, both of the same kind — a number that is right
    answering a question nobody asked:**

    * It reported "every source current" over the rows that came BACK. The view ends each
      branch with ``having count(*) > 0``, so an EMPTY source emits no row at all and
      simply vanishes from the report — a wiped `gold_pevs_production` would have read as
      "all current". The expected set is now declared (`_EXPECTED_METADATA_SOURCES`, kept
      in step with the model by a parity test) and a missing source is the LOUDEST finding
      here, not an absent one. It is the lesson the heartbeat check below already learned:
      never say "every" over the subset that happened to report.
    * A monthly source was held to a YEAR-granular floor. `year_end` cannot express it: a
      COMEX that stopped publishing in March still reports year_end = that year, so the
      floor only passed it in January of year+2 — a detection lag of 13 to 24 months,
      where the comment promised about one. Monthly sources are now measured on
      `period_end` in MONTHS.
    """
    try:
        client = bigquery.Client(
            project=settings.gcp_project_id,
            location=settings.bq_location,
            credentials=get_credentials(settings),
        )
        fqn = f"{settings.gcp_project_id}.{settings.bq_gold_dataset}.gold_source_metadata"
        rows = list(
            client.query(
                f"select source, cadence, year_end, period_end from `{fqn}`",
                job_config=_bq_job_config(settings),
            ).result()
        )
        if not rows:
            return CheckResult(
                "Source data freshness", True, f"⚠ {fqn} is empty — nothing to check yet"
            )

        today = datetime.now(UTC).date()
        this_year = today.year
        slack = settings.source_freshness_annual_slack_years
        month_slack = settings.source_freshness_monthly_slack_months
        overdue: list[str] = []
        fresh: list[str] = []
        for row in rows:
            cadence = (row.cadence or "annual").strip().lower()
            year_end = row.year_end
            if year_end is None:
                overdue.append(f"{row.source} (no year_end)")
                continue
            if cadence == "monthly":
                # Measured in MONTHS off period_end (the newest month, closed), because a
                # year comparison cannot see a monthly source that stalled mid-year.
                if row.period_end is None:
                    overdue.append(f"{row.source} monthly (no period_end)")
                    continue
                behind = (
                    (today.year - row.period_end.year) * 12 + today.month - (row.period_end.month)
                )
                if behind > month_slack:
                    overdue.append(
                        f"{row.source} monthly ends {row.period_end:%Y-%m} "
                        f"({behind} months behind > {month_slack})"
                    )
                else:
                    fresh.append(f"{row.source}={row.period_end:%Y-%m}")
                continue
            floor = this_year - slack
            if int(year_end) < floor:
                overdue.append(f"{row.source} {cadence} ends {year_end} < {floor}")
            else:
                fresh.append(f"{row.source}={year_end}")

        # A source that emits NO row is not "current" — it is absent, which the view's
        # `having count(*) > 0` makes indistinguishable from "fine" unless we ask.
        missing = sorted(_EXPECTED_METADATA_SOURCES - {row.source for row in rows})
        if missing:
            overdue.insert(
                0,
                f"MISSING from gold_source_metadata: {', '.join(missing)} — a source emits "
                "no row when its Gold is EMPTY, so this is a vanished acervo, not a lag",
            )

        janelas = f"annual slack={slack}y, monthly slack={month_slack}mo"
        if overdue:
            # `missing` is deliberately NOT sorted into the rest: an absent source outranks
            # a late one, so it leads the line instead of landing alphabetically mid-list.
            atrasadas = sorted(o for o in overdue if not o.startswith("MISSING"))
            lider = [o for o in overdue if o.startswith("MISSING")]
            return CheckResult(
                "Source data freshness",
                True,  # warn, not fail — a lagging source is a signal to look, not a broken env
                "⚠ "
                + " · ".join(lider + atrasadas)
                + f" ({janelas}; check the source's publication calendar and "
                "the trigger before assuming the pipeline broke)",
            )
        # "every" is safe here ONLY because the expected set was checked above.
        return CheckResult(
            "Source data freshness",
            True,
            f"every expected source current: {' · '.join(sorted(fresh))} ({janelas})",
        )
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Source data freshness", exc)


def _check_ingest_heartbeat(settings: Settings) -> CheckResult:
    """Did each scheduled ingest actually RUN inside its own cadence window?

    The companion to "Source data freshness", and the half that check explicitly cannot
    do. Freshness asks whether the DATA advanced — which stays legitimately still between
    publication windows. This asks whether the RUN happened, which must be true every
    window regardless of whether the source had anything to give.

    Expected window per source is its own `IngestSpec.cadence_days` plus
    `HEARTBEAT_SLACK_DAYS` of grace. The cadence is declared per source rather than
    inferred from `in_all`, which stopped meaning "daily" when the batch went weekly
    (2026-08-28) and only bcb-currency kept a daily trigger.

    A source that has never reported is exempt only while the exemption still MEANS
    something: until the heartbeat table itself has existed longer than that source's
    window. Before that, silence is expected (the table starts empty, and crying wolf on
    day one is how a check gets ignored). After it, silence stops being "not yet" and
    becomes the loudest signal there is — a trigger created wrong and never fired once.
    That case used to be invisible here, and it is exactly the case a NEW scheduler is
    in: the weekly batch (2026-08-28) had never executed, and this check answered
    "every scheduled ingest ran".

    **The window is measured on the last SUCCESS, not the last invocation.** The
    heartbeat records three states (see ``ingestion_heartbeat``) and this check used to
    read two, collapsing ``outcome='failed'`` into "it ran" — with the evidence sitting
    in the table it had just queried. That mattered because the compensating control is
    deliberately disarmed: ``ingest all`` exits 0 when every failure is a marked
    ``SourceTransientError``, so no Cloud Run execution is marked failed and the
    Monitoring alert stays quiet. A source failing transiently every single run would
    read green here, silent there, and — for the warn-only sources (PAM/PPM/COMTRADE,
    60d with no ``error_after``) — green in ``dbt source freshness`` too. Three layers
    each agreeing nothing was wrong because each had delegated the question to another.

    A source that is still being INVOKED but has stopped succeeding gets its own line:
    "rodou há 3d, último sucesso há 47d" is a different fix from a dead trigger.
    """
    try:
        from embrapa_dashboard import ingestion_heartbeat
        from embrapa_dashboard.cli import INGESTS

        client = bigquery.Client(
            project=settings.gcp_project_id,
            location=settings.bq_location,
            credentials=get_credentials(settings),
        )
        fqn = ingestion_heartbeat.table_fqn(settings)
        rows = {
            r.source: r
            for r in client.query(
                "select source, max(run_ts) as last_run, "
                "max(if(outcome = 'ok', run_ts, null)) as last_ok "
                f"from `{fqn}` group by source",
                job_config=_bq_job_config(settings),
            ).result()
        }
        if not rows:
            return CheckResult(
                "Ingest heartbeat",
                True,
                "⚠ no heartbeat recorded yet — expected until the next scheduled run lands",
            )

        now = datetime.now(UTC)
        # How long we have been in a position to observe anything at all. The table's own
        # creation time is the honest reference: before it existed no source COULD have
        # reported, so absence says nothing; after it has outlived a source's window,
        # absence says everything.
        watched_days = (now - client.get_table(fqn).created).total_seconds() / 86400

        overdue: list[str] = []
        failing: list[str] = []
        never: list[str] = []
        pending: list[str] = []
        seen: list[str] = []

        def _age(ts) -> float:
            return (now - ts).total_seconds() / 86400

        for spec in INGESTS:
            row = rows.get(spec.name)
            window = spec.cadence_days + settings.heartbeat_slack_days
            if row is None:
                # Never reported. Only an answer once the table is older than the window.
                if watched_days > window:
                    never.append(f"{spec.name} (nunca, {watched_days:.0f}d observando)")
                else:
                    pending.append(spec.name)
                continue
            # The window is the source's OWN cadence plus a grace margin — not a guess
            # from `in_all`, which stopped meaning "daily" when the batch went weekly.
            # And it is measured on the last SUCCESS: a run that failed proves the
            # trigger fired, not that the ingest worked.
            if row.last_ok is not None and _age(row.last_ok) <= window:
                seen.append(f"{spec.name}={_age(row.last_ok):.0f}d")
                continue
            invoked = f"rodou há {_age(row.last_run):.0f}d"
            if _age(row.last_run) <= window:
                # Still being invoked, just never succeeding — the case the alert cannot
                # raise, because a transient-only batch exits 0 and never marks a failed
                # Cloud Run execution.
                if row.last_ok is None:
                    failing.append(f"{spec.name} ({invoked}, NENHUM sucesso registrado)")
                else:
                    failing.append(
                        f"{spec.name} ({invoked}, último sucesso há "
                        f"{_age(row.last_ok):.0f}d > {window}d)"
                    )
            else:
                overdue.append(f"{spec.name} {_age(row.last_run):.0f}d ago (> {window}d)")

        if overdue or failing or never:
            parts = []
            if overdue:
                parts.append("parou de rodar: " + " · ".join(sorted(overdue)))
            # Distinct from "stopped": the trigger fires, the ingest does not work. The
            # fix is in the pipeline/logs, not in Cloud Scheduler.
            if failing:
                parts.append("roda mas não conclui: " + " · ".join(sorted(failing)))
            # Distinct from both: nothing ever arrived, and enough time has passed
            # that something should have. Points at the trigger's CREATION, not its health.
            if never:
                parts.append("nunca rodou: " + " · ".join(sorted(never)))
            return CheckResult(
                "Ingest heartbeat",
                True,  # warn — the trigger may be paused on purpose
                "⚠ "
                + " ; ".join(parts)
                + " (trigger → Cloud Scheduler + the Job's executions; 'roda mas não "
                "conclui' → the run's own logs, the alert stays quiet on a transient-only "
                "batch because it exits 0)",
            )
        # Never say "every" over the subset that happens to have reported — the sources
        # still inside their first window are named, so the line accounts for all of them.
        msg = f"succeeded inside its window: {' · '.join(sorted(seen)) or 'nenhuma ainda'}"
        if pending:
            msg += " · sem primeiro registro, ainda dentro da janela: "
            msg += " · ".join(sorted(pending))
        return CheckResult("Ingest heartbeat", True, msg)
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Ingest heartbeat", exc)


_INFRA_CHECKS: list[tuple[str, Callable[[Settings], CheckResult]]] = [
    ("env", _check_env),
    ("pinned-end-years", _check_pinned_end_years),
    ("inflation-codes", _check_inflation_pivot_codes),
    ("currency-codes", _check_currency_series_codes),
    ("foreign-inflation-codes", _check_foreign_inflation_codes),
    ("pam-variable-codes", _check_pam_variable_codes),
    ("ibge-variable-codes", _check_ibge_variable_codes),
    ("silvicultura-variable-codes", _check_silvicultura_variable_codes),
    ("adc", _check_adc),
    ("bq", _check_bq),
    ("gcs", _check_gcs),
]

# ★ Extension point: to register a new source, add it here +
# in BRONZE_TARGETS above. For sources without a public API (e.g. SEFAZ NFe via
# bulk download), the "check" can be a stub that returns
# CheckResult(name, ok=True, detail="no public probe"). See
# docs/adding_a_data_source.md.
SOURCE_CHECKS: list[tuple[str, Callable[[Settings], CheckResult]]] = [
    ("ibge", _check_ibge),
    ("silvicultura", _check_silvicultura),
    ("pam", _check_pam),
    ("ppm", _check_ppm),
    ("bcb", _check_bcb),
    ("foreign-inflation", _check_foreign_inflation),
    ("comex", _check_comex),
    ("comtrade", _check_comtrade),
]

# ★ Extension point: each (dataset_attr, table_attr) references a field
# in Settings. _check_bronze_tables iterates over this list.
BRONZE_TARGETS: list[tuple[str, str]] = [
    ("bq_bronze_ibge_dataset", "bq_bronze_ibge_table"),
    # Same dataset as t289 — the two halves of one survey — but its own table.
    ("bq_bronze_ibge_dataset", "bq_bronze_silvicultura_table"),
    ("bq_bronze_pam_dataset", "bq_bronze_pam_table"),
    ("bq_bronze_ppm_dataset", "bq_bronze_ppm_herd_table"),
    ("bq_bronze_ppm_dataset", "bq_bronze_ppm_animal_table"),
    ("bq_bronze_bcb_dataset", "bq_bronze_bcb_inflation_table"),
    ("bq_bronze_bcb_dataset", "bq_bronze_bcb_currency_table"),
    ("bq_bronze_foreign_dataset", "bq_bronze_foreign_inflation_table"),
    ("bq_bronze_comex_dataset", "bq_bronze_comex_flows_table"),
    ("bq_bronze_comtrade_dataset", "bq_bronze_comtrade_flows_table"),
]


def _check_catalog_data_arrival(settings: Settings) -> CheckResult:
    """Cataloged produtos whose data never arrived in Gold — the generic net for the
    "registered, but the pipeline never fetched it" failure, for ANY banco.

    Each pipeline family solves scope growth its own way, because their economics differ:
    IBGE re-queries SIDRA over the full window when a resolved product is absent from
    Bronze; COMEX re-filters its archived raw when the product-filter fingerprint changes
    (no source hit at all); COMTRADE re-fetches a settled year when the recorded
    ``cmd_scope`` lacks a now-configured code. Three mechanisms, one promise — and COMTRADE
    had NO mechanism at all until 2026-08, so bamboo registered against it would have sat
    empty forever with nothing anywhere reporting the fact.

    This check is the source-agnostic backstop for that class: it does not care HOW a banco
    ingests, only whether what a researcher registered actually shows up. A future banco
    gets the same safety net for free, including one whose scope mechanism is missing or
    broken — which is exactly the case no per-pipeline test can cover.

    Advisory (ok=True): a produto registered minutes ago is legitimately still empty, so
    this reports rather than fails. Flask-free (direct BQ) so a bare ``embrapa doctor``
    runs it; any fault degrades to 'skipped'."""
    try:
        from embrapa_dashboard.gcp.clients import resolve_bq_client
        from embrapa_dashboard.serving import sql as sqlbuild

        bq = resolve_bq_client(settings)
        catalog_log = sqlbuild.table_ref(
            settings, "bq_research_inputs_dataset", settings.bq_produto_catalog_log_table
        )
        gold_union = _gold_code_union(settings)
        sql = f"""
            with ativos as (
              select codigo_produto, banco from (
                select codigo_produto, banco, active, row_number() over (
                  partition by {sqlbuild.CHAVE_CATALOGO} order by edited_at desc, change_id desc
                ) as _rn from `{catalog_log}`
              ) where _rn = 1 and active
            ),
            gold as (select distinct src, code from ({gold_union}))
            select a.banco, a.codigo_produto
            from ativos a
            left join gold g on g.src = a.banco and g.code = a.codigo_produto
            where g.code is null
            order by a.banco, a.codigo_produto
        """
        rows = list(bq.query(sql, job_config=_bq_job_config(settings)).result())
        if not rows:
            return CheckResult(
                "Catalog → Gold arrival", True, "every cataloged produto has data in Gold"
            )
        by_banco: dict[str, list[str]] = {}
        for r in rows:
            by_banco.setdefault(r.banco, []).append(r.codigo_produto)
        detail = " · ".join(f"{b}: {','.join(c)}" for b, c in sorted(by_banco.items()))
        return CheckResult(
            "Catalog → Gold arrival",
            True,
            f"{len(rows)} cataloged produto(s) with NO Gold data — {detail}. Expected right "
            "after a registration; if it persists past an ingest + dbt build, that banco's "
            "pipeline is not picking the code up.",
        )
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Catalog → Gold arrival", exc)


def _check_curation_referential_integrity(settings: Settings) -> CheckResult:
    """Do the curation logs still point at things that EXIST?

    Two writes a researcher makes daily reference a vocabulary defined elsewhere, and
    both stored the reference without checking it:

    * a catalog entry names an ``agrupamento_id``, which must exist in the agrupamentos
      registry. On 2026-08-29 a bulk reorganization wrote 37 entries naming groups it
      never created. Nothing failed: the write succeeded, the log was consistent with
      itself, and the products simply vanished from every grouped view — surfacing only
      as the "Sem agrupamento registrado (38)" heading a human happened to read. The
      writer now rejects this; a violation reaching here arrived by some path that
      bypasses the writer (a direct BQ insert, a restored backup, a registry row
      deleted after the fact), which is exactly what a checker is for.
    * a classification names an industrialization level. The writer is deliberately
      OPEN-vocabulary (it stores a level outside the scale), so a typo'd level leaves
      that product invisible to every level slice AND absent from "sem classificação" —
      the same silent hole, one axis over. Measured 2026-08-29: 308 classifications
      across 5 levels, all valid; the invariant holds and nothing was enforcing it.

    FAILS (ok=False) rather than advising: unlike a tombstoned product, neither
    condition is ever legitimate. Reads only the two small append-logs — no Gold scan,
    so it is free. Any fault (tables absent, no perms) degrades to 'skipped', because a
    cold install must not report a red integrity check it has no data to fail.
    """
    try:
        from embrapa_dashboard.gcp.clients import resolve_bq_client
        from embrapa_dashboard.serving import agrupamentos
        from embrapa_dashboard.serving import sql as sqlbuild
        from embrapa_dashboard.webapi.seam_attribute_engineering import CUR_LEVELS

        bq = resolve_bq_client(settings)
        catalog_log = sqlbuild.table_ref(
            settings, "bq_research_inputs_dataset", settings.bq_produto_catalog_log_table
        )
        nivel_log = sqlbuild.table_ref(
            settings,
            "bq_research_inputs_dataset",
            settings.bq_code_industrialization_log_table,
        )
        registered = set(agrupamentos._current_groups(bq, agrupamentos._group_log_ref(settings)))

        # Latest-wins per key, exactly as every reader collapses these logs.
        grupo_sql = f"""
            select codigo_produto, banco, agrupamento_id from (
              select codigo_produto, banco, agrupamento_id, active, row_number() over (
                partition by {sqlbuild.CHAVE_CATALOGO} order by edited_at desc, change_id desc
              ) as _rn from `{catalog_log}`
            ) where _rn = 1 and active
              and agrupamento_id is not null and agrupamento_id != ''
        """
        pendentes = [
            (r.codigo_produto, r.banco, r.agrupamento_id)
            for r in bq.query(grupo_sql, job_config=_bq_job_config(settings)).result()
            if r.agrupamento_id not in registered
        ]

        nivel_sql = f"""
            select source, code, industrialization_level from (
              select source, code, industrialization_level, row_number() over (
                partition by {sqlbuild.CHAVE_CLASSIFICACAO} order by edited_at desc, change_id desc
              ) as _rn from `{nivel_log}`
            ) where _rn = 1 and industrialization_level != ''
        """
        # '' is the explicit CLEAR (latest-wins un-classification), not a bad value.
        fora_da_escala = [
            (r.source, r.code, r.industrialization_level)
            for r in bq.query(nivel_sql, job_config=_bq_job_config(settings)).result()
            if r.industrialization_level not in CUR_LEVELS
        ]

        problemas = []
        if pendentes:
            ids = sorted({g for _, _, g in pendentes})
            problemas.append(
                f"{len(pendentes)} catalog entr(ies) name {len(ids)} unregistered "
                f"agrupamento(s) ({', '.join(ids[:5])}) — those produtos disappear from "
                "every grouped view; register the group (its name must slug to this id) "
                "or re-point the entries"
            )
        if fora_da_escala:
            niveis = sorted({n for _, _, n in fora_da_escala})
            problemas.append(
                f"{len(fora_da_escala)} classification(s) use {len(niveis)} level(s) "
                f"outside the scale ({', '.join(niveis[:5])}) — invisible to every level "
                "filter and absent from 'sem classificação'"
            )
        if problemas:
            return CheckResult("Curation referential integrity", False, "; ".join(problemas))
        return CheckResult(
            "Curation referential integrity",
            True,
            "every agrupamento_id registered, every level within the scale",
        )
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Curation referential integrity", exc)


# A coluna que distingue as duas tabelas SIDRA de um banco multi-tabela. É `tabela`
# em TODO banco, por definição: a identidade de um produto é `(banco, tabela, código)`, e a
# tabela é o dado — não um rótulo derivado dela. Constante, e não um campo por banco, de
# propósito: enquanto cada entrada trazia o seu próprio discriminador, o PEVS trazia
# `origem` (prosa) e o PPM `measure_kind` (prosa), e quando a v1.46.1 removeu `origem` este
# check virou uma consulta a uma coluna inexistente. Um campo por banco torna representável
# exatamente o erro que a v1.46.x foi corrigir.
_COLUNA_DISCRIMINADORA = "tabela"

# Os bancos que unem DUAS tabelas SIDRA sob um token só. Uma segunda entrada aqui é tudo o
# que um novo banco multi-tabela precisa.
_BANCOS_MULTI_TABELA = (
    ("ibge_pevs", "gold_pevs_production"),
    ("ibge_ppm", "gold_ppm_production"),
)


def _check_shared_code_across_tables(settings: Settings) -> CheckResult:
    """Um código pode existir nas DUAS tabelas SIDRA de um banco multi-tabela?

    Hoje não: PEVS tem 7 códigos de extração contra 3 de silvicultura, PPM tem 8 de
    rebanho contra 6 de produção animal, sem interseção (medido 2026-08-29). Se o IBGE
    publicar um código compartilhado, três coisas acontecem, e só a primeira faz barulho:

    1. O teste de unicidade do Gold — chave sem o discriminador, severidade `error` — falha,
       e como o prod roda ``dbt build`` os modelos downstream são pulados. O número errado
       NÃO chega ao dashboard.
    2. O **gate de visibilidade** não consegue representar o caso — e só ele. Catálogo
       (grão ``(banco, tabela, código)``) e nível de industrialização (grão
       ``(source, code, tabela, version)``) já carregam a tabela na chave. A view
       ``dim_produto_visibility`` também é única em ``(source, code, tabela)``, mas o
       PREDICADO que a consome casa só ``source`` e ``code`` — nos dois lados, a macro
       ``hidden_code_predicate`` e o espelho Python ``serving/sql.visibility_clause``.
       Esconder uma metade esconderia as DUAS, em silêncio. Medido em 2026-08-30.
    3. Com ``catalog_authoritative_ingestion`` ligado, o resolver filtra por
       ``tabela``: a metade não marcada deixaria de ser buscada em silêncio.

    Corrigir (2) de verdade custaria trocar a identidade do produto em ~25 pontos, 3 dims e
    3 logs — sobre o único dado que não se recalcula. Este check é a alternativa barata:
    avisa no instante em que o caso aparecer, antes do build quebrar e muito antes de a
    ingestão dirigida ser ligada, dando tempo de decidir com um caso concreto na mão.

    FALHA (ok=False): a condição nunca é benigna. Qualquer falta (tabela ausente, sem
    permissão) degrada para 'skipped'.
    """
    try:
        from embrapa_dashboard.gcp.clients import resolve_bq_client
        from embrapa_dashboard.serving import sql as sqlbuild

        bq = resolve_bq_client(settings)
        achados: list[str] = []
        for banco, tabela in _BANCOS_MULTI_TABELA:
            ref = sqlbuild.table_ref(settings, "bq_gold_dataset", tabela)
            sql = f"""
                select product_code, count(distinct {_COLUNA_DISCRIMINADORA}) as n
                from `{ref}`
                group by product_code
                having n > 1
                order by product_code
            """
            codigos = [
                r.product_code for r in bq.query(sql, job_config=_bq_job_config(settings)).result()
            ]
            if codigos:
                achados.append(f"{banco}: {', '.join(codigos[:5])}")
        if achados:
            return CheckResult(
                "Shared code across SIDRA tables",
                False,
                "código(s) presente(s) nas DUAS tabelas de um banco — "
                + "; ".join(achados)
                + ". O gate de visibilidade casa só (source, code): esconder uma metade "
                "esconderia as duas, sem aviso. Catálogo e nível de industrialização já "
                "trazem a tabela na chave e aguentam o caso. Ver "
                "PLANS/silvicultura_source.md antes de mexer no predicado do gate.",
            )
        return CheckResult(
            "Shared code across SIDRA tables",
            True,
            f"nenhum código compartilhado em {len(_BANCOS_MULTI_TABELA)} banco(s) multi-tabela",
        )
    except Exception as exc:  # sem dado → verde; check quebrado → vermelho
        return _skip_ou_quebra("Shared code across SIDRA tables", exc)


_POSTCHECKS: list[tuple[str, Callable[[Settings], CheckResult]]] = [
    ("bronze", _check_bronze_tables),
    ("serving", _check_serving_marts),
    ("quality-drift", _check_quality_drift),
    ("catalog-parity", _check_catalog_resolver_parity),
    ("curation-backup", _check_curation_backup),
    ("history-backup", _check_history_backup),
    ("curation-integrity", _check_curation_referential_integrity),
    ("shared-code", _check_shared_code_across_tables),
    ("orphans", _check_orphan_lifecycle),
    ("catalog-arrival", _check_catalog_data_arrival),
    ("backup", _check_backup_freshness),
    ("source-freshness", _check_source_data_freshness),
    ("heartbeat", _check_ingest_heartbeat),
]

# Total ordering of the checks. Each block can be extended without changing this alias.
CHECKS = _INFRA_CHECKS + SOURCE_CHECKS + _POSTCHECKS


def run_all(settings: Settings | None = None) -> list[CheckResult]:
    """Execute every probe and return the results in the same order as CHECKS.

    Each probe is guarded, so one that raises costs its OWN row and nothing else. Every
    probe already owns a ``try``; this is the structural guarantee behind that habit,
    and it was not hypothetical. ``_check_comex`` read ``comex_flows_list`` before its
    try and ``_check_bcb`` caught only ``StopIteration``, so a malformed ``.env`` — the
    very condition this command exists to diagnose — raised out of the comprehension
    that built this list. The operator got a traceback and NONE of the rows, including
    the ``.env parsed ✗`` that had already named the problem.

    The fallback name is the registry key rather than the probe's display name: the
    display name lives inside the probe, and a probe that blew up before returning is
    exactly the one that cannot supply it. A key is enough to find the check.
    """
    settings = settings or get_settings()
    results: list[CheckResult] = []
    for key, fn in CHECKS:
        try:
            results.append(fn(settings))
        except Exception as exc:
            results.append(_skip_ou_quebra(key, exc))
    return results
