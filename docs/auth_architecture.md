# Enterprise Cloud Architecture

Modern GCP authentication using **Service Account Impersonation** (OAuth) instead of sharing JSON keyfiles.

## Overview

This document describes the **Chain of Trust** security model that eliminates JSON credential files from developer machines while maintaining secure, auditable access to GCP resources.

## The Problem with JSON Keyfiles

Traditional setup required sharing service account JSON files:
- ❌ Files copied via email, Slack, Drive (multiple copies)
- ❌ Developers store files locally (risk of theft/exposure)
- ❌ No audit trail of who accessed what
- ❌ Revocation requires rotating credentials and re-distributing files
- ❌ Difficult to enforce least-privilege access

## The Solution: Service Account Impersonation

OAuth 2.0 with service account impersonation:
- ✅ No JSON keyfiles shared or stored locally
- ✅ Uses `gcloud auth` or browser login (ADC)
- ✅ Complete audit trail in GCP logs
- ✅ Instant revocation via IAM role removal
- ✅ Fine-grained permission control
- ✅ Automatic token refresh

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Developer Machine (Local)                                       │
│                                                                 │
│  ┌──────────────────────────────────────┐                      │
│  │ gcloud auth (Browser/OAuth)          │                      │
│  │ ↓                                    │                      │
│  │ .env (NO CREDENTIALS)                │                      │
│  │ dbt profiles.yml (OAuth method)      │                      │
│  │                                      │                      │
│  │ scripts/setup_dev_env.py             │                      │
│  │ ↓ impersonate                        │                      │
│  │ sa-secret-reader-prod                │                      │
│  └────────────────────┬─────────────────┘                      │
│                       │                                         │
└───────────────────────┼─────────────────────────────────────────┘
                        │ OAuth 2.0
                        │ (Service Account Token Creator)
                        ↓
┌─────────────────────────────────────────────────────────────────┐
│ Google Cloud Project (embrapa-dashboard-commodities)           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Four-Tier Service Account Architecture                  │  │
│  │                                                         │  │
│  │ 1. sa-secret-reader-prod                               │  │
│  │    ├─ Impersonation target for developers              │  │
│  │    ├─ No JSON keyfile distributed                      │  │
│  │    ├─ Used by dbt (BigQuery) and developer workflows   │  │
│  │    └─ Access granted via Token Creator role            │  │
│  │                                                         │  │
│  │ 2. sa-data-pipeline-prod                               │  │
│  │    ├─ Runs ingestion pipelines (IBGE, BCB)            │  │
│  │    ├─ Impersonated by Cloud Run / Cloud Scheduler      │  │
│  │    ├─ Permissions:                                      │  │
│  │    │  - storage.objectCreator (write to GCS)           │  │
│  │    │  - bigquery.dataEditor (load to Bronze)           │  │
│  │    │  - bigquery.jobUser (execute jobs)                │  │
│  │    └─ NO human access                                  │  │
│  │                                                         │  │
│  │ 3. sa-web-dashboard-prod                               │  │
│  │    ├─ Cloud Run dashboard runtime (stateless)          │  │
│  │    ├─ Dataset-scoped least privilege:                  │  │
│  │    │  - bigquery.dataViewer  ON serving (read marts)   │  │
│  │    │  - bigquery.dataEditor  ON research_inputs only   │  │
│  │    │  - bigquery.jobUser     (project, run queries)    │  │
│  │    └─ NO project-wide read; NO write outside curation  │  │
│  │                                                         │  │
│  │ 4. sa-ai-agent-admin-prod                              │  │
│  │    ├─ AI agent administration (Claude, Vertex AI)      │  │
│  │    ├─ Impersonated by AI agents                        │  │
│  │    ├─ Permissions:                                      │  │
│  │    │  - bigquery.dataViewer (project, READ-ONLY)       │  │
│  │    │  - bigquery.jobUser    (project, run queries)     │  │
│  │    │  - bigquery.dataEditor ON one sandbox dataset     │  │
│  │    │  - storage.objectViewer (read GCS)                │  │
│  │    │  - storage.objectCreator (write reports)          │  │
│  │    └─ NO project-wide write (protects gold + curation) │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Chain of Trust

