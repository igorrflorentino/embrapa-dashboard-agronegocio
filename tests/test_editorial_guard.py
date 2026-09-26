"""A varredura editorial do lado Python: o texto em português que o backend manda à tela.

Contraparte de `frontend/src/ui/editorialGuard.test.js`, com o MESMO vocabulário
(`frontend/src/ui/editorialVocabulary.json`) e as regras do CLAUDE.md (§ Code Style →
Language, "Editorial control"). O SPA exibe erros, notas e rótulos que nascem aqui: o 404
da API chegava à tela como "endpoint de API não encontrado", e o status "Pipeline
construído" do registro de maturidade repetia o do SPA palavra por palavra.

O que conta como texto de tela: constante de string (inclusive pedaço de f-string) com
marca de português — acento ou palavra funcional — e ao menos um espaço, fora de
docstring e de SQL. Mensagens de log e de operador são em inglês por regra do projeto e
ficam de fora pelo mesmo filtro de idioma.

O itálico NÃO é cobrado aqui: ele só existe onde o SPA renderiza a marca `*termo*`
(`window.comItalico`), e nenhum texto do backend passa por lá. Um termo de
`italic.terms` num texto longo do backend precisa, antes, de um ponto de renderização.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
VOCAB = json.loads(
    (REPO / "frontend" / "src" / "ui" / "editorialVocabulary.json").read_text(encoding="utf-8")
)
PACOTES = [
    REPO / "src" / "embrapa_dashboard" / "webapi",
    REPO / "src" / "embrapa_dashboard" / "serving",
]

# ── O que é aceito, e POR QUÊ ──────────────────────────────────────────────────
# (arquivo relativo ao repo, trecho literal, razão). "Sempre foi assim" não é razão.
PERMITIDOS: list[tuple[str, str, str]] = []


def _palavra(padrao: str) -> re.Pattern[str]:
    # `\w` do re é Unicode: "top" não casa em "Topázio", "gold" não casa em "gold_pevs".
    return re.compile(rf"(?<!\w)(?:{padrao})(?!\w)", re.IGNORECASE)


PROIBIDOS = [(_palavra(f["pattern"]), f["term"], f["use"]) for f in VOCAB["forbidden"]] + [
    (_palavra(v["pattern"]), "verbo inventado", v["use"]) for v in VOCAB["inventedVerbs"]
]
CAMADAS = _palavra(VOCAB["layerNames"]["pattern"])

# "no" and "as" are English words too: an operator message such as "no Gold snapshot — run a
# backup first." read as Portuguese when they counted as a marker.
_PT = re.compile(
    r"[à-úÀ-Ú]|\b(de|do|da|dos|das|não|com|para|por|em|na|um|uma|os|ao|é|sem|ou)\b", re.I
)
_EN = re.compile(
    r"\b(the|and|of|to|is|when|with|from|this|that|for|not|are|be|it|by|an|on|at|as)\b", re.I
)
_PT_FUNCAO = re.compile(
    r"\b(de|do|da|dos|das|não|com|para|por|em|no|na|um|uma|os|as|ao|é|sem|ou|que|se|mais)\b", re.I
)
_SQL = re.compile(r"^\s*(select|with|insert|update|delete|merge|create)\b|\bfrom\s+`", re.I)


def _eh_texto_de_tela(t: str) -> bool:
    if len(t) <= 3 or " " not in t or _SQL.search(t) or not _PT.search(t):
        return False
    return len(_EN.findall(t)) <= len(_PT_FUNCAO.findall(t))


def extrair_texto(codigo: str, arquivo: str) -> list[tuple[str, int, str]]:
    arvore = ast.parse(codigo)
    docstrings = set()
    for no in ast.walk(arvore):
        if isinstance(no, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            corpo = no.body
            if (
                corpo
                and isinstance(corpo[0], ast.Expr)
                and isinstance(corpo[0].value, ast.Constant)
            ):
                docstrings.add(id(corpo[0].value))
    saida = []
    for no in ast.walk(arvore):
        if isinstance(no, ast.Constant) and isinstance(no.value, str) and id(no) not in docstrings:
            texto = re.sub(r"\s+", " ", no.value).strip()
            if _eh_texto_de_tela(texto):
                saida.append((arquivo, no.lineno, texto))
    return saida


def _texto_do_backend() -> list[tuple[str, int, str]]:
    linhas = []
    for pacote in PACOTES:
        for f in sorted(pacote.glob("*.py")):
            rel = f.relative_to(REPO).as_posix()
            linhas += extrair_texto(f.read_text(encoding="utf-8"), rel)
    return linhas


def violacoes_de_vocabulario(linha: tuple[str, int, str]) -> list[str]:
    arquivo, n, texto = linha
    return [
        f"{arquivo}:{n} — {termo} → use “{use}” [{m.group(0)}]: “{texto[:110]}”"
        for padrao, termo, use in PROIBIDOS
        for m in padrao.finditer(texto)
    ]


def violacao_de_camada(linha: tuple[str, int, str]) -> str | None:
    arquivo, n, texto = linha
    if not CAMADAS.search(texto):
        return None
    for a in VOCAB["layerNames"]["allowedIn"]:
        if a["file"] == arquivo and a["contains"] in texto:
            return None
    return f"{arquivo}:{n} — nome de camada fora de explicação de arquitetura: “{texto[:110]}”"


def _permitido(msg: str) -> bool:
    return any(msg.startswith(arq + ":") and trecho in msg for arq, trecho, _ in PERMITIDOS)


TEXTO = _texto_do_backend()


def test_a_extracao_enxerga_o_texto_de_tela() -> None:
    # Sem esta âncora, uma extração quebrada faria toda varredura passar vazia.
    assert len(TEXTO) > 100
    assert any(t == "rota da API não encontrada" for _, _, t in TEXTO)


def test_nenhum_estrangeirismo_com_equivalente_nativo() -> None:
    vs = [v for linha in TEXTO for v in violacoes_de_vocabulario(linha) if not _permitido(v)]
    assert vs == []


def test_nomes_de_camada_so_nas_explicacoes_de_arquitetura() -> None:
    vs = [v for v in map(violacao_de_camada, TEXTO) if v and not _permitido(v)]
    assert vs == []


def test_permitidos_tem_razao_e_nao_estao_obsoletos() -> None:
    todas = [v for linha in TEXTO for v in violacoes_de_vocabulario(linha)]
    todas += [v for v in map(violacao_de_camada, TEXTO) if v]
    for arquivo, trecho, razao in PERMITIDOS:
        assert len(razao) >= 60, f"razão curta demais para {trecho!r}"
        assert any(v.startswith(arquivo + ":") and trecho in v for v in todas), (
            f"PERMITIDO obsoleto (nada mais casa): {arquivo} — {trecho}"
        )


# ── Contraprova: as regras reprovam o texto que a v1.96.0 trocou ───────────────


@pytest.mark.parametrize(
    ("texto", "termo"),
    [
        ("endpoint de API não encontrado", "endpoint"),
        ("Pipeline construído, mas os dados ainda estão sendo baixados das fontes", "pipeline"),
        ("Veja o dashboard com os filtros aplicados", "dashboard"),
        ("da fonte oficial ao recorte que o painel consome", "recorte (tabela)"),
        ("Precisamos taguear os produtos antes de startar a carga", "verbo inventado"),
    ],
)
def test_reprova(texto: str, termo: str) -> None:
    assert any(f"— {termo} →" in v for v in violacoes_de_vocabulario(("x.py", 1, texto)))


@pytest.mark.parametrize(
    "texto",
    [
        "Topázio e topografia não são gíria",
        "a tabela gold_pevs_production tem uma linha por município",
        "Aguarde alguns segundos antes de enviar outro feedback.",
        "O cachê do artista não é memória temporária",
        "Aplique o recorte geográfico e compare as séries",
    ],
)
def test_aprova(texto: str) -> None:
    assert violacoes_de_vocabulario(("x.py", 1, texto)) == []


def test_camada_fora_de_explicacao_reprova() -> None:
    assert violacao_de_camada(("x.py", 1, "a consulta ao Gold falhou para este banco")) is not None


def test_a_extracao_ignora_docstring_log_em_ingles_e_sql() -> None:
    codigo = '''
def f():
    """Docstring com dashboard, que o pesquisador nunca lê."""
    log.info("pipeline finished for the dashboard")
    raise RuntimeError("no Gold snapshot — run a backup first.")
    q = "SELECT * FROM `p.gold.t` WHERE a = 'de'"
    return "Mensagem de tela sem problema"
'''
    assert [t for _, _, t in extrair_texto(codigo, "x.py")] == ["Mensagem de tela sem problema"]
