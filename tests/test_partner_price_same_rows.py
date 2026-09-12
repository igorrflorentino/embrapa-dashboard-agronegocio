"""O preço por parceiro divide valor por peso — e as duas metades têm de cobrir as MESMAS linhas.

O COMTRADE publica linhas com valor e SEM peso líquido: o declarante registrou a
transação sem quantidade. Somar TODO o valor contra o peso de apenas parte dessas linhas
não produz um preço — produz o preço inflado pela fração que ficou fora do denominador.

Medido em produção 2026-09-07 (``serving.serving_comtrade_annual``): 79.528 linhas (3,87%)
sem peso, carregando 3,83% do valor. No agrupamento *madeira* o efeito não era um erro de
arredondamento e sim uma resposta trocada — **cinco dos dez primeiros** do ranking de preço
eram artefato da própria lacuna que mediam:

    Guam                  6º  US$ 1,251/kg   →  41º  US$ 0,567/kg   (+121%, 54,7% sem peso)
    Oceania, nep          2º  US$ 1,567/kg   →  13º  US$ 0,715/kg   (+119%, 54,4% sem peso)
    São Tomé e Príncipe   3º  US$ 1,461/kg   →  14º  US$ 0,682/kg   (+114%, 53,3% sem peso)

O ranking existe para responder "quem paga mais por quilo" e respondia "quem reporta peso
para a menor fatia do que comercia". O COMEX é imune por DADO, não por construção (zero
linhas sem peso), e é justamente por isso que a guarda tem de ser sobre o SQL: o dia em que
o MDIC publicar uma linha sem peso, a fórmula errada volta a mentir sozinha.
"""

from __future__ import annotations

from embrapa_dashboard.serving import sql as sqlmod

# ÂNCORA EXTERNA: o que a função DEVOLVE, não o que o módulo acha que devolve.
_SQL, _ = sqlmod.trade_by_partner(
    "projeto.serving.serving_comtrade_annual",
    partner_code_column="partner_iso_a3",
    partner_name_column="partner_name",
    code_column="cmd_code",
)


def _projecoes() -> dict[str, str]:
    """alias → a expressão que o produz, recortada da lista do ``select``.

    Uma regex do tipo ``(.+?) as <alias>`` parece resolver e não resolve: ela casa a
    partir do ``select`` e devolve a lista inteira, então TODA asserção sobre "o que há
    no numerador" passa, porque o numerador de todo mundo contém tudo. (Foi o que este
    arquivo fez na primeira versão — verde em três asserções sobre um texto errado.)
    Aqui a lista é varrida de verdade: comentários fora, vírgulas de topo separando os
    campos, parênteses contados.
    """
    corpo = _SQL.split("select", 1)[1].split("from `", 1)[0]
    limpo = " ".join(linha.split("--")[0] for linha in corpo.splitlines())
    campos, atual, prof = [], [], 0
    for ch in limpo:
        if ch == "(":
            prof += 1
        elif ch == ")":
            prof -= 1
        if ch == "," and prof == 0:
            campos.append("".join(atual))
            atual = []
        else:
            atual.append(ch)
    campos.append("".join(atual))
    saida: dict[str, str] = {}
    for campo in campos:
        expr, _, alias = " ".join(campo.split()).rpartition(" as ")
        if expr:
            saida[alias.strip()] = expr.strip()
    return saida


def _linha_do(alias: str) -> str:
    projecoes = _projecoes()
    assert alias in projecoes, (
        f"o SQL de trade_by_partner não produz {alias!r} — produz {sorted(projecoes)}"
    )
    return projecoes[alias]


def test_o_extrator_recorta_um_campo_de_cada_vez():
    """Guarda do próprio instrumento: sem isto os testes abaixo medem a lista inteira."""
    assert _linha_do("total_weight_kg") == "sum(net_weight_kg)"
    assert "exp_value" not in _linha_do("total_value")


def test_o_denominador_do_preco_e_o_peso_somado():
    assert "sum(net_weight_kg)" in _linha_do("price_per_kg")


def test_o_numerador_do_preco_ignora_a_linha_sem_peso():
    """O coração do defeito: `sum(val_yearfx_usd)` cru no numerador.

    A asserção não procura um texto decorado — exige que a expressão do numerador
    CONDICIONE o valor à presença do peso. Qualquer forma que faça isso passa; a forma
    que soma o valor inteiro, não.
    """
    numerador = _linha_do("price_per_kg")
    # Recorta o que está DENTRO do safe_divide, antes da vírgula que separa do peso.
    dentro = numerador.split("safe_divide(", 1)[1]
    primeiro = dentro.split(", sum(net_weight_kg)", 1)[0]
    assert "net_weight_kg is null" in primeiro, (
        f"o numerador do preço soma valor de linhas que não entram no denominador: {primeiro!r}"
    )


def test_a_cobertura_viaja_junto_para_a_tela():
    """Sem `priced_value` o número fica certo e MUDO.

    Um preço apoiado em 56% do comércio do parceiro é um preço legítimo de uma PARTE — e
    a regra do projeto proíbe exibir um valor calculado sobre um recorte sem dizer qual.
    """
    expr = _linha_do("priced_value")
    assert "net_weight_kg is null" in expr and "val_yearfx_usd" in expr


def test_o_valor_total_continua_inteiro():
    """A correção não pode encolher o ranking de Capital.

    `total_value` responde "quanto se comerciou" e a linha sem peso comerciou de verdade:
    ela sai do PREÇO por não ter denominador, não do valor.
    """
    assert _linha_do("total_value") == "sum(val_yearfx_usd)"