The trust relationship flows downward:

```
                        Organization / Admin
                                ↓
                         (Trusts Service Accounts)
                                ↓
                  sa-secret-reader-prod (impersonation target)
                    ↙    ↓    ↘    ↖
                   /     |     \     \
                  /      |      \     \
         Developer   Cloud Run  Web App  AI Agent
        (impersonate via OAuth with Token Creator role)
```

**Key Principle:** No JSON keyfiles are distributed to developers. All identities are accessed via impersonation (OAuth) with audit trails for every operation. The `sa-secret-reader-prod` service account exists purely as an impersonation target for developer workflows (dbt, BigQuery queries).

## Authentication Flow

### Developer Setup

1. **Developer runs setup:**
   ```bash
   ./setup.sh  # or setup.bat on Windows
   python3 scripts/setup_dev_env.py
   ```

2. **Script detects authentication context:**
   - Checks for gcloud CLI (installed via Cloud SDK)
   - Checks for Application Default Credentials (ADC) from browser login
   - Falls back to GOOGLE_APPLICATION_CREDENTIALS env var → `--credentials-file` arg → manual JSON paste

3. **If impersonation available:**
   - Script validates developer has `iam.serviceAccountTokenCreator` role on `sa-secret-reader-prod`
   - Generates OAuth token valid for ~1 hour
   - Updates dbt profiles to use `method: oauth` with `impersonate_service_account`
   - Sets `GCP_AUTH_METHOD=impersonation` in .env

4. **No JSON keyfile stored locally:**
   - Credentials flow through OAuth 2.0
   - Each API call includes short-lived token
   - Token auto-refreshes before expiration

### dbt Execution with Impersonation

```yaml
# ~/.dbt/profiles.yml (enterprise mode)
embrapa_dashboard:
  target: dev
  outputs:
    dev:
      type: bigquery
      method: oauth                    # Modern: OAuth
      project: embrapa-dashboard-commodities
      impersonate_service_account: sa-secret-reader-prod@{project}.iam.gserviceaccount.com
      dataset: dbt_dev
      # ... rest of config
```

When dbt runs:
1. Reads OAuth token from gcloud's cached credentials
2. Uses token to call BigQuery APIs
3. BigQuery validates token has `iam.serviceAccountTokenCreator` on `sa-secret-reader-prod`
4. BigQuery executes query as if run by `sa-secret-reader-prod`
5. All actions logged to GCP audit logs with developer's identity + impersonated SA

### Python Client (Data Pipelines)

```python
from google.auth import default
from google.auth import impersonated_credentials

# Use developer OAuth (ADC) to impersonate sa-data-pipeline-prod
source_creds, _ = default()
credentials = impersonated_credentials.Credentials(
    source_credentials=source_creds,
    target_principal=f"sa-data-pipeline-prod@{project}.iam.gserviceaccount.com",
    target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
)

# Use impersonated credentials for BigQuery/GCS
client = bigquery.Client(credentials=credentials, project=project)
```

## IAM Permission Structure

### Developer Role Assignment

**For service account impersonation to work, each developer must have:**

```
Project: embrapa-dashboard-commodities

Role on sa-secret-reader-prod:
  - roles/iam.serviceAccountTokenCreator
    (allows impersonation)

  - roles/iam.serviceAccountUser
    (required by some integrations)
```

**NOT needed anymore:**
- ❌ `roles/owner` or `roles/editor`
- ❌ `roles/bigquery.admin`
- ❌ Direct storage access
- ❌ JSON keyfile

### Service Account Role Assignments

