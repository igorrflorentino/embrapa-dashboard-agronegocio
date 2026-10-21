-- A PAM product is EITHER counted in every year (pam_count_unit_products: abacaxi, coco-da-baía)
-- OR counted until 2000 and weighed since (pam_fruit_unit_eras: IBGE's 17 fruits, e.g. laranja,
-- limão, tangerina, banana) — never both. In both seeds, silver_ibge_pam would multiply the same quantity by a
-- weight per fruit AND relabel it a count: two corrections of one number, with a result nobody
-- could explain.
--
-- Fails (returns rows) for any product_code present in both seeds.
select
    c.product_code
from {{ ref('pam_count_unit_products') }} c
join {{ ref('pam_fruit_unit_eras') }} e
    on c.product_code = e.product_code
