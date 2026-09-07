"""Engenharia de Atributos readers for the seam layer (historically mislabelled
"Curadoria"; that name is now reserved for the catalog — what enters/exits the
dashboard).

Two derived attributes:
  • Per-code INDUSTRIALIZATION (an 8-level ordinal scale, Commodity Pura → Manufaturado
    Especializado) + the value-added analysis that splits COMEX exports by that level over
    time — RESEARCHER-EDITABLE (an append-log SCD2 the researcher
    curates in the UI; gated by the `enable_curation` dbt var). Writes go through the
    verified BFF writer (IAP author capture).
  • MARKET NATURE (consumo/processamento) — RESEARCHER-EDITABLE again (reverted from the
    comtrade_market_nature seed, v1.9.0): the (customs procedure × flow) → market mapping is
    an append-log SCD2 (dim_flow_market_scd2) the researcher edits in the "Tipo de Mercado"
    matrix. The matrix editor reads the LIVE mapping (short TTL); the "Finalidade econômica"
    analysis sums the serving mart's market_nature column (LEFT JOIN of the SCD2, materialized
    at build time → reflects an edit after the next dbt build).

Imports only ``seam_base`` (the shared commodity toolkit) + the gateway, never
``seam`` itself, so the import graph stays acyclic. ``seam`` re-exports the public
readers/writers so ``seam.curation_worklist`` / ``seam.market_nature`` etc. keep
working unchanged.
"""

from __future__ import annotations

from google.api_core.exceptions import NotFound

from embrapa_dashboard.serving import gateway
from embrapa_dashboard.serving.cache import cache

from . import measures, seam_base, seam_curation

# The 8 industrialization levels, ORDERED least→most processed. Mirrors the frontend
# window.ENRICH_LEVELS ids. The order is the ordinal the value-added analysis uses to draw
# the gradient and to pick the most-vs-least "prêmio de processamento". Open-vocabulary in
# the writer (a level outside this tuple is still stored) — this tuple only drives the
# worklist counts + the value-added grouping/ordering.
CUR_LEVELS = (
    "commodity_pura",
    "commodity_higienizada",
    "commodity_acondicionada",
    "commodity_consumivel",
    "commodity_subproduto",
    "manufaturado_artesanal",
    "manufaturado_industrial",
    "manufaturado_especializado",
)


@cache.memoize()
def _code_to_agrupamento() -> dict:
    """{(source, code) -> agrupamento_id} reverse index of the crosswalk, for
    grouping the worklist by commodity."""
    idx: dict = {}
    for cid, c in seam_base.produto_catalog().items():
        for src_key, source in (
            ("pevs", "ibge_pevs"),
            ("comex", "mdic_comex"),
            ("comtrade", "un_comtrade"),
        ):
            for code in c.get(src_key, ()):
                idx[(source, str(code))] = cid
    return idx


def attribute_editor_emails() -> set[str]:
    """Lowercased attribute editor emails from the allowlist table; empty set when the
    table is absent (allowlist not configured) — so routes fall back to "any
    IAP-authenticated caller may curate". Any OTHER error propagates (a transient
    BQ/permission fault must NOT silently widen the gate to everyone)."""
    try:
        df = gateway.fetch_attribute_editors()
    except NotFound:
        return set()
    if df is None or df.empty:
        return set()
    return {str(e).strip().lower() for e in df["email"] if e}


def _current_code_levels() -> dict:
    """{(source, code): level} from the SCD2 view; {} when the view is absent
    (curation not enabled in this dataset yet) — so the worklist still renders."""
    try:
        df = gateway.fetch_current_code_industrialization()
    except NotFound:
        # The SCD2 view genuinely doesn't exist yet (curation not enabled) — render
        # the worklist empty. Any OTHER error (transient BQ, permissions) must
        # propagate, not be masked as "not built yet".
        return {}
    if df is None or df.empty:
        return {}
    return {(r.source, str(r.code)): r.industrialization_level for r in df.itertuples()}


