"""Cross-source analytics for the seam layer (M3 builders).

The comparable cross-metric series + the four crosswalk-joined analytical
perspectives (market share, export coefficient, price spread, trade mirror). They
map the SAME commodity across PEVS / NCM / HS6 via gold_produto_agrupamento, then
compose existing ``serving.gateway`` readers filtered to that commodity's codes —
pure composition, no new BFF SQL beyond the crosswalk read (in ``seam_base``).

Imports only ``seam_base`` (the shared commodity toolkit) + the gateway, never
``seam`` itself, so the import graph stays acyclic. ``seam`` re-exports the public
builders so ``seam.market_share`` etc. keep working unchanged.
"""

from __future__ import annotations

from embrapa_dashboard.config import get_settings
from embrapa_dashboard.serving import gateway
from embrapa_dashboard.serving import sql as sqlbuild
from embrapa_dashboard.serving.cache import cache

from . import measures, seam_base
from .registries import Banco, banco_by_id
from .seam_base import _LIVE_SOURCES

CROSS_DISPLAY_UNIT = {
    "ibge_pevs:prod_value": "R$ bi",
    "ibge_pevs:prod_mass": "mil t",
    "ibge_pevs:prod_volume": "mi m³",
    "mdic_comex:exp_value": "US$ bi",
    "mdic_comex:imp_value": "US$ bi",
    "mdic_comex:exp_weight": "mil t",
    "mdic_comex:exp_price": "US$/kg",
    "un_comtrade:exp_value": "US$ bi",
    "un_comtrade:imp_value": "US$ bi",
    "un_comtrade:world_exp": "US$ bi",
}


def _metric_meta(banco: Banco, metric_id: str) -> dict | None:
    return next((m for m in banco.metrics if m["id"] == metric_id), None)


def cross_metric_refs() -> list[dict]:
    """Every (banco, metric) the picker can offer (live bancos with a real series)."""
    refs = []
    for bid in ("ibge_pevs", "mdic_comex", "un_comtrade"):
        b = banco_by_id(bid)
        for m in b.metrics:
            if f"{bid}:{m['id']}" in CROSS_DISPLAY_UNIT:
                refs.append(
                    {
                        "banco": bid,
                        "banco_short": b.short,
                        "metric": m["id"],
                        "label": m["label"],
                        "family": m["family"],
                    }
                )
    return refs


def cross_series(
    banco_id: str,
    metric_id: str,
    y0: int | None = None,
    y1: int | None = None,
    uf_codes: tuple = (),
) -> dict | None:
    """Comparable annual series for (banco, metric), in its DISPLAY_UNIT magnitude.

    ``uf_codes`` optionally narrows to origin UFs (the cross-source per-UF scoping).
    It only affects the UF-capable bancos (IBGE PEVS production, MDIC COMEX export);
    a COMTRADE metric ignores it (no UF column) — the view notes that honestly."""
    key = f"{banco_id}:{metric_id}"
    unit = CROSS_DISPLAY_UNIT.get(key)
    banco = banco_by_id(banco_id)
    metric = _metric_meta(banco, metric_id)
    if unit is None or metric is None or banco_id not in _LIVE_SOURCES:
        return None
    # A cross metric must declare its coverage; no fabricated default window.
    cov = metric.get("years")
    if not cov:
        return None
    yy0, yy1 = (y0 or cov[0]), (y1 or cov[1])
    return {
        "banco": banco_id,
        "banco_short": banco.short,
        "metric": metric_id,
        "key": key,
        "label": metric["label"],
        "unit": unit,
        "family": metric["family"],
        "coverage": cov,
        "points": _cross_points(banco_id, metric_id, yy0, yy1, unit, uf_codes),
    }


def _cross_points(
    banco_id: str, metric_id: str, y0: int, y1: int, unit: str, uf_codes: tuple = ()
) -> list[dict]:
    if banco_id == "ibge_pevs":
        return _pevs_cross_points(metric_id, y0, y1, uf_codes)
    if metric_id == "exp_price":
        return _exp_price_cross_points(y0, y1, uf_codes)
    df = gateway.fetch_cross_series(
        f"{banco_id}:{metric_id}", year_start=y0, year_end=y1, uf_codes=uf_codes
    )
    scale = 1e9 if unit.endswith("bi") else (1e6 if unit == "mil t" else 1.0)
    return [{"y": int(r.reference_year), "v": float(r.value or 0) / scale} for r in df.itertuples()]


