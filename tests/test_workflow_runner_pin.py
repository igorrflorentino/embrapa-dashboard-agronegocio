"""Every CI job runs on ONE pinned Ubuntu image, and Python comes from `.python-version`.

What broke (measured 2026-11-17): GitHub moved `ubuntu-latest` from 24.04 to 26.04 between
2026-10-22 15:57 UTC (the last prod build that succeeded, on `ubuntu-24.04`) and 2026-10-23
15:36 UTC (the first run on `ubuntu-26.04`), with no change in this repo. actions/setup-python
ships its CPython builds PER Ubuntu release and does not rebuild old patch releases for a new
one: its manifest has 3.12.11 for 22.04 and 24.04 only (26.04 starts at 3.12.13). Every job
that asked for the pinned 3.12.11 died about 8 s in. That was the seven scheduled prod builds
of 2026-10-26 → 11-16, the daily source-freshness check and the three Python jobs of every PR,
while the painel kept serving the 2026-10-22 build.

Why pin the image rather than the interpreter: the runner image was the one input of a prod
build that changed WITHOUT going through a pull request, so no PR's CI could have caught it.
Pinned, a new image arrives as a PR like any other change, and that PR's CI proves it. Move
every job at once (the second test), ideally together with the next Python upgrade: 26.04 has
setup-python builds from 3.12.13 / 3.13.13 on, and Python 3.12 itself ends in 2028-10.

The interpreter version lives in ONE place, `.python-version` (the file pyenv and uv already
read), the way `.nvmrc` holds the Node major. A literal in a workflow is a second copy, and
second copies drift.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
WORKFLOWS = sorted((REPO / ".github" / "workflows").glob("*.yml"))
PINNED_IMAGE = re.compile(r"ubuntu-\d{2}\.\d{2}")


def _jobs() -> list[tuple[str, str, dict]]:
    """(workflow file, job id, job spec) for every job that runs on a runner of its own.

    A job that calls a reusable workflow (`uses:` at job level) has no `runs-on`: the called
    workflow's jobs carry it, and they are swept here if they live in this directory.
    """
    jobs = []
    for path in WORKFLOWS:
        workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job_id, spec in workflow["jobs"].items():
            if "uses" not in spec:
                jobs.append((path.name, job_id, spec))
    return jobs


def _setup_python_steps() -> list[tuple[str, str, dict]]:
    return [
        (workflow, job_id, step)
        for workflow, job_id, spec in _jobs()
        for step in spec.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/setup-python@")
    ]


def test_the_sweep_sees_the_workflows():
    """A moved directory or a renamed action would turn every check below vacuously green."""
    assert len(WORKFLOWS) >= 9, [p.name for p in WORKFLOWS]
    assert len(_jobs()) >= 13
    assert len(_setup_python_steps()) >= 7


def test_no_job_runs_on_a_floating_image():
    floating = [
        f"{workflow}:{job_id} (runs-on: {spec.get('runs-on')})"
        for workflow, job_id, spec in _jobs()
        if not PINNED_IMAGE.fullmatch(str(spec.get("runs-on", "")))
    ]
    assert not floating, (
        "These jobs run on an image GitHub can swap without a PR here (that is how every prod "
        f"build failed from 2026-10-26 on). Pin a versioned label like ubuntu-24.04: {floating}"
    )


def test_every_job_runs_on_the_same_image():
    images = {str(spec.get("runs-on")) for _, _, spec in _jobs()}
    assert len(images) == 1, (
        f"Jobs run on different images {sorted(images)}. Moving to a new image is ONE PR that "
        "moves every job, so its CI proves the whole set at once."
    )


def test_python_comes_from_the_repo_pin():
    offenders = [
        f"{workflow}:{job_id} (with: {step.get('with')})"
        for workflow, job_id, step in _setup_python_steps()
        if (step.get("with") or {}).get("python-version-file") != ".python-version"
        or "python-version" in (step.get("with") or {})
    ]
    assert not offenders, (
        "actions/setup-python must read `python-version-file: .python-version` and carry no "
        f"version of its own, or CI and local dev drift apart: {offenders}"
    )


def test_the_repo_pin_is_an_exact_release():
    """`3.12` instead of `3.12.11` would let each runner image pick its own patch release."""
    pin = (REPO / ".python-version").read_text(encoding="utf-8").strip()
    assert re.fullmatch(r"\d+\.\d+\.\d+", pin), f".python-version should be X.Y.Z, got {pin!r}"
