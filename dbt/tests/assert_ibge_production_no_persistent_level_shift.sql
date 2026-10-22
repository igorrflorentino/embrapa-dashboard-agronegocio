-- Persistent level-shift detector for the IBGE bancos (PAM, PEVS, PPM): a product whose NATIONAL
-- quantity settles at a new level that STAYS — the median of the three years from a year on at
-- 3x or more (or 1/3 or less) the median of the three years before it — has very likely changed
-- UNIT or METHOD inside the series, not production.
--
-- Why this exists: assert_pam_quantity_no_unit_cliff looks at the step between two consecutive
-- years, in PAM only, and only for steps of 4x or more. This one compares LEVELS: the three
-- years after a unit change are all on the new side, while a harvest, a frost or a boom swings
-- and comes back. It covers the three IBGE bancos, and a change the step test lets through by a
-- hair (marmelo: x0.25 in 2001, a 3.97x step against the step test's 4x; measured on SIDRA's
-- raw series, 2026-10-22). The same rule is applied BEFORE a product is registered by
-- `embrapa discover ibge-series-check` (src/embrapa_dashboard/discover.py::level_shifts,
-- SHIFT_FACTOR = 3 there too; tests/test_discover_series_check.py pins the number in this file).
--
-- WHAT IT DOES NOT CATCH, measured: a unit change whose size is inside the 3x band. Of IBGE's
-- 17 PAM fruits counted until 2000, abacate (x0.45), manga (x0.36), melão (x1.5) and mamão
-- (x0.88) stay under it. The guard for them is IBGE's own LIST, which the seed
-- pam_fruit_unit_eras carries in full (tests/test_pam_counted_fruits.py pins it) — so this test
-- is the net for a product that is NOT on that list, not the guard for the ones that are. It is
-- also blind to a swing of ONE year (it never moves the median of three), and an episode of two
-- years fires as an up/down pair a couple of years apart: read the pair together.
--
-- Calibration, measured 2026-10-22 over the 38 products the serving marts hold (PAM 14, PEVS 10,
-- PPM 14): 0 rows at 3x, 13 at 2x — real production changes (castanha de caju, native-forest
-- timber, herds, milk) with ratios 2.0-2.6. 3x is the first factor with no false alarm on what
-- is in production today. Python and SQL agree exactly: 109 shifts in each, over the 193 real
-- national series (6,457 points) of SIDRA tables 5457, 289, 291, 74 and 3939.
--
-- Reads qty_base AFTER the unit conversion (the seeds pam_fruit_unit_eras and
-- unit_family_conversions), so a product the seeds already convert does not fire; and reads the
-- serving marts, which hold the by-UF grain pre-aggregated and hide the products a researcher
-- marked unavailable.
--
-- WARN, not error, and the row is a PROMPT, not proof: a crop that really vanished (juta, rami)
-- or a policy shock leaves a new stable level too, and the series alone cannot tell it from a
-- change of unit. Read IBGE's notes for the table, then either add the product to the
-- conversion seeds or accept the shift. One row per shift (a clean step at year Y flags the
-- windows at Y-1, Y and Y+1; they are one shift).
--
-- Fails (returns rows) for every shift found.

{{ config(severity='warn') }}

with annual as (

    select 'pam' as banco, tabela, product_code, family, reference_year, sum(qty_base) as qty
    from {{ ref('serving_pam_annual') }}
    where qty_base > 0
    group by tabela, product_code, family, reference_year

    union all

    select 'pevs' as banco, tabela, product_code, family, reference_year, sum(qty_base) as qty
    from {{ ref('serving_pevs_annual') }}
    where qty_base > 0
    group by tabela, product_code, family, reference_year

    union all

    select 'ppm' as banco, tabela, product_code, family, reference_year, sum(qty_base) as qty
    from {{ ref('serving_ppm_annual') }}
    where qty_base > 0
    group by tabela, product_code, family, reference_year

),

windows as (

    -- the six years y-3 .. y+2 around each year, side by side; a series with a gap in that
    -- span has no window there (a gap would fake a shift)
    select
        banco, tabela, product_code, family, reference_year, qty,
        lag(qty, 1) over w as q_m1,
        lag(qty, 2) over w as q_m2,
        lag(qty, 3) over w as q_m3,
        lead(qty, 1) over w as q_p1,
        lead(qty, 2) over w as q_p2,
        lag(reference_year, 3) over w as year_m3,
        lead(reference_year, 2) over w as year_p2
    from annual
    window w as (partition by banco, tabela, product_code, family order by reference_year)

),

medians as (

    -- median of three = greatest(least(a, b), least(greatest(a, b), c))
    select
        banco, tabela, product_code, family, reference_year,
        safe_divide(qty, q_m1) as step,
        greatest(least(q_m3, q_m2), least(greatest(q_m3, q_m2), q_m1)) as before_level,
        greatest(least(qty, q_p1), least(greatest(qty, q_p1), q_p2)) as after_level
    from windows
    where year_m3 = reference_year - 3
      and year_p2 = reference_year + 2

),

flagged as (

    select
        *,
        safe_divide(after_level, before_level) as ratio,
        if(after_level > before_level, 'up', 'down') as direction
    from medians
    where after_level >= 3 * before_level
       or after_level <= before_level / 3

),

runs as (

    -- consecutive flagged years in one direction are ONE shift
    select
        *,
        reference_year
            - row_number() over (
                partition by banco, tabela, product_code, family, direction
                order by reference_year
            ) as run_id
    from flagged

)

select
    banco,
    tabela,
    product_code,
    family,
    direction,
    -- the year of the new level = where the series itself stepped the most inside the run
    array_agg(reference_year order by abs(ln(step)) desc limit 1)[offset(0)] as shift_year,
    array_agg(ratio order by abs(ln(step)) desc limit 1)[offset(0)] as ratio,
    array_agg(before_level order by abs(ln(step)) desc limit 1)[offset(0)] as before_level,
    array_agg(after_level order by abs(ln(step)) desc limit 1)[offset(0)] as after_level,
    min(reference_year) as first_window_year,
    max(reference_year) as last_window_year
from runs
group by banco, tabela, product_code, family, direction, run_id
order by banco, tabela, product_code, shift_year
