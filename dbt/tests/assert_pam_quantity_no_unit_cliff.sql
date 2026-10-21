-- Unit-break detector for PAM quantities: a product whose NATIONAL quantity jumps by 4x or
-- more between two consecutive years almost certainly changed UNIT inside the series, not
-- production.
--
-- Why this exists: SIDRA table 5457 labels every quantity "Toneladas", and the label is not
-- evidence. Until 2000 IBGE counted the citrus fruits and the banana (mil frutos / mil
-- cachos) and never back-converted the table, so laranja fell x0.16 and banana jumped x10.9
-- between 2000 and 2001. Nothing downstream could see it: the price detector tolerates
-- a 100x implied price, and the labels agreed. Banana was in production with that cliff
-- until this test and the seed pam_fruit_unit_eras were written (found 2026-10-20 while
-- adding laranja, limão and tangerina).
--
-- Calibration, measured on the 14 PAM products over 1974-2024 (national series, SIDRA API):
-- the largest REAL year-over-year swing was cafe 1975->76 at 0.30x (the 1975 frost; 3.3x
-- inverted) and castanha-de-caju 2011->12 at 0.35x (drought). The unit breaks were 0.12x-0.19x
-- and 10.9x. 4x separates the two groups with margin on both sides.
--
-- WARN, not error: a real shock can still trip it (a new crop starting from a small base, a
-- frost, a drought). The row is a prompt to look — and to decide whether the product belongs
-- in pam_fruit_unit_eras — not proof of an error. It is evaluated AFTER the conversion, so
-- a product already declared there does not trip it.
--
-- Fails (returns rows) for every product-year pair that breaches the 4x band.

{{ config(severity='warn') }}

with national as (

    select
        product_code,
        reference_year,
        sum(qty_base) as qty
    from {{ ref('gold_pam_production') }}
    where family = 'massa'
      and qty_base > 0
    group by product_code, reference_year

),

steps as (

    select
        product_code,
        reference_year,
        qty,
        lag(qty)            over (partition by product_code order by reference_year) as prev_qty,
        lag(reference_year) over (partition by product_code order by reference_year) as prev_year
    from national

)

select
    product_code,
    prev_year,
    reference_year,
    prev_qty,
    qty,
    safe_divide(qty, prev_qty) as ratio
from steps
where prev_year = reference_year - 1   -- consecutive years only; a gap is not a step
  and (qty >= 4 * prev_qty or qty <= prev_qty / 4)
