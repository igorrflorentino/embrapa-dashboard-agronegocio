"""As DUAS listas de perspectivas têm de contar a mesma história.

O registro de views existe em dois lugares: `frontend/src/ui/views.js` (o que está no ar
— o menu, e quem decide se há botão de exportar) e `webapi/registries.py` (que nenhuma
rota serve e nenhum código de produção lê). Uma cópia sem leitor não quebra nada quando
diverge; ela simplesmente **mente para a próxima pessoa que a ler**.

Era exatamente o caso. Quando este arquivo foi escrito (v1.55.0), o lado Python já havia
apodrecido em dois pontos, sem ninguém notar:

* **`territory_profile`** — perspectiva `live` no SPA, ausente aqui;
* **`productivity`** — declarada `exportable=True` aqui e `exportable: false` no SPA, que
  é quem decide (`canExportView` lê o registro do frontend).

A alternativa era apagar o registro Python. Preferimos **dar-lhe emprego**: com este teste
ele deixa de ser peso morto e passa a ser a segunda testemunha — o mesmo papel que `BANCOS`
e `FILTER_SCHEMAS` já cumprem (`test_banco_coverage_claims.py`, `test_pevs_scope_claims.py`).

**O que é pinado, e o que não é.** Pinamos o que engana se divergir: quais perspectivas
existem, em que grupo, se são `live`, o que exigem do banco e se exportam. NÃO pinamos a
prosa (`desc`) nem os campos exclusivos de cada lado (`planned` no JS; `sources`/`align`
no Python) — obrigar duas prosas idênticas transformaria o teste num empecilho, e um teste
que atrapalha é um teste que alguém desliga.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from embrapa_dashboard.webapi.registries import VIEW_BY_ID, VIEW_GROUPS

VIEWS_JS = Path(__file__).resolve().parents[1] / "frontend" / "src" / "ui" / "views.js"


def _corpo_do_registro() -> str:
    src = VIEWS_JS.read_text(encoding="utf-8")
    ini = src.index("window.VIEW_GROUPS")
    return src[ini : src.index("\n];", ini)]


def _blocos_de_view(src: str) -> dict[str, str]:
    """{view_id: bloco literal}, delimitado por CONTAGEM DE CHAVES.

    Regex frouxa não serve: uma view com `planned: [...]` multilinha faz um `.{0,N}?`
    parar cedo e reportar divergência onde não há. Contar chaves é o que torna a
    extração confiável — a primeira versão desta varredura acusou 10 falsos positivos
    antes de o parser ser consertado.
    """
    out: dict[str, str] = {}
    for m in re.finditer(r"\{\s*id:\s*'([^']+)',\s*label:", src):
        prof = 0
        for j in range(m.start(), len(src)):
            if src[j] == "{":
                prof += 1
            elif src[j] == "}":
                prof -= 1
                if prof == 0:
                    out[m.group(1)] = src[m.start() : j + 1]
                    break
    return out


def _campos_js(bloco: str) -> tuple[str | None, bool, tuple[str, ...]]:
    status = re.search(r"status:\s*'([^']+)'", bloco)
    exportable = re.search(r"exportable:\s*(true|false)", bloco)
    requires = re.search(r"requires:\s*\[([^\]]*)\]", bloco)
    return (
        status.group(1) if status else None,
        bool(exportable and exportable.group(1) == "true"),
        tuple(sorted(re.findall(r"'([^']+)'", requires.group(1)))) if requires else (),
    )


def _views_js() -> dict[str, tuple[str | None, bool, tuple[str, ...]]]:
    corpo = _corpo_do_registro()
    grupos = {g.id for g in VIEW_GROUPS}
    # Os blocos de GRUPO têm a mesma forma `{ id, label, … }`; distinguimos pelo id.
    return {
        vid: _campos_js(bloco) for vid, bloco in _blocos_de_view(corpo).items() if vid not in grupos
    }


def test_o_extrator_encontra_as_views() -> None:
    """Guarda do próprio varredor: um extrator quebrado passaria todos os testes abaixo."""
    js = _views_js()
    assert len(js) >= 20, f"só {len(js)} views extraídas de views.js — extrator quebrado?"
    assert "overview" in js and "geo" in js


def test_as_duas_listas_tem_as_mesmas_perspectivas() -> None:
    js, py = set(_views_js()), set(VIEW_BY_ID)
    assert js == py, (
        "as duas listas de perspectivas divergiram — a do Python não tem leitor em "
        "produção, então ela mente em silêncio para quem a ler.\n"
        f"  só no SPA:    {sorted(js - py)}\n"
        f"  só no Python: {sorted(py - js)}"
    )


def test_os_grupos_sao_os_mesmos_e_na_mesma_ordem() -> None:
    corpo = _corpo_do_registro()
    ids_js = [m.group(1) for m in re.finditer(r"\n  \{\n    id:\s*'([^']+)'", corpo)]
    assert ids_js == [g.id for g in VIEW_GROUPS], (
        "a estrutura do menu divergiu entre os dois registros"
    )


@pytest.mark.parametrize("view_id", sorted(VIEW_BY_ID))
def test_status_exportabilidade_e_requisitos_batem(view_id: str) -> None:
    """O SPA é quem vale: ele monta o menu e decide se há botão de exportar."""
    js = _views_js()[view_id]
    v = VIEW_BY_ID[view_id]
    assert (v.status, v.exportable, tuple(sorted(v.requires))) == js, (
        f"{view_id}: o registro do backend contradiz o SPA (que é quem está no ar).\n"
        f"  Python: status={v.status!r} exportable={v.exportable} "
        f"requires={tuple(sorted(v.requires))}\n"
        f"  SPA:    status={js[0]!r} exportable={js[1]} requires={js[2]}"
    )
