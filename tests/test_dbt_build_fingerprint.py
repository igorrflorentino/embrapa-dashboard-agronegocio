"""The prod build is skipped only when nothing it can produce has changed.

`scripts/dbt_build_fingerprint.py` reduces a compiled dbt project to a fingerprint, and
`dbt-build-prod.yml` skips a push-triggered build when it equals the last successful
build's. The two failure modes are not symmetric:

* a change the fingerprint MISSES skips a build that was needed — prod keeps the old
  table, and nothing fails to say so;
* noise the fingerprint KEEPS forces a build that was not — it only costs bytes.

So every test below that says "identical" guards the savings, and every test that says
"different" guards correctness. The second group is the one that must never shrink.
"""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "dbt_build_fingerprint.py"
_spec = importlib.util.spec_from_file_location("dbt_build_fingerprint", _SCRIPT)
fp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fp)

INV = "11111111-2222-3333-4444-555555555555"


def _manifest() -> dict:
    return {
        "metadata": {
            "invocation_id": INV,
            "project_name": "proj",
            "generated_at": "2026-09-26T04:00:00Z",
        },
        "nodes": {
            "model.proj.gold_x": {
                "resource_type": "model",
                "name": "gold_x",
                "compiled_code": "select a, 'x -- y' as s\nfrom `p.silver.x` -- tail\nwhere b > 1",
                "raw_code": "select a from {{ ref('silver_x') }}",
                "checksum": {"name": "sha256", "checksum": "raw-file-hash"},
                "config": {"materialized": "table", "partition_by": {"field": "ano"}},
                "description": "Tabela analítica.",
                "columns": {"a": {"name": "a", "description": "coluna a", "data_type": None}},
                "relation_name": "`p`.`gold`.`gold_x`",
                "depends_on": {"nodes": ["model.proj.silver_x"], "macros": []},
                "created_at": 1.0,
                "original_file_path": "models/gold/gold_x.sql",
                "path": "gold/gold_x.sql",
            },
            "model.proj.serving_history": {
                "resource_type": "model",
                "name": "serving_history",
                "compiled_code": (
                    f"select '{INV}' as invocation_id, current_timestamp() as built_at"
                ),
                "config": {"materialized": "incremental", "full_refresh": False},
                "columns": {},
            },
            "test.proj.not_null_gold_x_a": {
                "resource_type": "test",
                "compiled_code": "select a from `p.gold.gold_x` where a is null",
                "config": {"severity": "ERROR"},
                "test_metadata": {"name": "not_null", "kwargs": {"column_name": "a"}},
            },
            "seed.proj.factors": {
                "resource_type": "seed",
                "checksum": {"name": "sha256", "checksum": "csv-hash"},
                "config": {"column_types": {"factor": "numeric"}},
            },
            "operation.proj.proj-on-run-end-0": {
                "resource_type": "operation",
                "compiled_code": "{{ apply_dev_ttl(days=7) }}",
            },
        },
        "unit_tests": {
            "unit_test.proj.gold_x.t1": {
                "model": "gold_x",
                "given": [{"rows": [{"a": 1}]}],
                "expect": {"rows": [{"a": 1}]},
            },
        },
        "macros": {
            "macro.proj.my_materialization": {
                "package_name": "proj",
                "macro_sql": "{% macro m() %}\n{#- explains why -#}\nselect 1\n{% endmacro %}",
            },
            "macro.dbt_utils.star": {
                "package_name": "dbt_utils",
                "macro_sql": "{% macro star() %}x{% endmacro %}",
            },
        },
    }


def _same(mutate) -> bool:
    base, other = _manifest(), _manifest()
    mutate(other)
    identical, _ = fp.compare(fp.compute(base), fp.compute(other))
    return identical


def _set(path: list, value):
    def mutate(m):
        target = m
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return mutate


GOLD = ["nodes", "model.proj.gold_x"]


# ── Must NOT force a build (the savings) ─────────────────────────────────────


