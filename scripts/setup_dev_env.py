#!/usr/bin/env python3
"""
Cross-platform development environment setup script.

Auto-detects authentication mode and adapts:
  1. Service Account impersonation (OAuth, enterprise) — preferred
  2. GOOGLE_APPLICATION_CREDENTIALS env var (legacy)
  3. --credentials-file argument (legacy)
  4. Interactive paste prompt (last resort)

Generates the appropriate .env, ~/.dbt/profiles.yml, and credential files
for the detected authentication mode. Works on Windows, macOS, Linux,
and cloud serverless VMs.

The impersonation target SA defaults to
`sa-secret-reader-prod@<project>.iam.gserviceaccount.com` but can be
overridden by setting GCP_IMPERSONATION_SA (either a short name or a
full email).

See docs/auth_architecture.md for the four-tier service account model and
docs/iam_setup.md for the admin-side configuration.
"""

import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any


class SetupHelper:
    """Cross-platform setup with auto-detected authentication mode."""

    REPO_ROOT = Path(__file__).resolve().parent.parent
    ENV_FILE = REPO_ROOT / ".env"
    DBT_PROFILES_DIR = Path.home() / ".dbt"
    DBT_PROFILES_FILE = DBT_PROFILES_DIR / "profiles.yml"
    GCP_CREDS_FILE = REPO_ROOT / ".gcp-credentials.json"  # Legacy fallback only

    ENV_TEMPLATE = """{gcp_config}{bcb_config}{ibge_config}"""

    GCP_CONFIG = """# GCP Configuration
GCP_PROJECT_ID={project_id}
GCS_BUCKET={bucket}
BQ_LOCATION=us-central1
GCP_AUTH_METHOD={auth_method}

# BigQuery datasets / tables
BQ_BRONZE_IBGE_DATASET=bronze_ibge
BQ_BRONZE_BCB_DATASET=bronze_bcb
BQ_BRONZE_IBGE_TABLE=sidra_t289_raw
BQ_BRONZE_BCB_INFLATION_TABLE=inflation_series_raw
BQ_BRONZE_BCB_CURRENCY_TABLE=currency_series_raw
BQ_SILVER_DATASET=silver
BQ_GOLD_DATASET=gold

"""

    IBGE_CONFIG = """# IBGE PEVS Configuration
IBGE_TABLE_ID=289
IBGE_CLASSIFICATION_ID=193
IBGE_PRODUCT_CODES=3405,3435,3450
IBGE_START_YEAR=1986
# IBGE_END_YEAR unset on purpose: it floats with the current year (see .env.example)

"""

    BCB_CONFIG = """# BCB SGS Configuration
BCB_INFLATION_SERIES=433:IPCA,189:IGPM,190:IGPDI
BCB_INFLATION_SERIES_IPCA_CODE=433
BCB_INFLATION_SERIES_IGPM_CODE=189
BCB_INFLATION_SERIES_IGPDI_CODE=190
BCB_CURRENCY_SERIES=1:USD,21619:EUR
BCB_START_YEAR=1974
# BCB_END_YEAR unset on purpose: it floats with the current year (see .env.example)

"""

    # Enterprise: OAuth method with service account impersonation
    DBT_PROFILES_ENTERPRISE = """embrapa_dashboard:
  target: dev
  outputs:
    dev:
      type: bigquery
      method: oauth
      project: {project_id}
      dataset: dbt_dev
      location: us-central1
      threads: 4
      job_execution_timeout_seconds: 600
      job_retries: 1
      priority: interactive
      impersonate_service_account: {impersonation_sa}

    prod:
      type: bigquery
      method: oauth
      project: {project_id}
      dataset: prod
      location: us-central1
      threads: 8
      job_execution_timeout_seconds: 600
      job_retries: 1
      priority: batch
      impersonate_service_account: {impersonation_sa}
"""

    # Legacy: Keyfile method (for backward compatibility)
    DBT_PROFILES_LEGACY = """embrapa_dashboard:
  target: dev
  outputs:
    dev:
      type: bigquery
      method: service-account
      project: {project_id}
      dataset: dbt_dev
      location: us-central1
      threads: 4
      job_execution_timeout_seconds: 600
      job_retries: 1
      priority: interactive
      keyfile: {keyfile}

    prod:
      type: bigquery
      method: service-account
      project: {project_id}
      dataset: prod
      location: us-central1
      threads: 8
      job_execution_timeout_seconds: 600
      job_retries: 1
      priority: batch
      keyfile: {keyfile}
"""

    def __init__(self):
        self.os_name = platform.system()
        self.is_windows = self.os_name == "Windows"
        self.is_mac = self.os_name == "Darwin"
        self.is_linux = self.os_name == "Linux"
        self.auth_method = "unknown"
        self.project_id = None

    def print_header(self, text: str):
        """Print a formatted header."""
        print(f"\n{'=' * 60}")
        print(f"  {text}")
        print(f"{'=' * 60}\n")

    def print_step(self, step: float, text: str):
        """Print a step message (accepts e.g. 1 and 2.1)."""
        print(f"[{step}] {text}")

    def print_success(self, text: str):
        """Print a success message."""
        print(f"  ✅ {text}")

    def print_error(self, text: str):
        """Print an error message."""
        print(f"  ❌ {text}")

    def print_warning(self, text: str):
        """Print a warning message."""
        print(f"  ⚠️  {text}")

    def print_info(self, text: str):
        """Print an info message."""
        print(f"  ℹ️  {text}")

    # ============================================================================
    # Authentication Strategy 1: Service Account Impersonation (Enterprise)
    # ============================================================================

    def detect_impersonation_context(self) -> tuple[bool, str | None]:
        """
        Detect if running in a context that supports service account impersonation.
        Returns (is_available, reason)
        """
        try:
            # Check if gcloud is available
            result = subprocess.run(
                ["gcloud", "auth", "application-default", "print-access-token"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                return True, "gcloud OAuth available"
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        try:
            # Check if Application Default Credentials (ADC) is available
            from google.auth import default

            creds, _ = default()
            if creds and not creds.service_account_email:  # Not a service account key
                return True, "Application Default Credentials (ADC) available"
        except Exception:
            pass

        return False, "No impersonation context detected"

    def validate_impersonation_permissions(self, project_id: str) -> bool:
        """
        Validate that the current user has iam.serviceAccountTokenCreator role
        on the impersonation target SA.
        """
        try:
            sa_email = self.get_impersonation_sa_email(project_id)
            current_user = self.get_current_gcp_user()

            result = subprocess.run(
                ["gcloud", "iam", "service-accounts", "get-iam-policy", sa_email, "--format=json"],
                capture_output=True,
                timeout=10,
            )

            if result.returncode != 0:
                stderr = result.stderr.decode().strip()
                self.print_warning(f"Could not check IAM policy for {sa_email}")
                if stderr:
                    self.print_info(f"gcloud: {stderr.splitlines()[0]}")
                return False

            policy = json.loads(result.stdout.decode())
            bindings = policy.get("bindings", [])

            # Check that the CURRENT user is bound to Service Account Token Creator
            for binding in bindings:
                if binding.get("role") != "roles/iam.serviceAccountTokenCreator":
                    continue
                members = binding.get("members", [])
                if current_user and f"user:{current_user}" in members:
                    self.print_success(
                        f"Permission validated: {current_user} can impersonate {sa_email}"
                    )
                    return True
                if current_user and f"serviceAccount:{current_user}" in members:
                    self.print_success(
                        f"Permission validated: {current_user} can impersonate {sa_email}"
                    )
                    return True

            who = current_user or "current user"
            self.print_warning(f"{who} not in iam.serviceAccountTokenCreator for {sa_email}")
            return False

        except Exception as e:
            self.print_warning(f"Could not validate impersonation permissions: {e}")
            return False

    def get_impersonation_sa_email(self, project_id: str) -> str:
        """Return the impersonation target SA email (configurable via GCP_IMPERSONATION_SA)."""
        sa = os.environ.get("GCP_IMPERSONATION_SA")
        if sa:
            return sa if "@" in sa else f"{sa}@{project_id}.iam.gserviceaccount.com"
        return f"sa-secret-reader-prod@{project_id}.iam.gserviceaccount.com"

    def get_current_gcp_user(self) -> str | None:
        """Get the currently authenticated GCP user/service account."""
        try:
            result = subprocess.run(
                ["gcloud", "config", "get-value", "account"], capture_output=True, timeout=5
            )
            if result.returncode == 0:
                return result.stdout.decode().strip()
        except Exception:
            pass
        return None

    def setup_impersonation(self, project_id: str) -> bool:
        """
        Setup for service account impersonation (enterprise mode).
        """
        self.print_step(2.1, "Detecting service account impersonation context...")

        available, reason = self.detect_impersonation_context()
        if not available:
            self.print_warning(f"Impersonation not available: {reason}")
            return False

        self.print_success(reason)

        user = self.get_current_gcp_user()
        if user:
            self.print_info(f"Authenticated as: {user}")

        # Validate permissions
        self.print_step(2.2, "Validating impersonation permissions...")
        if not self.validate_impersonation_permissions(project_id):
            self.print_warning("Impersonation permission check failed (may still work)")

        self.auth_method = "impersonation"
        self.print_success("Enterprise mode: Service Account impersonation enabled")
        return True

    # ============================================================================
    # Authentication Strategy 2: Environment Variable
    # ============================================================================

    def get_gcp_credentials_from_env(self) -> dict[str, Any] | None:
        """
        Fallback 1: Try environment variable GOOGLE_APPLICATION_CREDENTIALS.
        """
        env_creds = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if env_creds and Path(env_creds).exists():
            self.print_info("Found credentials in GOOGLE_APPLICATION_CREDENTIALS")
            try:
                with open(env_creds) as f:
                    creds = json.load(f)
                    self.print_success(f"Loaded credentials from {env_creds}")
                    self.auth_method = "env_var"
                    return creds
            except (OSError, json.JSONDecodeError) as e:
                self.print_warning(f"Failed to read credentials file: {e}")
        return None

    # ============================================================================
    # Authentication Strategy 3: Credentials File Argument
    # ============================================================================

    def get_gcp_credentials_from_file(self) -> dict[str, Any] | None:
        """
        Fallback 2: Try --credentials-file argument.
        """
        if "--credentials-file" in sys.argv:
            idx = sys.argv.index("--credentials-file")
            if idx + 1 < len(sys.argv):
                creds_path = Path(sys.argv[idx + 1])
                if creds_path.exists():
                    try:
                        with open(creds_path) as f:
                            creds = json.load(f)
                            self.print_success(f"Loaded credentials from {creds_path}")
                            self.auth_method = "credentials_file"
                            return creds
                    except (OSError, json.JSONDecodeError) as e:
                        self.print_error(f"Failed to read {creds_path}: {e}")
        return None

    # ============================================================================
    # Authentication Strategy 4: Interactive Prompt
    # ============================================================================

    def get_gcp_credentials_from_prompt(self) -> dict[str, Any] | None:
        """
        Fallback 3: Prompt user to paste JSON (legacy, last resort).
        """
        self.print_info("No credentials found. Paste your GCP service account JSON below.")
        self.print_info("(Press Enter twice when done)")

        lines = []
        empty_count = 0
        try:
            while empty_count < 2:
                line = input()
                if not line.strip():
                    empty_count += 1
                else:
                    empty_count = 0
                    lines.append(line)
        except EOFError:
            self.print_error("No input received. Skipping GCP setup.")
            return None

        if not lines:
            return None

        try:
            json_str = "\n".join(lines)
            creds = json.loads(json_str)
            self.print_success("Credentials parsed successfully")
            self.auth_method = "manual_json"
            return creds
        except json.JSONDecodeError as e:
            self.print_error(f"Invalid JSON: {e}")
            return None

    # ============================================================================
    # Unified Credential Resolution
    # ============================================================================

    def get_gcp_credentials(self) -> dict[str, Any] | None:
        """
        Fallback authentication strategy (impersonation handled separately):
        1. Try GOOGLE_APPLICATION_CREDENTIALS environment variable
        2. Try --credentials-file argument
        3. Prompt user for JSON (legacy, last resort)
        """
        creds = self.get_gcp_credentials_from_env()
        if creds:
            return creds

        creds = self.get_gcp_credentials_from_file()
        if creds:
            return creds

        creds = self.get_gcp_credentials_from_prompt()
        if creds:
            return creds

        return None

    # ============================================================================
    # Configuration Files
    # ============================================================================

    def save_gcp_credentials(self, creds: dict[str, Any]) -> bool:
        """Save GCP credentials to file (legacy mode only)."""
        try:
            with open(self.GCP_CREDS_FILE, "w") as f:
                json.dump(creds, f, indent=2)
            os.chmod(self.GCP_CREDS_FILE, 0o600)
            self.print_success(f"Saved credentials to {self.GCP_CREDS_FILE}")
            return True
        except OSError as e:
            self.print_error(f"Failed to save credentials: {e}")
            return False

    def create_env_file(self, project_id: str, bucket: str) -> bool:
        """Create .env file with auth method."""
        try:
            content = self.ENV_TEMPLATE.format(
                gcp_config=self.GCP_CONFIG.format(
                    project_id=project_id, bucket=bucket, auth_method=self.auth_method
                ),
                ibge_config=self.IBGE_CONFIG,
                bcb_config=self.BCB_CONFIG,
            )
            self.ENV_FILE.write_text(content)
            self.print_success(f"Created {self.ENV_FILE} (auth_method={self.auth_method})")
            return True
        except OSError as e:
            self.print_error(f"Failed to create .env: {e}")
            return False

    def create_dbt_profiles(self, project_id: str, use_enterprise: bool = True) -> bool:
        """Create dbt profiles.yml with appropriate authentication method."""
        try:
            self.DBT_PROFILES_DIR.mkdir(parents=True, exist_ok=True)

            if use_enterprise and self.auth_method == "impersonation":
                # Enterprise mode: OAuth with impersonation
                content = self.DBT_PROFILES_ENTERPRISE.format(
                    project_id=project_id,
                    impersonation_sa=self.get_impersonation_sa_email(project_id),
                )
                self.print_info("Using enterprise OAuth method with service account impersonation")
            else:
                # Legacy mode: Keyfile-based authentication
                keyfile = self.GCP_CREDS_FILE.resolve()
                content = self.DBT_PROFILES_LEGACY.format(
                    project_id=project_id, keyfile=str(keyfile)
                )
                self.print_info("Using legacy keyfile-based authentication")

            self.DBT_PROFILES_FILE.write_text(content)

            # Set restrictive permissions on Unix
            if not self.is_windows:
                os.chmod(self.DBT_PROFILES_FILE, 0o600)

            self.print_success(f"Created {self.DBT_PROFILES_FILE}")
            return True
        except OSError as e:
            self.print_error(f"Failed to create dbt profiles: {e}")
            return False

    # ============================================================================
    # Validation
    # ============================================================================

    def validate_uv(self) -> bool:
        """Check if uv is available."""
        try:
            result = subprocess.run(["uv", "--version"], capture_output=True, timeout=5)
            if result.returncode == 0:
                version = result.stdout.decode().strip()
                self.print_success(f"Found uv: {version}")
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        self.print_warning("uv not found. Install from https://github.com/astral-sh/uv")
        return False

    def run_embrapa_doctor(self) -> bool:
        """Run embrapa doctor to validate setup."""
        try:
            env = os.environ.copy()

            # For impersonation, we don't set GOOGLE_APPLICATION_CREDENTIALS
            # gcloud auth will handle it
            if self.auth_method == "impersonation":
                env.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
            elif self.GCP_CREDS_FILE.exists():
                env["GOOGLE_APPLICATION_CREDENTIALS"] = str(self.GCP_CREDS_FILE.resolve())

            result = subprocess.run(
                ["uv", "run", "embrapa", "doctor"],
                cwd=self.REPO_ROOT,
                capture_output=True,
                timeout=60,
                env=env,
            )

            output = result.stdout.decode()
            if "All checks passed" in output:
                self.print_success("embrapa doctor: All checks passed!")
                return True
            else:
                self.print_warning("embrapa doctor: Some checks failed")
                print(output)
                return False
        except Exception as e:
            self.print_warning(f"Could not run embrapa doctor: {e}")
            return False

    # ============================================================================
    # Main Setup Flow
    # ============================================================================

    def run_setup(self) -> bool:
        """Run the complete enterprise setup process."""
        self.print_header(f"Development Environment Setup ({self.os_name})")
        self.print_info("Auto-detecting authentication mode...")

        # Step 1: Check uv
        self.print_step(1, "Checking uv installation...")
        if not self.validate_uv():
            self.print_error("uv is required. Please install it first.")
            return False

        # Step 2: Determine GCP project ID (needed before we can validate
        # impersonation permissions, which require the project name to build
        # the SA email).
        self.print_step(2, "Determining GCP project...")
        try:
            result = subprocess.run(
                ["gcloud", "config", "get-value", "project"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                project = result.stdout.decode().strip()
                if project and project != "(unset)":
                    self.project_id = project
                    self.print_success(f"Detected project from gcloud: {self.project_id}")
        except Exception:
            pass

        if not self.project_id:
            self.project_id = os.environ.get("GCP_PROJECT_ID")
            if self.project_id:
                self.print_success(f"Using GCP_PROJECT_ID from environment: {self.project_id}")

        # If still no project, try to read from a keyfile (fallback paths)
        if not self.project_id:
            self.print_step(2.1, "Loading credentials to discover project ID...")
            creds = self.get_gcp_credentials()
            if not creds:
                self.print_error("Cannot proceed without GCP credentials or project")
                return False

            self.project_id = creds.get("project_id")
            if not self.project_id:
                self.print_error("Invalid credentials: missing project_id")
                return False

            # Save keyfile since we now have one in hand
            self.print_step(2.2, "Saving GCP credentials...")
            if not self.save_gcp_credentials(creds):
                return False

        # Step 3: With project_id known, attempt service account impersonation.
        self.print_step(3, "Checking for service account impersonation (enterprise mode)...")
        if not self.setup_impersonation(self.project_id):
            self.print_warning(
                "Enterprise mode not available, falling back to legacy authentication"
            )
            # If we have no keyfile yet, prompt for one now.
            if self.auth_method != "impersonation" and not self.GCP_CREDS_FILE.exists():
                self.print_step(3.1, "Setting up GCP credentials for legacy auth...")
                creds = self.get_gcp_credentials()
                if creds and not self.save_gcp_credentials(creds):
                    return False

        bucket = f"{self.project_id}-datalake"

        # Step 4: Create .env
        self.print_step(4, "Creating .env file...")
        if not self.create_env_file(self.project_id, bucket):
            return False

        # Step 5: Create dbt profiles
        self.print_step(5, "Creating dbt profiles...")
        use_enterprise = self.auth_method == "impersonation"
        if not self.create_dbt_profiles(self.project_id, use_enterprise=use_enterprise):
            return False

        # Step 6: Validate setup
        self.print_step(6, "Validating setup...")
        self.run_embrapa_doctor()

        return True


def main():
    """Main entry point."""
    helper = SetupHelper()

    try:
        success = helper.run_setup()

        if success:
            helper.print_header("✅ Setup Complete!")
            mode_label = {
                "impersonation": "Service Account Impersonation (OAuth) — enterprise",
                "env_var": "GOOGLE_APPLICATION_CREDENTIALS env var",
                "credentials_file": "--credentials-file argument",
                "manual_json": "Manually pasted JSON keyfile",
                "unknown": "Unknown (no credentials configured)",
            }.get(helper.auth_method, helper.auth_method)
            print(f"Authentication Mode: {mode_label}\n")
            print("Your development environment is ready.\n")
            print("Next steps:")
            print("  1. Review .env file and make any necessary changes")
            print("  2. Run: uv run embrapa --help")
            print("  3. Run: make dbt-build (for dbt development)")
            print("  4. See docs/auth_architecture.md for the cloud architecture overview")
            print("  5. Happy coding! 🚀\n")
            sys.exit(0)
        else:
            helper.print_header("❌ Setup Failed")
            print("Please review the errors above and try again.\n")
            print(
                "For setup help, see: docs/setup.md, docs/auth_architecture.md, docs/iam_setup.md\n"
            )
            sys.exit(1)
    except KeyboardInterrupt:
        print("\n\nSetup cancelled by user.")
        sys.exit(1)
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
