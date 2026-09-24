{{ config(materialized='table') }}

-- ────────────────────────────────────────────────────────────────────────────
-- serving_quality_by_source — data_quality_flag breakdown per source.
--
-- Backs the dashboard's quality donut (brief §3.5: id, count, share) for every
-- bank from one tiny pre-counted table, so the UI never scans a Gold fact just to
-- tally flags. `share` sums to 1 within each source.
--
-- `value_share` (v1.56.0) is the same breakdown weighted by MONEY, and it exists
-- because the row count alone reads as alarm. Measured on prod 2026-09-24: PEVS is
-- 81,7% UNSCORED by ROWS and 0,7% by VALUE. Most of the rows the detector skips are
-- numerous and economically negligible: in the IBGE bancos, empty cube cells (SIDRA
-- publishes a `-` row for every município × produto × ano that had no production), and
-- in the trade bancos, shipments under the US$ 100k materiality floor. Showing only the
-- row share tells the researcher the data is two-thirds unexamined, which is true of the
-- ROWS and false of the SUBJECT.
--
-- It is NOT "over 99% of the money in every banco", which is what this header said until
-- v1.89.0. PAM and PPM carry 1974–1979, the years before the IPCA exists, and the detector
-- (which scores on val_real_ipca_brl) cannot examine them. Those rows hold 8,98% of PAM's
-- value and 10,38% of PPM's (measured 2026-09-24), so the money examined there is ~91%
-- and ~90%. See docs/audits/qualidade_dados_audit_2026-09-24.md § A1.
--
-- ── Why the IBGE weight is IGP-DI, not IPCA ─────────────────────────────────
-- The weight has to be a value that EXISTS for every row that has one. Weighting by
-- `coalesce(val_real_ipca_brl, 0)` — the column until v1.89.0 — priced exactly the
-- unexaminable rows at R$ 0, because the reason they are unexaminable is that IPCA does
-- not reach them. The share then said the detector had skipped 0,10% of PAM's money when
-- it had skipped 8,98%: an absence read as zero, in the one number whose job is to say
-- how much went unexamined. IGP-DI (SGS 190) starts in 1944 and covers every valued IBGE
-- row (0 gaps in PAM, PEVS and PPM, measured 2026-09-24). The `coalesce(…, 0)` now only
-- zeroes the herd rows, which are worth nothing here by construction.
--
-- The value column differs per banco (BRL for IBGE, USD for trade) and that is fine:
-- `value_share` is a ratio WITHIN a source, never compared across them. Trade keeps
-- nominal US$: the materiality weight within one source needs no deflation to be a
-- coherent share, and US$ has no pre-1994 hole to fall into.
--
-- Grain: one row per (source, data_quality_flag).
-- ────────────────────────────────────────────────────────────────────────────

with flags as (

    -- `value`: a monetary column that exists for every valued row of the banco (IBGE:
    -- IGP-DI — see the header for why not IPCA). A herd row (PPM stock) has none —
    -- coalesce to 0 so it neither inflates nor breaks the sum; it is genuinely worth
    -- nothing monetarily, which is why it takes the stock branch of the flag.
    select 'ibge_pevs'  as source, data_quality_flag,
           coalesce(val_real_igpdi_brl, 0) as value from {{ ref('gold_pevs_production') }}
        where {{ hidden_code_predicate('pevs', 'product_code') }}
    union all
    select 'ibge_pam'   as source, data_quality_flag,
           coalesce(val_real_igpdi_brl, 0) from {{ ref('gold_pam_production') }}
        where {{ hidden_code_predicate('pam', 'product_code') }}
    union all
    select 'ibge_ppm'   as source, data_quality_flag,
           coalesce(val_real_igpdi_brl, 0) from {{ ref('gold_ppm_production') }}
        where {{ hidden_code_predicate('ppm', 'product_code') }}
    union all
    select 'mdic_comex' as source, data_quality_flag,
           coalesce(val_yearfx_usd, 0) from {{ ref('gold_comex_flows') }}
        where {{ hidden_code_predicate('comex', 'ncm_code') }}
    union all
    select 'un_comtrade' as source, data_quality_flag,
           coalesce(val_yearfx_usd, 0) from {{ ref('gold_comtrade_flows') }}
        where {{ hidden_code_predicate('comtrade', 'cmd_code') }}

)

select
    source,
    data_quality_flag,
    count(*)                                                          as n_rows,
    safe_divide(count(*), sum(count(*)) over (partition by source))   as share,
    -- safe_divide, não `/`: um banco cujo valor total seja zero (um recorte só de
    -- rebanho, por exemplo) devolve NULL — "sem base para a fração" — em vez de
    -- estourar ou fingir 0%.
    safe_divide(sum(value), sum(sum(value)) over (partition by source)) as value_share
from flags
group by source, data_quality_flag
