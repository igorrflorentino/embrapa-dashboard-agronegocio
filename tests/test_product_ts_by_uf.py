"""The per-product series under a whole-UF geography filter (v1.108.3).

Until v1.108.3 every screen drawing a product's series read the snapshot's ``productTS``,
which is NATIONAL: the mart has a UF grain and the snapshot sums it away. Under a chip
saying "1 UF", Pará's Leite stacked at Brazil's ~R$ 90 bi while Pará's whole value is
~R$ 1,6 bi (measured on prod 2026-11-18). ``/api/product-ts`` reads the same mart, the same
column and the same filters, plus the UFs.

What is pinned here:

* the SQL narrows by state and dates the value only when asked;
* the seam refuses an empty UF list — it reads as "no filter" downstream and would serve the
  national series under a UF label — and a banco with no UF grain;
* the per-UF read and the snapshot's read build their filters in ONE helper, so they answer
  over the same dataset: summed over every UF, one IS the other;
* the serializer speaks the snapshot's units, and the route parses what the seam needs.
"""

from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from embrapa_dashboard.serving import sql as sqlbuild

BRL = {"currency": "BRL", "correction": "Nominal"}
USD = {"currency": "USD", "correction": "Nominal"}


def _seam():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam

    return seam


def _spy_product_ts(seam, monkeypatch) -> list[dict]:
    """Record every per-product series read: the banco plus its keyword arguments."""
    calls: list[dict] = []

    def fake(source, **kwargs):
        calls.append({"source": source, **kwargs})
        return pd.DataFrame()

    monkeypatch.setattr(seam.gateway, "fetch_product_timeseries", fake)
    return calls


def _stub_the_rest_of_the_snapshot(seam, monkeypatch) -> None:
    empty = pd.DataFrame()
    for name in (
        "fetch_products",
        "fetch_quality_by_source",
        "fetch_quality_timeseries",
        "fetch_quality_by_product",
        "fetch_production_overview",
        "fetch_production_by_uf",
        "fetch_production_by_uf_yearly",
        "fetch_comex_overview",
        "fetch_comtrade_overview",
        "fetch_comex_by_uf",
        "fetch_comex_by_uf_yearly",
    ):
        monkeypatch.setattr(seam.gateway, name, lambda *a, **k: empty)


# ── 1. SQL ──────────────────────────────────────────────────────────────────────


def test_the_sql_narrows_by_state_and_the_national_read_stays_as_it_was():
    nacional, p_nac = sqlbuild.product_timeseries(
        "t", code_column="product_code", value_column="val_real_ipca_brl"
    )
    por_uf, p_uf = sqlbuild.product_timeseries(
        "t", code_column="product_code", value_column="val_real_ipca_brl", uf_codes=("PA",)
    )
    assert "state_acronym" not in nacional and p_nac == []
    assert "state_acronym IN UNNEST(@uf_codes)" in por_uf
    assert [(p.name, list(p.values)) for p in p_uf] == [("uf_codes", ["PA"])]
    # Still one row per product and year: the UFs are summed, never a grouping key.
    assert "group by product_code, reference_year" in por_uf


def test_the_sql_dates_the_value_only_when_asked():
    sem, _ = sqlbuild.product_timeseries(
        "t", code_column="product_code", value_column="val_real_ipca_brl", uf_codes=("PA",)
    )
    com, _ = sqlbuild.product_timeseries(
        "t",
        code_column="product_code",
        value_column="val_real_ipca_brl",
        uf_codes=("PA",),
        price_base=True,
    )
    assert "price_base" not in sem
    assert "max(ipca_base_month) as price_base_month" in com
    assert com.index("price_base_month") < com.index("from `t`")


# ── 2. Gateway ──────────────────────────────────────────────────────────────────


def test_the_gateway_threads_the_ufs_and_the_base_into_the_query(monkeypatch):
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.serving import gateway
    from tests.test_price_base import SETE
    from tests.test_serving import _bind_simplecache, _isolated_settings

    consultas: list[tuple[str, list]] = []
    monkeypatch.setattr(
        gateway, "run_query", lambda sql, params, **k: consultas.append((sql, params))
    )
    monkeypatch.setattr(gateway, "get_settings", lambda: _isolated_settings())
    monkeypatch.setattr(gateway, "fetch_table_columns", lambda *a: SETE)
    app, cache = _bind_simplecache()
    with app.app_context():
        cache.clear()
        gateway.fetch_product_timeseries("ibge_ppm", value_column="val_real_ipca_brl")
        gateway.fetch_product_timeseries(
            "ibge_ppm",
            value_column="val_real_ipca_brl",
            uf_codes=("PA",),
            with_price_base=True,
        )
    (nacional, _), (por_uf, params) = consultas
    assert "state_acronym" not in nacional and "price_base" not in nacional
    assert "state_acronym IN UNNEST(@uf_codes)" in por_uf
    assert "max(ipca_base_month) as price_base_month" in por_uf
    assert ("uf_codes", ["PA"]) in [(p.name, list(getattr(p, "values", []))) for p in params]


