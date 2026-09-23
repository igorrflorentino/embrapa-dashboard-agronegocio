{{ config(materialized='view') }}

{#-
    Unified inflation source the Gold deflation reads: the Brazilian indices from BCB SGS
    (IPCA · IGP-M · IGP-DI) and the foreign ones from their own publishers (US CPI-U from
    BLS, euro-area HICP from the ECB). A thin view so the Gold deflation CTEs have ONE
    `(series_code, series_name, provider, economy, reference_date, reference_year,
    reference_month, monthly_pct_change, index_value, ingestion_timestamp,
    is_interpolated)` source for every deflator, exactly as `silver_currency` does for
    every FX rate.

    The two halves reach the same shape by different routes and that difference stays
    upstream: SGS publishes monthly % change (chain-linked into an index there), the
    foreign publishers publish index levels (used directly). By the time a row is here,
    `index_value` means the same thing in both — a price level whose RATIO between two
    dates is the correction factor. The bases differ (IPCA's chain starts at 100 in its
    first month, CPI-U is 1982-84=100, HICP 2025=100) and must never be compared across
    series; a ratio within one series is base-invariant, which is the only use there is.

    `economy` is the column that makes the pairing checkable: an index may only deflate
    the money of the economy it measures. Nothing here enforces that — the pairing lives
    in the Gold column NAMES (val_real_cpi_usd, val_real_hicp_eur) and in the BFF's
    convention model — but a row carrying its economy is what lets an audit ask.

    `is_interpolated` travels here so the one deflator table a researcher can CONSULT
    ("Referências" → "Deflatores, todos") says which reading is an estimate. Today that is
    one row — CPI-U 2025-10, which BLS never published (see silver_foreign_inflation) — and
    without the column the estimate would be disclosed only in a seed a reader has no
    reason to open. The BCB half is published readings only, hence the literal FALSE.

    Explicit column list, not `select *` from each half: a `union all` by position over
    two models maintained apart is the shape that silently shuffles values between
    fields rather than failing.

    The foreign half is behind `enable_foreign_inflation` — a BUILD-ORDER gate (its
    Bronze source 404s until the first ingest), not a feature switch. With it off this
    view is exactly the BCB half, so the shape of everything downstream, including the
    Gold val_real_{cpi,hicp}_* columns, is unchanged; the pivot just finds no rows and
    those columns come out NULL. See dbt_project.yml for the turn-on sequence.
-#}

select
    series_code,
    series_name,
    provider,
    economy,
    reference_date,
    reference_year,
    reference_month,
    monthly_pct_change,
    index_value,
    ingestion_timestamp,
    false as is_interpolated
from {{ ref('silver_bcb_inflation') }}
{#- Whitespace control on BOTH tags, and not for tidiness. What SQLFluff lints is the
    COMPILED output, not this file, and a bare `{% if %}` leaves the removed block's
    newlines behind: with the gate off the compiled SQL would end in a blank line, unlike
    every other model here, which is what LT12 (exactly one trailing newline) measures.
    `{%- if %}` … `{%- endif %}` makes both branches end exactly as silver_currency does. -#}
{%- if var('enable_foreign_inflation', false) %}

union all

select
    series_code,
    series_name,
    provider,
    economy,
    reference_date,
    reference_year,
    reference_month,
    monthly_pct_change,
    index_value,
    ingestion_timestamp,
    is_interpolated
from {{ ref('silver_foreign_inflation') }}
{%- endif %}
