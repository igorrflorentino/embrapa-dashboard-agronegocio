"""A VARREDURA que impede a quarta instância de "lista vazia = sem filtro".

``seam_base._codes(agrupamento_id, source)`` devolve ``()`` quando o agrupamento não tem
lado naquela fonte — e ``()`` significa **"sem filtro"** para os leitores do gateway. As
duas leituras são individualmente razoáveis e a composição é uma armadilha: uma view
que não guarda o resultado publica o **banco inteiro** como se fosse o produto escolhido.

Três instâncias em um dia (2026-09-07):

* ``export_coefficient`` — o denominador lia só a PEVS enquanto o numerador cobria as
  duas origens; ao somar a PAM, um agrupamento sem lado PEVS teria lido a PEVS inteira.
* ``price_spread`` — **o defeito chegou à produção**: o lado FOB era guardado e o da
  porteira não, e soja e milho exibiam o MESMO "preço de porteira" (US$ 0,019/kg em
  2020), que era o preço implícito de toda a PEVS. Markup fabricado de 25,24× na soja.
* ``market_nature`` e ``trade_mirror`` já guardavam — e foi comparar com eles que
  mostrou o que faltava nas outras duas.

Nenhuma varredura TEXTUAL pega isto: o defeito é a AUSÊNCIA de um ``if``, e um leitor
chamado com códigos vazios é idêntico, no código, a um chamado sem escopo (que é
legítimo — é a cesta completa). Então esta varredura é COMPORTAMENTAL: dá a cada entrada
um agrupamento sem código nenhum e exige que ela recuse, em vez de servir o total.
"""

from __future__ import annotations

import pytest

from embrapa_dashboard.webapi import seam_attribute_engineering, seam_base, seam_cross

# Toda entrada pública que recebe um agrupamento e consulta um banco por códigos.
# Uma entrada NOVA que não esteja aqui é o buraco por onde a quarta instância entra —
# `test_a_varredura_cobre_toda_entrada_publica` falha quando alguém acrescenta uma.
ENTRADAS = [
    ("export_coefficient", lambda: seam_cross.export_coefficient("assimetrico")),
    ("price_spread", lambda: seam_cross.price_spread("assimetrico")),
    ("market_share", lambda: seam_cross.market_share("assimetrico")),
    ("trade_mirror", lambda: seam_cross.trade_mirror("assimetrico")),
    ("market_nature", lambda: seam_attribute_engineering.market_nature("assimetrico")),
    ("value_added", lambda: seam_attribute_engineering.value_added("assimetrico")),
]

_MODULOS = (seam_cross, seam_attribute_engineering)


# O agrupamento ASSIMÉTRICO é a sonda certa, e descobri isso errando primeiro: uma
# sonda "sem código em fonte alguma" é barrada pela PRIMEIRA guarda de qualquer view
# (todas checam ao menos uma fonte), então ela passava mesmo com o defeito injetado.
#
# Os três defeitos reais eram todos assimétricos — o agrupamento TEM código numa fonte e
# não tem em outra, a view guarda a que tem e lê a que não tem sem filtro. Soja é o caso
# vivo: NCM sim, PAM sim, PEVS não — e o preço de porteira lia a PEVS inteira.
_ASSIMETRICO = {
    "assimetrico": {
        "name": "Assimétrico",
        "family": "massa",
        "pevs": [],  # AUSENTE de propósito: é aqui que a leitura sem filtro entra
        "pam": ["40124"],
        "ppm": [],
        "comex": ["12010010"],
        "comtrade": ["120100"],
    }
}


@pytest.fixture
def catalogo_sem_codigos(monkeypatch):
    """Um agrupamento com código em UMAS fontes e não em outras — o caso perigoso."""
    vazio = _ASSIMETRICO
    for mod in _MODULOS:
        monkeypatch.setattr(mod.seam_base, "produto_catalog", lambda: vazio, raising=False)
    monkeypatch.setattr(seam_base, "produto_catalog", lambda: vazio)
    # A base é de massa: sem isto, export_coefficient/price_spread recusariam pela
    # FAMÍLIA e o teste passaria sem nunca exercitar a guarda de códigos.
    monkeypatch.setattr(seam_cross, "_is_mass_basis", lambda cid: True)
    return vazio


