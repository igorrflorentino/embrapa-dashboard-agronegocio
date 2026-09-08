"""O preço de porteira soma duas pesquisas — e cada uma entra com as DUAS metades ou nenhuma.

``_gate_price_by_year`` soma PEVS (extração nativa) e PAM (lavoura) porque o outro lado
da comparação é o preço FOB da alfândega, que não distingue origem produtiva. A soma
estava certa; o pareamento não. ``(ve or 0) + (vc or 0)`` sobre ``(qe or 0) + (qc or 0)``
acumula as duas metades INDEPENDENTEMENTE: uma pesquisa com quantidade e sem valor entra
com 0 no numerador e com a quantidade inteira no denominador, e o que sai não é um preço
— é um preço diluído pela produção que ninguém precificou.

Medido em produção 2026-09-07: o IBGE não tem ``val_yearfx_usd`` antes de 1994 (a PEVS de
1986 a 1993, a PAM de 1974 a 1993) e a quantidade existe em todos esses anos — sempre
tudo-ou-nada dentro do ano (1993: 232 de 232 linhas na PEVS, 260 de 260 na PAM). Hoje
esses anos não chegam à tela porque a série se cruza com o COMEX, que começa em 1997:
imunidade por DADO, não por construção. É a mesma forma da imunidade do COMEX ao peso
faltante — e foi ela que deixou o defeito irmão viver na produção (v1.70.0).

Há ainda um segundo ponto onde a ausência morria antes: ``sum()`` do pandas devolve
``0.0`` para um grupo inteiramente NaN, e um 0.0 é indistinguível de um zero medido.
Daí o ``min_count=1``.
"""

from __future__ import annotations

import pandas as pd
import pytest

from embrapa_dashboard.webapi import seam_cross


@pytest.fixture
def sem_rede(monkeypatch):
    """Substitui o leitor do gateway por um cubo à mão, com o vão do valor no lugar."""

    def fake(banco, codes, value_column, uf_codes=()):
        assert codes, "o leitor não pode ser chamado com lista de códigos vazia"
        # 1993: quantidade sim, valor NÃO (o vão do USD nominal do IBGE).
        # 1994: as duas metades presentes.
        linhas = [
            {"reference_year": 1993, "total_value": None, "total_qty_native": 100.0},
            {"reference_year": 1994, "total_value": 500.0, "total_qty_native": 100.0},
        ]
        if banco == "ibge_pam":  # a lavoura é maior, e é ela que dilui se entrar sozinha
            linhas = [
                {"reference_year": 1993, "total_value": None, "total_qty_native": 900.0},
                {"reference_year": 1994, "total_value": 4500.0, "total_qty_native": 900.0},
            ]
        return pd.DataFrame(linhas)

    monkeypatch.setattr(seam_cross.gateway, "fetch_product_timeseries", fake)


def test_ano_sem_valor_recusa_em_vez_de_valer_zero(sem_rede):
    preco = seam_cross._gate_price_by_year(("3901",), ("40124",))
    assert preco[1993] is None, (
        "um ano em que nenhuma pesquisa tem valor não vale US$ 0,00/kg — não há preço"
    )


def test_ano_completo_continua_sendo_calculado(sem_rede):
    """A recusa não pode virar recusa geral: o ano com as duas metades tem preço."""
    preco = seam_cross._gate_price_by_year(("3901",), ("40124",))
    # (500 + 4500) US$ ÷ ((100 + 900) t × 1000 kg/t) = 5000 ÷ 1e6 = 0,005 US$/kg
    assert preco[1994] == pytest.approx(0.005)


def test_uma_pesquisa_sem_valor_nao_dilui_a_outra(monkeypatch):
    """O caso ASSIMÉTRICO — o que o pareamento existe para impedir.

    A PEVS traz as duas metades; a PAM traz só quantidade. Sem pareamento, a quantidade
    da PAM engrossa o denominador sem que seu valor engrosse o numerador, e o preço
    despenca para um décimo do verdadeiro. A âncora aqui é EXTERNA ao código: o preço
    correto sai de aritmética feita à mão sobre a fixture.
    """

    def fake(banco, codes, value_column, uf_codes=()):
        if banco == "ibge_pam":
            return pd.DataFrame(
                [{"reference_year": 2000, "total_value": None, "total_qty_native": 900.0}]
            )
        return pd.DataFrame(
            [{"reference_year": 2000, "total_value": 500.0, "total_qty_native": 100.0}]
        )

    monkeypatch.setattr(seam_cross.gateway, "fetch_product_timeseries", fake)
    preco = seam_cross._gate_price_by_year(("3901",), ("40124",))
    # Só a PEVS tem as duas metades: 500 ÷ (100 × 1000) = 0,005 US$/kg.
    assert preco[2000] == pytest.approx(0.005)
    # Se a quantidade da PAM entrasse sozinha: 500 ÷ (1000 × 1000) = 0,0005 — dez vezes
    # menor, e indistinguível de um preço de mercado baixo.
    assert preco[2000] != pytest.approx(0.0005)


def test_a_soma_do_grupo_todo_ausente_nao_vira_zero(monkeypatch):
    """Guarda do ponto ANTERIOR: `sum()` do pandas devolve 0.0 para um grupo só de NaN.

    Sem `min_count=1` a ausência morre aqui, e nenhuma guarda a jusante pode vê-la —
    o valor 0.0 que chega já não se distingue de um zero medido.
    """

    def fake(banco, codes, value_column, uf_codes=()):
        return pd.DataFrame(
            [
                {"reference_year": 1993, "total_value": None, "total_qty_native": 50.0},
                {"reference_year": 1993, "total_value": None, "total_qty_native": 50.0},
            ]
        )

    monkeypatch.setattr(seam_cross.gateway, "fetch_product_timeseries", fake)
    por_ano = seam_cross._gate_value_qty_by_year("ibge_pevs", ("3901",))
    valor, _ = por_ano[1993]
    assert pd.isna(valor), f"a soma de um grupo inteiramente ausente virou {valor!r}"
