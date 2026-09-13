"""A convenção pode não ter valor em parte da janela — e a tela tem de dizer onde (v1.78.0).

O euro só existe desde 1999 e o COMEX começa em 1997: na coluna `val_yearfx_eur` as 1.665
linhas de 1997 e as 1.758 de 1998 são NULL (medido em produção 2026-09-13). Um SUM pula o
NULL em silêncio, então com "€ · Sem correção" as três telas de comércio exterior mentiam
de três jeitos diferentes:

* **Parceiros e Sankey** somavam 1999–2026 sob um período que dizia 1997–2026;
* **o preço médio por parceiro** dividia o valor de 1999 em diante pelo peso desde 1997 —
  a quarta regra do projeto, as duas metades de uma razão sobre as mesmas linhas;
* **Sazonalidade** desenhava os 12 meses de 1998 como 0,0, e esses zeros entravam nas médias.

Enquanto as telas somavam só dólar a lacuna era inalcançável; a v1.77.0 as ligou à faixa de
convenções e a abriu. As âncoras abaixo são o recorte medido em produção: Acre ×
castanha-do-pará, exportação.
"""

from __future__ import annotations

import pandas as pd
import pytest

from embrapa_dashboard.serving import sql
from embrapa_dashboard.webapi import serializers as s

_EUR = "val_yearfx_eur"


def _plano(texto: str) -> str:
    return " ".join(texto.split())


# ── SQL ────────────────────────────────────────────────────────────────────────


def _partner_sql(**kw) -> str:
    q, _ = sql.trade_by_partner(
        "p.s.t",
        partner_code_column="country_code",
        partner_name_column="country_name",
        code_column="ncm_code",
        **kw,
    )
    return _plano(q)


def test_o_preco_por_parceiro_condiciona_as_duas_metades():
    q = _partner_sql(value_column=_EUR)
    assert (
        "safe_divide(sum(if(net_weight_kg is null or val_yearfx_eur is null, null, "
        "val_yearfx_eur)), sum(if(val_yearfx_eur is null, null, net_weight_kg)))"
    ) in q, "o peso de 1997–1998 entraria no denominador do preço em euro"


@pytest.mark.parametrize("leitor", ["partners", "flows", "seasonality"])
def test_os_tres_leitores_devolvem_o_par_de_cobertura(leitor):
    if leitor == "partners":
        q = _partner_sql(value_column=_EUR)
    elif leitor == "flows":
        q = _plano(
            sql.trade_flows(
                "p.s.t",
                origin_code_column="state_acronym",
                origin_name_column="state_name",
                dest_code_column="country_code",
                dest_name_column="country_name",
                code_column="ncm_code",
                value_column=_EUR,
            )[0]
        )
    else:
        q = _plano(sql.comex_seasonality("p.s.seas", value_column=_EUR)[0])
    # O metro é o US$ declarado, que nunca falta: mede o que a convenção não alcança.
    assert "sum(val_yearfx_usd) as total_usd" in q
    assert "sum(if(val_yearfx_eur is null, val_yearfx_usd, null)) as unvalued_usd" in q
    if leitor != "seasonality":  # na mensal, o NULL do próprio mês já diz onde
        assert "years_without_value" in q


# ── serializers ────────────────────────────────────────────────────────────────


def _parceiro(nome, valor, peso, anos=(), sem_valor=0.0, usd=None):
    return {
        "partner_name": nome,
        "exp_value": valor,
        "imp_value": 0.0,
        "total_value": valor,
        "total_weight_kg": peso,
        "priced_value": valor,
        "price_per_kg": (valor / peso) if (valor is not None and peso) else None,
        "total_usd": usd if usd is not None else valor,
        "unvalued_usd": sem_valor or None,
        "years_without_value": list(anos),
    }


def test_a_lacuna_do_ranking_cobre_a_JANELA_e_nao_a_pagina():
    """O corte top-N não pode esconder a lacuna: ela é calculada antes dele."""
    df = pd.DataFrame(
        [
            _parceiro("Peru", 67_750_000, 26_000_000, usd=77_650_000),
            # A Bolívia vendeu US$ 570 mil em 1997–1998 — anos que o euro não alcança.
            _parceiro(
                "Bolívia",
                37_010_000,
                80_000_000,
                anos=[1997, 1998],
                sem_valor=570_000,
                usd=47_120_000,
            ),
        ]
    )
    out = s.serialize_partner(df, max_rows=1, value_column=_EUR)
    assert [p["name"] for p in out["partners"]] == ["Peru"]  # a Bolívia ficou fora da página
    assert out["unit"] == "€"
    assert out["valueGap"]["years"] == [1997, 1998]  # …mas a lacuna dela, não
    assert out["valueGap"]["share"] == pytest.approx(570_000 / (77_650_000 + 47_120_000))


