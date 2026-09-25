"""Coverage-focused tests for the error/edge branches of embrapa doctor probes.

These complement ``tests/test_doctor.py`` by driving the failure paths that the
happy-path suite does not reach: the ``except Exception`` arms of each check
(BigQuery/GCS/HTTP raising), the ADC impersonation branch, the empty-series
``StopIteration`` short-circuit in ``_check_bcb``, the COMTRADE "key configured"
success line, and the malformed-timestamp skip in ``_list_backup_runs``.
"""

from __future__ import annotations

from unittest.mock import MagicMock, PropertyMock, patch

import pytest
import requests

from embrapa_dashboard import doctor
from embrapa_dashboard.config import Settings


@pytest.fixture
def settings(settings_factory) -> Settings:
    # _env_file=None (via settings_factory) keeps these probes hermetic.
    return settings_factory(
        gcp_project_id="test-project",
        gcs_bucket="test-bucket",
        bcb_inflation_series="433:IPCA",
        bcb_currency_series="1:USD,21619:EUR",
    )


# --- _check_inflation_pivot_codes except branch (lines 99-100) ----------------


def test_check_inflation_pivot_codes_handles_unexpected_exception(settings: Settings) -> None:
    """If the pivot-codes property raises, the probe degrades to ok=False."""
    with patch.object(
        Settings,
        "inflation_pivot_codes",
        new_callable=PropertyMock,
        side_effect=RuntimeError("boom"),
    ):
        result = doctor._check_inflation_pivot_codes(settings)
    assert result.ok is False
    assert "boom" in result.detail


# --- _check_currency_series_codes except branch (lines 146-147) ---------------


def test_check_currency_series_codes_handles_unexpected_exception(settings: Settings) -> None:
    with patch.object(
        Settings,
        "currency_series_map",
        new_callable=PropertyMock,
        side_effect=RuntimeError("currency kaboom"),
    ):
        result = doctor._check_currency_series_codes(settings)
    assert result.ok is False
    assert "currency kaboom" in result.detail


# --- _check_pam_variable_codes except branch (lines 190-191) ------------------


def test_check_pam_variable_codes_handles_unexpected_exception(settings: Settings) -> None:
    with patch.object(
        Settings,
        "pam_variable_codes_list",
        new_callable=PropertyMock,
        side_effect=RuntimeError("pam kaboom"),
    ):
        result = doctor._check_pam_variable_codes(settings)
    assert result.ok is False
    assert "pam kaboom" in result.detail


# --- _check_adc impersonation branch (line 199) -------------------------------


def test_check_adc_reports_impersonation_target(settings: Settings) -> None:
    """When an impersonation SA is set, the detail names it (line 199 branch)."""
    settings.gcp_impersonation_sa = "sa-impersonate@x.iam.gserviceaccount.com"
    with patch("embrapa_dashboard.doctor.google.auth.default") as auth:
        auth.return_value = (MagicMock(), "test-project")
        result = doctor._check_adc(settings)
    assert result.ok is True
    assert "impersonating" in result.detail
    assert "sa-impersonate@x.iam.gserviceaccount.com" in result.detail


# --- _check_bq except branch (lines 220-221) ----------------------------------


