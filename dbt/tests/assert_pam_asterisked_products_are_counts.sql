-- SIDRA marks, in the product NAME, the PAM products IBGE counts in "mil frutos" in EVERY year:
-- "Abacaxi*" and "Coco-da-baía*" — and only those two of the 86 products of table 5457 (measured
-- 2026-10-21). The unit label of every product says "Toneladas", so the asterisk is the only
-- machine-readable sign, and IBGE's own note says the same two "continuam a ser pesquisados por
-- unidade (mil frutos)".
--
-- A product with an asterisk that is NOT in pam_count_unit_products would publish a fruit COUNT as
-- tonnes, with no warning anywhere: the price detector tolerates 100x and the labels agree. Unlike
-- assert_pam_quantity_no_unit_cliff this needs no threshold, so it does not depend on how big the
-- break happens to be.
--
-- ERROR, not warn: the cost of a false alarm is one seed row, and the cost of a miss is a wrong
-- number nobody sees. If IBGE ever uses the asterisk for something else, the failure names the
-- product and the call is a human's.
--
-- Reads only the last four reference years: the name carries the asterisk in every year, and the
-- table is partitioned by reference_year, so this scans a few partitions, not the whole history.
--
-- Fails (returns rows) for every asterisked product that is not declared a count.

select distinct
    product_code,
    product_description
from {{ ref('silver_ibge_pam') }}
where reference_year >= extract(year from current_date()) - 3
  and product_description like '%*'
  and product_code not in (select product_code from {{ ref('pam_count_unit_products') }})
