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

Uma terceira forma divide FORA do SQL: o leitor devolve as duas metades e o Python as divide
(o preço por produto da v1.108.10; os preços da Análise cruzada da v1.108.13). Não há
``safe_divide`` para ler, e a regra vira outra: as metades ``priced_value<S>`` e
``priced_qty<S>`` vêm sob UMA condição que exige as duas medidas, e nenhuma metade de
quantidade existe sem a de valor. A segunda metade deste arquivo confere isso no SQL que os
construtores GERAM, não no molde da f-string: só no gerado a condição tem nome de coluna.

O lado Python desta regra não é textual e mora em ``tests/test_gate_price_pairs_halves.py``:
lá duas somas LENIENTES independentes (``sumPresent`` soma os presentes de propósito, e
está certo num total) viravam as metades de uma razão.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from embrapa_dashboard.serving import sql

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


# ── Os pares de metades: a razão que o Python divide (v1.108.10, v1.108.13) ────────────

_ALIAS_DO_PAR = re.compile(r"\s+as\s+(priced_(?:value|qty)\w*)", re.I)


def _fecha(texto: str, abre: int) -> int:
    """O índice logo depois do ')' que fecha o '(' em `abre`."""
    prof = 0
    for i in range(abre, len(texto)):
        if texto[i] == "(":
            prof += 1
        elif texto[i] == ")":
            prof -= 1
            if prof == 0:
                return i + 1
    raise ValueError("parêntese sem par")


def _condicao_e_expressao(soma: str) -> tuple[str, str] | None:
    """``sum(case when C then X end)`` → (C, X); None em qualquer outra forma.

    O ``then`` que separa é o primeiro FORA de parênteses: a condição embrulha a expressão de
    valor entre parênteses (``(case when … then … end) is not null``), e o ``then`` dela fica
    num nível mais fundo.
    """
    m = re.fullmatch(r"sum\(\s*case\s+when\s+(.*)\s+end\s*\)", soma, re.I | re.S)
    if not m:
        return None
    corpo, prof = m.group(1), 0
    for i, ch in enumerate(corpo):
        if ch == "(":
            prof += 1
        elif ch == ")":
            prof -= 1
        elif prof == 0 and re.match(r"\sthen\s", corpo[i : i + 6], re.I):
            return corpo[:i].strip(), corpo[i + 6 :].strip()
    return None


def pares_de(sql_gerado: str) -> dict[str, dict[str, str]]:
    """Sufixo → {'value': soma, 'qty': soma} de toda metade ``priced_value<S>``/``priced_qty<S>``
    do SQL, sem os comentários ``--``."""
    plano = " ".join(linha.split("--")[0] for linha in sql_gerado.splitlines())
    plano = " ".join(plano.split())
    pares: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"\bsum\s*\(", plano, re.I):
        fim = _fecha(plano, m.end() - 1)
        alias = _ALIAS_DO_PAR.match(plano, fim)
        if not alias:
            continue
        nome = alias.group(1).lower()
        if nome.startswith("priced_value"):
            lado, sufixo = "value", nome.removeprefix("priced_value")
        else:
            lado, sufixo = "qty", nome.removeprefix("priced_qty")
        pares.setdefault(sufixo, {})[lado] = plano[m.start() : fim]
    return pares


def par_coerente(soma_valor: str, soma_qtd: str) -> bool:
    """As duas metades somam as mesmas linhas: a MESMA condição, e ela exige as duas medidas."""
    valor, qtd = _condicao_e_expressao(soma_valor), _condicao_e_expressao(soma_qtd)
    if valor is None or qtd is None:
        return False  # uma soma sem condição percorre todas as linhas que a sua coluna tem
    (cond_v, expr_v), (cond_q, expr_q) = valor, qtd
    if cond_v != cond_q:
        return False

    def exige(expr: str) -> bool:
        return f"({expr}) is not null" in cond_v or f"{expr} is not null" in cond_v

    return exige(expr_v) and exige(expr_q)


def _construtores_do_par() -> set[str]:
    """As funções PÚBLICAS do sql.py que emitem o par, direta ou indiretamente — lidas da
    árvore do código, para que um construtor novo não escape da varredura."""
    arvore = ast.parse(Path(sql.__file__).read_text(encoding="utf-8"))
    chama = {
        f.name: {
            no.func.id
            for no in ast.walk(f)
            if isinstance(no, ast.Call) and isinstance(no.func, ast.Name)
        }
        for f in arvore.body
        if isinstance(f, ast.FunctionDef)
    }
    emitem = {"_priced_pair"}
    while True:
        novos = {nome for nome, alvos in chama.items() if alvos & emitem} - emitem
        if not novos:
            break
        emitem |= novos
    return {nome for nome in emitem if not nome.startswith("_")}


