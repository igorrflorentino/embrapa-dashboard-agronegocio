"""HTTP clients for the two foreign price-index publishers (BLS · ECB).

Both fetchers return the SAME two-column frame the BCB SGS client returns —
``data`` (``dd/mm/yyyy``) and ``valor`` (the observation as a string) — so the
Bronze natural key, the raw-zone archive and the Silver dedup are identical for
every inflation series regardless of who published it. The per-provider quirks
(pagination window, response format, the "no data this far back" answer) stop
here; nothing downstream branches on the provider again.

One difference from SGS matters downstream and is NOT hidden here: these series
are INDEX LEVELS (CPI-U 1982-84=100, HICP 2025=100), while SGS 433/189/190 are
monthly % changes. ``silver_foreign_inflation`` uses the value as the index
directly instead of chain-linking it.

Both publishers have a way of answering 200 with data that is not what was asked
for, and both have bitten: the keyless BLS v1 GET ignores the requested years, and
the ECB's older ``ICP`` dataflow keeps serving a series that stopped in 2025-12.
The first is refused here (a window answered entirely outside itself); the second
is visible only against the calendar, which is the doctor's job, not the ingest's.
"""

from __future__ import annotations

import io
import logging
import re

import pandas as pd
import requests

from embrapa_dashboard.core import SourceTransientError
from embrapa_dashboard.core import http as core_http

logger = logging.getLogger(__name__)

# Hard wall-clock ceiling for one HTTP request, and for all retries of one window.
# Mirrors the BCB client: the per-read timeout only fires on full byte-idle gaps, so a
# server trickling a byte every ~29s could bypass it forever without the manual drain.
REQUEST_TOTAL_DEADLINE_S: float = 90.0
PER_WINDOW_DEADLINE_S: float = 180.0

# BLS caps a single request's span: 10 years on the keyless v1 endpoint, 20 with a
# registered key on v2. We chunk to the smaller of the two that applies.
BLS_MAX_YEARS_V1 = 10
BLS_MAX_YEARS_V2 = 20


class ForeignInflationRequestError(Exception):
    """Non-200 (or non-success) response from a foreign price-index API."""


class ForeignInflationTransientError(ForeignInflationRequestError, SourceTransientError):
    """Transient (retryable) response from a foreign price-index API."""


_KEY_IN_URL = re.compile(r"(registrationkey=)[^&\s'\"]+", re.I)
_KEY_IN_BLS_ECHO = re.compile(r"(The key:)\S+", re.I)


def _scrub(text: str, secret: str = "") -> str:
    """Remove the BLS key from text headed for a log, a traceback or the heartbeat.

    The key rides the QUERY STRING, so three paths carry it out: requests puts the full
    URL into its connection/timeout errors; the retry hook logs those; and BLS ECHOES
    the key in its own refusal ("The key:<key> provided by the User is invalid") — which
    is how a pasted value reached the Job's stderr and three `ingestion_heartbeat` rows on
    2026-09-23. The literal replace covers the exact configured key; the two patterns
    cover the places a key sits even when this caller does not hold it (the retry hook).
    """
    if secret:
        text = text.replace(secret, "***")
    text = _KEY_IN_URL.sub(r"\1***", text)
    return _KEY_IN_BLS_ECHO.sub(r"\1***", text)


def _emit_retry(retry_state):  # type: ignore[no-untyped-def]
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    logger.warning(
        "Retrying foreign-inflation fetch attempt=%d: %s",
        retry_state.attempt_number,
        # Scrub BEFORE truncating: a slice can cut the pattern and leave a usable prefix.
        _scrub(str(exc))[:200] if exc else "?",
    )


@core_http.http_retry_policy(
    transient_exc=ForeignInflationTransientError,
    deadline_s=PER_WINDOW_DEADLINE_S,
    before_sleep=_emit_retry,
)
def _get(url: str, *, context: str):
    """One atomic GET, drained under the wall-clock deadline, status-checked."""
    response = core_http.get_drained(
        url,
        total_deadline_s=REQUEST_TOTAL_DEADLINE_S,
        transient_exc=ForeignInflationTransientError,
        context=context,
    )
    try:
        if response.status_code == 200:
            return response
        msg = f"HTTP {response.status_code} for {context}: {response.text[:200]}"
        if response.status_code in core_http.RETRYABLE_STATUS_CODES:
            raise ForeignInflationTransientError(msg)
        raise ForeignInflationRequestError(msg)
    except BaseException:
        response.close()
        raise


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=["data", "valor"])