def curation_worklist() -> dict:
    """The classification worklist = the CURADORIA CATALOG entries ⟕ current levels.

    Reads the SAME live commodity catalog the "Cadastro de commodities" editor uses
    (``seam_curation.catalog_worklist`` → the append-only ``produto_catalog_log``,
    latest-wins active), so the two features stay in lock-step: identical
    banco+código+descrição+agrupamento, and any catalog edit (a new/renamed/moved/removed
    commodity or group) propagates here automatically. Each catalog entry carries its
    curated level or None ("a classificar"); its ``agrupamento`` is the grouping. PAM/PPM
    are included by construction (they live in the catalog with their agrupamentos, unlike
    the crosswalk). Pure reads; safe before any catalog / SCD2 view exists (renders empty).
    """
    levels = _current_code_levels()
    catalog = seam_curation.catalog_worklist()
    rows = []
    for e in catalog.get("entries", []):
        src = seam_curation._BANCO_TO_SOURCE.get(e.get("banco"))
        if src is None:
            continue
        code = str(e["codigo_produto"])
        rows.append(
            {
                "source": src,
                "code": code,
                # Source's original product name (parity with the catalog's "Descrição
                # (fonte)" column); fall back to the researcher description, then the code.
                "name": e.get("descricao_fonte") or e.get("descricao_produto") or code,
                "commodity": e.get("agrupamento_id"),
                "agrupamento_nome": e.get("agrupamento"),
                "level": levels.get((src, code)),
            }
        )
    classified = sum(1 for r in rows if r["level"])
    by_level = {lvl: sum(1 for r in rows if r["level"] == lvl) for lvl in CUR_LEVELS}
    return {
        "rows": rows,
        "total": len(rows),
        "classified": classified,
        "pending": len(rows) - classified,
        "by_level": by_level,
    }


def record_code_level(source: str, code: str, level: str, change_id: str | None = None) -> dict:
    """Append one per-code classification edit. The author comes from the request's
    IAP header (dev fallback per config). ``change_id`` is the optional client
    idempotency key (a retried save reusing it is a no-op). Wraps the verified
    BFF writer."""
    from flask import has_request_context, request

    from embrapa_dashboard.serving import attribute_engineering

    headers = dict(request.headers) if has_request_context() else {}
    return attribute_engineering.record_code_industrialization(
        source, code, level, headers, change_id=change_id
    )


# ── Flow-market matrix (customs procedure × flow → consumo/processamento) ──────
# pt-BR labels for the ten UN Comtrade trade regimes, keyed by the NORMALIZED flow
# token (matching serving_comtrade_annual.flow / the log's flow_code), not the raw
# UN code (X/M/RX). Only export/import/re-export/re-import are ingested today; the
# rest are kept so the label is correct if the ingestion scope ever widens.
_FLOW_LABELS = {
    "import": "Importação",
    "export": "Exportação",
    "national-export": "Exportação nacional",
    "foreign-import": "Importação estrangeira",
    "import-inward-processing": "Importação para aperfeiçoamento ativo",
    "import-outward-processing": "Importação após aperfeiçoamento passivo",
    "re-import": "Reimportação",
    "re-export": "Reexportação",
    "export-inward-processing": "Exportação após aperfeiçoamento ativo",
    "export-outward-processing": "Exportação para aperfeiçoamento passivo",
}


def _flow_market_map() -> dict:
    """{(customs_code, flow_code): market} from dim_flow_market_scd2; {} when the view is
    absent (curation not enabled / nobody classified yet) — so the matrix renders before
    activation. Any OTHER error propagates instead of being masked as "not activated"."""
    try:
        df = gateway.fetch_current_flow_market()
    except NotFound:
        return {}
    if df is None or df.empty:
        return {}
    return {(r.customs_code, r.flow_code): r.market for r in df.itertuples()}


def flow_market_worklist() -> dict:
    """The (customs procedure × flow) matrix — COMTRADE traded value ⟕ the current market
    mapping — backing the "Tipo de Mercado" editor. Each cell carries the real US$ value
    (from the serving mart) so the researcher classifies what actually matters, and its
    current market (from the live SCD2 view). Empty before any COMTRADE data / classification.
    """
    mapping = _flow_market_map()
    customs: set = set()
    flows: set = set()
    agg: dict = {}
    try:
        df = gateway.fetch_flow_market_values()
    except NotFound:
        df = None
    if df is not None and not df.empty:
        for r in df.itertuples():
            customs.add(r.customs_code)
            flows.add(r.flow_code)
            key = (r.customs_code, r.flow_code)
            agg[key] = agg.get(key, 0.0) + float(r.value_usd or 0)
    # Every CURRENT classification must render as a cell — even a pair with no COMTRADE
    # value (a specific regime absent from the data). Without this, a saved classification
    # for a no-data pair is invisible in the matrix and uncounted in the KPI, so the
    # researcher's edit silently disappears. Such cells get value_usd=0 (shown as "·").
    for c, f in mapping:
        if (c, f) not in agg:
            agg[(c, f)] = 0.0
        customs.add(c)
        flows.add(f)
    cells = [
        {"customs_code": c, "flow_code": f, "value_usd": v, "market": mapping.get((c, f))}
        for (c, f), v in sorted(agg.items(), key=lambda kv: kv[1], reverse=True)
    ]
    return {
        "customs": sorted(customs),
        "flows": [{"code": f, "label": _FLOW_LABELS.get(f, f)} for f in sorted(flows)],
        "cells": cells,
        "classified": sum(1 for c in cells if c["market"]),
        "total": len(cells),
    }