def test_parceiro_so_dos_anos_sem_valor_nao_vira_zero():
    df = pd.DataFrame(
        [
            _parceiro("Peru", 67_750_000, 26_000_000),
            _parceiro("Antigo", None, 5_000, anos=[1998], sem_valor=12_000, usd=12_000),
        ]
    )
    antigo = s.serialize_partner(df, value_column=_EUR)["partners"][1]
    assert antigo["value"] is None, "um parceiro sem valor na convenção virava '0,00 mi'"
    assert antigo["price"] is None


def test_sem_lacuna_nao_ha_nota():
    df = pd.DataFrame([_parceiro("Peru", 1_000_000, 1_000)])
    assert s.serialize_partner(df)["valueGap"] is None
    assert s.serialize_partner(None)["valueGap"] is None


def test_o_vinculo_do_sankey_sem_valor_nao_e_desenhado():
    links = pd.DataFrame(
        [
            {
                "origin_code": "AC",
                "origin_name": "Acre",
                "dest_code": "589",
                "dest_name": "Peru",
                "total_value": 67_750_000.0,
                "total_usd": 77_650_000.0,
                "unvalued_usd": None,
                "years_without_value": [],
            },
            {
                "origin_code": "AC",
                "origin_name": "Acre",
                "dest_code": "999",
                "dest_name": "Só em 1998",
                "total_value": None,
                "total_usd": 40_000.0,
                "unvalued_usd": 40_000.0,
                "years_without_value": [1998],
            },
        ]
    )
    out = s.serialize_flow({"links": links, "value_column": _EUR})
    assert [n["label"] for n in out["nodes"]] == ["Acre", "Peru"]
    assert len(out["links"]) == 1
    assert out["valueGap"]["years"] == [1998]
    assert out["valueGap"]["share"] == pytest.approx(40_000 / 77_690_000)


def _mes(ano, mes, valor, usd):
    return {
        "reference_year": ano,
        "reference_month": mes,
        "total_value": valor,
        "total_weight_kg": 1_000.0,
        "total_usd": usd,
        "unvalued_usd": usd if valor is None else None,
    }


def test_o_mes_sem_valor_fica_vazio_e_fora_da_media():
    # ÂNCORA: em dólar, janeiro de 1998 teve US$ 49,5 mil; em euro, não há valor.
    df = pd.DataFrame(
        [
            _mes(1998, 1, None, 49_500.0),
            _mes(1999, 1, 94_000.0, 105_000.0),
            _mes(2000, 1, 46_000.0, 42_000.0),
        ]
    )
    out = s.serialize_monthly(df, value_column=_EUR)
    assert out["matrix"]["1998"][0] is None, "janeiro de 1998 era desenhado como 0,0"
    assert out["matrix"]["1998"][1] == 0.0  # fevereiro sem LINHA: comércio nenhum registrado
    # A média de janeiro é sobre 1999 e 2000 — o zero falso de 1998 a puxava para baixo.
    assert out["monthlyAvg"][0] == pytest.approx((0.094 + 0.046) / 2)
    assert out["valueGap"]["years"] == [1998]
    assert out["valueGap"]["share"] == pytest.approx(49_500 / (49_500 + 105_000 + 42_000))
    assert out["series"][0]["v"] is None


def test_a_mensal_sem_lacuna_segue_como_antes():
    df = pd.DataFrame([_mes(2020, 1, 6_000_000.0, 6_000_000.0)])
    out = s.serialize_monthly(df)
    assert out["valueGap"] is None
    assert out["matrix"]["2020"][0] == 6.0 and out["matrix"]["2020"][1] == 0.0


# ── o ano que falta só EM PARTE ────────────────────────────────────────────────
# ÂNCORA EXTERNA, medida em produção 2026-09-13: em US$ · IPCA, TODAS as 2.275 linhas de
# agosto de 2026 do COMEX estão sem valor corrigido — o Gold deflaciona mês a mês e o IPCA
# de agosto ainda não entrou. A primeira versão da nota dizia "Esse ano fica fora da soma",
# e saiu um mês.


def test_os_leitores_dizem_tambem_os_anos_COM_valor():
    q = _partner_sql(value_column="val_real_ipca_usd")
    assert "if(val_real_ipca_usd is not null, reference_year, null)" in q
    assert "as years_with_value" in q


def test_o_ranking_marca_o_ano_parcial():
    df = pd.DataFrame(
        [
            {
                **_parceiro("Peru", 14_900_000, 5_000_000, anos=[2026], sem_valor=30_000),
                "years_with_value": [2025, 2026],
            },
            {
                **_parceiro("Antigo", None, 5_000, anos=[1998], sem_valor=1_000, usd=1_000),
                "years_with_value": [],
            },
        ]
    )
    gap = s.serialize_partner(df, value_column="val_real_ipca_usd")["valueGap"]
    assert gap["years"] == [1998, 2026]
    assert gap["partial"] == [2026]  # 1998 falta inteiro; 2026 só em parte