# ── BLS (US CPI-U) ────────────────────────────────────────────────────────────


def _bls_window(base_url: str, series_id: str, start: int, end: int, api_key: str) -> pd.DataFrame:
    """One BLS timeseries window → the ``data``/``valor`` frame.

    The keyless v1 endpoint answers the same JSON as v2 for a single series, so the
    only thing the key changes is the path and the window width. A window entirely
    before the series exists comes back with an empty ``data`` list and no error —
    that is "no data", not a failure (same contract as SGS's 404).
    """
    version = "v2" if api_key else "v1"
    url = f"{base_url}/{version}/timeseries/data/{series_id}?startyear={start}&endyear={end}"
    if api_key:
        url = f"{url}&registrationkey={api_key}"
    try:
        response = _get(url, context=f"BLS {series_id} {start}-{end}")
    except Exception as exc:
        # The retries are spent by now; what is left is a message on its way to stderr
        # and the heartbeat. A requests error carries the URL — and with it the key.
        # Re-raised as our own type with the transience preserved (`ingest all` treats a
        # transient failure differently), and `from None`: the chained original would
        # print the unscrubbed URL in the traceback right under the scrubbed one.
        scrubbed = _scrub(str(exc), api_key)
        if scrubbed == str(exc):
            raise
        transient = isinstance(exc, (requests.RequestException, SourceTransientError))
        kind = ForeignInflationTransientError if transient else ForeignInflationRequestError
        raise kind(scrubbed) from None
    payload = response.json()
    status = payload.get("status", "")
    if status != "REQUEST_SUCCEEDED":
        # BLS reports a throttle/quota refusal with HTTP 200 and a status string, so
        # the status check cannot live in _get. Daily-quota exhaustion is transient in
        # the only sense that matters here: it clears on its own.
        messages = _scrub("; ".join(payload.get("message", [])), api_key)[:300]
        msg = f"BLS {series_id} {start}-{end}: {status} {messages}"
        if "threshold" in messages.lower() or "limit" in messages.lower():
            raise ForeignInflationTransientError(msg)
        raise ForeignInflationRequestError(msg)

    series = payload.get("Results", {}).get("series", [])
    rows = series[0].get("data", []) if series else []
    records = []
    outside: list[int] = []
    for row in rows:
        period = str(row.get("period", ""))
        # M01..M12 are the monthly readings; M13 is the ANNUAL AVERAGE BLS ships in the
        # same list. Keeping it would put a 13th "month" in the series and, worse, give
        # December two candidate readings for the year-end index.
        if not period.startswith("M") or period == "M13":
            continue
        year = int(row["year"])
        if not start <= year <= end:
            outside.append(year)
            continue
        month = int(period[1:])
        records.append({"data": f"01/{month:02d}/{year}", "valor": str(row.get("value", ""))})

    if outside and not records:
        # The keyless v1 GET ignores startyear/endyear and answers the latest three years
        # whatever was asked (measured 2026-09-23). Taking that answer as the window's
        # would store the same recent months once per window and report a backfill that
        # never happened — which is exactly what the 2026-09-14 run did, six times over.
        # Refusing here turns that silent truncation into a failure that names its cause.
        raise ForeignInflationRequestError(
            f"BLS {series_id} {start}-{end}: the answer covers {min(outside)}-{max(outside)}, "
            f"none of the requested window — BLS ignored startyear/endyear. The keyless v1 "
            "endpoint does this; set BLS_KEY_SECRET (the Job) or BLS_API_KEY (local) so the "
            "call goes to v2, which honours the window."
        )
    if outside:
        # A window that overlaps the latest three years (a delta run) gets its own years
        # back plus the neighbours v1 always sends. The neighbours are not this window's
        # to store: dropping them keeps each window's archive exactly its own span.
        logger.info(
            "BLS %s %d-%d: dropped %d observation(s) outside the window (%d-%d).",
            series_id,
            start,
            end,
            len(outside),
            min(outside),
            max(outside),
        )
    if not records:
        logger.info("BLS %s: no observations for %d-%d — skipping window.", series_id, start, end)
        return _empty()
    return pd.DataFrame.from_records(records)