def record_flow_market(
    customs_code: str, flow_code: str, market: str, change_id: str | None = None
) -> dict:
    """Append one (customs_code, flow_code) → market edit. The author comes from the
    request's IAP header (dev fallback per config). ``change_id`` is the optional client
    idempotency key (a retried save reusing it is a no-op). Wraps the verified BFF writer."""
    from flask import has_request_context, request

    from embrapa_dashboard.serving import attribute_engineering

    headers = dict(request.headers) if has_request_context() else {}
    return attribute_engineering.record_flow_market(
        customs_code, flow_code, market, headers, change_id=change_id
    )


def value_added(agrupamento_id: str | None = None, uf_codes: tuple = ()) -> dict:
    """COMEX exports split by the curated industrialization LEVEL over the years.

    For each mdic_comex code currently classified into one of the 8 levels, sum its
    annual export value (US$ bi) + weight (mil t) into that level. Real data, but
    empty until codes are classified in Engenharia de Atributos. ``agrupamento_id``
    optionally scopes to one crosswalk commodity. Composes existing readers — no new
    BFF SQL.

    Set-based: ONE value + ONE weight query per PRESENT level (the reader's ``codes``
    filter is an ``IN UNNEST`` over the whole level), so the request cost stays flat
    as attribute editors classify more codes — never 2 BigQuery round-trips per code; levels
    with no classified code are skipped entirely.

    ``uf_codes`` optionally narrows the export side to one origin UF(s) (cross-source
    per-UF scoping). Returns the per-year per-level series, the levels present (in
    ordinal order), the latest-year processing premium (price of the most-processed
    present level ÷ the least-processed present level) and the predominant level.
    """
    by_level = _value_added_codes_by_level(agrupamento_id)
    acc, n = _value_added_accumulate(by_level, uf_codes)
    series = [_value_added_series_point(y, acc[y]) for y in sorted(acc)]
    present = [lvl for lvl in CUR_LEVELS if any(lvl in pt["levels"] for pt in series)]
    last = series[-1] if series else None
    return {
        "series": series,
        "levels": present,
        "premium": _value_added_premium(last) if last else None,
        "predominant": _value_added_predominant(last) if last else None,
        "n_codes": n,
    }


def _value_added_codes_by_level(agrupamento_id: str | None) -> dict[str, list[str]]:
    """Group currently-classified COMEX codes by industrialization level (scoped).

    Only mdic_comex codes whose level is one of the 8 CUR_LEVELS are kept; a code
    classified to some other free-text value is ignored by the analysis (but still
    stored). Returns only the levels that actually have codes."""
    scope = set(seam_base._codes(agrupamento_id, "comex")) if agrupamento_id else None
    valid = set(CUR_LEVELS)
    by_level: dict[str, list[str]] = {}
    for (src, code), lvl in _current_code_levels().items():
        if src != "mdic_comex" or lvl not in valid:
            continue
        if scope is not None and code not in scope:
            continue
        by_level.setdefault(lvl, []).append(code)
    return by_level


def _value_added_accumulate(
    by_level: dict[str, list[str]], uf_codes: tuple = ()
) -> tuple[dict, int]:
    """Sum export value (US$ bi) + weight (mil t) per year per level; (acc, n_codes).

    ONE value + ONE weight query per present level (the reader's ``codes`` filter is
    an ``IN UNNEST`` over the whole level), so the cost stays flat as more codes are
    classified — never 2 BigQuery round-trips per code. Iterates in CUR_LEVELS order
    so the accumulator's per-year slots are built deterministically. ``uf_codes``
    narrows the export side to one origin UF(s) (cross-source per-UF scoping).
    """
    acc: dict = {}
    n = 0
    for lvl in CUR_LEVELS:
        lvl_codes = by_level.get(lvl) or []
        if not lvl_codes:
            continue
        codes = tuple(sorted(lvl_codes))
        val = seam_base._xyear("mdic_comex:exp_value", codes, uf_codes)
        if not val:
            continue
        wt = seam_base._xyear("mdic_comex:exp_weight", codes, uf_codes)
        n += len(lvl_codes)
        for y, v in val.items():
            cell = acc.setdefault(y, {}).setdefault(lvl, {"v": 0.0, "w": 0.0})
            cell["v"] += v / 1e9  # US$ bi
            cell["w"] += wt.get(y, 0.0) / 1e6  # mil t
    return acc, n