def _pevs_cross_points(metric_id: str, y0: int, y1: int, uf_codes: tuple = ()) -> list[dict]:
    """PEVS cross points: value (÷1e9) or per-family native quantity (÷1e3 / ÷1e6)."""
    if metric_id == "prod_value":
        df = gateway.fetch_production_overview(
            year_start=y0, year_end=y1, value_column="val_real_ipca_brl", uf_codes=uf_codes
        )
        return [
            {"y": int(r.reference_year), "v": float(r.total_value or 0) / 1e9}
            for r in df.itertuples()
        ]
    fam = "massa" if metric_id == "prod_mass" else "volume"
    scale = 1e3 if metric_id == "prod_mass" else 1e6
    pts = gateway.fetch_product_timeseries(
        "ibge_pevs", year_start=y0, year_end=y1, value_column="val_real_ipca_brl", uf_codes=uf_codes
    )
    sub = pts[pts["family"] == fam].groupby("reference_year")["total_qty_native"].sum()
    return [{"y": int(y), "v": float(v) / scale} for y, v in sub.items()]


def _exp_price_cross_points(y0: int, y1: int, uf_codes: tuple = ()) -> list[dict]:
    """Derived COMEX export price: value(US$) ÷ weight(kg) = US$/kg."""
    val = gateway.fetch_cross_series(
        "mdic_comex:exp_value", year_start=y0, year_end=y1, uf_codes=uf_codes
    )
    wt = gateway.fetch_cross_series(
        "mdic_comex:exp_weight", year_start=y0, year_end=y1, uf_codes=uf_codes
    )
    wmap = {int(r.reference_year): float(r.value or 0) for r in wt.itertuples()}
    # A year with no (or zero) weight has no defined price: emit None (a gap
    # in the chart) — NEVER divide by 1, which would plot the year's raw
    # total US$ value as a 'US$/kg' point.
    return [
        {
            "y": int(r.reference_year),
            "v": (
                float(r.value or 0) / wmap[int(r.reference_year)]
                if wmap.get(int(r.reference_year))
                else None
            ),
        }
        for r in val.itertuples()
    ]


def _mass_by_year(banco: str, codes: tuple, uf_codes: tuple = ()) -> dict:
    """Produced mass (mil t) per year for ONE production banco. Empty ``codes`` means
    the agrupamento has no side in this banco (carvão vegetal has no PAM half), and
    the reader is skipped — an empty code list means "no filter" downstream, which
    would silently sum the WHOLE banco into the denominator."""
    if not codes:
        return {}
    pts = gateway.fetch_product_timeseries(
        banco, codes=codes, value_column="val_real_ipca_brl", uf_codes=uf_codes
    )
    if pts is None or pts.empty:
        return {}
    g = pts.groupby("reference_year")["total_qty_native"].sum()
    return {int(y): float(v) / 1e3 for y, v in g.items()}  # t -> mil t


# The two IBGE surveys that measure PRODUCTION, and the crosswalk `source` value of
# each. They are disjoint by construction — PEVS counts what is gathered from native
# forest, PAM what is harvested from a planted crop — so a produto present in both is
# not double-counted by summing them; it is two different phenomena that customs
# cannot tell apart.
_PRODUCTION_SOURCES = (
    ("pevs", "ibge_pevs", "gold_pevs_production"),
    ("pam", "ibge_pam", "gold_pam_production"),
)


