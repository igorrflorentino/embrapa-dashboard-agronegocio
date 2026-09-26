"""The prod build workflow skips a push ONLY when the compiled project did not change.

`tests/test_dbt_build_fingerprint.py` pins WHAT counts as a change. This file pins the
wiring around it in `.github/workflows/dbt-build-prod.yml`, where a slip is just as
silent: a fingerprint compiled under different --vars than the build, an artifact
uploaded under one name and downloaded under another, or a skip that also applies to the
scheduled build — the one that carries new Bronze data — would each leave prod stale with
every run green.

The decision step is also RUN, under bash, with `gh` and `uv` replaced by stubs, so what
is checked is the script the workflow executes, not a reading of its text. Six scenarios;
exactly one of them may skip.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "dbt-build-prod.yml"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _steps() -> list[dict]:
    return _workflow()["jobs"]["build"]["steps"]


def _step(name: str) -> dict:
    for step in _steps():
        if step.get("name") == name:
            return step
    raise AssertionError(f"no step named {name!r} in {WORKFLOW.name} — did it move?")


COMPILE = "Compile and fingerprint the project"
DECIDE = "Decide whether this push changes what the build produces"
BUILD = "dbt build prod"
ORPHANS = "Mark orphan produtos (Curadoria lifecycle)"
KEEP = "Keep this build's fingerprint"
ARGS = "Assemble dbt arguments"


# ── Wiring ───────────────────────────────────────────────────────────────────


def test_the_steps_run_in_the_order_the_decision_needs():
    names = [s.get("name") for s in _steps()]
    order = [names.index(n) for n in (ARGS, COMPILE, DECIDE, BUILD, ORPHANS, KEEP)]
    assert order == sorted(order)


def test_only_a_push_can_be_skipped():
    """The scheduled and manual builds carry NEW BRONZE DATA with unchanged code — the
    exact case the fingerprint calls 'identical'. They must never consult it."""
    assert _step(DECIDE)["if"].replace(" ", "") == "github.event_name=='push'"
    assert _step(DECIDE)["id"] == "decide"


def test_the_build_and_its_side_effect_obey_the_decision():
    assert _step(BUILD)["if"].replace(" ", "") == "steps.decide.outputs.skip!='true'"
    assert "steps.decide.outputs.skip != 'true'" in _step(ORPHANS)["if"]


def test_compile_and_build_read_the_same_assembled_arguments():
    """A fingerprint compiled under other --vars describes another project: a change to a
    var-gated model (curation views, foreign deflators) would slip past it."""
    assert '> "$RUNNER_TEMP/dbt_args"' in _step(ARGS)["run"]
    for name, verb in ((COMPILE, "compile"), (BUILD, "build")):
        run = _step(name)["run"]
        assert 'mapfile -t ARGS < "$RUNNER_TEMP/dbt_args"' in run
        assert f'uv run dbt {verb} "${{ARGS[@]}}"' in run


def test_the_dbt_environment_is_shared_by_compile_and_build():
    job_env = _workflow()["jobs"]["build"]["env"]
    for key in (
        "BQ_SILVER_DATASET",
        "BQ_GOLD_DATASET",
        "BQ_SERVING_DATASET",
        "BCB_CURRENCY_SERIES",
        "BCB_INFLATION_SERIES_IPCA_CODE",
        "FOREIGN_INFLATION_CPI_CODE",
        "FOREIGN_INFLATION_HICP_CODE",
    ):
        assert key in job_env, f"{key} must be job-level so the compile sees it too"
    for name in (COMPILE, BUILD):
        assert "env" not in _step(name), f"{name!r} must not override the shared dbt env"


def test_the_fingerprint_is_kept_under_the_name_and_path_the_next_push_reads():
    keep = _step(KEEP)
    assert keep["if"] == "success()", (
        "a failed run's fingerprint would claim prod holds what it failed to build"
    )
    assert keep["uses"].startswith("actions/upload-artifact@")
    name, path = keep["with"]["name"], keep["with"]["path"]
    assert f"-n {name}" in _step(DECIDE)["run"]
    produced = "$RUNNER_TEMP/fingerprint/fingerprint.json"
    assert f'--out "{produced}"' in _step(COMPILE)["run"]
    assert path == "${{ runner.temp }}/fingerprint/fingerprint.json"
    assert f'"{produced}"' in _step(DECIDE)["run"]


def test_the_run_may_read_the_previous_run():
    assert _workflow()["permissions"].get("actions") == "read"


# ── The decision, executed ───────────────────────────────────────────────────

_bash = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("bash") is None,
    reason="runs the workflow step's own script under bash (CI is Linux)",
)


def _fingerprint(digest: str) -> dict:
    return {"schema_version": 1, "digest": digest, "parts": {"node:x": digest}}


def _decide(
    tmp_path: Path, *, listed: str | None, baseline: dict | None, current: dict
) -> tuple[str, str, str]:
    """Run the step with `gh` and `uv` replaced. `listed` is what `gh run list … --jq`
    prints (None = the call fails); `baseline` is the artifact `gh run download` yields
    (None = no artifact). Returns (skip, stdout, summary).

    The stubs are bash FUNCTIONS, not executables on PATH: a function always wins over a
    real `gh` installed on the machine. And the fake `gh` logs every call, which the test
    requires — a stub that is never reached makes every "build" scenario pass for the
    wrong reason (it did, once, while this harness was being written)."""
    runner_temp = tmp_path / "runner"
    (runner_temp / "fingerprint").mkdir(parents=True)
    (runner_temp / "fingerprint" / "fingerprint.json").write_text(
        json.dumps(current), encoding="utf-8"
    )
    src, calls = tmp_path / "baseline.json", tmp_path / "gh-calls.log"
    if baseline is not None:
        src.write_text(json.dumps(baseline), encoding="utf-8")
    listing = "return 1" if listed is None else f"printf '%s\n' '{listed}'; return 0"
    stubs = f"""
