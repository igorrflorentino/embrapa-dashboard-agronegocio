"""Source-invariant tripwires for the Q1 implied-price quality detection.

These pin the load-bearing properties of the dbt macros + gold models WITHOUT a warehouse. The
Q1 ON-state is a compile-time ``{% if %}`` (so a dbt unit_test can't exercise it) and
``accepted_values`` only checks the flag domain — so a future edit that regresses IBGE to a nominal
value, removes the magnitude floor, or inverts the problemático-before-outlier precedence would
otherwise stay green. These string-level checks fail loudly instead.
"""

from pathlib import Path

import pytest

_DBT = Path(__file__).resolve().parents[1] / "dbt"
_IBGE_MODELS = ("gold_pevs_production", "gold_pam_production", "gold_ppm_production")


def _model(name: str) -> str:
    return (_DBT / "models" / "gold" / f"{name}.sql").read_text(encoding="utf-8")


def _macro(name: str) -> str:
    return (_DBT / "macros" / f"{name}.sql").read_text(encoding="utf-8")


@pytest.mark.parametrize("model", _IBGE_MODELS)
def test_ibge_q1_scores_on_deflated_value_not_nominal(model):
    """IBGE implied-price scoring MUST use the DEFLATED value (val_real_ipca_brl). Nominal
    val_yearfx_brl manufactures a fake pre-1995 hyperinflation tail (66k+ near-zero-price rows) —
    the single most important Q1 invariant."""
    sql = _model(model)
    assert "quality_scored_bounds('val_real_ipca_brl'" in sql
    assert "quality_scored_bounds('val_yearfx_brl'" not in sql


def test_trade_q1_scores_on_usd_value():
    """Trade (COMEX/COMTRADE) scores on the nominal USD value ÷ net weight (no BR-inflation), not
    a BRL column."""
    assert "quality_scored_bounds('val_fob_usd'" in _model("gold_comex_flows")
    assert "quality_scored_bounds('primary_value_usd'" in _model("gold_comtrade_flows")


def test_magnitude_floor_is_wired_into_the_guard():
    """The magnitude floor (quality_value_floor) is what lets a single global price_k work across
    all 5 sources — without it, tiny-municipality rounding noise over-flags PAM/PPM at ~2%."""
    assert "quality_value_floor" in _macro("quality_outlier_ctes")


def test_problematic_takes_precedence_over_outlier():
    """In the level macros the PROBLEMATIC (typo) branch is decided BEFORE the OUTLIER
    (valid-but-large) branch — else a typo would be mislabeled as a valid large value."""
    macro = _macro("quality_outlier_ctes")
    assert macro.index("'problematic'") < macro.index("'outlier'")


def test_ppm_stock_rows_are_unscored_not_ok():
    """A PPM herd row (measure_kind='stock') is a headcount with NO value, so the
    implied-price detector has nothing to score. Since v1.49.0 'OK' means EXAMINED and
    cleared, so marking a stock row OK asserts an examination that never happened — it did,
    for 2.022.856 rows, 57% of the whole banco (measured on prod 2026-09-08). The stock
    branch must reach UNSCORED, and MISSING_QUANTITY must still win when the headcount
    itself is absent."""
    sql = _model("gold_ppm_production")
    stock = sql[sql.index("when measure_kind = 'stock'") :]
    stock = stock[: stock.index("else {{ data_quality_flag")]
    assert "'UNSCORED'" in stock
    # Completeness still takes precedence over the unscored tier.
    assert stock.index("'MISSING_QUANTITY'") < stock.index("'UNSCORED'")
    # And the branch is gated on the same vars as the flag itself, so a build with the
    # feature off still compiles to the previous OK/MISSING_QUANTITY pair.
    assert "enable_quality_outliers" in stock and "quality_unscored_scope" in stock
    assert "'OK'" in stock