@cache.memoize()
def _production_family_by_agrupamento() -> dict:
    """agrupamento_id -> set of physical-unit families across BOTH production bancos.

    Sourced from ``gold_pevs_production.family`` and ``gold_pam_production.family``.
    The ``'*'`` key holds every family present, the basis of the "Cesta completa" /
    no-filter selection, which sums across ALL products. A mass↔weight ratio is only
    meaningful when the production side is purely ``massa``; volume (m³) or mixed
    selections are not — Gold itself warns "NEVER sum qty_base across families".

    It used to read PEVS alone, and that is what let the export coefficient divide
    COMEX's whole numerator by a fraction of the denominator (see
    ``export_coefficient``): a produto could be pure-mass in PEVS and never be asked
    whether its PAM half is mass too.
    """
    s = get_settings()
    xwalk = sqlbuild.table_ref(s, "bq_gold_dataset", "gold_produto_agrupamento")
    parts = []
    for src, _banco, tbl in _PRODUCTION_SOURCES:
        t = sqlbuild.table_ref(s, "bq_gold_dataset", tbl)
        parts.append(
            f"""
            select x.agrupamento_id as cid, p.family as family
            from `{xwalk}` x
            join `{t}` p on x.source = '{src}' and p.product_code = x.code
            group by cid, family
            union all
            select '*' as cid, family from (select distinct family from `{t}`)
            """
        )
    idx: dict = {}
    for r in gateway.run_query(" union all ".join(parts), []).itertuples():
        idx.setdefault(r.cid, set()).add(r.family)
    return idx


def _is_mass_basis(agrupamento_id: str | None) -> bool:
    """True iff the production side of this selection is purely mass (t) — the
    precondition for comparing IBGE production against COMEX shipment weight (kg).
    Volume commodities (madeira, m³) and the mixed "Cesta completa" return False."""
    fams = _production_family_by_agrupamento().get(agrupamento_id or "*", set())
    return fams == {"massa"}


def produto_catalog_with_family() -> dict:
    """The commodity catalog, each commodity TAGGED with its PEVS physical-unit
    family ('massa'/'volume'/… pt-BR, or None when it has no single PEVS family).

    Drives the frontend's family-gated cross pickers: the export coefficient and
    price spread compare PEVS MASS (mil t) to COMEX shipment weight (kg), so they
    must offer ONLY pure-mass commodities — a volume (m³) or mixed-family commodity
    is not interpretable there. A commodity is single-family by construction, so a
    set of >1 (or empty) collapses to None and those views drop it from the picker.
    Composes two cached reads (catalog + family index); kept un-memoized so a warm
    instance always reflects their own TTL refresh instead of pinning a stale merge.
    """
    fams = _production_family_by_agrupamento()
    out: dict = {}
    for cid, c in seam_base.produto_catalog().items():
        fset = fams.get(cid, set())
        out[cid] = {**c, "family": next(iter(fset)) if len(fset) == 1 else None}
    return out


# A world-export year is "settled" once ~all UN reporters have filed. Reporters lag
# ~1-2y, so the most recent year(s) carry far fewer reporters; dividing Brazil (a
# complete declarant) by that partial world total inflates the "current" share and
# fakes an upward tail / historic peak. A year counts as complete when its reporter
# count is at least this fraction of the best-covered year — the share series and KPI
# are capped at the latest such year (the COMTRADE analog of COMEX's partial-latest-year
# guard, seam._latest_year_completeness).
_WORLD_MIN_REPORTER_COVERAGE = 0.9


def _world_latest_complete_year() -> int | None:
    """The most recent world-export year whose reporter coverage is settled (>= the
    coverage threshold of the best-covered year); None when the mart has no reporters
    (then no clamp is applied — a safe no-op degrade to the raw common window).

    Only the TRAILING partial years are trimmed: an older year with naturally lower
    coverage (the world's trade data was thinner then) still sits at/below this year and
    is kept — the clamp caps the upper bound, it does not filter the interior.
    """
    df = gateway.fetch_comtrade_reporters_per_year()
    counts = (
        {int(r.reference_year): int(r.n_reporters) for r in df.itertuples()}
        if df is not None and not df.empty
        else {}
    )
    if not counts:
        return None
    threshold = max(counts.values()) * _WORLD_MIN_REPORTER_COVERAGE
    complete = [y for y, n in counts.items() if n >= threshold]
    return max(complete) if complete else None