# O SQL de cada construtor do par, nas variações que mudam a expressão de valor.
_GERADO = {
    "product_timeseries": [
        sql.product_timeseries(
            "p.d.t", code_column="product_code", value_column=coluna, has_measure_kind=estoque
        )[0]
        for coluna in ("val_yearfx_usd", "val_real_ipca_brl")
        for estoque in (False, True)
    ],
    "cross_price_annual": [
        sql.cross_price_annual(
            "p.d.t",
            value_column="val_yearfx_usd",
            qty_column="net_weight_kg",
            flow="export",
            code_column="ncm_code",
            codes=("08012200",),
            uf_codes=("PA",),
            year_start=1997,
            year_end=2026,
        )[0]
    ],
}


@pytest.mark.parametrize("construtor", sorted(_GERADO))
def test_todo_par_de_metades_soma_as_mesmas_linhas(construtor):
    for sql_gerado in _GERADO[construtor]:
        pares = pares_de(sql_gerado)
        orfas = sorted(s for s, lados in pares.items() if "value" not in lados)
        assert not orfas, (
            f"{construtor}: metade de quantidade sem a de valor ({orfas}) — o preço dividiria "
            "um valor que soma outras linhas"
        )
        culpados = [
            s
            for s, lados in pares.items()
            if "qty" in lados and not par_coerente(lados["value"], lados["qty"])
        ]
        assert not culpados, (
            f"{construtor}: as metades do preço {culpados} não estão sob a mesma condição, "
            "ou ela não exige as duas medidas"
        )


def test_a_varredura_de_pares_cobre_todo_construtor():
    """Guarda do instrumento: a lista de construtores sai da árvore do sql.py, e cada um tem
    o seu SQL gerado aqui — com pelo menos um par inteiro dentro."""
    assert _construtores_do_par() == set(_GERADO), (
        "construtor que emite o par sem SQL gerado nesta varredura, ou o contrário"
    )
    for construtor, gerados in _GERADO.items():
        for sql_gerado in gerados:
            inteiros = [s for s, lados in pares_de(sql_gerado).items() if len(lados) == 2]
            assert inteiros, f"{construtor}: o analisador não achou par nenhum"
    # Âncora à mão: as três trilhas da série por produto e o par do preço de exportação.
    assert set(pares_de(_GERADO["product_timeseries"][0])) == {"_mass", "_vol", "_count"}
    assert set(pares_de(_GERADO["cross_price_annual"][0])) == {""}


def test_a_varredura_de_pares_REPROVA_as_formas_defeituosas():
    """As metades soltas (a forma que dividia ``exp_value`` por ``exp_weight`` até a
    v1.108.11, cada série somando as próprias linhas), a condição que só exige uma medida, a
    condição que difere entre as metades, e a metade de quantidade órfã."""
    soltas = "sum(val_yearfx_usd) as priced_value, sum(net_weight_kg) as priced_qty"
    lados = pares_de(soltas)[""]
    assert not par_coerente(lados["value"], lados["qty"])
    meia = (
        "sum(case when net_weight_kg is not null then val_yearfx_usd end) as priced_value, "
        "sum(case when net_weight_kg is not null then net_weight_kg end) as priced_qty"
    )
    lados = pares_de(meia)[""]
    assert not par_coerente(lados["value"], lados["qty"]), (
        "uma linha com peso e sem valor entraria só no denominador"
    )
    desiguais = (
        "sum(case when a is not null and b is not null then a end) as priced_value_x, "
        "sum(case when b is not null then b end) as priced_qty_x"
    )
    lados = pares_de(desiguais)["_x"]
    assert not par_coerente(lados["value"], lados["qty"])
    orfa = pares_de("sum(case when b is not null then b end) as priced_qty_y")
    assert "value" not in orfa["_y"]


def test_a_varredura_de_pares_APROVA_o_par_escrito_a_mao():
    """E aprova a forma certa escrita sem o construtor — a regra é a forma, não a origem."""
    certo = (
        "sum(case when peso is not null and (valor) is not null then valor end) as priced_value, "
        "sum(case when peso is not null and (valor) is not null then peso end) as priced_qty"
    )
    lados = pares_de(certo)[""]
    assert par_coerente(lados["value"], lados["qty"])
