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
from contextlib import contextmanager
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest
import responses

from embrapa_dashboard.config import Settings
from embrapa_dashboard.foreign_inflation import client, pipeline

_BLS_URL = re.compile(r"https://api\.bls\.gov/publicAPI/v\d/timeseries/data/.*")
_ECB_URL = re.compile(r"https://data-api\.ecb\.europa\.eu/service/data/HICP/.*")


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


def _latest_three_years() -> list[dict]:
    """What the keyless v1 GET answers WHATEVER startyear/endyear say (measured
    2026-09-23: a 1990-1995 request returned 2024-2026)."""
    return [
        {"year": str(y), "period": f"M{m:02d}", "value": f"{300 + y - 2024 + m / 100:.3f}"}
        for y in (2024, 2025, 2026)
        for m in range(1, 13)
    ]


@responses.activate
def test_bls_window_answered_entirely_outside_itself_is_refused() -> None:
    """The 2026-09-14 backfill, reproduced. Every 10-year window came back holding the
    same 2024-2026 block, each was stored as if it were its own span, and the run reported
    success with 3 years of a 53-year series. A window whose answer has NONE of its own
    years is not a sparse window — it is an ignored request, and saying so beats storing
    it. Permanent, not transient: retrying the same keyless call gets the same answer."""
    responses.add(responses.GET, _BLS_URL, json=_bls_payload(_latest_three_years()), status=200)
    with pytest.raises(client.ForeignInflationRequestError, match="ignored") as exc:
        client.fetch_bls_series("CUUR0000SA0", 1990, 1995, base_url="https://api.bls.gov/publicAPI")
    assert not isinstance(exc.value, client.ForeignInflationTransientError)
    # The remedy travels with the refusal: the operator reads WHAT to set, not just "failed".
    assert "BLS_KEY_SECRET" in str(exc.value)


@responses.activate
def test_keyless_backfill_fails_instead_of_truncating() -> None:
    """End to end over the chunker: a keyless 1974-2026 backfill must not come back with
    2024-2026 six times over. It stops at the first window, naming why."""
    responses.add(responses.GET, _BLS_URL, json=_bls_payload(_latest_three_years()), status=200)
    with pytest.raises(client.ForeignInflationRequestError, match="1974-1983"):
        client.fetch_bls_series("CUUR0000SA0", 1974, 2026, base_url="https://api.bls.gov/publicAPI")
    assert len(responses.calls) == 1


@responses.activate
def test_bls_neighbours_outside_a_recent_window_are_dropped_not_stored() -> None:
    """A delta window overlaps the latest three years, so keyless v1 answers it with its
    own years plus a neighbour. That is still a usable answer — the delta works without a
    key — but the neighbour is not this window's to store: kept, the raw archive would
    claim a span it was never asked for."""
    responses.add(responses.GET, _BLS_URL, json=_bls_payload(_latest_three_years()), status=200)
    df = client.fetch_bls_series(
        "CUUR0000SA0", 2025, 2026, base_url="https://api.bls.gov/publicAPI"
    )
    years = {d[-4:] for d in df["data"]}
    assert years == {"2025", "2026"}
    assert len(df) == 24


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
    "HICP.M.U2.N.000000.4D0.INX,M,2021-01,105.5\n"
    "HICP.M.U2.N.000000.4D0.INX,M,2021-02,106.4\n"
)