def _market_share_series(comex_codes: tuple, comtrade_codes: tuple) -> list[dict]:
    """Yearly BR-export ÷ world-export share (US$ bi) over the common-year window,
    capped at the latest world year with SETTLED reporter coverage — a partially
    reported recent denominator would inflate the share and fake an upward tail."""
    br = seam_base._xyear("mdic_comex:exp_value", comex_codes)
    world = seam_base._xyear("un_comtrade:world_exp", comtrade_codes)
    cap = _world_latest_complete_year()
    years = [y for y in sorted(set(br) & set(world)) if cap is None or y <= cap]
    return [
        {
            "y": y,
            "br": br[y] / 1e9,
            "world": world[y] / 1e9,
            # Sem exportação mundial no ano não há fatia a declarar. 0 diria "o Brasil
            # tem 0% do mercado", que é uma AFIRMAÇÃO sobre um ano que ninguém mediu.
            "share": measures.pct_present(br[y], world[y]),
        }
        for y in years
    ]


def _market_share_latest(comex_codes: tuple, comtrade_codes: tuple) -> float | None:
    """Latest SETTLED common-year BR ÷ world share (%), or None when there is no
    overlap. Capped at the latest world year with complete reporter coverage so the
    "current share" KPI isn't inflated by a partially reported recent denominator."""
    b = seam_base._xyear("mdic_comex:exp_value", comex_codes)
    w = seam_base._xyear("un_comtrade:world_exp", comtrade_codes)
    cap = _world_latest_complete_year()
    common = [y for y in sorted(set(b) & set(w)) if cap is None or y <= cap]
    if not common:
        return None
    ly = common[-1]
    return measures.pct_present(b[ly], w[ly])


def market_share(agrupamento_id: str | None) -> dict:
    """BR exports (COMEX) / world exports (COMTRADE), per year + per commodity."""
    comex_codes = seam_base._codes(agrupamento_id, "comex")
    comtrade_codes = seam_base._codes(agrupamento_id, "comtrade")
    series = []
    # Guard (mirrors market_nature): a scoped commodity missing codes for either
    # source must yield an EMPTY series — an empty tuple means "no filter" to the
    # readers, which would silently serve the ALL-commodities totals as if scoped.
    if not agrupamento_id or (comex_codes and comtrade_codes):
        series = _market_share_series(comex_codes, comtrade_codes)
    by_product = []
    for cid, c in seam_base.produto_catalog().items():
        if not (c["comex"] and c["comtrade"]):
            continue  # same guard per commodity — never the unscoped totals
        share = _market_share_latest(tuple(c["comex"]), tuple(c["comtrade"]))
        if share is not None:
            by_product.append({"code": cid, "name": c["name"], "share": share})
    by_product.sort(key=lambda x: x["share"], reverse=True)
    return {"unit": "US$ bi", "series": series, "by_product": by_product}


def _empty_export_coef(uf_codes: tuple) -> dict:
    """The no-data export-coefficient payload, echoing the active UF scope back."""
    return {
        "unit": "mil t",
        "by_uf": [],
        "national": {},
        "timeseries": [],
        "states": list(uf_codes),
    }


