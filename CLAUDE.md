# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI assistants when working with code in this repository.

## Project Overview

**Embrapa Agricultural, Livestock & Forestry Dashboard** — pt-BR product name (what the researcher reads on screen, and the ABNT citation title): **"Análise histórica de produtos agropecuários e florestais"**, held in ONE place, `frontend/src/ui/produto.js` (`window.PRODUTO`) — a rename is one line there, and `produto.test.js` fails if any screen keeps a literal copy. It was "produtos agrícolas" until v1.50.0, which named less than a third of the acervo: of the 35 products in the production bancos only 11 are lavouras, the rest being livestock and animal products (including wool and silkworm cocoons), native-forest extraction (including charcoal and firewood) and planted-forest silviculture — and the citation contradicted itself, its author line already reading "PESQUISA AGROPECUÁRIA". Medallion pipeline (Bronze → Silver → Gold) for historical analysis of Brazilian agricultural, livestock and forestry production — **both halves of IBGE PEVS**: extraction from native forest (SIDRA t289) and silviculture from planted forest (t291), told apart by `gold_pevs_production.tabela` (the table id itself) — enriched with FX rates (USD, EUR) and inflation indices (IPCA, IGP-M, IGP-DI) from Brazil's Central Bank.

Built for **Embrapa researchers** — the purpose is historical/scientific exploration of time series, **not** business metrics or real-time analytics (data is ingested and transformed in batch).

- **Language**: Python 3.12 · **Package manager**: uv · **Build**: hatchling
- **Data transforms**: dbt-core + dbt-bigquery
- **Infrastructure**: GCS + BigQuery + GitHub Actions
- **Consumption (two parallel paths)**: Looker Studio (no-code, direct on Gold) · a custom **React SPA + Flask REST API + Plotly.js** dashboard deployed to Cloud Run (behind IAP). Both read the same Gold/serving tables; neither is exclusive.
- **License**: Apache 2.0

