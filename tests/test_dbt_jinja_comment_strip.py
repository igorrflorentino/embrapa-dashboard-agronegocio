"""A ``--`` SQL comment line must not be followed by a left-stripping Jinja tag.

``{%-`` / ``{{-`` strips the whitespace BEFORE the tag — including the newline that ends the
comment line above it. Whatever the tag renders then lands inside the comment, and so does,
through a chain of ``-%}`` closers, the text after it. v1.105.0's
``assert_price_base_single_valued`` compiled to ``-- ... either rule.select per_mart.mart, ...``:
the ``select`` commented out, a FROM-first query left over, and BigQuery read it as pipe syntax
("WHERE not supported after FROM query"). Only a dev build against real data saw it —
``dbt build --empty`` had skipped the test after an upstream failure, and CI runs no singular
test — so the prod build would have been the first to fail.

The rule is deliberately broader than the defect: a ``{%- set ... %}`` that closes without a
right strip is harmless today, but one ``-`` added to its closer comments out the next line. A
plain ``{%`` after a comment costs one blank line in the compiled SQL.
"""

from __future__ import annotations

import re
from pathlib import Path

DBT = Path(__file__).resolve().parents[1] / "dbt"
_ESQUERDA = re.compile(r"\s*(\{%-|\{\{-)")


def violacoes(texto: str, nome: str = "x.sql") -> list[str]:
    linhas = texto.splitlines()
    return [
        f"{nome}:{i + 1}: {linhas[i].strip()[:60]}"
        for i in range(1, len(linhas))
        if _ESQUERDA.match(linhas[i]) and linhas[i - 1].lstrip().startswith("--")
    ]


def _fontes() -> list[Path]:
    return [
        f
        for f in sorted(DBT.rglob("*.sql"))
        if not {"target", "dbt_packages", "logs"} & set(f.relative_to(DBT).parts)
    ]


def test_no_comment_line_is_followed_by_a_left_stripping_tag():
    vs = [v for f in _fontes() for v in violacoes(f.read_text(encoding="utf-8"), f.name)]
    assert vs == [], "\n".join(vs)


def test_the_scanner_reads_the_project():
    # A glob that found nothing would make the test above pass vacuously.
    nomes = {f.name for f in _fontes()}
    assert {"assert_price_base_single_valued.sql", "gold_comtrade_flows.sql"} <= nomes
    assert len(nomes) > 60  # 82 on 2026-11-17


def test_counterproof_the_text_that_failed():
    antes = (
        "-- One output row per (mart, base column) that breaks either rule.\n"
        "{%- set marts = ['serving_pevs_annual'] -%}\n"
        "{%- set columns = ['ipca_base_month'] -%}\n"
        "\n"
        "select per_mart.mart\n"
    )
    assert violacoes(antes) == ["x.sql:2: {%- set marts = ['serving_pevs_annual'] -%}"]
    assert violacoes(antes.replace("{%- set marts", "{% set marts")) == []
    assert violacoes("-- comentário\n{{- ref('x') }}\n") != []
    assert violacoes("select 1\n{%- if true %}\n") == []
