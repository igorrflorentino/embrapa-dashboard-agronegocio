{{ config(enabled=var('enable_foreign_inflation', false)) }}
-- Rides the same build-order gate as the model it tests: with the foreign
-- deflators off, silver_foreign_inflation does not exist to be tested.
-- Deflator continuity guard for silver_foreign_inflation.
--
-- The sibling guard on silver_bcb_inflation protects a CHAIN: a missing month there
-- makes the cumulative product treat two non-adjacent months as adjacent, and the error
-- compounds forever after. These series carry index LEVELS, so a gap does not corrupt
-- the neighbours — but it still changes the answer, in a way that is harder to see. The
-- Gold deflates a year by the MEAN of its twelve monthly indices, and only for a year that
-- has all twelve (annual_deflation_ctes): a year with a hole inside it therefore silently
-- loses its corrected value (NULL in val_real_cpi_usd / val_real_hicp_eur) instead of being
-- deflated from a different part of the year than every other year it is compared to — which
-- is what the previous December rule did, deflating a year missing December by, say, its
-- September reading. A declared publisher gap (seed foreign_inflation_publisher_gaps) is
-- filled in Silver precisely so this does not happen; an UNdeclared one fails here.
--
-- A gap BEFORE a series begins is not a gap: this only looks between consecutive
-- observations that both exist, so HICP starting in 1996 is invisible here (the absence
-- of 1974-1995 is reported to the researcher by the value-gap note instead).
with ordered as (
    select
        series_code,
        reference_date,
        lag(reference_date) over (
            partition by series_code
            order by reference_date
        ) as prev_date
    from {{ ref('silver_foreign_inflation') }}
)
select
    series_code,
    prev_date,
    reference_date,
    date_diff(reference_date, prev_date, month) as month_gap
from ordered
where prev_date is not null
  and date_diff(reference_date, prev_date, month) > 1
