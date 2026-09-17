{{ config(materialized='view') }}

-- ────────────────────────────────────────────────────────────────────────────
-- gold_source_metadata — per-source provenance for the frontend's metadata seam.
--
-- The dashboard reads ALL bank provenance from the backend (dataStore.meta(id) →
-- bancoMeta(id)), never from frontend literals: table name, cadence, coverage,
-- counters and freshness. This view DERIVES them from the Gold fact tables, so a
-- table rename / new cadence / extended coverage / fresh load propagates to the
-- whole UI (hero, Sobre, Saúde, freshness banner) with nothing diverging from the
-- real data. last_refresh doubles as the goldVersion timestamp (isStale).
--
-- One row per source. A view (not a table) so it always reflects the current Gold.
-- NOT here (runtime config, see docs/frontend_data_contract.md): implStatus /
-- visible / preview, and SEFAZ (no Gold table yet → implStatus 'um_dia').
-- ────────────────────────────────────────────────────────────────────────────

select
    'ibge_pevs'                    as source,
    'gold_pevs_production'         as gold_table,
    'annual'                       as cadence,
    min(reference_year)            as year_start,
    max(reference_year)            as year_end,
    count(*)                       as total_rows,
    count(distinct product_code)   as products_total,
    -- real Brazilian UFs only — exclude special trade codes (EX/ND/ZN/MN/RE…),
    -- which have no state_name from the state lookup
    count(distinct case when state_name is not null then state_acronym end) as ufs_total,
    max(last_refresh)              as last_refresh,
    -- The END of the newest reference PERIOD, as a date. year_end alone cannot express
    -- a monthly source's staleness: a COMEX that stopped publishing in March still
    -- reports year_end = that year, so a year-granular check could not notice for
    -- 13 to 24 months. Annual sources close on 31/12; COMEX closes on its newest month.
    date(max(reference_year), 12, 31) as period_end
from {{ ref('gold_pevs_production') }}
-- F7 visibility gate: exclude products a researcher marked "indisponível" so the "acervo"
-- counters (total_rows / products_total) a researcher SEES (ViewHealth, chip fallbacks) match
-- the gated marts. Isolated from the admin editor, which reads Gold ungated. NO-OP until hidden.
where {{ hidden_code_predicate('pevs', 'product_code') }}
having count(*) > 0   -- an empty source emits no metadata row (NULL coverage would fail not_null)

union all

select
    'ibge_pam'                     as source,
    'gold_pam_production'          as gold_table,
    'annual'                       as cadence,
    min(reference_year)            as year_start,
    max(reference_year)            as year_end,
    count(*)                       as total_rows,
    count(distinct product_code)   as products_total,
    count(distinct case when state_name is not null then state_acronym end) as ufs_total,
    max(last_refresh)              as last_refresh,
    date(max(reference_year), 12, 31) as period_end
from {{ ref('gold_pam_production') }}
where {{ hidden_code_predicate('pam', 'product_code') }}
having count(*) > 0

union all

select
    'ibge_ppm'                     as source,
    'gold_ppm_production'          as gold_table,
    'annual'                       as cadence,
    min(reference_year)            as year_start,
    max(reference_year)            as year_end,
    count(*)                       as total_rows,
    count(distinct product_code)   as products_total,
    count(distinct case when state_name is not null then state_acronym end) as ufs_total,
    max(last_refresh)              as last_refresh,
    date(max(reference_year), 12, 31) as period_end
from {{ ref('gold_ppm_production') }}
where {{ hidden_code_predicate('ppm', 'product_code') }}
having count(*) > 0

union all

select
    'mdic_comex',
    'gold_comex_flows',
    'monthly',
    min(reference_year),
    max(reference_year),
    count(*),
    count(distinct ncm_code),
    count(distinct case when state_name is not null then state_acronym end),
    max(last_refresh),
    last_day(max(reference_date))  -- monthly: the newest month, closed
from {{ ref('gold_comex_flows') }}
where {{ hidden_code_predicate('comex', 'ncm_code') }}
having count(*) > 0

union all

select
    'un_comtrade',
    'gold_comtrade_flows',
    'annual',
    min(reference_year),
    max(reference_year),
    count(*),
    count(distinct cmd_code),
    cast(null as int64),           -- COMTRADE has no Brazilian UF (country↔country)
    max(last_refresh),
    date(max(reference_year), 12, 31)
from {{ ref('gold_comtrade_flows') }}
where {{ hidden_code_predicate('comtrade', 'cmd_code') }}
having count(*) > 0
