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


def _serving(name: str) -> str:
    return (_DBT / "models" / "serving" / f"{name}.sql").read_text(encoding="utf-8")


def _macro_body(sql: str, name: str) -> str:
    """The text of one ``{% macro name(...) %}`` block, up to its ``endmacro``."""
    start = sql.index(f"macro {name}(")
    return sql[start : sql.index("endmacro", start)]


@pytest.mark.parametrize("model", _IBGE_MODELS)
def test_ibge_q1_scores_on_deflated_value_not_nominal(model):
    """IBGE implied-price scoring MUST use a DEFLATED value. Nominal val_yearfx_brl manufactures a
    fake pre-1995 hyperinflation tail (66k+ near-zero-price rows) — the single most important Q1
    invariant.

    And the deflator must be IGP-DI, the only BCB index that reaches every IBGE year. Scoring by
    IPCA (until v1.90.0) left PAM/PPM 1974–1979 — 355.644 rows — unscoreable by construction. All
    four detector calls read the SAME column: a window that mixed two indices would bend the very
    median the price is judged against."""
    sql = _model(model)
    calls = ("quality_scored_bounds", "quality_qty_level", "quality_val_level", "quality_scored")
    for call in calls:
        assert f"{call}('val_real_igpdi_brl', 'qty_native')" in sql, call
    assert "quality_scored_bounds('val_yearfx_brl'" not in sql
    assert "'val_real_ipca_brl', 'qty_native'" not in sql


def test_trade_q1_scores_on_usd_value():
    """Trade (COMEX/COMTRADE) scores on the nominal USD value ÷ net weight (no BR-inflation), not
    a BRL column."""
    assert "quality_scored_bounds('val_fob_usd'" in _model("gold_comex_flows")
    assert "quality_scored_bounds('primary_value_usd'" in _model("gold_comtrade_flows")


def test_magnitude_floor_is_wired_into_the_guard():
    """The magnitude floor (quality_value_floor) is what lets a single global price_k work across
    all 5 sources — without it, tiny-municipality rounding noise over-flags PAM/PPM at ~2%."""
    assert "quality_value_floor" in _macro("quality_outlier_ctes")


def test_magnitude_floor_is_material_by_either_measure():
    """The floor tests the larger of the reported value and the EXPECTED one (quantity × median
    price). Testing the reported value alone made it blind to the typo that SHRINKS the value:
    the row fell under the floor and was never scored — 1.030 such rows in COMTRADE against 2.986
    flagged, and in PEVS more hidden (24) than flagged (20), measured 2026-09-24."""
    guard = _macro_body(_macro("quality_outlier_ctes"), "_q_guard")
    assert "greatest({{ value_expr }}, {{ qty_expr }} * exp(_q_ln_med_price))" in guard
    assert "or {{ value_expr }} < {{ var('quality_value_floor'" not in guard


def test_comtrade_names_a_missing_weight():
    """A COMTRADE value with no net weight is MISSING_WEIGHT — the tag COMEX already used — not
    MISSING_QUANTITY or UNSCORED depending on whether some non-kg quantity happened to be there
    (79.536 rows split 25.638 / 53.898 until v1.90.0). A missing VALUE must still win, so the
    branch requires the value present; and it rides the Q1 gate like the rest of the taxonomy."""
    sql = _model("gold_comtrade_flows")
    branch = "when primary_value_usd is not null and net_weight_kg is null then 'MISSING_WEIGHT'"
    assert branch in sql
    gate = sql.rindex("{% if var('enable_quality_outliers', false)", 0, sql.index(branch))
    assert "{%- else -%}" in sql[sql.index(branch) :]
    assert sql.index(branch) - gate < 200, "the MISSING_WEIGHT branch must sit inside the Q1 gate"


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


def test_problematic_attribution_is_null_safe_and_exhaustive():
    """A row whose implied price is >= price_k x off must land in EXACTLY one PROBLEMATIC tier.

    `_q_*_excess` is NULL when a measure's p75 equals its median, and a bare
    `abs(NULL) >= abs(x)` is NULL — which failed BOTH attribution conditions, so a 1.000x price
    anomaly fell through to 'OK'. 0 rows reached that on prod (2026-09-24), which is exactly the
    kind of immunity-by-data this project keeps losing. The guard: both levels read the SAME
    coalesced predicate, one as-is and one negated, so they are complements by construction.
    """
    macro = _macro("quality_outlier_ctes")
    blame = _macro_body(macro, "_q_blame_value")
    assert blame.count("coalesce(") == 2, "both excesses must be coalesced"
    assert "_q_blame_value(value_expr, qty_expr) }} then 'problematic'" in _macro_body(
        macro, "quality_val_level"
    )
    assert "not ({{ _q_blame_value(value_expr, qty_expr) }}) then 'problematic'" in _macro_body(
        macro, "quality_qty_level"
    )


def test_sample_gate_counts_the_population_the_median_sees():
    """`quality_min_obs` must count the prices the median is taken over — ln(v/q), which skips
    value=0 rows — not v/q, which counts them. Otherwise a product can pass the sample gate on
    prices its median never saw."""
    bounds = _macro_body(_macro("quality_outlier_ctes"), "quality_scored_bounds")
    assert "count(safe.ln(safe_divide(" in bounds
    assert "percentile_cont(safe.ln(safe_divide(" in bounds


