"""A lista de campos ANULÁVEIS do contrato, mantida em dois lugares — e conferida aqui.

A varredura `absenceGuard.test.js` procura aritmética crua sobre os campos que o
serializer pode emitir `None`. Ela precisa saber QUAIS são, e essa lista é uma cópia:
o Python decide, o JS varre. Uma cópia que ninguém confere apodrece em silêncio — e o
modo de apodrecer é o pior possível: um serializer novo emite um campo anulável, a
varredura não o conhece, e o próximo `null * fator` passa sem ser visto.

Este arquivo deriva a lista do Python — toda chave atribuída de uma função que devolve
``None`` (``_measure``, ``_measure_scaled``, ``_yield``, ``ratio_present``,
``pct_present``, ``mean_present``) — e exige que o JS declare exatamente as mesmas.
"""

from __future__ import annotations

import re
from pathlib import Path

_RAIZ = Path(__file__).resolve().parents[1]
_WEBAPI = _RAIZ / "src" / "embrapa_dashboard" / "webapi"
_JS = _RAIZ / "frontend" / "src" / "ui" / "absenceGuard.test.js"

# As funções que preservam a ausência devolvendo None. Uma chave atribuída de qualquer
# uma delas pode chegar ao JS como `null`.
_ANULAVEIS = (
    r"(?:_measure(?:_scaled)?|_yield"
    r"|measures\.(?:ratio_present|pct_present|mean_present))\s*\("
)


def _campos_do_python() -> set[str]:
    campos: set[str] = set()
    for arquivo in _WEBAPI.glob("*.py"):
        texto = arquivo.read_text(encoding="utf-8")
        # SÓ a forma `"chave": funcao(...)` — o dicionário de contrato, que é o que
        # chega ao JS. A forma `nome = funcao(...)` pega VARIÁVEIS LOCAIS junto (foi
        # assim que `m`, o temporário de `_measure_scaled`, entrou na lista), e uma
        # variável local não é campo de contrato: sinalizá-la faria a varredura do
        # frontend procurar aritmética sobre um nome que não existe lá.
        campos |= set(re.findall(r'"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*' + _ANULAVEIS, texto))
    return campos


def _campos_do_js() -> set[str]:
    texto = _JS.read_text(encoding="utf-8")
    m = re.search(r"const CAMPOS_ANULAVEIS = \[([^\]]*)\]", texto, re.S)
    assert m, "CAMPOS_ANULAVEIS sumiu de absenceGuard.test.js"
    return set(re.findall(r"'([A-Za-z_][A-Za-z0-9_]*)'", m.group(1)))


def test_a_lista_do_js_cobre_todo_campo_anulavel_do_python():
    py, js = _campos_do_python(), _campos_do_js()
    faltando = py - js
    assert not faltando, (
        "campos que o serializer pode emitir NULOS e a varredura do frontend não conhece "
        f"— acrescente-os a CAMPOS_ANULAVEIS em absenceGuard.test.js: {sorted(faltando)}"
    )


def test_a_lista_do_js_nao_inventa_campos():
    """O contrário também importa: um campo a mais faz a varredura sinalizar aritmética
    legítima, e a lista de permissões cresce para calar ruído — que é como uma varredura
    deixa de ser levada a sério."""
    py, js = _campos_do_python(), _campos_do_js()
    sobrando = js - py
    assert not sobrando, (
        "campos em CAMPOS_ANULAVEIS que nenhum serializer emite por função anulável "
        f"— remova-os ou aponte de onde vêm: {sorted(sobrando)}"
    )


def test_a_derivacao_encontra_algo():
    """Guarda do próprio derivador: se as regex quebrarem, os dois testes acima passam
    comparando dois conjuntos vazios — verdes sobre nada."""
    py = _campos_do_python()
    assert len(py) >= 6, f"a derivação do Python achou pouca coisa: {sorted(py)}"
    # Âncoras concretas: os campos que produziram defeito medido nesta sessão.
    for esperado in ("v", "value", "yieldKgHa", "coefPct"):
        assert esperado in py, f"{esperado!r} deveria ser derivado do Python"
