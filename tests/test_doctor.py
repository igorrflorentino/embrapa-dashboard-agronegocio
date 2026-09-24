"""Tests for the embrapa doctor health-check probes."""

from __future__ import annotations

import ast
import inspect
import json
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import google.auth
import pytest
import responses
from google.api_core.exceptions import BadRequest
from google.cloud.exceptions import Forbidden, NotFound

from embrapa_dashboard import doctor
from embrapa_dashboard.config import Settings


@pytest.fixture
def settings(settings_factory) -> Settings:
    # _env_file=None (via settings_factory) keeps these probes from reading the
    # developer's repo-root .env, so default-dependent assertions stay hermetic.
    return settings_factory(
        gcp_project_id="test-project",
        gcs_bucket="test-bucket",
        bcb_inflation_series="433:IPCA",
        bcb_currency_series="3694:USD",
    )


def test_check_env_passes_with_valid_settings(settings: Settings) -> None:
    result = doctor._check_env(settings)
    assert result.ok is True
    assert "433" in result.detail
    # The check vouches for ALL source mappings, not just PEVS/BCB.
    assert "pam=" in result.detail
    assert "comex=" in result.detail
    assert "comtrade=" in result.detail


def test_check_env_fails_on_bad_format(settings: Settings) -> None:
    # No colon — malformed pair.
    settings.bcb_inflation_series = "433_no_colon"
    result = doctor._check_env(settings)
    assert result.ok is False


def test_check_env_fails_on_bad_comex_ncm_codes(settings: Settings) -> None:
    """A malformed COMEX_NCM_CODES must fail '.env parsed' — not explode mid-ingest."""
    settings.comex_ncm_codes = "08012100_no_colon"
    result = doctor._check_env(settings)
    assert result.ok is False
    assert "08012100_no_colon" in result.detail


def test_check_env_fails_on_invalid_comtrade_flows(settings: Settings) -> None:
    settings.comtrade_flows = "X,Z"
    result = doctor._check_env(settings)
    assert result.ok is False
    assert "Z" in result.detail


def test_check_env_fails_on_empty_pam_codes(settings: Settings) -> None:
    settings.pam_product_codes = " , "
    result = doctor._check_env(settings)
    assert result.ok is False
    assert "PAM_PRODUCT_CODES" in result.detail


def test_check_inflation_pivot_codes_pass(settings: Settings) -> None:
    """All three Gold pivot codes present in BCB_INFLATION_SERIES → ok."""
    settings.bcb_inflation_series = "433:IPCA,189:IGPM,190:IGPDI"
    result = doctor._check_inflation_pivot_codes(settings)
    assert result.ok is True


def test_check_inflation_pivot_codes_fails_when_code_not_ingested(settings: Settings) -> None:
    """A pivot code absent from BCB_INFLATION_SERIES → fail.

    The fixture ingests only 433:IPCA, but the IGP-M (189) and IGP-DI (190)
    pivot codes default on, so they are missing from the ingested series —
    exactly the drift that would silently NULL the Gold val_real_igpm/igpdi_*
    columns.
    """
    result = doctor._check_inflation_pivot_codes(settings)
    assert result.ok is False
    assert "189" in result.detail or "190" in result.detail


def test_pinned_end_year_below_today_is_named(settings_factory) -> None:
    """The production Job carried IBGE_END_YEAR=2024 from an operator .env, and every
    weekly PEVS-extração run became a no-op (Bronze had reached the pin, so the delta
    skipped entirely and absorbed no revision). Nothing reported it. This line does."""
    settings = settings_factory(gcp_project_id="p", gcs_bucket="b", ibge_end_year=2000)
    result = doctor._check_pinned_end_years(settings)
    assert result.ok is True  # a warning: a local pin can be deliberate
    assert "IBGE_END_YEAR=2000" in result.detail
    assert "⚠" in result.detail and "unset" in result.detail


def test_floating_end_years_are_not_reported(settings_factory) -> None:
    """Defaults float to the current year — not a pin, even though the value is a year.
    Only a value someone SET counts, which is what model_fields_set distinguishes."""
    settings = settings_factory(gcp_project_id="p", gcs_bucket="b")
    result = doctor._check_pinned_end_years(settings)
    assert result.ok is True
    assert "⚠" not in result.detail


def test_pinned_end_year_check_reports_its_own_breakage() -> None:
    """A check that cannot evaluate must say so in red, never fall through to "none"."""
    broken = SimpleNamespace(model_fields_set={"ibge_end_year"}, ibge_end_year="not-a-year")
    result = doctor._check_pinned_end_years(broken)
    assert result.ok is False
    assert result.name == "Pinned END_YEAR"


def test_an_end_year_pinned_at_or_after_today_is_not_a_problem(settings_factory) -> None:
    """Pinning AHEAD of today is harmless (the window already covers every release)."""
    this_year = datetime.now(UTC).year
    settings = settings_factory(gcp_project_id="p", gcs_bucket="b", bcb_end_year=this_year)
    assert "⚠" not in doctor._check_pinned_end_years(settings).detail


def test_check_foreign_inflation_codes_pass(settings: Settings) -> None:
    """Both deflators declared, the ECB key carrying its dataflow prefix → ok."""
    result = doctor._check_foreign_inflation_codes(settings)
    assert result.ok is True
    assert "CPI" in result.detail and "HICP" in result.detail


def test_check_foreign_inflation_codes_fails_on_an_empty_series_id(settings: Settings) -> None:
    """An empty id makes dbt pivot on '' — the column comes out NULL and nothing else
    anywhere says why, which is the failure this whole feature exists to end."""
    settings.foreign_inflation_cpi_code = ""
    result = doctor._check_foreign_inflation_codes(settings)
    assert result.ok is False
    assert "CPI: empty" in result.detail


def test_check_foreign_inflation_codes_fails_on_a_prefixless_ecb_key(settings: Settings) -> None:
    """The ECB REST path is built by splitting the key at its FIRST dot, so a key with no
    dataflow prefix would request a dataflow that does not exist and 404 forever."""
    settings.foreign_inflation_hicp_code = "M-U2-N-000000-4-INX"
    result = doctor._check_foreign_inflation_codes(settings)
    assert result.ok is False
    assert "dataflow prefix" in result.detail


def test_check_foreign_inflation_codes_refuses_the_frozen_icp_dataflow(settings: Settings) -> None:
    """The key that nothing else catches: the ECB's ICP flow still answers 200 with data
    for any window up to 2025-12, so an operator .env copied before the move would ingest
    cleanly forever while the € deflator stood still. The detail names the successor."""
    settings.foreign_inflation_hicp_code = "ICP.M.U2.N.000000.4.INX"
    result = doctor._check_foreign_inflation_codes(settings)
    assert result.ok is False
    assert "frozen at 2025-12" in result.detail
    assert "HICP.M.U2.N.000000.4D0.INX" in result.detail


def test_check_foreign_inflation_codes_handles_an_unexpected_exception(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        type(settings),
        "foreign_inflation_pivot_codes",
        property(lambda self: (_ for _ in ()).throw(RuntimeError("boom"))),
    )
    result = doctor._check_foreign_inflation_codes(settings)
    assert result.ok is False and "boom" in result.detail


def _months_ago(n: int) -> date:
    """The first day of the month `n` months before today — the probe measures against
    the calendar, so a fixture pinned to a literal year would go stale on its own."""
    today = datetime.now(UTC).date()
    year, month0 = divmod(today.year * 12 + today.month - 1 - n, 12)
    return date(year, month0 + 1, 1)


def _bls_body(*months: date) -> dict:
    return {
        "status": "REQUEST_SUCCEEDED",
        "Results": {
            "series": [
                {
                    "data": [
                        {"year": str(m.year), "period": f"M{m.month:02d}", "value": "317.6"}
                        for m in months
                    ]
                }
            ]
        },
    }


def _ecb_body(*months: date) -> str:
    rows = "".join(f"HICP.M.U2.N.000000.4D0.INX,M,U2,{m:%Y-%m},103.69\n" for m in months)
    return "KEY,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\n" + rows


def _foreign_inflation_response(url: str) -> MagicMock:
    """A publisher answering NORMALLY — an HTTP 200 carrying a RECENT observation.

    Both halves need a real body, not a bare 200: each publisher has a way of saying
    "no data" while still returning 200, so the probe reads the body and a content-free
    mock would be indistinguishable from the refusals the tests below assert on. And the
    observation has to be recent, because a series that answers with data but has stopped
    advancing is the other 200 the probe exists to refuse.
    """
    response = MagicMock()
    response.raise_for_status.return_value = None
    if "api.bls.gov" in url:
        response.json.return_value = _bls_body(_months_ago(1))
    else:
        response.text = _ecb_body(_months_ago(1))
    return response


def _with_bls(body: dict):
    def get(url, **_kw):
        if "api.bls.gov" not in url:
            return _foreign_inflation_response(url)
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = body
        return response

    return get


def test_check_foreign_inflation_probes_both_publishers(settings: Settings) -> None:
    """Two publishers, one line — so the line has to report BOTH. A green check hiding a
    dead half would leave one currency silently un-deflatable."""
    with patch(
        "embrapa_dashboard.doctor.requests.get",
        side_effect=lambda url, **_kw: _foreign_inflation_response(url),
    ) as get:
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is True
    assert "bls." in result.detail and "ecb." in result.detail
    urls = [c.args[0] for c in get.call_args_list]
    assert any("/v1/timeseries/data/" in u for u in urls)
    ecb_url = next(u for u in urls if "/HICP/M.U2.N.000000.4D0.INX" in u)
    # The LATEST observation, not a fixed past year — a fixed year cannot see a series
    # that stopped, which is how the retired ICP key stayed green eight months behind.
    assert "lastNObservations=1" in ecb_url
    assert "startPeriod" not in ecb_url
    # And the detail says HOW recent, so a green line carries its own evidence.
    assert f"latest {_months_ago(1):%Y-%m}" in result.detail


def test_keyless_bls_window_is_a_warning_not_a_failure(settings: Settings) -> None:
    """Keyless v1 ignores the requested years and answers the latest three. That is its
    documented limit, harmless for a delta run and fatal for a backfill — so the line
    stays green and SAYS it, rather than going red on every keyless machine or staying
    silently green as it did while a backfill stored 3 years of 53."""
    body = _bls_body(_months_ago(30), _months_ago(1))
    assert not settings.bls_api_key
    with patch("embrapa_dashboard.doctor.requests.get", side_effect=_with_bls(body)):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is True
    assert "keyless v1 ignores the requested years" in result.detail
    assert "BLS_API_KEY" in result.detail


def test_keyed_bls_answer_outside_the_window_fails(settings: Settings) -> None:
    """Keyed, the call goes to v2, whose whole point is honouring the window. An answer
    outside it there is the same defect on the path the ingest depends on."""
    settings.bls_api_key = "SEGREDO123"
    body = _bls_body(_months_ago(30), _months_ago(1))
    with patch("embrapa_dashboard.doctor.requests.get", side_effect=_with_bls(body)):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    assert "ignored the requested window" in result.detail
    assert "SEGREDO123" not in result.detail


def test_bls_series_that_stopped_advancing_fails(settings: Settings) -> None:
    """Eight months back is always inside the probe's window (last year → this year), so
    the only thing wrong with this answer is its age — and that alone must turn it red."""
    body = _bls_body(_months_ago(8))
    with patch("embrapa_dashboard.doctor.requests.get", side_effect=_with_bls(body)):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    assert "8 months old" in result.detail and "stopped advancing" in result.detail


