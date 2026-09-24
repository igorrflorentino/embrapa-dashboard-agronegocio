# Testing Guide

Comprehensive testing for the development environment setup.

> ℹ️ **Scope.** This guide covers the backend (ingest + dbt + CLI). The React SPA (`frontend/`) shipped in the 2026-06 Dash→React migration and brings its own test suite: Vitest, run by the `frontend` job in `.github/workflows/ci.yml` (`cd frontend && npm test`). The old Dash UI tests (Dash smoke test, Playwright visual check) were removed on 2026-05-29 alongside the Dash layer.
>
> ⚠️ **Run the frontend suite on the node version in `/.nvmrc` (24).** It is the single source of truth CI and `deploy/webapi/Dockerfile` also use. On a newer node the suite fails in ways that have nothing to do with your change — node 25, for example, fails all 36 `AppShell` tests with `localStorage.removeItem is not a function`, a jsdom interaction, while CI stays green. With `nvm`/`fnm`, `nvm use` in the repo root picks it up. Without a version manager on macOS: `brew install node@24` (keg-only — it does NOT touch your global node) and prefix the run with `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

## Quick Test

Run all environment validation tests in one command:

### macOS / Linux
```bash
./test.sh
```

### Windows
```cmd
test.bat
```

### Or directly with Python
```bash
python3 scripts/test_setup.py
```

## What Gets Tested

The test suite validates critical components across 9 categories. The exact
count varies by auth mode (~27 in enterprise / impersonation mode, ~31 in
legacy keyfile mode):

### 1️⃣ File Existence (8 checks)
- ✅ `.env` file exists
- ✅ `~/.dbt/profiles.yml` exists
- ✅ Bootstrap scripts present: `setup.sh`, `setup.bat`, `setup.ps1`, `scripts/setup_dev_env.py`
- ✅ `docs/setup.md` present
- ✅ `.gcp-credentials.json` — required in legacy mode, optional in enterprise mode

### 2️⃣ Environment Configuration (7 checks)
- ✅ `.env` file is readable
- ✅ Required config keys present:
  - `GCP_PROJECT_ID`
  - `GCS_BUCKET`
  - `BQ_LOCATION`
  - `BQ_BRONZE_IBGE_DATASET`
  - `BCB_INFLATION_SERIES`
  - `IBGE_PRODUCT_CODES`

### 3️⃣ GCP Credentials (1–5 checks)
- **Legacy:** Credentials file is valid JSON + required fields (`project_id`, `private_key`, `client_email`, `type`)
- **Enterprise:** Application Default Credentials (ADC) reachable via `gcloud auth application-default print-access-token`

### 4️⃣ dbt Configuration (6 checks)
- ✅ `profiles.yml` is readable
- ✅ Required sections present:
  - `embrapa_dashboard:`
  - `dev:` and `prod:` targets
  - `type: bigquery`
  - `method: service-account` (legacy) **or** `method: oauth` (enterprise)

### 5️⃣ Python & Dependencies (1 test)
- ✅ Python >= 3.8 available

### 6️⃣ Build Tools (1 test)
- ✅ `uv` command available and working

### 7️⃣ dbt (1 test)
- ✅ `dbt` accessible via `uv run`

### 8️⃣ Embrapa Pipeline (1 test)
- ✅ `embrapa doctor` passes all checks:
  - `.env` parsed ✓
  - GCP credentials accessible ✓
  - BigQuery reachable ✓
  - GCS bucket accessible ✓
  - IBGE SIDRA API reachable ✓
  - IBGE PAM SIDRA (5457) reachable ✓
  - PAM variable codes ✓
  - IBGE PPM SIDRA (3939+74) reachable ✓
  - BCB SGS API reachable ✓
  - COMEX Stat (MDIC) reachable ✓
  - UN Comtrade API reachable ✓
  - Bronze tables present ✓

### 9️⃣ BigQuery Connection (1 test)
- ✅ `dbt debug` succeeds:
  - Service account authentication ✓
  - BigQuery connection OK ✓
  - Schema and dataset accessible ✓

## Test Output Example

```
============================================================
  1️⃣  File Existence Tests
============================================================

  ➜ File exists: .env... ✅
  ➜ File exists: .gcp-credentials.json... ✅
  ...

============================================================
  📊 Test Summary
============================================================

Total: 27 tests
Passed: 27 ✅
Failed: 0 ❌

