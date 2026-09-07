# Development Environment Setup

Automated cross-platform setup for the Embrapa Agricultural, Livestock & Forestry Dashboard project. Works on fresh machines with no prior setup.

## Quick Start

### macOS / Linux

```bash
# Run setup (will auto-install Python and uv if needed)
./setup.sh
```

### Windows (Command Prompt)

```cmd
# Run setup (will auto-install Python and uv if needed)
setup.bat
```

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

## How It Works

The setup scripts are **fully bootstrapped** and handle fresh machines:

1. ✅ Detects OS (Windows/macOS/Linux)
2. ✅ Checks for Python 3.8+ (auto-installs if missing)
3. ✅ Checks for uv (auto-installs if missing)
4. ✅ **Auto-detects the best authentication mode** (enterprise OAuth/impersonation → keyfile fallback)
5. ✅ Creates `.env` file with configuration (records `GCP_AUTH_METHOD`)
6. ✅ Creates `~/.dbt/profiles.yml` matching the detected mode (OAuth+impersonation or keyfile)
7. ✅ Protects credentials in `.gitignore`
8. ✅ Validates entire setup with `embrapa doctor`

> **One script, two modes.** The same `scripts/setup_dev_env.py` produces an enterprise
> setup (OAuth + service-account impersonation, **no keyfile on disk**) when
> `gcloud auth application-default login` has been run, and falls back to the
> legacy JSON-keyfile flow otherwise. See [auth_architecture.md](auth_architecture.md)
> for the full enterprise model.

## Machine Requirements

### macOS / Linux
- **bash** — included by default
- **curl** — for downloading Python/uv (usually included)

### Windows
- **PowerShell 3.0+** — included in Windows 7+ (usually PowerShell 5+)
- **Internet connection** — for downloading Python and uv

**That's it!** No pre-installed tools required.

## Setup Scripts Overview

### `setup.sh` (macOS / Linux)
- Detects Python 3.8+ installations
- Auto-installs Python 3.12 via system package manager
- Auto-installs uv via curl
- Calls `scripts/setup_dev_env.py` for configuration

### `setup.bat` (Windows Command Prompt)
- Wrapper that calls `setup.ps1`
- No PowerShell knowledge needed

### `setup.ps1` (Windows PowerShell)
- Detects Python 3.8+ installations
- Auto-installs Python 3.12 via Chocolatey (or shows manual steps)
- Auto-installs uv via PowerShell
- Calls `scripts/setup_dev_env.py` for configuration

### `scripts/setup_dev_env.py` (Core Python Script)
- Cross-platform setup logic — single source of truth
- **Auto-detects** the best available authentication method
- Generates `.env` and `~/.dbt/profiles.yml` matching the detected mode
- Reads `GCP_IMPERSONATION_SA` from `.env` to override the default impersonation target
- Runs validation checks against the configured project

### `init_dev_env.sh` (One-shot init / SessionStart hook)
- Lightweight wrapper for already-cloned repos
- Used by Claude Code on the web and as a quick re-init
- Decodes `GCP_CREDENTIALS_B64` (Claude Code Web only) into `.gcp-credentials.json`
- Sets `GOOGLE_APPLICATION_CREDENTIALS` if a keyfile exists, otherwise lets
  Application Default Credentials take over
- Runs `uv sync` and `python3 scripts/test_setup.py`

### `scripts/setup-claude-code-web-sa.sh` (admin one-time)
- Provisions `sa-claude-code-web-dev` in your GCP project with limited
  BigQuery + GCS permissions
- Emits a JSON keyfile and a base64-encoded copy to paste into Claude Code
  Web's environment variables (`GCP_CREDENTIALS_B64`)
- Both output files are covered by `.gitignore` (`sa-*.json`, `sa-*.b64`)

## GCP Authentication Strategy

The setup script tries authentication strategies in this order, picking the
first one that works:

### 1️⃣ Service Account Impersonation (Enterprise — Recommended)

If you have run `gcloud auth application-default login` and your account has
`roles/iam.serviceAccountTokenCreator` on the impersonation target SA, the
script configures **OAuth + impersonation**:

