"""A faixa de convenções só pode prometer o que o número cumpre — a varredura.

Até a v1.77.0 três telas de comércio exterior (Parceiros, Sankey, Sazonalidade) somavam US$
nominal sob uma faixa que dizia "Correção IPCA": a coluna estava escrita no SQL, e nem a
rota nem o seam liam a moeda. Nenhum teste reprovava, porque cada peça fazia o que dizia —
o defeito estava na LIGAÇÃO entre elas. Achado conferindo a planilha de uma pesquisadora
contra o painel (Acre × castanha-do-pará: "US$ 78 mi sob IPCA" era a soma nominal, ao dólar).

Esta varredura deriva do CÓDIGO as três ligações e reprova a que faltar:

1. **SQL** — nenhuma soma monetária com a coluna escrita no texto: ela vem de
   ``{value_column}``. A exceção estrutural é reconhecida pelo ALIAS, não listada: o par de
   cobertura (``total_usd`` / ``unvalued_usd``), que mede no US$ declarado o que a convenção
   não alcança — é o metro, não o valor exibido. Fora isso, só os leitores nominais POR
   DESENHO, cada um com o motivo escrito ao lado.
2. **seam → gateway** — toda chamada a um leitor que aceita ``value_column`` passa uma
   coluna EXPLÍCITA, e uma coluna monetária literal só com motivo escrito. O padrão do
   leitor (``val_yearfx_usd``) é justamente o nominal silencioso. Uma coluna de QUANTIDADE
   literal (``qty_base``) é legítima: não há moeda nela para a faixa contradizer.
3. **rota → seam** — toda rota que chama um seam que resolve a convenção
   (``effective_value_column``) lê ``currency``/``correction`` e as repassa.

Cada regra tem a sua guarda do instrumento: uma varredura que não sabe reprovar, ou que não
acha nada, fica verde sobre coisa nenhuma.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

_RAIZ = Path(__file__).resolve().parents[1]
_WEBAPI = _RAIZ / "src" / "embrapa_dashboard" / "webapi"
_SQL_PY = _RAIZ / "src" / "embrapa_dashboard" / "serving" / "sql.py"
_GATEWAY_PY = _RAIZ / "src" / "embrapa_dashboard" / "serving" / "gateway.py"
_ROUTES_PY = _WEBAPI / "routes.py"
_SEAMS = sorted(_WEBAPI.glob("seam*.py"))

_MONETARIA = re.compile(r"\bval_(?:yearfx|real_(?:ipca|igpm|igpdi))_(?:brl|usd|eur)\b")
_COBERTURA = frozenset({"total_usd", "unvalued_usd"})

# Leitores cujo SQL soma uma coluna monetária FIXA de propósito. Cada um diz por quê.
_SQL_NOMINAL_POR_DESENHO = {
    "flow_market_values": (
        "Engenharia de atributos · tipo de mercado (congelada): o editor mostra o peso de "
        "cada célula regime × fluxo no US$ declarado, e a tela o rotula assim."
    ),
    "market_nature_series": (
        "Idem — a série da finalidade econômica, congelada e rotulada em US$ declarado."
    ),
}

# Chamadas do seam com coluna MONETÁRIA literal. (arquivo, função que chama, leitor) → motivo.
_LITERAL_POR_DESENHO = {
    ("seam_cross.py", "_gate_value_qty_by_year", "fetch_product_timeseries"): (
        "Preço na porteira contra o FOB do MESMO ano: a comparação é dentro do ano, onde a "
        "inflação se cancela, e o outro lado (aduana) só existe em US$ declarado."
    ),
    ("seam_cross.py", "_pevs_cross_points", "fetch_production_overview"): (
        "Cruzamento entre fontes: a métrica `prod_value` declara a sua convenção na tela — "
        "'Valor real (IPCA) da extração vegetal' (bancos.js) — e o Multi-fonte não tem "
        "faixa de convenções para contradizê-la."
    ),
    ("seam_cross.py", "_pevs_cross_points", "fetch_product_timeseries"): (
        "Ramo de QUANTIDADE (massa/volume): só `total_qty_native` é lido; o leitor exige "
        "uma coluna de valor e ela é ignorada."
    ),
    ("seam_cross.py", "_mass_by_year", "fetch_product_timeseries"): (
        "Só lê a massa (`total_qty_native`), o denominador do coeficiente de exportação."
    ),
}

# Chamadas SEM coluna, de propósito: o leitor devolve valor, mas quem chama não o lê.
_SEM_COLUNA_POR_DESENHO = {
    ("seam_cross.py", "_export_coef_by_uf", "fetch_comex_by_uf"): (
        "Só lê `total_weight_kg`: o coeficiente de exportação é peso ÷ massa, sem moeda."
    ),
}


# ── 1. SQL ─────────────────────────────────────────────────────────────────────


def _texto(no: ast.AST) -> str:
    """O texto de uma string do código, com os placeholders de f-string como ``{expr}``."""
    if isinstance(no, ast.Constant) and isinstance(no.value, str):
        return no.value
    if isinstance(no, ast.JoinedStr):
        return "".join(
            v.value if isinstance(v, ast.Constant) else "{" + ast.unparse(v.value) + "}"
            for v in no.values
        )
    return ""


def sql_por_funcao(fonte: str) -> dict[str, str]:
    """Função → o SQL que ela monta: toda string do corpo que tenha ``select``, menos a
    docstring. Comentários ``--`` fora — um comentário que CITA a coluna não é soma."""
    saida: dict[str, str] = {}
    for f in ast.walk(ast.parse(fonte)):
        if not isinstance(f, ast.FunctionDef):
            continue
        docstring = ast.get_docstring(f, clean=False)
        # Os pedaços literais de uma f-string também são nós Constant: contados à parte,
        # o mesmo SQL entraria duas vezes.
        dentro_de_fstring = {
            id(v) for no in ast.walk(f) if isinstance(no, ast.JoinedStr) for v in no.values
        }
        pedacos = [
            _texto(no)
            for corpo in f.body
            for no in ast.walk(corpo)
            if isinstance(no, ast.Constant | ast.JoinedStr) and id(no) not in dentro_de_fstring
        ]
        sql = "\n".join(
            p for p in pedacos if p and p != docstring and re.search(r"\bselect\b", p, re.I)
        )
        if sql:
            saida[f.name] = "\n".join(linha.split("--")[0] for linha in sql.splitlines())
    return saida


def _itens_do_select(sql: str) -> list[str]:
    """Os itens de TOPO de cada lista ``select … from``, contando parênteses."""
    itens: list[str] = []
    plano = " ".join(sql.split())
    for m in re.finditer(r"\bselect\b", plano, re.I):
        prof, atual = 0, []
        resto = plano[m.end() :]
        for i, ch in enumerate(resto):
            if ch == "(":
                prof += 1
            elif ch == ")":
                if prof == 0:
                    break  # fim de um subselect
                prof -= 1
            if prof == 0 and ch == " " and re.match(r"\s*from\b", resto[i:], re.I):
                break
            if ch == "," and prof == 0:
                itens.append("".join(atual).strip())
                atual = []
            else:
                atual.append(ch)
        itens.append("".join(atual).strip())
    return [i for i in itens if i]


def somas_fixas(fonte: str) -> list[tuple[str, str]]:
    """(função, item) de todo item de select que soma uma coluna monetária ESCRITA —
    fora o par de cobertura, reconhecido pelo alias."""
    achadas = []
    for funcao, sql in sql_por_funcao(fonte).items():
        for item in _itens_do_select(sql):
            sem_placeholder = re.sub(r"\{[^}]*\}", "", item)
            if not _MONETARIA.search(sem_placeholder):
                continue
            alias = item.rsplit(" as ", 1)[-1].strip().lower() if " as " in item else ""
            if alias in _COBERTURA:
                continue
            achadas.append((funcao, item))
    return achadas


def test_nenhuma_soma_monetaria_tem_a_coluna_escrita():
    culpadas = [
        (f, i)
        for f, i in somas_fixas(_SQL_PY.read_text(encoding="utf-8"))
        if f not in _SQL_NOMINAL_POR_DESENHO
    ]
    assert not culpadas, (
        "soma monetária com a coluna ESCRITA no SQL — a tela vai mostrá-la sob qualquer "
        "moeda/correção da faixa. Receba `value_column` e some `{value_column}`: "
        + "; ".join(f"{f}: {i!r}" for f, i in culpadas)
    )


def test_as_excecoes_de_sql_ainda_existem():
    """Uma exceção cujo leitor sumiu é uma licença esquecida esperando o próximo defeito."""
    funcoes = sql_por_funcao(_SQL_PY.read_text(encoding="utf-8"))
    for nome in _SQL_NOMINAL_POR_DESENHO:
        assert nome in funcoes, f"{nome} não existe mais — tire-o da lista de exceções"


def test_a_varredura_de_sql_REPROVA_o_sankey_de_antes():
    """O texto que vigorou até a v1.77.0 em ``trade_flows``."""
    antes = (
        "def trade_flows():\n"
        '    sql = f"""select x as o, sum(val_yearfx_usd) as value_usd from t"""\n'
    )
    assert somas_fixas(antes) == [("trade_flows", "sum(val_yearfx_usd) as value_usd")]


def test_a_varredura_de_sql_APROVA_a_convencao_e_o_par_de_cobertura():
    certo = (
        'def leitor():\n    sql = f"""select sum({value_column}) as total_value,\n'
        "        sum(val_yearfx_usd) as total_usd,\n"
        '        sum(if({value_column} is null, val_yearfx_usd, null)) as unvalued_usd from t"""\n'
    )
    assert somas_fixas(certo) == []


