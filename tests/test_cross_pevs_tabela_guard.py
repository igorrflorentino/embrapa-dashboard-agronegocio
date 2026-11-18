"""A PEVS series in "Cruzamento entre fontes" reads ONE half of the survey — the sweep.

PEVS is two disjoint halves: extraction from native forest (SIDRA t289) and silviculture
from planted forest (t291). Every production reader sums BOTH when it receives no
``tabela``, which is the survey's own total — legitimate only when the label says so.

Until v1.106.0 the three PEVS cross series called the readers with no table. ``prod_value``
told the researcher "Valor real (IPCA) da extração vegetal" and served the sum: measured on
prod 2026-11-17, R$ 47.7 bi for 2024 against the extraction's R$ 6.5 bi (7.3×), with the
mass at 9.5× and the volume at 8.4× (in MG the value was 827× the extraction). The two
halves move in opposite directions, so the series did not just have the wrong level — it
told the wrong story: flat since 1986, where the extraction fell 80%.

Nothing failed, because each piece did what it said: the reader sums what it is given,
the registry labels a half. The defect lived in the CONNECTION, so this sweep derives
every PEVS cross metric from the registry (never a hand list) and records every gateway
read made while building its series. A read without the metric's table fails.

Instrument guards: the sweep must see reads (or it is green over nothing), and it must
FAIL when the pin is removed from the real code path — run below, not assumed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd
import pytest

REPO = Path(__file__).resolve().parents[1]
BANCOS_JS = REPO / "frontend" / "src" / "ui" / "bancos.js"


def _cross():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam_cross

    return seam_cross


def _pevs_cross_metrics() -> list[dict]:
    """Every PEVS metric the cross picker offers — derived from the two registries the
    picker itself reads (metrics × CROSS_DISPLAY_UNIT), so a new one is swept unasked."""
    seam_cross = _cross()
    from embrapa_dashboard.webapi.registries import banco_by_id

    return [
        m
        for m in banco_by_id("ibge_pevs").metrics
        if f"ibge_pevs:{m['id']}" in seam_cross.CROSS_DISPLAY_UNIT
    ]


def _configured_tables() -> dict[str, str]:
    """SIDRA table id → half, from the DECLARED config defaults (no credentials needed)."""
    from embrapa_dashboard.config import Settings

    return {
        Settings.model_fields["ibge_table_id"].default: "extração",
        Settings.model_fields["silvicultura_table_id"].default: "silvicultura",
    }


# ── the registry ──────────────────────────────────────────────────────────────


def test_the_sweep_sees_pevs_cross_metrics():
    """Guard of the instrument: an empty list would make every check below vacuous."""
    ids = {m["id"] for m in _pevs_cross_metrics()}
    assert {"prod_value", "prod_mass", "prod_volume"} <= ids


def test_every_pevs_cross_metric_pins_a_configured_table():
    tables = _configured_tables()
    sem_tabela = [m["id"] for m in _pevs_cross_metrics() if m.get("tabela") not in tables]
    assert sem_tabela == [], (
        f"PEVS cross metrics with no (or an unknown) `tabela`: {sem_tabela}. Each one must "
        f"pin one of {sorted(tables)} — without it the readers sum both halves."
    )


def test_both_halves_are_offered_in_every_family():
    """Pinning the series must not drop the planted half from the comparison: it is
    ~87% of the survey's value, and the ``prod_*`` series used to carry it (summed)."""
    offered = {(m["tabela"], m["family"]) for m in _pevs_cross_metrics()}
    expected = {(t, f) for t in _configured_tables() for f in ("currency", "mass", "volume")}
    assert expected <= offered, f"missing (tabela, family): {sorted(expected - offered)}"


def test_each_label_names_its_half():
    """The label is what the chip, the legend and the ABNT citation print, so it — and not
    only the hover text — must say which half the number is."""
    tables = _configured_tables()
    for m in _pevs_cross_metrics():
        half = tables[m["tabela"]]
        assert half in m["label"].lower(), f"{m['id']}: {m['label']!r} does not name {half}"
        assert half in m["agg"].lower(), f"{m['id']}: {m['agg']!r} does not name {half}"
        assert f"SIDRA {m['tabela']}" in m["agg"], f"{m['id']}: the hover text omits the table"