@responses.activate
def test_ecb_parses_the_csv_into_the_shared_date_shape() -> None:
    responses.add(responses.GET, _ECB_URL, body=_ECB_CSV, status=200)
    df = client.fetch_ecb_series(
        "HICP.M.U2.N.000000.4D0.INX",
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
        "HICP.M.U2.N.000000.4D0.INX",
        2021,
        2021,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert "/data/HICP/M.U2.N.000000.4D0.INX?" in responses.calls[0].request.url


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
        "HICP.M.U2.N.000000.4D0.INX",
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
        "HICP.M.U2.N.000000.4D0.INX",
        1974,
        1980,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert df.empty


@responses.activate
def test_ecb_period_with_an_empty_value_is_absent_not_the_string_nan() -> None:
    """The HICP dataflow lists 1990-01..1995-12 with an EMPTY OBS_VALUE (the euro-area index
    starts in 1996). Read as str that cell is NaN, and `astype(str)` turns NaN into the
    four characters "nan" — a Bronze row that looks like a value to anything but a cast."""
    responses.add(
        responses.GET,
        _ECB_URL,
        body=(
            "KEY,FREQ,TIME_PERIOD,OBS_VALUE\n"
            "HICP.M.U2.N.000000.4D0.INX,M,1995-12,\n"
            "HICP.M.U2.N.000000.4D0.INX,M,1996-01,55.12\n"
        ),
        status=200,
    )
    df = client.fetch_ecb_series(
        "HICP.M.U2.N.000000.4D0.INX",
        1995,
        1996,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert list(df["data"]) == ["01/01/1996"]
    assert "nan" not in set(df["valor"])


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


# ── pipeline: the two phases, end to end ──────────────────────────────────────


def _raw_roundtrip():
    """land_raw captures the verbatim frame; read_raw replays it (Phase 1 → Phase 2)."""
    holder: dict = {}

    def land(df, **_kw):
        holder["df"] = df
        return "gs://test/raw"

    def read(*_a, **_kw):
        return holder["df"].copy()

    return land, read


@contextmanager
def _offline_gcp(monkeypatch: pytest.MonkeyPatch, *, land=None, read=None):
    """Every GCP touchpoint stubbed, so run() exercises its own two phases only."""
    land_fn, read_fn = _raw_roundtrip()
    with (
        patch("embrapa_dashboard.gcp.clients.bigquery.Client"),
        patch("embrapa_dashboard.gcp.clients.storage.Client"),
        patch.object(pipeline, "ensure_dataset"),
        patch.object(pipeline, "land_raw", side_effect=land or land_fn) as land_mock,
        patch.object(pipeline, "read_raw", side_effect=read or read_fn),
        patch.object(pipeline, "load_dataframe") as load_mock,
    ):
        yield land_mock, load_mock


def test_fetch_routes_each_index_to_its_own_publisher(monkeypatch: pytest.MonkeyPatch) -> None:
    """The provider is data on the spec, not a branch anyone has to remember: CPI goes to
    BLS with the optional key, HICP to the ECB with none."""
    seen: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        client,
        "fetch_bls_series",
        lambda code, s, e, *, base_url, api_key="": (
            seen.append(("bls", code, api_key)) or _frame("01/01/2021")
        ),
    )
    monkeypatch.setattr(
        client,
        "fetch_ecb_series",
        lambda code, s, e, *, base_url: seen.append(("ecb", code, "")) or _frame("01/01/2021"),
    )
    settings = _settings(bls_api_key="k")
    for spec in pipeline.FOREIGN_INDICES:
        pipeline._fetch(spec, settings, 2020, 2021)
    assert seen == [("bls", "CUUR0000SA0", "k"), ("ecb", "HICP.M.U2.N.000000.4D0.INX", "")]


def test_fetch_refuses_an_unknown_provider() -> None:
    bogus = pipeline.ForeignIndexSpec(
        label="X",
        provider="nope",
        economy="US",
        currency="USD",
        code_attr="foreign_inflation_cpi_code",
        description="",
    )
    with pytest.raises(ValueError, match="nope"):
        pipeline._fetch(bogus, _settings(), 2020, 2021)


def test_run_lands_the_raw_object_then_loads_bronze(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_fetch(monkeypatch, {"CPI": _frame("01/01/2021"), "HICP": _frame("01/02/2021")})
    with _offline_gcp(monkeypatch) as (land, load):
        destination = pipeline.run(_settings(), full=True)

    assert destination.endswith(".bronze_foreign.inflation_series_raw")
    # Phase 1 archives under raw/foreign/inflation/, run-stamped by the window ACTUALLY
    # fetched — not the configured one, which HICP does not reach.
    kw = land.call_args.kwargs
    assert (kw["source"], kw["dataset"]) == ("foreign", "inflation")
    assert kw["basename"].endswith("_2021_2021")
    assert kw["provenance"]["mode"] == "full"
    assert "bls:CUUR0000SA0" in kw["provenance"]["series"]
    # Phase 2 stamps the Bronze-only column and keeps the natural key clustered.
    loaded = load.call_args.args[1]
    assert "ingestion_timestamp" in loaded.columns
    assert load.call_args.kwargs["time_partitioning_field"] == "ingestion_timestamp"
    assert load.call_args.kwargs["clustering_fields"] == ["series_code", "reference_date_str"]


def test_run_delta_short_circuits_when_nothing_is_new(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing new must not archive an empty raw object — the trail is an audit record,
    and an empty entry in it reads as 'the publisher had nothing', which is different."""
    _stub_fetch(monkeypatch, {"CPI": pd.DataFrame(), "HICP": pd.DataFrame()})
    monkeypatch.setattr(pipeline, "latest_reference_date", lambda *a, **k: date(2026, 8, 1))
    with _offline_gcp(monkeypatch) as (land, load):
        assert pipeline.run(_settings(), full=False) == ""
    land.assert_not_called()
    load.assert_not_called()


def test_run_from_raw_replays_the_trail_without_touching_the_publishers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(*_a, **_k):
        raise AssertionError("--from-raw must not call the APIs")

    monkeypatch.setattr(pipeline, "_fetch", boom)
    monkeypatch.setattr(pipeline, "list_raw", lambda *a, **k: ["run1", "run2"])
    with _offline_gcp(monkeypatch, read=lambda *a, **k: _frame("01/01/2021")) as (land, load):
        destination = pipeline.run(_settings(), from_raw=True)
    assert destination.endswith("inflation_series_raw")
    land.assert_not_called()
    assert load.call_count == 2  # both archived runs appended, in order


def test_run_from_raw_with_an_empty_trail_is_a_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipeline, "list_raw", lambda *a, **k: [])
    with _offline_gcp(monkeypatch) as (_land, load):
        assert pipeline.run(_settings(), from_raw=True) == ""
    load.assert_not_called()


# ── client: the paths that only fire when something goes wrong ────────────────


def test_retry_hook_survives_an_outcome_with_no_exception() -> None:
    """The tenacity hook runs on the way to a retry; it must never be the thing that
    raises, or a transient blip turns into a crash inside the retry machinery."""
    state = SimpleNamespace(
        outcome=SimpleNamespace(exception=lambda: ValueError("x")), attempt_number=2
    )
    client._emit_retry(state)
    client._emit_retry(SimpleNamespace(outcome=None, attempt_number=1))


@responses.activate
def test_a_retryable_status_is_classified_transient() -> None:
    responses.add(responses.GET, _BLS_URL, body="upstream down", status=503)
    with pytest.raises(client.ForeignInflationTransientError):
        client.fetch_bls_series("CUUR0000SA0", 2021, 2021, base_url="https://api.bls.gov/publicAPI")


@responses.activate
def test_a_non_retryable_status_is_permanent() -> None:
    responses.add(responses.GET, _ECB_URL, body="nope", status=400)
    with pytest.raises(client.ForeignInflationRequestError) as exc:
        client.fetch_ecb_series(
            "HICP.M.U2.N.000000.4D0.INX",
            2021,
            2021,
            base_url="https://data-api.ecb.europa.eu/service/data",
        )
    assert not isinstance(exc.value, client.ForeignInflationTransientError)


@responses.activate
def test_ecb_csv_without_the_expected_columns_is_empty_not_a_crash() -> None:
    """A portal that answers 200 with a different shape (an error page, a changed
    column set) must degrade to 'no data' — the cold-series guard upstream is what
    turns a persistent version of that into a loud failure."""
    responses.add(responses.GET, _ECB_URL, body="KEY,FREQ\nx,M\n", status=200)
    df = client.fetch_ecb_series(
        "HICP.M.U2.N.000000.4D0.INX",
        2021,
        2021,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert df.empty


@responses.activate
def test_ecb_response_with_no_monthly_rows_is_empty() -> None:
    responses.add(
        responses.GET, _ECB_URL, body="KEY,FREQ,TIME_PERIOD,OBS_VALUE\nx,A,2021,104.0\n", status=200
    )
    df = client.fetch_ecb_series(
        "HICP.M.U2.N.000000.4D0.INX",
        2021,
        2021,
        base_url="https://data-api.ecb.europa.eu/service/data",
    )
    assert df.empty
