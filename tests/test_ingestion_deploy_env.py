"""deploy/ingestion/deploy.sh never pins the Job's upper year bound.

deploy.sh rebuilds the Job's whole env from the operator's .env, and until v1.86.1 it
forwarded every `IBGE_*`/`BCB_*` key — including `IBGE_END_YEAR=2024` and
`BCB_END_YEAR=2026`, which .env.example and scripts/setup_dev_env.py wrote in. On the
production Job that made every weekly PEVS-extração run a no-op (Bronze had reached the
pin, so the delta skipped entirely and absorbed no revision — measured 2026-09-21), and
would have stopped câmbio, inflação and the foreign deflators in January 2027.

The rule these pin: an END_YEAR never reaches the Job, and nothing else is lost with it.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
DEPLOY = REPO / "deploy" / "ingestion" / "deploy.sh"

_SAMPLE = (
    "GCP_PROJECT_ID=p\n"
    "IBGE_START_YEAR=1986\n"
    "IBGE_END_YEAR=2024\r\n"  # CRLF: a Windows-edited .env
    "BCB_START_YEAR=1974\n"
    "BCB_END_YEAR=2026\n"
    "PAM_END_YEAR=2024\n"
    "FOREIGN_INFLATION_START_YEAR=1974\n"
    "UNRELATED_SETTING=x\n"
)


def _shell_var(name: str) -> str:
    match = re.search(rf"^{name}='([^']*)'$", DEPLOY.read_text(encoding="utf-8"), re.M)
    assert match, f"deploy.sh lost its {name}"
    return match.group(1)


def _forwarded_by_regex(env_text: str) -> list[str]:
    """The two ERE patterns deploy.sh applies, applied the same way (they are
    Python-compatible: anchors, classes and alternation only)."""
    allow = re.compile(_shell_var("INGEST_ALLOWLIST"))
    deny = re.compile(_shell_var("INGEST_DENYLIST"))
    return [
        line.split("=", 1)[0]
        for line in env_text.splitlines()
        if allow.search(line) and not deny.search(line)
    ]


def test_no_end_year_is_forwarded_and_nothing_else_is_lost():
    forwarded = _forwarded_by_regex(_SAMPLE)
    assert not [k for k in forwarded if k.endswith("_END_YEAR")], forwarded
    # The START years must survive: BCB_START_YEAR=1974 is itself a pin the Job NEEDS
    # (a stale 1980 there once cut PAM/PPM 1974-1979 off every deflator).
    assert forwarded == [
        "GCP_PROJECT_ID",
        "IBGE_START_YEAR",
        "BCB_START_YEAR",
        "FOREIGN_INFLATION_START_YEAR",
    ]


def test_both_forwarding_paths_apply_the_denylist():
    """Two pipelines copy .env keys into the Job: the main allowlist and the Comtrade
    block (COMTRADE_END_YEAR is as much a pin as any). A denylist applied to one of them
    would leave the other door open."""
    text = DEPLOY.read_text(encoding="utf-8")
    applied = text.count('grep -vE "$INGEST_DENYLIST"')
    assert applied >= 2, f"the END_YEAR denylist is applied on {applied} path(s), expected 2"


@pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("bash") is None,
    reason="runs deploy.sh's own shell under bash (CI is Linux)",
)
def test_the_shell_block_itself_drops_end_years_under_strict_mode(tmp_path):
    """Not a re-implementation: the env-building block of deploy.sh, executed as written
    under `set -euo pipefail`. A `grep -v` that matches nothing exits 1, and pipefail
    would turn that into a failed deploy — the regex test above cannot see that."""
    config = tmp_path / "sample_config.txt"
    config.write_text(_SAMPLE, encoding="utf-8", newline="")
    lines = DEPLOY.read_text(encoding="utf-8").splitlines()
    start = next(i for i, ln in enumerate(lines) if ln.startswith("INGEST_ALLOWLIST="))
    end = next(i for i, ln in enumerate(lines) if ln.startswith('[ -s "$ENV_YAML" ]'))
    probe = tmp_path / "probe.sh"
    probe.write_text(
        "set -euo pipefail\n"
        f"ENV_FILE='{config}'\n"
        + "\n".join(lines[start : end + 1])
        + '\nwhile IFS= read -r l; do echo "YAML $l"; done < "$ENV_YAML"\n',
        encoding="utf-8",
    )
    out = subprocess.run(["bash", str(probe)], capture_output=True, text=True, check=True)
    yaml_lines = [ln for ln in out.stdout.splitlines() if ln.startswith("YAML ")]
    yaml_keys = [ln.split()[1].rstrip(":") for ln in yaml_lines]
    assert yaml_keys == [
        "GCP_PROJECT_ID",
        "IBGE_START_YEAR",
        "BCB_START_YEAR",
        "FOREIGN_INFLATION_START_YEAR",
    ]
    # And the operator is TOLD what was dropped, not left to discover it.
    assert "IBGE_END_YEAR" in out.stdout and "Not forwarding" in out.stdout
