{# Shared inflation-index + FX CTEs for the annual deflation pipeline.

   These four CTEs (inflation_year_avg, inflation_latest, fx_year, fx_latest) were
   copy-pasted byte-for-byte into gold_pevs_production, gold_pam_production,
   gold_ppm_production and gold_comtrade_flows. Verified identical: the COMPILED SQL of
   this block is byte-for-byte equal across all four models (only comment wording
   differed). Centralised here so a change to the deflation convention — e.g. the 1994
   Plano Real FX changeover guard — lands in ONE place instead of four hand-maintained
   copies that could silently drift into inconsistent val_real_* / val_yearfx_* NUMBERS
   (DEDUP-1).

   Reads only silver_inflation (the BCB indices and the foreign ones, unioned) +
   silver_currency. The downstream `enriched` real_* expressions that CONSUME these stay
   PER-MODEL — they genuinely differ (val_raw for the IBGE production marts vs
   primary_value_usd * brl_per_usd_avg for the COMTRADE flow mart), so they are
   intentionally NOT part of this macro.

   Emits the four CTE definitions WITHOUT a trailing comma; the caller adds the `,` before
   its own `enriched as (...)` CTE.

   WHICH INDEX DEFLATES A YEAR: the MEAN of the year's twelve monthly indices (v1.103.0; until
   then it was the DECEMBER index). An annual value is a FLOW accrued through the year, so its
   price level is the year's mean, not December's. If the real volume is the same every month
   the nominal value of each month is proportional to that month's index, the year sums to
   q × Σ index, and the real value is `sum ÷ mean index`. December and the mean coincide when
   inflation is low and part ways in hyperinflation: IGP-DI December ÷ mean is 3.2 in 1993 and
   3.5 in 1989, and mostly 0.99-1.05 from 1995 on with peaks of 1.17 (2002) and 1.13 (2020)
   (docs/audits/deflacao_indice_medio_2026-10-21.md). Under the December rule every pre-1995
   corrected value was understated by that factor and the deflated price of EVERY IBGE product
   jumped ×2-4 between 1993 and 1994.
   ONE rule for the five series (IPCA, IGP-M, IGP-DI, CPI-U, HICP): a single sentence to state
   and to defend. CPI-U and HICP move at most 3.2% with it, with no visible defect to justify a
   separate rule. COMEX is monthly and deflates by its OWN month's index (gold_comex_flows).
   A year is deflated only when its index covers all 12 months, except the LAST year of that
   series, which is still open and uses the mean of the months present. A series that starts
   mid-year (IGP-M, 1989-06) therefore has no corrected value for that first year — IGP-M
   starts in 1990 — instead of a mean over the part of the year it covers; the gap shows on
   screen by itself, because `valueGap` is measured on the data, not on the index's first year.
   Internal month gaps are guarded by assert_inflation_series_no_month_gaps and
   assert_foreign_inflation_no_month_gaps.

   THE PRICE BASE (v1.105.0): every val_real column is expressed at the price level of its
   index's LATEST month — that is what "corrected" means here, and the month floats with every
   build. Until v1.105.0 the month was used and then thrown away, so the screen said "em reais
   de hoje" with no date while every corrected number moved by each new month's inflation
   (2026-11-17: Sep → Oct moved every IPCA value by +0.14%, silently). `inflation_latest_cte`
   and `fx_latest_cte` now also return the DATE of the reading they use, and each Gold carries
   it as constant columns (`<index>_base_month`, `fx_<cur>_base_date`) so the base a researcher
   reads travels in the same row — and later the same SELECT — as the number it describes.
   It is never computed at compile time: a month in the compiled SQL or in a persisted
   description would change the build fingerprint every time new data lands. #}
{%- macro annual_deflation_ctes() -%}
inflation_year_avg as (

    select
        reference_year,
        max(case when series_code = '{{ var("inflation_series_ipca")  }}' then index_value end) as ipca_year_avg,
        max(case when series_code = '{{ var("inflation_series_igpm")  }}' then index_value end) as igpm_year_avg,
        max(case when series_code = '{{ var("inflation_series_igpdi") }}' then index_value end) as igpdi_year_avg,
        -- The FOREIGN deflators. Same pivot, same yearly-mean rule, different question:
        -- these correct a dollar by US prices and a euro by euro-area prices, which is
        -- what a value denominated in those currencies actually needs. A Brazilian
        -- index can only ever say what something is worth in R$ — expressing that in
        -- US$ afterwards changes the symbol, not the price level it was measured at.
        max(case when series_code = '{{ var("inflation_series_cpi")   }}' then index_value end) as cpi_year_avg,
        max(case when series_code = '{{ var("inflation_series_hicp")  }}' then index_value end) as hicp_year_avg
    from (
        select reference_year, series_code, avg(index_value) as index_value
        from (
            select
                reference_year,
                reference_month,
                series_code,
                index_value,
                -- the series' own last year: still open, so it may be partial
                max(reference_year) over (partition by series_code) as series_last_year
            from {{ ref('silver_inflation') }}
            where index_value is not null
        )
        group by reference_year, series_code, series_last_year
        having count(distinct reference_month) = 12
            or reference_year = series_last_year
    )
    group by reference_year

),