def test_a_varredura_de_sql_acha_as_somas_da_convencao():
    """Guarda do instrumento: o analisador tem de enxergar o SQL real."""
    funcoes = sql_por_funcao(_SQL_PY.read_text(encoding="utf-8"))
    for nome in ("trade_by_partner", "trade_flows", "comex_seasonality"):
        assert nome in funcoes, f"o analisador não achou o SQL de {nome}"
        itens = _itens_do_select(funcoes[nome])
        assert any("{value_column}" in i and i.endswith("total_value") for i in itens), (
            f"{nome}: não achei a soma da convenção entre {itens}"
        )
        assert any(i.endswith("unvalued_usd") for i in itens), f"{nome} perdeu a cobertura"


# ── 2. seam → gateway ──────────────────────────────────────────────────────────


def _leitores_com_coluna() -> set[str]:
    arvore = ast.parse(_GATEWAY_PY.read_text(encoding="utf-8"))
    return {
        f.name
        for f in arvore.body
        if isinstance(f, ast.FunctionDef)
        and any(a.arg == "value_column" for a in f.args.args + f.args.kwonlyargs)
    }


def chamadas_sem_coluna(fonte: str, arquivo: str, leitores: set[str]) -> list[str]:
    """Chamadas ``gateway.<leitor>(…)`` que não passam ``value_column``, ou passam uma
    coluna MONETÁRIA literal — fora das exceções escritas."""
    achadas = []
    for f in ast.walk(ast.parse(fonte)):
        if not isinstance(f, ast.FunctionDef):
            continue
        for no in ast.walk(f):
            if not (
                isinstance(no, ast.Call)
                and isinstance(no.func, ast.Attribute)
                and isinstance(no.func.value, ast.Name)
                and no.func.value.id == "gateway"
                and no.func.attr in leitores
            ):
                continue
            chave = (arquivo, f.name, no.func.attr)
            coluna = {k.arg: k.value for k in no.keywords}.get("value_column")
            if coluna is None:
                if chave not in _SEM_COLUNA_POR_DESENHO:
                    achadas.append(f"{arquivo}:{f.name} → gateway.{no.func.attr} sem value_column")
            elif (
                isinstance(coluna, ast.Constant)
                and _MONETARIA.fullmatch(str(coluna.value))  # `qty_base` é quantidade
                and chave not in _LITERAL_POR_DESENHO
            ):
                achadas.append(
                    f"{arquivo}:{f.name} → gateway.{no.func.attr}"
                    f"(value_column={coluna.value!r}) literal"
                )
    return achadas


