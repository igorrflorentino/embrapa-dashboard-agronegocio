"""Every quantity unit IBGE's SIDRA uses has a conversion — before a product that needs it exists.

The audit of 2026-10-22 (docs/audits/unidades_e_deflacao_audit_2026-10-21.md, item D) scanned the
WHOLE SIDRA universe of PAM, PEVS and PPM, not just the catalog, and found exactly one quantity
unit without a row in ``unit_family_conversions``: ``Mil árvores`` (PEVS 3449, pinheiro-brasileiro
— árvores abatidas). Registered as it was, its quantity would have landed in family
``desconhecida`` with a NULL ``qty_base`` (the Silver never invents a conversion), which
``assert_unconvertible_quantities_for_curation`` reports only AFTER the data is in Gold. The seed
has the row now; this test pins the measured list so the guarantee cannot erode silently.

The list below is a MEASUREMENT, not a specification: unit labels of the cells that carry a numeric
value, per table, over every product and year. A unit IBGE introduces later will not be here — that
case is what ``embrapa discover ibge-series-check`` (before registering) and the dbt test above
(after ingesting) are for.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

_SEEDS = Path(__file__).resolve().parent.parent / "dbt/seeds"

# table -> quantity unit labels (lowercased, as the Silver joins them), measured 2026-10-22
SIDRA_QUANTITY_UNITS: dict[str, set[str]] = {
    "t5457 (PAM)": {"toneladas"},
    "t289 (PEVS extração)": {"toneladas", "metros cúbicos", "mil árvores"},
    "t291 (PEVS silvicultura)": {"toneladas", "metros cúbicos"},
    "t74 (PPM produção animal)": {"mil dúzias", "mil litros", "quilogramas"},
    "t3939 (PPM rebanhos)": {"cabeças"},
}


def _conversions() -> dict[str, dict]:
    with (_SEEDS / "unit_family_conversions.csv").open(encoding="utf-8") as f:
        return {r["unit_raw"]: r for r in csv.DictReader(f)}


@pytest.mark.parametrize("table", sorted(SIDRA_QUANTITY_UNITS))
def test_every_unit_of_the_table_converts_to_a_family_base(table: str) -> None:
    conv = _conversions()
    for unit in sorted(SIDRA_QUANTITY_UNITS[table]):
        row = conv.get(unit)
        assert row is not None, f"{table}: unit {unit!r} has no row in unit_family_conversions"
        # a blank to_base means 'needs a per-product factor' (saca, @, bushel) — not generic
        assert row["to_base"].strip(), f"{table}: unit {unit!r} has no generic to_base"
        assert row["family"].strip() and row["base_unit"].strip()


def test_mil_arvores_is_a_count_of_thousands_in_both_spellings() -> None:
    """1 mil árvores = 1000 trees, in the 'contagem' family like mil dúzias / milheiro. Both
    spellings, because the join is on lower(trim(label)) and SIDRA prints the accent."""
    conv = _conversions()
    for label in ("mil árvores", "mil arvores"):
        assert (conv[label]["family"], conv[label]["base_unit"], float(conv[label]["to_base"])) == (
            "contagem",
            "un",
            1000.0,
        )


def test_the_thousands_units_agree_with_each_other() -> None:
    """A 'mil X' unit must be 1000 × the X unit it counts: a typo in one of them would rescale a
    whole series by a factor nobody sees (the label and the family still look right)."""
    conv = _conversions()
    assert float(conv["mil dúzias"]["to_base"]) == 1000 * float(conv["dúzia"]["to_base"])
    assert float(conv["mil árvores"]["to_base"]) == 1000 * float(conv["un"]["to_base"])
    assert float(conv["mil litros"]["to_base"]) == 1000 * float(conv["l"]["to_base"])
