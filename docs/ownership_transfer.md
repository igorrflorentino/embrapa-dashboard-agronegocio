# Ownership transfer to the company

This project was designed to be portable: nothing in the code hardcodes the `GCP_PROJECT_ID` or the bucket name. Everything flows via `.env`.

## Migration checklist

1. **GitHub** — transfer the repository to the company's organization under *Settings → Transfer ownership*. Collaborators and history are preserved.
2. **New GCP project** — create a project inside the company's org, for example `embrapa-produtos-agricolas-prod`. Enable the APIs: BigQuery, Cloud Storage, IAM.
3. **Local permissions (dev)** — each engineer runs once: `gcloud auth application-default login`.
4. **Company `.env`** — copy `.env.example` and update:
   ```
   GCP_PROJECT_ID=embrapa-produtos-agricolas-prod
   GCS_BUCKET=embrapa-produtos-agricolas-prod-datalake
   BQ_LOCATION=southamerica-east1   # or US, depending on company policy
   ```
5. **Company `profiles.yml`** — copy `dbt/profiles.yml.example` to `~/.dbt/profiles.yml` and swap `project:` for the new project.
6. **First load** — `uv run embrapa ingest all` automatically creates the bucket and the `bronze_ibge` / `bronze_bcb` / `bronze_foreign` / `bronze_comex` / `bronze_pam` / `bronze_ppm` / `bronze_comtrade` datasets in the new project (PAM and PPM are excluded from `all` — run `uv run embrapa ingest ibge-pam` and `ingest ibge-ppm` separately; COMTRADE is also left out of `all` — it is key-gated; run `uv run embrapa ingest comtrade` separately).
7. **First transformation** — `make dbt-build` materializes Silver and Gold.
8. **Looker Studio** — duplicate the existing report and repoint the data source to `embrapa-produtos-agricolas-prod.gold.gold_pevs_production`.

## When to migrate orchestration to the cloud

Today the MVP runs locally. When the company requires scheduling, I recommend, in order of complexity:

1. **GitHub Actions + Workload Identity Federation** — free (or ~$0 for small private repos). Add a workflow at `.github/workflows/ingest.yml` running `uv run embrapa ingest all` on a daily cron; auth to GCP via WIF removes the need for service account keys.
2. **Cloud Run Jobs + Cloud Scheduler** — package the Python package as a container and trigger it via cron. All within GCP.
3. **Cloud Composer (Airflow)** — only if the company already maintains a Composer cluster; the fixed cost (~$300/month) is not worth it for this volume.

In any case, the code does not change — only the trigger.

## Least-privilege IAM for the production service account

| Role | Resource | Rationale |
|---|---|---|
| `roles/bigquery.dataEditor` | datasets `bronze_*`, `silver`, `gold` | writing the tables |
| `roles/bigquery.jobUser` | project | creating load and query jobs |
| `roles/storage.objectAdmin` | bucket `${project}-datalake` | writing the raw Parquet |

## Cold-storage backup of Gold (operator responsibility)

The `embrapa backup-gold` command exports all Gold tables (it introspects the
dataset by the `gold_` prefix; six today) to
`gs://${GCS_BUCKET}/backups/run=<timestamp>/...` in Parquet. It does **not**
run automatically after `make dbt-build-prod` — this is intentional, so that
experimental prod builds do not inflate the snapshot bucket.

**Recommended path:** use `make dbt-build-prod-with-backup` instead of
plain `make dbt-build-prod` whenever the result is worth preserving
(schema release, new product code, anything you would want to be
able to roll back). Plain `make dbt-build-prod` remains
available for throwaway iterations.

**Recommended cadence:** at minimum **once per release boundary** —
that is, whenever something in Gold's behavior or schema changes in a
way observable by Looker Studio / the dashboard. On projects with
weekly ingestion, the practical pattern is to run the `-with-backup` path on the
final Friday of each sprint.

**Automatic retention:** the GCS lifecycle applied to the
`backups/` prefix does:

| Age | Action |
|---|---|
| 30 days | Transition to `NEARLINE` |
| 90 days | Transition to `COLDLINE` |
| 365 days | `DELETE` |

(Configured in `src/embrapa_dashboard/gcp/storage.py` and applied at
bucket creation — the `landing/` prefix follows a separate lifecycle that
ends in `ARCHIVE`, with no delete.)

**Monitoring:** `uv run embrapa doctor` includes a
`Gold backup freshness` check that emits a warning if the most recent snapshot
is more than `BACKUP_STALENESS_DAYS` (default 14) days old, and fails
explicitly when no snapshot exists.
