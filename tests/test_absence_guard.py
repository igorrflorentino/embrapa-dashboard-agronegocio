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
# O MESMO denominador mascarado, uma linha antes: `total = ... or 1` e a divisão depois.
# Escapava da regex acima, que exige o `or 1` dentro da própria divisão — foi por aí que
# `_value_added_predominant` declarava um "nível predominante · 0,0% do valor" sobre um
# ano de valor zerado, transformando a fração numa multiplicação por 100. É o gêmeo da
# mesma cegueira já corrigida na varredura do frontend (absenceGuard.test.js).
#
# `or 1` é LEGÍTIMO quando o resultado não vira afirmação: uma barra de progresso, ou uma
# guarda morta cujo denominador nunca chega a zero porque a coleção só existe se tiver
# linhas. É ilegítimo quando o quociente vai para a tela como fração de alguma coisa.
_TOTAL_MASCARADO = re.compile(r"^\s*\w+ = [^\n]*\bor\s+1(?:\.0)?\b")
# `float(x or 0)` — a ausência vira zero ANTES de qualquer divisão. As três regexes acima
# olham o DENOMINADOR; esta olha o valor lido da linha, que é onde a fatia de mercado de um
# ano sem dado virava 0% (seam_base._xyear, v1.92.3). Aceita uma chamada aninhada
# (`float(getattr(r, "v", None) or 0)`). `int(... or 0)` fica de fora: é contagem.
_ZERO_COERCION = re.compile(r"\bfloat\(\s*(?:[^()\n]|\([^()\n]*\))*?\bor\s+0(?:\.0)?\s*\)")

# Cada permissão precisa do trecho literal E de uma razão. Uma razão só vale se o zero for
# MEDIDO (uma contagem de verdade) ou se não houver divisão por medida ausente.
PERMITIDOS: list[tuple[str, str]] = [
    # ── Os `= ... or 1` que NÃO viram afirmação ────────────────────────────────
    (
        "chunks_total = max(state.chunks_total or 1, state.chunks_done + state.chunks_failed)",
        "monitor/render.py: denominador de uma BARRA DE PROGRESSO na CLI do operador, não "
        "um número na tela do pesquisador. Sem chunk algum a barra fica vazia, que é o "
        "desenho certo; e o `max` já garante que o total nunca fica abaixo do concluído.",
    ),
    (
        'total = sum(slot["counts"].values()) or 1.0',
        "serializers._quality_by_product: divide CONTAGENS por total de contagens, e o "
        "slot só existe porque teve linhas — o total nunca chega a zero ali. A guarda é "
        "código morto; o `or 1.0` nunca decide nada.",
    ),
    (
        "total = sum(flags.values()) or 1.0",
        "serializers._quality_ts: idem — o ano só entra em by_year porque teve linha, "
        "então a soma das flags dele é positiva por construção. Contagem, não medida: "
        "zero linhas seria zero de verdade, e nem esse caso chega aqui.",
    ),
    (
        'return row["production"] if row else 0.0',
        "seam_cross._uf_mass: uma UF SEM linha produziu zero daquele produto — as DUAS "
        "pesquisas de produção do IBGE (PEVS extração + PAM lavoura) cobrem as 27 UFs, "
        "então a ausência de linha é um zero MEDIDO, não um dado que falta. A recusa "
        "continua onde deve: pct_present devolve None quando a soma dos dois lados não é "
        "positiva, e é o COEFICIENTE que não existe para quem exporta sem produzir.",
    ),
    # ── Os `float(x or 0)` que são TOTAIS, não pontos nem razões ────────────────
    (
        '"production": float(r.total_value or 0) / 1e3,',
        "seam_cross._production_by_uf: massa produzida por UF, somada no BigQuery. É o "
        "mesmo zero MEDIDO de _uf_mass logo abaixo: a pesquisa cobre as 27 UFs e o Gold "
        "descarta a célula em branco (o '...' do SIDRA) antes de somar, então uma soma NULL "
        "não chega aqui. O coeficiente continua recusado por pct_present quando a produção "
        "somada não é positiva.",
    ),
    (
        "exp_by_uf = {r.state_acronym: float(r.total_weight_kg or 0) / 1e6",
        "seam_cross._export_coef_by_uf: peso exportado por UF, um TOTAL que entra no "
        "numerador do coeficiente. O COMEX não tem linha com peso NULL (0 em toda a história, "
        "medido na auditoria de 2026-09-24), e uma UF sem exportação exportou zero de fato. "
        "A razão continua passando por pct_present.",
    ),
    (
        "agg[key] = agg.get(key, 0.0) + float(r.value_usd or 0)",
        "seam_attribute_engineering.flow_market_worklist: SOMA do valor por par regime × "
        "fluxo para ordenar a matriz de classificação. Somar só os presentes é a leitura "
        "certa de um total (regra do CLAUDE.md), e o par sem valor já é desenhado como '·' "
        "pelo próprio docstring da função. O eixo está congelado (0 valores em produção).",
    ),
    (
        "float(row.share or 0.0),",
        "doctor._check_quality_drift: `share` é CONTAGEM ÷ contagem do mesmo banco "
        "(safe_divide(count(*), sum(count(*)) over (partition by source)) no mart). A linha "
        "só existe com count ≥ 1, então o denominador é positivo e o share nunca vem NULL. "
        "O value_share, que é medida, já chega como None ao lado.",
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


@pytest.mark.parametrize(
    ("linha", "pega"),
    [
        ('"v": float(r.value or 0) / scale', True),  # a forma de seam_cross até a v1.92.3
        ("return {y: float(r.value or 0.0) for r in df.itertuples()}", True),
        ('x = float(getattr(r, "v", None) or 0)', True),  # uma chamada aninhada
        ("n = int(job.num_dml_affected_rows or 0)", False),  # contagem, não medida
        ("v = measures.present(r.value)", False),
        ("x = float(a) + (b or 0)", False),  # o `or 0` fora do float(...)
    ],
)
def test_a_regex_do_or_zero_pega_as_formas_conhecidas(linha: str, pega: bool) -> None:
    """Uma regex que não casa nada deixa a varredura passar vazia, sem ninguém notar."""
    assert bool(_ZERO_COERCION.search(linha)) is pega


def test_nenhum_call_site_responde_zero_a_uma_razao_indefinida() -> None:
    achados: list[str] = []
    for caminho in _fontes():
        for n, linha in enumerate(caminho.read_text(encoding="utf-8").split("\n"), 1):
            despida = linha.strip()
            if despida.startswith("#") or not despida:
                continue
            if not (
                _FALLBACK_ZERO.search(linha)
                or _DENOMINADOR_MASCARADO.search(linha)
                or _TOTAL_MASCARADO.search(linha)
                or _ZERO_COERCION.search(linha)
            ):
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