def _js_pevs_metrics() -> list[dict]:
    """The PEVS ``metrics`` of the SPA registry, one object literal per line."""
    src = BANCOS_JS.read_text(encoding="utf-8")
    bloco = re.search(r"id:\s*'ibge_pevs'.*?\n    metrics: \[\n(.*?)\n    \],", src, re.S)
    assert bloco, "bancos.js: PEVS metrics block not found"
    campo = r"(\w+):\s*(?:'([^']*)'|\[(\d{4}), (\d{4})\])"
    saida = []
    for linha in bloco.group(1).splitlines():
        if not linha.strip().startswith("{ id:"):
            continue
        m: dict = {}
        for chave, texto, y0, y1 in re.findall(campo, linha):
            m[chave] = [int(y0), int(y1)] if y0 else texto
        saida.append(m)
    return saida


def test_spa_and_backend_declare_the_same_pevs_metrics():
    """The SPA draws the chips and the comparable window from ITS copy; the BFF serves
    from the other. Fixing one and leaving the other is how a stale claim survives."""
    from embrapa_dashboard.webapi.registries import banco_by_id

    py = [dict(m) for m in banco_by_id("ibge_pevs").metrics]
    js = _js_pevs_metrics()
    assert len(js) == len(py) >= 6, "the parser must see every metric (instrument guard)"
    assert js == py


# ── the seam: every read behind a PEVS series carries the metric's table ───────


# What each reader returns in these tests: the overview is one row per year; the
# per-product series one row per (code, year), each code in one family. Any other
# ``fetch_*`` gets the union of both shapes, so a new read cannot crash the sweep.
_OVERVIEW = pd.DataFrame([{"reference_year": 2020, "total_value": 2e9, "source_rows": 9}])
_PRODUCT_TS = pd.DataFrame(
    [
        {"code": "a", "reference_year": 2020, "total_qty_native": 1e3, "family": "massa"},
        {"code": "b", "reference_year": 2020, "total_qty_native": 2e3, "family": "massa"},
        {"code": "c", "reference_year": 2020, "total_qty_native": 7e6, "family": "volume"},
    ]
)
_SHAPES = {"fetch_production_overview": _OVERVIEW, "fetch_product_timeseries": _PRODUCT_TS}


def _record_reads(monkeypatch, seam_cross) -> list[tuple[str, dict]]:
    """Replace EVERY ``gateway.fetch_*`` with a recorder, not just the two readers the seam
    calls today — a future read added to the PEVS branch is swept too."""
    calls: list[tuple[str, dict]] = []
    outro = pd.concat([_OVERVIEW, _PRODUCT_TS], ignore_index=True)
    for nome in dir(seam_cross.gateway):
        if nome.startswith("fetch_") and callable(getattr(seam_cross.gateway, nome)):

            def leitor(*args, _nome=nome, **kwargs):
                calls.append((_nome, kwargs))
                return _SHAPES.get(_nome, outro).copy()

            monkeypatch.setattr(seam_cross.gateway, nome, leitor)
    return calls


def _unpinned_reads(seam_cross, calls: list[tuple[str, dict]]) -> list[str]:
    """Every PEVS cross series, built on the recorders; the reads that miss the table."""
    faltas = []
    for metric in _pevs_cross_metrics():
        for ufs in ((), ("PA",)):
            calls.clear()
            seam_cross.cross_series("ibge_pevs", metric["id"], 2019, 2021, ufs)
            assert calls, f"{metric['id']}: no gateway read recorded (instrument guard)"
            # `is None` first: a metric with no table and a read with none would otherwise
            # agree (None == None) and the sweep would pass over exactly the defect.
            faltas += [
                f"{metric['id']} → {nome}(tabela={k.get('tabela')!r})"
                for nome, k in calls
                if k.get("tabela") is None or k.get("tabela") != metric.get("tabela")
            ]
    return faltas


def test_every_read_behind_a_pevs_cross_series_pins_its_table(monkeypatch):
    seam_cross = _cross()
    calls = _record_reads(monkeypatch, seam_cross)
    assert _unpinned_reads(seam_cross, calls) == []


def test_the_sweep_fails_when_the_pin_is_removed(monkeypatch):
    """Counter-proof on the REAL code path: drop the table the way the pre-v1.106.0 seam
    did (the readers then get ``tabela=None``) and every PEVS series must be named."""
    seam_cross = _cross()
    calls = _record_reads(monkeypatch, seam_cross)
    monkeypatch.setattr(seam_cross, "_pevs_tabela", lambda metric: None)
    faltas = _unpinned_reads(seam_cross, calls)
    nomeadas = {f.split(" → ")[0] for f in faltas}
    assert nomeadas == {m["id"] for m in _pevs_cross_metrics()}


