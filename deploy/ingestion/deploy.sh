#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build + deploy the `embrapa ingest all` Cloud Run JOB (batch, not a Service).
#
# Reads config from the repo-root .env (the project's single source of truth).
# Idempotent: re-running rebuilds the image and updates the job in place.
#
# Prereqs:
#   - gcloud authenticated, project APIs enabled: run, cloudbuild,
#     artifactregistry (cloudscheduler for schedule.sh).
#   - The ingestion SA exists (default sa-data-pipeline-prod) with write access
#     to GCS + BigQuery. See docs/iam_setup.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (copy .env.example → .env)"; exit 1; }

# Read a single value from .env without sourcing it (avoids bash interpreting
# odd values); strips a trailing CR so Windows CRLF files work too.
# `|| true`: a key absent from .env (e.g. optional COMTRADE_KEY_SECRET) must
# return empty, not crash the script under `set -euo pipefail` (grep exits 1 on
# no match, which pipefail would propagate). Mirrors schedule_*.sh's get_env.
get_env() { { grep -E "^$1=" "$ENV_FILE" || true; } | head -n1 | cut -d= -f2- | tr -d '\r'; }

# Resolve the Cloud Run region. Cloud Run requires a SINGLE region (e.g.
# us-central1) and rejects a BigQuery multi-region locator like "US"/"EU" —
# `gcloud run jobs deploy --region US` fails. So INGEST_JOB_REGION is a
# first-class input, DECOUPLED from BQ_LOCATION, defaulting to us-central1.
# As a convenience, an explicitly-set multi-region locator is mapped to a
# concrete region; a bare/unmapped multi-region is rejected with a clear error
# rather than passed through to gcloud (which would fail cryptically).
resolve_region() {
  local r="${INGEST_JOB_REGION:-}"
  if [ -z "$r" ]; then
    echo us-central1
    return 0
  fi
  case "$r" in
    US|us) echo us-central1 ;;       # BigQuery "US" multi-region → default Cloud Run region
    EU|eu) echo europe-west1 ;;      # BigQuery "EU" multi-region → a concrete EU region
    *-*)   echo "$r" ;;              # already a concrete region (has a hyphen, e.g. us-east1)
    *)
      echo "ERROR: INGEST_JOB_REGION='$r' is not a Cloud Run region. Cloud Run needs a" >&2
      echo "       single region (e.g. us-central1, europe-west1), not a multi-region." >&2
      echo "       Set INGEST_JOB_REGION explicitly in .env (it is decoupled from BQ_LOCATION)." >&2
      exit 1
      ;;
  esac
}

PROJECT="${GCP_PROJECT_ID:-$(get_env GCP_PROJECT_ID)}"
[ -n "$PROJECT" ] || { echo "ERROR: GCP_PROJECT_ID not set"; exit 1; }
REGION="$(INGEST_JOB_REGION="${INGEST_JOB_REGION:-$(get_env INGEST_JOB_REGION)}" resolve_region)"
JOB_NAME="${INGEST_JOB_NAME:-embrapa-ingest-all}"
AR_REPO="${INGEST_JOB_AR_REPO:-embrapa-jobs}"
INGEST_SA="${INGEST_JOB_SA:-sa-data-pipeline-prod@${PROJECT}.iam.gserviceaccount.com}"
# Image tag = explicit INGEST_JOB_TAG, else the current git SHA — never a silent
# ':latest' fallback when git can't resolve a SHA, which would deploy an unintended
# image (INFRA-3, mirrors deploy/webapi/deploy.sh).
if [ -n "${INGEST_JOB_TAG:-}" ]; then
  TAG="$INGEST_JOB_TAG"
else
  TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  [ -n "$TAG" ] || { echo "ERROR: cannot resolve a git SHA for the image tag and INGEST_JOB_TAG is unset; set INGEST_JOB_TAG explicitly (refusing to deploy the mutable ':latest')." >&2; exit 1; }
fi
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${JOB_NAME}:${TAG}"
TASK_TIMEOUT="${INGEST_JOB_TASK_TIMEOUT:-3600s}"
MEMORY="${INGEST_JOB_MEMORY:-2Gi}"
CPU="${INGEST_JOB_CPU:-1}"

echo "Project=$PROJECT  Region=$REGION  Job=$JOB_NAME"
echo "Image=$IMAGE"
echo "Runtime SA=$INGEST_SA"

# 1) Artifact Registry repo (idempotent).
if ! gcloud artifacts repositories describe "$AR_REPO" \
      --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  echo "Creating Artifact Registry repo '$AR_REPO'…"
  gcloud artifacts repositories create "$AR_REPO" --repository-format docker \
    --location "$REGION" --project "$PROJECT" \
    --description "Embrapa Cloud Run job images"
fi

# 2) Build + push the image via Cloud Build (no local Docker required).
echo "Building image via Cloud Build…"
gcloud builds submit "$REPO_ROOT" --project "$PROJECT" \
  --config "$REPO_ROOT/deploy/ingestion/cloudbuild.yaml" \
  --substitutions "_IMAGE=${IMAGE}"

