-- A trade-code description that is still a PLACEHOLDER must not become permanent by being
-- forgotten.
--
-- comex_ncm / comtrade_hs carry the OFFICIAL Portuguese text of each code, taken from MDIC's own
-- tables (NCM.csv / NCM_SH.csv) — never written from memory. Two codes of the fruit scope
-- (laranja / limão / tangerina, 2026-10) are RETIRED NCM/HS codes whose history is in the data
-- but whose official text is not available: the Siscomex API serves only the current table, and
-- MDIC's host (balanca.economia.gov.br) had an expired TLS certificate on 2026-10-21. They carry the
-- parent's official wording plus the marker "texto oficial pendente", which is true and visible.
--
-- This test turns the marker into a worklist: it returns a row per code still marked, and WARNS
-- (never fails — the data is right, only the text is pending). Fix a row by running
-- `make nomenclature-audit` once MDIC answers, replacing the description with NO_NCM_POR /
-- NO_SH6_POR, and dropping the marker; the test then returns nothing.
--
-- Fails (warns) while any description contains the marker.

{{ config(severity='warn') }}

select 'comex' as banco, co_ncm as code, ncm_description as description
from {{ ref('comex_ncm') }}
where ncm_description like '%texto oficial pendente%'

union all

select 'comtrade' as banco, cmd_code as code, description
from {{ ref('comtrade_hs') }}
where description like '%texto oficial pendente%'