@pytest.mark.parametrize(
    ("family", "reader", "expected"),
    [
        ("currency", "fetch_production_overview", [{"y": 2020, "v": 2.0}]),  # 2e9 → R$ bi
        ("mass", "fetch_product_timeseries", [{"y": 2020, "v": 3.0}]),  # 1e3 + 2e3 t → mil t
        ("volume", "fetch_product_timeseries", [{"y": 2020, "v": 7.0}]),  # 7e6 m³ → mi m³
    ],
)
def test_each_series_reads_its_family_in_its_display_unit(monkeypatch, family, reader, expected):
    """The value comes from the overview, each quantity from the per-product series of its
    OWN family only — in both halves alike."""
    seam_cross = _cross()
    calls = _record_reads(monkeypatch, seam_cross)
    metricas = [m for m in _pevs_cross_metrics() if m["family"] == family]
    assert len(metricas) == 2  # one per half
    for m in metricas:
        calls.clear()
        assert seam_cross.cross_series("ibge_pevs", m["id"], 2020, 2020)["points"] == expected
        assert {nome for nome, _ in calls} == {reader}


def test_a_pevs_metric_without_a_table_is_refused(monkeypatch):
    """The seam refuses rather than falling back to the survey total: a forgotten pin
    fails the first request instead of serving a number that looks right."""
    seam_cross = _cross()
    calls = _record_reads(monkeypatch, seam_cross)
    monkeypatch.setattr(
        seam_cross,
        "_metric_meta",
        lambda banco, metric_id: {
            "id": metric_id,
            "label": "Valor",
            "family": "currency",
            "years": [1986, 2025],
        },
    )
    with pytest.raises(ValueError, match="'prod_value' declares no `tabela`"):
        seam_cross.cross_series("ibge_pevs", "prod_value", 2020, 2020)
    assert calls == []  # refused BEFORE any read


def test_an_unknown_pevs_metric_is_refused_by_name(monkeypatch):
    seam_cross = _cross()
    _record_reads(monkeypatch, seam_cross)
    with pytest.raises(ValueError, match="'desconhecida' declares no `tabela`"):
        seam_cross._pevs_cross_points("desconhecida", 2020, 2020)


# ── the reader: the table reaches the SQL, and only when asked ─────────────────


def test_product_timeseries_pins_the_table_only_when_asked():
    from embrapa_dashboard.serving import sql

    antes, p_antes = sql.product_timeseries("t", code_column="product_code", year_start=2020)
    nenhuma, p_nenhuma = sql.product_timeseries(
        "t", code_column="product_code", year_start=2020, tabela=None
    )
    assert (nenhuma, [p.name for p in p_nenhuma]) == (antes, [p.name for p in p_antes])
    assert "tabela" not in antes  # byte-identical to the query before the parameter

    fixada, params = sql.product_timeseries(
        "t", code_column="product_code", year_start=2020, tabela="291"
    )
    assert "tabela = @tabela" in fixada
    assert {p.name: p.value for p in params}["tabela"] == "291"


def test_fetch_product_timeseries_threads_the_table(monkeypatch):
    pytest.importorskip("flask_caching")
    from flask import Flask

    from embrapa_dashboard.config import Settings
    from embrapa_dashboard.serving import gateway
    from embrapa_dashboard.serving.cache import cache

    vistos = []
    monkeypatch.setattr(
        gateway, "run_query", lambda q, params, **k: vistos.append({p.name: p for p in params})
    )
    monkeypatch.setattr(
        gateway, "get_settings", lambda: Settings(_env_file=None, gcp_project_id="p")
    )
    app = Flask(__name__)
    cache.init_app(app, config={"CACHE_TYPE": "SimpleCache", "CACHE_DEFAULT_TIMEOUT": 300})
    with app.app_context():
        cache.clear()
        gateway.fetch_product_timeseries("ibge_pevs", year_start=2020, tabela="289")
        # Same call, no table: a distinct cache entry, so the reader runs again unpinned.
        gateway.fetch_product_timeseries("ibge_pevs", year_start=2020)
    assert vistos[0]["tabela"].value == "289"
    assert "tabela" not in vistos[1]
