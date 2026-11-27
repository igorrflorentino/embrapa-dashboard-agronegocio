"""Os preços da Análise cruzada dividem valor e quantidade das MESMAS linhas — provado no SQL real.

Três preços dividem valor por quantidade, por agrupamento e ano: os dois de "Preço: porteira
vs. FOB" (``seam_cross.price_spread``) e o preço de exportação do Cruzamento entre fontes
(``mdic_comex:exp_price``). Até a v1.108.11 cada metade era uma soma sobre as PRÓPRIAS
linhas — o FOB e o preço de exportação dividiam a série ``exp_value`` pela ``exp_weight``, a
porteira dividia ``total_value`` por ``total_qty_native`` —, e uma linha com valor e sem
quantidade entrava só no numerador. Hoje nenhuma linha do COMEX tem valor sem peso, e nenhuma
do IBGE tem valor sem quantidade (medido na produção em 2026-11-23): os números estavam certos
por DADO. Desde a v1.108.12 as duas metades vêm sob uma só condição (``sql._priced_pair``), e
ficam certos por construção.

Aqui só o armazém é trocado: ``gateway.run_query`` executa num sqlite o SQL que os próprios
construtores montam, e todo o resto — leitores, memoização, costura — é o código de produção.
Cada tabela tem UMA linha com valor e sem quantidade, e o preço certo sai de conta feita à mão
sobre a fixture. Contraprova: rodados contra o ``src/`` do main (fe1aa51), os três testes de
preço falham com FOB 13,85, porteira 2,2 e preço de exportação 13,85 US$/kg.
"""

from __future__ import annotations

import re
import sqlite3

import pandas as pd
import pytest

flask = pytest.importorskip("flask")
pytest.importorskip("flask_caching")

from embrapa_dashboard.config import Settings  # noqa: E402
from embrapa_dashboard.serving import gateway  # noqa: E402
from embrapa_dashboard.serving.cache import cache  # noqa: E402
from embrapa_dashboard.webapi import seam_base, seam_cross  # noqa: E402

_CATALOGO = {
    "castanha": {
        "id": "castanha",
        "name": "Castanha",
        "pevs": ["3404"],
        "pam": ["40143"],
        "ppm": [],
        "comex": ["08012200"],
        "comtrade": [],
    }
}


def _literal(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    return repr(v)


def _para_sqlite(sql: str, params) -> str:
    """O SQL do BigQuery que estes leitores montam, no dialeto do sqlite: tabela sem projeto e
    dataset, parâmetros escritos no texto, e o ``array_agg(… limit 1)[offset(0)]`` da família
    trocado por ``min(family)`` (a fixture tem uma família por produto)."""
    por_nome = {p.name: p for p in params}
    sql = re.sub(r"`[^`]*\.([A-Za-z0-9_]+)`", r"\1", sql)
    sql = re.sub(
        r"in\s+unnest\(@(\w+)\)",
        lambda m: "in (" + ", ".join(_literal(v) for v in por_nome[m.group(1)].values) + ")",
        sql,
        flags=re.I,
    )
    sql = re.sub(r"@(\w+)", lambda m: _literal(por_nome[m.group(1)].value), sql)
    return re.sub(
        r"array_agg\(family order by .*? limit 1\)\[offset\(0\)\]", "min(family)", sql, flags=re.S
    )


@pytest.fixture
def armazem(monkeypatch):
    """As três tabelas pré-agregadas que os preços leem, cada uma com UMA linha desemparelhada."""
    con = sqlite3.connect(":memory:")
    con.executescript(
        """
        create table serving_comex_annual (reference_year int, ncm_code text, flow text,
            state_acronym text, val_yearfx_usd real, net_weight_kg real);
        create table serving_pevs_annual (product_code text, reference_year int, tabela text,
            state_acronym text, family text, qty_native real, qty_base real,
            val_yearfx_usd real);
        create table serving_pam_annual (product_code text, reference_year int, tabela text,
            state_acronym text, family text, qty_native real, qty_base real,
            val_yearfx_usd real);
        """
    )
    con.executemany(
        "insert into serving_comex_annual values (?, ?, ?, ?, ?, ?)",
        [
            (2020, "08012200", "export", "PA", 1000.0, 100.0),
            (2020, "08012200", "export", "AM", 500.0, None),  # valor SEM peso
            (2020, "08012200", "export", "PA", 300.0, 30.0),
            (2020, "08012200", "import", "SP", 9999.0, 1.0),  # outro fluxo: nunca entra
        ],
    )
    con.executemany(
        "insert into serving_pevs_annual values (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("3404", 2020, "289", "PA", "massa", 50.0, 50.0, 100_000.0),
            ("3404", 2020, "289", "AM", "massa", None, None, 40_000.0),  # valor SEM quantidade
        ],
    )
    con.executemany(
        "insert into serving_pam_annual values (?, ?, ?, ?, ?, ?, ?, ?)",
        [("40143", 2020, "5457", "PA", "massa", 150.0, 150.0, 300_000.0)],
    )

    def run_query(sql, params, **_kw):
        return pd.read_sql_query(_para_sqlite(sql, params), con)

    def _settings():
        return Settings(_env_file=None, gcp_project_id="p")

    monkeypatch.setattr(gateway, "run_query", run_query)
    for modulo in (gateway, seam_base, seam_cross):
        monkeypatch.setattr(modulo, "get_settings", _settings, raising=False)
    monkeypatch.setattr(seam_base, "produto_catalog", lambda: _CATALOGO)
    monkeypatch.setattr(seam_cross, "_is_mass_basis", lambda cid: True)
    app = flask.Flask(__name__)
    cache.init_app(app, config={"CACHE_TYPE": "SimpleCache", "CACHE_DEFAULT_TIMEOUT": 300})
    with app.app_context():
        cache.clear()
        yield con
    con.close()