def export_coefficient(agrupamento_id: str | None, uf_codes: tuple = ()) -> dict:
    """Share of each UF's production (PEVS, mass) that is exported (COMEX weight).

    ``uf_codes`` narrows every side of the ratio to the selected origin UFs — the
    per-UF rows, the timeseries AND the aggregate. It did not before, so this view
    showed all 27 states (and a country-wide coefficient) while the rest of the
    session was narrowed. Both sides must be narrowed together: scoping only the
    production half would divide the selected states' output by the whole country's
    exports and silently deflate the coefficient. ``states`` is echoed back so the
    view relabels its "nacional" figures — a coefficient over a subset is a
    different ratio, not a smaller one.
    """
    if not _is_mass_basis(agrupamento_id):
        # Volume commodity (m³) or mixed basket: exported-kg ÷ produced-m³ is not a
        # share. Refuse rather than print a dimensionless-nonsense percentage.
        return _incompatible_export_coef("familia", uf_codes)
    pevs_codes = seam_base._codes(agrupamento_id, "pevs")
    pam_codes = seam_base._codes(agrupamento_id, "pam")
    ncms = seam_base._codes(agrupamento_id, "comex")
    if agrupamento_id and not ncms:
        # No customs side: since v1.58.0 the family gate reads BOTH production bancos,
        # so PAM-only agrupamentos reach this view — and three of them (abacaxi, café,
        # cana-de-açúcar) have no NCM in the crosswalk. Without a numerator there is no
        # coefficient, and rendering "—" everywhere would leave the researcher guessing
        # whether the data is missing or the pipeline broke. Refuse with a REASON, the
        # same honest-note path the volume/mixed refusal already uses.
        return _incompatible_export_coef("sem-ncm", uf_codes)
    if agrupamento_id and not (pevs_codes or pam_codes):
        # Codes for the customs side but none for production: empty payload, never the
        # unscoped ALL-commodities totals (empty codes mean "no filter").
        return _empty_export_coef(uf_codes)
    # O DENOMINADOR SOMA AS DUAS PESQUISAS DE PRODUÇÃO. Lia só a PEVS (extração
    # nativa), enquanto o numerador — o peso que saiu pela alfândega — não sabe
    # distinguir origem: o NCM da castanha de caju é "com casca"/"sem casca", uma
    # distinção de BENEFICIAMENTO, não de origem produtiva. Dividir todas as
    # exportações por uma fração da produção dava 736% nacionais para a castanha-
    # de-caju (a PEVS tem 0,20 mi t contra 5,29 mi t da PAM) e 1.408.728% no Ceará,
    # que planta 409 mil t e extrai ~0. As duas pesquisas são disjuntas por
    # construção — coleta de mata nativa × lavoura plantada — então somá-las não
    # duplica nada. Um agrupamento sem lado PAM (carvão vegetal, castanha-do-pará)
    # tem codes vazio e o somatório fica idêntico ao de antes.
    mass_extractive = _mass_by_year("ibge_pevs", pevs_codes, uf_codes)
    mass_crop = _mass_by_year("ibge_pam", pam_codes, uf_codes)
    prod_mass = {
        y: mass_extractive.get(y, 0.0) + mass_crop.get(y, 0.0)
        for y in set(mass_extractive) | set(mass_crop)
    }
    exp_mass = {
        y: v / 1e6 for y, v in seam_base._xyear("mdic_comex:exp_weight", ncms, uf_codes).items()
    }
    ts = sorted(set(prod_mass) & set(exp_mass))
    # A SÉRIE do coeficiente, pelo mesmo motivo do valor por UF: um ano sem produção
    # não exporta "0% do que produziu" — o coeficiente não existe naquele ano, e o
    # gráfico deve mostrar lacuna, não um ponto colado no eixo.
    timeseries = [{"y": y, "v": measures.pct_present(exp_mass[y], prod_mass[y])} for y in ts]
    if not ts:
        return _empty_export_coef(uf_codes)
    # The by-UF/national ratios must compare the SAME window on both sides:
    # PEVS starts in 1986 but COMEX only in 1997, so unbounded cumulative sums
    # would systematically understate coefPct (and disagree with the timeseries,
    # which already intersects the two sources' years).
    by_uf = _export_coef_by_uf(pevs_codes, pam_codes, ncms, ts[0], ts[-1], uf_codes)
    return {
        "unit": "mil t",
        "by_uf": by_uf,
        "national": _export_coef_national(by_uf),
        "timeseries": timeseries,
        "states": list(uf_codes),
    }


def _production_by_uf(banco: str, codes: tuple, y0: int, y1: int, uf_codes: tuple) -> dict:
    """uf -> {name, region, production (mil t)} for ONE production banco over the
    window. Empty ``codes`` (the agrupamento has no side in this banco) returns {}
    WITHOUT querying: an empty code list means "no filter" downstream, so it would
    sum the whole banco into the denominator instead of nothing."""
    if not codes:
        return {}
    df = gateway.fetch_production_by_uf(
        year_start=y0,
        year_end=y1,
        value_column="qty_base",
        product_codes=codes,
        uf_codes=uf_codes,
        source=banco,
        latest_year_only=False,
    )
    return {
        r.state_acronym: {
            "name": r.state_name,
            "region": r.region_abbrev,
            "production": float(r.total_value or 0) / 1e3,  # qty_base (t) -> mil t
        }
        for r in df.itertuples()
    }