# 3) Build the Job env vars from .env via an EXPLICIT ALLOWLIST — forward ONLY
#    the keys `embrapa ingest all` actually reads, not the whole .env. The job
#    runs AS the ingestion SA (no impersonation, no API key) and is a batch with
#    no UI, so the serving/cache/dbt and deploy-time INGEST_*/INGEST_SCHEDULE_*
#    vars are irrelevant to it; shipping them would only leak config surface
#    into the Job's environment. COMTRADE is excluded from `ingest all`
#    (key-gated), so its Bronze/scope vars are omitted too. A YAML file handles
#    values with commas/colons (e.g. BCB_INFLATION_SERIES=433:IPCA,189:IGPM).
#
# Allowlist (anchored, prefix-based so new per-source knobs are auto-covered):
#   GCP_PROJECT_ID, GCS_*                       — project + landing/raw bucket + prefixes
#   BQ_LOCATION                                 — dataset region
#   BQ_BRONZE_{IBGE,PAM,PPM,BCB,COMEX,FOREIGN}_* — Bronze dataset/table names for the
#                                                 sources `all` runs + PAM/PPM (their own
#                                                 monthly triggers; NOT COMTRADE: key-gated)
#   IBGE_* / PAM_* / PPM_* / BCB_* / COMEX_*    — per-source scope (codes, years, flows, delta)
#   FOREIGN_INFLATION_* + {BLS,ECB}_API_BASE_URL — the foreign deflators (US CPI-U · euro-area
#                                                 HICP), which ride `ingest all`. BLS_API_KEY is
#                                                 deliberately NOT forwarded: it is optional, and
#                                                 the keyless v1 endpoint covers this Job's load
#                                                 (6 requests for a full backfill, 1 per delta
#                                                 run, against a 25/day cap). Keeping it out
#                                                 leaves the Job's secret surface unchanged.
#   CATALOG_* + BQ_RESEARCH_INPUTS_DATASET/BQ_PRODUTO_CATALOG_LOG_TABLE — catalog-driven
#                                                 ingestion: the CATALOG_AUTHORITATIVE_INGESTION
#                                                 flag + safety cap, and the catalog log the
#                                                 resolver reads (defaults work; forwarded so a
#                                                 non-default .env dataset/table still resolves)
# PAM_*/PPM_* are forwarded even though PAM/PPM are out of `ingest all` (in_all=False):
# their monthly schedulers override args to `ibge-pam`/`ibge-ppm`, and the Job must carry
# their PRODUCT_CODES / START_YEAR / … for those runs to use your .env scope.
INGEST_ALLOWLIST='^(GCP_PROJECT_ID|GCS_[A-Z0-9_]+|BQ_LOCATION|BQ_BRONZE_(IBGE|PAM|PPM|BCB|COMEX|FOREIGN)_[A-Z0-9_]+|BQ_RESEARCH_INPUTS_DATASET|BQ_PRODUTO_CATALOG_LOG_TABLE|CATALOG_[A-Z0-9_]+|IBGE_[A-Z0-9_]+|PAM_[A-Z0-9_]+|PPM_[A-Z0-9_]+|BCB_[A-Z0-9_]+|COMEX_[A-Z0-9_]+|FOREIGN_INFLATION_[A-Z0-9_]+|(BLS|ECB)_API_BASE_URL)='
ENV_YAML="$(mktemp)"; trap 'rm -f "$ENV_YAML"' EXIT
grep -E "$INGEST_ALLOWLIST" "$ENV_FILE" \
  | while IFS='=' read -r key val; do
      printf "%s: '%s'\n" "$key" "$(printf '%s' "$val" | tr -d '\r')"
    done > "$ENV_YAML"
[ -s "$ENV_YAML" ] || { echo "ERROR: no ingestion config matched in $ENV_FILE (check GCP_PROJECT_ID etc.)"; exit 1; }

# 3b) OPTIONAL — UN Comtrade backfill support. Comtrade is key-gated and excluded
#     from the nightly `all` (cli.IngestSpec in_all=False), so its scope vars + key
#     are NOT forwarded by default. When COMTRADE_KEY_SECRET names a Secret
#     Manager secret holding the UN key, ALSO forward the COMTRADE_* / Bronze
#     config and mount the key as a secret env var — so the Job can run
#     `embrapa ingest comtrade` (driven by schedule_comtrade.sh). The key itself
#     never touches .env or this script: it lives only in Secret Manager.
COMTRADE_SECRET="${COMTRADE_KEY_SECRET:-$(get_env COMTRADE_KEY_SECRET)}"
if [ -n "$COMTRADE_SECRET" ]; then
  echo "Comtrade enabled: forwarding COMTRADE_* config + mounting key from secret '$COMTRADE_SECRET'."
  # Append Comtrade scope/Bronze config (NOT the key — that comes from the secret).
  grep -E '^(BQ_BRONZE_COMTRADE_[A-Z0-9_]+|COMTRADE_[A-Z0-9_]+)=' "$ENV_FILE" \
    | grep -vE '^COMTRADE_API_KEY=' \
    | while IFS='=' read -r key val; do
        printf "%s: '%s'\n" "$key" "$(printf '%s' "$val" | tr -d '\r')"
      done >> "$ENV_YAML"
fi

# 4) Deploy / update the Cloud Run Job (create-or-update).
echo "Deploying Cloud Run Job…"
gcloud run jobs deploy "$JOB_NAME" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$INGEST_SA" \
  --env-vars-file "$ENV_YAML" \
  --task-timeout "$TASK_TIMEOUT" \
  --max-retries 2 \
  --memory "$MEMORY" \
  --cpu "$CPU" \
  ${COMTRADE_SECRET:+--set-secrets COMTRADE_API_KEY=${COMTRADE_SECRET}:latest}

cat <<EOF

Done. The job is deployed but NOT yet scheduled.
  Run once now:   gcloud run jobs execute $JOB_NAME --region $REGION --project $PROJECT
  Schedule nightly: deploy/ingestion/schedule.sh   (or: make ingest-job-schedule)
EOF