| Service Account | Roles | Purpose |
|---|---|---|
| `sa-secret-reader-prod` | `roles/bigquery.dataEditor`<br/>`roles/bigquery.jobUser`<br/>`roles/storage.objectViewer`<br/>**NOT** `secretmanager.secretAccessor`, despite the name ([iam_setup §2.1](iam_setup.md)) | Impersonation target for developers (dbt + ad-hoc queries) |
| `sa-data-pipeline-prod` | `roles/storage.objectCreator`<br/>`roles/bigquery.dataEditor`<br/>`roles/bigquery.jobUser` | Ingest data (IBGE, BCB) |
| `sa-web-dashboard-prod` | `roles/bigquery.dataViewer` **on `serving`**<br/>`roles/bigquery.dataEditor` **on `research_inputs`**<br/>`roles/bigquery.jobUser` (project) | Dataset-scoped least privilege for the Cloud Run dashboard: read marts, append curation log — **not** project-wide on Gold. Looker Studio uses end-user OAuth, not this SA. |
| `sa-ai-agent-admin-prod` | `roles/bigquery.dataViewer` (project, read-only)<br/>`roles/bigquery.jobUser` (project)<br/>`roles/bigquery.dataEditor` **on one sandbox dataset only**<br/>`roles/storage.objectCreator` | Read-only analysis; writes confined to a report sandbox (never Gold prod / the curation log) |

## Dashboard ingress — Cloud Run direct IAP (HARD REQUIREMENT)

> Applies to the Cloud Run **Service** (the React SPA + Flask REST dashboard,
> `deploy/webapi/`), not the ingestion Job. The Service is live on Cloud Run, and
> the IAP posture below is a **non-negotiable deploy-time requirement** the
> operator must satisfy on every deploy.
>
> **Zero fixed cost (scale-to-zero).** This is an experimental project that must
> not bill when idle, so auth uses **Cloud Run _direct_ IAP** — which is **free** —
> and **NOT** an external HTTPS Load Balancer (an LB carries a fixed ~US$18+/mo
> charge even at zero traffic). There is currently **no load balancer**. The
> LB + IAP arrangement is a **future-only expansion**, added solely when the
> project is explicitly instructed to migrate (see § _Future expansion only_ at the
> end of this section, and the scale-to-zero rule in [`cost_safety.md`](cost_safety.md)).

The dashboard derives the audit field `edited_by` (who classified a commodity in
the append-only curation log) **solely** from the IAP-injected request header
`X-Goog-Authenticated-User-Email`. That header is only trustworthy if **IAP is the
authentication boundary** in front of the Service. With **Cloud Run direct IAP**,
Google IAP authenticates every request at the platform — on the `*.run.app` URL
itself — and **overwrites** any client-supplied `X-Goog-Authenticated-User-Email`
with the verified identity before it reaches the container. The forgeable-header
risk exists only when the Service runs `ingress=all` **WITHOUT** IAP enabled; with
IAP enabled it is closed. There is no in-app password; IAP *is* the authentication
boundary.

**Therefore the dashboard Service MUST be deployed with all of:**

```bash
gcloud run deploy <dashboard-service> \
  --no-allow-unauthenticated \   # remove the public allUsers invoker — require an authenticated principal
  ...
# + IAP enabled ON the Cloud Run service (annotation run.googleapis.com/iap-enabled=true,
#   set in Console → Security → IAP, or via gcloud). Ingress stays the DEFAULT `all` so
#   IAP serves the *.run.app URL. Do NOT pass --ingress internal-and-cloud-load-balancing —
#   that is the future-LB topology and would BREAK direct IAP. deploy/webapi/deploy.sh does
#   exactly this: it never forces an ingress lock by default.
```

Why each control is load-bearing:

