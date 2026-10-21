"""The 17 fruits IBGE counted until 2000, pinned against IBGE's own list.

The build-time detector ``assert_pam_quantity_no_unit_cliff`` looks for a >= 4x year-over-year step
in the national quantity. That is a symptom, and for five of IBGE's seventeen fruits it is too
small to trip it: abacate x0.45, manga x0.36, marmelo x0.25 (3.97x), melao x1.5, mamao x0.88
(measured 2026-10-21, docs/audits/unidades_e_deflacao_audit_2026-10-21.md). So the guard is the
LIST, not the threshold: IBGE's note ("Mudanca da unidade de medida das frutiferas",
https://sidra.ibge.gov.br/content/documentos/pam/AlteracoesUnidadesMedidaFrutas.pdf) names every
fruit and its median weight, and the seed carries all of them — inert until a product is ingested,
correct the day it is registered in the catalog.

The product codes are SIDRA classification-782 codes read from the API (2026-10-21), not typed from
memory; the weights are the values PRINTED in IBGE's table.
"""

from __future__ import annotations

import csv
from pathlib import Path

_SEEDS = Path(__file__).resolve().parent.parent / "dbt/seeds"

# code -> (name, kg per fruit as printed by IBGE; banana is kg per BUNCH)
IBGE_COUNTED_FRUITS: dict[str, tuple[str, float]] = {
    "40129": ("abacate", 0.38),
    "40136": ("banana", 10.20),
    "40142": ("caqui", 0.18),
    "40148": ("figo", 0.09),
    "40149": ("goiaba", 0.16),
    "40151": ("laranja", 0.16),
    "40152": ("limão", 0.10),
    "40260": ("maçã", 0.15),
    "40261": ("mamão", 0.80),
    "40262": ("manga", 0.31),
    "40263": ("maracujá", 0.15),
    "40264": ("marmelo", 0.19),
    "40267": ("pêra", 0.17),
    "40268": ("pêssego", 0.13),
    "40271": ("tangerina", 0.15),
    "40120": ("melancia", 6.08),
    "40121": ("melão", 1.39),
}
# IBGE's footnote: grape "sempre foi pesquisada em peso"; abacaxi and coco-da-baía "continuam a ser
# pesquisados por unidade (mil frutos)" — the last two live in pam_count_unit_products.
ALWAYS_WEIGHED = {"40274": "uva"}
ALWAYS_COUNTED = {"40092": "abacaxi", "40145": "coco-da-baía"}


def _rows(name: str) -> list[dict]:
    with (_SEEDS / name).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_the_seed_is_exactly_ibges_list_of_seventeen():
    """A fruit missing here is converted by nobody; a row that is not in IBGE's note is a
    conversion with no source. Adding a fruit to the seed means adding it here, on purpose."""
    seed = {r["product_code"]: r for r in _rows("pam_fruit_unit_eras.csv")}
    assert set(seed) == set(IBGE_COUNTED_FRUITS)
    for code, (name, kg) in IBGE_COUNTED_FRUITS.items():
        row = seed[code]
        assert float(row["kg_per_unit"]) == kg, f"{name} ({code}): weight differs from IBGE's note"
        # The count changed unit in 2001; the series starts in 1974 (the first PAM year).
        assert (int(row["year_from"]), int(row["year_to"])) == (1974, 2000), name
        assert row["source_unit"] == ("mil cachos" if code == "40136" else "mil frutos"), name


def test_each_reason_states_the_weight_the_column_carries():
    """The researcher-facing sentence and the number the Silver multiplies by are two copies of one
    fact; they drift silently unless something compares them."""
    for row in _rows("pam_fruit_unit_eras.csv"):
        name = IBGE_COUNTED_FRUITS[row["product_code"]][0]
        kg = float(row["kg_per_unit"])  # the COLUMN, which is what the Silver multiplies by
        assert f"{kg:.2f}".replace(".", ",") + " kg" in row["reason"], name


def test_a_product_is_counted_always_or_until_2000_never_both_and_never_a_weighed_one():
    eras = {r["product_code"] for r in _rows("pam_fruit_unit_eras.csv")}
    counted = {r["product_code"] for r in _rows("pam_count_unit_products.csv")}
    assert eras.isdisjoint(counted)
    # The seeds name EXACTLY the products IBGE says were counted: grape was always weighed, and
    # converting a weight by a weight-per-fruit would be a 0.1x error of our own making.
    assert eras.isdisjoint(ALWAYS_WEIGHED)
    assert counted == set(ALWAYS_COUNTED)