- ✅ No JSON keyfile written to disk
- ✅ Complete audit trail in Cloud Logging
- ✅ Instant revocation via IAM
- ✅ Automatic credential rotation (no re-distribution)

The default impersonation target is
`sa-secret-reader-prod@<project>.iam.gserviceaccount.com`. Override it by
setting `GCP_IMPERSONATION_SA` (short name or full email) in your shell
before running setup, or in `.env` after first run.

Generated `~/.dbt/profiles.yml` uses `method: oauth` with `impersonate_service_account`.

See [auth_architecture.md](auth_architecture.md) and [iam_setup.md](iam_setup.md).

### 2️⃣ Environment Variable (legacy)

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
./setup.sh
```

Useful in CI/CD environments or pre-provisioned VMs where the keyfile is
already on disk.

### 3️⃣ File Argument (legacy)

```bash
./setup.sh --credentials-file /path/to/service-account.json
```

Useful when you have a keyfile downloaded locally and want to point to it
explicitly.

### 4️⃣ Interactive Prompt (last resort)

If none of the above work, the script prompts you to paste your service
account JSON. Avoid this path — copy/paste leaves traces in shell history.

## File Arguments

```bash
./setup.sh [OPTIONS]
  --credentials-file PATH    Path to GCP service account JSON file
  --help                     Show help message
```

Same options work with `setup.bat` and `setup.ps1`.

## Claude Code Web (cloud sandbox)

Claude Code on the web runs sessions in an ephemeral container. There is no
interactive `gcloud auth` flow there, so the OAuth+impersonation path is not
available. Instead, the container reads a base64-encoded service account key
from an environment variable and writes it to `.gcp-credentials.json` on each
session start.

### One-time admin setup

```bash
# Provisions sa-claude-code-web-dev with limited BigQuery + GCS scopes
# and writes scripts/sa-claude-code-web-dev-key.{json,b64}
bash scripts/setup-claude-code-web-sa.sh
```

Both output files are ignored by git via the `sa-*.json` / `sa-*.b64` patterns.

### Per-session configuration (Claude Code Web UI)

In **Settings → Update cloud environment**:

- **Environment variables:**
  - `GCP_PROJECT_ID=<your_project_id>`
  - `GCP_CREDENTIALS_B64=<paste contents of scripts/sa-claude-code-web-dev-key.b64>`
- **Setup script:**
  ```bash
  #!/bin/bash
  ./init_dev_env.sh || true
  ```

`init_dev_env.sh` then:
1. Decodes `GCP_CREDENTIALS_B64` → `.gcp-credentials.json`
2. Exports `GOOGLE_APPLICATION_CREDENTIALS`
3. Runs `uv sync` and `scripts/test_setup.py`

### Rotating the key

If the key leaks, delete the old key and rerun the provisioning script:

```bash
gcloud iam service-accounts keys list \
  --iam-account=sa-claude-code-web-dev@<project>.iam.gserviceaccount.com
gcloud iam service-accounts keys delete <KEY_ID> \
  --iam-account=sa-claude-code-web-dev@<project>.iam.gserviceaccount.com
bash scripts/setup-claude-code-web-sa.sh
```

## Troubleshooting

### "Python not found"

#### Linux (Ubuntu/Debian)
```bash
sudo apt-get update
sudo apt-get install python3.12 python3.12-venv
./setup.sh
```

#### Linux (Fedora)
```bash
sudo dnf install python3.12
./setup.sh
```

#### macOS
```bash
# Option 1: Homebrew
brew install python@3.12

# Option 2: MacPorts
sudo port install python312

# Option 3: Download from
# https://www.python.org/downloads/
```

#### Windows
The setup script (`setup.bat`) will offer to auto-install Python. If it fails:

```powershell
# Option 1: Chocolatey (auto-installer handles this)
choco install python312

# Option 2: Microsoft Store
# Search "Python" in Microsoft Store and install

