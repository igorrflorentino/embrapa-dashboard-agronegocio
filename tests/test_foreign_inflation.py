"""Tests for the foreign price-index source (BLS CPI-U · ECB HICP), HTTP fully mocked.

What these pin is not "the parser works" but the two properties the deflation depends
on, because both were the shape of a real defect elsewhere in this pipeline:

1. **What is dropped is dropped deliberately.** BLS ships the ANNUAL AVERAGE in the same
   list as the months (period ``M13``), and the ECB will serve an annual or quarterly row
   for a differently-keyed series. Either one, kept, gives a year a second candidate
   "last month" — and the Gold year-end index is exactly ``the last month of the year``.
2. **A deflator that never arrives fails LOUDLY.** A typo'd series id answers empty, and
   an empty cold series that is merely skipped leaves ``val_real_cpi_usd`` NULL forever
   with every layer reporting success — the failure mode this whole feature exists to
   remove, reproduced one level down.
"""

from __future__ import annotations

import re
from datetime import date
from unittest.mock import MagicMock

import pandas as pd
import pytest
import responses

from embrapa_dashboard.config import Settings
from embrapa_dashboard.foreign_inflation import client, pipeline

_BLS_URL = re.compile(r"https://api\.bls\.gov/publicAPI/v\d/timeseries/data/.*")
_ECB_URL = re.compile(r"https://data-api\.ecb\.europa\.eu/service/data/ICP/.*")


def _bls_payload(rows: list[dict]) -> dict:
    return {
        "status": "REQUEST_SUCCEEDED",
        "message": [],
        "Results": {"series": [{"seriesID": "CUUR0000SA0", "data": rows}]},
    }


def _settings(**over: object) -> Settings:
    base = dict(
        gcp_project_id="p",
        gcs_bucket="b",
        foreign_inflation_start_year=2020,
        bcb_end_year=2021,
    )
    base.update(over)
    return Settings(**base)  # type: ignore[arg-type]


# ── BLS ───────────────────────────────────────────────────────────────────────


@responses.activate
def test_bls_maps_monthly_periods_to_the_shared_date_shape() -> None:
    responses.add(
        responses.GET,
        _BLS_URL,
        json=_bls_payload(
            [
                {"year": "2021", "period": "M02", "value": "263.014"},
                {"year": "2021", "period": "M01", "value": "261.582"},
            ]
        ),
        status=200,
    )
    df = client.fetch_bls_series(
        "CUUR0000SA0", 2021, 2021, base_url="https://api.bls.gov/publicAPI"
    )
    assert list(df.columns) == ["data", "valor"]
    # dd/mm/yyyy — the same natural key every other inflation series lands under.
    assert set(df["data"]) == {"01/01/2021", "01/02/2021"}


@responses.activate
def test_bls_drops_the_annual_average_row() -> None:
    """M13 is the year's average, not a 13th month. Kept, it would compete with
    December for the year-end index the Gold deflation reads."""
    responses.add(
        responses.GET,
        _BLS_URL,
        json=_bls_payload(
            [
                {"year": "2021", "period": "M13", "value": "270.970"},
                {"year": "2021", "period": "M12", "value": "278.802"},
            ]
        ),
        status=200,
    )
    df = client.fetch_bls_series(
        "CUUR0000SA0", 2021, 2021, base_url="https://api.bls.gov/publicAPI"
    )
    assert list(df["data"]) == ["01/12/2021"]


@responses.activate
def test_bls_window_before_the_series_exists_is_empty_not_an_error() -> None:
    responses.add(responses.GET, _BLS_URL, json=_bls_payload([]), status=200)
    df = client.fetch_bls_series(
        "CUUR0000SA0", 1900, 1900, base_url="https://api.bls.gov/publicAPI"
    )
    assert df.empty
    assert list(df.columns) == ["data", "valor"]


