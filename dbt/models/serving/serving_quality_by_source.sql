{{ config(materialized='table') }}

-- ────────────────────────────────────────────────────────────────────────────
-- serving_quality_by_source — data_quality_flag breakdown per source.
--
-- Backs the dashboard's quality donut (brief §3.5: id, count, share) for every
-- bank from one tiny pre-counted table, so the UI never scans a Gold fact just to
-- tally flags. `share` sums to 1 within each source.
--
-- `value_share` (v1.56.0) is the same breakdown weighted by MONEY, and it exists
-- because the row count alone reads as alarm. Measured on prod 2026-09-07: PEVS is
-- 81,6% UNSCORED by ROWS and 0,7% by VALUE — the detector examines over 99% of the
-- money in every banco. The rows it skips are numerous and economically negligible:
-- in the IBGE bancos they are empty cube cells (SIDRA publishes a `-` row for every
-- município × produto × ano that had no production — 20,4M of them in PAM alone), and
-- in the trade bancos they are shipments under the US$ 100k materiality floor (98,8%
-- of COMEX's unscored rows). Showing only the row share tells the researcher the data
-- is two-thirds unexamined, which is true of the ROWS and false of the SUBJECT.
--
-- The value column differs per banco (BRL for IBGE, USD for trade) and that is fine:
-- `value_share` is a ratio WITHIN a source, never compared across them.
--
-- Grain: one row per (source, data_quality_flag).
-- ────────────────────────────────────────────────────────────────────────────

with flags as (

    -- `value`: the banco's own canonical monetary column. A herd row (PPM stock) has
    -- none — coalesce to 0 so it neither inflates nor breaks the sum; it is genuinely
    -- worth nothing monetarily, which is why it takes the stock branch of the flag.
    select 'ibge_pevs'  as source, data_quality_flag,
           coalesce(val_real_ipca_brl, 0) as value from {{ ref('gold_pevs_production') }}
        where {{ hidden_code_predicate('pevs', 'product_code') }}
    union all
    select 'ibge_pam'   as source, data_quality_flag,
           coalesce(val_real_ipca_brl, 0) from {{ ref('gold_pam_production') }}
        where {{ hidden_code_predicate('pam', 'product_code') }}
    union all
    select 'ibge_ppm'   as source, data_quality_flag,
           coalesce(val_real_ipca_brl, 0) from {{ ref('gold_ppm_production') }}
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
