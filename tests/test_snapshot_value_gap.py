"""The snapshot's month-level ``valueGap`` (v1.79.0).

Every COMEX screen but the three trade views (Visão geral, Valor × Volume, Geografia, the
product and territory profiles, Concentração) reads annual marts, whose build SUMs the
months — and a SUM swallows the month a convention cannot value. Measured on prod
2026-09-13: all 2.275 rows of August 2026 had no IPCA/IGP-DI value (IGP-M was in), so the
corrected 2026 total covered Jan–Jul under a "2026" label while the nominal one covered
through August; and every month of 1997–1998 has no € sem correção.

The list is MONTH-LEVEL and UNFILTERED on purpose: Gold joins the deflator and the FX by
year + month, so a missing index nulls every row of its month — exact for any product/UF/
flow the browser selects, from one cheap query per convention.
"""

from __future__ import annotations

import pandas as pd
import pytest

from embrapa_dashboard.serving import sql
from embrapa_dashboard.webapi import serializers as s


def _plano(texto: str) -> str:
    return " ".join(texto.split())


# ── the builder + reader ───────────────────────────────────────────────────────


def test_o_construtor_lista_os_meses_sem_filtro():
    q, params = sql.comex_value_gap_by_month(
        "p.serving.serving_comex_seasonality", value_column="val_real_ipca_brl"
    )
    plano = _plano(q)
    assert "from `p.serving.serving_comex_seasonality`" in plano
    assert "group by reference_year, reference_month" in plano
    assert "countif(val_real_ipca_brl is null) as rows_without_value" in plano
    assert "countif(val_real_ipca_brl is not null) as rows_with_value" in plano
    # Global de propósito: o índice falta por MÊS, para toda linha daquele mês.
    assert " where " not in f" {plano.lower()} "
    assert params == []


def test_o_construtor_recusa_coluna_fora_da_allowlist():
    with pytest.raises(ValueError):
        sql.comex_value_gap_by_month("p.s.seas", value_column="val_yearfx_usd) --")


def _bind_simplecache():
    """Bind the shared cache to a fresh Flask app on SimpleCache; return (app, cache)."""
    from flask import Flask

    from embrapa_dashboard.serving.cache import cache

    app = Flask(__name__)
    cache.init_app(app, config={"CACHE_TYPE": "SimpleCache", "CACHE_DEFAULT_TIMEOUT": 300})
    return app, cache


def test_o_leitor_consulta_o_mart_mensal(monkeypatch, settings_factory):
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.serving import gateway

    gravado = {}

    def gravador(query, params, **kwargs):
        gravado["query"] = query
        return "df"

    monkeypatch.setattr(gateway, "run_query", gravador)
    monkeypatch.setattr(gateway, "get_settings", lambda: settings_factory(gcp_project_id="p"))
    app, cache = _bind_simplecache()

    with app.app_context():
        cache.clear()
        out = gateway.fetch_comex_value_gap_by_month(value_column="val_yearfx_eur")

    assert out == "df"
    assert "serving_comex_seasonality" in gravado["query"]
    assert "countif(val_yearfx_eur is null)" in gravado["query"]


# ── the serializer ─────────────────────────────────────────────────────────────


def _meses(*linhas):
    """(ano, mês, linhas sem valor, linhas com valor) → the reader's frame."""
    return pd.DataFrame(
        [
            {
                "reference_year": a,
                "reference_month": m,
                "rows_without_value": sem,
                "rows_with_value": com,
            }
            for a, m, sem, com in linhas
        ]
    )


def test_o_ano_parcial_nomeia_o_mes_e_os_anos_inteiros_nao():
    # ÂNCORA EXTERNA, medida em produção 2026-09-13 (as contagens de 1997–1998 são as de €
    # sem correção; as de 2026 as de IPCA — aqui juntas só para exercitar os dois casos).
    df = _meses(
        (1997, 1, 396, 0),
        (1998, 12, 618, 0),
        (2025, 12, 0, 2211),
        (2026, 7, 0, 2255),
        (2026, 8, 2275, 0),
    )
    assert s._month_gap(df) == {
        "years": [1997, 1998, 2026],
        "partial": [2026],
        "months": {"2026": [8]},
        "share": None,  # a fração depende do recorte, que vive no navegador
    }


def test_sem_lacuna_ou_sem_quadro_nao_ha_nota():
    assert s._month_gap(_meses((2025, 1, 0, 10))) is None
    assert s._month_gap(None) is None
    assert s._month_gap(pd.DataFrame()) is None


def test_o_snapshot_carrega_a_lacuna():
    out = s.serialize_snapshot({"value_gap_months": _meses((2026, 7, 0, 5), (2026, 8, 5, 0))})
    assert out["valueGap"]["partial"] == [2026]
    assert out["valueGap"]["months"] == {"2026": [8]}
    assert s.serialize_snapshot({})["valueGap"] is None