@pytest.fixture
def gateway_que_recusa_escopo_vazio(monkeypatch):
    """Todo leitor do gateway estoura se for chamado com uma lista de códigos VAZIA.

    Esta é a âncora externa da varredura: em vez de conferir o formato da resposta (que
    um bug pode acertar por acaso), ela observa o que a view FAZ — e "consultou o banco
    sem filtro" é exatamente o defeito, independentemente do que seja devolvido depois.
    """
    chamadas: list[str] = []

    def barreira(nome):
        def _f(*args, **kwargs):
            escopo = kwargs.get("codes", kwargs.get("product_codes", kwargs.get("ncm_codes")))
            if escopo is not None and len(tuple(escopo)) == 0:
                pytest.fail(f"{nome} consultado com códigos VAZIOS — leria o banco inteiro")
            chamadas.append(nome)
            return None

        return _f

    for mod in _MODULOS:
        gw = mod.gateway
        for nome in dir(gw):
            if nome.startswith("fetch_"):
                monkeypatch.setattr(gw, nome, barreira(nome), raising=False)

    # _xyear recebe os códigos direto, sem passar por um fetch_ nomeado.
    def xyear(metric, codes, uf_codes=()):
        if len(tuple(codes)) == 0:
            pytest.fail(f"_xyear({metric!r}) chamado com códigos VAZIOS")
        return {}

    for mod in _MODULOS:
        monkeypatch.setattr(mod.seam_base, "_xyear", xyear, raising=False)
    return chamadas


# Os leitores INTERNOS que recebem uma lista de códigos e consultam um banco. A
# varredura de entradas acima só alcança os que a primeira etapa do fluxo chama — com o
# gateway devolvendo vazio, a interseção de anos fecha e as etapas seguintes não rodam.
# Encher a barreira com um DataFrame que satisfizesse todos os leitores criaria um
# esquema-sombra que apodrece; cobrir cada leitor DIRETAMENTE é robusto e completo.
LEITORES = [
    ("_mass_by_year", lambda: seam_cross._mass_by_year("ibge_pevs", ())),
    ("_gate_price_by_year", lambda: seam_cross._gate_price_by_year((), ())),
    ("_production_by_uf", lambda: seam_cross._production_by_uf("ibge_pevs", (), 2000, 2024, ())),
]


@pytest.mark.parametrize(("nome", "chamar"), LEITORES, ids=[e[0] for e in LEITORES])
def test_leitor_interno_nao_consulta_com_lista_vazia(nome, chamar, gateway_que_recusa_escopo_vazio):
    """Cada leitor recusa sozinho, sem depender da guarda de quem o chama.

    Defesa em profundidade de propósito: as três instâncias reais foram guardas de VIEW
    que faltavam, e um leitor que se protege torna a próxima omissão inofensiva.
    """
    assert not chamar(), f"{nome} devolveu dado para uma lista de códigos vazia"


@pytest.mark.parametrize(("nome", "chamar"), ENTRADAS, ids=[e[0] for e in ENTRADAS])
def test_entrada_recusa_em_vez_de_ler_o_banco_inteiro(
    nome, chamar, catalogo_sem_codigos, gateway_que_recusa_escopo_vazio
):
    """Nenhum banco pode ser consultado com a lista de códigos VAZIA.

    A asserção é sobre o que a view FAZ, não sobre o que devolve: a barreira do gateway
    estoura na hora da consulta sem filtro. Uma view pode legitimamente devolver dados
    aqui (o agrupamento TEM código em algumas fontes) — o que ela não pode é completar a
    parte que falta com o total do banco.
    """
    saida = chamar()
    assert isinstance(saida, dict), f"{nome} não devolveu um payload"


def test_a_varredura_cobre_toda_entrada_publica():
    """A lista não pode ficar para trás do código.

    Enumera as funções públicas dos dois módulos que recebem ``agrupamento_id`` e exige
    que cada uma esteja em ENTRADAS. Uma entrada nova sem guarda é exatamente por onde
    as três primeiras instâncias entraram.
    """
    import inspect

    cobertas = {nome for nome, _ in ENTRADAS}
    faltando = []
    for mod in _MODULOS:
        for nome, fn in vars(mod).items():
            if nome.startswith("_") or not inspect.isfunction(fn):
                continue
            if fn.__module__ != mod.__name__:
                continue  # re-exportada de outro módulo; testada lá
            params = inspect.signature(fn).parameters
            if "agrupamento_id" in params and nome not in cobertas:
                faltando.append(f"{mod.__name__.rsplit('.', 1)[-1]}.{nome}")
    assert not faltando, (
        "entradas que recebem agrupamento_id e não estão na varredura — cada uma pode "
        f"ler o banco inteiro quando o agrupamento não tem códigos: {sorted(faltando)}"
    )