🎉 All tests passed! Environment is ready.
```

## Exit Codes

- **0** — All tests passed ✅
- **1** — One or more tests failed ❌

## Troubleshooting

### Test Fails: "File exists: .env"
Run setup again:
```bash
./setup.sh
```

### Test Fails: "Config key present: GCP_PROJECT_ID"
Edit `.env` and ensure all required keys are present. See CLAUDE.md for defaults.

### Test Fails: "GCP Credentials"
The credentials file is invalid JSON. Verify:
1. File is valid JSON (use https://jsonlint.com/)
2. All required fields are present
3. No special characters in file path

### Test Fails: "dbt debug (BigQuery connection)"
This usually means:
1. Service account doesn't have BigQuery permissions
2. Credentials file path is wrong in `profiles.yml`
3. Network connectivity issue

Check permissions in Google Cloud Console:
- IAM & Admin → IAM
- Find service account
- Verify roles: `BigQuery Data Editor` and `Storage Object Creator`

### Test Fails: "embrapa doctor"
Run manually to see detailed output:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/.gcp-credentials.json
uv run embrapa doctor
```

## Python unit tests

The backend unit suite (in `tests/`) runs credential-free against mocked
HTTP/GCP clients and is the gate that `make test` enforces:

```bash
make test                                # all tests (pytest)
uv run pytest tests/test_ibge_client.py  # single test file
uv run pytest -k "config"                # tests matching a keyword
```