def test_todo_leitor_monetario_recebe_a_coluna_explicita():
    leitores = _leitores_com_coluna()
    culpadas = [
        c
        for arquivo in _SEAMS
        for c in chamadas_sem_coluna(arquivo.read_text(encoding="utf-8"), arquivo.name, leitores)
    ]
    assert not culpadas, (
        "o padrão do leitor é o US$ nominal silencioso — passe a coluna que "
        "effective_value_column resolveu: " + "; ".join(culpadas)
    )


def test_a_varredura_do_seam_REPROVA_o_leitor_sem_coluna():
    """A forma de antes da v1.77.0 em ``flow_data``: o leitor chamado sem a coluna."""
    antes = "def flow_data(b, s):\n    return gateway.fetch_comex_flows(flow='export')\n"
    assert chamadas_sem_coluna(antes, "seam.py", {"fetch_comex_flows"})


def test_a_varredura_do_seam_APROVA_quantidade_literal_e_REPROVA_moeda_literal():
    qtd = "def f():\n    return gateway.leitor(value_column='qty_base')\n"
    moeda = "def f():\n    return gateway.leitor(value_column='val_real_ipca_brl')\n"
    assert chamadas_sem_coluna(qtd, "x.py", {"leitor"}) == []
    assert chamadas_sem_coluna(moeda, "x.py", {"leitor"})


