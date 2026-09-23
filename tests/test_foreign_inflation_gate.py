"""The foreign-deflator gate has to cover the SOURCE, not just the model.

v1.82.0 gated `silver_foreign_inflation` behind `enable_foreign_inflation` after reasoning
carefully about one failure: a Bronze table that 404s until the first ingest would fail that
model and cascade through `silver_inflation` into every Gold table. The reasoning was about
`dbt build`, and it was right about `dbt build`.

It missed that `dbt source freshness` is a DIFFERENT command, in a different workflow, which
reads the SOURCE declaration — and that one had no gate. From 2026-09-13 the daily monitor
failed with `Dataset bronze_foreign was not found`, every day, on a dataset nobody had
written to yet.

What that costs is not a red square. That workflow is the standing staleness monitor for the
WHOLE Bronze layer and its own header says an error-level breach pages the operator by
e-mail; a run that always fails buries the signal it exists to carry. A monitor that cannot
pass is a monitor that is off — the same defect shape as a probe that cannot fail (the BLS
quota refusal the doctor used to certify in v1.82.1).

So the invariant is not "the source is gated" but "the source and the model that reads it
ride the SAME gate", because the two failure directions are both real:
  • source enabled, model off  → the freshness monitor fails on a missing dataset (the bug);
  • model enabled, source off  → `dbt build` fails with "source is disabled".
Neither half can be flipped alone.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
SOURCES_YML = REPO / "dbt" / "models" / "_sources.yml"
SILVER_SQL = REPO / "dbt" / "models" / "silver" / "silver_foreign_inflation.sql"
PROJECT_YML = REPO / "dbt" / "dbt_project.yml"

GATE = "enable_foreign_inflation"


def _foreign_table() -> dict:
    doc = yaml.safe_load(SOURCES_YML.read_text(encoding="utf-8"))
    source = next(s for s in doc["sources"] if s["name"] == "bronze_foreign")
    return source["tables"][0]


def test_the_bronze_foreign_source_is_gated_by_the_same_var_as_its_model():
    table = _foreign_table()
    enabled = str(table["config"]["enabled"])
    assert GATE in enabled, (
        f"bronze_foreign.{table['name']} has config.enabled={enabled!r}, which does not read "
        f"{GATE}. Ungated, `dbt source freshness` asks a dataset that does not exist yet how "
        "old it is, and the daily Bronze monitor fails forever."
    )
    model = SILVER_SQL.read_text(encoding="utf-8")
    assert re.search(rf"enabled\s*=\s*var\(\s*['\"]{GATE}['\"]", model), (
        f"silver_foreign_inflation no longer rides {GATE}. Source and model must turn on "
        "together: the source alone breaks the freshness monitor, the model alone breaks "
        "`dbt build` with 'source is disabled'."
    )


def test_the_gate_does_not_silently_delete_the_freshness_monitor():
    """Gating is not the same as removing. Once the deflators are ingested the source has to
    be watched like every other Bronze table — and on the same window as the BCB indices it
    rides the weekly batch with, or one half of the conventions strip could go stale while
    the other stayed fresh with nothing saying so."""
    table = _foreign_table()
    freshness = table["config"]["freshness"]
    assert table["config"]["loaded_at_field"] == "ingestion_timestamp"
    assert freshness["warn_after"] == {"count": 10, "period": "day"}
    assert freshness["error_after"] == {"count": 17, "period": "day"}

    doc = yaml.safe_load(SOURCES_YML.read_text(encoding="utf-8"))
    bcb = next(s for s in doc["sources"] if s["name"] == "bronze_bcb")
    pares = next(t for t in bcb["tables"] if t["name"] == "inflation_raw")
    assert pares["config"]["freshness"] == freshness, (
        "the foreign deflators and the BCB ones ride the same weekly batch, so a window that "
        "differs between them would call one stale while the other is fine"
    )


def test_no_other_bronze_source_was_gated_by_accident():
    """The instrument guard. A gate that spread to the other nine sources would silence the
    monitor completely — and it would look exactly like this fix from the outside."""
    doc = yaml.safe_load(SOURCES_YML.read_text(encoding="utf-8"))
    gated = {
        f"{s['name']}.{t['name']}"
        for s in doc["sources"]
        for t in s.get("tables", [])
        if GATE in str((t.get("config") or {}).get("enabled", ""))
    }
    assert gated == {"bronze_foreign.inflation_raw"}, f"gate spread to: {gated}"

    watched = {
        f"{s['name']}.{t['name']}"
        for s in doc["sources"]
        for t in s.get("tables", [])
        if (t.get("config") or {}).get("freshness")
    }
    # The nine that must keep being measured no matter what this feature does.
    assert watched >= {
        "bronze_ibge.sidra_raw",
        "bronze_ibge.sidra_silvicultura_raw",
        "bronze_pam.sidra_raw",
        "bronze_ppm.herd_raw",
        "bronze_ppm.animal_raw",
        "bronze_bcb.inflation_raw",
        "bronze_bcb.currency_raw",
        "bronze_comex.comex_flows_raw",
        "bronze_comtrade.comtrade_flows_raw",
    }


def test_the_gate_ships_off_and_is_a_literal_boolean():
    """Two separate facts, both load-bearing.

    OFF by default, because the turn-on sequence is ingest-first and a default of true would
    break the prod build on the very next merge. And a LITERAL boolean, because a Jinja
    expression in dbt_project.yml renders to the STRING "False" — which is what made
    `config(enabled="False")` fail dbt's schema validation in v1.82.0's first CI run.
    """
    project = yaml.safe_load(PROJECT_YML.read_text(encoding="utf-8"))
    value = project["vars"][GATE]
    assert value is False, f"{GATE} must be the literal boolean false, got {value!r}"


MAKEFILE = REPO / "Makefile"


def _prod_build_lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if "--target prod" in ln and "build" in ln]


def test_every_local_prod_build_carries_the_gate_prod_runs_with():
    """Production has run with the gate ON since 2026-09-23 — through the repo variable
    DBT_ENABLE_FOREIGN_INFLATION, which only dbt-build-prod.yml reads. The Makefile's prod
    targets (including `dbt-build-prod-with-backup`, the path CLAUDE.md recommends, and
    `reconcile`) ran a bare prod build: gate OFF, so a local prod build rebuilt Gold with
    every val_real_{cpi,hicp}_* NULL. Nothing failed; the columns just emptied. Same defect
    shape as the pinned END_YEARs of v1.86.1 — CI right, the local path wrong. A sweep, so a
    NEW prod recipe cannot be added without the gate either."""
    text = MAKEFILE.read_text(encoding="utf-8")
    prod_lines = _prod_build_lines(text)
    assert prod_lines, "no prod build recipe found in the Makefile — did it change?"
    bare = [ln for ln in prod_lines if "$(PROD_VARS)" not in ln and GATE not in ln]
    assert not bare, f"prod build recipe(s) without the foreign-deflator gate: {bare}"

    default = re.search(r"^ENABLE_FOREIGN_INFLATION\s*\?=\s*(\S+)", text, re.M)
    assert default and default.group(1) == "true", "the local prod default must match prod (ON)"
    assert re.search(
        r"^PROD_VARS\s*:=.*" + GATE + r":\s*\$\(ENABLE_FOREIGN_INFLATION\)", text, re.M
    ), "PROD_VARS must hand dbt the gate from ENABLE_FOREIGN_INFLATION"


@pytest.mark.skipif(shutil.which("make") is None, reason="needs GNU make (CI is Linux)")
def test_make_expands_the_gate_into_the_prod_build_command():
    """The recipe as make will actually run it (`make -n` prints, executes nothing)."""
    on = subprocess.run(
        ["make", "-n", "dbt-build-prod"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout
    built = _prod_build_lines(on)
    assert built and all(f"{GATE}: true" in ln for ln in built), built
    off = subprocess.run(
        ["make", "-n", "dbt-build-prod", "ENABLE_FOREIGN_INFLATION=false"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert f"{GATE}: false" in off
