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

These tests run the step's own script under bash and read back the arguments it writes,
so what is checked is the command the workflow really assembles, not a reading of its text.
Since v1.97.0 the arguments are assembled in a step of their own and read by BOTH the
compile that is fingerprinted and the build — tests/test_dbt_build_skip_workflow.py pins
that both read the same file.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "dbt-build-prod.yml"
STEP = "Assemble dbt arguments"

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


def _argv(*, curation: str, foreign: str, tmp: Path, full_refresh: str = "") -> list[str]:
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
    assert '"$RUNNER_TEMP/dbt_args"' in script, "the step no longer writes the args file"
    env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": str(tmp)}
    subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True, env=env)
    return (tmp / "dbt_args").read_text(encoding="utf-8").splitlines()


def _vars(argv: list[str]) -> list[dict]:
    return [yaml.safe_load(argv[i + 1]) for i, arg in enumerate(argv) if arg == "--vars"]


def test_both_switches_on_reach_dbt_in_one_mapping(tmp_path):
    argv = _argv(curation="true", foreign="true", tmp=tmp_path)
    assert argv[:2] == ["--target", "prod"]
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
def test_each_switch_alone_and_neither(curation, foreign, expected, tmp_path):
    assert _vars(_argv(curation=curation, foreign=foreign, tmp=tmp_path)) == expected


def test_full_refresh_still_passes_through(tmp_path):
    argv = _argv(curation="true", foreign="true", full_refresh="true", tmp=tmp_path)
    assert "--full-refresh" in argv
    assert len(_vars(argv)) == 1
