"""Coverage tests for serving/sql.py raw-filter builders + webapi/seam_cross.py edge guards.

Targets currently-uncovered branches:
  sql.py     — _bq_param_type BOOL map, _coerce_filter_value finite-float / bool coercion,
               _raw_filter_predicate is_null / not_null predicates.
  seam_cross — cross_series None when a metric declares no coverage window;
               _market_share_latest None when there is no common year;
               _gate_price_by_year {} when the PEVS timeseries is empty.

Pure-ish: the sql builders take no I/O (assert on the produced SQL string / bound params),
and the seam readers reuse the test_webapi_seam mocking style (monkeypatch the gateway /
seam_base toolkit with synthetic DataFrames). flask_caching is importorskip'd via the same
helpers the seam suite uses.
"""

from __future__ import annotations

import pandas as pd
import pytest

from embrapa_dashboard.serving import sql


def _cross():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam_cross

    return seam_cross


def _base():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam_base

    return seam_base


# ── sql.py: _bq_param_type — the BOOL branch (line 1251) ───────────────────────


def test_bq_param_type_maps_boolean_to_bool():
    # BOOLEAN / BOOL columns bind as BOOL; everything else falls through to STRING.
    assert sql._bq_param_type("BOOLEAN") == "BOOL"
    assert sql._bq_param_type("bool") == "BOOL"  # case-insensitive
    assert sql._bq_param_type("STRING") == "STRING"


# ── sql.py: _coerce_filter_value — finite-float return + bool coercion (1268/1272) ─


def test_coerce_filter_value_returns_finite_float():
    # A finite float passes math.isfinite and is returned as a float (the happy path
    # for a FLOAT64 column — not the non-finite ValueError branch).
    out = sql._coerce_filter_value("FLOAT64", "3.5")
    assert out == 3.5
    assert isinstance(out, float)


def test_coerce_filter_value_coerces_bool_truthy_and_falsey():
    # A BOOL column maps the textual truthy tokens to True, everything else to False.
    assert sql._coerce_filter_value("BOOL", "true") is True
    assert sql._coerce_filter_value("BOOL", "SIM") is True  # pt-BR token, case-insensitive
    assert sql._coerce_filter_value("BOOL", "1") is True
    assert sql._coerce_filter_value("BOOL", "no") is False


# ── sql.py: _raw_filter_predicate — is_null / not_null (1284-1285 / 1287-1288) ──


def test_raw_table_rows_builds_is_null_and_not_null_predicates():
    # is_null / not_null are valueless ops: they emit a bare IS [NOT] NULL predicate and
    # bind NO parameter (the early returns before the pname/value path).
    cols = {"reference_year": "INTEGER", "product_code": "STRING"}
    query, params = sql.raw_table_rows(
        "p.d.t",
        columns_types=cols,
        limit=10,
        filters=[
            {"col": "reference_year", "op": "is_null"},
            {"col": "product_code", "op": "not_null"},
        ],
    )
    assert "`reference_year` is null" in query
    assert "`product_code` is not null" in query
    assert params == []  # neither valueless op binds a parameter


# ── seam_cross.cross_series — None when the metric declares no coverage (line 83) ─


def test_cross_series_none_when_metric_has_no_coverage(monkeypatch):
    seam_cross = _cross()
    # A metric that IS in CROSS_DISPLAY_UNIT and whose banco is a live source, but whose
    # metadata declares no 'years' coverage → cross_series refuses (no fabricated window).
    monkeypatch.setattr(
        seam_cross,
        "_metric_meta",
        lambda banco, metric_id: {"id": "prod_value", "label": "X", "family": "valor"},
    )
    assert seam_cross.cross_series("ibge_pevs", "prod_value", 2020, 2020) is None


# ── seam_cross._market_share_latest — None when no common year (line 242) ───────


def test_market_share_latest_none_when_no_common_year(monkeypatch):
    seam_cross = _cross()
    base = _base()

    def fake_xyear(metric, codes, uf_codes=()):
        # BR-export years disjoint from world-export years → empty intersection.
        return {2001: 1e9} if metric == "mdic_comex:exp_value" else {2002: 2e9}

    monkeypatch.setattr(base, "_xyear", fake_xyear)
    monkeypatch.setattr(seam_cross, "_world_latest_complete_year", lambda: None)
    assert seam_cross._market_share_latest(("08012100",), ("080121",)) is None