def fetch_bls_series(
    series_id: str, start_year: int, end_year: int, *, base_url: str, api_key: str = ""
) -> pd.DataFrame:
    """Fetch a BLS series across the whole window, chunked to the API's span cap."""
    span = BLS_MAX_YEARS_V2 if api_key else BLS_MAX_YEARS_V1
    frames = []
    for chunk_start in range(start_year, end_year + 1, span):
        chunk_end = min(chunk_start + span - 1, end_year)
        df = _bls_window(base_url, series_id, chunk_start, chunk_end, api_key)
        if not df.empty:
            frames.append(df)
    if not frames:
        return _empty()
    return pd.concat(frames, ignore_index=True)


# ── ECB (euro-area HICP) ──────────────────────────────────────────────────────


def fetch_ecb_series(
    series_key: str, start_year: int, end_year: int, *, base_url: str
) -> pd.DataFrame:
    """Fetch an ECB Data Portal series in one call → the ``data``/``valor`` frame.

    The SDMX REST path splits the series key at its FIRST dot: ``HICP`` is the dataflow
    and ``M.U2.N.000000.4D0.INX`` the series within it. ``format=csvdata`` is asked for
    because the CSV is a flat table (one row per observation) — the SDMX-JSON
    alternative nests observations under positional indices that have to be re-joined
    to a dimension list, which is a lot of parsing for the same two columns.

    An HTTP 404 here means the query matched no observation (e.g. a window entirely
    before 1996), which is "no data" rather than an error — same contract as SGS.
    """
    if "." not in series_key:
        raise ForeignInflationRequestError(
            f"ECB series key {series_key!r} has no dataflow prefix "
            "(expected e.g. 'HICP.M.U2.N.000000.4D0.INX')"
        )
    dataflow, key = series_key.split(".", 1)
    url = (
        f"{base_url}/{dataflow}/{key}"
        f"?format=csvdata&detail=dataonly"
        f"&startPeriod={start_year}-01&endPeriod={end_year}-12"
    )
    try:
        response = _get(url, context=f"ECB {series_key} {start_year}-{end_year}")
    except ForeignInflationRequestError as exc:
        if "HTTP 404" in str(exc):
            logger.info(
                "ECB %s: 404 (no data) for %d-%d — skipping.", series_key, start_year, end_year
            )
            return _empty()
        raise

    raw = pd.read_csv(io.StringIO(response.text), dtype=str)
    if raw.empty or "TIME_PERIOD" not in raw or "OBS_VALUE" not in raw:
        logger.warning("ECB %s returned no usable rows for %d-%d", series_key, start_year, end_year)
        return _empty()

    periods = raw["TIME_PERIOD"].astype(str)
    # Monthly series only: 'YYYY-MM'. Anything else (an annual 'YYYY' row, a quarterly
    # 'YYYY-Q1') is a different frequency that must not be mixed into a monthly index.
    monthly = periods.str.fullmatch(r"\d{4}-\d{2}")
    # A period with no value is a month the series does not cover, not a reading. The
    # HICP dataflow lists 1990-01..1995-12 with an EMPTY OBS_VALUE (the euro-area index
    # starts in 1996); read with dtype=str that cell is NaN, and `astype(str)` below
    # would store it as the four-character string "nan" — a row Silver then has to
    # know to discard. Absence stays absence here, at the boundary.
    valued = raw["OBS_VALUE"].fillna("").astype(str).str.strip().ne("")
    raw = raw[monthly.fillna(False) & valued]
    if raw.empty:
        return _empty()
    parts = raw["TIME_PERIOD"].astype(str).str.split("-", n=1, expand=True)
    return pd.DataFrame(
        {
            "data": "01/" + parts[1] + "/" + parts[0],
            "valor": raw["OBS_VALUE"].astype(str).values,
        }
    ).reset_index(drop=True)