def _uf_mass(rows: dict, uf: str) -> float:
    """Massa produzida por uma UF em UM banco de produção, em mil t.

    Uma UF sem linha produziu ZERO daquele produto: as duas pesquisas do IBGE cobrem
    as 27 UFs, então a ausência de linha é um zero MEDIDO, não um dado que falta. A
    recusa continua existindo onde deve — ``pct_present`` devolve None quando o
    denominador somado não é positivo, e é o coeficiente, não a massa, que não existe
    para quem exporta sem produzir.
    """
    row = rows.get(uf)
    return row["production"] if row else 0.0


def _incompatible_export_coef(reason: str, uf_codes: tuple = ()) -> dict:
    """Honest refusal payload. ``reason`` is a CODE, not a sentence: the pt-BR text the
    researcher reads is composed in the view (project rule — display strings live with
    the UI). ``'familia'`` = volume/mixed selection (kg ÷ m³ is not a share);
    ``'sem-ncm'`` = the agrupamento has no customs correspondence, so there is no
    numerator at all."""
    return {
        "unit": "mil t",
        "incompatible": True,
        "incompatibleReason": reason,
        "by_uf": [],
        "national": {},
        "timeseries": [],
        "states": list(uf_codes),
    }


def _export_coef_by_uf(
    pevs_codes: tuple, pam_codes: tuple, ncms: tuple, y0: int, y1: int, uf_codes: tuple = ()
) -> list[dict]:
    """Per-UF production (mil t) vs exported weight (mil t) and their coefficient.

    Production is the SUM of the two IBGE surveys — ``productionExtractive`` (PEVS,
    coleta de mata nativa) + ``productionCrop`` (PAM, lavoura plantada) — because the
    export side cannot tell the two apart (see ``export_coefficient``). Both halves
    travel to the UI: the composition is separable and worth showing, the RATIO is not
    (all exports ÷ half the production is the very defect this fixes).

    Every reader is window-CUMULATIVE (``latest_year_only=False``): the coefficient
    is exported-over-window ÷ produced-over-window across the SAME ``[y0, y1]``
    common-year intersection, NOT a single latest-year ratio (that is the snapshot
    choropleth's job). A single-year ratio would also reintroduce the year-window
    mismatch the cumulative sums were built to avoid.
    """
    extractive = _production_by_uf("ibge_pevs", pevs_codes, y0, y1, uf_codes)
    crop = _production_by_uf("ibge_pam", pam_codes, y0, y1, uf_codes)
    exp = gateway.fetch_comex_by_uf(
        year_start=y0,
        year_end=y1,
        ncm_codes=ncms,
        uf_codes=uf_codes,
        flow="export",
        latest_year_only=False,
    )
    exp_by_uf = {r.state_acronym: float(r.total_weight_kg or 0) / 1e6 for r in exp.itertuples()}
    prod_by_uf = {**crop, **extractive}  # só para nome/região; a massa vem somada abaixo
    # Union the UF universe (FINDING #3): a UF that EXPORTS but has no PEVS
    # production row (port/warehousing states shipping goods grown elsewhere) must
    # NOT be dropped — otherwise its exports vanish from the choropleth AND from the
    # national aggregate, making the national KPI disagree with the (all-UF)
    # timeseries. Export-only UFs carry production=0; the view filters production>0
    # for the ranking, so the ranking stays clean while the national totals and the
    # map become complete and consistent with the timeseries.
    by_uf = []
    for uf in sorted(set(prod_by_uf) | set(exp_by_uf)):
        pr = prod_by_uf.get(uf)
        pe = _uf_mass(extractive, uf)
        pc = _uf_mass(crop, uf)
        p = pe + pc
        e = exp_by_uf.get(uf, 0.0)
        by_uf.append(
            {
                "uf": uf,
                "name": pr["name"] if pr else uf,
                "region": pr["region"] if pr else None,
                "production": p,
                "productionExtractive": pe,
                "productionCrop": pc,
                "exportV": e,
                # None, não 0: uma UF sem produção não exporta "0% do que produz" —
                # o coeficiente NÃO EXISTE para ela. E quem cai aqui é justamente quem
                # exporta sem produzir (origem não declarada, entreposto), então o 0
                # dizia o oposto da verdade. O KPI nacional na SPA já tratava null; a
                # tabela filtra production > 0; o mapa pinta não-positivo como "sem dado".
                "coefPct": measures.pct_present(e, p),
            }
        )
    return by_uf


