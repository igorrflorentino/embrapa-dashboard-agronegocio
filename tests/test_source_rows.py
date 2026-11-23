"""The Gold rows behind each point travel to the screen (v1.108.10).

The hero's "Linhas" counter used to ESTIMATE how many Gold rows the recorte held, multiplying
the banco's total by the shares of value of each filter. A share of VALUE is not a share of
ROWS, so the estimate could be anything: PAM açaí 1990–2000 read thousands of rows over a
period the product has no row in. The marts already count their Gold rows (``source_rows =
count(*)``), so the reads that apply the screen's filters now return that count, and the
counter sums it. These tests pin each link: the SQL asks only when told to, every table it
asks exists with the column, the serializer passes it on only when it was asked, and the
seam asks on exactly the reads the counter sums.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd
import pytest

from embrapa_dashboard.serving import sql as sqlbuild

_RAIZ = Path(__file__).resolve().parents[1]
_SERVING = _RAIZ / "dbt" / "models" / "serving"


def _seam():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam

    return seam


def _serializers():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import serializers

    return serializers


# ── 1. The SQL asks for the count only when told to ────────────────────────────

# (builder, the expression it must select). A mart row already counts its Gold rows, so a
# grouped read SUMS them; the município cube reads Gold itself, so it COUNTS them.
_LEITORES = {
    "production_by_uf_yearly": (
        lambda **k: sqlbuild.production_by_uf_yearly("t", **k),
        "sum(source_rows) as source_rows",
    ),
    "comex_by_uf_yearly": (
        lambda **k: sqlbuild.comex_by_uf_yearly("t", **k),
        "sum(source_rows) as source_rows",
    ),
    "product_timeseries": (
        lambda **k: sqlbuild.product_timeseries("t", code_column="product_code", **k),
        "sum(source_rows) as source_rows",
    ),
    "production_by_municipio_yearly": (
        lambda **k: sqlbuild.production_by_municipio_yearly("t", **k),
        "count(*) as source_rows",
    ),
}


@pytest.mark.parametrize("nome", sorted(_LEITORES))
def test_each_reader_counts_only_when_asked(nome):
    montar, expressao = _LEITORES[nome]
    sem, params_sem = montar(value_column="val_real_ipca_brl")
    # Off by default: every caller that does not ask builds the SQL it built before.
    assert "source_rows" not in sem
    assert montar(value_column="val_real_ipca_brl", rows=False) == (sem, params_sem)

    com, params_com = montar(value_column="val_real_ipca_brl", rows=True)
    assert expressao in com
    # In the select that sums the value, and never a group-by key: a group per count
    # would split every point by how many rows it happens to have.
    assert com.index("source_rows") < com.index("from `t`")
    assert "source_rows" not in com[com.index("group by") :]
    # A column the read returns, not a filter: it binds no parameter.
    assert params_com == params_sem


def test_the_count_rides_with_the_price_base():
    """Both flags are independent additions to the same select."""
    sql, _ = sqlbuild.production_by_uf_yearly(
        "t", value_column="val_real_ipca_brl", rows=True, price_base=True
    )
    assert "sum(source_rows) as source_rows" in sql
    assert "max(ipca_base_month) as price_base_month" in sql


# ── 2. Every table a counted read can read carries the column ──────────────────


def _mart_sql(mart: str) -> str:
    return (_SERVING / f"{mart}.sql").read_text(encoding="utf-8")


def _marts_contados() -> set[str]:
    """The marts behind the three counted mart reads, taken from the gateway's own maps.

    Derived, not listed: a banco added to ``_PRODUCT_SOURCES`` joins the snapshot's counted
    series the day it is registered, and so must its mart's column."""
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.serving import gateway

    marts = {mart for mart, *_ in gateway._PRODUCT_SOURCES.values()}  # product_timeseries
    marts |= set(gateway._PRODUCTION_MART.values())  # production_by_uf_yearly
    marts.add("serving_comex_annual")  # comex_by_uf_yearly
    return marts


