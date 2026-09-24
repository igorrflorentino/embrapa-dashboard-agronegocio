"""The prod build hands dbt ONE --vars mapping, whatever the repository variables say.

dbt keeps only the LAST ``--vars`` flag: it is a single-value option, so a second one
replaces the first instead of merging with it. Measured 2026-09-24 on dbt 1.12.5 with
``--vars 'enable_curation: 12345' --vars 'enable_foreign_inflation: true'``: the compiled
``var('enable_curation')`` came out as the project default, not 12345.

dbt-build-prod.yml appended one ``--vars`` per repository variable, so with both
DBT_ENABLE_CURATION and DBT_ENABLE_FOREIGN_INFLATION set to true (prod since 2026-09-23)
the curation flag never reached dbt. Nothing broke only because dbt_project.yml ALSO says
``enable_curation: true``; the repository variable had become a switch wired to nothing,
and turning it off would have changed nothing.

These tests run the step's own script under bash, with ``uv run dbt`` swapped for a
printf, so what is checked is the command the workflow really assembles, not a reading of
its text.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "dbt-build-prod.yml"
STEP = "dbt build prod"

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("bash") is None,
    reason="runs the workflow step's own script under bash (CI is Linux)",
)


def _step_script() -> str:
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == STEP:
                return step["run"]
    raise AssertionError(f"no step named {STEP!r} in {WORKFLOW.name} — did it move?")


def _argv(*, curation: str, foreign: str, full_refresh: str = "") -> list[str]:
    values = {
        "vars.DBT_ENABLE_CURATION": curation,
        "vars.DBT_ENABLE_FOREIGN_INFLATION": foreign,
        "github.event.inputs.full_refresh": full_refresh,
    }

    def expand(match: re.Match[str]) -> str:
        expr = match.group(1).strip()
        assert expr in values, f"new expression ${{{{ {expr} }}}} in the step: give it a value here"
        return values[expr]

    script = re.sub(r"\$\{\{(.*?)\}\}", expand, _step_script())
    assert "uv run dbt" in script, "the step no longer runs `uv run dbt` — update this test"
    script = script.replace("uv run dbt", "printf 'ARG:%s\\n'")
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True).stdout
    return [line[4:] for line in out.splitlines() if line.startswith("ARG:")]


def _vars(argv: list[str]) -> list[dict]:
    return [yaml.safe_load(argv[i + 1]) for i, arg in enumerate(argv) if arg == "--vars"]


def test_both_switches_on_reach_dbt_in_one_mapping():
    argv = _argv(curation="true", foreign="true")
    assert argv[:3] == ["build", "--target", "prod"]
    assert _vars(argv) == [{"enable_curation": True, "enable_foreign_inflation": True}]


@pytest.mark.parametrize(
    ("curation", "foreign", "expected"),
    [
        ("true", "", [{"enable_curation": True}]),
        ("", "true", [{"enable_foreign_inflation": True}]),
        ("", "", []),
        ("false", "false", []),
    ],
)
def test_each_switch_alone_and_neither(curation, foreign, expected):
    assert _vars(_argv(curation=curation, foreign=foreign)) == expected


def test_full_refresh_still_passes_through():
    argv = _argv(curation="true", foreign="true", full_refresh="true")
    assert "--full-refresh" in argv
    assert len(_vars(argv)) == 1