> ✅ **Custom dashboard = React SPA + Flask REST + Plotly.js (live on Cloud Run, behind IAP).** Built in the 2026-06 Dash→React migration, which **replaced the Dash UI entirely** (the Dash package was removed after the cutover — don't look for `dashboard/`). It is **one of two first-class consumption paths**; the other is Looker Studio, direct on Gold. Architecture (**Pushdown Computing** — no Gold held in memory):
> - **Data-access / serving layer**: `dbt/models/serving/` (pre-aggregated marts at the chart grains), `dbt/models/core/` (conformed dims + the SCD2 curation view), and `src/embrapa_dashboard/serving/` (the UI-agnostic BFF: parameterized BigQuery queries, `flask-caching`, the append-only curation writer with IAP author capture).
> - **REST API + SPA host**: `src/embrapa_dashboard/webapi/` (Flask app factory; serves the built SPA **and** `/api` from one origin/IAP; `seam` composes the gateway readers, `serializers` shapes them to the UI's `contracts.js`; `format`/`registries` are the pt-BR formatting + banco/metric/view registries — these moved here from the deleted Dash package). gunicorn entrypoint `embrapa_dashboard.webapi.app:app`; extra `webapi` (flask + flask-caching + gunicorn, **no dash/plotly**).
> - **Frontend**: `frontend/` — the Design System's React/Vite UI (`frontend/src/ui/`, adopted verbatim from the handoff and now the live production UI — **not** a prototype), with the synthetic data layer + SVG charts replaced by API-backed `src/data/` + Plotly.js `src/charts/` (analytical charts get zoom/hover/pan). `npm run dev` (Vite :5173, proxies `/api`→Flask :8000) · `npm run build`→`dist`.
> - **Deploy**: `deploy/webapi/` (3-stage node-build→python image, private + IAP, runtime SA `sa-web-dashboard-prod`). **A code change needs NO manual deploy** — merging to `main` triggers `.github/workflows/webapi-deploy.yml`, which does a surgical `gcloud run services update --image` (env, secrets and the IAP annotations all persist). `make webapi-deploy` (`deploy.sh`) is only for an **env change**: it uses `--env-vars-file`, which REPLACES the whole env block, so it must run from a machine that has `deploy/webapi/.env.prod`. Spec/history: **`PLANS/react_migration_contract_map.md`**.
> - **Curadoria** (the catalog — *what enters/exits the dashboard*) is **LIVE**: a researcher-editable commodity catalog in `research_inputs` (the editable successor to the retired `commodity_crosswalk` seed → `core/dim_produto_catalog` → `gold_produto_agrupamento`), edited via the **"Cadastro de produtos"** admin view and consulted (read-only calibration seeds) via **"Referências"**; with an **orphan→Descontinuado** lifecycle (auto-detected on the dbt-build boundary, NON-destructive) and a **human-gated purge** (`embrapa purge-orphan` — backup-first, prints the DELETEs for a human; never auto-deletes). Backend: `serving/{curation,catalog_lifecycle,research_inputs}.py` + `webapi/seam_curation.py`; per-catalog allowlist `research_inputs.catalog_editors`. Spec: **`PLANS/curadoria_catalogo.md`**.
> - **Engenharia de Atributos** (derived columns from researcher input) has TWO axes and only ONE is frozen — do not read the freeze as covering the feature. **Nível de industrialização (per-code) is LIVE**: the editor is in the sidebar, the *Valor agregado* view is `status: 'live'`, `enable_curation` is **`true`** in `dbt_project.yml`, and `serving.dim_code_industrialization_scd2` carries 303 classifications across 5 levels in prod (measured 2026-08-28). **Tipo de mercado (customs×flow market-nature) is FROZEN** (PRs #168/#169): its sidebar entry is commented out, `curated_market_nature` is deliberately left unmapped so a stale deep link degrades to a neutral notice instead of routing, and `serving_comtrade_annual.market_nature` holds 0 distinct values. That one is **data-blocked, not merely deferred**: the totals-only COMTRADE base (`customsCode=C00`, v1.13.0) carries no customs-procedure detail to classify, so un-freezing the UI would surface an empty axis. `serving/attribute_engineering.py` + `webapi/seam_attribute_engineering.py` back both axes. The shared append-log + IAP-author + idempotency infra both features reuse is `serving/research_inputs.py`. **Data-blocked** (honest in-product placeholders): `cross_chain`/`cross_lag` + the *regime×flow market-nature* axis need sources this repo lacks (SEFAZ inter-UF flows; monthly PEVS — PEVS is annual; the customs-procedure dimension, summed away in Silver). (Note: the *ingestion* Cloud Run **Job** under `deploy/ingestion/` is a separate batch, no-UI artifact — don't confuse it with the dashboard Service.)

## Documentation Map

| File | Purpose |
|------|---------|
| `README.md` | Human entry point, quickstart, CLI reference |
| `ARCHITECTURE.md` | Technical deep-dive: folder structure, data flow, stack decisions |
| `CONTRIBUTING.md` | Commit conventions, branch flow, PR process |
| `CHANGELOG.md` | Version history (Keep a Changelog format). **Every merge bumps the version here; only some become a git tag + GitHub Release** — the rule is in `CONTRIBUTING.md` § Release Policy: a tag is cut ONLY when the change reaches the deployed product (`frontend/`, `src/embrapa_dashboard/`, `dbt/`, `deploy/`). Tests, docs and comments ship silently. The convention lived only in people's heads until v1.55.0, and the practice had lapsed for 118 versions without anyone noticing. |
| Roadmap (Google Drive) | Project vision & evolution tracking for business leadership — kept **outside the repo** (replaces the former `ROADMAP.md` + `TODO.md`): [Roadmap — Google Drive](https://docs.google.com/document/d/1UByZ_THIJcqtYizZWrOSDsMpM_XCptj0f29VcymcPXE/edit?usp=sharing). `PLANS/` (engineering specs) and `CHANGELOG.md` (per-version record) stay in-repo. |
| `SECURITY.md` | Vulnerability reporting policy |
| `PLANS/` | Detailed feature plans (one .md per feature) |
| `docs/` | Deep-dive docs (setup, IAM, testing, cost safety, etc.) |
| `docs/operations_runbook.md` | Occasional prod ops: managing curators (BQ allowlist), backing up prod Gold locally, the destructive-command safety hooks |
| `docs/nomenclatura_divergencias.md` | **Gerado** (`make nomenclature-audit`). COMEX/COMTRADE não trazem descrição nos dados — o nome do produto vem de um seed deste repo. Este é o registro de toda divergência contra o campo de exibição do MDIC, classificada: o oficial às vezes é abreviado (`Outs.painéis`) e às vezes está errado (`15079019` recebe lá a descrição do irmão). Política: usar o texto pleno da nomenclatura e registrar aqui. |
| `docs/comtrade_world_backfill.md` | How the UN Comtrade all-reporters (world) backfill was done — **completed**; every year 2000–2025 is at all-reporters (measured 2026-08-28). Kept as the record + the procedure for a future re-run: measured volume/time/cost (forecast vs. actual), local + Cloud Run Job paths, quota behaviour, cost guard |

## Code Style

- **Formatter/Linter**: Ruff (line-length=100, target=py312)
- **Rules**: E, F, I, B, UP, SIM, RUF (ignoring RUF001-003 for the pt-BR Unicode that remains in UI/i18n data values)
- **Language** (project rule — the **end user is the deciding reader**):
    - Read **exclusively by the development team** → **English**: identifiers, docstrings, comments, log/error and operator/CLI messages, dbt comments + YAML descriptions, and all technical docs (README, ARCHITECTURE, docs/, PLANS/, …).
    - Read by **anyone *including* the end user**, or **any string the end user could read — no matter where it lives** → **Portuguese**: dashboard display strings, chart/axis labels, and i18n data values (e.g. `month_name_pt` → `'Janeiro'`, Brazilian region/state names).
    - When unsure whether the end user could ever see a string, **default to Portuguese**. (External-API literals the code must match — e.g. SIDRA's Portuguese error text — stay verbatim as data.)
- **SQL**: SQLFluff for dbt models
- **Pre-commit**: gitleaks + ruff + file-hygiene hooks (install with `make precommit-install`)

## Commands

Setup (once per machine):
```bash
pyenv local 3.12.11 && uv sync
gcloud auth application-default login
cp .env.example .env                          # then edit GCP_PROJECT_ID etc.
cp dbt/profiles.yml.example ~/.dbt/profiles.yml
make precommit-install                        # optional: ruff + file-hygiene on every commit
```

Ingestion (Python → GCS Parquet → BigQuery Bronze):
```bash
make ingest-all                               # IBGE PEVS (extração + silvicultura) + both BCB series + COMEX — FIVE sources (delta)
# CADENCE (revised 2026-08-28, measured): this batch is now WEEKLY (Monday 05:00 BRT,
# `embrapa-ingest-all-weekly`). Only BCB câmbio advances daily — 22 of 30 days, vs 2 for
# inflação, 3 for COMEX and 2 for PEVS — so it kept a daily trigger of its own
# (`embrapa-ingest-all-currency-daily`, `make ingest-job-currency-schedule`).
# `all` deliberately EXCLUDES three (in_all=False in cli.INGESTS): ibge-pam and ibge-ppm
# (annual, ~1yr publication lag — own monthly triggers) and comtrade (key + quota gated).
# Each source declares its expected `cadence_days`, which doctor's heartbeat check reads.
make ingest-ibge-historical                   # auto-chunked for large year windows
uv run embrapa ingest {ibge|ibge-silvicultura|ibge-pam|ibge-ppm|bcb-inflation|bcb-currency|comex|comtrade|all}
uv run embrapa ingest bcb-inflation --full    # force refetch from BCB_START_YEAR
uv run embrapa ingest ibge-batch --chunk-years 5
```

**IBGE and BCB pipelines are delta by default.** Each queries the max reference
already in Bronze and re-fetches only a small recent window. BCB rewinds a
**year-granular** overlap (it rewinds to the start of a calendar year, not a
precise month/day window — so inflation re-fetches up to ~24 months and FX up to
a full year of daily PTAX; strictly an over-fetch, never under-covering). **IBGE**
re-fetches from
`latest_bronze_year - IBGE_DELTA_OVERLAP_YEARS` forward — absorbing PEVS revisions
of recent years and a newly published year — instead of the whole 1986→today
window, a huge SIDRA request that can blow the slow-byte deadline on an
unattended Cloud Run job. A cold Bronze table falls back to the full window.
Use `--full` to force the complete window (or `ingest ibge-batch` to chunk a
first historical backfill). **COMEX is the exception** — its per-file ETag check
re-detects a revision to *any* year every run, so the delta limitation below is
IBGE/BCB-only.

**Catching upstream revisions of OLD data — `reconcile`.** Because IBGE/BCB are
delta, a correction the source publishes to an *old* year (e.g. IBGE revising a
1999 value) is **never re-queried** by the scheduled run. `embrapa ingest reconcile`
(`make reconcile`) is the escape hatch: a full re-download of every scheduled
source (IBGE year-chunked for deadline-safety, BCB + COMEX `--full`), ignoring
the delta/ETag short-circuit. It stays **operator-triggered** because the
re-ingest itself is expensive and rarely warranted — but the question of WHETHER
it is warranted is now answerable: **`embrapa reconcile-check`** compares what the
sources serve today against Bronze for data older than the delta window (IBGE PEVS
cell-by-cell at the n6 grain we store; every BCB point older than the rewind), and
exits 1 if anything diverged. It is read-only. The earlier claim that no cheap
pre-check was feasible held for the whole history but not for a well-chosen sample
(~20k points in ~2 min), and for BCB not at all — one SGS request returns the whole
series, so that half is exhaustive. COMEX stays out of scope: its per-file ETag
check already catches old-year revisions on every scheduled run. The **monthly reminder issue**
(`.github/workflows/reconcile-reminder.yml`) now leads with `reconcile-check`
instead of asking for a guess. (Re-enable a monthly Cloud Run trigger any time with
`make ingest-job-reconcile-schedule` — the same Job with args overridden to
`reconcile`.) `reconcile` refreshes only **Bronze**; the **daily scheduled
`dbt build`** (`.github/workflows/dbt-build-prod.yml`) propagates it to
Silver/Gold. No `--full-refresh` is needed: `silver_ibge_pevs` is incremental but
**year-agnostic** (it re-scans whatever Bronze years got a newer
`ingestion_timestamp`), so a revised old year flows all the way to Gold on a
plain build.

Cold-storage backup of the prod Gold tables **and of `research_inputs`** — the researcher-authored curation data (catálogo, agrupamentos, classificações, allowlists). Gold is DERIVABLE (losing it costs a `dbt build`); `research_inputs` is not recomputable from any source, and until v1.36.0 it was the one dataset with no snapshot. `embrapa doctor` fails (`curation-backup`) if the newest snapshot predates that coverage. **The recommended prod path
bundles build + snapshot in one target — reach for this instead of bare
`dbt-build-prod` whenever the run is preservation-worthy:**

```bash
make dbt-build-prod-with-backup   # build prod, then snapshot Gold to GCS
make backup-gold                  # snapshot only (after an existing prod build)
uv run embrapa backup-gold        # same as above, direct CLI form
```

Each snapshot lands at `gs://${GCS_BUCKET}/backups/run=<ts>/...`. Plain
`make dbt-build-prod` is intentionally left un-chained so throwaway prod
experiments don't accumulate snapshots. **Operator responsibility:** run
`dbt-build-prod-with-backup` at least once per release boundary (after
schema changes, new product codes, or anything you'd want to roll back
to). `embrapa doctor` warns if the latest snapshot is more than
`BACKUP_STALENESS_DAYS` (default 14) old, and fails clearly if no
snapshot exists.

dbt transforms (run from repo root via Makefile, or `cd dbt` to call dbt directly):
```bash
make dbt-build           # dev target — writes to dbt_dev_silver, dbt_dev_gold
make dbt-build-prod      # prod target — writes to silver, gold (full-refresh)
make dbt-test
cd dbt && uv run dbt run --select silver_ibge_pevs+    # single model + downstream
cd dbt && uv run dbt test --select gold_pevs_production
cd dbt && uv run dbt build --full-refresh              # force rebuild incremental models
```

**`silver_ibge_pevs` is incremental** (insert_overwrite by `reference_year`).
Each `dbt build` scans only Bronze partitions for years with new ingestions —
the dedup `qualify` no longer pulls the whole Bronze history. Use
`--full-refresh` after schema changes, after dropping the table, or when
re-anchoring to a different `ingestion_timestamp` baseline. `silver_bcb_*`
remain `materialized=table` (small tables; the IPCA chain index requires a
full-series window).

Discovery helpers (auxiliary — for filling in `.env`, not part of the pipeline):
```bash
uv run embrapa discover ibge-periods   --table-id 289
uv run embrapa discover ibge-products  --keywords castanha,madeira
uv run embrapa discover bcb-series     433
```

Lint / test:
```bash
make lint                                # ruff check + ruff format --check
make test                                # pytest
uv run pytest tests/test_ibge_client.py::test_name   # single test
```

## Architecture

Medallion pipeline: data sources (today IBGE PEVS + BCB SGS; see `cli.INGESTS` registry — extensible) → Python (Bronze) → dbt (Silver → Gold) → consumed in parallel by **Looker Studio** (direct) and the **custom React SPA + Flask REST (`webapi`) dashboard on Cloud Run**.

For the full technical deep-dive (folder structure, data flow diagrams, stack decisions, Bronze/Silver/Gold details, configuration model, dev/prod separation), see [`ARCHITECTURE.md`](ARCHITECTURE.md).

Key facts for AI context:
- **⚠ The GCP project id `embrapa-dashboard-commodities` is a FROZEN, IMMUTABLE legacy label — treat it as an opaque string with NO domain meaning.** It predates the "produtos agrícolas" rename; GCP project ids cannot be renamed (only the display name, which is already "Embrapa Produtos Agrícolas Dashboard"). Do **not** read "commodity trading" semantics into it, do **not** propose migrating/recreating the project to change it, and **never** find/replace it in bulk (a bulk rename once corrupted it into an invalid form with a space and an accent, breaking every IAM/bq command; see the v1.10.8 incident). Since v1.50.0 there are THREE distinct names and that is deliberate, not drift: the **product** is "Análise histórica de produtos agropecuários e florestais" (`window.PRODUTO`, the only one a researcher reads); the **GitHub repo** is `embrapa-dashboard-agronegocio` (renamed in v1.52.0); and the **GCP project id** keeps the oldest token of all and must NEVER be renamed. **Renaming the repo touches SIX places in GCP, not the three the workflow comments list** — measured 2026-09-07 by enumerating, not by reading the docs: the `attribute.repository` binding on **five** CI service accounts (`sa-ingest-deploy-ci`, `sa-dashboard-smoke-ci`, `sa-release-ci`, `sa-dbt-build-ci`, `sa-webapi-deploy-ci`) **plus the `attributeCondition` on the WIF provider itself** (`github-provider`), which pins the repo by name and is evaluated BEFORE any service-account binding — miss it and every CI job that authenticates to GCP fails, with the new bindings powerless to help. The safe order is: widen the provider condition to accept BOTH names → add the new bindings → rename → prove a CI run authenticates → only then narrow the condition and drop the old bindings. **First, check each identity against the table in `docs/iam_setup.md`**: that rename enumerated the LIVE bindings and faithfully re-created all five, including `sa-dashboard-smoke-ci`, which that file had marked RETIRED three weeks earlier (holding project-wide BigQuery read for nothing; deleted 2026-09-07, leaving four). Enumeration answers "what exists", never "what should exist" — a retiring identity must be dropped from the migration, not carried across it. In the terminology model **commodity** is a narrow, specific word (an *undifferentiated* produto) — it is not a synonym for the subject.
- **Bronze is append-only**; Silver dedupes on natural key by `ingestion_timestamp desc`.
- All Bronze columns are `STRING` except `ingestion_timestamp`.
- The seed `historical_currency_factors` absorbs currency reforms; without it, pre-1994 values are 10⁶–10⁹× too large.
- `val_real_{ipca,igpm,igpdi}_*` columns are for cross-year comparison; `val_yearfx_*` are nominal.
- Config flows through `src/embrapa_dashboard/config.py` (pydantic-settings + `.env`). `BCB_INFLATION_SERIES` uses `CODE:LABEL,CODE:LABEL` format — keep `BCB_INFLATION_SERIES_IPCA_CODE` / `BCB_INFLATION_SERIES_IGPM_CODE` / `BCB_INFLATION_SERIES_IGPDI_CODE` in sync (dbt reads each via `env_var()` to wire the right series into the Gold pivot).
- `target=dev` → `dbt_dev_silver` / `dbt_dev_gold` (auto-expire 7 days). `target=prod` → `silver` / `gold`.
- **F7 Ciclo de Vida visibility gate**: `core/dim_produto_visibility` (a view of `(source, code, tabela)` — the EXACT commodity code, no prefixes — for produtos a researcher marked *indisponível*) + the `hidden_code_predicate` macro + `serving/sql.visibility_clause` (the Python builder) exclude those produtos from **every** researcher-facing Gold read (the 6 serving marts, `serving_quality_by_source`, the cross-source picker, and the gateway direct readers — município cube, quality timeseries, quality-by-product); kept SEPARATE from `dim_produto_catalog` so the admin editor + crosswalk still see hidden rows. **NOT a no-op:** 3 comex codes are hidden in prod, filtering 6,688 Gold rows (measured 2026-08-30) — the gate was a no-op only in its first releases, and the docs said so long after it stopped being true. Since v1.46.5 the predicate matches the TABLE too on multi-table bancos (`pevs`/`ppm`, the set in the `bancos_multi_tabela()` macro ↔ `serving.curation._BANCOS_MULTI_TABELA`): hiding the extração half (289) leaves silvicultura (291) visible, and a gate row with NO table is a WILDCARD that hides both — the pre-existing behaviour, preserved for untagged entries. Both sides expose the gate column as `_vis_tabela` **by necessity**: inside the `NOT EXISTS`, an unqualified `tabela` resolves to the INNER scope and the comparison becomes a tautology that hides both halves again while looking right. Spec: `PLANS/quality_outliers_and_visibility_gate.md`.
- **Q1 `data_quality_flag` is a 12-value taxonomy** — 10 emitted (OUTLIER = high-magnitude-but-price-consistent vs PROBLEMATIC = implied price `value/quantity` >`quality_price_k`× or <1/k× the product median ⇒ likely typo) **plus 2 RESERVED auto-fill tiers** (`INFERRED_QUANTITY`/`INFERRED_VALUE`, accepted-but-absent, always 0 today — no Gold CASE emits them; reserved for a future auto-fill pipeline, v1.10.2), gated by `enable_quality_outliers` (TRUE in prod; false ⇒ legacy 4-value flag, compiled byte-identical), with vars `quality_price_k`(=100)/`quality_outlier_k`(=4.0)/`quality_min_obs`(=100)/`quality_value_floor`(=100000, a magnitude floor skipping tiny-municipality rounding noise). IBGE is scored on **deflated** `val_real_ipca_brl` (nominal would fake a pre-1995 hyperinflation tail); trade on nominal USD value / `net_weight_kg`. The 10th emitted value is **`UNSCORED`** (v1.49.0): the row the detector could not examine, which used to fall through the `ELSE` into `OK` and become indistinguishable from a row it examined and cleared — on PAM only **33,6%** of the `OK` rows had actually been scored (measured on prod 2026-09-06). Scope is `quality_unscored_scope`, set to **`'all'`** in prod (rebuilt 2026-09-07): every guard-blocked row — value absent (the deflator gap), value/qty non-positive (the empty cube cells), and the materiality floor. Measured after the rebuild: **PAM 33,5% OK / 66,3% UNSCORED · PEVS 18,2% / 81,6% · COMTRADE 33,7% · COMEX 33,8% · PPM 69,7%** (PPM is higher because its ~2,02M herd rows are stock — `measure_kind = 'stock'` skips the detector by design, since a headcount has no price to score). `'absent'` narrows it to the deflator gap alone; `false` restores the old `OK`. **A `UNSCORED` row is NOT a defect** — it is a row with no basis to evaluate. The UI says so: the KPI is *"Linhas examinadas sem ressalva"* with *"X% sem base para avaliar"* beside it, never *"íntegras"*, which would read as if two thirds of the acervo were broken. Any new metric over this flag must keep that distinction — in particular a `not_ok = 1 - OK` numerator now sweeps UNSCORED in and maps cube sparsity as if it were damage. Changing the scope requires a Gold rebuild.
- **The cross-source views that divide by production sum BOTH IBGE surveys — PEVS (extração nativa) + PAM (lavoura plantada) — and that is not a shortcut.** The other side of the comparison is customs, and the NCM cannot tell the two apart: the cashew codes are `08013100` *"com casca"* / `08013200` *"sem casca"*, a distinction of PROCESSING, and `serving_comex_annual` carries no origin column at all. The two surveys are disjoint by construction (gathered from native forest vs harvested from a planted crop), so summing does not double-count. Reading only PEVS is what made the export coefficient publish **736,2%** nationally for castanha-de-caju (PEVS has 0,20 mi t against PAM's 5,29 mi t) and **1.408.727,8%** for Ceará, which grows 409 mil t and gathers ~0. Same reason for `price_spread`'s gate price — and there, what is summed is **value and quantity**, with the division afterwards: averaging the two prices answers a different question. Widening the family gate to read both surveys also unlocked nine agrupamentos for these views (soja 75,7%, milho 25,6%), which had no PEVS side and so never had a family.
- **A number that is arithmetically right can answer the wrong question — three rules, all learned the hard way.** These are the reading layer's counterpart to the dbt `quality_value_floor`, and every one of them was found in production, not in review. They live in `frontend/src/ui/seriesUtils.js` (JS) and `src/embrapa_dashboard/webapi/measures.py` (Python), with sweeps in `frontend/src/ui/absenceGuard.test.js`, `tests/test_absence_guard.py` and `tests/test_cross_empty_codes_guard.py`.
    - **Absence is not zero, and rounding re-creates it.** `_measure()` preserves `None` for measures (`_num()` zeroes only COUNTS); on the JS side `addPresent`/`scalePresent`/`ratioPresent`/`deltaPct`/`roundPresent` do the same. The traps are `null * fator === 0`, `x ? a/x : 0`, `null >= 0 === true` (a `—` painted green with an up arrow — hence `deltaUp`, which returns `true`/`false`/`null`) and **`Math.round(null) === 0`** (hence `roundPresent`: a rounding is not a division, so the ratio sweep does not cover it). A refusal also needs a REASON — "sem dado" and "moedas diferentes" are different answers (`deltaWhyNot`, `spanComparable`).
    - **A ratio over a tiny base is not a measurement.** `materialityFloor(rows, key, {minShare, minAbs})` — TWO tests, passing ONE is enough, because there are two distinct reasons to belong in a national ranking: weighing enough in the crop (relative) and having a base that stands on its own (absolute). A floor with only one test configured must treat the other as NON-EXISTENT, never as trivially satisfied (`minAbs = 0` makes `x >= 0` always true and silently kills the relative half). Calibrations are MEASURED and live next to the rule: `AREA_FLOOR` (0,5% + 1.000 ha — above 300 ha no yield is a round multiple of 1.000 kg/ha), `PRODUCAO_FLOOR` (0,01%, relative ONLY — the agrupamentos span 910 mil t to 2,17 bi, so no absolute serves), `_PARTNER_PRICE_FLOOR` (100 t + 0,001%, mirrored in `PARTNER_PRICE_FLOOR` for the note; `test_partner_price_floor_parity.py` locks the two units). **Nothing disappears silently**: the floor returns `(kept, dropped)` and the caller MUST name the dropped ones — `window.MaterialityFloorNote` does it, collapsing into a `<details>` past 10 rows (the partner floor removes 38 countries).
    - **An empty code list means "no filter" to the readers.** `seam_base._codes(agrupamento_id, source)` returns `()` when the agrupamento has no side in that source, and passing that straight to a reader publishes the WHOLE banco as if it were the product. It bit three times in one day; `price_spread` reached production, showing the same "preço de porteira" for soja and milho (the implied price of all of PEVS, and a fabricated 25× markup). **The dangerous case is ASYMMETRIC** — codes in one source, none in another — so a probe with no codes anywhere proves nothing: every view is stopped by its first guard. Guard at BOTH levels (the view and the reader) and add the new entry point to `ENTRADAS` in the sweep.
- **Adding a new data source**: follow [`docs/adding_a_data_source.md`](docs/adding_a_data_source.md). The registries that need new entries: `cli.INGESTS`, `doctor.SOURCE_CHECKS`, `doctor.BRONZE_TARGETS` — **plus the banco TABLE ID** (`config.<source>_table_id` + the dbt var, stamped in Silver), because the product identity is the triple in ALL bancos including single-table ones; the guide§4 lists every point and notes that each is test-guarded. Shared primitives live in `src/embrapa_dashboard/core/`. **Gold is per-source, ONE comprehensive table per source** named `gold_<source>_<form>` (`<form>` = `production` for output measurement like PEVS, or `flows` for origin→destination trade like COMEX/COMTRADE/NFe). Ad-hoc aggregations (Looker, exploration) come from `GROUP BY` at query time on Gold; **for the dashboard's Pushdown Computing, the `serving/` layer materializes pre-aggregated marts** at the exact chart grains (fed by the conformed dims `dim_date`/`dim_geo_br`/`dim_geo_municipio` in `core/`) — they derive from Gold, not replace it (see `ARCHITECTURE.md` § Camada Serving). `gold_pevs_production` is the PEVS table — and it is the one place where ONE Gold table carries two SIDRA tables: PEVS is a single survey with two halves (extração vegetal t289 · silvicultura t291), unioned from two Silver models and discriminated by **`tabela`** — the SIDRA table id each row came from. That is not a break in the one-table-per-source rule but its correct reading: the SOURCE is the survey. **A produto's identity is `(banco, tabela, código)` — in ALL FIVE bancos, since v1.47.0**, the same key the curation catalog uses since v1.39.0, so the table is a COLUMN and every human label for a half ("Extração vegetal", "Silvicultura") is DERIVED from it — never stored beside it. **Single-table bancos carry a table id too**, on purpose: PAM uses its real SIDRA id (5457); COMEX and COMTRADE are not SIDRA and use a PROJECT-chosen name (`ncm` / `hs`, in `config.py` ↔ dbt vars). The point is SYMMETRY — with the triple holding everywhere, every identity function has ONE shape instead of branching on "does this banco have a table", and that branch is precisely what kept the rule from propagating (v1.46.1, v1.46.5, and the seven findings in `docs/audits/chave_produto_audit_2026-08-30.md`). The column is stamped in **Silver** (each model knows which table it reads) and carried through Gold and the marts; the append-only curation logs predate it for the single-table bancos, so the `tabela_com_padrao` macro fills the banco's default at the ONE boundary where the raw log becomes a dim — multi-table bancos get no default, because guessing a half would invent data, and a `not_null` on the dims turns that into a build failure. Until v1.46.1 Gold stamped the prose `origem` instead, and the id existed only as a Bronze table NAME (`sidra_t289_raw`): a chart that had to tell two halves apart could not reach the identity and merged madeira/lenha/carvão — the same name in both halves — into one bar with both labels on top of each other. The table is a first-class filter axis all the way to the chip, the ABNT citation and the CSV, because the planted half is ~5× the native one and a total that mixes them silently would be a wrong number wearing a right label. The URL param is `tb`; the retired `or=extrativa|silvicultura` is still decoded for old permalinks. Spec: **`PLANS/silvicultura_source.md`**. **The sub-UF geography cascade** (classic mesorregião/microrregião + 2017 região intermediária/imediata + live município, for the IBGE bancos `ibge_pevs`/`ibge_pam`/`ibge_ppm`) is the exception to the mart pattern — too fine to pre-aggregate: it reads `gold_<source>_production` directly via TWO city-scoped, `maximum_bytes_billed`-guarded readers — `POST /api/municipio-yearly` (the per-(município, year) cube) and `POST /api/products-by-municipio` (what those municípios PRODUCE; the cube groups by city and sums the produtos away, so it cannot name them) — with the static IBGE municipal mesh universe served once from `dim_geo_municipio` via `GET /api/geo-mesh`. Both require a non-empty `cityCodes` body: the city scope IS the cost control on a direct Gold read.

## Skills available

Each skill in `.claude/skills/` provides deep context for a specific workflow. Claude Code loads them on demand by matching the task description.

| Skill | When to use |
|-------|------------|
| `dbt-workflow` | Create/modify dbt models, run transforms, understand Silver/Gold patterns |
| `lint-and-test` | Run ruff, pytest, sqlfluff, or pre-commit hooks |
| `ingest-data` | Ingest from IBGE/BCB, add products or series, debug pipelines |
| `bigquery-debug` | Debug BQ errors (404/403/400), inspect data, diagnostic queries |
| `code-audit` | Strategic health audit: complexity, maintainability, coverage (run periodically, not on every change) |

> The frontend-specific skills (`run-dashboard`, `dash-page-scaffold`, `new-chart-component`, `deploy-cloud-run`) were removed alongside the old Dash UI. New UI-related skills will be (re)introduced as part of the Claude Design System handoff.

## Migration history

One-time migration notes (Bronze re-partitioning, Gold schema changes, column renames) are archived in `docs/migration_history.md`.
