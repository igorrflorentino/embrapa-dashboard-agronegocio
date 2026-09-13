{# Shared inflation-index + FX CTEs for the annual deflation pipeline.

   These four CTEs (inflation_year_end, inflation_latest, fx_year, fx_latest) were
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
   its own `enriched as (...)` CTE. #}
{%- macro annual_deflation_ctes() -%}
inflation_year_end as (

    select
        reference_year,
        max(case when series_code = '{{ var("inflation_series_ipca")  }}' then index_value end) as ipca_year_end,
        max(case when series_code = '{{ var("inflation_series_igpm")  }}' then index_value end) as igpm_year_end,
        max(case when series_code = '{{ var("inflation_series_igpdi") }}' then index_value end) as igpdi_year_end,
        -- The FOREIGN deflators. Same pivot, same year-end rule, different question:
        -- these correct a dollar by US prices and a euro by euro-area prices, which is
        -- what a value denominated in those currencies actually needs. A Brazilian
        -- index can only ever say what something is worth in R$ — expressing that in
        -- US$ afterwards changes the symbol, not the price level it was measured at.
        max(case when series_code = '{{ var("inflation_series_cpi")   }}' then index_value end) as cpi_year_end,
        max(case when series_code = '{{ var("inflation_series_hicp")  }}' then index_value end) as hicp_year_end
    from (
        select reference_year, series_code, index_value
        from {{ ref('silver_inflation') }}
        where index_value is not null
        qualify row_number() over (
            partition by reference_year, series_code
            order by reference_month desc
        ) = 1
    )
    group by reference_year

),

inflation_latest as (

    select
        max(case when series_code = '{{ var("inflation_series_ipca")  }}' then index_value end) as ipca_current,
        max(case when series_code = '{{ var("inflation_series_igpm")  }}' then index_value end) as igpm_current,
        max(case when series_code = '{{ var("inflation_series_igpdi") }}' then index_value end) as igpdi_current,
        -- Each series' OWN latest reading, not a shared cut-off date: CPI-U, HICP and
        -- the SGS indices publish on different calendars, so forcing one common month
        -- would throw away a month of whichever published first — and, worse, make the
        -- "today" of one convention differ from its own latest ingested data.
        max(case when series_code = '{{ var("inflation_series_cpi")   }}' then index_value end) as cpi_current,
        max(case when series_code = '{{ var("inflation_series_hicp")  }}' then index_value end) as hicp_current
    from (
        select series_code, index_value
        from {{ ref('silver_inflation') }}
        where index_value is not null
        qualify row_number() over (
            partition by series_code
            order by reference_date desc
        ) = 1
    )

),

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

fx_latest as (

    select
        max(case when currency = 'USD' then brl_per_foreign_unit end) as brl_per_usd_current,
        max(case when currency = 'EUR' then brl_per_foreign_unit end) as brl_per_eur_current
    from (
        select currency, brl_per_foreign_unit
        from {{ ref('silver_currency') }}
        where brl_per_foreign_unit is not null
        qualify row_number() over (
            partition by currency
            order by reference_date desc
        ) = 1
    )

)
{%- endmacro -%}