# ── 3. Seam ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("summary", [None, {}, {"states": []}, {"states": None}])
def test_no_uf_selection_is_no_read_never_the_national_series(monkeypatch, summary):
    """An empty UF list means "no filter" to the reader: passing it would answer with the
    national series, and the screen would draw it under the UF chip — the defect itself."""
    seam = _seam()
    calls = _spy_product_ts(seam, monkeypatch)
    assert seam.product_ts_by_uf("ibge_ppm", BRL, summary) is None
    assert calls == []


def test_a_banco_without_a_uf_grain_has_no_reader(monkeypatch):
    seam = _seam()
    calls = _spy_product_ts(seam, monkeypatch)
    assert seam.product_ts_by_uf_available("un_comtrade") is False
    assert seam.product_ts_by_uf("un_comtrade", USD, {"states": ["PA"]}) is None
    assert seam.product_ts_by_uf_available("banco_que_nao_existe") is False
    assert calls == []


@pytest.mark.parametrize("banco", ["ibge_pevs", "ibge_pam", "ibge_ppm", "mdic_comex"])
def test_every_banco_with_a_uf_grain_has_the_reader(banco):
    assert _seam().product_ts_by_uf_available(banco) is True


def test_the_read_narrows_by_uf_dates_its_values_and_leaves_the_window_open(monkeypatch):
    seam = _seam()
    calls = _spy_product_ts(seam, monkeypatch)
    seam.product_ts_by_uf(
        "ibge_ppm", {"currency": "BRL", "correction": "IPCA"}, {"states": ["PA", "AM"]}
    )
    (call,) = calls
    assert call["source"] == "ibge_ppm"
    assert call["uf_codes"] == ("PA", "AM")
    assert call["with_price_base"] is True
    assert call["value_column"] == "val_real_ipca_brl"
    # Every product and the whole history, like the snapshot: the client narrows both.
    assert call["codes"] == ()
    assert "year_start" not in call and "year_end" not in call
    # A production mart has no flow column.
    assert "flow" not in call


def test_the_level_narrows_the_codes_and_an_empty_level_matches_nothing(monkeypatch):
    """The level is resolved to codes in the seam. A level with no code must read as
    "nothing", not as an empty list — which the reader takes for "every product"."""
    seam = _seam()
    calls = _spy_product_ts(seam, monkeypatch)
    monkeypatch.setattr(
        seam.gateway, "fetch_products", lambda *a, **k: pd.DataFrame({"code": ["1", "2"]})
    )
    monkeypatch.setattr(seam, "_codes_for_levels", lambda banco, niveis, universo: set())
    seam.product_ts_by_uf("ibge_pam", BRL, {"states": ["MT"], "niveis": ["commodity_pura"]})
    (call,) = calls
    assert call["codes"] == (seam._NO_CODE_SENTINEL,)


_MIRROR = [
    ("ibge_pevs", BRL, {"states": ["PA"]}),
    ("ibge_pam", BRL, {"states": ["MT", "GO"]}),
    ("ibge_ppm", BRL, {"states": ["PA"], "tabela": "74"}),
    ("mdic_comex", USD, {"states": ["SP"]}),
    ("mdic_comex", USD, {"states": ["SP"], "flow": "import"}),
    ("mdic_comex", USD, {"states": ["SP"], "flow": "all"}),
]


@pytest.mark.parametrize("banco,conv,summary", _MIRROR)
def test_the_per_uf_read_answers_over_the_snapshot_reads_filters(monkeypatch, banco, conv, summary):
    """Summed over every UF, the per-UF series must BE the national one. That holds only
    while both reads carry the same filters — so both build them in one helper, and this
    compares the two calls argument by argument, minus the UFs and the base."""
    seam = _seam()
    _stub_the_rest_of_the_snapshot(seam, monkeypatch)
    calls = _spy_product_ts(seam, monkeypatch)
    seam.snapshot(banco, conv, summary)
    seam.product_ts_by_uf(banco, conv, summary)
    nacional, por_uf = calls
    assert por_uf.pop("uf_codes") == tuple(summary["states"])
    assert por_uf.pop("with_price_base") is True
    # The snapshot route sends no year window either; the seam passes it as None.
    assert nacional.pop("year_start") is None and nacional.pop("year_end") is None
    assert nacional == por_uf