# Option 3: Download from
# https://www.python.org/downloads/
```

### "command not found: $'\r'" / "unrecognized arguments" on Windows

If you see errors like:

```
scripts/setup-claude-code-web-sa.sh: line 10: $'\r': command not found
ERROR: (gcloud...) unrecognized arguments:
```

your Git checkout converted the shell scripts to CRLF line endings. The
repo's `.gitattributes` pins `*.sh` to LF, but Git only applies it on a
fresh checkout. Re-normalize your working copy:

```bash
git rm --cached -r .
git reset --hard HEAD
```

Or, if you only want to fix the affected scripts without touching the
rest of the tree:

```bash
git checkout-index --force -- init_dev_env.sh setup.sh test.sh \
  scripts/setup-claude-code-web-sa.sh
```

If you cloned with `core.autocrlf=true`, consider switching to
`core.autocrlf=input` (`git config --global core.autocrlf input`) so
Windows checkouts stop munging Unix-only scripts.

### "uv installation failed"

The bootstrap scripts attempt auto-installation. If it fails:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Then re-run setup:
```bash
./setup.sh    # or setup.bat on Windows
```

### "Invalid JSON" error

Make sure you're pasting a valid GCP service account JSON file. Obtain it from:
1. **Google Cloud Console** → **Service Accounts** → Your account → **Keys** → **Add Key** → **JSON**

### "GCS bucket access denied (403)"

This may happen if the service account doesn't have proper IAM roles:

1. **Google Cloud Console** → **IAM & Admin** → **IAM**
2. Find your service account
3. Grant roles:
   - `Storage Object Creator` (for GCS)
   - `BigQuery Data Editor` (for BigQuery)
4. Wait 1-2 minutes for permissions to propagate
5. Re-run `setup.sh`

## Environment Files Created

### `.env` (always)
- **Location:** Project root
- **Contains:** GCP project settings, dataset names, pipeline configuration, `GCP_AUTH_METHOD`
- **Safety:** Added to `.gitignore`

### `~/.dbt/profiles.yml` (always)
- **Location:** User home directory (`.dbt/` folder)
- **Contains:** dbt BigQuery connection — `method: oauth` + `impersonate_service_account` in enterprise mode, `method: service-account` + `keyfile` in legacy mode
- **Safety:** Permissions restricted to user only

### `.gcp-credentials.json` (legacy only)
- **Location:** Project root
- **Contains:** GCP service account credentials
- **Created only** in the legacy paths (env var / `--credentials-file` / manual paste). Enterprise mode does NOT write this file.
- **Safety:** Added to `.gitignore` (pattern `sa-*.json` and explicit entry), file permissions 0600

## Validation

After setup completes, verify everything works:

```bash
# Check environment status
uv run embrapa doctor

# Run dbt tests
make dbt-test

# Build dbt dev models
make dbt-build
```

## Next Steps

1. Review `.env` and adjust settings if needed
2. Ensure GCP service account has proper IAM roles
3. Run `uv run embrapa ingest ibge` to test ingestion
4. Happy coding! 🚀

## Advanced: Manual Setup (if scripts don't work)

If the bootstrap scripts encounter issues, you can set up manually:

1. **Install Python 3.8+** from https://www.python.org/downloads/
2. **Install uv:**
   ```bash
   # macOS / Linux
   curl -LsSf https://astral.sh/uv/install.sh | sh
   
   # Windows (PowerShell)
   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```
3. **Run setup script:**
   ```bash
   python3 scripts/setup_dev_env.py --credentials-file /path/to/service-account.json
   ```

## Support

For issues or questions:
- **CLAUDE.md** — Project architecture and commands
- **GitHub Issues** — https://github.com/igorrflorentino/embrapa-dashboard-agronegocio/issues
- **Contributing** — See CLAUDE.md for setup and development workflow

## Architecture Diagram

```
Fresh Machine
    ↓
setup.sh / setup.bat
    ↓
[Detect Python]
    ├─→ Found? Continue
    └─→ Not found? Auto-install
    ↓
[Detect uv]
    ├─→ Found? Continue
    └─→ Not found? Auto-install
    ↓
scripts/setup_dev_env.py
    ├─→ Resolve GCP project ID (gcloud → env → keyfile)
    ├─→ Detect impersonation context (OAuth) or fall back to keyfile
    ├─→ Create .env (records GCP_AUTH_METHOD)
    ├─→ Create ~/.dbt/profiles.yml (oauth+impersonation or service-account)
    └─→ Run `uv run embrapa doctor`
    ↓
✅ Ready to develop!
```
