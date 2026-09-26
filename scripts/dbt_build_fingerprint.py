"""Fingerprint of what a prod `dbt build` would produce — so a push that changes nothing
the build can see (a comment, a YAML comment, `config.py`) does not rebuild prod.

Measured before it existed (2026-09-26): 46 of the 63 prod builds in 30 days were
push-triggered, and the build had just been measured at ~18 GiB per run. A push whose
compiled project is byte-identical to the last successful build re-runs every model to
arrive at the same tables.

Usage (both run inside `.github/workflows/dbt-build-prod.yml`):

    uv run python scripts/dbt_build_fingerprint.py compute dbt/target/manifest.json \
        --project-dir dbt --workflow .github/workflows/dbt-build-prod.yml --out fp.json
    uv run python scripts/dbt_build_fingerprint.py compare baseline.json fp.json

`compare` exits 0 when the two are identical (the build may be skipped), 1 when they
differ (it prints what changed), 2 when either file is missing or unreadable. Anything
but 0 means BUILD — the safe answer is always the default.

WHAT GOES IN — anything that can change a table, a persisted column description, a test
verdict, or how dbt runs:
  • every model, test, snapshot and operation: its COMPILED SQL, with comments removed and
    whitespace collapsed by a real SQL lexer (never inside a string literal), and this
    invocation's id replaced — serving_quality_history stamps `invocation_id` into its SQL,
    which would otherwise make every compile unique;
  • every node's config, description, columns (persist_docs writes them to BigQuery),
    relation, dependencies, contract and test metadata;
  • every seed's file checksum and every unit test's definition;
  • the project's OWN macros, Jinja comments removed — a materialization or adapter
    override acts at RUN time, after compile, so compiled SQL alone cannot see it;
  • dbt_project.yml and the package files (parsed, so their comments don't count), the
    dbt-core and dbt-bigquery versions, and the workflow file itself (the build procedure,
    parsed likewise).
WHAT STAYS OUT: comments, file paths, parse timestamps, the raw-file checksum of models —
what a commit can change without changing a byte BigQuery receives. The list of dropped
node fields is a BLOCKLIST on purpose: a field dbt adds in a future version lands IN the
fingerprint, where the worst it can do is force a build.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from importlib import metadata
from pathlib import Path

import yaml
from sqlparse import lexer
from sqlparse import tokens as T

SCHEMA_VERSION = 1

# Node fields that change without changing what the build does. Everything else counts.
_DROPPED_FIELDS = frozenset(
    {
        "created_at",
        "original_file_path",
        "path",
        "root_path",
        "patch_path",
        "compiled_path",
        "build_path",
        "raw_code",
        "compiled_code",  # re-added below, normalised
        "compiled",
        "extra_ctes",
        "extra_ctes_injected",
        "unrendered_config",
        "unrendered_config_call_dict",
        "config_call_dict",
        "fqn",
        "defer_relation",
        "deferred",
        "doc_blocks",
    }
)
_JINJA_COMMENT = re.compile(r"\{#.*?#\}", re.DOTALL)


def normalize_sql(sql: str, invocation_id: str | None = None) -> str:
    """Compiled SQL with comments dropped and whitespace collapsed, token by token.

    The lexer decides what a comment is, so `'-- not a comment'` stays intact, and
    whitespace INSIDE a string literal is part of that literal's single token — changing
    `'a  b'` to `'a b'` still changes the fingerprint.
    """
    if invocation_id:
        sql = sql.replace(invocation_id, "<invocation_id>")
    out: list[str] = []
    gap = False
    for ttype, value in lexer.tokenize(sql):
        if ttype in T.Comment or ttype in T.Whitespace or ttype in T.Newline:
            gap = True
            continue
        if gap and out:
            out.append(" ")
        gap = False
        out.append(value)
    return "".join(out)


def normalize_jinja(source: str) -> str:
    """Macro source without Jinja comments and without the blank lines they leave."""
    text = _JINJA_COMMENT.sub("", source)
    return "\n".join(line.rstrip() for line in text.splitlines() if line.strip())


def _str_keys(obj: object) -> object:
    """YAML 1.1 reads a workflow's `on:` key as the boolean True; mixed with string keys,
    `sort_keys` cannot order them. Every key becomes text before hashing."""
    if isinstance(obj, dict):
        return {str(k): _str_keys(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_str_keys(v) for v in obj]
    return obj


def _digest(obj: object) -> str:
    blob = json.dumps(_str_keys(obj), sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _node_record(node: dict, invocation_id: str | None) -> dict:
    record = {k: v for k, v in node.items() if k not in _DROPPED_FIELDS}
    if node.get("resource_type") == "seed":
        record["checksum"] = node.get("checksum")  # the seed's DATA
    else:
        record.pop("checksum", None)  # the raw file, comments included
    if node.get("compiled_code") is not None:
        record["compiled_sql"] = normalize_sql(node["compiled_code"], invocation_id)
    elif node.get("resource_type") in {"model", "test", "snapshot", "operation"}:
        # Not compiled (should not happen after `dbt compile`): fall back to the raw code,
        # which is stricter — any edit, comments included, then forces a build.
        record["raw_code"] = node.get("raw_code")
    return record


def _yaml_digest(path: Path) -> str | None:
    if not path.exists():
        return None
    return _digest(yaml.safe_load(path.read_text(encoding="utf-8")))


def _version(dist: str) -> str | None:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return None


def compute(manifest: dict, project_dir: Path | None = None, workflow: Path | None = None) -> dict:
    invocation_id = manifest.get("metadata", {}).get("invocation_id")
    project_name = manifest.get("metadata", {}).get("project_name")
    parts: dict[str, object] = {}
    for uid, node in manifest.get("nodes", {}).items():
        parts[f"node:{uid}"] = _digest(_node_record(node, invocation_id))
    for uid, unit in manifest.get("unit_tests", {}).items():
        parts[f"unit_test:{uid}"] = _digest(_node_record(unit, invocation_id))
    for uid, macro in manifest.get("macros", {}).items():
        if project_name is None or macro.get("package_name") == project_name:
            parts[f"macro:{uid}"] = _digest(normalize_jinja(macro.get("macro_sql", "")))
    if project_dir is not None:
        parts["file:dbt_project.yml"] = _yaml_digest(project_dir / "dbt_project.yml")
        parts["file:packages.yml"] = _yaml_digest(project_dir / "packages.yml")
        parts["file:package-lock.yml"] = _yaml_digest(project_dir / "package-lock.yml")
    if workflow is not None:
        parts["file:workflow"] = _yaml_digest(workflow)
    parts["version:dbt-core"] = _version("dbt-core")
    parts["version:dbt-bigquery"] = _version("dbt-bigquery")
    return {"schema_version": SCHEMA_VERSION, "digest": _digest(parts), "parts": parts}


def compare(baseline: dict, current: dict) -> tuple[bool, list[str]]:
    """(identical, human-readable differences)."""
    if baseline.get("schema_version") != current.get("schema_version"):
        return False, ["fingerprint schema changed — rebuilding once to re-anchor"]
    if baseline.get("digest") == current.get("digest"):
        return True, []
    old, new = baseline.get("parts", {}), current.get("parts", {})
    diffs = [f"added   {k}" for k in sorted(new.keys() - old.keys())]
    diffs += [f"removed {k}" for k in sorted(old.keys() - new.keys())]
    diffs += [f"changed {k}" for k in sorted(old.keys() & new.keys()) if old[k] != new[k]]
    return False, diffs


def _load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compute")
    c.add_argument("manifest")
    c.add_argument("--project-dir")
    c.add_argument("--workflow")
    c.add_argument("--out")
    k = sub.add_parser("compare")
    k.add_argument("baseline")
    k.add_argument("current")
    args = ap.parse_args(argv)

    if args.cmd == "compute":
        fp = compute(
            _load(args.manifest),
            Path(args.project_dir) if args.project_dir else None,
            Path(args.workflow) if args.workflow else None,
        )
        text = json.dumps(fp, indent=1, sort_keys=True)
        if args.out:
            Path(args.out).write_text(text, encoding="utf-8")
        else:
            print(text)
        print(f"fingerprint {fp['digest'][:16]} over {len(fp['parts'])} parts", file=sys.stderr)
        return 0

    try:
        baseline, current = _load(args.baseline), _load(args.current)
    except (OSError, ValueError) as exc:
        print(f"cannot compare ({exc}) — build", file=sys.stderr)
        return 2
    identical, diffs = compare(baseline, current)
    if identical:
        print(f"identical: {current['digest'][:16]} ({len(current['parts'])} parts)")
        return 0
    print(f"different: {len(diffs)} part(s)")
    for line in diffs[:40]:
        print(f"  {line}")
    if len(diffs) > 40:
        print(f"  … and {len(diffs) - 40} more")
    return 1


if __name__ == "__main__":
    sys.exit(main())
