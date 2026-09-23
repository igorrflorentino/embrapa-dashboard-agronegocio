"""The turn-on runbook names real things.

`PLANS/correcao_inflacionaria_multimoeda.md` § Turning it on is the sequence an operator
follows with the dev environment in front of them. It is prose, so nothing stops it from
naming a variable that was renamed, a Job that was retired, or a make target that never
existed — and the operator finds out at the one moment the cost is highest, mid-sequence,
with a half-configured Job.

That is not hypothetical here. The runbook shipped in v1.82.0 with four steps and stayed
at four through v1.83.0, which made `BLS_KEY_SECRET` a real prerequisite and documented it
in `deploy.sh` and `.env.example` — everywhere except the page the operator actually opens.
The repo's recurring defect is a documented fact that quietly stops being true; this is the
cheap half of guarding against it.

What this CANNOT check is the ORDER, which is the part that matters most (flipping the dbt
var before Bronze has rows cascades a 404 through every Gold table). Order lives in the
prose. This pins the vocabulary the prose is built from, so a rename breaks a test instead
of an operator's afternoon.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLAN = REPO / "PLANS" / "correcao_inflacionaria_multimoeda.md"


def _runbook() -> str:
    """The '## Turning it on' section, up to the next heading."""
    text = PLAN.read_text(encoding="utf-8")
    match = re.search(r"^## Turning it on\n(.*?)^## ", text, re.S | re.M)
    assert match, "PLANS/correcao_inflacionaria_multimoeda.md lost its 'Turning it on' section"
    return match.group(1)


def test_the_runbook_still_starts_with_the_bls_key():
    """v1.83.0 made the key a prerequisite and the runbook did not notice for two versions.

    The key comes FIRST for a mechanical reason, not a stylistic one: deploy.sh reads
    BLS_KEY_SECRET while building the Job, so registering the key afterwards means
    deploying a second time.
    """
    body = _runbook()
    assert "BLS_KEY_SECRET" in body, (
        "the runbook no longer mentions BLS_KEY_SECRET. Without it the Job runs keyless "
        "against a 25/day cap counted per EGRESS IP, which it can find already spent."
    )
    key_at = body.index("BLS_KEY_SECRET")
    deploy_at = body.index("make ingest-job-deploy")
    assert key_at < deploy_at, (
        "the key must be registered BEFORE `make ingest-job-deploy` — deploy.sh mounts it "
        "at build time, so a key registered afterwards needs a second deploy"
    )


def test_every_identifier_the_runbook_names_exists():
    """Rename parity. Each name is load-bearing somewhere else in the repo; if it moves
    there and not here, the runbook sends the operator after something that is gone."""
    body = _runbook()

    deploy_sh = (REPO / "deploy" / "ingestion" / "deploy.sh").read_text(encoding="utf-8")
    makefile = (REPO / "Makefile").read_text(encoding="utf-8")
    workflow = (REPO / ".github" / "workflows" / "dbt-build-prod.yml").read_text(encoding="utf-8")
    cli = (REPO / "src" / "embrapa_dashboard" / "cli.py").read_text(encoding="utf-8")
    doctor = (REPO / "src" / "embrapa_dashboard" / "doctor.py").read_text(encoding="utf-8")

    # (what the runbook says, where it has to be true, how it looks there)
    claims = [
        ("BLS_KEY_SECRET", "deploy/ingestion/deploy.sh", "BLS_KEY_SECRET" in deploy_sh),
        ("make ingest-job-deploy", "Makefile", "\ningest-job-deploy:" in makefile),
        ("embrapa-ingest-all", "deploy/ingestion/deploy.sh", "embrapa-ingest-all" in deploy_sh),
        (
            "DBT_ENABLE_FOREIGN_INFLATION",
            ".github/workflows/dbt-build-prod.yml",
            "vars.DBT_ENABLE_FOREIGN_INFLATION" in workflow,
        ),
        (
            # As the Job spells it — args FOLLOW the image's `embrapa ingest` entrypoint,
            # so they start at the subcommand (see the entrypoint test below).
            "--args=foreign-inflation,--full",
            "cli.py",
            'ingest_app.command("foreign-inflation")' in cli,
        ),
        (
            "embrapa doctor",
            "doctor.py",
            '("foreign-inflation", _check_foreign_inflation)' in doctor,
        ),
    ]

    for name, home, exists in claims:
        if name in body:
            assert exists, f"the runbook names {name!r}, which no longer exists in {home}"

    # And the runbook must not have quietly dropped any of them.
    missing = [name for name, _, _ in claims if name not in body]
    assert not missing, f"the runbook stopped naming: {missing}"


def _entrypoint() -> list[str]:
    dockerfile = (REPO / "deploy" / "ingestion" / "Dockerfile").read_text(encoding="utf-8")
    match = re.search(r"^ENTRYPOINT\s+(\[.*\])\s*$", dockerfile, re.M)
    assert match, "deploy/ingestion/Dockerfile lost its exec-form ENTRYPOINT"
    return json.loads(match.group(1))


def test_job_args_never_repeat_the_entrypoint():
    """`gcloud run jobs execute --args=…` APPENDS to the image's ENTRYPOINT, and that
    entrypoint is already `embrapa ingest`. So an arg list that starts with `ingest,` runs
    `embrapa ingest ingest …` and fails on the one step the operator cannot redo cheaply.

    This runbook shipped exactly that from v1.82.0 to v1.84.0, and the vocabulary test
    above pinned it as correct ("as the Job spells it") — a test that checked the NAME
    existed and never asked what the Job would do with it. The truth lives in the
    Dockerfile, so the check reads it there, and sweeps every file that tells an operator
    how to run the Job, not only this one page.
    """
    entrypoint = _entrypoint()
    assert entrypoint[:1] == ["embrapa"], entrypoint
    already = entrypoint[1:]  # the subcommand words the image supplies itself
    if not already:
        return
    doubled = re.compile(r"--args[= ]" + re.escape(",".join(already)) + r"(,|\s|$)")

    swept = [
        PLAN,
        REPO / "Makefile",
        REPO / "CLAUDE.md",
        REPO / "README.md",
        *sorted((REPO / "deploy" / "ingestion").glob("*.sh")),
        *sorted((REPO / "deploy" / "ingestion").glob("*.md")),
        *sorted((REPO / "docs").rglob("*.md")),
    ]
    offenders = [
        f"{path.relative_to(REPO)}:{n}"
        for path in swept
        if path.exists()
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if doubled.search(line)
    ]
    assert not offenders, (
        f"these repeat the image's entrypoint ({' '.join(entrypoint)}) in --args, which "
        f"would run `{' '.join(entrypoint + already)} …`: {offenders}"
    )


def test_the_runbook_warns_against_flipping_the_var_early():
    """The one ordering mistake that breaks production rather than just the sequence.

    Gate on + Bronze empty points silver_foreign_inflation at a dataset that answers 404,
    and it cascades through silver_inflation into every Gold table. The runbook has to say
    so where the step is, not leave it to the reader to infer from the gate's existence.
    """
    body = _runbook()
    tail = body[body.index("DBT_ENABLE_FOREIGN_INFLATION") :]
    assert "cascade" in tail.lower() or "cascata" in tail.lower(), (
        "the runbook no longer explains what flipping DBT_ENABLE_FOREIGN_INFLATION before "
        "the backfill does — a 404 that reaches every Gold table"
    )
