# Looker Studio — Dashboard Setup

## Prerequisite: run `make dbt-build-prod`

Looker Studio must point to the **production** datasets (`silver`, `gold`),
not the dev ones (`dbt_dev_silver`, `dbt_dev_gold`). Make sure you have run:

```bash
make dbt-build-prod
```

This creates `embrapa-dashboard-commodities.gold.gold_pevs_production` with the complete data.

---

## 1. BI Engine — DO NOT enable (fixed cost; future-only)

BI Engine is a caching technology that speeds up BigQuery queries.

> ⚠️ **Leave this OFF.** A BI Engine **Reservation** is **reserved capacity billed
> per GB-hour even at zero traffic** (~US$ 30/month/GB) — a **fixed cost** that
> directly violates this project's zero-fixed-cost / scale-to-zero rule (see
> [cost_safety.md § 0](cost_safety.md)). It is **not** needed: the dataset is small
> and BigQuery on-demand is more than fast enough. Enable it **only** as a future,
> explicitly-instructed decision if the dashboard ever sees heavy steady use.

If (and only if) that future arrives, the steps are: **BigQuery → BI Engine →
Reservations → Create Reservation** (project `embrapa-dashboard-commodities`,
location `us-central1`, capacity e.g. 1 GB; ~US$ 30/month/GB). First configure the
budget + quota in [cost_safety.md](cost_safety.md) so any unexpected cost alerts.
(Looker Studio also exposes a small free BI Engine allotment in some cases, but a
*Reservation* is the paid, always-on form to avoid.)

---

## 2. Create the report in Looker Studio

### 2a. Access Looker Studio