gh() {{
  echo "gh $1 $2" >> "{calls.as_posix()}"
  if [ "$1 $2" = "run list" ]; then {listing}; fi
  if [ "$1 $2" = "run download" ]; then
    {"return 1" if baseline is None else ":"}
    local dest=""
    while [ $# -gt 0 ]; do [ "$1" = "-D" ] && dest="$2"; shift; done
    mkdir -p "$dest" && cp "{src.as_posix()}" "$dest/fingerprint.json"
    return 0
  fi
  return 3
}}
uv() {{ shift 2; "{Path(sys.executable).as_posix()}" "$@"; }}  # `uv run python …`
"""
    out, summary = tmp_path / "out", tmp_path / "summary"
    env = {
        **os.environ,
        "RUNNER_TEMP": str(runner_temp),
        "GITHUB_OUTPUT": str(out),
        "GITHUB_STEP_SUMMARY": str(summary),
        "GITHUB_RUN_ID": "999",
        "GITHUB_REPOSITORY": "o/r",
    }
    done = subprocess.run(
        ["bash", "-c", stubs + _step(DECIDE)["run"]],
        cwd=REPO,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert calls.read_text(encoding="utf-8").startswith("gh run list"), (
        "the fake gh was never called"
    )
    skip = dict(line.split("=", 1) for line in out.read_text(encoding="utf-8").splitlines())["skip"]
    return skip, done.stdout, summary.read_text(encoding="utf-8") if summary.exists() else ""


@_bash
def test_identical_to_the_last_successful_build_skips(tmp_path):
    same = _fingerprint("aaa")
    skip, stdout, summary = _decide(
        tmp_path, listed="41 success abcdef1234", baseline=same, current=same
    )
    assert skip == "true"
    assert "identical to run 41 (abcdef123)" in stdout
    assert "skipped" in summary and "run 41" in summary


_A, _B = _fingerprint("aaa"), _fingerprint("bbb")


@_bash
@pytest.mark.parametrize(
    ("listed", "baseline", "current", "reason"),
    [
        ("41 success abcdef1234", _A, _B, "differs from run 41"),
        ("41 failure abcdef1234", _A, _A, "ended 'failure' — prod may be half-built"),
        ("41 cancelled abcdef1234", _A, _A, "ended 'cancelled'"),
        ("41 success abcdef1234", None, _A, "run 41 left no fingerprint"),
        ("", _A, _A, "no completed build to compare with"),
        (None, _A, _A, "no completed build to compare with"),
    ],
    ids=["changed", "last-failed", "last-cancelled", "no-artifact", "no-previous-run", "gh-failed"],
)
def test_every_doubt_builds_and_says_why(tmp_path, listed, baseline, current, reason):
    skip, stdout, summary = _decide(tmp_path, listed=listed, baseline=baseline, current=current)
    assert skip == "false"
    assert reason in stdout
    assert summary == ""
