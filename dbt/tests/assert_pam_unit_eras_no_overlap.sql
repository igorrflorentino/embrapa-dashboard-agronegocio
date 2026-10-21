-- Fan-out guard for the PAM count→weight seed.
--
-- silver_ibge_pam converts the quantity and yield of a fruit that was counted before 2001
-- via a date-aware LEFT JOIN:
--   on ue.product_code = p.product_code
--   and p.reference_year between ue.year_from and ue.year_to
-- If two rows of the SAME product had overlapping year ranges that join would match twice
-- and DUPLICATE every row of those years — and, worse, would apply two different weights
-- per fruit to one number. Same invariant, same shape as assert_currency_factor_no_overlap.
--
-- Fails (returns rows) if any overlap exists.
select
    a.product_code,
    a.year_from as a_year_from,
    a.year_to   as a_year_to,
    b.year_from as b_year_from,
    b.year_to   as b_year_to
from {{ ref('pam_fruit_unit_eras') }} a
join {{ ref('pam_fruit_unit_eras') }} b
    on a.product_code = b.product_code
   and a.year_from <= b.year_to
   and b.year_from <= a.year_to
   -- each unordered pair once, a row never against itself; ordering on the full
   -- (year_from, year_to) tuple also catches a same-start / different-end overlap.
   and (a.year_from < b.year_from
        or (a.year_from = b.year_from and a.year_to < b.year_to))
