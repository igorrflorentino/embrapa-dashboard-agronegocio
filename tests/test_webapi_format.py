"""Unit tests for ``webapi/format.py`` — the metric-conventions model.

The prototype's pt-BR number/currency *formatters* were removed (the React
frontend formats numbers in JS); only the conventions model + month
abbreviations remain. These tests pin the two surviving public functions
(``monetary_column``, ``convention_value_label``) and the ``MONTH_ABBR_PT``
constant, and — critically — pin the ``monetary_column`` ↔ serving
``ALLOWED_VALUE_COLUMNS`` contract so a column the seam can request always
exists in the marts' allowlist (and the reverse, modulo the non-monetary
quantity columns).
"""

from __future__ import annotations

import pytest

from embrapa_dashboard.serving.sql import ALLOWED_VALUE_COLUMNS
from embrapa_dashboard.webapi import format as fmt

# Every (currency, correction) pair the conventions strip can present, mapped to
# the canonical Gold/serving column. Pins the exact infix/suffix wiring.
_COLUMN_CASES = [
    ("BRL", "Nominal", "val_yearfx_brl"),
    ("BRL", "IPCA", "val_real_ipca_brl"),
    ("BRL", "IGP-M", "val_real_igpm_brl"),
    ("BRL", "IGP-DI", "val_real_igpdi_brl"),
    ("USD", "Nominal", "val_yearfx_usd"),
    ("USD", "IPCA", "val_real_ipca_usd"),
    ("USD", "IGP-M", "val_real_igpm_usd"),
    ("USD", "IGP-DI", "val_real_igpdi_usd"),
    ("EUR", "Nominal", "val_yearfx_eur"),
    ("EUR", "IPCA", "val_real_ipca_eur"),
    ("EUR", "IGP-M", "val_real_igpm_eur"),
    ("EUR", "IGP-DI", "val_real_igpdi_eur"),
    # The own-currency deflators: an index only ever corrects the money of the economy
    # it measures, so each of these exists for ONE currency. The rows where they are
    # asked for another currency are below, in _IMPOSSIBLE_PAIRS.
    ("USD", "CPI", "val_real_cpi_usd"),
    ("EUR", "HICP", "val_real_hicp_eur"),
]

# Pairs the strip must never present and the allowlist must never carry: a Brazilian
# display corrected by a foreign price level, or a currency corrected by an index that
# measures a different economy. monetary_column still NAMES a column for them (it is a
# pure string mapping with no opinion), which is exactly why the allowlist has to be the
# place that refuses — see effective_value_column's fallback.
_IMPOSSIBLE_PAIRS = [
    ("BRL", "CPI", "val_real_cpi_brl"),
    ("BRL", "HICP", "val_real_hicp_brl"),
    ("EUR", "CPI", "val_real_cpi_eur"),
    ("USD", "HICP", "val_real_hicp_usd"),
]


@pytest.mark.parametrize(("currency", "correction", "expected"), _COLUMN_CASES)
def test_monetary_column_maps_every_convention_pair(currency, correction, expected):
    assert fmt.monetary_column(currency, correction) == expected


def test_monetary_column_unknown_currency_falls_back_to_brl_suffix():
    # An unmodelled currency must not crash — it falls back to the BRL suffix.
    assert fmt.monetary_column("JPY", "IPCA") == "val_real_ipca_brl"


def test_monetary_column_unknown_correction_falls_back_to_real_ipca_infix():
    # An unmodelled correction falls back to the real-IPCA infix.
    assert fmt.monetary_column("USD", "Bogus") == "val_real_ipca_usd"


def test_monetary_column_double_unknown_is_the_brl_ipca_default():
    assert fmt.monetary_column("???", "???") == "val_real_ipca_brl"


# ── monetary_column ↔ ALLOWED_VALUE_COLUMNS contract ──────────────────────────


def test_every_real_monetary_column_is_in_the_serving_allowlist():
    """A column the conventions strip can request — and the seam validates against
    ``ALLOWED_VALUE_COLUMNS`` — must exist in the allowlist, OR be one of the two
    documented USD-real gaps the seam's fallback chain handles (USD+IGP-M /
    USD+IGP-DI: the marts carry these only in BRL/EUR). The test fixes BOTH the
    columns that must be present and the precise set that is intentionally absent,
    so a silent drift in either direction fails here."""
    produced = {fmt.monetary_column(c, k) for c, k, _ in _COLUMN_CASES}
    missing = produced - ALLOWED_VALUE_COLUMNS
    # The only monetary columns monetary_column emits that the marts don't carry.
    assert missing == {"val_real_igpm_usd", "val_real_igpdi_usd"}


