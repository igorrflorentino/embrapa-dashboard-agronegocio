{{
    config(
        materialized='table',
        partition_by={'field': 'reference_date', 'data_type': 'date', 'granularity': 'month'},
        cluster_by=['series_code']
    )
}}

{#-
    Stays materialized=table (not incremental) because the chain-linked
    `index_value` uses `sum(log(1+x/100)) over (... rows unbounded preceding)`,
    which is only correct when the window scans the full series. A partition-
    overwrite incremental would silently break the chain for unaffected months.
    The table is small (~2k rows) so the full rebuild cost is negligible.

    Surfaces ONLY the SGS inflation series the config currently pulls — IPCA / IGP-M /
    IGP-DI — by filtering series_code to the three `inflation_series_*` vars (mirrors
    BCB_INFLATION_SERIES / config.py and the Gold deflation pivot). Bronze is APPEND-ONLY,
    so a code dropped from the config can still sit in Bronze; without this filter that
    stale series would leak into the chain index. Symmetric with silver_bcb_currency.
    Keep in sync with config.py's bcb_inflation_series.
-#}

{#- Configured SGS inflation series codes (IPCA 433, IGP-M 189, IGP-DI 190 by default). -#}
{%- set _inflation_codes = [
    "'" ~ var('inflation_series_ipca',  '433') ~ "'",
    "'" ~ var('inflation_series_igpm',  '189') ~ "'",
    "'" ~ var('inflation_series_igpdi', '190') ~ "'",
] -%}

with deduplicated as (

    select *
    from {{ source('bronze_bcb', 'inflation_raw') }}
    where series_code in ({{ _inflation_codes | join(', ') }})
    qualify row_number() over (
        partition by series_code, reference_date_str
        order by ingestion_timestamp desc
    ) = 1

),

parsed as (

    select
        series_code,
        series_name,
        safe.parse_date('%d/%m/%Y', reference_date_str)   as reference_date,
        {{ safe_numeric('value_str') }}                   as monthly_pct_change,
        ingestion_timestamp
    from deduplicated
    where safe.parse_date('%d/%m/%Y', reference_date_str) is not null

)

-- Chain-link the monthly % changes into a 100-base number index.
-- This index captures pure REAL inflation only — it does NOT absorb the
-- Brazilian currency reforms (Cz$→NCz$→Cr$→CR$→R$) because those reforms
-- divided the currency without changing purchasing power, so the SGS 433
-- monthly variation series shows no spike at reform dates. Nominal historical
-- values therefore must be converted to BRL via the
-- `historical_currency_factors` seed BEFORE this index is applied for
-- inflation correction in Gold.
select
    series_code,
    series_name,
    -- Who published it, and whose prices it measures. Constants here (every row in this
    -- model is a BCB SGS series about Brazilian prices), but PRESENT so this model and
    -- silver_foreign_inflation are column-identical and `silver_inflation` can union
    -- them. The economy is what makes an index usable as a DEFLATOR rather than just a
    -- series: it says which money this index corrects.
    'bcb-sgs'                          as provider,
    'BR'                               as economy,
    reference_date,
    extract(year  from reference_date) as reference_year,
    extract(month from reference_date) as reference_month,
    monthly_pct_change,
    100.0 * exp(
        sum(safe.log(1.0 + monthly_pct_change / 100.0)) over (
            partition by series_code
            order by reference_date
            rows between unbounded preceding and current row
        )
    ) as index_value,
    ingestion_timestamp
from parsed
where monthly_pct_change is not null
