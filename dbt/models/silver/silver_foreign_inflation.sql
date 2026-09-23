{#- `enabled` below is a BUILD-ORDER gate, not a feature switch: this model's Bronze
    source answers 404 until `embrapa ingest foreign-inflation` has run once, and that
    failure would cascade through silver_inflation into every Gold table. The var's
    comment in dbt_project.yml has the four-step turn-on. -#}
{{
    config(
        materialized='table',
        partition_by={'field': 'reference_date', 'data_type': 'date', 'granularity': 'month'},
        cluster_by=['series_code'],
        enabled=var('enable_foreign_inflation', false)
    )
}}

{#-
    The foreign deflators: US CPI-U (BLS) and euro-area HICP (ECB). They answer, for the
    dollar and the euro, the question the BCB series answer for the real — and they are
    the ONLY honest answer for a value the source itself declared in US$, which is what
    every customs row is.

    ── Why this is NOT silver_bcb_inflation with a different filter ────────────────────
    The SGS series are monthly PERCENT CHANGE, chain-linked there into a 100-base index.
    CPI-U and HICP are published as INDEX LEVELS already (CPI-U 1982-84=100, HICP
    2025=100), so chain-linking them would compound a level as if it were a rate and
    produce numbers that look like an index and are not one. The value goes through as
    `index_value` directly.

    The BASE of each level differs (1982-84=100 vs 2025=100) and that is deliberately NOT
    normalised here: every use downstream is a RATIO of two readings of the SAME series
    (index_now / index_then), and a ratio is base-invariant. Rebasing would add an
    arbitrary anchor year with no effect on any number and one more thing to keep in sync.

    `monthly_pct_change` is computed for symmetry with the BCB model (and so an operator
    can eyeball a series), NEVER consumed by the deflation. It is null for each series'
    first month — there is no prior reading to compare against, which is a real absence
    and not a zero.
-#}

{#- Configured provider series ids. Same env_var/config.py NAME coupling the BCB codes
    have: `embrapa doctor` (foreign-inflation-codes) guards the parity. -#}
{%- set _foreign_codes = [
    "'" ~ var('inflation_series_cpi',  'CUUR0000SA0') ~ "'",
    "'" ~ var('inflation_series_hicp', 'HICP.M.U2.N.000000.4D0.INX') ~ "'",
] -%}

with deduplicated as (

    select *
    from {{ source('bronze_foreign', 'inflation_raw') }}
    -- Bronze is APPEND-ONLY, so a series id dropped from the config can still sit there.
    -- Without this filter a retired series would keep feeding a deflator nobody selected.
    -- It is also what made the 2026 move of HICP safe: the ECB froze the ICP dataflow
    -- (2015=100) at 2025-12 and continued the index in HICP (2025=100). Both keys live in
    -- Bronze; only the configured one reaches here, so the two bases never share a
    -- ratio — mixing them would read a 22% deflation into a single month.
    where series_code in ({{ _foreign_codes | join(', ') }})
    qualify row_number() over (
        partition by series_code, reference_date_str
        order by ingestion_timestamp desc
    ) = 1

),

parsed as (

    select
        series_code,
        series_name,
        -- The publisher, as STORED by the ingest. Never inferred from the series id: a
        -- second US or euro-area index (core CPI, HICP ex-energy) would break any
        -- pattern the moment it arrived.
        provider,
        economy,
        safe.parse_date('%d/%m/%Y', reference_date_str)   as reference_date,
        {{ safe_numeric('value_str') }}                   as index_value,
        ingestion_timestamp
    from deduplicated
    where safe.parse_date('%d/%m/%Y', reference_date_str) is not null

),

observed as (

    select
        series_code,
        series_name,
        provider,
        economy,
        reference_date,
        index_value,
        ingestion_timestamp
    from parsed
    where
        index_value is not null
        -- A price index is strictly positive. A zero would divide the deflation by zero
        -- (safe_divide saves the query, not the reading) and a negative one is a parse
        -- error.
        and index_value > 0

),

{# A month the PUBLISHER never released — not one we failed to fetch. BLS shows '-' for
    CPI-U October 2025 (no prices were collected during the US federal shutdown), and a
    hole there breaks two things: `assert_foreign_inflation_no_month_gaps` fails, which
    in `dbt build` skips every Gold model, and COMEX's monthly deflation leaves Oct/2025
    unvalued, so serving_comex_annual would sum 11 months of 2025 and present them as
    the year (~8% short, with nothing on screen to say so).

    The month is filled with the GEOMETRIC mean of its two published neighbours — the
    midpoint of the log-linear path between them, i.e. the month-over-month inflation
    split evenly across the two months. Three rules keep it an estimate of a point and
    not a licence to paper over holes:
      * only months DECLARED in the `foreign_inflation_publisher_gaps` seed, each with
        its reason — an undeclared hole (an ingest that lost a month) still fails the
        gap test, which is that test's whole job;
      * only a SINGLE missing month (the neighbours exactly two months apart) — bridging
        a longer run would be estimating a trend, and has to be a new decision;
      * a published value always wins: if the publisher later releases the month, the
        observation replaces the estimate on the next build.
    Every filled row says so in `is_interpolated`. -#}
declared_gaps as (

    select
        series_code,
        cast(reference_date as date) as reference_date
    from {{ ref('foreign_inflation_publisher_gaps') }}

),

gap_neighbours as (

    select
        declared_gaps.series_code,
        declared_gaps.reference_date,
        max(
            if(observed.reference_date < declared_gaps.reference_date, observed.reference_date, null)
        ) as prev_date,
        min(
            if(observed.reference_date > declared_gaps.reference_date, observed.reference_date, null)
        ) as next_date
    from declared_gaps
    inner join observed
        on declared_gaps.series_code = observed.series_code
    group by declared_gaps.series_code, declared_gaps.reference_date

),

interpolated as (

    select
        gap_neighbours.series_code,
        prev_obs.series_name,
        prev_obs.provider,
        prev_obs.economy,
        gap_neighbours.reference_date,
        sqrt(prev_obs.index_value * next_obs.index_value) as index_value,
        greatest(prev_obs.ingestion_timestamp, next_obs.ingestion_timestamp) as ingestion_timestamp
    from gap_neighbours
    inner join observed as prev_obs
        on
            gap_neighbours.series_code = prev_obs.series_code
            and gap_neighbours.prev_date = prev_obs.reference_date
    inner join observed as next_obs
        on
            gap_neighbours.series_code = next_obs.series_code
            and gap_neighbours.next_date = next_obs.reference_date
    left join observed as published
        on
            gap_neighbours.series_code = published.series_code
            and gap_neighbours.reference_date = published.reference_date
    where
        date_diff(gap_neighbours.next_date, gap_neighbours.prev_date, month) = 2
        and published.series_code is null

),

combined as (

    select
        series_code,
        series_name,
        provider,
        economy,
        reference_date,
        index_value,
        ingestion_timestamp,
        false as is_interpolated
    from observed

    union all

    select
        series_code,
        series_name,
        provider,
        economy,
        reference_date,
        index_value,
        ingestion_timestamp,
        true as is_interpolated
    from interpolated

)

select
    series_code,
    series_name,
    provider,
    economy,
    reference_date,
    extract(year from reference_date) as reference_year,
    extract(month from reference_date) as reference_month,
    -- Derived for symmetry/inspection only — the deflation reads index_value.
    100.0 * safe_divide(
        index_value - lag(index_value) over (partition by series_code order by reference_date),
        lag(index_value) over (partition by series_code order by reference_date)
    ) as monthly_pct_change,
    index_value,
    ingestion_timestamp,
    is_interpolated
from combined