{{ inflation_latest_cte() }},

fx_year as (

    select
        reference_year,
        avg(case when currency = 'USD' then brl_per_foreign_unit end) as brl_per_usd_avg,
        -- The euro did not exist before 1999-01-01, so a pre-1999 "year-average EUR" is
        -- spurious (a lone backfilled 1998-12-31 PTAX fixing would otherwise leak a
        -- val_yearfx_eur for 1998, contradicting the EUR-pre-1999→NULL contract). NULL it
        -- at the source so every gold's val_yearfx_eur is NULL before 1999.
        avg(case when currency = 'EUR' and reference_year >= 1999
                 then brl_per_foreign_unit end) as brl_per_eur_avg
    from {{ ref('silver_currency') }}
    where brl_per_foreign_unit is not null
        -- 1994 changeover (Plano Real, 1994-07-01): PTAX before that date is
        -- CR$/unit (Cruzeiro Real, ~450-2750 per US$); from it, R$/unit (~0.85).
        -- A whole-1994 average would mix the two scales and corrupt the 1994
        -- val_yearfx_* by ~3 orders of magnitude, so 1994 averages only the R$
        -- half. Pre-1994 years keep their old-currency averages — the
        -- `reference_year >= 1994` guard below nulls those columns anyway.
        and (reference_year != 1994 or reference_date >= date(1994, 7, 1))
    group by reference_year

),

{{ fx_latest_cte() }}
{%- endmacro -%}


{#- The latest reading of each index: the NUMERATOR of every val_real column, and its price
    base. Shared by the four annual Gold models (through annual_deflation_ctes) and by
    gold_comex_flows, which deflates by its own month's index but brings it to the same
    latest reading — one definition, so "the base" cannot mean two things in two tables.
    Emits ONE CTE without a trailing comma. -#}
{%- macro inflation_latest_cte() -%}
inflation_latest as (

    select
        max(case when series_code = '{{ var("inflation_series_ipca")  }}' then index_value end) as ipca_current,
        max(case when series_code = '{{ var("inflation_series_igpm")  }}' then index_value end) as igpm_current,
        max(case when series_code = '{{ var("inflation_series_igpdi") }}' then index_value end) as igpdi_current,
        -- Each series' OWN latest reading, not a shared cut-off date: CPI-U, HICP and
        -- the SGS indices publish on different calendars, so forcing one common month
        -- would throw away a month of whichever published first — and, worse, make the
        -- price base of one convention differ from its own latest ingested data.
        max(case when series_code = '{{ var("inflation_series_cpi")   }}' then index_value end) as cpi_current,
        max(case when series_code = '{{ var("inflation_series_hicp")  }}' then index_value end) as hicp_current,
        -- THE PRICE BASE: the month of the reading above, per series — the month every
        -- val_real column of that index is expressed in ("a preços de outubro de 2026").
        -- Same row as the index value, so it cannot disagree with the number it dates.
        -- NULL when the series has no rows (e.g. enable_foreign_inflation off): an
        -- absent base is never replaced by a guessed month downstream.
        date_trunc(max(case when series_code = '{{ var("inflation_series_ipca")  }}' then reference_date end), month) as ipca_base_month,
        date_trunc(max(case when series_code = '{{ var("inflation_series_igpm")  }}' then reference_date end), month) as igpm_base_month,
        date_trunc(max(case when series_code = '{{ var("inflation_series_igpdi") }}' then reference_date end), month) as igpdi_base_month,
        date_trunc(max(case when series_code = '{{ var("inflation_series_cpi")   }}' then reference_date end), month) as cpi_base_month,
        date_trunc(max(case when series_code = '{{ var("inflation_series_hicp")  }}' then reference_date end), month) as hicp_base_month
    from (
        select series_code, index_value, reference_date
        from {{ ref('silver_inflation') }}
        where index_value is not null
        qualify row_number() over (
            partition by series_code
            order by reference_date desc
        ) = 1
    )

)
{%- endmacro -%}


{#- The latest PTAX rate per currency — what the cross columns (val_real_{ipca,igpm,igpdi}_
    {usd,eur}: deflated in R$, then converted) divide by — and the DAY of that rate. The
    own-currency columns (CPI · HICP) convert at the year's rate and never read this.
    Emits ONE CTE without a trailing comma. -#}
{%- macro fx_latest_cte() -%}
fx_latest as (

    select
        max(case when currency = 'USD' then brl_per_foreign_unit end) as brl_per_usd_current,
        max(case when currency = 'EUR' then brl_per_foreign_unit end) as brl_per_eur_current,
        max(case when currency = 'USD' then reference_date end)       as fx_usd_base_date,
        max(case when currency = 'EUR' then reference_date end)       as fx_eur_base_date
    from (
        select currency, brl_per_foreign_unit, reference_date
        from {{ ref('silver_currency') }}
        where brl_per_foreign_unit is not null
        qualify row_number() over (
            partition by currency
            order by reference_date desc
        ) = 1
    )

)
{%- endmacro -%}