def _value_added_series_point(y: int, slot: dict) -> dict:
    """One year: per-level value (US$ bi), weight (mil t) and absolute unit price
    (US$/kg), plus the year totals. Only levels present that year appear in ``levels``.

    price = value(US$ bi) ÷ weight(mil t); ×1e3 → US$/kg (the COMEX exp_price unit).
    """
    levels = {
        lvl: {
            "v": d["v"],
            "w": d["w"],
            # Preço unitário sem peso não é "preço zero" — é preço desconhecido.
            "price": measures.ratio_present(d["v"] * 1e3, d["w"]),
        }
        for lvl, d in slot.items()
    }
    return {
        "y": y,
        "levels": levels,
        "totalV": sum(d["v"] for d in slot.values()),
        "totalW": sum(d["w"] for d in slot.values()),
    }


def _value_added_premium(point: dict) -> float | None:
    """The processing premium at one year: unit price of the MOST-processed present
    level ÷ the LEAST-processed present level (both with a positive price), ordered
    by CUR_LEVELS.

    ``None`` — not 0 — when fewer than two priced levels are present: with a single
    level there is no premium to compute, and 0 would read as "processing adds
    nothing", which is a finding this data cannot support. The SPA already renders a
    falsy premium as '—', so this only makes the payload honest."""
    priced = [
        point["levels"][lvl]["price"]
        for lvl in CUR_LEVELS
        if lvl in point["levels"] and (point["levels"][lvl]["price"] or 0) > 0
    ]
    if len(priced) < 2:
        return None
    least, most = priced[0], priced[-1]
    return measures.ratio_present(most, least)


def _value_added_predominant(point: dict) -> dict | None:
    """The level with the largest export value at one year → {level, shareV%}."""
    if not point["levels"]:
        return None
    lvl, cell = max(point["levels"].items(), key=lambda kv: kv[1]["v"])
    total = point["totalV"] or 1
    return {"level": lvl, "shareV": cell["v"] / total * 100}


# ── Market-nature — COMTRADE value by economic purpose (consumo/processamento) ──
# The (customs procedure × flow) → market mapping is EDIT-DRIVEN (dim_flow_market_scd2,
# reverted from the comtrade_market_nature seed), LEFT JOINed into serving_comtrade_annual
# as the market_nature column. This analysis just sums the serving mart by that column,
# scoped to a commodity's HS codes — pairs with no economic-purpose mapping are simply
# absent. It reflects a matrix edit after the next dbt build (the editor's live reads use
# flow_market_worklist above).
def market_nature(agrupamento_id: str | None = None) -> dict:
    """COMTRADE trade value (US$ bi) by economic purpose (consumo/processamento) over the
    years, optionally scoped to ONE commodity's HS codes. Classified per
    (customs procedure × flow); the serving mart carries the market_nature column."""
    if agrupamento_id:
        codes = tuple(seam_base._codes(agrupamento_id, "comtrade"))
        if not codes:
            # The commodity exists but has no COMTRADE (HS) codes → no global trade to
            # split. Return empty rather than the unscoped all-commodities total.
            return {"years": [], "series": [], "latest": {}}
    else:
        codes = ()
    df = gateway.fetch_market_nature_series(codes)
    markets = [m["id"] for m in ENRICH_MARKETS]
    acc: dict = {}
    if df is not None and not df.empty:
        for r in df.itertuples():
            acc.setdefault(int(r.reference_year), {})[r.market_nature] = (
                float(r.value_usd or 0) / 1e9
            )
    years = sorted(acc)
    series = [{"y": y, **{m: acc[y].get(m, 0.0) for m in markets}} for y in years]
    return {"years": years, "series": series, "latest": series[-1] if series else {}}


# Economic-purpose markets the seed maps to (mirrors the frontend ENRICH_MARKETS).
ENRICH_MARKETS = [{"id": "consumo"}, {"id": "processamento"}]