@pytest.mark.parametrize(
    "mutate",
    [
        _set(
            [*GOLD, "compiled_code"],
            "select a, 'x -- y' as s\n\n  from `p.silver.x`  /* note */ where b > 1",
        ),
        _set(
            [*GOLD, "compiled_code"],
            "select a, 'x -- y' as s # bigquery hash comment\nfrom `p.silver.x` where b > 1",
        ),
        _set([*GOLD, "raw_code"], "select a from {{ ref('silver_x') }} {# a jinja comment #}"),
        _set([*GOLD, "checksum"], {"name": "sha256", "checksum": "edited-comment-only"}),
        _set([*GOLD, "created_at"], 2.0),
        _set([*GOLD, "original_file_path"], "models/gold/moved.sql"),
        _set(["metadata", "generated_at"], "2026-09-27T00:00:00Z"),
        _set(
            ["macros", "macro.proj.my_materialization", "macro_sql"],
            "{% macro m() %}\n{#- a different explanation,\n   over two lines -#}\n"
            "select 1\n{% endmacro %}",
        ),
    ],
    ids=[
        "sql-comment-and-spacing",
        "bigquery-hash-comment",
        "raw-code",
        "raw-file-checksum",
        "parse-timestamp",
        "file-path",
        "manifest-timestamp",
        "macro-jinja-comment",
    ],
)
def test_what_bigquery_never_sees_does_not_force_a_build(mutate):
    assert _same(mutate)


def test_a_new_invocation_id_is_not_a_change():
    """serving_quality_history stamps `invocation_id` into its compiled SQL — without the
    placeholder, every compile would differ and no build would ever be skipped."""
    other_inv = "99999999-8888-7777-6666-555555555555"

    def rerun(m):
        m["metadata"]["invocation_id"] = other_inv
        node = m["nodes"]["model.proj.serving_history"]
        node["compiled_code"] = node["compiled_code"].replace(INV, other_inv)

    assert _same(rerun)


def test_another_packages_macros_are_left_to_the_package_files():
    assert _same(
        _set(["macros", "macro.dbt_utils.star", "macro_sql"], "{% macro star() %}y{% endmacro %}")
    )


# ── MUST force a build (correctness) ─────────────────────────────────────────


@pytest.mark.parametrize(
    "mutate",
    [
        _set([*GOLD, "compiled_code"], "select a, 'x -- y' as s from `p.silver.x` where b > 2"),
        _set([*GOLD, "compiled_code"], "select a, 'x  -- y' as s from `p.silver.x` where b > 1"),
        _set([*GOLD, "compiled_code"], "select a, 'x -- z' as s from `p.silver.x` where b > 1"),
        _set([*GOLD, "description"], "Tabela analítica (revisada)."),
        _set([*GOLD, "columns", "a", "description"], "coluna a, em R$"),
        _set([*GOLD, "config", "partition_by"], {"field": "mes"}),
        _set([*GOLD, "relation_name"], "`p`.`gold`.`gold_y`"),
        _set(["nodes", "test.proj.not_null_gold_x_a", "config", "severity"], "WARN"),
        _set(["nodes", "seed.proj.factors", "checksum"], {"name": "sha256", "checksum": "new-csv"}),
        _set(
            ["nodes", "operation.proj.proj-on-run-end-0", "compiled_code"],
            "{{ apply_dev_ttl(days=3) }}",
        ),
        _set(["unit_tests", "unit_test.proj.gold_x.t1", "expect"], {"rows": [{"a": 2}]}),
        _set(
            ["macros", "macro.proj.my_materialization", "macro_sql"],
            "{% macro m() %}\n{#- explains why -#}\nselect 2\n{% endmacro %}",
        ),
        lambda m: m["nodes"].pop("test.proj.not_null_gold_x_a"),
        lambda m: m["nodes"].__setitem__(
            "model.proj.new", {"resource_type": "model", "compiled_code": "select 1"}
        ),
    ],
    ids=[
        "sql-logic",
        "whitespace-inside-a-string",
        "comment-lookalike-inside-a-string",
        "persisted-description",
        "persisted-column-description",
        "config",
        "relation",
        "test-severity",
        "seed-data",
        "project-hook",
        "unit-test",
        "project-macro",
        "node-removed",
        "node-added",
    ],
)
def test_what_changes_the_build_forces_it(mutate):
    assert not _same(mutate)


