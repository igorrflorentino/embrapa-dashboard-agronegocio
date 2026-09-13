"""A doc that enumerates the deflated value family must name the whole family.

v1.82.0 added `val_real_cpi_usd` / `val_real_hicp_eur` to all five Gold facts and all six
serving marts, and updated every place that DESCRIBES the feature. It missed every place
that ENUMERATES the value matrix — which is where a reader actually looks up "what columns
exist". Found on 2026-09-13 in ARCHITECTURE.md, docs/gold_data_model.md,
docs/frontend_data_contract.md and the dbt-workflow skill, three versions after the fact.

Two things are pinned here, and the second matters more than the first.

1. **Completeness.** A live doc that spells out `val_real_{ipca,igpm,igpdi}` is enumerating
   the family, so it has to name the foreign pair too, or it teaches a matrix that is
   missing a quarter of itself.

2. **Shape.** Those docs described the matrix as "the 4 monetary conventions (× 3
   currencies)". That multiplication is not merely out of date — it encodes the exact
   assumption the feature disproved. An index measures ONE economy's prices, so CPI pairs
   with US$ only and HICP with € only; `val_real_cpi_brl` does not exist and is refused by
   `serving.sql.ALLOWED_VALUE_COLUMNS`. A doc that presents the family as a product invites
   a reader to construct the combination the pipeline will not serve.

Historical specs under PLANS/ are deliberately NOT covered. A spec records what was built
at the time; editing one so it mentions a later feature would rewrite the record rather
than fix a document. Only files a reader consults as CURRENT truth are in scope.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]

# Docs read as current truth. PLANS/ specs are records of their own moment — see docstring.
LIVE_DOCS = [
    "CLAUDE.md",
    "ARCHITECTURE.md",
    "docs/gold_data_model.md",
    "docs/frontend_data_contract.md",
    ".claude/skills/dbt-workflow/SKILL.md",
]

# The Brazilian trio spelled out as a set — the signature of "this line enumerates the family".
ENUMERATES = re.compile(r"val_real_\{ipca,\s*igpm,\s*igpdi\}")

# A hard-coded count of conventions. The number is always wrong eventually, and the
# "× N currencies" framing is wrong in kind.
FIXED_COUNT = re.compile(
    r"\b(?:\d+|two|three|four|five|six|Two|Three|Four|Five|Six)\s+"
    r"(?:currency|monetary)\s+conventions",
)


@pytest.mark.parametrize("relpath", LIVE_DOCS)
def test_a_doc_that_enumerates_the_family_names_the_foreign_pair(relpath: str):
    text = (REPO / relpath).read_text(encoding="utf-8")
    if not ENUMERATES.search(text):
        pytest.skip(f"{relpath} does not enumerate the value matrix")
    assert "val_real_cpi_usd" in text or "val_real_hicp_eur" in text, (
        f"{relpath} spells out val_real_{{ipca,igpm,igpdi}} but never names "
        "val_real_cpi_usd / val_real_hicp_eur. Those columns are in all five Gold facts and "
        "all six serving marts; a reader looking up the matrix here would not learn they "
        "exist, which is exactly how v1.82.0's docs went stale."
    )


@pytest.mark.parametrize("relpath", LIVE_DOCS)
def test_no_live_doc_presents_the_conventions_as_a_fixed_product(relpath: str):
    text = (REPO / relpath).read_text(encoding="utf-8")
    hit = FIXED_COUNT.search(text)
    assert hit is None, (
        f"{relpath} says {hit.group(0)!r}. Don't pin a count: the family grows, and the "
        '"N conventions × 3 currencies" framing asserts a Cartesian product that does not '
        "exist — a foreign index corrects only its own economy's money."
    )