GitHub Actions runs the same `make test` step on every PR (see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

### Not everything is mocked — on purpose

- **The IAP signature check runs for real.** `tests/test_iap_real_signature.py` serves an
  ES256 key in IAP's own format (`{kid: PEM}`) from a loopback HTTP server and drives
  `serving.iap.verify_iap_jwt` through google-auth → `cryptography`: one genuine token
  accepted, five forged or stale ones refused. Every other IAP test mocks `verify_token`,
  which is why the crypto stack that decides who authored a curation edit had never been
  exercised — until v1.88.2 upgraded it. Still offline and credential-free.
- **Some tests run a shell script under bash, and are SKIPPED on Windows** (CI is Linux, so
  they always run there): `test_dbt_prod_vars.py` executes the `dbt build prod` step of the
  workflow with `dbt` swapped for `printf`, `test_ingestion_deploy_env.py` runs
  `deploy/ingestion/deploy.sh`'s own shell, and one test in `test_foreign_inflation_gate.py`
  needs GNU make. "N skipped" locally on Windows is expected. A green local run is NOT
  proof for them, only the CI run is.

### The two coverage layers, and why one number was not enough

**Layer 1 — the absolute floor (`make test`, `--cov-fail-under=98`).** Its job is to stop
*silent decay*, not to police individual PRs. It sits at 98, not 99, on purpose: the floor
is **proportional to repo size**, so at ~6.8k statements a 99% threshold left only ~7 lines
of headroom and a single defensive `except` could block a merge. A gate that blocks
routinely gets lowered in a hurry — which is how it went decorative before (see below). 98
still catches an untested feature of ~77 statements while ignoring one-line noise.

> ⚠️ **`precision = 2` in `pyproject.toml` is load-bearing — do not remove it.** coverage
> decides with `round(total, precision) < fail_under`, and precision **defaults to 0**. With
> the default, `--cov-fail-under=98` silently accepts anything ≥97.5%, and the log prints a
> `FAIL Required test coverage not reached` line that *never touches the exit code*. Measured
> 2026-08-20: **0.38% coverage still exited 0** while CI stayed green (v1.24.27).

**Layer 2 — patch coverage (`make coverage-diff`).** This is the one that actually enforces
*"you wrote code, you wrote tests"*:

```bash
make test            # produces coverage.xml
make coverage-diff   # ≥90% of the lines THIS branch changed must be covered
```

A floor asks "is the whole repo still well covered?" — a question that gets **weaker as the
repo grows**, since the same untested feature moves the total less every month. Patch
coverage asks "did you test what you just wrote?", which does not decay, and it never
charges a PR for pre-existing gaps it did not create (e.g. the ~20 uncovered lines in the
**frozen** `serving/attribute_engineering.py`).

The two are complementary, and the gap is easy to demonstrate: adding 6 untested lines moves
the total from 99.12% to 99.04% — the **floor passes**, and **patch coverage fails at 16%**.

CI runs layer 2 on pull requests only (on a push to `main` the diff is what was just merged
and already checked). Override the base for a stacked branch:

```bash
make coverage-diff COMPARE_BRANCH=origin/feat/my-base
```

## Manual Testing

Beyond automated tests, you can verify functionality manually:

### Test dbt
```bash
# Validate dbt configuration
make dbt-test

# Build dev models
make dbt-build

# Or run specific dbt command
uv run dbt run --select silver_ibge_pevs
```

Until v1.88.7 a dev build ended with **exit code 2 after `Done. PASS=… ERROR=0`**: the
`apply_dev_ttl` hook ALTERed the `dbt_dev_*` datasets unconditionally, which needs a
permission the dev identities lack. It now only ALTERs a dataset whose TTL is missing or
different, so a clean build exits 0, and an exit 2 means something really failed (see
[`docs/iam_setup.md`](iam_setup.md) §2.1).

### Validating a dbt / BigQuery-adapter upgrade

A green CI proves the project **compiles** under the new version. It does not prove the numbers
are the same. For a `dbt-core` or `dbt-bigquery` bump (the adapter writes the SQL of every
materialization), compare a full dev build against prod built from the SAME Bronze, before
the merge. This is how #476 (dbt-core 1.12) and #481 (dbt-bigquery 1.12.1) were validated:

1. Install the PR's lock (`gh pr checkout <n>` + `uv sync --frozen --all-extras`) and run a
   full dev build with the prod vars in ONE mapping:
   `bash scripts/dbt-with-env.sh build --target dev --vars '{enable_curation: true, enable_foreign_inflation: true}'`.
   Make sure no ingestion ran between the last prod build and this one.
2. **Metadata (free):** compare `row_count` / `size_bytes` of `dbt_dev_{silver,gold,serving}.__TABLES__`
   against `{silver,gold,serving}.__TABLES__`. Tables present only in prod can be leftovers of
   removed models (check that no file in `dbt/` still produces them).
3. **Content:** per table, `SELECT BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t)))` over all
   columns except `last_refresh`, on each side (~14 GiB billed for the whole project). Equal
   fingerprints mean identical content.
4. **For tables whose fingerprint differs:** join dev and prod on every non-FLOAT64 column,
   and per FLOAT64 column take `max(abs(dev - prod) / abs(prod))`, counting rows above 1e-9
   and nulls present on one side only. Expect differences around 1e-15 in the Gold facts and
   marts. BigQuery's parallel AVG/SUM (the yearly FX mean, the mart aggregates) varies in the
   last bit between ANY two builds, so that is noise. Anything above 1e-9, a row with no
   partner, or a changed non-float column (e.g. `data_quality_flag`) is a real change.

### Test ingestion
```bash
# Simulate ingestion (dry-run)
uv run embrapa ingest ibge --help

# Test IBGE discovery
uv run embrapa discover ibge-periods --table-id 289

# Test BCB discovery
uv run embrapa discover bcb-series 433
```

### Test database connectivity
```bash
# Test BigQuery directly (connection + auth)
cd dbt && uv run dbt debug
```

## CI/CD Integration

These tests can be integrated into CI/CD pipelines:

```bash
#!/bin/bash
# GitHub Actions example
- name: Test environment setup
  run: python3 scripts/test_setup.py
```

## Test Coverage

| Component | Type | Status |
|-----------|------|--------|
| File structure | Static | ✅ Automated |
| Configuration | Static | ✅ Automated |
| Credentials | Static + Dynamic | ✅ Automated |
| Python/uv | Environment | ✅ Automated |
| dbt | Tool | ✅ Automated |
| BigQuery | Network | ✅ Automated |
| GCS | Network | ✅ Automated (via embrapa doctor) |
| Ingestion | Integration | ⚠️ Manual only |
| dbt models | Integration | ⚠️ Manual only |

## Next Steps After Testing

If all tests pass, you're ready to:

1. **Run the pipeline:** `make dbt-build`
2. **Test ingestion:** `uv run embrapa ingest ibge`
3. **Monitor pipeline:** `uv run embrapa monitor`
4. **Start development:** Create your feature branch

## Additional Resources

- **setup.md** — Environment setup documentation
- **CLAUDE.md** — Project architecture and commands
- **scripts/setup_dev_env.py** — Setup script (see for test implementation)
- **scripts/test_setup.py** — Test script source code

## Support

For test failures or questions:
1. Check testing.md troubleshooting section
2. Review setup.md for setup issues
3. Check CLAUDE.md for architecture details
4. Open GitHub issue if problem persists
