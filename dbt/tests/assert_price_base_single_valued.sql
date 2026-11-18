-- Singular test (v1.105.0): every serving table carries ONE price base per index, on every row.
--
-- The base columns (<index>_base_month, fx_<cur>_base_date) say at which month's prices the
-- val_real columns are, and the BFF reads them back with max() in the SAME select that sums a
-- value — that is what dates the number on screen. max() is only right if there is exactly one
-- value to take: two would mean one table mixes values corrected to two different months, and
-- max() would date the older ones wrong. By construction there is one (Gold cross-joins the
-- one-row latest-reading CTEs of annual_deflation_ctes, and the marts lift it with max()), so
-- this guards the CONSTRUCTION, not the data: a per-year join, or a mart turned incremental,
-- would otherwise break it without a sound.
--
-- NULL is accepted only where the series may legitimately be absent: CPI-U and HICP while the
-- foreign deflators are off (enable_foreign_inflation). IPCA, IGP-M, IGP-DI and both PTAX rates
-- exist in every real build, so a NULL there is a construction defect too — a corrected number
-- reaching the screen with no date. An empty mart (`dbt build --empty`) passes.
--
-- Cost: only the seven DATE columns of each mart are read, no value column — about 160 MB on
-- prod (2,86 mi rows across the six marts on 2026-11-17, 2,55 mi of them serving_comtrade_annual).
--
-- One output row per (mart, base column) that breaks either rule.
--
-- The first set tag below opens WITHOUT the whitespace-stripping dash: with it, the newline
-- that ends the comment line above is stripped, the chain of stripping closers strips the
-- rest, and the select lands inside the comment, leaving a FROM-first query that BigQuery
-- reads as pipe syntax ("WHERE not supported after FROM query"). That is how this test first
-- failed in a dev build (tests/test_dbt_jinja_comment_strip.py). Jinja delimiters are parsed
-- even inside a SQL comment, so none is written out here.
{% set marts = [
    'serving_pevs_annual',
    'serving_pam_annual',
    'serving_ppm_annual',
    'serving_comex_annual',
    'serving_comex_seasonality',
    'serving_comtrade_annual',
] -%}
{%- set columns = [
    'ipca_base_month', 'igpm_base_month', 'igpdi_base_month',
    'cpi_base_month', 'hicp_base_month',
    'fx_usd_base_date', 'fx_eur_base_date',
] -%}
{%- set may_be_null = [] if var('enable_foreign_inflation', false)
                      else ['cpi_base_month', 'hicp_base_month'] -%}

select per_mart.mart, c.base_column, c.n_values, c.n_null
from (
{%- for mart in marts %}
    select
        '{{ mart }}' as mart,
        [
        {%- for col in columns %}
            struct(
                '{{ col }}' as base_column,
                count(distinct {{ col }}) as n_values,
                {{ '0' if col in may_be_null else 'countif(' ~ col ~ ' is null)' }} as n_null
            ){% if not loop.last %},{% endif %}
        {%- endfor %}
        ] as checks
    from {{ ref(mart) }}
    {%- if not loop.last %}
    union all
    {%- endif %}
{%- endfor %}
) as per_mart,
unnest(per_mart.checks) as c
where c.n_values > 1 or c.n_null > 0
