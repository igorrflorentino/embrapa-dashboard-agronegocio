"""A varredura que impede a reincidência do defeito da v1.49.0 no lado PYTHON.

A guarda de JavaScript (`frontend/src/ui/absenceGuard.test.js`, v1.51.0) cobria só o
frontend — e a mesma forma vivia aqui, alimentando métricas que o pesquisador lê: o
coeficiente de exportação saía `0%` para uma UF sem produção, a divergência entre fontes
saía `0%` num ano sem dado em nenhuma das duas, preços e markup saíam `0` em vez de "sem
preço" (corrigido na v1.54.0, ver `webapi/measures.py`).

Este arquivo é a metade que faltava: falha quando um call site NOVO responde ZERO a uma
razão indefinida, e obriga quem o escreveu a ou usar `measures`, ou registrar aqui por que
aquele caso é benigno — com razão escrita.

Mesmo idioma de test_filter_axes_wiring.py: varrer o domínio, não somar casos.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1] / "src" / "embrapa_dashboard"

# `X if den else 0` — responder zero quando o denominador não existe.
_FALLBACK_ZERO = re.compile(r"\bif\s+[A-Za-z_][\w.\[\]\"']*\s+else\s+0(?:\.0)?\b")
# `/ (algo or 1)` — mascarar o denominador para que a divisão "não falhe".
_DENOMINADOR_MASCARADO = re.compile(r"/\s*\(?[^()\n]*\bor\s+1\b")

# Cada permissão precisa do trecho literal E de uma razão. Uma razão só vale se o zero for
# MEDIDO (uma contagem de verdade) ou se não houver divisão por medida ausente.
PERMITIDOS: list[tuple[str, str]] = [
    (
        'return row["production"] if row else 0.0',
        "seam_cross._uf_mass: uma UF SEM linha produziu zero daquele produto — as DUAS "
        "pesquisas de produção do IBGE (PEVS extração + PAM lavoura) cobrem as 27 UFs, "
        "então a ausência de linha é um zero MEDIDO, não um dado que falta. A recusa "
        "continua onde deve: pct_present devolve None quando a soma dos dois lados não é "
        "positiva, e é o COEFICIENTE que não existe para quem exporta sem produzir.",
    ),
    (
        "elapsed = (state.ended_at or now) - started if started else 0.0",
        "monitor/render.py: mede DURAÇÃO de uma etapa que ainda não começou. Zero segundos "
        "decorridos é o tempo real de algo que não iniciou, não uma razão indefinida.",
    ),
    (
        "out.append(sum(vals) / len(vals) if vals else 0.0)",
        "serializers._monthly_avg: a sazonalidade precisa dos 12 meses no eixo, e o "
        "docstring logo acima explica que o filtro é `is not None` justamente para NÃO "
        "descartar meses de zero medido. O fallback só dispara para um mês sem nenhuma "
        "observação em ano nenhum — caso em que o gráfico já não tem o que desenhar.",
    ),
]


# measures.py fica de FORA: é o único arquivo autorizado a escrever o padrão, porque é
# ele que documenta por que o padrão é errado. Mesma exceção que produto.js tem na sua
# própria guarda — o preço de manter a explicação junto do código que a substitui.
_EXCLUIDOS = {"measures.py"}


def _fontes() -> list[Path]:
    return sorted(
        p for p in RAIZ.rglob("*.py") if "__pycache__" not in p.parts and p.name not in _EXCLUIDOS
    )


def test_a_varredura_encontra_o_que_varrer() -> None:
    """Guarda do próprio varredor: se o glob quebrar, os testes abaixo passam vazios."""
    assert len(_fontes()) > 30


def test_nenhum_call_site_responde_zero_a_uma_razao_indefinida() -> None:
    achados: list[str] = []
    for caminho in _fontes():
        for n, linha in enumerate(caminho.read_text(encoding="utf-8").split("\n"), 1):
            despida = linha.strip()
            if despida.startswith("#") or not despida:
                continue
            if not (_FALLBACK_ZERO.search(linha) or _DENOMINADOR_MASCARADO.search(linha)):
                continue
            if any(trecho in linha for trecho, _ in PERMITIDOS):
                continue
            achados.append(f"{caminho.relative_to(RAIZ)}:{n}\n      {despida}")

    assert not achados, (
        "Um call site respondeu 0 a uma razão indefinida — o defeito da v1.49.0/v1.54.0.\n"
        "Use webapi.measures (ratio_present / pct_present / mean_present), que devolvem None\n"
        "e chegam à tela como '—'. Se o zero aqui for MEDIDO de verdade, registre o trecho\n"
        "em PERMITIDOS neste arquivo, com a razão.\n\n" + "\n".join(achados)
    )


@pytest.mark.parametrize(("trecho", "razao"), PERMITIDOS)
def test_cada_permissao_declara_uma_razao_de_verdade(trecho: str, razao: str) -> None:
    """A lista de exceções não pode virar despejo."""
    assert len(razao) > 60, f"sem razão: {trecho}"
    assert not re.search(r"não deu problema|por enquanto|TODO", razao, re.I), trecho


@pytest.mark.parametrize(("trecho", "razao"), PERMITIDOS)
def test_cada_permissao_ainda_corresponde_a_codigo(trecho: str, razao: str) -> None:
    """A lista não pode apodrecer: uma permissão órfã esconde a próxima reincidência."""
    todo = "\n".join(p.read_text(encoding="utf-8") for p in _fontes())
    assert trecho in todo, f"permissão obsoleta, remova de PERMITIDOS: {trecho}"
