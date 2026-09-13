"""The COMEX coverage reader at the MONTHLY grain, and the serializer's defensive edges.

``comex_value_gap`` exists because the annual mart cannot answer "where is the convention's
value missing?": its build SUMs the months, and a SUM swallows a month without a deflator
inside a non-null year total. Measured on prod 2026-09-13 (Acre × castanha, US$ · IPCA):
the annual grain saw 0,2% of the trade without value, the monthly grain 2,05%. The partner
ranking and the Sankey take their totals from the annual mart and their coverage from here
(v1.78.0) — so this reader must hit the MONTHLY mart, with the same filters as those views.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from embrapa_dashboard.serving import sql
from embrapa_dashboard.webapi import serializers as s


def _plano(texto: str) -> str:
    return " ".join(texto.split())


# ── the builder ────────────────────────────────────────────────────────────────


def test_o_construtor_mede_por_ano_no_grao_mensal_com_os_filtros_das_telas():
    q, params = sql.comex_value_gap(
        "p.serving.serving_comex_seasonality",
        year_start=1997,
        year_end=2026,
        ncm_codes=("08012100", "08012200"),
        flow="export",
        uf_codes=("AC",),
        value_column="val_real_ipca_usd",
    )
    plano = _plano(q)
    assert "from `p.serving.serving_comex_seasonality`" in plano
    assert "group by reference_year" in plano
    # Contagens da COLUNA da convenção: é o que distingue o ano inteiro do ano parcial.
    assert "countif(val_real_ipca_usd is null) as rows_without_value" in plano
    assert "countif(val_real_ipca_usd is not null) as rows_with_value" in plano
    # O metro é o US$ declarado, que nunca falta.
    assert "sum(if(val_real_ipca_usd is null, val_yearfx_usd, null)) as unvalued_usd" in plano
    assert "sum(val_yearfx_usd) as total_usd" in plano
    por_nome = {p.name: p for p in params}
    assert por_nome["ncm_codes"].values == ["08012100", "08012200"]
    assert por_nome["uf_codes"].values == ["AC"]
    assert por_nome["flow"].value == "export"
    assert por_nome["year_start"].value == 1997 and por_nome["year_end"].value == 2026


def test_o_construtor_recusa_coluna_fora_da_allowlist():
    """Um identificador não pode ser parâmetro — a allowlist é o que o torna seguro."""
    with pytest.raises(ValueError):
        sql.comex_value_gap("p.s.seas", value_column="val_yearfx_usd) --")


# ── the gateway reader ─────────────────────────────────────────────────────────


def _bind_simplecache():
    """Bind the shared cache to a fresh Flask app on SimpleCache; return (app, cache)."""
    from flask import Flask

    from embrapa_dashboard.serving.cache import cache

    app = Flask(__name__)
    cache.init_app(app, config={"CACHE_TYPE": "SimpleCache", "CACHE_DEFAULT_TIMEOUT": 300})
    return app, cache


def test_o_leitor_consulta_o_mart_MENSAL(monkeypatch, settings_factory):
    """O mart anual esconde o mês sem deflator — ler dele devolveria 0,2% onde há 2,05%."""
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.serving import gateway

    gravado = {}

    def gravador(query, params, **kwargs):
        gravado["query"] = query
        gravado["params"] = {p.name: p for p in params}
        return "df"

    monkeypatch.setattr(gateway, "run_query", gravador)
    monkeypatch.setattr(gateway, "get_settings", lambda: settings_factory(gcp_project_id="p"))
    app, cache = _bind_simplecache()

    with app.app_context():
        cache.clear()
        out = gateway.fetch_comex_value_gap(
            year_start=2020,
            ncm_codes=("08012100",),
            flow="export",
            uf_codes=("AC",),
            value_column="val_yearfx_eur",
        )

    assert out == "df"
    assert "serving_comex_seasonality" in gravado["query"]
    assert "serving_comex_annual" not in gravado["query"]
    assert "countif(val_yearfx_eur is null)" in gravado["query"]
    assert gravado["params"]["uf_codes"].values == ["AC"]
    assert gravado["params"]["flow"].value == "export"


# ── the serializer's defensive edges ───────────────────────────────────────────


def test_soma_sem_nenhum_valor_e_ausente_nao_zero():
    """pandas devolve 0.0 para a soma de um grupo todo ausente; aqui ela é ausente."""
    assert s._present_sum(None) is None
    assert s._present_sum(pd.Series([None, math.nan])) is None
    assert s._present_sum(pd.Series([1.0, None, 2.0])) == 3.0


def test_celula_de_anos_sem_array_e_ignorada():
    """O BigQuery devolve NULL/NaN onde o array_agg não achou ano nenhum."""
    assert s._flat_years([[1997, 1998], None, math.nan, [], [2026]]) == {1997, 1998, 2026}