def test_market_share_latest_value_when_years_overlap(monkeypatch):
    seam_cross = _cross()
    base = _base()

    def fake_xyear(metric, codes, uf_codes=()):
        return {2010: 1e9} if metric == "mdic_comex:exp_value" else {2010: 4e9}

    monkeypatch.setattr(base, "_xyear", fake_xyear)
    monkeypatch.setattr(seam_cross, "_world_latest_complete_year", lambda: None)
    # Latest common year 2010: 1e9 / 4e9 * 100 = 25%.
    assert seam_cross._market_share_latest(("a",), ("b",)) == pytest.approx(25.0)


# ── seam_cross._world_latest_complete_year — reporter-coverage clamp ────────────


def test_world_latest_complete_year_clamps_to_settled_year(monkeypatch):
    seam_cross = _cross()
    # 2023 fully reported (163), 2024/2025 still filling (136/72). Threshold = 90% of 163 =
    # 146.7, so only 2023 is "settled" → the share window caps there, not at partial 2025.
    df = pd.DataFrame({"reference_year": [2023, 2024, 2025], "n_reporters": [163, 136, 72]})
    monkeypatch.setattr(seam_cross.gateway, "fetch_comtrade_reporters_per_year", lambda: df)
    assert seam_cross._world_latest_complete_year() == 2023


def test_world_latest_complete_year_none_when_no_reporters(monkeypatch):
    seam_cross = _cross()
    monkeypatch.setattr(
        seam_cross.gateway, "fetch_comtrade_reporters_per_year", lambda: pd.DataFrame()
    )
    assert seam_cross._world_latest_complete_year() is None


# ── seam_cross._gate_price_by_year — {} when the PEVS timeseries is empty (line 380) ─


def test_gate_price_by_year_empty_when_no_pts(monkeypatch):
    seam_cross = _cross()
    monkeypatch.setattr(
        seam_cross.gateway, "fetch_product_timeseries", lambda *a, **k: pd.DataFrame()
    )
    assert seam_cross._gate_price_by_year(("9",), ()) == {}


def test_gate_price_by_year_none_pts_returns_empty(monkeypatch):
    seam_cross = _cross()
    monkeypatch.setattr(seam_cross.gateway, "fetch_product_timeseries", lambda *a, **k: None)
    assert seam_cross._gate_price_by_year((), ()) == {}


def test_gate_price_by_year_sem_codigos_nao_consulta_o_banco(monkeypatch):
    """Uma lista de códigos vazia significa "sem filtro" no leitor, então consultar
    assim publicaria o preço implícito do BANCO INTEIRO como se fosse o do produto."""
    seam_cross = _cross()
    chamou = []
    monkeypatch.setattr(
        seam_cross.gateway,
        "fetch_product_timeseries",
        lambda *a, **k: chamou.append(k.get("codes")) or pd.DataFrame(),
    )
    seam_cross._gate_price_by_year((), ())
    assert chamou == [], "consultou um banco de produção com filtro vazio"


def test_gate_price_by_year_soma_as_duas_pesquisas_de_producao(monkeypatch):
    """O lado FOB não distingue origem produtiva, então o lado da porteira soma as duas.

    O preço é uma RAZÃO: somar os dois preços seria errado; o que se soma são valor e
    quantidade, e a divisão vem depois.
    """
    seam_cross = _cross()

    def fake(banco, **k):
        v, q = {"ibge_pevs": (100.0, 1.0), "ibge_pam": (900.0, 9.0)}[banco]
        return pd.DataFrame([{"reference_year": 2020, "total_value": v, "total_qty_native": q}])

    monkeypatch.setattr(seam_cross.gateway, "fetch_product_timeseries", fake)
    # (100 + 900) US$ ÷ ((1 + 9) t × 1000) = US$ 0,10/kg — e NÃO a média dos dois preços
    # (0,10 e 0,10 coincidem aqui de propósito só na soma; ver o caso assimétrico abaixo).
    assert seam_cross._gate_price_by_year(("3404",), ("40143",)) == {2020: pytest.approx(0.1)}

    def fake_assimetrico(banco, **k):
        v, q = {"ibge_pevs": (100.0, 1.0), "ibge_pam": (100.0, 9.0)}[banco]
        return pd.DataFrame([{"reference_year": 2020, "total_value": v, "total_qty_native": q}])

    monkeypatch.setattr(seam_cross.gateway, "fetch_product_timeseries", fake_assimetrico)
    # 200 ÷ 10.000 = 0,02 — a média dos preços (0,10 e 0,011) daria 0,0556, outro número.
    assert seam_cross._gate_price_by_year(("3404",), ("40143",)) == {2020: pytest.approx(0.02)}
