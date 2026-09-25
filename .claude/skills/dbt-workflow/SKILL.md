---
name: dbt-workflow
description: >-
  Run, create, modify, test, or debug dbt models (Silver/Gold), seeds, macros,
  and tests. Use when asked to work with dbt, create a new model, fix dbt test
  failures, add columns to Silver/Gold, modify the medallion pipeline
  transforms, or understand the schema separation.
---

# dbt Workflow — Embrapa Produtos Agrícolas

## Quick Commands

```powershell
# Dev (sandboxed in dbt_dev_silver / dbt_dev_gold):
make dbt-build               # build all models
cd dbt && uv run dbt run --select silver_ibge_pevs+   # single model + downstream
cd dbt && uv run dbt test --select gold_pevs_production

# Prod (writes to silver / gold — only after dev validation):
make dbt-build-prod           # plain build (NOT --full-refresh) against real datasets

# Test:
make dbt-test
cd dbt && uv run dbt test
```

## Dev/Prod Schema Separation

The macro `dbt/macros/generate_schema_name.sql` enforces:

| Target | Schema result | Example |
|--------|---------------|---------|
| `dev` (default) | `<target.schema>_<custom_schema>` | `dbt_dev_silver`, `dbt_dev_gold` |
| `prod` | `<custom_schema>` only | `silver`, `gold` |

**Always iterate on `make dbt-build` (dev).** `make dbt-build-prod` builds against the real datasets (a plain build, not `--full-refresh`: the incremental Silver re-scans whatever Bronze years got a newer ingestion) — only run after dev validation.

**Dev schemas auto-expire after 7 days** via the `apply_dev_ttl` macro (`on-run-end` hook in `dbt_project.yml`).

## Model Patterns

### Silver — `dbt/models/silver/`

- **Materialization:** `table` (default). Exception: `silver_ibge_pevs` is `incremental` with `insert_overwrite` partitioned by `reference_year`.
- **Dedup pattern** (Bronze is append-only):
  ```sql
  select *
  from {{ source('bronze_ibge', 'sidra_raw') }}
  qualify row_number() over (
      partition by <natural_key_columns>
      order by ingestion_timestamp desc
  ) = 1
  ```
- **Incremental strategy** (silver_ibge_pevs): scan only partitions with new Bronze rows since last Silver build, then `insert_overwrite` the affected `reference_year` partitions. Use `--full-refresh` after schema changes.
- **Naming:** `silver_<source>_<entity>` (e.g. `silver_bcb_inflation`, `silver_ibge_pevs`).

### Gold — `dbt/models/gold/`

- **Materialization:** `table` (current). One comprehensive table per source — the PEVS model is `gold_pevs_production`. Ad-hoc aggregation is query-time `GROUP BY`; pre-aggregated marts for the React/webapi dashboard's Pushdown Computing live in the `serving/` layer (they derive from Gold, not replace it).
- **Columns:** one row per `(reference_year, state_acronym, city_code, product_code)`. `dbt/models/gold/_gold.yml` is the authoritative column list — a hard-coded count here goes stale silently (this line read "28" while prod carried 31).
- **Monetary conventions:**
  - `val_yearfx_*` — raw value ÷ year's average FX. NULL pre-1994.
  - `val_real_{ipca,igpm,igpdi}_*` — value projected to today via chain-linked IPCA/IGP-M/IGP-DI index, converted to a foreign currency at today's FX. **Use this for cross-year comparison.**
  - `val_real_cpi_usd` / `val_real_hicp_eur` — converted at the record's FX, then deflated by US CPI-U / euro-area HICP. An index only corrects the money of the economy it measures, so these pair with one currency each and `val_real_cpi_brl` does not exist. Behind `enable_foreign_inflation` (build-order gate; NULL until the first ingest).
- **Naming:** `gold_<source>_<form>` where `<form>` is `production` (output measurement, e.g. `gold_pevs_production`) or `flows` (origin→destination trade, e.g. `gold_comex_flows`).

### Seeds — `dbt/seeds/`

- Land in the same dataset as Silver.
- Key seed: `historical_currency_factors` — date-aware multiplier that absorbs the "Mil" multiplier AND cumulative Brazilian currency reforms. **Without this factor, pre-1994 values are 10⁶–10⁹× too large.**
- Seed join is date-aware: `(unit_of_measure, reference_year BETWEEN year_from AND year_to)`.
- **Editing a seed an INCREMENTAL model consumes** (`silver_ibge_pevs` ref()s `historical_currency_factors` / `unit_family_conversions` / `product_unit_factors`) needs `dbt build --select silver_ibge_pevs+ --full-refresh` — the incremental gate only re-scans Bronze years with new ingestions, so a seed-only change never reaches already-built partitions otherwise.

### Macros — `dbt/macros/`

| Macro | Purpose |
|-------|---------|
| `generate_schema_name` | Dev/prod schema routing |
| `apply_dev_ttl` | Auto-expire dev tables after N days |
| `safe_numeric` | Parse string to numeric, handling nulls |
| `data_quality_flag` | Classify row quality — the 14-value cascade (absences → `PROBLEMATIC_*` → `ISOLATED_SPIKE` → `OUTLIER_*` → `UNSCORED` → `OK`); PAM adds `AREA_INCONSISTENT`, trade adds `MISSING_WEIGHT`, `INFERRED_*` are reserved. Legacy 4-value flag when `enable_quality_outliers` is off |
| `isolated_spike` | The temporal detector behind `ISOLATED_SPIKE` (IBGE only): a one-year value that makes its state's series jump. Measured before written — 138 rows / 60 state-year jumps |
| `quality_outlier_ctes` | The implied-price detector behind the flag: per-product median of ln(value ÷ qty), the materiality floor (value OR qty × median price ≥ 100k), NULL-safe attribution. IBGE scores `val_real_igpdi_brl`, trade nominal US$ ÷ `net_weight_kg`. Audit: `docs/audits/qualidade_dados_audit_2026-09-24.md` |
| `state_name` | State acronym → full state name (in `state_dimensions.sql`) |
| `state_region` | State acronym → region (in `state_dimensions.sql`) |

## Adding / Modifying Models — Checklist

1. Create/edit `.sql` file in `dbt/models/silver/` or `dbt/models/gold/`.
2. Add schema tests in `_silver.yml` or `_gold.yml` (same directory).
3. Run `make dbt-build` to test in dev.
4. Run `make dbt-test` to validate schema tests pass.
5. If incremental model, test with `--full-refresh` too.
6. Only then `make dbt-build-prod`.

## dbt Variables (from `dbt_project.yml`)

```yaml
vars:
  ibge_variable_quantity: "144"
  ibge_variable_value: "145"
  inflation_series_ipca:  "{{ env_var('BCB_INFLATION_SERIES_IPCA_CODE',  '433') }}"
  inflation_series_igpm:  "{{ env_var('BCB_INFLATION_SERIES_IGPM_CODE',  '189') }}"
  inflation_series_igpdi: "{{ env_var('BCB_INFLATION_SERIES_IGPDI_CODE', '190') }}"
```

If you change BCB series codes in `.env`, also update these vars.

## Gotchas

- `silver_bcb_*` remain `materialized=table` (small tables; the IPCA chain index requires a full-series window scan).
- The IPCA chain in `silver_bcb_inflation.sql` uses `100 * exp(sum(log(1 + pct/100)) over (...))` — this is a log-additive compound, not a simple product.
- Adding a new historical-currency unit string: add a row to `dbt/seeds/historical_currency_factors.csv` with a non-overlapping `[year_from, year_to]` range.
