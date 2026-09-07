"""O piso do preço médio por parceiro vive em DOIS lugares — e em unidades diferentes.

Quem APLICA o corte é o Python (``serializers._PARTNER_PRICE_FLOOR``, em kg): o SQL de
``trade_by_partner`` não tem ``LIMIT``, e o ``head(max_rows)`` do serializer É o corte
top-N, então um piso a jusante receberia uma página já feita só de artefatos.

Quem ENUNCIA a regra na tela é o JS (``window.PARTNER_PRICE_FLOOR``, em mil t), porque a
nota tem de dizer ao pesquisador qual limiar foi aplicado — e uma nota que anuncia um
número diferente do que o servidor usou é pior que nota nenhuma.

A conversão entre as duas unidades é onde a divergência entraria em silêncio: 1e5 kg são
0,1 mil t, e trocar um dos dois sem o outro deixaria a tela afirmando um piso que
ninguém aplicou. Este arquivo lê os dois textos-fonte e confere.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from embrapa_dashboard.webapi import serializers

_JS = Path(__file__).resolve().parents[1] / "frontend" / "src" / "ui" / "seriesUtils.js"
_KG_POR_MIL_T = 1e6  # 1 mil t = 1.000 t = 1.000.000 kg


def _js_floor() -> dict[str, float]:
    """A calibração declarada no seriesUtils.js, lida do texto-fonte.

    Sem regex frouxa: a linha é ancorada pelo nome, e o corpo do objeto é convertido
    para dict de verdade. Uma linha ausente ou reescrita falha aqui em vez de devolver
    silenciosamente um dicionário vazio que passaria em qualquer comparação.
    """
    texto = _JS.read_text(encoding="utf-8")
    m = re.search(r"window\.PARTNER_PRICE_FLOOR\s*=\s*\{([^}]*)\}", texto)
    assert m, "window.PARTNER_PRICE_FLOOR sumiu do seriesUtils.js"
    corpo = m.group(1)
    saida: dict[str, float] = {}
    for chave, valor in re.findall(r"(\w+)\s*:\s*([0-9.eE+-]+)", corpo):
        saida[chave] = float(ast.literal_eval(valor))
    assert set(saida) == {"minShare", "minAbs"}, f"chaves inesperadas: {sorted(saida)}"
    return saida


def test_o_piso_absoluto_e_o_mesmo_nas_duas_unidades():
    py_kg = serializers._PARTNER_PRICE_FLOOR["min_abs"]
    js_mil_t = _js_floor()["minAbs"]
    assert js_mil_t * _KG_POR_MIL_T == pytest.approx(py_kg), (
        f"a tela anuncia {js_mil_t} mil t ({js_mil_t * _KG_POR_MIL_T:,.0f} kg) mas o "
        f"servidor corta em {py_kg:,.0f} kg"
    )


def test_o_piso_relativo_e_o_mesmo_dos_dois_lados():
    # Uma fração não tem unidade, então aqui a igualdade é direta — e é justamente por
    # ser direta que ela some quando alguém ajusta só um lado.
    assert _js_floor()["minShare"] == pytest.approx(serializers._PARTNER_PRICE_FLOOR["min_share"])


def test_a_calibracao_e_a_medida_em_producao():
    """ÂNCORA EXTERNA, medida em 2026-09-07 sobre ``serving_comex_annual``.

    100 t é a fronteira que o dado indica, não um número redondo escolhido: abaixo dela
    os 16 parceiros excluídos somam de US$ 11 (Lesoto, 1 kg) a US$ 68 mil de comércio
    ACUMULADO em toda a série; logo acima está a Estônia, com 3.604 t a US$ 2,20/kg — um
    mercado pequeno de alto valor, que é exatamente a resposta que este ranking existe
    para achar. Este teste falha se alguém apertar o piso a ponto de cortar a Estônia
    junto com os artefatos, que é o erro que o piso relativo mais apertado cometia.
    """
    piso = serializers._PARTNER_PRICE_FLOOR
    assert piso["min_abs"] == 1e5, "o piso absoluto saiu dos 100 t medidos"
    estonia_kg = 3_604_334
    assert estonia_kg >= piso["min_abs"], "o piso passou a cortar a Estônia (3.604 t)"
    monaco_kg = 1_522
    assert monaco_kg < piso["min_abs"], "o piso deixou de cortar Mônaco (1.522 kg)"