def _export_coef_national(by_uf: list[dict]) -> dict:
    """Aggregate the per-UF rows into the national production/export/coefficient."""
    tp = sum(d["production"] for d in by_uf)
    te = sum(d["exportV"] for d in by_uf)
    return {
        "production": tp,
        # As duas metades do denominador, para a tela poder mostrar a COMPOSIÇÃO da
        # produção (que é separável) sem publicar duas razões (que não são).
        "productionExtractive": sum(d["productionExtractive"] for d in by_uf),
        "productionCrop": sum(d["productionCrop"] for d in by_uf),
        "exportV": te,
        "coefPct": measures.pct_present(te, tp),
    }


def _fob_price_by_year(ncms: tuple, uf_codes: tuple = ()) -> dict:
    """FOB export unit price (US$/kg) = COMEX value ÷ weight, per common year."""
    val = seam_base._xyear("mdic_comex:exp_value", ncms, uf_codes)
    wt = seam_base._xyear("mdic_comex:exp_weight", ncms, uf_codes)
    return {y: (val[y] / wt[y]) for y in (set(val) & set(wt)) if wt[y]}


def _gate_value_qty_by_year(banco: str, codes: tuple, uf_codes: tuple = ()) -> dict:
    """``{ano: (valor US$, quantidade t)}`` para UM banco de produção.

    ``codes`` vazio devolve ``{}`` SEM consultar: uma lista vazia significa "sem filtro"
    lá embaixo, e consultar assim somaria o banco INTEIRO — foi exatamente esse o defeito
    que a v1.60.0 corrige (ver :func:`price_spread`).
    """
    if not codes:
        return {}
    pts = gateway.fetch_product_timeseries(
        banco, codes=codes, value_column="val_yearfx_usd", uf_codes=uf_codes
    )
    if pts is None or pts.empty:
        return {}
    g = pts.groupby("reference_year").agg(v=("total_value", "sum"), q=("total_qty_native", "sum"))
    return {int(y): (row.v, row.q) for y, row in g.iterrows()}


def _gate_price_by_year(pevs_codes: tuple, pam_codes: tuple, uf_codes: tuple = ()) -> dict:
    """Preço de porteira implícito (US$/kg) = valor ÷ (quantidade × 1000), por ano.

    Soma as DUAS pesquisas de produção do IBGE — extração nativa (PEVS) e lavoura
    plantada (PAM) — pelo mesmo motivo do coeficiente de exportação: o outro lado da
    comparação é o preço FOB da alfândega, que não distingue origem produtiva.
    """
    extractive = _gate_value_qty_by_year("ibge_pevs", pevs_codes, uf_codes)
    crop = _gate_value_qty_by_year("ibge_pam", pam_codes, uf_codes)
    saida = {}
    for y in set(extractive) | set(crop):
        ve, qe = extractive.get(y, (0.0, 0.0))
        vc, qc = crop.get(y, (0.0, 0.0))
        saida[y] = measures.ratio_present((ve or 0) + (vc or 0), ((qe or 0) + (qc or 0)) * 1000)
    return saida