def test_a_node_dbt_did_not_compile_falls_back_to_the_stricter_raw_code():
    """Should not happen after `dbt compile`; if it does, ANY edit — comments included —
    must count, rather than the node silently dropping out of the comparison."""

    def uncompiled(raw):
        def mutate(m):
            del m["nodes"]["model.proj.gold_x"]["compiled_code"]
            m["nodes"]["model.proj.gold_x"]["raw_code"] = raw

        return mutate

    base, a, b = _manifest(), _manifest(), _manifest()
    uncompiled("select 1")(a)
    uncompiled("select 1 -- note")(b)
    assert fp.compare(fp.compute(a), fp.compute(b))[0] is False
    assert fp.compare(fp.compute(base), fp.compute(a))[0] is False


def test_the_diff_names_what_changed():
    base, other = _manifest(), _manifest()
    other["nodes"]["model.proj.gold_x"]["description"] = "outra"
    identical, diffs = fp.compare(fp.compute(base), fp.compute(other))
    assert not identical
    assert diffs == ["changed node:model.proj.gold_x"]


def test_a_new_fingerprint_schema_rebuilds_once():
    a = fp.compute(_manifest())
    b = copy.deepcopy(a)
    b["schema_version"] = fp.SCHEMA_VERSION + 1
    assert fp.compare(a, b)[0] is False


# ── Project files: parsed, so comments don't count ───────────────────────────


def test_project_and_workflow_files_count_by_content_not_comments(tmp_path):
    proj = tmp_path / "dbt"
    proj.mkdir()
    wf = tmp_path / "wf.yml"

    def fingerprint(project_yml: str, workflow_yml: str) -> dict:
        (proj / "dbt_project.yml").write_text(project_yml, encoding="utf-8")
        wf.write_text(workflow_yml, encoding="utf-8")
        return fp.compute(_manifest(), proj, wf)

    base = fingerprint("vars:\n  k: 1\n", "jobs:\n  build:\n    steps: [a]\n")
    commented = fingerprint(
        "# why k is 1\nvars:\n  k: 1  # note\n", "# doc\njobs:\n  build:\n    steps: [a]\n"
    )
    assert fp.compare(base, commented)[0] is True
    assert (
        fp.compare(base, fingerprint("vars:\n  k: 2\n", "jobs:\n  build:\n    steps: [a]\n"))[0]
        is False
    )
    assert (
        fp.compare(base, fingerprint("vars:\n  k: 1\n", "jobs:\n  build:\n    steps: [a, b]\n"))[0]
        is False
    )


def test_the_real_project_and_workflow_files_can_be_fingerprinted():
    """The real workflow's `on:` key parses as the boolean True in YAML 1.1 — mixed with
    string keys it broke the sorted hash. A synthetic YAML without `on:` never showed it;
    the backtest over the real commits did (2026-09-26)."""
    repo = _SCRIPT.parents[1]
    got = fp.compute(
        _manifest(), repo / "dbt", repo / ".github" / "workflows" / "dbt-build-prod.yml"
    )
    assert got["parts"]["file:workflow"] and got["parts"]["file:dbt_project.yml"]


# ── The CLI contract the workflow relies on: only exit 0 skips ───────────────


def test_cli_exit_codes(tmp_path, capsys):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(_manifest()), encoding="utf-8")
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    assert fp.main(["compute", str(manifest), "--out", str(a)]) == 0
    assert fp.main(["compute", str(manifest), "--out", str(b)]) == 0
    assert fp.main(["compare", str(a), str(b)]) == 0

    changed = _manifest()
    changed["nodes"]["model.proj.gold_x"]["compiled_code"] = "select 2"
    manifest.write_text(json.dumps(changed), encoding="utf-8")
    assert fp.main(["compute", str(manifest), "--out", str(b)]) == 0
    assert fp.main(["compare", str(a), str(b)]) == 1
    assert "changed node:model.proj.gold_x" in capsys.readouterr().out

    assert fp.main(["compare", str(tmp_path / "missing.json"), str(b)]) == 2