@pytest.mark.parametrize(("currency", "correction", "column"), _IMPOSSIBLE_PAIRS)
def test_an_index_may_not_deflate_a_currency_it_does_not_measure(currency, correction, column):
    """The pairing rule, enforced where it cannot be forgotten.

    'US$ · IPCA' is a real (if easily misread) measurement — Brazilian purchasing power
    printed in dollars — and stays available. 'R$ · CPI' is not: it would be the
    dollar's purchasing power printed in reais, which answers no question the dashboard
    asks. The allowlist is what makes it unbuildable, so it is what this pins."""
    assert fmt.monetary_column(currency, correction) == column
    assert column not in ALLOWED_VALUE_COLUMNS
    assert not fmt.deflates_own_currency(currency, correction)


def test_allowlist_monetary_columns_are_all_reachable_from_a_convention():
    """Every *monetary* column in the serving allowlist (excluding the non-monetary
    quantity measures) is reachable from some (currency, correction) pair, so the
    allowlist has no dead monetary entry the conventions can never select."""
    non_monetary = {"net_weight_kg", "qty_base"}
    monetary_allowed = ALLOWED_VALUE_COLUMNS - non_monetary
    reachable = {fmt.monetary_column(c, k) for c, k, _ in _COLUMN_CASES}
    assert monetary_allowed <= reachable


# ── convention_value_label ────────────────────────────────────────────────────

_LABEL_CASES = [
    ({"currency": "BRL", "correction": "IPCA"}, "Valor real (IPCA) — R$"),
    ({"currency": "BRL", "correction": "Nominal"}, "Valor nominal — R$"),
    ({"currency": "USD", "correction": "Nominal"}, "Valor nominal — US$"),
    ({}, "Valor real (IPCA) — R$"),  # empty conv → BRL + IPCA defaults
    # A BRAZILIAN index under a foreign symbol must say so. 'Valor real (IGP-M) — US$'
    # reads as dollars corrected by Brazilian inflation, which is not what the number
    # is: it is R$ deflated by IGP-M and then converted at today's rate.
    (
        {"currency": "USD", "correction": "IGP-M"},
        "Valor real (IGP-M · inflação do Brasil, ao câmbio de hoje) — US$",
    ),
    (
        {"currency": "EUR", "correction": "IGP-DI"},
        "Valor real (IGP-DI · inflação do Brasil, ao câmbio de hoje) — €",
    ),
    # The own-currency deflators name their economy too — the symbol alone would not
    # tell a reader whether CPI or IPCA produced the dollars in front of them.
    ({"currency": "USD", "correction": "CPI"}, "Valor real (CPI · inflação dos EUA) — US$"),
    (
        {"currency": "EUR", "correction": "HICP"},
        "Valor real (HICP · inflação da zona do euro) — €",
    ),
]


def test_the_two_correction_logics_get_different_labels_under_the_same_symbol():
    """The defect in one assertion: both are 'real dollars', and a researcher choosing
    between them can only do so if the screen distinguishes them."""
    via_brasil = fmt.convention_value_label({"currency": "USD", "correction": "IPCA"})
    via_eua = fmt.convention_value_label({"currency": "USD", "correction": "CPI"})
    assert via_brasil != via_eua
    assert "Brasil" in via_brasil and "câmbio de hoje" in via_brasil
    assert "EUA" in via_eua and "câmbio" not in via_eua


@pytest.mark.parametrize(
    ("currency", "correction", "own"),
    [
        ("BRL", "IPCA", True),
        ("USD", "CPI", True),
        ("EUR", "HICP", True),
        ("USD", "IPCA", False),
        ("EUR", "IGP-M", False),
        # Nominal corrects nothing, so there is no economy to match.
        ("USD", "Nominal", False),
        ("BRL", "Nominal", False),
    ],
)
def test_deflates_own_currency(currency, correction, own):
    assert fmt.deflates_own_currency(currency, correction) is own


@pytest.mark.parametrize(("conv", "expected"), _LABEL_CASES)
def test_convention_value_label(conv, expected):
    assert fmt.convention_value_label(conv) == expected


def test_convention_value_label_unknown_currency_falls_back_to_brl_symbol():
    assert fmt.convention_value_label({"currency": "JPY", "correction": "Nominal"}).endswith("R$")


def test_convention_value_label_is_portuguese_for_the_end_user():
    # The label is end-user-visible → pt-BR ("Valor real", not "Real value").
    assert fmt.convention_value_label({"currency": "BRL", "correction": "IPCA"}).startswith("Valor")


# ── month abbreviations ────────────────────────────────────────────────────────


def test_month_abbr_pt_is_twelve_portuguese_abbreviations_in_order():
    assert fmt.MONTH_ABBR_PT == [
        "Jan",
        "Fev",
        "Mar",
        "Abr",
        "Mai",
        "Jun",
        "Jul",
        "Ago",
        "Set",
        "Out",
        "Nov",
        "Dez",
    ]
    assert len(fmt.MONTH_ABBR_PT) == 12
    assert fmt.MONTH_ABBR_PT[0] == "Jan"  # index 0 → January
    assert fmt.MONTH_ABBR_PT[11] == "Dez"
