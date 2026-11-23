"""A lista de campos ANULÁVEIS do contrato, mantida em dois lugares — e conferida aqui.

A varredura `absenceGuard.test.js` procura aritmética crua sobre os campos que o
serializer pode emitir `None`. Ela precisa saber QUAIS são, e essa lista é uma cópia:
o Python decide, o JS varre. Uma cópia que ninguém confere apodrece em silêncio — e o
modo de apodrecer é o pior possível: um serializer novo emite um campo anulável, a
varredura não o conhece, e o próximo `null * fator` passa sem ser visto.

Este arquivo deriva a lista do Python — toda chave de dicionário cujo valor sai de uma
função que devolve ``None`` (``_measure``, ``_measure_scaled``, ``_yield``,
``ratio_present``, ``pct_present``, ``mean_present``) — e exige que o JS declare exatamente
as mesmas.

A derivação lê a ÁRVORE do código, não o texto (v1.108.10). Até então era uma regex sobre a
forma ``"chave": funcao(...)``, e a série por produto escrevia ``"q": q``, com ``q`` vindo de
``_measure_scaled`` duas linhas acima. O ``q`` era anulável desde a v1.108.8 e a varredura não
sabia: o CSV por produto escreveu 0 num ano sem quantidade (``(d.q || 0)``), na forma exata
que a varredura existe para reprovar. Agora uma chave também é anulável quando o seu valor é
um NOME atribuído, na mesma função, de uma dessas chamadas.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

_RAIZ = Path(__file__).resolve().parents[1]
_WEBAPI = _RAIZ / "src" / "embrapa_dashboard" / "webapi"
_JS = _RAIZ / "frontend" / "src" / "ui" / "absenceGuard.test.js"

# As funções que preservam a ausência devolvendo None. Uma chave cujo valor sai de qualquer
# uma delas pode chegar ao JS como `null`.
_FUNCOES = frozenset({"_measure", "_measure_scaled", "_yield"})
_METODOS = frozenset(
    {("measures", "ratio_present"), ("measures", "pct_present"), ("measures", "mean_present")}
)


def _anulavel(expr: ast.expr | None) -> bool:
    """O valor DA PRÓPRIA expressão pode ser None: uma chamada anulável, ou um dos ramos de
    ``a if c else b``.

    Só o topo conta. Uma lista montada com uma chamada anulável DENTRO (``[{"v": _measure(x)}
    for x in linhas]``) não é anulável: anulável é o ``"v"`` de cada item, que a derivação já
    pega no dicionário interno. Olhar a expressão inteira fazia ``series``, ``levels`` e
    ``products`` entrarem na lista.
    """
    if isinstance(expr, ast.IfExp):
        return _anulavel(expr.body) or _anulavel(expr.orelse)
    if not isinstance(expr, ast.Call):
        return False
    f = expr.func
    if isinstance(f, ast.Name):
        return f.id in _FUNCOES
    return (
        isinstance(f, ast.Attribute)
        and isinstance(f.value, ast.Name)
        and (f.value.id, f.attr) in _METODOS
    )


def _chaves(dicionario: ast.Dict, anulavel) -> set[str]:
    return {
        k.value
        for k, v in zip(dicionario.keys, dicionario.values, strict=True)
        if isinstance(k, ast.Constant) and isinstance(k.value, str) and anulavel(v)
    }


def _campos_de(texto: str) -> set[str]:
    """As chaves de contrato que um módulo pode emitir nulas.

    Duas formas: ``"chave": funcao(...)`` em qualquer dicionário, e ``"chave": nome`` quando
    ``nome`` recebe, na mesma função, o valor de uma chamada anulável. Uma variável local
    sozinha nunca entra (foi assim que ``m``, o temporário de ``_measure_scaled``, entrou na
    lista quando a regex aceitava ``nome = funcao(...)``): só a que chega a uma chave.
    """
    arvore = ast.parse(texto)
    campos: set[str] = set()
    for no in ast.walk(arvore):
        if isinstance(no, ast.Dict):
            campos |= _chaves(no, _anulavel)
    for funcao in ast.walk(arvore):
        if not isinstance(funcao, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        locais = {
            alvo.id
            for no in ast.walk(funcao)
            if isinstance(no, (ast.Assign, ast.AnnAssign)) and _anulavel(no.value)
            for alvo in (no.targets if isinstance(no, ast.Assign) else [no.target])
            if isinstance(alvo, ast.Name)
        }
        if not locais:
            continue
        for no in ast.walk(funcao):
            if isinstance(no, ast.Dict):
                campos |= _chaves(
                    no, lambda v, nomes=locais: isinstance(v, ast.Name) and v.id in nomes
                )
    return campos


def _campos_do_python() -> set[str]:
    campos: set[str] = set()
    for arquivo in _WEBAPI.glob("*.py"):
        campos |= _campos_de(arquivo.read_text(encoding="utf-8"))
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
    """Guarda do próprio derivador: se a análise quebrar, os dois testes acima passam
    comparando dois conjuntos vazios — verdes sobre nada."""
    py = _campos_do_python()
    assert len(py) >= 6, f"a derivação do Python achou pouca coisa: {sorted(py)}"
    # Âncoras concretas: os campos que produziram defeito medido.
    for esperado in ("v", "value", "yieldKgHa", "coefPct"):
        assert esperado in py, f"{esperado!r} deveria ser derivado do Python"
    # A série por produto: `q` chega ao dicionário por uma variável local, e era isso que a
    # regex não via (v1.108.8); as duas metades do preço chegam do mesmo jeito (v1.108.10).
    for esperado in ("q", "vPriced", "qPriced"):
        assert esperado in py, f"{esperado!r} chega por variável local e tem de ser derivado"


def test_a_derivacao_segue_a_variavel_local_ate_a_chamada():
    """A forma que escapou: a chamada numa linha, a chave na outra."""
    amostra = (
        "def serie(r, trilha):\n"
        "    if trilha:\n"
        "        q = _measure_scaled(r.q_mass, 1e3)\n"
        "    else:\n"
        "        q = None\n"
        "    total = len(r)\n"
        '    return {"q": q, "n": total}\n'
    )
    assert _campos_de(amostra) == {"q"}


def test_a_derivacao_nao_toma_o_recipiente_pelo_conteudo():
    """Uma lista montada com chamadas anuláveis dentro não é anulável; o campo de cada item é.

    Sem esta distinção, ``series``, ``levels`` e ``products`` entravam na lista, e a varredura
    do frontend passaria a reprovar aritmética sobre recipientes que nunca chegam nulos.
    """
    amostra = (
        "def pontos(linhas):\n"
        '    serie = [{"v": _measure(x)} for x in linhas]\n'
        '    return {"series": serie, "talvez": measures.ratio_present(1, 2) if linhas else 0}\n'
    )
    assert _campos_de(amostra) == {"v", "talvez"}
