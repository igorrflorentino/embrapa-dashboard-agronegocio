#!/bin/bash
# Setup Google Cloud service account for Claude Code Web development.
# Run this once per GCP project to create a limited-scope dev account.
#
# Usage:
#   bash scripts/setup-claude-code-web-sa.sh
#
# Output: JSON keyfile at scripts/sa-claude-code-web-dev-key.json
#         (Base64 encode and paste into Claude Code Web env vars)

set -e

PROJECT_ID="${GCP_PROJECT_ID:-embrapa-dashboard-commodities}"

echo "Setting up sa-claude-code-web-dev in project: $PROJECT_ID"
echo ""

# 1. Create service account
echo "[1/5] Creating service account..."
gcloud iam service-accounts create sa-claude-code-web-dev \
  --project="$PROJECT_ID" \
  --display-name="Claude Code Web Development" \
  --description="Limited-scope dev account for Claude Code Web sandbox (dbt_dev only, no prod access)"

SA_EMAIL="sa-claude-code-web-dev@${PROJECT_ID}.iam.gserviceaccount.com"
echo "✅ Created: $SA_EMAIL"
echo ""

# 2. Grant BigQuery read-only on all project data.
#    NOT dataEditor: a project-wide dataEditor would let this "dbt_dev only, no
#    prod access" SA WRITE/DELETE prod silver/gold — directly contradicting its
#    own scope, so a leaked key = full prod-data write. dataViewer is read-only
#    and lets the dev build read Bronze sources (and inspect prod for debugging)
#    without being able to mutate any dataset.
echo "[2/5] Granting BigQuery dataViewer (project read-only)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/bigquery.dataViewer" \
  --quiet

echo "✅ Granted BigQuery data viewer (read-only) role"
echo ""

# 3. Grant BigQuery user (run jobs + create datasets). The SA becomes OWNER of the
#    dbt_dev_* datasets it creates, so it has full read/write on its OWN dev
#    sandbox — but NO write to prod datasets it didn't create. This is the
#    dev-write path that replaces the project-wide dataEditor above (and it
#    subsumes jobUser, so no separate jobUser grant is needed).
echo "[3/5] Granting BigQuery user (jobs + own-dataset create/write)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/bigquery.user" \
  --quiet

echo "✅ Granted BigQuery user role"
echo ""

# 4. Grant GCS access to the landing bucket.
#    objectViewer (read-only) is NOT enough: this SA runs `backup-gold` and the raw
#    ingestion archive, which WRITE objects. Hence objectUser.
#
#    And objectUser alone is still not enough, which is the non-obvious part: it grants
#    NO bucket-level permission at all (`gcloud iam roles describe roles/storage.objectUser`
#    — not one storage.buckets.*). But ensure_bucket() calls bucket.exists() and
#    bucket.reload() (storage.buckets.get) on EVERY backup and EVERY ingestion, and patches
#    lifecycle/versioning when they drift (storage.buckets.update). Object roles alone break
#    both at the first call, before a byte is written. Hence the tiny custom role below.
#
#    NOT storage.admin, which this bucket carried until 2026-09-09: it let a DEV identity
#    delete the bucket holding the Gold + research_inputs backups, and rewrite its IAM and
#    retention. See docs/iam_setup.md §2.5.
echo "[4/5] Granting GCS permissions (objects RW + minimal bucket config)..."
BUCKET="${PROJECT_ID}-datalake"
BUCKET_ROLE="bucketConfigReaderWriter"

gcloud iam roles create "$BUCKET_ROLE" \
  --project="$PROJECT_ID" \
  --title="Bucket config get/update" \
  --description="storage.buckets.get + update — the minimum ensure_bucket() requires." \
  --permissions=storage.buckets.get,storage.buckets.update \
  --stage=GA --quiet 2>/dev/null || echo "   (custom role already exists — reusing)"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.objectUser" \
  --quiet 2>/dev/null || true

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="projects/${PROJECT_ID}/roles/${BUCKET_ROLE}" \
  --quiet 2>/dev/null || true

