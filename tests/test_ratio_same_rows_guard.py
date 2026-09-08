"""A VARREDURA da quarta regra: as duas metades de uma razão têm de cobrir as MESMAS linhas.

O defeito exige DOIS agregados. Uma divisão por linha se recusa sozinha — em SQL o NULL
propaga, e ``a / b`` com ``b`` ausente é ausente. Já ``sum(a) / sum(b)`` não: cada soma
pula os próprios nulos em silêncio, e as duas metades acabam sobre populações diferentes.
O resultado é aritmeticamente correto e responde a outra pergunta.

Medido em produção 2026-09-07, antes da v1.70.0: o ranking de *Preço médio* por parceiro
dividia TODO o valor comerciado pelo peso de PARTE das linhas (o UN Comtrade publica
79.528 transações — 3,87% — com valor e sem peso). No agrupamento madeira, **cinco dos
dez primeiros** eram artefato: Guam aparecia em 6º com US$ 1,251/kg e pertence ao 41º com
US$ 0,567. O ranking pergunta "quem paga mais por quilo" e respondia "quem reporta peso
para a menor fatia do que comercia".

Duas formas são coerentes POR CONSTRUÇÃO e a varredura as reconhece em vez de as
listar como exceção — uma lista de permissões guarda o que alguém lembrou de justificar,
uma regra estrutural guarda o que ainda não foi escrito:

* **Fração de participação** — o denominador é a soma do próprio numerador sobre uma
  partição (``sum(x) / sum(sum(x)) over (…)``). As mesmas linhas dos dois lados, sempre.
* **Numerador condicionado** — o numerador anula o que o denominador não alcança
  (``sum(if(peso is null, null, valor)) / sum(peso)``). É a correção da v1.70.0.

O lado Python desta regra não é textual e mora em ``tests/test_gate_price_pairs_halves.py``:
lá duas somas LENIENTES independentes (``sumPresent`` soma os presentes de propósito, e
está certo num total) viravam as metades de uma razão.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_RAIZ = Path(__file__).resolve().parents[1]

# Onde o SQL do projeto mora: o construtor do BFF (texto literal em f-strings) e o dbt.
_FONTES = [
    _RAIZ / "src" / "embrapa_dashboard" / "serving" / "sql.py",
    *sorted((_RAIZ / "dbt" / "models").rglob("*.sql")),
    *sorted((_RAIZ / "dbt" / "macros").rglob("*.sql")),
]

_AGREGADO = re.compile(r"\b(?:sum|count|avg)\s*\(", re.I)
_IDENT = re.compile(r"\b([a-z_][a-z0-9_]{2,})\b", re.I)
# Palavras da linguagem, não colunas. Uma lista curta e fechada: qualquer coisa fora dela
# conta como coluna, então esquecer uma palavra gera RUÍDO (falso positivo), nunca um
# silêncio — o modo de errar seguro para uma varredura.
_PALAVRAS = frozenset(
    {
        # agregados e funções
        "sum",
        "count",
        "avg",
        "min",
        "max",
        "safe_divide",
        "nullif",
        "coalesce",
        "percentile_cont",
        "safe",
        "ln",
        "cast",
        "if",
        # estrutura da linguagem
        "case",
        "when",
        "then",
        "else",
        "end",
        "is",
        "null",
        "not",
        "over",
        "partition",
        "by",
        "distinct",
        "and",
        "or",
        "as",
        "true",
        "false",
        "select",
        "from",
        "where",
        "group",
        "having",
        "order",
        "desc",
        "asc",
        # jinja do dbt
        "var",
    }
)


def _argumentos(texto: str, abre: int) -> list[str]:
    """Os argumentos de TOPO da chamada cujo '(' está em `abre`.

    Contando parênteses, não separando por vírgula: `safe_divide(f(a, b), c)` tem dois
    argumentos, e um `split(',')` enxergaria três.
    """
    prof, atual, args = 0, [], []
    for ch in texto[abre:]:
        if ch == "(":
            prof += 1
            if prof == 1:
                continue
        elif ch == ")":
            prof -= 1
            if prof == 0:
                args.append("".join(atual))
                break
        if ch == "," and prof == 1:
            args.append("".join(atual))
            atual = []
            continue
        atual.append(ch)
    return [a.strip() for a in args]


def _colunas(expr: str) -> set[str]:
    return {c.lower() for c in _IDENT.findall(expr)} - _PALAVRAS


def razoes_de(texto: str) -> list[tuple[str, str]]:
    """Toda razão AGREGADO-sobre-AGREGADO do texto, como (numerador, denominador)."""
    plano = " ".join(texto.split())
    achadas = []
    for m in re.finditer(r"safe_divide\s*\(", plano):
        args = _argumentos(plano, m.end() - 1)
        if len(args) != 2:
            continue
        num, den = args
        if _AGREGADO.search(num) and _AGREGADO.search(den):
            achadas.append((num, den))
    return achadas


def coerente(num: str, den: str) -> bool:
    """A razão cobre as mesmas linhas?"""
    if _colunas(num) == _colunas(den):
        return True  # mesmas colunas dos dois lados
    if num in den:
        return True  # fração de participação: o denominador SOMA o numerador
    # Numerador condicionado à presença de cada coluna que só o denominador alcança.
    return all(f"{col} is null" in num for col in _colunas(den) - _colunas(num))


def _todas() -> list[tuple[Path, str, str]]:
    return [(f, num, den) for f in _FONTES for num, den in razoes_de(f.read_text(encoding="utf-8"))]


@pytest.mark.parametrize("caminho", _FONTES, ids=lambda p: p.name)
def test_toda_razao_de_agregados_cobre_as_mesmas_linhas(caminho):
    culpadas = [
        (num, den)
        for num, den in razoes_de(caminho.read_text(encoding="utf-8"))
        if not coerente(num, den)
    ]
    assert not culpadas, (
        f"razão cujas metades somam populações diferentes em {caminho.name} — o numerador "
        "tem de anular o que o denominador não alcança "
        "(sum(if(<den> is null, null, <num>))): " + "; ".join(f"{n!r} ÷ {d!r}" for n, d in culpadas)
    )


def test_a_varredura_acha_alguma_coisa():
    """Guarda do instrumento: se o analisador quebrar, o teste acima fica verde sobre nada.

    A âncora é uma lista feita à mão a partir do que EXISTE hoje, não uma contagem
    derivada do próprio analisador — as três razões de agregados do projeto, cada uma de
    uma forma diferente.
    """
    achadas = _todas()
    assert len(achadas) >= 3, f"o analisador achou pouca coisa: {achadas}"
    arquivos = {f.name for f, _, _ in achadas}
    assert "sql.py" in arquivos, "a razão do preço por parceiro sumiu da varredura"
    assert "serving_quality_by_source.sql" in arquivos, "as frações do donut sumiram"


def test_a_varredura_REPROVA_a_forma_defeituosa():
    """Uma varredura que não sabe reprovar não guarda nada.

    Este é o texto EXATO que vigorou em produção até a v1.70.0.
    """
    defeituoso = "safe_divide(sum(val_yearfx_usd), sum(net_weight_kg))"
    achadas = razoes_de(defeituoso)
    assert len(achadas) == 1, "o analisador não reconheceu a forma defeituosa"
    assert not coerente(*achadas[0]), "a varredura aprovaria o defeito da v1.70.0"


def test_a_varredura_APROVA_as_duas_formas_coerentes():
    """E uma que reprova tudo também não guarda nada — cala-se com uma lista de exceções."""
    corrigido = (
        "safe_divide(sum(if(net_weight_kg is null, null, val_yearfx_usd)), sum(net_weight_kg))"
    )
    assert coerente(*razoes_de(corrigido)[0])
    fracao = "safe_divide(sum(value), sum(sum(value)) over (partition by source))"
    assert coerente(*razoes_de(fracao)[0])


def test_a_divisao_POR_LINHA_fica_de_fora():
    """O escopo da regra: uma divisão por linha se recusa sozinha (o NULL propaga).

    Incluí-la encheria a varredura de ruído — as dezenas de `safe_divide(valor, indice)`
    da deflação — e ruído é como uma varredura deixa de ser levada a sério.
    """
    assert razoes_de("safe_divide(val_real_ipca_brl, brl_per_usd_current)") == []
    assert razoes_de("safe_divide(safe.ln(value), qty)") == []