| Control | What it prevents |
|---|---|
| **IAP enabled on the Cloud Run service** (`run.googleapis.com/iap-enabled=true`, ingress `all`) | Google IAP authenticates every request at the platform on the `*.run.app` URL and **overwrites** any client-supplied `X-Goog-Authenticated-User-Email` with the verified identity — the trust anchor for `edited_by`. |
| `--no-allow-unauthenticated` | Removes the public `allUsers` invoker binding. Defense-in-depth: the request must carry a valid identity (the IAP service agent's). |

> **Defense in depth — the app also verifies the IAP JWT.** Cloud Run direct IAP is
> the primary boundary; `src/embrapa_dashboard/serving/iap.py` additionally
> validates the signed `X-Goog-IAP-JWT-Assertion` (when `IAP_AUDIENCE` is set) so a
> misconfiguration (e.g. IAP accidentally disabled) fails closed rather than
> trusting a forged plain header. Operators must **not** rely on the in-app JWT
> check as a substitute for enabling IAP — both the platform IAP boundary and the
> in-app verification are wanted.

This is the same boundary referenced as "behind IAP" in
[`ARCHITECTURE.md`](../ARCHITECTURE.md) (§ Security and Authentication and §
Dynamic Curation). The least-privilege IAM for the Service's runtime SA
(`sa-web-dashboard-prod`) is in [`iam_setup.md`](iam_setup.md) §2.3.

### Future expansion only — external HTTPS Load Balancer + IAP

> ⚠️ **Do NOT deploy this without an explicit instruction.** An external HTTPS Load
> Balancer adds a **fixed monthly cost** (the forwarding rule + LB are billed even
> at zero traffic), which violates the project's zero-fixed-cost / scale-to-zero
> rule. It is documented only as the migration path for if/when the dashboard
> graduates from an experiment to steady real-world use.

If the project later migrates to an external HTTPS Load Balancer with IAP on the
backend service, lock the Service so the LB is the sole ingress path:

```bash
gcloud run deploy <dashboard-service> \
  --ingress internal-and-cloud-load-balancing \  # reject direct *.run.app; only the LB (+ internal) reaches it
  --no-allow-unauthenticated \
  ...
```

`deploy/webapi/deploy.sh` supports this via
`WEBAPI_INGRESS=internal-and-cloud-load-balancing` (unset by default → no lock →
direct IAP preserved). In that topology the JWT audience (`IAP_AUDIENCE`) takes the
backend-service form `/projects/<PROJECT_NUMBER>/global/backendServices/<BACKEND_SERVICE_ID>`;
under the current direct-IAP posture it is the audience shown in
Console → Security → IAP ("Get JWT audience code") for the Cloud Run resource.

## Credential Management

**There are no long-lived JSON keyfiles in the data pipeline or dashboard
runtime.** (One acknowledged exception: the optional `sa-claude-code-web-dev`
sandbox SA created by `scripts/setup-claude-code-web-sa.sh` for the Claude Code
web UI uses a long-lived key — scoped read-only to data plus a dev-only write
sandbox, never prod write. Rotate it at least every 90 days.) Developers
authenticate with their personal Google account (`gcloud auth
application-default login`) and impersonate `sa-secret-reader-prod` for
their daily work.

### Granting Access (Admin Task)

```bash
# Grant a new developer permission to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding \
  sa-secret-reader-prod@embrapa-dashboard-commodities.iam.gserviceaccount.com \
  --member=user:florenciaitalo@gmail.com \
  --role=roles/iam.serviceAccountTokenCreator
```

The developer then runs `./setup.sh` and gets a working environment with no
credential file to manage.

### Rotation

Nothing to rotate manually — OAuth tokens are short-lived (~1 hour) and
refreshed automatically by gcloud. There is no static secret to expire.

## Audit & Compliance

### GCP Audit Logs

Every operation is logged with:
- **Who:** Developer's email (from OAuth token) + impersonated SA
- **What:** API call, resource modified, data read
- **When:** Timestamp with millisecond precision
- **Where:** Audit log entry with request/response details

```bash
# Query audit logs
gcloud logging read \
  "protoPayload.authenticationInfo.principalEmail=florenciaitalo@gmail.com OR 
   protoPayload.request.policy.bindings.members=sa-secret-reader-prod@..." \
  --limit=100 \
  --format=json
```

### Revocation

If a developer leaves:

```bash
# Remove their impersonation permission
gcloud iam service-accounts remove-iam-policy-binding \
  sa-secret-reader-prod@embrapa-dashboard-commodities.iam.gserviceaccount.com \
  --member=user:departed@gmail.com \
  --role=roles/iam.serviceAccountTokenCreator

# Immediate effect - no new credentials can be generated
# No need to rotate the keyfile itself
```

## Migration from Keyfile to Impersonation

### For Existing Setups

If you have a pre-existing `.gcp-credentials.json`:

1. **Re-run the unified setup script:**
   ```bash
   python3 scripts/setup_dev_env.py
   ```

2. **Script will:**
   - Detect impersonation context first (preferred)
   - Fall back to GOOGLE_APPLICATION_CREDENTIALS env var if impersonation unavailable
   - Fall back to `--credentials-file` argument if provided
   - Fall back to manual JSON paste (legacy, last resort)
   - Update `.env` with `GCP_AUTH_METHOD` value
   - Update `~/.dbt/profiles.yml` accordingly

3. **Existing keyfile remains:**
   - Only used as a fallback when impersonation isn't available
   - Can be safely deleted once impersonation is validated
   - Still in `.gitignore` (never committed)

### For New Developers

New developers should:

1. **Install gcloud CLI:**
   ```bash
   curl https://sdk.cloud.google.com | bash
   ```

2. **Authenticate:**
   ```bash
   gcloud auth application-default login
   # or
   gcloud auth login florenciaitalo@gmail.com
   ```

3. **Run setup:**
   ```bash
   python3 scripts/setup_dev_env.py
   ```

4. **Script uses impersonation automatically.**

## FAQ

**Q: Do I need a JSON keyfile?**
A: No. The enterprise setup uses OAuth via `gcloud auth` or browser login. If you have an existing keyfile, you can delete it (it's in .gitignore).

**Q: How does dbt authenticate?**
A: dbt uses the `oauth` method in `profiles.yml`. It reads a cached OAuth token from gcloud and uses it to call BigQuery, impersonating `sa-secret-reader-prod`.

**Q: What if gcloud CLI is not installed?**
A: The setup script will warn you. Install the Cloud SDK from https://cloud.google.com/sdk/docs/install. This is a one-time step per machine.

**Q: Can I use this with GitHub Actions / CI/CD?**
A: Yes. See `iam_setup.md` for CI/CD integration using Workload Identity Federation (no service account keys in GitHub Secrets).

**Q: What if I lose my laptop?**
A: No problem. Your OAuth token is cached locally (in `~/.config/gcloud/` on Unix, `AppData\gcloud\` on Windows). Remove your IAM role on `sa-secret-reader-prod`, and that laptop can no longer access GCP.

**Q: Is this faster than keyfile auth?**
A: Slightly. OAuth tokens are cached, so subsequent API calls don't require a round-trip to get a token. Keyfile auth also caches, but the token generation step is implicit.

**Q: What's the audit trail like?**
A: Complete. Every BigQuery job and GCS object access is logged with your identity + the impersonated service account. Admins can see exactly who did what and when.

## Related Documentation

- **iam_setup.md** — Step-by-step IAM role and service account setup
- **scripts/setup_dev_env.py** — Unified cross-platform setup script (auto-detects auth mode)
- **setup.md** — General setup documentation
- **CLAUDE.md** — Project architecture and development commands

## Support

For questions or issues:
1. Check **iam_setup.md** for permission configuration
2. Run `embrapa doctor` to diagnose authentication issues
3. Review GCP audit logs: https://console.cloud.google.com/logs
4. Contact your GCP administrator for IAM role assignments
