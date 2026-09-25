"""The Cadastro tells curators WHEN an edit reaches the charts. The words must follow the cron.

A catalog edit (hide a produto, move it to another agrupamento) reaches the researcher-facing
charts only on the next prod dbt build, because the serving marts apply the visibility gate at
build time. The Cadastro states that delay in `_CC_LATENCIA` (frontend/src/ui/
ViewCadastroProdutos.jsx). It said "reconstrução diária … 08:30" for a month after the build
went from daily to Mondays and Thursdays (2026-08-26): four copies of the sentence, all stale,
and a vitest that pinned the word "diária". Nothing linked the text to the schedule.

This test reads the schedule from `.github/workflows/dbt-build-prod.yml` and fails if the
sentence names other days.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "dbt-build-prod.yml"
CADASTRO = REPO / "frontend" / "src" / "ui" / "ViewCadastroProdutos.jsx"

# cron day-of-week → the word the sentence must use for it.
_DIA = {
    "0": "domingo",
    "1": "segunda",
    "2": "terça",
    "3": "quarta",
    "4": "quinta",
    "5": "sexta",
    "6": "sábado",
    "7": "domingo",
}


def _cron_days() -> list[str]:
    crons = re.findall(r"cron:\s*'([^']+)'", WORKFLOW.read_text(encoding="utf-8"))
    assert len(crons) == 1, f"expected one schedule in {WORKFLOW.name}, found {crons}"
    return crons[0].split()[4].split(",")


def _latency_sentence() -> str:
    src = CADASTRO.read_text(encoding="utf-8")
    m = re.search(r"const _CC_LATENCIA =\s*((?:'[^']*'\s*\+?\s*)+);", src)
    assert m, "_CC_LATENCIA not found — was it renamed?"
    return "".join(re.findall(r"'([^']*)'", m.group(1)))


def test_the_cadastro_names_the_days_the_prod_build_runs() -> None:
    days = _cron_days()
    text = _latency_sentence().lower()
    if days == ["*"]:
        assert "diária" in text or "todo dia" in text, text
        return
    for d in days:
        assert _DIA[d] in text, f"cron runs on day {d} ({_DIA[d]}); the Cadastro says: {text}"
    assert "diária" not in text, f"the build is not daily, but the Cadastro says: {text}"


def test_no_other_message_restates_the_delay_by_hand() -> None:
    """The sentence drifted in four copies at once. Every message now reuses the constant."""
    src = CADASTRO.read_text(encoding="utf-8")
    code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("//"))
    assert "reconstrução" not in code
    assert code.count("próximo processamento dos dados") == 1  # the constant itself