1. Go to [lookerstudio.google.com](https://lookerstudio.google.com)
2. Click **+ Create → Report**

### 2b. Connect to the Gold table

There is **a single physical Gold table per source** — for IBGE PEVS it is
`gold_pevs_production` (~95 thousand rows, one per year × UF × municipality × product).
Aggregations by state/year or Brazil-total are derived within Looker
Studio itself (calculated fields / GROUP BY on the source). Pre-aggregated marts exist in the
`serving/` layer (for the React SPA dashboard / Pushdown Computing), but Looker
consumes Gold directly.

| Table | Rows (approx.) | Grain |
|---|---|---|
| `gold_pevs_production` | ~95 thousand | year × UF × municipality × product (full drill-down) |

Connect:

1. Under "Add data to report", select **BigQuery**
2. Sign in with the account that has access to the project
3. Navigate: **My projects → embrapa-dashboard-commodities → gold → gold_pevs_production**
4. Click **Add** → **Add to report**

> **Important:** connect directly to the table, not via "Custom Query".
> BI Engine only accelerates direct connections to the physical table.

### 2c. Configure default fields

On the data source configuration screen, adjust:

| Field | Suggested type | Default aggregation |
|---|---|---|
| `reference_year` | Number (year) | — |
| `reference_date` | Date (YYYY-MM-DD) | — |
| `state_acronym` | Text | — |
| `state_name` | Text | — |
| `region` | Text | — |
| `city_code` | Text / Geo → "Brazilian Municipality" | — |
| `city_name` | Text | — |
| `product_code` | Text | — |
| `product_description` | Text | — |
| `family` | Text | — (always use as a quantity dimension/filter) |
| `unit_native` | Text | — |
| `base_unit` | Text | — |
| `qty_native` | Number | Sum (**only when filtering by a single `family`/`unit_native`**) |
| `qty_base` | Number | Sum (**only with `family` in the breakdown — never across families**) |
| `val_yearfx_brl` | Number (BRL currency) | Sum |
| `val_yearfx_usd` | Number (USD currency) | Sum |
| `val_yearfx_eur` | Number (EUR currency) | Sum |
| `val_real_ipca_brl` | Number (BRL currency) | Sum |
| `val_real_ipca_usd` | Number (USD currency) | Sum |
| `val_real_ipca_eur` | Number (EUR currency) | Sum |
| `val_real_igpm_brl` | Number (BRL currency) | Sum |
| `val_real_igpm_usd` | Number (USD currency) | Sum |
| `val_real_igpm_eur` | Number (EUR currency) | Sum |
| `data_quality_flag` | Text | — |
| `last_refresh` | Date and time | Maximum |

---

## 3. Recommended default filter

Add a **report filter** for exploratory analyses:

- Field: `data_quality_flag`
- Condition: **Exclude** — `MISSING_VALUE`, `MISSING_QUANTITY`, `MISSING_WEIGHT`, `INCOMPLETE`,
  `PROBLEMATIC_VALUE`, `PROBLEMATIC_QUANTITY`

This drops the rows with an actual defect: the ones where IBGE published no monetary value
(e.g. Pinheiro brasileiro) and the ones whose implied price says a digit was mistyped.

> ⚠️ **Do NOT use `Equal to OK` — it was the recommendation here until v1.49.0 and it now
> throws away most of your data.** `OK` used to mean "nothing wrong was found"; since the
> `UNSCORED` tier (v1.49.0) it means "the outlier detector EXAMINED this row and cleared it",
> and everything it had no basis to examine moved out of `OK`. On PAM that is **66,3% of the
> table** — every row before 1980 (which the IPCA does not reach), every empty cube cell
> (município × produto that simply has no production), and everything under the materiality
> floor. None of those are defects. Filtering `= OK` would silently cut a 1974–2024 series
> down to 1980–2024 and drop most municípios, with nothing on the report to say so.
>
> If you have an EXISTING report built from the old recommendation, fix the filter — the
> numbers in it changed the moment prod Gold was rebuilt (2026-09-07), without the report
> changing.

To keep only rows the detector actively verified, filter `Equal to OK` **on purpose** and say
so on the page — it is a legitimate, much narrower scope, not a general-purpose default.

---

## 4. Suggested page structure

### Page 1 — Overview

| Chart | Configuration |
|---|---|
| Scorecard — Total Real Value IPCA (BRL) | `val_real_ipca_brl` Sum |
| Scorecard — Total Mass (t) | `qty_base` Sum · **filter `family = massa`** |
| Scorecard — Total Volume (m³) | `qty_base` Sum · **filter `family = volume`** |
| Line chart — Historical series | Dimension: `reference_year` · Metric: `val_real_ipca_brl` |
| Bar chart — By product | Dimension: `product_description` · Metric: `val_real_ipca_brl` |
| Filter — Year | Slider control on `reference_year` |
| Filter — State | Selector on `state_acronym` |
| Filter — Product | Selector on `product_description` |

### Page 2 — Geographic analysis

| Chart | Configuration |
|---|---|
| Choropleth map (Brazil) | Geo: `state_acronym` · Color: `val_real_ipca_brl` |
| Detailed table — Top municipalities | Dimensions: `city_name`, `state_acronym`, `family` · Metrics: `qty_base`, `val_yearfx_brl`, `val_real_ipca_brl` |

### Page 3 — Comparative monetary analysis

| Chart | Configuration |
|---|---|
| Line chart — Nominal vs real values | Series 1: `val_yearfx_brl` · Series 2: `val_real_ipca_brl` · Series 3: `val_real_igpm_brl` |
| Bar chart — By currency | Metrics: `val_real_ipca_usd`, `val_real_ipca_eur` |

---

## 5. Automatic data refresh

The dashboard reflects the Gold table at query time. To refresh:

```bash
# Incremental ingestion (only new data)
uv run embrapa ingest all

# Rebuild transformations
make dbt-build-prod
```

Set up a cron or GitHub Actions to run this annually (PEVS is published 1× per year).

---

## 6. Transfer to the company

When moving the project to the company:
1. Transfer the report: **Share → Transfer ownership** in Looker Studio.
2. Update the data source to point to the new `GCP_PROJECT_ID`.
3. There is no hardcoded project in the report — only the data source needs to be updated.