def price_spread(agrupamento_id: str | None, uf_codes: tuple = ()) -> dict:
    """Farm-gate implied price (IBGE, US$/kg) vs FOB export price (COMEX, US$/kg).

    O lado da porteira soma as DUAS pesquisas de produção (PEVS extração + PAM lavoura),
    porque o lado FOB não distingue origem produtiva — o mesmo motivo do coeficiente de
    exportação.

    ``uf_codes`` optionally narrows BOTH sides to the same origin UF(s) — the
    porteira-vs-FOB spread for a single state (cross-source per-UF scoping)."""
    if not _is_mass_basis(agrupamento_id):
        # Gate price = produção em valor ÷ produção em massa; para um agrupamento de
        # volume isso é US$/m³, não o US$/kg do preço FOB — o spread seria inválido.
        return {"unit": "US$/kg", "incompatible": True, "series": []}
    ncms = seam_base._codes(agrupamento_id, "comex")
    pevs_codes = seam_base._codes(agrupamento_id, "pevs")
    pam_codes = seam_base._codes(agrupamento_id, "pam")
    if agrupamento_id and not ncms:
        # No NCM codes for this commodity: empty payload, never the unscoped
        # ALL-commodities FOB price (empty codes mean "no filter" to the reader).
        return {"unit": "US$/kg", "series": []}
    if agrupamento_id and not (pevs_codes or pam_codes):
        # O MESMO cuidado do lado da produção, que faltava. O lado FOB era guardado e o
        # da porteira não: um agrupamento sem códigos de produção lia o BANCO INTEIRO e
        # publicava o preço implícito de toda a PEVS como se fosse o daquele produto.
        # Medido em produção 2026-09-07: soja e milho exibiam o MESMO "preço de porteira"
        # (US$ 0,019/kg em 2020), porque nenhum dos dois tinha lado PEVS — e daí saía um
        # markup de 18,85× para a soja, um número inteiramente fabricado.
        return {"unit": "US$/kg", "series": []}
    fob = _fob_price_by_year(ncms, uf_codes)
    gate = _gate_price_by_year(pevs_codes, pam_codes, uf_codes)
    series = [
        {
            "y": y,
            "fob": fob[y],
            "gate": gate[y],
            # Ambos podem ser None desde que os preços passaram a preservar ausência:
            # sem os dois lados não há diferença nem múltiplo a declarar.
            "spread": (None if fob[y] is None or gate[y] is None else fob[y] - gate[y]),
            "markup": measures.ratio_present(fob[y], gate[y]),
        }
        for y in sorted(set(fob) & set(gate))
    ]
    return {"unit": "US$/kg", "series": series}


def trade_mirror(agrupamento_id: str | None) -> dict:
    """The same BR exports seen by MDIC (COMEX) vs UN Comtrade (reporter = Brazil)."""
    comex_codes = seam_base._codes(agrupamento_id, "comex")
    comtrade_codes = seam_base._codes(agrupamento_id, "comtrade")
    if agrupamento_id and not (comex_codes and comtrade_codes):
        # Missing codes for one side: empty payload, never a "mirror" of the
        # unscoped ALL-commodities totals (empty codes mean "no filter").
        return {"unit": "US$ bi", "series": [], "discrepancy": []}
    mdic = {y: v / 1e9 for y, v in seam_base._xyear("mdic_comex:exp_value", comex_codes).items()}
    comtrade = {
        y: v / 1e9 for y, v in seam_base._xyear("un_comtrade:exp_value", comtrade_codes).items()
    }
    # Third line: every OTHER country's declaration of what it imported FROM Brazil
    # (partner = Brazil on import rows) — the mirror view's "Reportado pelos parceiros".
    partners = {
        y: v / 1e9 for y, v in seam_base._xyear("un_comtrade:partner_exp", comtrade_codes).items()
    }
    years = sorted(set(mdic) & set(comtrade))
    series = [
        {"y": y, "mdic": mdic[y], "comtrade": comtrade[y], "partners": partners.get(y)}
        for y in years
    ]
    discrepancy = [
        {
            "y": d["y"],
            # `or 1` mascarava o denominador: num ano em que NENHUMA das duas fontes
            # tem dado, a divergência saía 0% — que se lê como "as fontes concordam
            # perfeitamente" sobre um ano que ninguém mediu.
            "v": measures.pct_present(
                abs(d["mdic"] - d["comtrade"]), (d["mdic"] + d["comtrade"]) / 2
            ),
        }
        for d in series
    ]
    return {"unit": "US$ bi", "series": series, "discrepancy": discrepancy}