def test_quality_value_share_weights_ibge_by_a_deflator_that_covers_every_row():
    """The donut's value_share is the one number that says how much MONEY went unexamined, so
    its weight must exist for every valued row. IPCA starts in 1980; PAM/PPM start in 1974, and
    the rows it cannot reach are precisely the ones the detector cannot score. Weighting by
    `coalesce(val_real_ipca_brl, 0)` priced them at R$ 0 and published 0,10% unexamined for a
    PAM that was 8,98% unexamined (measured 2026-09-24). IGP-DI (from 1944) covers them all."""
    mart = _serving("serving_quality_by_source")
    body = mart[mart.index("with flags as") :]
    assert "val_real_ipca_brl" not in body
    assert body.count("coalesce(val_real_igpdi_brl, 0)") == len(_IBGE_MODELS)


@pytest.mark.parametrize("model", _IBGE_MODELS)
def test_ibge_detector_window_is_the_produto_identity(model):
    """The detector's median is per produto, and a produto is (banco, tabela, código). All three
    IBGE windows carry `tabela`, so none is correct only because today's code sets are disjoint."""
    sql = _model(model)
    window = sql[sql.index("window _qw as") :]
    window = window[: window.index(")")]
    assert "product_code" in window and "tabela" in window


def test_ppm_groups_by_tabela_instead_of_lifting_it():
    """gold_ppm_production lifted `tabela` with any_value() until v1.89.0 — exact only while no
    (year, city, code) spans the herd and animal-production tables. Grouping by it makes a
    collision two rows instead of one row that mixes a headcount with a production quantity."""
    sql = _model("gold_ppm_production")
    base = sql[sql.index("with base_ppm as") : sql.index("having")]
    assert "any_value(tabela)" not in base
    assert "group by reference_year, state_acronym, city_code, product_code, tabela" in base


def test_quality_history_is_append_only_and_survives_full_refresh():
    """serving_quality_history is the one table in this project that cannot be recomputed from
    the sources: it is what the donut SAID at each build. An incremental model with a
    unique_key would overwrite rows, and one without `full_refresh=false` would be wiped by the
    prod workflow's --full-refresh input — either way `doctor`'s quality-drift check would lose
    the baseline it compares against, which is exactly how the 1985 fix (223 → 4 PAM rows)
    went unnoticed in 2026-06."""
    sql = _serving("serving_quality_history")
    config = sql[: sql.index("}}")]
    assert "materialized='incremental'" in config
    assert "full_refresh=false" in config
    assert "unique_key" not in config
    assert "ref('serving_quality_by_source')" in sql


def test_isolated_spike_sits_between_problematic_and_outlier():
    """ISOLATED_SPIKE comes after the two PROBLEMÁTICO tiers — a price 100× off is the stronger
    evidence and keeps its name (Tacima 1995 banana stays PROBLEMATIC_VALUE) — and before the
    OUTLIER tiers, because "large and plausibly priced" is exactly how an isolated spike looks to
    the price detector (two PEVS spikes were OUTLIER_VALUE before v1.92.0)."""
    flag = _macro("data_quality_flag")
    on_branch = flag[flag.index("{%- else -%}") :]
    order = [
        "THEN 'PROBLEMATIC_QUANTITY'",
        "THEN 'ISOLATED_SPIKE'",
        "THEN 'OUTLIER_VALUE'",
        "THEN 'UNSCORED'",
    ]
    positions = [on_branch.index(tier) for tier in order]
    assert positions == sorted(positions), order
    # The legacy (Q1-off) CASE must not know the tier at all (the header comment may name it).
    start = flag.index("{%- if not var('enable_quality_outliers'")
    assert "ISOLATED_SPIKE" not in flag[start : flag.index("{%- else -%}")]


@pytest.mark.parametrize("model", _IBGE_MODELS)
def test_isolated_spike_is_wired_into_every_ibge_model(model):
    """The three IBGE Gold models compute the spike on the same deflated value the price
    detector uses, join it back, and hand it to the flag. A model that computed the CTEs but
    forgot `spike=` would silently never emit the tier."""
    sql = _model(model)
    assert "{{ isolated_spike_ctes('val_real_igpdi_brl') }}" in sql
    assert "{{ isolated_spike_select() }}" in sql
    assert "{{ isolated_spike_join('e') }}" in sql
    assert "spike='_q_isolated_spike'" in sql


@pytest.mark.parametrize("model", ("gold_comex_flows", "gold_comtrade_flows"))
def test_trade_models_do_not_flag_isolated_spikes(model):
    """A shipment in one month and none in the next is how trade works, not an anomaly."""
    assert "isolated_spike" not in _model(model)


def test_isolated_spike_rule_is_the_measured_one():
    """The rule that was measured before it was written (138 rows, 60 state-year jumps, both
    halves of the Ortigueira/Telêmaco Borba 2011 case). Each clause is load-bearing:
    both neighbour years must have production (a sporadic state series cannot jump — that is
    how soy planted once in Ceará stays unflagged), and the isolated rows are SUMMED per
    state-year before being compared with the excess (Ortigueira alone explains 56% of Paraná's
    2011 jump and Telêmaco Borba 34%; only together do they cross the bar)."""
    macro = _macro("isolated_spike")
    assert "prv._tot > 0" in macro and "nxt._tot > 0" in macro
    assert "sum(case when _isolated then _v else 0 end) as _iso_tot" in macro
    assert "var('quality_spike_jump', 1.5)" in macro
    assert "var('quality_spike_explained', 0.5)" in macro
    assert "var('quality_value_floor', 100000)" in macro
    # A first or last survey year has no neighbour on one side: never isolated.
    assert "reference_year > _y0" in macro and "reference_year < _y1" in macro
    # Gated with the Q1 taxonomy, and switchable on its own.
    assert "var('enable_quality_outliers', false) and var('quality_isolated_spike', true)" in macro