def _ponto_2020():
    serie = seam_cross.price_spread("castanha")["series"]
    assert [p["y"] for p in serie] == [2020]
    return serie[0]


def test_o_preco_fob_divide_valor_e_peso_dos_mesmos_embarques(armazem):
    # Os embarques com valor E peso: (1000 + 300) US$ ÷ (100 + 30) kg = 10 US$/kg. Somar o
    # valor do embarque sem peso daria 1800 ÷ 130 = 13,85 — 38% acima.
    assert _ponto_2020()["fob"] == pytest.approx(10.0)


def test_o_preco_de_porteira_divide_valor_e_quantidade_das_mesmas_linhas(armazem):
    # PEVS e PAM somadas, só as linhas com valor E massa: (100.000 + 300.000) US$ ÷
    # ((50 + 150) t × 1000) = 2 US$/kg. Com o valor da linha sem quantidade: 2,2.
    ponto = _ponto_2020()
    assert ponto["gate"] == pytest.approx(2.0)
    assert ponto["markup"] == pytest.approx(5.0)
    assert ponto["spread"] == pytest.approx(8.0)


def test_o_preco_de_exportacao_divide_valor_e_peso_dos_mesmos_embarques(armazem):
    # O Cruzamento entre fontes lê o COMEX inteiro (sem agrupamento): o mesmo 1300 ÷ 130.
    pontos, _ = seam_cross._cross_points("mdic_comex", "exp_price", 2020, 2020, "US$/kg")
    assert [p["y"] for p in pontos] == [2020]
    assert pontos[0]["v"] == pytest.approx(10.0)


def test_cada_preco_diz_quanto_do_valor_o_sustenta(armazem):
    """A cobertura que a tela nomeia abaixo de 90%: o valor das linhas com as duas medidas
    sobre o valor de todas. FOB e exportação: 1300 de 1800 US$; porteira: 400 de 440 mil."""
    ponto = _ponto_2020()
    assert ponto["fobPricedShare"] == pytest.approx(1300 / 1800)
    assert ponto["gatePricedShare"] == pytest.approx(400_000 / 440_000)
    pontos, _ = seam_cross._cross_points("mdic_comex", "exp_price", 2020, 2020, "US$/kg")
    assert pontos[0]["pricedShare"] == pytest.approx(1300 / 1800)


def test_um_ano_sem_linha_inteira_nao_tem_preco(armazem):
    """Sem nenhuma linha com as duas medidas, o ano não tem preço — nem divisão por 1, nem
    US$ 0/kg —, e também não tem cobertura a declarar."""
    armazem.execute(
        "insert into serving_comex_annual values (2021, '08012200', 'export', 'PA', 700.0, null)"
    )
    pontos, _ = seam_cross._cross_points("mdic_comex", "exp_price", 2020, 2021, "US$/kg")
    assert pontos[1] == {"y": 2021, "v": None, "pricedShare": None}