def test_the_trade_read_follows_the_selected_direction(monkeypatch):
    """COMEX's per-UF cube and hero follow the selected flow (geo_yearly), so the per-product
    series under the same chip must too — pinning exports, as the one-period ranking does,
    would make the composition disagree with the total drawn beside it."""
    seam = _seam()
    calls = _spy_product_ts(seam, monkeypatch)
    seam.product_ts_by_uf("mdic_comex", USD, {"states": ["SP"], "flow": "import"})
    seam.product_ts_by_uf("mdic_comex", USD, {"states": ["SP"]})
    assert [c["flow"] for c in calls] == ["import", None]


# ── 4. Serializer ───────────────────────────────────────────────────────────────


def test_the_serializer_speaks_the_snapshots_units_and_dates_the_values():
    pytest.importorskip("flask")
    from embrapa_dashboard.webapi import serializers

    linhas = pd.DataFrame(
        [
            {
                "code": "2682",
                "reference_year": 2025,
                "total_value": 1.6e9,
                "total_qty_native": 1.0,
                "q_mass": None,
                "q_vol": 1.0e9,
                "q_count": None,
                "family": "volume",
                "price_base_month": dt.date(2026, 10, 1),
                "price_base_fx_date": None,
            }
        ]
    )
    out = serializers.serialize_product_ts_by_uf(linhas.copy(), available=True)
    sem_base = linhas.drop(columns=["price_base_month", "price_base_fx_date"])
    # Byte-identical to the snapshot's productTS for the same rows.
    assert out["productTS"] == serializers._product_ts(sem_base)
    assert out["productTS"]["2682"][0]["v"] == pytest.approx(1600.0)
    assert out["priceBase"] == {"column": None, "month": "2026-10", "fxDate": None}
    assert out["available"] is True


@pytest.mark.parametrize("available", [True, False])
def test_no_rows_is_an_empty_series_and_the_flag_tells_why(available):
    pytest.importorskip("flask")
    from embrapa_dashboard.webapi import serializers

    assert serializers.serialize_product_ts_by_uf(None, available=available) == {
        "productTS": {},
        "priceBase": None,
        "available": available,
    }


# ── 5. Route ────────────────────────────────────────────────────────────────────


def test_the_route_parses_the_ufs_conventions_and_axes(monkeypatch):
    from tests.test_webapi_routes import _client

    client = _client(monkeypatch)
    from embrapa_dashboard.webapi import seam

    captured = {}

    def fake(banco, conv, summary):
        captured.update(banco=banco, conv=conv, summary=summary)
        return None

    monkeypatch.setattr(seam, "product_ts_by_uf", fake)
    resp = client.get(
        "/api/product-ts?banco=mdic_comex&states=SP,MG&currency=USD&correction=Nominal"
        "&flow=import&niveis=commodity_pura"
    )
    assert resp.status_code == 200
    assert resp.get_json() == {"productTS": {}, "priceBase": None, "available": True}
    assert captured == {
        "banco": "mdic_comex",
        "conv": {"currency": "USD", "correction": "Nominal"},
        "summary": {"states": ["SP", "MG"], "flow": "import", "niveis": ["commodity_pura"]},
    }


def test_the_route_without_ufs_asks_the_seam_with_no_summary(monkeypatch):
    from tests.test_webapi_routes import _client

    client = _client(monkeypatch)
    from embrapa_dashboard.webapi import seam

    captured = {}

    def fake(banco, conv, summary):
        captured["summary"] = summary
        return None

    monkeypatch.setattr(seam, "product_ts_by_uf", fake)
    resp = client.get("/api/product-ts?banco=ibge_ppm")
    assert resp.status_code == 200
    assert resp.get_json() == {"productTS": {}, "priceBase": None, "available": True}
    assert captured["summary"] is None


@pytest.mark.parametrize(
    "query",
    [
        "banco=ibge_ppm&states=PA&currency=GBP",
        "banco=ibge_ppm&states=PA&correction=SELIC",
        "banco=mdic_comex&states=SP&flow=Exportacao",
        "banco=ibge_ppm&states=PA&niveis=nivel_inventado",
    ],
)
def test_the_route_refuses_a_bad_value_before_the_seam_runs(monkeypatch, query):
    from tests.test_webapi_routes import _client

    client = _client(monkeypatch)
    from embrapa_dashboard.webapi import seam

    def must_not_run(*a, **k):
        raise AssertionError("seam reached despite a bad value")

    monkeypatch.setattr(seam, "product_ts_by_uf", must_not_run)
    assert client.get(f"/api/product-ts?{query}").status_code == 400


def test_comtrade_says_it_has_no_reader(monkeypatch):
    from tests.test_webapi_routes import _client

    client = _client(monkeypatch)
    resp = client.get("/api/product-ts?banco=un_comtrade&states=PA")
    assert resp.status_code == 200
    assert resp.get_json() == {"productTS": {}, "priceBase": None, "available": False}