def test_every_counted_mart_counts_its_gold_rows():
    marts = _marts_contados()
    assert len(marts) == 5  # the five annual marts — one per banco
    for mart in sorted(marts):
        # count(*) over the Gold rows the mart row aggregates, then carried to the output.
        assert re.search(r"count\(\*\)\s+as source_rows", _mart_sql(mart)), mart
        assert re.search(r"\.source_rows\b", _mart_sql(mart)), mart


# ── 3. The serializer passes the count on only when it was asked ───────────────


def test_a_frame_without_the_column_was_not_counted():
    s = _serializers()
    linha = next(pd.DataFrame([{"total_value": 1.0}]).itertuples())
    # No key at all: the client reads a missing ``rows`` as "not counted", never as zero.
    assert s._source_rows(linha) == {}


def test_a_count_is_an_integer_and_a_missing_one_is_none():
    s = _serializers()
    linhas = list(pd.DataFrame({"source_rows": [3.0, float("nan"), 0]}).itertuples())
    assert [s._source_rows(r) for r in linhas] == [{"rows": 3}, {"rows": None}, {"rows": 0}]


def _uf_ano(**extra):
    return pd.DataFrame(
        [
            {
                "reference_year": 2020,
                "state_acronym": "PA",
                "state_name": "Pará",
                "region_abbrev": "N",
                "total_value": 2e6,
                "q_mass": 1e3,
                "q_vol": 0.0,
                **extra,
            }
        ]
    )


def test_the_grids_carry_rows_only_when_the_read_counted():
    s = _serializers()
    assert "rows" not in s.serialize_geo_yearly(_uf_ano())["ufYearly"][0]
    assert s.serialize_geo_yearly(_uf_ano(source_rows=41))["ufYearly"][0]["rows"] == 41

    cidade = _uf_ano(city_code="1505502").drop(columns=["state_name", "region_abbrev"])
    assert "rows" not in s.serialize_municipio_yearly(cidade)["municipioYearly"][0]
    contada = cidade.assign(source_rows=7)
    assert s.serialize_municipio_yearly(contada)["municipioYearly"][0]["rows"] == 7

    serie = pd.DataFrame(
        [{"code": "45982", "reference_year": 2020, "total_value": 1e6, "family": "massa"}]
    )
    assert "rows" not in s._product_ts(serie)["45982"][0]
    assert s._product_ts(serie.assign(source_rows=12))["45982"][0]["rows"] == 12


# ── 4. The seam asks on exactly the reads the counter sums ─────────────────────


def test_the_basket_cube_is_counted_in_both_shapes(monkeypatch):
    seam = _seam()
    pedidos = {}

    def gravar(nome):
        def fake(**k):
            pedidos[nome] = k.get("with_rows", "AUSENTE")
            return pd.DataFrame()

        return fake

    monkeypatch.setattr(seam.gateway, "fetch_production_by_uf_yearly", gravar("producao"))
    monkeypatch.setattr(seam.gateway, "fetch_comex_by_uf_yearly", gravar("comex"))
    conv = {"currency": "BRL", "correction": "Nominal"}
    seam.geo_yearly("ibge_pam", conv, {"basket": ["45982"]})
    seam.geo_yearly("mdic_comex", {"currency": "USD", "correction": "Nominal"}, None)
    assert pedidos == {"producao": True, "comex": True}


def test_the_municipio_cube_is_counted(monkeypatch):
    seam = _seam()
    pedidos = {}

    def fake(**k):
        pedidos.update(k)
        return pd.DataFrame()

    monkeypatch.setattr(seam.gateway, "fetch_production_by_municipio_yearly", fake)
    seam.geo_municipio_yearly(
        "ibge_pevs",
        {"currency": "BRL", "correction": "Nominal"},
        {"cityCodes": ["1505502", "1501808"]},
    )
    assert pedidos["with_rows"] is True