@responses.activate
def test_bls_quota_refusal_is_transient_despite_http_200() -> None:
    """BLS answers a daily-quota refusal with HTTP 200 and a status string, so the
    status-code check alone would take it for data."""
    responses.add(
        responses.GET,
        _BLS_URL,
        json={
            "status": "REQUEST_NOT_PROCESSED",
            "message": ["Daily threshold for Series exceeded."],
            "Results": {},
        },
        status=200,
    )
    with pytest.raises(client.ForeignInflationTransientError):
        client.fetch_bls_series("CUUR0000SA0", 2021, 2021, base_url="https://api.bls.gov/publicAPI")


@responses.activate
def test_bls_unknown_series_is_a_permanent_error() -> None:
    responses.add(
        responses.GET,
        _BLS_URL,
        json={
            "status": "REQUEST_NOT_PROCESSED",
            "message": ["Series does not exist for Series NOPE"],
            "Results": {},
        },
        status=200,
    )
    with pytest.raises(client.ForeignInflationRequestError) as exc:
        client.fetch_bls_series("NOPE", 2021, 2021, base_url="https://api.bls.gov/publicAPI")
    assert not isinstance(exc.value, client.ForeignInflationTransientError)


@responses.activate
def test_bls_chunks_the_window_to_the_keyless_ten_year_cap() -> None:
    responses.add(responses.GET, _BLS_URL, json=_bls_payload([]), status=200)
    client.fetch_bls_series("CUUR0000SA0", 1974, 2003, base_url="https://api.bls.gov/publicAPI")
    windows = [
        (
            int(re.search(r"startyear=(\d+)", c.request.url).group(1)),
            int(re.search(r"endyear=(\d+)", c.request.url).group(1)),
        )
        for c in responses.calls
    ]
    assert windows == [(1974, 1983), (1984, 1993), (1994, 2003)]


@responses.activate
def test_bls_key_upgrades_to_v2_and_a_wider_window() -> None:
    responses.add(responses.GET, _BLS_URL, json=_bls_payload([]), status=200)
    client.fetch_bls_series(
        "CUUR0000SA0", 1990, 2009, base_url="https://api.bls.gov/publicAPI", api_key="k"
    )
    assert len(responses.calls) == 1
    assert "/v2/" in responses.calls[0].request.url


# ── ECB ───────────────────────────────────────────────────────────────────────

_ECB_CSV = (
    "KEY,FREQ,TIME_PERIOD,OBS_VALUE\n"
    "ICP.M.U2.N.000000.4.INX,M,2021-01,105.5\n"
    "ICP.M.U2.N.000000.4.INX,M,2021-02,106.4\n"
)