def test_ecb_series_that_stopped_advancing_fails(settings: Settings) -> None:
    """The ECB's ICP dataflow, as found on 2026-09-23: 200, a valued observation, and
    2025-12 as the newest one — eight months behind, with every older check green."""

    def ecb_frozen(url, **_kw):
        if "api.bls.gov" in url:
            return _foreign_inflation_response(url)
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.text = _ecb_body(_months_ago(8))
        return response

    with patch("embrapa_dashboard.doctor.requests.get", side_effect=ecb_frozen):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    assert "8 months old" in result.detail and "stopped advancing" in result.detail
    # The BLS half answered and still reads as such.
    assert "bls." in result.detail and "200 OK" in result.detail


def test_the_lag_allowance_covers_a_normal_release_calendar(settings: Settings) -> None:
    """CPI-U for month M is out mid-M+1, so on the 1st of a month the newest reading is two
    months back. That is a healthy series and must not read as a stopped one."""
    at_limit = _months_ago(doctor.FOREIGN_INDEX_MAX_LAG_MONTHS)

    def both_at_limit(url, **_kw):
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = _bls_body(at_limit)
        response.text = _ecb_body(at_limit)
        return response

    with patch("embrapa_dashboard.doctor.requests.get", side_effect=both_at_limit):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is True, result.detail


def test_check_foreign_inflation_fails_when_bls_refuses_with_http_200(
    settings: Settings,
) -> None:
    """The refusal that actually happens in the field, and the one a status-blind probe
    calls green: BLS reports a quota/throttle refusal as HTTP 200 with the bad news in
    the body. The keyless v1 quota is per calling IP, so a shared egress address reaches
    it without this project making a single request — and the answer carries NO
    observation. Vouching for that is worse than a red line: it certifies a deflator that
    is not there. Measured live on 2026-09-13, when the probe returned 'bls 200 OK'."""
    refusal = {
        "status": "REQUEST_NOT_PROCESSED",
        "message": [
            "Request could not be serviced, as the daily threshold for total number of "
            "requests allocated to the user with registration key  has been reached."
        ],
        "Results": {},
    }

    def bls_refuses(url, **_kw):
        if "api.bls.gov" not in url:
            return _foreign_inflation_response(url)
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = refusal
        return response

    with patch("embrapa_dashboard.doctor.requests.get", side_effect=bls_refuses):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    assert "REQUEST_NOT_PROCESSED" in result.detail
    # The reason travels with the verdict — "quota" and "BLS is down" need different
    # operator responses, and the detail line is the only place that distinction lands.
    assert "daily threshold" in result.detail
    # The half that DID answer stays green.
    assert "ecb." in result.detail and "200 OK" in result.detail


def test_check_foreign_inflation_fails_when_ecb_answers_200_with_no_observations(
    settings: Settings,
) -> None:
    """The ECB's counterpart of the same lie. A bogus series id is a clean 404 that
    raise_for_status already catches, but a window the series does not cover comes back
    200 with an EMPTY body — reachable host, no deflator."""

    def ecb_empty(url, **_kw):
        if "api.bls.gov" in url:
            return _foreign_inflation_response(url)
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.text = ""
        return response

    with patch("embrapa_dashboard.doctor.requests.get", side_effect=ecb_empty):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    assert "no observations" in result.detail
    assert "bls." in result.detail and "200 OK" in result.detail


def test_check_foreign_inflation_probes_v2_when_a_key_is_configured(settings: Settings) -> None:
    """The probe must exercise the endpoint the INGEST will actually use. The two BLS
    versions draw on DIFFERENT quotas — v1's 25/day is counted per calling IP and shared
    with every other caller on that address, v2's 500/day belongs to the key — so probing
    v1 for a keyed pipeline spends a quota the real run never touches and can report a
    refusal it never meets."""
    settings.bls_api_key = "SEGREDO123"
    with patch(
        "embrapa_dashboard.doctor.requests.get",
        side_effect=lambda url, **_kw: _foreign_inflation_response(url),
    ) as get:
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is True
    bls_url = next(c.args[0] for c in get.call_args_list if "api.bls.gov" in c.args[0])
    assert "/v2/timeseries/data/" in bls_url
    assert "registrationkey=SEGREDO123" in bls_url


def test_check_foreign_inflation_never_prints_the_key(settings: Settings) -> None:
    """The key rides the QUERY STRING, and requests puts the whole URL into its exception
    text. So the one path that reports a failure is also the one that would print the
    secret to the operator's terminal and into whatever captures that output."""
    settings.bls_api_key = "SEGREDO123"

    def bls_raises(url, **_kw):
        if "api.bls.gov" not in url:
            return _foreign_inflation_response(url)
        response = MagicMock()
        response.raise_for_status.side_effect = RuntimeError(f"404 Client Error for url: {url}")
        return response

    with patch("embrapa_dashboard.doctor.requests.get", side_effect=bls_raises):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    assert "SEGREDO123" not in result.detail
    assert "***" in result.detail


def test_redact_is_a_no_op_without_a_configured_key() -> None:
    """`"abc".replace("", x)` splices x between EVERY character, so an unguarded redaction
    would mangle every failure line on the default (keyless) setup — the common case."""
    plain = "404 Client Error for url: https://api.bls.gov/publicAPI/v1"
    assert doctor._redact(plain, "") == plain
    redacted = doctor._redact("registrationkey=abc123 refused", "abc123")
    assert redacted == "registrationkey=*** refused"


@pytest.mark.parametrize(
    ("caida", "marca", "erro"),
    [("data-api", "ECB 503", "ECB 503"), ("api.bls.gov", "BLS 503", "BLS 503")],
)
def test_check_foreign_inflation_fails_when_either_publisher_is_down(
    settings: Settings, caida: str, marca: str, erro: str
) -> None:
    """Both directions, because the two halves fail independently: US$ loses its deflator
    when BLS is down, € when the ECB is, and a check that only noticed one of them would
    be green while a currency silently had no correction."""

    def one_side_down(url, **_kw):
        if caida not in url:
            return _foreign_inflation_response(url)
        response = MagicMock()
        response.raise_for_status.side_effect = RuntimeError(erro)
        return response

    with patch("embrapa_dashboard.doctor.requests.get", side_effect=one_side_down):
        result = doctor._check_foreign_inflation(settings)
    assert result.ok is False
    # The half that DID answer is still reported — "one of the two is down" is the
    # actionable statement, not "foreign inflation is broken".
    assert "200 OK" in result.detail and marca in result.detail


def test_check_currency_series_codes_pass(settings: Settings) -> None:
    """The canonical daily PTAX codes (USD=1, EUR=21619) → ok."""
    settings.bcb_currency_series = "1:USD,21619:EUR"
    result = doctor._check_currency_series_codes(settings)
    assert result.ok is True
    assert "USD=1" in result.detail


def test_check_currency_series_codes_fails_on_stale_wrong_codes(settings: Settings) -> None:
    """The historical wrong USD code (3694, annual) → fail with a clear reason.

    The fixture defaults bcb_currency_series to the bad '3694:USD' — exactly the
    stale-.env drift that would silently regress the Gold val_yearfx_* columns."""
    result = doctor._check_currency_series_codes(settings)  # fixture = "3694:USD"
    assert result.ok is False
    assert "3694" in result.detail