def test_a_mensal_marca_o_ano_parcial_e_deixa_vazio_so_o_mes_sem_valor():
    df = pd.DataFrame(
        [
            _mes(1998, 1, None, 49_500.0),  # o ano inteiro sem valor na convenção
            _mes(2026, 7, 5_000_000.0, 5_000_000.0),
            _mes(2026, 8, None, 1_200_000.0),  # só agosto
        ]
    )
    out = s.serialize_monthly(df, value_column="val_real_ipca_usd")
    assert out["valueGap"]["years"] == [1998, 2026]
    assert out["valueGap"]["partial"] == [2026]
    assert out["matrix"]["2026"][6] == 5.0 and out["matrix"]["2026"][7] is None


# ── COMEX: a cobertura medida no grão MENSAL ───────────────────────────────────
# O mart anual soma os meses, e a soma engole o mês sem deflator dentro de um total anual
# não nulo. ÂNCORA EXTERNA, medida em produção 2026-09-13 (Acre × castanha, US$ · IPCA): o
# grão anual via 0,2% do comércio sem valor, o mensal 2,05%. Parceiros e Sankey tiram o
# total do mart anual e a cobertura do mensal.


def _cobertura(*anos):
    """Linhas de fetch_comex_value_gap: (ano, linhas sem valor, com valor, US$ sem, US$)."""
    return pd.DataFrame(
        [
            {
                "reference_year": a,
                "rows_without_value": sem,
                "rows_with_value": com,
                "unvalued_usd": us_sem,
                "total_usd": us,
            }
            for a, sem, com, us_sem, us in anos
        ]
    )


def test_a_cobertura_mensal_vence_a_do_quadro_anual():
    df = pd.DataFrame(
        [
            {
                **_parceiro("Peru", 1e7, 1e6, anos=[2026], sem_valor=30_000, usd=1e7),
                "years_with_value": [2026],
            }
        ]
    )
    gap_rows = _cobertura((2025, 0, 12, None, 1.0e7), (2026, 5, 20, 3.0e6, 1.5e7))
    gap = s.serialize_partner(df, gap_rows=gap_rows)["valueGap"]
    assert gap["years"] == [2026] and gap["partial"] == [2026]
    # Os US$ 3 mi de agosto sobre o recorte — não os US$ 30 mil que o quadro anual enxergava.
    assert gap["share"] == pytest.approx(3.0e6 / 2.5e7)


def test_cobertura_mensal_sem_lacuna_nao_gera_nota():
    df = pd.DataFrame([_parceiro("Peru", 1e7, 1e6)])
    assert (
        s.serialize_partner(df, gap_rows=_cobertura((2025, 0, 12, None, 1e7)))["valueGap"] is None
    )
    assert s.serialize_partner(df, gap_rows=pd.DataFrame())["valueGap"] is None


def test_o_seam_mede_a_cobertura_do_comex_no_grao_mensal(monkeypatch):
    from embrapa_dashboard.webapi import seam

    pedidos: dict = {}
    monkeypatch.setattr(seam.gateway, "fetch_comex_partners", lambda **k: pd.DataFrame())
    monkeypatch.setattr(seam.gateway, "fetch_comex_flows", lambda **k: pd.DataFrame())
    monkeypatch.setattr(
        seam.gateway,
        "fetch_comex_seasonality_columns",
        lambda: frozenset({"val_yearfx_usd", "val_real_ipca_usd"}),
    )
    monkeypatch.setattr(
        seam.gateway,
        "fetch_comex_value_gap",
        lambda **k: pedidos.update(k) or _cobertura((2026, 5, 20, 1.0, 2.0)),
    )
    filtro = {
        "basket": ["08012100"],
        "states": ["AC"],
        "startDate": "1997",
        "endDate": "2026",
        "flow": "export",
    }
    ipca = {"currency": "USD", "correction": "IPCA"}

    assert seam.partner_data("mdic_comex", filtro, conv=ipca)["gap_rows"] is not None
    assert pedidos == {
        "year_start": 1997,
        "year_end": 2026,
        "ncm_codes": ("08012100",),
        "flow": "export",
        "uf_codes": ("AC",),
        "value_column": "val_real_ipca_usd",
    }
    pedidos.clear()
    assert seam.flow_data("mdic_comex", filtro, conv=ipca)["gap_rows"] is not None
    assert pedidos["flow"] == "export"  # o Sankey do COMEX é só exportação

    # Sem lacuna possível (o US$ declarado) ou sem a coluna no mart mensal: não consulta.
    pedidos.clear()
    assert seam.partner_data("mdic_comex", filtro)["gap_rows"] is None
    euro_ipca = {"currency": "EUR", "correction": "IPCA"}
    assert seam.partner_data("mdic_comex", filtro, conv=euro_ipca)["gap_rows"] is None
    assert pedidos == {}