@responses.activate
def test_ecb_parses_the_csv_into_the_shared_date_shape() -> None:
    responses.add(responses.GET, _ECB_URL, body=_ECB_CSV, status=200)
    df = client.fetch_ecb_series(
        "ICP.M.U2.N.000000.4.INX",
        2021,
        2021,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert list(df["data"]) == ["01/01/2021", "01/02/2021"]
    assert list(df["valor"]) == ["105.5", "106.4"]


@responses.activate
def test_ecb_splits_the_series_key_at_the_dataflow() -> None:
    responses.add(responses.GET, _ECB_URL, body=_ECB_CSV, status=200)
    client.fetch_ecb_series(
        "ICP.M.U2.N.000000.4.INX",
        2021,
        2021,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert "/data/ICP/M.U2.N.000000.4.INX?" in responses.calls[0].request.url


@responses.activate
def test_ecb_keeps_only_monthly_observations() -> None:
    """A non-monthly row would give a year two candidate 'last periods'."""
    responses.add(
        responses.GET,
        _ECB_URL,
        body=(
            "KEY,FREQ,TIME_PERIOD,OBS_VALUE\nx,A,2021,104.0\nx,Q,2021-Q1,104.9\nx,M,2021-03,107.0\n"
        ),
        status=200,
    )
    df = client.fetch_ecb_series(
        "ICP.M.U2.N.000000.4.INX",
        2021,
        2021,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert list(df["data"]) == ["01/03/2021"]


@responses.activate
def test_ecb_404_is_no_data_not_a_failure() -> None:
    """HICP does not exist before 1996; the early backfill windows must stay silent."""
    responses.add(responses.GET, _ECB_URL, body="", status=404)
    df = client.fetch_ecb_series(
        "ICP.M.U2.N.000000.4.INX",
        1974,
        1980,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert df.empty


def test_ecb_key_without_a_dataflow_prefix_is_refused_before_any_request() -> None:
    with pytest.raises(client.ForeignInflationRequestError, match="dataflow"):
        client.fetch_ecb_series(
            "M-U2-N", 2021, 2021, base_url="https://data-api.ecb.europa.eu/service/data"
        )


# ── pipeline ──────────────────────────────────────────────────────────────────


def _stub_fetch(monkeypatch: pytest.MonkeyPatch, by_label: dict[str, pd.DataFrame]) -> None:
    monkeypatch.setattr(pipeline, "_fetch", lambda spec, settings, start, end: by_label[spec.label])


def _frame(*dates: str) -> pd.DataFrame:
    return pd.DataFrame({"data": list(dates), "valor": ["1"] * len(dates)})


def test_extract_stamps_the_publisher_and_the_economy(monkeypatch: pytest.MonkeyPatch) -> None:
    """Silver must never have to infer the provider from the series id."""
    _stub_fetch(monkeypatch, {"CPI": _frame("01/01/2021"), "HICP": _frame("01/01/2021")})
    settings = _settings()
    bq = MagicMock()
    bq.query.side_effect = AssertionError("full mode must not look up the last load")

    df = pipeline.extract(settings, bq, "p.d.t", full=True)

    assert set(df.columns) == {
        "series_code",
        "series_name",
        "provider",
        "economy",
        "reference_date_str",
        "value_str",
    }
    by_label = dict(zip(df["series_name"], df["provider"], strict=False))
    assert by_label == {"CPI": "bls", "HICP": "ecb"}
    assert set(df["economy"]) == {"US", "EA"}


def test_extract_fails_loudly_when_a_cold_series_comes_back_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo'd id would otherwise report success and leave the deflator NULL forever."""
    _stub_fetch(monkeypatch, {"CPI": _frame("01/01/2021"), "HICP": pd.DataFrame()})
    with pytest.raises(RuntimeError, match="HICP"):
        pipeline.extract(_settings(), MagicMock(), "p.d.t", full=True)


def test_extract_treats_an_empty_warm_series_as_nothing_new(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_fetch(monkeypatch, {"CPI": pd.DataFrame(), "HICP": pd.DataFrame()})
    monkeypatch.setattr(pipeline, "latest_reference_date", lambda *a, **k: date(2026, 8, 1))
    assert pipeline.extract(_settings(), MagicMock(), "p.d.t", full=False).empty


def test_delta_rewinds_a_whole_year(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[int] = []

    def fake_fetch(spec, settings, start, end):  # type: ignore[no-untyped-def]
        seen.append(start)
        return _frame("01/01/2026")

    monkeypatch.setattr(pipeline, "_fetch", fake_fetch)
    monkeypatch.setattr(pipeline, "latest_reference_date", lambda *a, **k: date(2026, 8, 1))
    pipeline.extract(_settings(bcb_end_year=2026), MagicMock(), "p.d.t", full=False)
    assert seen == [2025, 2025]


def test_an_empty_series_id_is_a_configuration_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """dbt would pivot on '' and NULL the column in silence."""
    settings = _settings(foreign_inflation_cpi_code="")
    with pytest.raises(RuntimeError, match="FOREIGN_INFLATION_CPI_CODE"):
        pipeline.extract(settings, MagicMock(), "p.d.t", full=True)


def test_every_declared_index_names_the_currency_it_deflates() -> None:
    """The pairing index↔currency is the fact the whole feature turns on: an index may
    only ever correct the money of the economy it measures."""
    assert {s.label: s.currency for s in pipeline.FOREIGN_INDICES} == {
        "CPI": "USD",
        "HICP": "EUR",
    }
    assert {s.label: s.economy for s in pipeline.FOREIGN_INDICES} == {"CPI": "US", "HICP": "EA"}