def test_check_bq_fails_when_client_raises(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        bq_cls.return_value.get_service_account_email.side_effect = Exception("403 denied")
        result = doctor._check_bq(settings)
    assert result.ok is False
    assert "403 denied" in result.detail


# --- _check_gcs except branch (lines 240-241) ---------------------------------


def test_check_gcs_fails_on_non_notfound_error(settings: Settings) -> None:
    """A permission error (not NotFound) is a hard failure, not a 'will create'."""
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.side_effect = Exception("permission denied")
        result = doctor._check_gcs(settings)
    assert result.ok is False
    assert "permission denied" in result.detail


# --- _check_pam except branch (lines 262-263) ---------------------------------


def test_check_pam_fails_on_request_error(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.requests.get") as get:
        get.side_effect = requests.ConnectionError("pam host down")
        result = doctor._check_pam(settings)
    assert result.ok is False
    assert "pam host down" in result.detail


# --- _check_ppm except branch (lines 276-277) ---------------------------------


def test_check_ppm_fails_on_request_error(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.requests.get") as get:
        get.side_effect = requests.ConnectionError("ppm host down")
        result = doctor._check_ppm(settings)
    assert result.ok is False
    assert "ppm host down" in result.detail


# --- _check_bcb StopIteration + except branches (lines 284-285, 293-294) ------


def test_check_bcb_fails_when_inflation_series_empty(settings_factory) -> None:
    """An empty BCB_INFLATION_SERIES short-circuits via StopIteration (line 284-285)."""
    s = settings_factory(bcb_inflation_series="")
    result = doctor._check_bcb(s)
    assert result.ok is False
    assert "empty" in result.detail


def test_check_bcb_fails_on_request_error(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.requests.get") as get:
        get.side_effect = requests.ConnectionError("bcb host down")
        result = doctor._check_bcb(settings)
    assert result.ok is False
    assert "bcb host down" in result.detail


# --- _check_comex non-HTTPError except branch (lines 330-331) -----------------


def test_check_comex_fails_on_connection_error(settings: Settings) -> None:
    """A ConnectionError (not an HTTPError) hits the generic except → hard fail,
    with no previous-year fallback."""
    settings.comex_end_year = 2026
    with patch("embrapa_dashboard.doctor.requests.head") as head:
        head.side_effect = requests.ConnectionError("comex host unreachable")
        result = doctor._check_comex(settings)
    assert result.ok is False
    assert "comex host unreachable" in result.detail
    # The connection error is terminal — the previous-year HEAD must not fire. It gets ONE
    # retry (v1.95.2, `_probe`), of the same end-year file.
    assert [c.args[0].rsplit("/", 1)[-1] for c in head.call_args_list] == ["EXP_2026.csv"] * 2


# --- _check_comtrade except + key-configured success (lines 365-366, 371) -----


def test_check_comtrade_fails_on_request_error(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.requests.get") as get:
        get.side_effect = requests.ConnectionError("comtrade host down")
        result = doctor._check_comtrade(settings)
    assert result.ok is False
    assert "comtrade host down" in result.detail


def test_check_comtrade_reports_key_configured(settings: Settings) -> None:
    """When the API responds AND a key is set, the success line names the key (371)."""
    settings.comtrade_api_key = "secret-key"
    with patch("embrapa_dashboard.doctor.requests.get") as get:
        get.return_value.raise_for_status.return_value = None
        get.return_value.close.return_value = None
        result = doctor._check_comtrade(settings)
    assert result.ok is True
    assert "key configured" in result.detail


# --- _check_bronze_tables except branch (lines 404-405) -----------------------


def test_check_bronze_tables_fails_when_client_raises(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        bq_cls.side_effect = Exception("bq client init failed")
        result = doctor._check_bronze_tables(settings)
    assert result.ok is False
    assert "bq client init failed" in result.detail


# --- _check_serving_marts except branch (lines 454-455) -----------------------


def test_check_serving_marts_fails_when_client_raises(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        bq_cls.side_effect = Exception("serving client init failed")
        result = doctor._check_serving_marts(settings)
    assert result.ok is False
    assert "serving client init failed" in result.detail


# --- _list_backup_runs malformed-timestamp skip (lines 505-506) ---------------


def test_list_backup_runs_skips_unparseable_timestamp(settings: Settings) -> None:
    """A prefix matching the run= regex shape but with an impossible date (month 99)
    survives the regex yet fails strptime → the ValueError arm (505-506) skips it."""
    blobs = MagicMock()
    # Month 99 matches \d{8}T\d{6}Z but strptime rejects it → ValueError → skipped.
    blobs.prefixes = ["backups/run=20269901T000000Z/"]
    client = MagicMock()
    client.list_blobs.return_value = blobs

    runs = doctor._list_backup_runs(client, settings)
    assert runs == []


# --- _check_backup_freshness except branch (lines 590-591) --------------------


def test_check_backup_freshness_fails_when_storage_client_raises(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.side_effect = Exception("storage init failed")
        result = doctor._check_backup_freshness(settings)
    assert result.ok is False
    assert "storage init failed" in result.detail