def test_check_adc_returns_project_when_ok(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.google.auth.default") as auth:
        auth.return_value = (MagicMock(), "test-project")
        result = doctor._check_adc(settings)
    assert result.ok is True
    assert "test-project" in result.detail


def test_check_adc_fails_with_recovery_hint(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.google.auth.default") as auth:
        auth.side_effect = Exception("no credentials")
        result = doctor._check_adc(settings)
    assert result.ok is False
    assert "gcloud auth" in result.detail


def test_check_bq_calls_service_account(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        bq_cls.return_value.get_service_account_email.return_value = "sa@x.iam"
        result = doctor._check_bq(settings)
    assert result.ok is True
    assert "sa@x.iam" in result.detail


def test_check_gcs_reports_existing_bucket(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = iter([object()])
        result = doctor._check_gcs(settings)
    assert result.ok is True
    assert "exists" in result.detail


def test_check_gcs_passes_when_bucket_missing(settings: Settings) -> None:
    """Missing bucket is OK — it'll be lazily created on first ingest."""
    from google.cloud.exceptions import NotFound

    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.side_effect = NotFound("bucket not found")
        result = doctor._check_gcs(settings)
    assert result.ok is True
    assert "will be created" in result.detail


@responses.activate
def test_check_ibge_reachable(settings: Settings) -> None:
    responses.add(
        responses.GET,
        re.compile(r"https://servicodados\.ibge\.gov\.br/api/v3/agregados/289/metadados.*"),
        json={"classificacoes": []},
        status=200,
    )
    result = doctor._check_ibge(settings)
    assert result.ok is True


@responses.activate
def test_check_ibge_handles_5xx(settings: Settings) -> None:
    responses.add(
        responses.GET,
        re.compile(r"https://servicodados\.ibge\.gov\.br/api/v3/agregados/289/metadados.*"),
        status=503,
    )
    result = doctor._check_ibge(settings)
    assert result.ok is False


@responses.activate
def test_check_bcb_reachable(settings: Settings) -> None:
    responses.add(
        responses.GET,
        re.compile(r"https://api\.bcb\.gov\.br/dados/serie/bcdata\.sgs\.433/dados.*"),
        json=[{"data": "01/01/2024", "valor": "0.16"}],
        status=200,
    )
    result = doctor._check_bcb(settings)
    assert result.ok is True
    assert "sgs.433" in result.detail


def _comex_url(settings: Settings, year: int) -> str:
    return f"{settings.comex_csv_base_url.rstrip('/')}/EXP_{year}.csv"


@responses.activate
def test_check_comex_ok_when_end_year_file_published(settings: Settings) -> None:
    settings.comex_end_year = 2026
    responses.add(responses.HEAD, _comex_url(settings, 2026), status=200)
    result = doctor._check_comex(settings)
    assert result.ok is True
    assert "EXP_2026.csv 200 OK" in result.detail


@responses.activate
def test_check_comex_treats_current_year_404_as_healthy(settings: Settings) -> None:
    """Early in the year MDIC hasn't published EXP_<end_year>.csv yet.

    The ingest pipeline classifies that 404 as an expected skip, so doctor
    must not exit 1 for it — it falls back to probing the previous year.
    """
    settings.comex_end_year = 2026
    responses.add(responses.HEAD, _comex_url(settings, 2026), status=404)
    responses.add(responses.HEAD, _comex_url(settings, 2025), status=200)
    result = doctor._check_comex(settings)
    assert result.ok is True
    assert "EXP_2025.csv 200 OK" in result.detail
    assert "not published yet" in result.detail


@responses.activate
def test_check_comex_fails_when_previous_year_also_unreachable(settings: Settings) -> None:
    """404 on BOTH years is a real problem (wrong base URL, host down), not
    the expected not-yet-published window."""
    settings.comex_end_year = 2026
    responses.add(responses.HEAD, _comex_url(settings, 2026), status=404)
    responses.add(responses.HEAD, _comex_url(settings, 2025), status=404)
    result = doctor._check_comex(settings)
    assert result.ok is False


@responses.activate
def test_check_comex_fails_on_5xx_without_fallback(settings: Settings) -> None:
    """Only the expected 404 triggers the previous-year fallback — a 5xx is a
    hard failure straight away."""
    settings.comex_end_year = 2026
    responses.add(responses.HEAD, _comex_url(settings, 2026), status=503)
    result = doctor._check_comex(settings)
    assert result.ok is False
    assert len(responses.calls) == 1


def test_check_bronze_tables_distinguishes_present_vs_missing(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        client = bq_cls.return_value
        # First table found, the rest missing. The count comes from the REGISTRY, not a
        # hand-kept literal: this test broke when the silviculture Bronze target was added
        # (2026-08-29) for no reason of its own, and the next source would have broken it
        # again. What it is about is present-vs-missing, not how many targets exist.
        client.get_table.side_effect = [MagicMock()] + [
            NotFound("nope") for _ in doctor.BRONZE_TARGETS[1:]
        ]
        result = doctor._check_bronze_tables(settings)
    assert result.ok is True  # informational only
    assert "missing" in result.detail


def test_check_serving_marts_all_present_and_populated(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        bq_cls.return_value.get_table.return_value = MagicMock(num_rows=100)
        result = doctor._check_serving_marts(settings)
    assert result.ok is True
    assert "all present" in result.detail


def test_check_serving_marts_reports_missing(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        # First eight targets present; gold_source_metadata (the 9th target) missing.
        bq_cls.return_value.get_table.side_effect = [
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),
            MagicMock(num_rows=10),  # serving_quality_history
            NotFound("nope"),
        ]
        result = doctor._check_serving_marts(settings)
    assert result.ok is True  # informational, never fails doctor on a fresh project
    assert "missing" in result.detail
    assert "dbt-build-prod" in result.detail


def test_check_serving_marts_flags_empty_mart(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        # serving_pevs_annual is empty (0 rows); the view (last) reports
        # num_rows=0 too — but only the materialized mart may be flagged.
        bq_cls.return_value.get_table.side_effect = [
            MagicMock(num_rows=0, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),  # serving_quality_history
            MagicMock(num_rows=0, table_type="VIEW"),
        ]
        result = doctor._check_serving_marts(settings)
    assert result.ok is True
    assert "empty=['serving_pevs_annual']" in result.detail


def test_check_serving_marts_view_with_zero_num_rows_is_not_empty(settings: Settings) -> None:
    """The BigQuery API returns numRows=0 for VIEWs (verified against the live
    API) — gold_source_metadata must not be flagged 'empty' on every run."""
    with patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls:
        bq_cls.return_value.get_table.side_effect = [
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),
            MagicMock(num_rows=10, table_type="TABLE"),  # serving_quality_history
            MagicMock(num_rows=0, table_type="VIEW"),  # gold_source_metadata
        ]
        result = doctor._check_serving_marts(settings)
    assert result.ok is True
    assert "empty" not in result.detail
    assert "all present + populated" in result.detail


def _list_blobs_mock(prefixes: list[str]) -> MagicMock:
    """Build a list_blobs() return-value that exposes ``prefixes`` after iteration.

    The real GCS HTTPIterator only fills ``prefixes`` once the page iterator
    has been drained, so the production code does ``list(blobs)`` before
    reading ``.prefixes``. MagicMock's default ``__iter__`` already returns
    an empty iterator, so we only need to set the prefixes attribute.
    """
    iterator = MagicMock()
    iterator.prefixes = prefixes
    return iterator


def _mark_complete(gcs_cls: MagicMock, complete_markers: set[str] | None = None) -> None:
    """Configure which `_SUCCESS` marker blobs exist on the mocked GCS client.

    ``None`` means every snapshot is complete (every marker exists); otherwise
    only the given blob names exist — modelling crashed half-backups.
    """

    def _blob(name: str) -> MagicMock:
        blob = MagicMock()
        blob.exists.return_value = complete_markers is None or name in complete_markers
        return blob

    gcs_cls.return_value.bucket.return_value.blob.side_effect = _blob


def test_check_backup_freshness_reports_fresh_snapshot(settings: Settings) -> None:
    """Recent snapshot (well within threshold): ok=True, no warn marker."""
    now = datetime.now(UTC)
    recent = (now - timedelta(days=2)).strftime("%Y%m%dT%H%M%SZ")
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock([f"backups/run={recent}/"])
        _mark_complete(gcs_cls)
        result = doctor._check_backup_freshness(settings)
    assert result.ok is True
    assert "⚠" not in result.detail
    assert "2d ago" in result.detail or "1d ago" in result.detail


def test_check_backup_freshness_warns_on_stale(settings: Settings) -> None:
    """Snapshot older than BACKUP_STALENESS_DAYS: ok=True but ⚠ in detail."""
    settings.backup_staleness_days = 14
    stale_ts = (datetime.now(UTC) - timedelta(days=30)).strftime("%Y%m%dT%H%M%SZ")
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock(
            [f"backups/run={stale_ts}/"]
        )
        _mark_complete(gcs_cls)
        result = doctor._check_backup_freshness(settings)
    assert result.ok is True  # warn, not fail
    assert "⚠" in result.detail
    assert "stale" in result.detail


def test_check_backup_freshness_picks_latest_of_many(settings: Settings) -> None:
    """When multiple snapshots exist, freshness is measured from the most recent one."""
    now = datetime.now(UTC)
    old = (now - timedelta(days=400)).strftime("%Y%m%dT%H%M%SZ")
    middle = (now - timedelta(days=100)).strftime("%Y%m%dT%H%M%SZ")
    recent = (now - timedelta(days=3)).strftime("%Y%m%dT%H%M%SZ")
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock(
            [
                f"backups/run={old}/",
                f"backups/run={recent}/",
                f"backups/run={middle}/",
            ]
        )
        _mark_complete(gcs_cls)
        result = doctor._check_backup_freshness(settings)
    assert result.ok is True
    assert "⚠" not in result.detail


def test_check_backup_freshness_skips_incomplete_snapshot(settings: Settings) -> None:
    """A crashed half-backup (run prefix without _SUCCESS) must not satisfy
    freshness — the newest COMPLETE snapshot counts instead."""
    now = datetime.now(UTC)
    complete_ts = (now - timedelta(days=3)).strftime("%Y%m%dT%H%M%SZ")
    partial_ts = (now - timedelta(days=1)).strftime("%Y%m%dT%H%M%SZ")
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock(
            [f"backups/run={complete_ts}/", f"backups/run={partial_ts}/"]
        )
        _mark_complete(gcs_cls, {f"backups/run={complete_ts}/_SUCCESS"})
        result = doctor._check_backup_freshness(settings)
    assert result.ok is True
    assert "3d ago" in result.detail  # measured from the complete one, not 1d
    assert "skipped 1 newer" in result.detail


def test_latest_complete_run_skips_snapshot_of_different_dataset(settings: Settings) -> None:
    """A COMPLETE snapshot whose manifest records a DIFFERENT dataset (e.g. a dev-pointed .env
    snapshotting dbt_dev_gold) must NOT satisfy a gate for settings.bq_gold_dataset — the newest
    matching-dataset run wins instead, and the mismatch counts as skipped."""
    import json as _json

    now = datetime.now(UTC)
    newer = (now - timedelta(days=1)).strftime("%Y%m%dT%H%M%SZ")
    older = (now - timedelta(days=3)).strftime("%Y%m%dT%H%M%SZ")
    runs = [
        (datetime.strptime(newer, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC), f"backups/run={newer}/"),
        (datetime.strptime(older, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC), f"backups/run={older}/"),
    ]
    other = settings.bq_gold_dataset + "_other"  # guaranteed != the configured dataset

    def _blob(name: str) -> MagicMock:
        blob = MagicMock()
        blob.exists.return_value = True
        dataset = other if newer in name else settings.bq_gold_dataset
        blob.download_as_text.return_value = _json.dumps({"dataset": dataset})
        return blob

    client = MagicMock()
    client.bucket.return_value.blob.side_effect = _blob
    latest, skipped = doctor._latest_complete_run(client, settings, runs)
    assert latest == runs[1][0]  # the older run OF THE CONFIGURED dataset, not the newer dev one
    assert skipped == 1  # the newer, other-dataset snapshot was skipped


def test_check_backup_freshness_fails_when_only_incomplete_snapshots(settings: Settings) -> None:
    """Run prefixes exist but none carries the _SUCCESS marker → hard fail.

    This is exactly the partial/failed-backup scenario: the operator must not
    be told the cold-storage rollback path is intact."""
    fresh_ts = (datetime.now(UTC) - timedelta(days=1)).strftime("%Y%m%dT%H%M%SZ")
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock(
            [f"backups/run={fresh_ts}/"]
        )
        _mark_complete(gcs_cls, set())  # no marker anywhere
        result = doctor._check_backup_freshness(settings)
    assert result.ok is False
    assert "_SUCCESS" in result.detail
    assert "dbt-build-prod-with-backup" in result.detail


def test_check_backup_freshness_fails_when_no_snapshot(settings: Settings) -> None:
    """Empty backups/ prefix is a hard fail with a recovery hint."""
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock([])
        result = doctor._check_backup_freshness(settings)
    assert result.ok is False
    assert "dbt-build-prod-with-backup" in result.detail


def test_check_backup_freshness_ignores_malformed_prefixes(settings: Settings) -> None:
    """Stray prefixes that don't match the run=<ts>/ pattern are skipped.

    A human poking around with `gsutil cp` could land arbitrary objects under
    `backups/`; the probe must not crash and must not let them count as a
    snapshot.
    """
    with patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls:
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock(
            ["backups/ad-hoc-thing/", "backups/run=not-a-timestamp/"]
        )
        result = doctor._check_backup_freshness(settings)
    assert result.ok is False  # no valid snapshot → fail like the empty case
    assert "no snapshot" in result.detail


def test_run_all_executes_every_probe(settings: Settings) -> None:
    """run_all should call each probe exactly once in CHECKS order."""
    with (
        patch("embrapa_dashboard.doctor.google.auth.default") as auth,
        patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls,
        patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls,
        patch("embrapa_dashboard.doctor.requests.get") as get,
        patch("embrapa_dashboard.doctor.requests.head") as head,
    ):
        auth.return_value = (MagicMock(), "p")
        bq_cls.return_value.get_service_account_email.return_value = "sa@x"
        bq_cls.return_value.get_table.return_value = MagicMock()
        gcs_cls.return_value.bucket.return_value.exists.return_value = True
        # list_blobs is consumed twice: once by _check_gcs (truthy iterator)
        # and once by _check_backup_freshness (prefixes attribute).
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock([])
        get.return_value.status_code = 200
        get.return_value.raise_for_status.return_value = None
        # _check_comex probes with HEAD (avoids pulling the 100+ MB body).
        head.return_value.status_code = 200
        head.return_value.raise_for_status.return_value = None

        results = doctor.run_all(settings)

    assert len(results) == len(doctor.CHECKS)
    assert [r.name for r in results] == [
        ".env parsed",
        "Pinned END_YEAR",
        "Inflation pivot codes",
        "Currency series codes",
        "Foreign inflation codes",
        "PAM variable codes",
        "IBGE PEVS variable codes",
        "IBGE silvicultura variable codes",
        "ADC credentials",
        "BigQuery reachable",
        "GCS bucket",
        "IBGE SIDRA reachable",
        "IBGE SIDRA silvicultura reachable",
        "IBGE PAM reachable",
        "IBGE PPM reachable",
        "BCB SGS reachable",
        "Foreign inflation reachable",
        "COMEX reachable",
        "COMTRADE reachable",
        "Bronze tables",
        "Serving marts",
        "Quality-tag drift",
        "Catalog↔env product codes",
        "Curation backup coverage",
        "Curation referential integrity",
        "Shared code across SIDRA tables",
        "Catalog orphan lifecycle",
        "Catalog → Gold arrival",
        "Gold backup freshness",
        "Source data freshness",
        "Ingest heartbeat",
    ]


# cli.INGESTS source name → the doctor SOURCE_CHECKS key that covers it. The two
# registries are independent lists keyed by DIFFERENT names: the CLI uses
# 'ibge-pam'/'bcb-inflation'/'bcb-currency'; doctor groups them as 'pam'/'bcb'
# (one probe per upstream API, not per ingest leg). This map IS the documented
# contract (docs/adding_a_data_source.md, CLAUDE.md) — the test below fails the
# moment a new IngestSpec is added without wiring up its doctor coverage.
_INGEST_TO_DOCTOR_CHECK = {
    "ibge": "ibge",
    # The other half of the SAME survey (SIDRA t291) — its own ingest and its own
    # SIDRA-reachability probe, one banco.
    "ibge-silvicultura": "silvicultura",
    "ibge-pam": "pam",
    "ibge-ppm": "ppm",
    "bcb-inflation": "bcb",
    "bcb-currency": "bcb",
    # The foreign deflators (BLS CPI-U · ECB HICP) that correct US$ and €. One ingest,
    # one probe — but the probe reports BOTH publishers, because a green line hiding a
    # dead half would leave one currency silently un-deflatable.
    "foreign-inflation": "foreign-inflation",
    "comex": "comex",
    "comtrade": "comtrade",
}


def test_every_ingest_source_is_covered_by_a_doctor_check() -> None:
    """Registry-drift guard. Adding a source means updating cli.INGESTS AND
    doctor.SOURCE_CHECKS/BRONZE_TARGETS (per docs/adding_a_data_source.md), but the
    lists don't reference each other, so a missed doctor entry is silent today. This
    pins the three registries together."""
    from embrapa_dashboard import cli

    ingest_names = {spec.name for spec in cli.INGESTS}
    doctor_keys = {name for name, _ in doctor.SOURCE_CHECKS}

    # The alias map covers exactly the registered ingest sources (fails if a new
    # IngestSpec lands without being mapped here).
    assert ingest_names == set(_INGEST_TO_DOCTOR_CHECK), (
        "cli.INGESTS drifted from the registry-drift map; "
        f"symmetric diff: {ingest_names ^ set(_INGEST_TO_DOCTOR_CHECK)}"
    )

    # Every mapped doctor key actually exists as a SOURCE_CHECK …
    missing = {k for k in _INGEST_TO_DOCTOR_CHECK.values() if k not in doctor_keys}
    assert not missing, f"ingest sources map to non-existent doctor checks: {missing}"

    # … and no SOURCE_CHECK is an orphan (unreachable from any ingest source).
    orphans = doctor_keys - set(_INGEST_TO_DOCTOR_CHECK.values())
    assert not orphans, f"doctor SOURCE_CHECKS has keys no ingest source maps to: {orphans}"


# ── "a probe must never raise INTO run_all" — swept, not spot-checked ─────────
# The invariant was already written down (see the silvicultura case further down) and
# already false: `_check_comex` read `settings.comex_flows_list` before its own try and
# `_check_bcb` caught only StopIteration, so a malformed .env — the very condition
# `embrapa doctor` exists to pre-empt — raised out of run_all's comprehension. The
# operator got a traceback and NONE of the 29 rows, including the `.env parsed ✗` that
# had already diagnosed it. A one-probe assertion could not see that; a sweep can.
_ENV_BREAKAGES = [
    pytest.param({"comex_flows": ""}, id="COMEX_FLOWS empty"),
    pytest.param({"comex_flows": "exportacao"}, id="COMEX_FLOWS invalid"),
    pytest.param({"bcb_inflation_series": "433_no_colon"}, id="BCB_INFLATION_SERIES malformed"),
    pytest.param({"bcb_currency_series": "1_no_colon"}, id="BCB_CURRENCY_SERIES malformed"),
    pytest.param({"comex_ncm_codes": "08012100_no_colon"}, id="COMEX_NCM_CODES malformed"),
    pytest.param({"comtrade_flows": "NOPE"}, id="COMTRADE_FLOWS invalid"),
    pytest.param({"pam_product_codes": "x:"}, id="PAM_PRODUCT_CODES malformed"),
]


@pytest.mark.parametrize("breakage", _ENV_BREAKAGES)
def test_no_probe_raises_on_a_malformed_env(settings: Settings, breakage: dict) -> None:
    """EVERY probe answers with a CheckResult, never an exception — whatever the .env.

    Swept over the whole registry rather than asserted on one probe: the two that broke
    this were not the one the original assertion happened to pick.
    """
    for field, value in breakage.items():
        setattr(settings, field, value)
    raised: list[str] = []
    with (
        patch("embrapa_dashboard.doctor.requests.get") as get,
        patch("embrapa_dashboard.doctor.requests.head") as head,
        patch("embrapa_dashboard.doctor.google.auth.default") as auth,
        patch("embrapa_dashboard.doctor.get_credentials", return_value=MagicMock()),
        patch("embrapa_dashboard.doctor.bigquery.Client") as bq_cls,
        patch("embrapa_dashboard.doctor.storage.Client") as gcs_cls,
        patch("embrapa_dashboard.gcp.clients.resolve_bq_client", return_value=MagicMock()),
    ):
        auth.return_value = (MagicMock(), "p")
        for mock in (get, head):
            mock.return_value.status_code = 200
            mock.return_value.raise_for_status.return_value = None
            mock.return_value.json.return_value = {"status": "REQUEST_SUCCEEDED"}
            mock.return_value.text = "header\nrow\n"
        bq_cls.return_value.get_table.return_value = MagicMock()
        gcs_cls.return_value.list_blobs.return_value = _list_blobs_mock([])
        for key, probe in doctor.CHECKS:
            try:
                result = probe(settings)
            except Exception as exc:
                raised.append(f"{key}: {type(exc).__name__}: {exc}")
                continue
            if not isinstance(result, doctor.CheckResult):
                raised.append(f"{key}: returned {type(result).__name__}")
    assert raised == []


def _raise_boom(_settings) -> doctor.CheckResult:
    raise RuntimeError("boom")


def _raise_not_found(_settings) -> doctor.CheckResult:
    raise NotFound("no such table")


def test_run_all_survives_a_probe_that_raises() -> None:
    """The structural guarantee: a blown-up probe costs its OWN row, not the report.

    Named by its REGISTRY KEY, because the display name lives inside the probe and a
    probe that raised before returning is exactly the one that cannot supply it.
    """
    survivor = doctor.CheckResult("sobrevivente", True, "ok")
    stub = [("explosiva", _raise_boom), ("outra", lambda _s: survivor)]
    with patch.object(doctor, "CHECKS", stub):
        results = doctor.run_all(Settings(_env_file=None, gcp_project_id="p", gcs_bucket="b"))

    assert len(results) == 2  # the raiser did NOT take the other probe down
    assert results[0].name == "explosiva" and results[0].ok is False
    assert "CHECK QUEBRADO" in results[0].detail and "boom" in results[0].detail
    assert results[1] is survivor


def test_run_all_treats_a_missing_table_as_skipped_not_broken() -> None:
    """A probe escaping with NotFound is a cold install, not a broken check — the same
    distinction `_skip_ou_quebra` draws inside a probe, applied at the boundary."""
    with patch.object(doctor, "CHECKS", [("ausente", _raise_not_found)]):
        results = doctor.run_all(Settings(_env_file=None, gcp_project_id="p", gcs_bucket="b"))

    assert results[0].ok is True
    assert results[0].detail.startswith("skipped:")


def test_pam_variable_codes_parity_passes_on_defaults(settings: Settings) -> None:
    """The 5 dbt PAM variable roles (8331/216/214/112/215) are all in the default
    PAM_VARIABLE_CODES → the parity check passes."""
    result = doctor._check_pam_variable_codes(settings)
    assert result.ok is True
    assert "5" in result.detail


def test_pam_variable_codes_parity_fails_when_a_dbt_code_is_dropped(settings_factory) -> None:
    """Dropping a code the dbt model needs (here 215 valor) must fail the parity
    check — that column would silently come out empty in Gold."""
    s = settings_factory(pam_variable_codes="8331,216,214,112")  # no 215 (valor)
    result = doctor._check_pam_variable_codes(s)
    assert result.ok is False
    assert "215" in result.detail


def test_ibge_variable_codes_parity_passes_on_defaults(settings: Settings) -> None:
    """The 2 PEVS variable codes (144 quantidade, 145 valor) match the defaults →
    the parity check passes (the PEVS analogue of the PAM check)."""
    result = doctor._check_ibge_variable_codes(settings)
    assert result.ok is True
    assert "144" in result.detail and "145" in result.detail


def test_ibge_variable_codes_parity_fails_on_typo(settings_factory) -> None:
    """A mistyped PEVS quantity code (144→143) must fail parity — silver_ibge_pevs would
    filter to a non-existent code and the quantity Gold column would come out empty."""
    s = settings_factory(ibge_variable_quantity_code="143")
    result = doctor._check_ibge_variable_codes(s)
    assert result.ok is False
    assert "144" in result.detail  # the required 'quantidade' code, now missing


def _small_codes(settings_factory):
    return settings_factory(
        ibge_product_codes="3405",
        silvicultura_product_codes="3457",
        pam_product_codes="40124",
        ppm_herd_product_codes="2670",
        ppm_animal_product_codes="2682",
    )


def test_catalog_parity_empty_uses_env(monkeypatch, settings_factory) -> None:
    """An empty/absent catalog → the check reports env fallback, no drift, never fails."""
    from embrapa_dashboard.ibge import catalog_resolver

    monkeypatch.setattr(catalog_resolver, "read_catalog_codes", lambda *a, **k: [])
    r = doctor._check_catalog_resolver_parity(_small_codes(settings_factory))
    assert r.ok is True
    assert "vazio" in r.detail and "DRIFT" not in r.detail


def test_catalog_parity_matches_env(monkeypatch, settings_factory) -> None:
    """Catalog codes equal to the .env codes per banco → OK, no drift."""
    from embrapa_dashboard.ibge import catalog_resolver

    codes = {
        ("pevs", "289"): ["3405"],
        ("pevs", "291"): ["3457"],
        ("pam", None): ["40124"],
        ("ppm", "3939"): ["2670"],
        ("ppm", "74"): ["2682"],
    }
    monkeypatch.setattr(
        catalog_resolver,
        "read_catalog_codes",
        lambda s, banco, *, tabela=None, bq_client=None: codes[(banco, tabela)],
    )
    r = doctor._check_catalog_resolver_parity(_small_codes(settings_factory))
    assert r.ok is True
    assert "OK" in r.detail and "DRIFT" not in r.detail


def test_catalog_parity_reports_drift_without_failing(monkeypatch, settings_factory) -> None:
    """An extra catalog code is reported as DRIFT but the check still passes (intended
    change, not an error) — an operator sees what the next run would pull."""
    from embrapa_dashboard.ibge import catalog_resolver

    codes = {
        ("pevs", "289"): ["3405", "9999"],
        ("pevs", "291"): ["3457"],
        ("pam", None): ["40124"],
        ("ppm", "3939"): ["2670"],
        ("ppm", "74"): ["2682"],
    }
    monkeypatch.setattr(
        catalog_resolver,
        "read_catalog_codes",
        lambda s, banco, *, tabela=None, bq_client=None: codes[(banco, tabela)],
    )
    r = doctor._check_catalog_resolver_parity(_small_codes(settings_factory))
    assert r.ok is True  # never fails on intended drift
    assert "DRIFT" in r.detail and "9999" in r.detail


def test_catalog_parity_compares_each_pevs_half_separately(monkeypatch, settings_factory) -> None:
    """PEVS spans two SIDRA tables since 2026-08-29, so it is compared PER TABLE like ppm.

    Comparing the token as a whole against IBGE_PRODUCT_CODES (t289 only) reported the
    silviculture codes as DRIFT forever — correct-by-design, and the kind of standing red
    herring that teaches an operator to stop reading doctor. Asserts on the SCOPES the
    check asks for, because a bare-token read is exactly the regression."""
    from embrapa_dashboard.ibge import catalog_resolver

    pedidos = []

    def _fake(s, banco, *, tabela=None, bq_client=None):
        pedidos.append((banco, tabela))
        return {"289": ["3405"], "291": ["3457"], "3939": ["2670"], "74": ["2682"]}.get(
            tabela, ["40124"]
        )

    monkeypatch.setattr(catalog_resolver, "read_catalog_codes", _fake)
    r = doctor._check_catalog_resolver_parity(_small_codes(settings_factory))

    assert ("pevs", "289") in pedidos and ("pevs", "291") in pedidos
    assert ("pevs", None) not in pedidos, "leitura do token inteiro — a metade some no DRIFT"
    assert "pevs:289 OK" in r.detail and "pevs:291 OK" in r.detail
    assert "DRIFT" not in r.detail


def test_bronze_targets_reference_real_settings_fields(settings: Settings) -> None:
    """Typo guard for the third registry: every (dataset_attr, table_attr) in
    doctor.BRONZE_TARGETS must name a real Settings field, else _check_bronze_tables
    would raise AttributeError at runtime instead of probing the table."""
    for dataset_attr, table_attr in doctor.BRONZE_TARGETS:
        assert hasattr(settings, dataset_attr), f"BRONZE_TARGETS: no Settings.{dataset_attr}"
        assert hasattr(settings, table_attr), f"BRONZE_TARGETS: no Settings.{table_attr}"


class _N:
    def __init__(self, n: int) -> None:
        self.n = n


def test_check_orphan_lifecycle_flags_unmarked(monkeypatch, settings: Settings) -> None:
    """A soft-warn when more catalog removals exist than lifecycle-marked ones (the
    mark-orphans step probably didn't run). Advisory (ok=True)."""
    client = MagicMock()
    client.query.return_value.result.side_effect = [[_N(3)], [_N(1)]]
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_orphan_lifecycle(settings)

    assert r.ok is True and "unmarked" in r.detail


def test_check_orphan_lifecycle_all_marked(monkeypatch, settings: Settings) -> None:
    """When every removal is already marked, the check reports the clean state."""
    client = MagicMock()
    client.query.return_value.result.side_effect = [[_N(2)], [_N(2)]]
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_orphan_lifecycle(settings)

    assert r.ok is True and "all marked" in r.detail


def test_check_orphan_lifecycle_error_degrades_to_skipped(monkeypatch, settings: Settings) -> None:
    """Tabelas ausentes / sem permissão degradam para 'skipped'. A exceção aqui é uma
    NotFound de verdade, e não um RuntimeError qualquer: desde a v1.46.4 só a AUSÊNCIA de
    dado vale verde — um check que simplesmente quebrou fica vermelho."""

    def _boom(s):
        raise NotFound("no dataset")

    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", _boom)

    r = doctor._check_orphan_lifecycle(settings)

    assert r.ok is True and "skipped" in r.detail


class _Row:
    def __init__(self, banco: str, codigo_produto: str) -> None:
        self.banco = banco
        self.codigo_produto = codigo_produto


def test_check_catalog_data_arrival_clean(monkeypatch, settings: Settings) -> None:
    """No cataloged produto missing from Gold → the clean state."""
    client = MagicMock()
    client.query.return_value.result.return_value = []
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_catalog_data_arrival(settings)

    assert r.ok is True and "every cataloged produto has data" in r.detail


def test_check_catalog_data_arrival_reports_missing_grouped_by_banco(
    monkeypatch, settings: Settings
) -> None:
    """The source-agnostic backstop for "registered, but the pipeline never fetched it".

    Each banco family solves scope growth differently (IBGE full-window backfill, COMEX
    filter fingerprint, COMTRADE cmd_scope re-fetch) — and COMTRADE had NO mechanism until
    2026-08, so a produto registered against it sat empty with nothing reporting the fact.
    This check does not care HOW a banco ingests, only whether what a researcher registered
    actually shows up, so a FUTURE banco with a missing or broken mechanism is covered too.
    """
    client = MagicMock()
    client.query.return_value.result.return_value = [
        _Row("comtrade", "140110"),
        _Row("comtrade", "200591"),
    ]
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_catalog_data_arrival(settings)

    # Advisory, never a failure: a produto registered minutes ago is legitimately empty.
    assert r.ok is True
    assert "2 cataloged produto(s) with NO Gold data" in r.detail
    assert "comtrade: 140110,200591" in r.detail


def test_check_catalog_data_arrival_degrades_on_error(monkeypatch, settings: Settings) -> None:
    """A missing table / permission fault degrades to 'skipped' — doctor must not blow up
    over an advisory probe."""
    client = MagicMock()
    client.query.side_effect = NotFound("no such table")
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_catalog_data_arrival(settings)

    assert r.ok is True and r.detail.startswith("skipped:")


# ── advisory fall-throughs that were never exercised (coverage-gate re-arm, 2026-08-20) ──
#
# `doctor` is a health REPORT: a probe that cannot answer must degrade to an advisory
# line, never crash the whole report or — worse — report a false green.


def test_check_ibge_variable_codes_degrades_when_the_config_read_faults(
    monkeypatch, settings: Settings
) -> None:
    """A malformed/unreadable variable-code config must surface as a FAILED check with
    the reason, not raise out of `doctor` and take every remaining probe with it."""

    class _Boom:
        def __getattr__(self, name):
            raise RuntimeError("config exploded")

    r = doctor._check_ibge_variable_codes(_Boom())

    assert r.ok is False
    assert "config exploded" in r.detail


def test_check_catalog_resolver_parity_is_advisory_when_the_catalog_read_faults(
    monkeypatch, settings: Settings
) -> None:
    """This probe DIFFS the catalog against .env — informational only. If the catalog
    can't be read it reports `skipped` and stays ok=True: a curation-side fault must not
    make the pipeline's health look broken."""
    monkeypatch.setattr(
        "embrapa_dashboard.ibge.catalog_resolver.read_catalog_codes",
        MagicMock(side_effect=NotFound("research_inputs absent")),
    )

    r = doctor._check_catalog_resolver_parity(settings)

    assert r.ok is True
    assert "skipped" in r.detail


def test_check_catalog_resolver_parity_falls_back_to_env_when_the_catalog_is_empty(
    monkeypatch, settings: Settings
) -> None:
    """An empty catalog is the pre-adoption state, not drift: the probe says so per
    banco (`vazio→.env(n)`) instead of reporting every configured code as removed."""
    monkeypatch.setattr(
        "embrapa_dashboard.ibge.catalog_resolver.read_catalog_codes", MagicMock(return_value=[])
    )

    r = doctor._check_catalog_resolver_parity(settings)

    assert r.ok is True
    assert "vazio→.env(" in r.detail


# ── Source data freshness ────────────────────────────────────────────────────
# The check answers "is the newest reference period as new as the cadence implies?", NOT
# "did the scheduler run" — see the docstring. These pin the cadence-dependent floor,
# because that is the whole content of the check.
def _freshness_rows(*triples):
    """(source, cadence, year_end[, period_end]) → the rows gold_source_metadata returns.

    `period_end` defaults to 31/12 of `year_end`, which is what the view emits for an
    annual source. A monthly source passes its own date — that column exists precisely
    because `year_end` cannot express mid-year staleness.
    """
    rows = []
    for triple in triples:
        source, cadence, year_end = triple[:3]
        period_end = (
            triple[3] if len(triple) > 3 else (date(year_end, 12, 31) if year_end else None)
        )
        rows.append(
            SimpleNamespace(
                source=source, cadence=cadence, year_end=year_end, period_end=period_end
            )
        )
    return rows


def _all_sources(*overrides):
    """Every expected source present, so a test can isolate ONE of them.

    Without this a fixture naming two sources would trip the new "missing source" finding
    on the other three, and the assertion under test would pass for the wrong reason.
    """
    year = datetime.now(UTC).year
    base = {
        "ibge_pevs": ("ibge_pevs", "annual", year),
        "ibge_pam": ("ibge_pam", "annual", year),
        "ibge_ppm": ("ibge_ppm", "annual", year),
        "mdic_comex": ("mdic_comex", "monthly", year, date(year, 12, 31)),
        "un_comtrade": ("un_comtrade", "annual", year),
    }
    for override in overrides:
        base[override[0]] = override
    return _freshness_rows(*base.values())


def _patch_freshness(rows):
    """Stand in for the one BigQuery read the check makes."""
    client = MagicMock()
    client.query.return_value.result.return_value = rows
    return patch("embrapa_dashboard.doctor.bigquery.Client", return_value=client)


def test_source_freshness_all_current(settings: Settings) -> None:
    year = datetime.now(UTC).year
    settings.source_freshness_annual_slack_years = 2
    with _patch_freshness(_all_sources(("ibge_pevs", "annual", year - 2))):
        result = doctor._check_source_data_freshness(settings)
    assert result.ok is True
    assert "⚠" not in result.detail
    assert "every expected source current" in result.detail


def test_source_freshness_warns_when_annual_source_falls_behind(settings: Settings) -> None:
    """One year past the slack window: the publication window came and went."""
    year = datetime.now(UTC).year
    settings.source_freshness_annual_slack_years = 2
    with _patch_freshness(
        _all_sources(("ibge_ppm", "annual", year - 3), ("ibge_pevs", "annual", year - 1))
    ):
        result = doctor._check_source_data_freshness(settings)
    assert result.ok is True  # warn, never fail — a lagging source is a signal to look
    assert "⚠" in result.detail
    assert "ibge_ppm" in result.detail
    assert "ibge_pevs" not in result.detail  # the healthy one is not named as overdue


def test_source_freshness_flags_a_missing_year_end(settings: Settings) -> None:
    with _patch_freshness(_all_sources(("mdic_comex", "monthly", None))):
        result = doctor._check_source_data_freshness(settings)
    assert "⚠" in result.detail
    assert "no year_end" in result.detail


# ── the monthly window: measured in MONTHS, off period_end ───────────────────
# It compared YEARS, so a COMEX that stopped publishing in month M of year Y kept
# reporting year_end = Y and only tripped in January of Y+2 — 13 to 24 months late,
# where the comment promised about one. The test that "pinned" this used year-2, so
# the real case (year-1) was never covered.
def test_source_freshness_catches_a_monthly_source_stalled_inside_the_current_year(
    settings: Settings,
) -> None:
    year = datetime.now(UTC).year
    settings.source_freshness_monthly_slack_months = 3
    stalled = date(year, 1, 31) if datetime.now(UTC).month > 4 else date(year - 1, 1, 31)
    with _patch_freshness(_all_sources(("mdic_comex", "monthly", year, stalled))):
        result = doctor._check_source_data_freshness(settings)
    assert "⚠" in result.detail
    assert "mdic_comex" in result.detail
    assert "months behind" in result.detail


def test_source_freshness_accepts_a_monthly_source_inside_its_publication_lag(
    settings: Settings,
) -> None:
    """MDIC publishes a month at ~D+30 and the ETag gate adds more: a two-month-old
    newest month is the HEALTHY steady state, not a stall."""
    settings.source_freshness_monthly_slack_months = 3
    today = datetime.now(UTC).date()
    recent = date(today.year, today.month, 1) - timedelta(days=45)
    with _patch_freshness(_all_sources(("mdic_comex", "monthly", recent.year, recent))):
        result = doctor._check_source_data_freshness(settings)
    assert "⚠" not in result.detail


def test_source_freshness_flags_a_monthly_source_with_no_period_end(settings: Settings) -> None:
    year = datetime.now(UTC).year
    with _patch_freshness(_all_sources(("mdic_comex", "monthly", year, None))):
        result = doctor._check_source_data_freshness(settings)
    assert "⚠" in result.detail and "no period_end" in result.detail


# ── a source that VANISHED is not a source that is current ───────────────────
def test_source_freshness_names_a_source_missing_from_the_view(settings: Settings) -> None:
    """The view ends each branch with `having count(*) > 0`, so an empty Gold emits NO
    row. Iterating what came back, the check answered "every source current" over the
    survivors — the same sentence the heartbeat check was already fixed not to say."""
    year = datetime.now(UTC).year
    with _patch_freshness(_freshness_rows(("mdic_comex", "monthly", year, date(year, 12, 31)))):
        result = doctor._check_source_data_freshness(settings)
    assert "⚠" in result.detail
    assert "MISSING from gold_source_metadata" in result.detail
    for vanished in ("ibge_pevs", "ibge_pam", "ibge_ppm", "un_comtrade"):
        assert vanished in result.detail
    assert "every expected source current" not in result.detail


def test_source_freshness_leads_with_the_absent_source_not_alphabetically(
    settings: Settings,
) -> None:
    """An absent acervo outranks a late one; it must not sort into the middle of the list."""
    year = datetime.now(UTC).year
    rows = _freshness_rows(
        ("mdic_comex", "monthly", year, date(year, 12, 31)),
        ("ibge_pevs", "annual", year),
        ("ibge_pam", "annual", year),
        ("un_comtrade", "annual", year - 9),  # late, and sorts after "MISSING" naturally
    )
    with _patch_freshness(rows):
        result = doctor._check_source_data_freshness(settings)
    assert result.detail.index("MISSING") < result.detail.index("un_comtrade")


def test_every_bigquery_read_in_doctor_is_capped() -> None:
    """No unbounded scan, statically. doctor is run ad hoc and repeatedly, and several
    of its checks read Gold end to end (the gold_source_metadata view recomputes every
    counter over the five fact tables). The gateway and the catalog resolver have passed
    `maximum_bytes_billed` all along; this module passed none. The cap does not shrink
    the scan — it makes an unbounded one impossible as the acervo grows."""
    tree = ast.parse(Path(doctor.__file__).read_text(encoding="utf-8"))
    uncapped = [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "query"
        and "job_config" not in {kw.arg for kw in node.keywords}
    ]
    assert uncapped == [], f"doctor.py has uncapped BigQuery reads at line(s) {uncapped}"


def test_doctor_does_not_promise_a_ten_second_run() -> None:
    """Three places ASSERTED "~10 seconds", one of them "even when something is broken".
    The broken case is 10–11 sequential probes at PROBE_TIMEOUT_S each — about 100s —
    which is the only case anyone times. Pinned on the assertive phrasings: the module
    docstring still QUOTES the old promise to explain why it is gone, and quoting a
    retracted claim is the opposite of making it."""
    from embrapa_dashboard import cli

    claims = ("reachability in ~10 seconds", "should finish in under ~15s", "ingest. ~10 seconds")
    source = Path(doctor.__file__).read_text(encoding="utf-8")
    for text in (source, cli.doctor_cmd.__doc__):
        for claim in claims:
            assert claim not in text, f"the retracted timing promise is back: {claim!r}"
    # …and the honest figure is stated where the promise used to be.
    assert "100s" in doctor.__doc__


def test_serving_targets_match_the_dbt_serving_models() -> None:
    """The deploy-readiness gate must cover every serving mart that exists.

    SOURCE_CHECKS and BRONZE_TARGETS are pinned to cli.INGESTS above; SERVING_TARGETS
    was the one registry with no parity guard, so an 8th mart would have been born
    outside the gate in silence. It happened to be correct — nothing was holding it so.
    """
    models = {
        p.stem for p in (Path(__file__).resolve().parents[1] / "dbt/models/serving").glob("*.sql")
    }
    registered = {
        table for dataset, table in doctor.SERVING_TARGETS if dataset == "bq_serving_dataset"
    }
    # dim_code_industrialization_scd2 is DELIBERATELY out: it is gated behind
    # `enable_curation`, so its absence in a standard build is expected, not an alarm.
    deliberately_out = {"dim_code_industrialization_scd2"}
    assert models - deliberately_out == registered, (
        "dbt/models/serving and doctor.SERVING_TARGETS drifted; symmetric diff: "
        f"{(models - deliberately_out) ^ registered}"
    )


def test_expected_metadata_sources_match_the_dbt_model() -> None:
    """Registry-drift guard: the declared set IS a contract with gold_source_metadata.sql.

    A sixth source added to the model without being listed here would never be reported
    as missing — the exact hole this constant closes, reopened one branch over.
    """
    sql = (
        Path(__file__).resolve().parents[1] / "dbt/models/gold/gold_source_metadata.sql"
    ).read_text(encoding="utf-8")
    # The model is a UNION ALL of one select per source, and each branch's FIRST string
    # literal is its source id — whether the branch names its columns (`'ibge_pevs' as
    # source`) or is positional (`'mdic_comex',`). Take that literal per branch rather
    # than pattern-matching a line shape, which also matched 'annual' / 'monthly'.
    branches = [b for b in re.split(r"^select\b", sql, flags=re.MULTILINE)[1:]]
    emitted = {m.group(1) for b in branches if (m := re.search(r"'([a-z0-9_]+)'", b))}
    assert emitted == set(doctor._EXPECTED_METADATA_SOURCES), (
        "gold_source_metadata.sql and doctor._EXPECTED_METADATA_SOURCES drifted; "
        f"symmetric diff: {emitted ^ set(doctor._EXPECTED_METADATA_SOURCES)}"
    )


def test_source_freshness_handles_an_empty_metadata_table(settings: Settings) -> None:
    with _patch_freshness([]):
        result = doctor._check_source_data_freshness(settings)
    assert result.ok is True
    assert "empty" in result.detail


def test_source_freshness_reports_a_query_failure(settings: Settings) -> None:
    client = MagicMock()
    client.query.side_effect = RuntimeError("permission denied on gold_source_metadata")
    with patch("embrapa_dashboard.doctor.bigquery.Client", return_value=client):
        result = doctor._check_source_data_freshness(settings)
    assert result.ok is False
    assert "permission denied" in result.detail


# ─── silvicultura probes ──────────────────────────────────────────────────────
def test_silvicultura_variable_codes_check_passes_on_the_configured_pair(
    settings: Settings,
) -> None:
    assert doctor._check_silvicultura_variable_codes(settings).ok is True


def test_silvicultura_variable_codes_check_fails_when_one_is_mistyped(
    settings: Settings,
) -> None:
    """The failure this exists for: a typo drops that variable from Silver and empties
    half a Gold column with NO downstream error."""
    settings.silvicultura_variable_value_code = "1443"  # transposed
    result = doctor._check_silvicultura_variable_codes(settings)
    assert result.ok is False
    assert "143" in result.detail and "tabela='291'" in result.detail


def test_silvicultura_variable_codes_check_reports_an_unexpected_error() -> None:
    """A probe must never raise INTO run_all — one broken check would take down the whole
    report, which is the opposite of what a health command is for."""

    class Broken:
        @property
        def silvicultura_variable_quantity_code(self) -> str:
            raise RuntimeError("boom")

    result = doctor._check_silvicultura_variable_codes(Broken())  # type: ignore[arg-type]
    assert result.ok is False
    assert "boom" in result.detail


def test_silvicultura_sidra_probe_reports_reachability(settings: Settings) -> None:
    with patch("embrapa_dashboard.doctor.requests.get") as get:
        get.return_value.raise_for_status.return_value = None
        ok = doctor._check_silvicultura(settings)
        get.side_effect = RuntimeError("timeout")
        bad = doctor._check_silvicultura(settings)
    assert ok.ok is True and "t291" in ok.detail
    assert bad.ok is False


class _GrupoRow:
    def __init__(self, codigo_produto: str, banco: str, agrupamento_id: str) -> None:
        self.codigo_produto = codigo_produto
        self.banco = banco
        self.agrupamento_id = agrupamento_id


class _NivelRow:
    def __init__(self, source: str, code: str, industrialization_level: str) -> None:
        self.source = source
        self.code = code
        self.industrialization_level = industrialization_level


def _curation_client(monkeypatch, grupos: list, niveis: list, registrados: set[str]) -> MagicMock:
    """Wire both log queries + the agrupamentos registry the integrity check reads."""
    client = MagicMock()
    client.query.return_value.result.side_effect = [grupos, niveis]
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)
    monkeypatch.setattr(
        "embrapa_dashboard.serving.agrupamentos._current_groups",
        lambda *a, **k: registrados,
    )
    monkeypatch.setattr(
        "embrapa_dashboard.serving.agrupamentos._group_log_ref", lambda cfg: "proj.ds.log"
    )
    return client


def test_curation_integrity_clean(monkeypatch, settings: Settings) -> None:
    """Every agrupamento registered and every level in scale → the clean state."""
    _curation_client(
        monkeypatch,
        grupos=[_GrupoRow("3405", "ibge_pevs", "madeira")],
        niveis=[_NivelRow("ibge_pevs", "3405", "commodity_pura")],
        registrados={"madeira"},
    )

    r = doctor._check_curation_referential_integrity(settings)

    assert r.ok is True and "every agrupamento_id registered" in r.detail


def test_curation_integrity_fails_on_unregistered_agrupamento(
    monkeypatch, settings: Settings
) -> None:
    """The 2026-08-29 defect: entries naming a group that was never created. The products
    vanish from every grouped view while the log stays self-consistent, so only a check
    that crosses the catalog WITH the registry can see it."""
    _curation_client(
        monkeypatch,
        grupos=[
            _GrupoRow("3405", "ibge_pevs", "madeira"),
            _GrupoRow("3406", "ibge_pevs", "lenha"),
        ],
        niveis=[],
        registrados={"madeira"},
    )

    r = doctor._check_curation_referential_integrity(settings)

    assert r.ok is False
    assert "1 catalog entr" in r.detail and "lenha" in r.detail
    assert "madeira" not in r.detail  # the registered one is not accused


def test_curation_integrity_fails_on_level_outside_scale(monkeypatch, settings: Settings) -> None:
    """The writer is open-vocabulary, so a typo'd level is stored and then matches no
    filter AND no 'sem classificação' — invisible either way."""
    _curation_client(
        monkeypatch,
        grupos=[],
        niveis=[
            _NivelRow("ibge_pevs", "3405", "commodity_pura"),
            _NivelRow("ibge_pevs", "3406", "commodity_purra"),
        ],
        registrados=set(),
    )

    r = doctor._check_curation_referential_integrity(settings)

    assert r.ok is False
    assert "1 classification" in r.detail and "commodity_purra" in r.detail


def test_curation_integrity_level_query_excludes_the_explicit_clear(
    monkeypatch, settings: Settings
) -> None:
    """An empty level is the un-classify CLEAR (latest-wins), not an invalid value. It is
    excluded in SQL, so assert on the emitted query — a fake client cannot filter."""
    client = _curation_client(monkeypatch, grupos=[], niveis=[], registrados=set())

    doctor._check_curation_referential_integrity(settings)

    nivel_sql = client.query.call_args_list[1].args[0]
    assert "industrialization_level != ''" in nivel_sql


def test_curation_integrity_error_degrades_to_skipped(monkeypatch, settings: Settings) -> None:
    """A cold install has no logs to read and must not report a red integrity check."""

    def _boom(s):
        raise NotFound("no dataset")

    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", _boom)

    r = doctor._check_curation_referential_integrity(settings)

    assert r.ok is True and "skipped" in r.detail


# ── curation backup coverage ──────────────────────────────────────────────────
def _backup_manifest(monkeypatch, settings: Settings, corpo: dict | None, *, runs=True):
    """One sealed run whose _SUCCESS body is `corpo`. `runs=False` = no snapshot at all."""
    from datetime import UTC, datetime

    marker = MagicMock()
    marker.exists.return_value = True
    marker.download_as_text.return_value = json.dumps(corpo or {})
    client = MagicMock()
    client.bucket.return_value.blob.return_value = marker
    monkeypatch.setattr(doctor, "get_credentials", lambda s: None)
    monkeypatch.setattr(doctor.storage, "Client", lambda **k: client)
    monkeypatch.setattr(
        doctor,
        "_list_backup_runs",
        lambda c, s: [(datetime(2026, 8, 29, tzinfo=UTC), "backups/run=X/")] if runs else [],
    )
    return client


def test_curation_backup_fails_when_the_snapshot_predates_coverage(monkeypatch, settings):
    """An ABSENT key means the snapshot was taken before curation was covered. It must not
    read as protected just because a Gold backup exists and is fresh — the authored
    catalog, classifications and editor allowlists would be sitting unprotected."""
    _backup_manifest(monkeypatch, settings, {"dataset": settings.bq_gold_dataset})

    r = doctor._check_curation_backup(settings)

    assert r.ok is False and "predates curation coverage" in r.detail


def test_curation_backup_accepts_a_covered_snapshot(monkeypatch, settings):
    _backup_manifest(
        monkeypatch,
        settings,
        {"dataset": settings.bq_gold_dataset, "curation_table_count": 12},
    )

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "12 curation table(s)" in r.detail


def test_curation_backup_distinguishes_zero_from_absent(monkeypatch, settings):
    """0 means 'covered, dataset empty' (a cold install) — a DIFFERENT state from 'not
    covered'. Conflating them is what would call an unprotected snapshot protected."""
    _backup_manifest(
        monkeypatch, settings, {"dataset": settings.bq_gold_dataset, "curation_table_count": 0}
    )

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "0 curation table(s)" in r.detail


def test_curation_backup_skips_when_no_snapshot_exists(monkeypatch, settings):
    """A project that never ran a backup is not a curation-coverage failure."""
    _backup_manifest(monkeypatch, settings, None, runs=False)

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "no snapshot yet" in r.detail


def _backup_runs_seq(monkeypatch, settings: Settings, marcadores: list[tuple[bool, dict | None]]):
    """N runs, newest first, each described by (has _SUCCESS marker, manifest body)."""
    blobs = []
    for existe, corpo in marcadores:
        m = MagicMock()
        m.exists.return_value = existe
        m.download_as_text.return_value = json.dumps(corpo or {})
        blobs.append(m)
    client = MagicMock()
    client.bucket.return_value.blob.side_effect = blobs
    monkeypatch.setattr(doctor, "get_credentials", lambda s: None)
    monkeypatch.setattr(doctor.storage, "Client", lambda **k: client)
    monkeypatch.setattr(
        doctor,
        "_list_backup_runs",
        lambda c, s: [
            (datetime(2026, 8, 29, 12 - i, tzinfo=UTC), f"backups/run={i}/")
            for i in range(len(marcadores))
        ],
    )


def test_curation_backup_skips_an_unsealed_run_and_reads_the_next(monkeypatch, settings):
    """A crashed half-backup carries no _SUCCESS marker. It must not answer for coverage —
    the same rule the freshness check already applies."""
    _backup_runs_seq(
        monkeypatch,
        settings,
        [(False, None), (True, {"dataset": settings.bq_gold_dataset, "curation_table_count": 7})],
    )

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "7 curation table(s)" in r.detail


def test_curation_backup_skips_a_snapshot_of_another_dataset(monkeypatch, settings):
    """dev (dbt_dev_gold) and prod (gold) hold identically-named tables, so a dev-pointed
    snapshot must not vouch for prod coverage."""
    _backup_runs_seq(
        monkeypatch,
        settings,
        [
            (True, {"dataset": "dbt_dev_gold", "curation_table_count": 12}),
            (True, {"dataset": settings.bq_gold_dataset, "curation_table_count": 3}),
        ],
    )

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "3 curation table(s)" in r.detail


def test_curation_backup_reports_when_no_run_is_sealed(monkeypatch, settings):
    _backup_runs_seq(monkeypatch, settings, [(False, None), (False, None)])

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "no sealed snapshot" in r.detail


def test_curation_backup_degrades_to_skipped_on_any_fault(monkeypatch, settings):
    """No perms / no bucket must not paint the check red — it has no data to judge."""

    def _boom(s):
        raise google.auth.exceptions.DefaultCredentialsError("sem credencial")

    monkeypatch.setattr(doctor, "get_credentials", _boom)

    r = doctor._check_curation_backup(settings)

    assert r.ok is True and "skipped" in r.detail


# ── código compartilhado entre as tabelas de um banco multi-tabela ────────────
class _Cod:
    def __init__(self, product_code: str, n: int = 2) -> None:
        self.product_code = product_code
        self.n = n


def test_shared_code_clean_when_no_banco_shares_a_code(monkeypatch, settings: Settings) -> None:
    """PEVS e PPM unem duas tabelas SIDRA cada; hoje os códigos são disjuntos."""
    client = MagicMock()
    client.query.return_value.result.return_value = []
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_shared_code_across_tables(settings)

    assert r.ok is True and "nenhum código compartilhado" in r.detail
    assert client.query.call_count == len(doctor._BANCOS_MULTI_TABELA), "faltou consultar um banco"


def test_shared_code_fails_and_names_the_banco(monkeypatch, settings: Settings) -> None:
    """A condição nunca é benigna: o teste de unicidade do Gold vai quebrar o build, e a
    curadoria — que identifica um produto por (banco, código) — não consegue representá-la."""
    client = MagicMock()
    client.query.return_value.result.side_effect = [[_Cod("3405")], []]
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_shared_code_across_tables(settings)

    assert r.ok is False
    assert "ibge_pevs: 3405" in r.detail
    assert "esconderia as duas" in r.detail


_RAIZ = Path(__file__).resolve().parents[1]


def test_the_discriminator_column_is_one_the_gold_models_actually_produce() -> None:
    """A coluna que o doctor consulta tem de ser uma coluna que o dbt ENTREGA.

    A versão anterior deste teste percorria `_BANCOS_MULTI_TABELA` e afirmava que o SQL
    continha o discriminador tirado *dessa mesma constante* — uma tautologia: qualquer nome
    que a constante trouxesse apareceria no SQL, inclusive `origem` depois de a v1.46.1
    removê-la do Gold. Ele ficou verde enquanto o check estava morto em produção.

    A âncora agora é externa ao doctor: o próprio modelo Gold, mantido pelo pipeline e não
    por este teste. Renomear a coluna lá sem atualizar o doctor quebra AQUI, que é onde
    precisava ter quebrado."""
    comentario_de_linha = re.compile(r"--.*")
    for _banco, tabela in doctor._BANCOS_MULTI_TABELA:
        modelo = _RAIZ / "dbt" / "models" / "gold" / f"{tabela}.sql"
        fonte = modelo.read_text(encoding="utf-8")
        # comentários fora: a coluna `origem` sobrevive na PROSA de vários modelos, contando
        # o que mudou, e um grep cru passaria verde por causa dela.
        codigo = comentario_de_linha.sub("", fonte)
        assert doctor._COLUNA_DISCRIMINADORA in codigo, (
            f"{tabela}.sql não produz a coluna {doctor._COLUNA_DISCRIMINADORA!r} que o "
            f"doctor consulta — o check viraria um 400 silencioso"
        )


def test_shared_code_query_groups_by_the_discriminator(monkeypatch, settings: Settings) -> None:
    """Agrupar pela coluna errada devolveria zero para sempre — o silêncio que este check
    existe para evitar. (Que a coluna EXISTE no Gold é o teste acima; este só garante que
    ela é de fato usada no group-by de cada banco.)"""
    client = MagicMock()
    client.query.return_value.result.return_value = []
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    doctor._check_shared_code_across_tables(settings)

    sqls = [c.args[0] for c in client.query.call_args_list]
    for _banco, tabela in doctor._BANCOS_MULTI_TABELA:
        assert any(
            f"count(distinct {doctor._COLUNA_DISCRIMINADORA})" in q and tabela in q for q in sqls
        ), f"{tabela} não foi consultada pelo discriminador"


def test_shared_code_degrades_to_skipped(monkeypatch, settings: Settings) -> None:
    """Sem permissão de leitura não há o que julgar — verde."""

    def _boom(s):
        raise Forbidden("sem permissão")

    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", _boom)

    r = doctor._check_shared_code_across_tables(settings)

    assert r.ok is True and "skipped" in r.detail


def test_shared_code_query_that_does_not_compile_is_red_not_skipped(
    monkeypatch, settings: Settings
) -> None:
    """A regressão real da v1.46.1→v1.46.3, como teste.

    O check consultava a coluna `origem`, que o Gold tinha deixado de ter. O BigQuery
    devolvia `400 Unrecognized name`, o `except Exception` engolia e o doctor imprimia um
    ✓ verde com um `skipped:` ao lado — em três versões ninguém leu. Uma consulta que não
    compila é o CHECK quebrado, nunca falta de dado: tem de ser vermelha e dizer isso."""
    client = MagicMock()
    client.query.side_effect = BadRequest("400 Unrecognized name: origem")
    monkeypatch.setattr("embrapa_dashboard.gcp.clients.resolve_bq_client", lambda s: client)

    r = doctor._check_shared_code_across_tables(settings)

    assert r.ok is False, "consulta quebrada não pode passar por 'sem dado para julgar'"
    assert "CHECK QUEBRADO" in r.detail


def test_the_multi_table_registry_matches_the_curation_validator() -> None:
    """Âncora INDEPENDENTE para `_BANCOS_MULTI_TABELA`.

    Os testes acima derivam do próprio registro (contam `len(...)`, iteram sobre ele), então
    remover um banco dali muda os dois lados da asserção e passa verde — uma injeção provou
    isso. `curation._validate_tabela` mantém a MESMA lista por outro motivo (só um
    banco multi-tabela pode carregar `tabela`), e as duas divergirem é sempre defeito:
    ou o doctor deixou de vigiar um banco, ou a validação passou a aceitar tag onde não
    deve.
    """
    from embrapa_dashboard.serving import curation

    # A âncora é `_tabelas_validas_por_banco` — o vocabulário de tabelas por banco, mantido
    # por outro motivo (validar a tag). Ela saiu de dentro de `_validate_tabela` em
    # v1.40.1 e este teste acusou a mudança, que é o que se espera dele.
    fonte = inspect.getsource(curation._tabelas_validas_por_banco)
    do_validador = {b for b in ("ppm", "pevs", "pam", "comex", "comtrade") if f'"{b}":' in fonte}
    do_doctor = {b.removeprefix("ibge_") for b, _t in doctor._BANCOS_MULTI_TABELA}

    assert do_doctor == do_validador, (
        f"doctor vigia {sorted(do_doctor)} e a validação conhece {sorted(do_validador)}"
    )


# ── a política de degradação, depois da v1.46.4 ───────────────────────────────
@pytest.mark.parametrize(
    "exc",
    [
        NotFound("dataset ausente"),
        Forbidden("sem permissão"),
        google.auth.exceptions.DefaultCredentialsError("sem ADC"),
        google.auth.exceptions.RefreshError("credencial expirada"),
    ],
    ids=["not_found", "forbidden", "sem_adc", "credencial_expirada"],
)
def test_skip_ou_quebra_trata_ausencia_de_dado_como_verde(exc: BaseException) -> None:
    """Instalação fria, máquina de dev sem acesso ao prod, credencial vencida: o check não
    tem o que julgar. Verde com `skipped:` — e nunca vermelho, que assustaria o operador
    por uma condição que não é defeito do projeto.

    A âncora é externa: as classes vêm de `google.api_core` / `google.auth`, mantidas fora
    deste repositório e por outro motivo. Um teste que inventasse a própria hierarquia de
    exceções estaria medindo a si mesmo."""
    r = doctor._skip_ou_quebra("X", exc)

    assert r.ok is True
    assert r.detail.startswith("skipped:")


@pytest.mark.parametrize(
    "exc",
    [
        BadRequest("400 Unrecognized name: origem"),
        RuntimeError("o que quer que seja"),
        TypeError("assinatura mudou"),
        KeyError("coluna"),
        AttributeError("atributo removido"),
    ],
    ids=["sql_nao_compila", "runtime", "tipo", "chave", "atributo"],
)
def test_skip_ou_quebra_trata_check_quebrado_como_vermelho(exc: BaseException) -> None:
    """O caso que custou três versões: `origem` saiu do Gold, a consulta virou um 400, e o
    check devolvia verde. Um guarda que não consegue rodar não está dizendo 'tudo bem' —
    está dizendo 'não sei', e num relatório 27/27 essas duas coisas não podem ter a mesma
    cor."""
    r = doctor._skip_ou_quebra("X", exc)

    assert r.ok is False
    assert "CHECK QUEBRADO" in r.detail
    assert type(exc).__name__ in r.detail, "o operador precisa saber O QUE quebrou"


def test_no_check_returns_a_literal_green_from_a_broad_except() -> None:
    """Varredura do domínio, não da função que eu consertei.

    O defeito da v1.46.1 não foi um `except` distraído: foram SEIS, todos devolvendo
    `CheckResult(..., True, f"skipped: {exc}")` de dentro de um `except Exception`. Bastava
    um deles quebrar para o doctor mentir. Este teste percorre a AST do módulo inteiro, de
    modo que um check NOVO com o mesmo atalho falhe aqui em vez de morrer em silêncio anos
    depois.

    Verde saindo de um `except` ESTREITO continua permitido: `GCS bucket` responde
    `except NotFound` com um veredito real ('será criado na primeira ingestão'), o que é
    julgar, não engolir. O que a regra proíbe é o verde que vem de um `except Exception`,
    onde o autor não sabe — e não pode saber — o que está sendo suprimido."""
    fonte = Path(inspect.getfile(doctor)).read_text(encoding="utf-8")
    arvore = ast.parse(fonte)

    def _e_amplo(h: ast.ExceptHandler) -> bool:
        # `except:` nu ou `except Exception`/`BaseException` — largo demais para julgar.
        if h.type is None:
            return True
        nomes = (
            [h.type] if not isinstance(h.type, ast.Tuple) else list(h.type.elts)  # type: ignore[list-item]
        )
        return any(getattr(n, "id", None) in {"Exception", "BaseException"} for n in nomes)

    infratores: list[str] = []
    for no in ast.walk(arvore):
        if not (isinstance(no, ast.ExceptHandler) and _e_amplo(no)):
            continue
        for sub in ast.walk(no):
            if not (isinstance(sub, ast.Return) and isinstance(sub.value, ast.Call)):
                continue
            chamada = sub.value
            alvo = getattr(chamada.func, "id", getattr(chamada.func, "attr", ""))
            if alvo != "CheckResult" or len(chamada.args) < 2:
                continue
            ok = chamada.args[1]
            if isinstance(ok, ast.Constant) and ok.value is True:
                infratores.append(f"linha {sub.lineno}: {ast.unparse(chamada)[:70]}")

    assert not infratores, (
        "check(es) devolvendo verde literal de dentro de um `except Exception` — use "
        "`_skip_ou_quebra`, que separa falta de dado (verde) de check quebrado "
        "(vermelho):\n  " + "\n  ".join(infratores)
    )


# ── Quality-tag drift ────────────────────────────────────────────────────────
# The fixtures are the three moves the audit of 2026-09-24 measured, so each threshold is
# tested against the case that justified it rather than against a made-up number.


def test_quality_drift_ignores_an_identical_build() -> None:
    build = {("ibge_pam", "OK"): (843_735, 0.335, 0.916)}
    assert doctor._quality_drifts(build, dict(build)) == []


def test_quality_drift_catches_a_rare_tag_collapsing_by_count() -> None:
    """The 1985 currency fix: PAM PROBLEMÁTICO 223 → 4. Its share moved 0,02 p.p. — no
    share threshold would ever see it — so the count test is the one that must."""
    before = {("ibge_pam", "PROBLEMATIC_VALUE"): (223, 223 / 1_124_058, 0.0005)}
    after = {("ibge_pam", "PROBLEMATIC_VALUE"): (4, 4 / 1_124_058, 0.00005)}
    (line,) = doctor._quality_drifts(before, after)
    assert "ibge_pam PROBLEMATIC_VALUE" in line and "223 → 4" in line


def test_quality_drift_does_not_cry_over_a_handful_of_rows() -> None:
    """v1.90.0 moved PAM PROBLEMÁTICO 4 → 6: ×1,5 over two rows is noise, not a signal."""
    before = {("ibge_pam", "PROBLEMATIC_VALUE"): (4, 4e-6, 0.00005)}
    after = {("ibge_pam", "PROBLEMATIC_VALUE"): (6, 6e-6, 0.00006)}
    assert doctor._quality_drifts(before, after) == []
    # And ×3 with fewer than QUALITY_DRIFT_MIN_ROWS rows of difference stays quiet too.
    assert (
        doctor._quality_drifts(
            {("x", "PROBLEMATIC_VALUE"): (2, 1e-6, None)},
            {("x", "PROBLEMATIC_VALUE"): (9, 4e-6, None)},
        )
        == []
    )


def test_quality_drift_catches_a_common_tag_moving_by_share() -> None:
    """v1.90.0: PAM OK 843.735 → 1.029.948 rows, only ×1,2, but 33,5% → 40,9% of the banco."""
    before = {("ibge_pam", "OK"): (843_735, 0.335, 0.916)}
    after = {("ibge_pam", "OK"): (1_029_948, 0.409, 0.930)}
    (line,) = doctor._quality_drifts(before, after)
    assert "rows 843,735 → 1,029,948 (33.5% → 40.9%)" in line


def test_quality_drift_catches_a_move_in_value_alone() -> None:
    """v1.89.0 changed no tag, only the value weight: PAM UNSCORED 0,10% → 8,98% of the money."""
    before = {("ibge_pam", "UNSCORED"): (1_668_065, 0.6628, 0.00101)}
    after = {("ibge_pam", "UNSCORED"): (1_668_065, 0.6628, 0.08975)}
    (line,) = doctor._quality_drifts(before, after)
    assert "value 0.1% → 9.0%" in line and "rows" not in line


def test_quality_drift_reports_a_tag_appearing_and_vanishing() -> None:
    """v1.90.0 in COMTRADE: MISSING_WEIGHT appeared (79.536) and MISSING_QUANTITY vanished."""
    before = {("un_comtrade", "MISSING_QUANTITY"): (25_638, 0.0125, 0.0089)}
    after = {("un_comtrade", "MISSING_WEIGHT"): (79_536, 0.0387, 0.0383)}
    lines = doctor._quality_drifts(before, after)
    assert any("MISSING_WEIGHT appeared (79,536 rows" in line for line in lines)
    assert any("MISSING_QUANTITY vanished (was 25,638 rows" in line for line in lines)
    # A tag born with a couple of rows is not news.
    assert doctor._quality_drifts({}, {("ibge_pam", "PROBLEMATIC_VALUE"): (2, 1e-6, None)}) == []


def test_quality_drift_does_not_read_an_absent_value_share_as_zero() -> None:
    """value_share is NULL for a banco with no money; that is no base for a shift."""
    before = {("ibge_ppm", "UNSCORED"): (100, 0.5, None)}
    after = {("ibge_ppm", "UNSCORED"): (100, 0.5, 0.40)}
    assert doctor._quality_drifts(before, after) == []


def _history(*builds):
    """Rows of serving_quality_history: each build is (built_at, {(source, tag): stats})."""
    rows = []
    for i, (built_at, flags) in enumerate(builds):
        for (source, tag), (n, share, value_share) in flags.items():
            rows.append(
                SimpleNamespace(
                    invocation_id=f"inv-{i}",
                    built_at=built_at,
                    source=source,
                    data_quality_flag=tag,
                    n_rows=n,
                    share=share,
                    value_share=value_share,
                )
            )
    return rows


def _patch_history(rows):
    client = MagicMock()
    client.query.return_value.result.return_value = rows
    return patch("embrapa_dashboard.doctor.bigquery.Client", return_value=client)


def test_quality_drift_check_needs_two_builds(settings: Settings) -> None:
    now = datetime.now(UTC)
    with _patch_history(_history((now, {("ibge_pam", "OK"): (10, 1.0, 1.0)}))):
        result = doctor._check_quality_drift(settings)
    assert result.ok is True and "nothing to compare yet" in result.detail


def test_quality_drift_check_warns_with_the_build_that_moved(settings: Settings) -> None:
    now = datetime.now(UTC)
    rows = _history(
        (now - timedelta(days=3), {("ibge_pam", "PROBLEMATIC_VALUE"): (223, 0.0002, 0.0005)}),
        (now - timedelta(days=1), {("ibge_pam", "PROBLEMATIC_VALUE"): (4, 0.000004, 0.00005)}),
    )
    with _patch_history(rows):
        result = doctor._check_quality_drift(settings)
    assert result.ok is True  # a warning: the move can be the point of a release
    assert result.detail.startswith("⚠")
    assert f"{now - timedelta(days=1):%Y-%m-%d}" in result.detail and "223 → 4" in result.detail


def test_quality_drift_keeps_reporting_after_a_quiet_build(settings: Settings) -> None:
    """The reason for the window: doctor runs ad hoc. A move two builds ago must still be
    visible after a later build changed nothing."""
    now = datetime.now(UTC)
    before = {("ibge_pam", "OK"): (843_735, 0.335, 0.916)}
    after = {("ibge_pam", "OK"): (1_029_948, 0.409, 0.930)}
    rows = _history(
        (now - timedelta(days=5), before),
        (now - timedelta(days=4), after),
        (now - timedelta(days=1), after),
    )
    with _patch_history(rows):
        result = doctor._check_quality_drift(settings)
    assert "⚠" in result.detail and "ibge_pam OK" in result.detail


def test_quality_drift_lets_an_old_move_age_out(settings: Settings) -> None:
    now = datetime.now(UTC)
    old = now - timedelta(days=doctor.QUALITY_DRIFT_LOOKBACK_DAYS + 5)
    rows = _history(
        (old - timedelta(days=1), {("ibge_pam", "OK"): (843_735, 0.335, 0.916)}),
        (old, {("ibge_pam", "OK"): (1_029_948, 0.409, 0.930)}),
        (now - timedelta(days=1), {("ibge_pam", "OK"): (1_029_948, 0.409, 0.930)}),
    )
    with _patch_history(rows):
        result = doctor._check_quality_drift(settings)
    assert "⚠" not in result.detail and "no tag moved across 1 build pair" in result.detail


def test_quality_drift_says_so_when_no_build_is_recent(settings: Settings) -> None:
    old = datetime.now(UTC) - timedelta(days=doctor.QUALITY_DRIFT_LOOKBACK_DAYS + 10)
    rows = _history(
        (old - timedelta(days=1), {("ibge_pam", "OK"): (10, 1.0, 1.0)}),
        (old, {("ibge_pam", "OK"): (10, 1.0, 1.0)}),
    )
    with _patch_history(rows):
        result = doctor._check_quality_drift(settings)
    assert result.ok is True and "no build in the last" in result.detail


def test_quality_drift_skips_before_the_history_table_exists(settings: Settings) -> None:
    client = MagicMock()
    client.query.side_effect = NotFound("serving_quality_history")
    with patch("embrapa_dashboard.doctor.bigquery.Client", return_value=client):
        result = doctor._check_quality_drift(settings)
    assert result.ok is True and result.detail.startswith("skipped:")


def test_quality_drift_is_registered() -> None:
    assert ("quality-drift", doctor._check_quality_drift) in doctor.CHECKS
