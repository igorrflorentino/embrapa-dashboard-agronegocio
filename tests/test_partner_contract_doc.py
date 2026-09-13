"""O contrato de parceiros é documentado à mão — e conferido aqui.

`docs/frontend_data_contract.md` §4.2 é o que um integrador lê para saber o que
`/api/partners` devolve. Descrevia `{ name, exp, imp, value }` enquanto o serializer já
emitia `weight`, `price` e `belowFloor` havia várias versões, e ninguém notou: uma
documentação defasada não quebra teste nenhum, não aparece na tela e não tem sintoma.
O `pricedShare` da v1.70.0 só alargou a distância.

A guarda é a mesma ideia de `test_partner_price_floor_parity.py` e
`test_absence_contract_fields.py`: derivar do CÓDIGO o que ele realmente devolve e exigir
que o texto acompanhe. Não confere a PROSA — nenhum teste pode — mas garante que nenhum
campo entre no contrato sem aparecer no documento que o descreve.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from embrapa_dashboard.webapi import serializers

_DOC = Path(__file__).resolve().parents[1] / "docs" / "frontend_data_contract.md"


def _secao_4_2() -> str:
    texto = _DOC.read_text(encoding="utf-8")
    inicio = texto.find("### 4.2 `partnerData`")
    assert inicio != -1, "a seção 4.2 do contrato de parceiros sumiu do documento"
    fim = texto.find("### 4.3", inicio)
    assert fim != -1, "não achei o fim da seção 4.2 — o documento foi reorganizado"
    return texto[inicio:fim]


def _campos_emitidos() -> tuple[set[str], set[str]]:
    """O que `serialize_partner` DEVOLVE — a âncora vem da função, não do documento."""
    df = pd.DataFrame(
        [
            {
                "partner_name": "X",
                "exp_value": 1.0,
                "imp_value": 1.0,
                "total_value": 2.0,
                "total_weight_kg": 1e9,  # acima do piso, para não cair em belowFloor
                "priced_value": 2.0,
                "price_per_kg": 1.0,
            }
        ]
    )
    saida = serializers.serialize_partner(df, rank_by="price")
    return set(saida), set(saida["partners"][0])


def test_o_documento_nomeia_todo_campo_do_payload():
    topo, _ = _campos_emitidos()
    secao = _secao_4_2()
    faltando = sorted(c for c in topo if c not in secao)
    assert not faltando, (
        "chaves de topo que /api/partners devolve e a §4.2 não menciona — documente-as "
        f"em docs/frontend_data_contract.md: {faltando}"
    )


def test_o_documento_nomeia_todo_campo_de_UMA_LINHA_do_ranking():
    _, linha = _campos_emitidos()
    secao = _secao_4_2()
    faltando = sorted(c for c in linha if c not in secao)
    assert not faltando, (
        "campos de um parceiro que a §4.2 não menciona — foi assim que `weight` e `price` "
        f"ficaram fora do documento por várias versões: {faltando}"
    )


def test_a_derivacao_encontra_algo():
    """Guarda do instrumento: com uma fixture que não produz linhas, os dois testes acima
    passariam comparando conjuntos vazios contra qualquer texto."""
    topo, linha = _campos_emitidos()
    assert len(linha) >= 6, f"a derivação achou poucos campos de linha: {sorted(linha)}"
    for esperado in ("price", "pricedShare", "weight"):
        assert esperado in linha, f"{esperado!r} deveria sair do serializer"
    assert "belowFloor" in topo, "o piso de materialidade sumiu do payload"