def test_a_varredura_do_seam_acha_os_leitores():
    """Guarda do instrumento: os leitores das telas corrigidas têm de estar na conta."""
    leitores = _leitores_com_coluna()
    for nome in ("fetch_comex_partners", "fetch_comex_flows", "fetch_comex_seasonality"):
        assert nome in leitores, f"{nome} deixou de aceitar value_column"


@pytest.mark.parametrize(
    "chave", [*_LITERAL_POR_DESENHO, *_SEM_COLUNA_POR_DESENHO], ids=lambda c: f"{c[1]}→{c[2]}"
)
def test_as_excecoes_do_seam_ainda_existem(chave):
    """Uma exceção cujo chamador sumiu é uma licença esquecida esperando o próximo defeito."""
    arquivo, funcao, leitor = chave
    fonte = (_WEBAPI / arquivo).read_text(encoding="utf-8")
    corpos = {
        f.name: ast.unparse(f) for f in ast.walk(ast.parse(fonte)) if isinstance(f, ast.FunctionDef)
    }
    assert funcao in corpos and f"gateway.{leitor}(" in corpos[funcao], (
        f"{arquivo}:{funcao} → {leitor} não existe mais — tire-o das exceções"
    )


# ── 3. rota → seam ─────────────────────────────────────────────────────────────


def _seams_que_resolvem_a_convencao() -> set[str]:
    nomes = set()
    for arquivo in _SEAMS:
        for f in ast.parse(arquivo.read_text(encoding="utf-8")).body:
            if isinstance(f, ast.FunctionDef) and any(
                isinstance(no, ast.Call)
                and isinstance(no.func, ast.Name)
                and no.func.id == "effective_value_column"
                for no in ast.walk(f)
            ):
                nomes.add(f.name)
    return nomes


def rotas_sem_convencao(fonte: str, resolvem: set[str]) -> tuple[list[str], set[str]]:
    """(rotas culpadas, seams alcançados). Culpada é a rota que chama ``seam.<x>`` com x
    em ``resolvem`` e não lê a convenção, ou lê e não a repassa."""
    culpadas, alcancados = [], set()
    for f in ast.parse(fonte).body:
        if not isinstance(f, ast.FunctionDef):
            continue
        le = any(
            isinstance(no, ast.Call)
            and isinstance(no.func, ast.Name)
            and no.func.id == "_conversion_or_400"
            for no in ast.walk(f)
        )
        for no in ast.walk(f):
            if not (
                isinstance(no, ast.Call)
                and isinstance(no.func, ast.Attribute)
                and isinstance(no.func.value, ast.Name)
                and no.func.value.id == "seam"
                and no.func.attr in resolvem
            ):
                continue
            alcancados.add(no.func.attr)
            repassa = any(k.arg == "conv" for k in no.keywords) or any(
                isinstance(a, ast.Name) and a.id == "conv" for a in no.args
            )
            if not (le and repassa):
                culpadas.append(f"{f.name} → seam.{no.func.attr}")
    return culpadas, alcancados


def test_toda_rota_que_serve_dinheiro_le_a_convencao():
    culpadas, _ = rotas_sem_convencao(
        _ROUTES_PY.read_text(encoding="utf-8"), _seams_que_resolvem_a_convencao()
    )
    assert not culpadas, (
        "rota que chama um seam monetário sem ler/repassar currency+correction — a faixa "
        "diria uma convenção e o número seria outro: " + "; ".join(culpadas)
    )


def test_a_varredura_de_rotas_REPROVA_a_rota_de_antes():
    """``/api/partners`` até a v1.77.0: chamava o seam sem ler a moeda."""
    antes = (
        "def partners():\n"
        "    summary = _filter_summary()\n"
        "    return jsonify(serializers.serialize_partner(seam.partner_data(b, summary)))\n"
    )
    culpadas, _ = rotas_sem_convencao(antes, {"partner_data"})
    assert culpadas == ["partners → seam.partner_data"]


def test_a_varredura_de_rotas_acha_as_telas():
    """Guarda do instrumento — âncora feita à mão: as rotas que servem valor de um banco."""
    _, alcancados = rotas_sem_convencao(
        _ROUTES_PY.read_text(encoding="utf-8"), _seams_que_resolvem_a_convencao()
    )
    esperados = {"snapshot", "flow_data", "partner_data", "monthly_data", "products_by_uf"}
    assert esperados <= alcancados, f"a varredura perdeu rotas: {esperados - alcancados}"


@pytest.mark.parametrize("nome", ["flow_data", "partner_data", "monthly_data"])
def test_as_telas_da_v1_77_resolvem_a_convencao(nome):
    assert nome in _seams_que_resolvem_a_convencao()
