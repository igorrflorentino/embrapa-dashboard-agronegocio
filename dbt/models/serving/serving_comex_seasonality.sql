{{
    config(
        materialized='table',
        partition_by={
            'field': 'reference_year',
            'data_type': 'int64',
            'range': {'start': 1970, 'end': 2050, 'interval': 1}
        },
        cluster_by=['flow', 'ncm_code', 'state_acronym']
    )
}}

-- ────────────────────────────────────────────────────────────────────────────
-- serving_comex_seasonality — monthly COMEX mart for the seasonality view.
--
-- The ONLY serving mart that keeps `reference_month` — it backs monthlyData
-- (brief §4.3: matrix[year][1..12], monthlyAvg[12]). Collapses NCM/country/via to
-- (year × month × flow × NCM × UF) — `state_acronym` is KEPT in the grain so the
-- seasonal profile can be narrowed to one origin UF (P6: per-UF scoping). Joins
-- dim_date for the localized month label so the chart axis needs no client-side
-- month mapping. COMTRADE is annual and never reaches this mart (= "Not applicable").
--
-- Grain: one row per (reference_year, reference_month, flow, ncm_code, state_acronym).
-- ────────────────────────────────────────────────────────────────────────────

with comex as (

    select
        reference_year,
        reference_month,
        flow,
        ncm_code,
        -- A TABELA no grão, como em todos os bancos. Constante aqui (banco de UMA tabela
        -- só), e é justamente por isso que precisa estar: com o trio valendo nos cinco, a
        -- mart tem a MESMA forma em todos e o consumidor não ramifica por banco.
        tabela,
        state_acronym,
        any_value(ncm_description)  as ncm_description,
        -- The full currency matrix, the same column set as serving_comex_annual. Until
        -- v1.77.0 this mart carried only nominal US$, so the seasonality view could not
        -- follow the conventions strip — it stayed nominal under "Correção IPCA" while
        -- the annual views honoured it. IGP-M / IGP-DI × USD are omitted for the same
        -- reason as there: the BFF allowlist (serving/sql.ALLOWED_VALUE_COLUMNS) can never
        -- SELECT them, so materializing them would be dead bytes.
        sum(val_yearfx_brl)         as val_yearfx_brl,
        sum(val_yearfx_usd)         as val_yearfx_usd,
        sum(val_yearfx_eur)         as val_yearfx_eur,
        sum(val_real_ipca_brl)      as val_real_ipca_brl,
        sum(val_real_ipca_usd)      as val_real_ipca_usd,
        sum(val_real_ipca_eur)      as val_real_ipca_eur,
        sum(val_real_igpm_brl)      as val_real_igpm_brl,
        sum(val_real_igpm_eur)      as val_real_igpm_eur,
        sum(val_real_igpdi_brl)     as val_real_igpdi_brl,
        sum(val_real_igpdi_eur)     as val_real_igpdi_eur,
        -- The own-currency deflators (v1.82.0): US CPI corrects the dollar, euro-area
        -- HICP the euro. Distinct columns, not variants of the ones above — the FX
        -- moment differs too (the month's rate, not the latest one), so the numbers are
        -- not two roundings of one answer. Served for their OWN currency only: a
        -- val_real_cpi_brl would be 'the dollar's purchasing power, printed in reais',
        -- which nothing on screen asks for.
        sum(val_real_cpi_usd)       as val_real_cpi_usd,
        sum(val_real_hicp_eur)      as val_real_hicp_eur,
        sum(net_weight_kg)          as net_weight_kg,
        count(*)                    as source_rows,
        max(last_refresh)           as last_refresh,
        -- The price base of the val_real columns above (v1.105.0). Constant across Gold,
        -- so max() only lifts it through the GROUP BY; the BFF reads it back with max()
        -- in the SAME select that sums a value, which is what dates that value.
        max(ipca_base_month)        as ipca_base_month,
        max(igpm_base_month)        as igpm_base_month,
        max(igpdi_base_month)       as igpdi_base_month,
        max(cpi_base_month)         as cpi_base_month,
        max(hicp_base_month)        as hicp_base_month,
        max(fx_usd_base_date)       as fx_usd_base_date,
        max(fx_eur_base_date)       as fx_eur_base_date
    from {{ ref('gold_comex_flows') }}
    where {{ hidden_code_predicate('comex', 'ncm_code') }}
    group by reference_year, reference_month, flow, ncm_code, tabela, state_acronym

)

select
    c.reference_year,
    c.reference_month,
    d.month_name_pt,
    d.month_abbr_pt,
    d.quarter,
    c.flow,
    c.ncm_code,
    c.tabela,
    c.state_acronym,
    c.ncm_description,
    c.val_yearfx_brl,
    c.val_yearfx_usd,
    c.val_yearfx_eur,
    c.val_real_ipca_brl,
    c.val_real_ipca_usd,
    c.val_real_ipca_eur,
    c.val_real_igpm_brl,
    c.val_real_igpm_eur,
    c.val_real_igpdi_brl,
    c.val_real_igpdi_eur,
    c.val_real_cpi_usd,
    c.val_real_hicp_eur,
    c.net_weight_kg,
    c.source_rows,
    c.ipca_base_month,
    c.igpm_base_month,
    c.igpdi_base_month,
    c.cpi_base_month,
    c.hicp_base_month,
    c.fx_usd_base_date,
    c.fx_eur_base_date,
    c.last_refresh
from comex c
left join {{ ref('dim_date') }} d
    on d.date_month = date(c.reference_year, c.reference_month, 1)