echo "✅ Granted GCS object RW + bucket config"
echo ""

# 4b. The dev WRITE path. Step 3's comment says the SA "becomes OWNER of the dbt_dev_*
#     datasets it creates" — true only for datasets IT creates. Where a human operator
#     already created them, the SA owns none of them and bigquery.user does not reach them,
#     so the dev build fails on write. An explicit dataset WRITER entry is required for each
#     pre-existing dataset. This was invisible for as long as a project-wide dataEditor was
#     masking it.
echo "[4b/5] Granting WRITER on any pre-existing dbt_dev_* datasets..."
for DS in dbt_dev_silver dbt_dev_gold dbt_dev_serving; do
  if bq show --project_id="$PROJECT_ID" "$DS" >/dev/null 2>&1; then
    python3 - "$PROJECT_ID" "$DS" "$SA_EMAIL" <<'PYEOF'
import subprocess, json, sys
project, ds, sa = sys.argv[1], sys.argv[2], sys.argv[3]
raw = subprocess.run(["bq", "show", "--project_id", project, "--format=prettyjson", ds],
                     capture_output=True, text=True, check=True).stdout
meta = json.loads(raw)
if any(a.get("userByEmail") == sa for a in meta.get("access", [])):
    print(f"   {ds}: already present")
    sys.exit(0)
meta.setdefault("access", []).append({"role": "WRITER", "userByEmail": sa})
path = f"/tmp/{ds}.acl.json"
json.dump(meta, open(path, "w"))
subprocess.run(["bq", "update", "--project_id", project, "--source", path, ds],
               capture_output=True, check=True)
print(f"   {ds}: WRITER granted")
PYEOF
  else
    echo "   $DS: does not exist yet — the SA will own the one it creates"
  fi
done
echo ""

# 5. Create JSON keyfile
echo "Creating JSON keyfile..."
KEYFILE="scripts/sa-claude-code-web-dev-key.json"
gcloud iam service-accounts keys create "$KEYFILE" \
  --iam-account="$SA_EMAIL" \
  --project="$PROJECT_ID"

echo "✅ Keyfile created: $KEYFILE"
echo ""

# 6. Encode to base64
echo "Encoding to base64 for Claude Code Web env var..."
B64_CONTENT=$(base64 -w 0 < "$KEYFILE")
B64_FILE="scripts/sa-claude-code-web-dev-key.b64"
echo "$B64_CONTENT" > "$B64_FILE"

echo "✅ Base64 encoded: $B64_FILE"
echo ""

# 7. Instructions
echo "════════════════════════════════════════════════════════════════"
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo ""
echo "1. Copy the base64 content to Claude Code Web environment:"
echo "   cat $B64_FILE"
echo ""
echo "2. In Claude Code Web settings → 'Atualizar ambiente de nuvem':"
echo "   - Name: embrapa-dashboard-commodities"
echo "   - Network: Completo"
echo "   - Environment variables:"
echo "     GCP_PROJECT_ID=embrapa-dashboard-commodities"
echo "     GCP_CREDENTIALS_B64=<paste_content_here>"
echo ""
echo "3. Set the setup script to:"
echo "   #!/bin/bash"
echo "   ./init_dev_env.sh || true"
echo ""
echo "4. Open a Claude Code Web session — init_dev_env.sh will bootstrap"
echo "   .env + dbt profile and run scripts/test_setup.py automatically."
echo ""
echo "⚠️  Important:"
echo "   - Keep $KEYFILE and $B64_FILE secret (don't commit!)"
echo "   - If the key leaks, rotate it:"
echo "     gcloud iam service-accounts keys delete <KEY_ID> --iam-account=$SA_EMAIL"
echo "   - Then run this script again to create a new key"
echo ""
echo "════════════════════════════════════════════════════════════════"
