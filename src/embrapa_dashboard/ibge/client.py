"""HTTP client for the IBGE SIDRA values endpoint with adaptive slicing."""

from __future__ import annotations

import contextvars
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import requests

from embrapa_dashboard import observability
from embrapa_dashboard.core import SourceTransientError
from embrapa_dashboard.core import http as core_http

logger = logging.getLogger(__name__)

# UF acronym for each IBGE n3 state code — used in events so the monitor shows
# "BA STUCK 2m" instead of "29 STUCK 2m".
STATE_CODE_TO_UF: dict[int, str] = {
    11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO",
    21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL",
    28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR",
    42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF",
}  # fmt: skip

# Thread-local pointer to the state currently being fetched. Read by the
# tenacity before_sleep hook so retry events carry the state acronym.
_current_state: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_state", default=None
)

# All 27 Brazilian federative units (IBGE n3 codes).
BRAZIL_STATES: tuple[int, ...] = (
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    31,
    32,
    33,
    35,
    41,
    42,
    43,
    50,
    51,
    52,
    53,
)

SIDRA_VALUES_URL = "https://apisidra.ibge.gov.br/values/t/{table_id}/p/{periods}/v/{variables}/{geo_level}/{geo_filter}/c{classification}/{products}"

# SIDRA returns at most this many cells per HTTP response. Going over triggers
# a 400 with "Limite de valores excedido".
SIDRA_CELL_LIMIT_PER_REQUEST = 100_000

# Minas Gerais has the most municipalities (853). Used as the worst-case denominator
# when sizing chunks — if MG fits under the cell limit, every other state does too.
LARGEST_STATE_MUNICIPALITY_COUNT = 853

# PEVS table 289 publishes 3 variables (`v/all` returns all): 144 (quantity),
# 145 (value), 1000145 (value as % of total).
SIDRA_T289_VARIABLES = 3


def recommended_chunk_years(n_products: int, safety: float = 0.7) -> int:
    """Compute the largest year-chunk that keeps every state response under
    SIDRA's per-request cell limit, with a 30% safety margin to absorb future
    municipality growth and per-request variability.

    cells_per_request = chunk_years * MG_municipalities * n_products * n_variables
    """
    if n_products <= 0:
        raise ValueError("n_products must be positive")
    safe_cells = int(SIDRA_CELL_LIMIT_PER_REQUEST * safety)
    denom = LARGEST_STATE_MUNICIPALITY_COUNT * SIDRA_T289_VARIABLES * n_products
    return max(1, safe_cells // denom)


# The (connect, read) timeout for the actual GET lives in
# ``core_http.DEFAULT_TIMEOUT`` — see ``_http_get`` -> ``core_http.get_drained``.

# Hard wall-clock ceiling for one HTTP request, enforced by manually iterating
# response.iter_content() with a deadline check. Without this, slow-byte
# pathologies bypass requests' per-read timeout indefinitely.
REQUEST_TOTAL_DEADLINE_S: float = 75.0

# Cumulative retry budget for ONE SIDRA HTTP call (one ``_http_get``): tenacity
# stops *starting* new attempts once this many seconds have elapsed across
# retries. Two things this is NOT:
# - a hard wall-clock ceiling: ``stop_after_delay`` never interrupts an attempt
#   already in flight, so one call can still run up to roughly this budget plus
#   REQUEST_TOTAL_DEADLINE_S (the in-flight attempt's own drain deadline);
# - per state: ``_fetch_block``'s recursive period-halving can issue several
#   ``_http_get`` calls for one state, each with its own fresh budget.
# Operators sizing job timeouts should budget per *call*, not per state.
PER_CALL_RETRY_BUDGET_S: float = 180.0

# ── Volume-based dynamic timeouts ─────────────────────────────────────────────
# A SIDRA response grows ~linearly with the request's cell volume: periods (years)
# × products × variables × the queried geography's municipality count. The flat
# REQUEST_TOTAL_DEADLINE_S above is the FLOOR — fine for a small request, but too
# tight to drain a wide-window / many-product response from a SLOW SIDRA. (This is
# exactly what killed the PPM 1974→ backfill: an already-cell-halved 12-year ×
# 8-product herd query for a big state couldn't stream within 75s on a slow night,
# and a slow-byte timeout — unlike a cell-limit error — does NOT trigger further
# halving, so it just re-tried at full size and died.) ``_request_deadlines`` scales
# BOTH budgets with the request's period×product×variable volume, clamped to a sane
# ceiling: a big request gets proportionally longer to drain (and a larger retry
# budget), while a small one keeps the lean 75s / 180s.
_DEADLINE_BASE_S: float = 45.0
_DEADLINE_PER_UNIT_S: float = 1.5  # added drain seconds per (period × product × variable)
_DEADLINE_MAX_S: float = 600.0  # ceiling: one drain never waits past 10 min
_RETRY_BUDGET_MULT: float = 2.5  # cumulative retry budget = this × the drain deadline
_RETRY_BUDGET_MAX_S: float = 1800.0
# 'v/all' returns an unknown variable count; SIDRA tables expose a handful, so treat
# it as a moderate constant for the volume estimate.
_ALL_VARIABLES_VOLUME: int = 5


def _request_deadlines(
    n_periods: int, n_products: int, variables: str, geo_units: int = 1
) -> tuple[float, float]:
    """Volume-scaled ``(drain_deadline_s, retry_budget_s)`` for one SIDRA request.

    The drain deadline scales linearly with ``periods × products × variables ×
    geo_units`` above the flat REQUEST_TOTAL_DEADLINE_S floor; the retry budget is a
    multiple of it. Both are clamped so a pathological request can't wait forever.
    ``variables`` is the ``v/`` selector — an explicit comma list counts its codes,
    ``'all'`` uses a moderate constant.

    ``geo_units`` is the queried geography's municipality count (the response also grows
    ~linearly with it). It scales the per-attempt DRAIN cap ONLY: for an ``n6`` per-state
    slice callers pass the worst-case ``LARGEST_STATE_MUNICIPALITY_COUNT`` so a DENSE
    state (MG, 853) gets the generous 600s drain ceiling on a slow night (IBGE-1). The
    cumulative RETRY budget deliberately does NOT fold in ``geo_units`` — it tracks the
    request's own ``periods × products × variables`` volume — so a sparse single-year n6
    slice keeps the lean ~187s retry budget instead of inheriting the saturated
    ceiling × MULT (which would let a single stalled state re-attempt for most of the
    nightly task window). Default ``1`` leaves the aggregated (n1/n3) budgets exactly as
    before. The drain is a CAP, not a forced wait — a fast response completes early — so
    clamping n6 drains to the ceiling is purely protective.
    """
    n_vars = (
        _ALL_VARIABLES_VOLUME
        if variables.strip() == "all"
        else max(1, sum(1 for v in variables.split(",") if v.strip()))
    )
    core_units = max(1, n_periods) * max(1, n_products) * n_vars
    # Per-attempt drain CAP scales with the FULL volume, incl. the queried geography size.
    units = core_units * max(1, geo_units)
    drain = min(
        _DEADLINE_MAX_S,
        max(REQUEST_TOTAL_DEADLINE_S, _DEADLINE_BASE_S + _DEADLINE_PER_UNIT_S * units),
    )
    # Cumulative retry budget tracks the request's OWN (geo-independent) volume, so a
    # sparse single-year n6 slice keeps the lean budget even though its drain is capped at
    # the ceiling. Without this, every n6 call inherited 600 × MULT = 1500s (IBGE-1).
    core_drain = min(
        _DEADLINE_MAX_S,
        max(REQUEST_TOTAL_DEADLINE_S, _DEADLINE_BASE_S + _DEADLINE_PER_UNIT_S * core_units),
    )
    retry_budget = min(_RETRY_BUDGET_MAX_S, core_drain * _RETRY_BUDGET_MULT)
    return drain, retry_budget


# Empirical sweet spot: 4 workers with `Connection: close` avoids the urllib3
# pool deadlocks observed at 8 workers AND the connection-staleness hangs
# observed when reusing Keep-Alive sockets against SIDRA (which closes idle
# server-side connections aggressively).
MAX_PARALLEL_STATE_FETCHES = 4


class SidraLimitExceeded(Exception):
    """Raised when SIDRA refuses the request because it would return too many cells.

    ``periods`` carries the exact period window of the request that was refused —
    the recursive halving in ``_fetch_block`` narrows it to a single year before
    the exception finally propagates, so callers can report the year that actually
    failed rather than the whole outer window.
    """

    def __init__(self, *args: object, periods: list[int] | None = None) -> None:
        super().__init__(*args)
        self.periods = periods


class SidraRequestError(Exception):
    """Raised on any non-200, non-limit-exceeded SIDRA error (base class)."""


class SidraTransientError(SidraRequestError, SourceTransientError):
    """Retryable SIDRA error (5xx, 408, 429, etc.)."""


def _clean_column_name(name: str) -> str:
    """Normalize a SIDRA header to snake_case (ASCII)."""
    name = str(name).lower()
    replacements = {
        "á": "a",
        "à": "a",
        "â": "a",
        "ã": "a",
        "é": "e",
        "ê": "e",
        "í": "i",
        "ó": "o",
        "ô": "o",
        "õ": "o",
        "ú": "u",
        "ç": "c",
    }
    for src, dst in replacements.items():
        name = name.replace(src, dst)
    name = re.sub(r"[^a-z0-9_]", "_", name)
    name = re.sub(r"_+", "_", name).strip("_")
    return name or "unnamed_column"


def _emit_retry(retry_state):  # type: ignore[no-untyped-def]
    """Tenacity before_sleep hook: emit structured event + warn the console."""
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    state = _current_state.get()
    observability.emit(
        "retry",
        state=state,
        attempt=retry_state.attempt_number,
        reason=str(exc)[:200] if exc else "?",
    )
    logger.warning(
        "Retrying SIDRA fetch state=%s attempt=%d: %s",
        state,
        retry_state.attempt_number,
        exc,
    )


def _http_get_once(
    url: str, *, total_deadline_s: float = REQUEST_TOTAL_DEADLINE_S
) -> requests.Response:
    """One drained SIDRA GET + SIDRA-specific status handling (NO retry).

    ``total_deadline_s`` is the volume-scaled wall-clock drain budget (see
    ``_request_deadlines``). The drain-under-deadline + Connection: close +
    slow-byte defense live in ``core_http.get_drained``; the ``SidraLimitExceeded``
    branch that drives period-halving in ``_fetch_block`` stays here so the helper
    doesn't grow API knowledge.
    """
    response = core_http.get_drained(
        url,
        total_deadline_s=total_deadline_s,
        transient_exc=SidraTransientError,
        context=url[:200],
    )
    try:
        if response.status_code == 200:
            return response
        if response.status_code in (400, 403):
            body = response.text.lower()
            if "limite" in body or "valores" in body:
                raise SidraLimitExceeded(body[:200])
        msg = f"HTTP {response.status_code} for {url}: {response.text[:200]}"
        if response.status_code in core_http.RETRYABLE_STATUS_CODES:
            raise SidraTransientError(msg)
        raise SidraRequestError(msg)
    except BaseException:
        # Ensure the underlying socket is released on any exit other than the
        # happy-path return above. ``get_drained`` already closes on its own
        # exceptions; this guards the status-check branch.
        response.close()
        raise


def _http_get(
    url: str,
    *,
    total_deadline_s: float = REQUEST_TOTAL_DEADLINE_S,
    retry_budget_s: float = PER_CALL_RETRY_BUDGET_S,
) -> requests.Response:
    """Drained SIDRA GET with full-jitter exponential-backoff retry.

    Both budgets are volume-scaled by the caller (``_fetch_block`` via
    ``_request_deadlines``): a bigger request gets a longer per-attempt drain
    (``total_deadline_s``) AND a longer cumulative retry budget (``retry_budget_s``).
    The retry policy stops on EITHER max_attempts OR the cumulative budget — the OR
    keeps repeated slow-byte hangs from re-attempting forever. It is built per call
    so the budget can vary by request; the defaults are the lean floor for ad-hoc
    callers that don't scale.
    """
    retry_policy = core_http.http_retry_policy(
        transient_exc=SidraTransientError,
        deadline_s=retry_budget_s,
        before_sleep=_emit_retry,
    )
    return retry_policy(_http_get_once)(url, total_deadline_s=total_deadline_s)


def _periods_string(periods: list[int]) -> str:
    if not periods:
        # Defensive: an empty period list has no SIDRA representation. Callers
        # short-circuit on it (see fetch_sidra_dataframe), so this only guards
        # against an accidental index-into-empty if one ever slips through.
        raise ValueError("periods is empty — no SIDRA period range to format")
    return f"{periods[0]}-{periods[-1]}" if len(periods) > 1 else str(periods[0])


def _fetch_block(
    table_id: str,
    periods: list[int],
    geo_level: str,
    geo_filter: str,
    classification: str,
    products: list[str],
    variables: str = "all",
) -> list[list[dict]]:
    """Fetch one SIDRA block. Returns a list of payloads (each with its own header row).

    ``variables`` is the SIDRA ``v/`` selector — ``"all"`` (default, PEVS) or an
    explicit comma list (PAM passes only its 5 substantive codes, since table 5457's
    ``v/all`` includes 3 useless percentual series that blow the per-request limit).

    On `SidraLimitExceeded`, the period is halved and the function recurses; if
    the period is already a single year, the exception propagates so the caller
    can decide whether to fall back to a different slicing strategy (e.g.
    per-state).
    """
    url = SIDRA_VALUES_URL.format(
        table_id=table_id,
        periods=_periods_string(periods),
        variables=variables,
        geo_level=geo_level,
        geo_filter=geo_filter,
        classification=classification,
        products=",".join(products),
    )
    logger.info(
        "SIDRA fetch t=%s p=%s geo=%s/%s products=%s",
        table_id,
        _periods_string(periods),
        geo_level,
        geo_filter,
        products,
    )
    # Scale the per-attempt drain + cumulative retry budget to THIS block's volume
    # (periods × products × variables × municipality count) so a wide-window /
    # many-product / DENSE-state request gets proportionally longer than the flat 75s —
    # and each halved recursion below recomputes its own (smaller) budget. An n6
    # per-state slice's response is dominated by the state's município count, so it
    # uses the worst-case LARGEST_STATE_MUNICIPALITY_COUNT (IBGE-1); aggregated levels
    # (n1/n3) keep geo_units=1.
    geo_units = LARGEST_STATE_MUNICIPALITY_COUNT if geo_level == "n6" else 1
    drain_s, retry_budget_s = _request_deadlines(len(periods), len(products), variables, geo_units)
    try:
        response = _http_get(url, total_deadline_s=drain_s, retry_budget_s=retry_budget_s)
    except SidraLimitExceeded as exc:
        if len(periods) > 1:
            mid = len(periods) // 2
            args = (table_id, geo_level, geo_filter, classification, products, variables)
            return _fetch_block(args[0], periods[:mid], *args[1:]) + _fetch_block(
                args[0], periods[mid:], *args[1:]
            )
        # A single-year request was still refused — record the failing year so
        # callers can report it instead of the (already-halved-away) outer window.
        exc.periods = periods
        raise
    payload = response.json()
    # Shape guard: a SIDRA data response is a JSON ARRAY whose first element is the
    # header row. A non-list body (an error object, or an undocumented shape) would
    # otherwise slip past the downstream `len(payload) < 2` check and yield a garbage/
    # empty DataFrame — so reject it loudly here. NOTE: this validates SHAPE, not
    # COMPLETENESS. SIDRA signals a too-large request with an HTTP 400
    # ("limite … excedido", handled above), NOT a silent 200 truncation, so a
    # valid-shaped 200 is trusted to be complete for the requested cells.
    if not isinstance(payload, list):
        raise SidraRequestError(
            f"SIDRA returned a {type(payload).__name__}, expected a JSON array "
            f"([header, ...rows]) for {url[:120]}"
        )
    return [payload]


def _fetch_one_state(
    state_code: int,
    table_id: str,
    periods: list[int],
    classification: str,
    products: list[str],
    variables: str = "all",
) -> list[list[dict]]:
    """Per-state worker. Sets the contextvar so retry events carry the UF,
    and emits state_start / state_end / state_error around the fetch."""
    uf = STATE_CODE_TO_UF.get(state_code, str(state_code))
    token = _current_state.set(uf)
    started = time.monotonic()
    observability.emit("state_start", state=uf, state_code=state_code)
    try:
        payloads = _fetch_block(
            table_id, periods, "n6", f"in n3 {state_code}", classification, products, variables
        )
        # Each payload's first row is the SIDRA header — exclude it from the count.
        rows = sum(max(0, len(p) - 1) for p in payloads)
        observability.emit(
            "state_end",
            state=uf,
            state_code=state_code,
            rows=rows,
            duration_s=round(time.monotonic() - started, 2),
        )
        return payloads
    except Exception as exc:
        observability.emit(
            "state_error",
            state=uf,
            state_code=state_code,
            error=str(exc)[:300],
            duration_s=round(time.monotonic() - started, 2),
        )
        raise
    finally:
        _current_state.reset(token)


def _fetch_by_state_parallel(
    table_id: str,
    periods: list[int],
    classification: str,
    products: list[str],
    variables: str = "all",
) -> list[list[dict]]:
    """Fallback path: slice an n6 query by state with a thread pool."""
    payloads: list[list[dict]] = []
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_STATE_FETCHES) as pool:
        future_to_state = {
            pool.submit(
                _fetch_one_state,
                state_code,
                table_id,
                periods,
                classification,
                products,
                variables,
            ): state_code
            for state_code in BRAZIL_STATES
        }
        for future in as_completed(future_to_state):
            state_code = future_to_state[future]
            try:
                payloads.extend(future.result())
            except SidraLimitExceeded as exc:
                # The window was already halved down to a single year before this
                # propagated (see _fetch_block), so report THAT year, not the outer
                # window — and since one year for one state still exceeds the limit,
                # the actionable knob is fewer product codes, not a narrower window.
                failing = exc.periods if exc.periods is not None else periods
                raise RuntimeError(
                    f"State {state_code} for period {_periods_string(failing)} alone exceeds "
                    f"the SIDRA cell limit. Reduce the number of product codes "
                    f"(IBGE_PRODUCT_CODES) for this ingest."
                ) from exc
            except Exception:
                logger.exception("State %s failed permanently", state_code)
                raise
    return payloads


def fetch_sidra_dataframe(
    table_id: str,
    start_year: int,
    end_year: int,
    classification: str,
    products: list[str],
    geo_level: str = "n6",
    variables: str = "all",
) -> pd.DataFrame:
    """Extract the full PEVS slice into a single DataFrame with snake_case headers.

    For municipal granularity (``geo_level='n6'``) we slice by state in parallel.
    Empirically this beats a single ``geo_filter='all'`` request for any
    realistic window: each state returns a small payload (~hundreds of KB),
    and 4 parallel workers (see ``MAX_PARALLEL_STATE_FETCHES``) cover all 27
    states far faster than a single ``all`` response (~17 MB, ~60s on its own).

    Per-state requests still go through ``_fetch_block``, so the recursive
    period-halving still kicks in if any individual state hits the SIDRA cell
    limit for a long-enough window.
    """
    periods = list(range(start_year, end_year + 1))
    if not periods:
        # An inverted window (start_year > end_year) yields no periods. Treat it
        # as "no rows" rather than indexing into an empty list downstream — the
        # delta path can hand us such a window when Bronze is already current.
        logger.warning(
            "SIDRA fetch skipped: empty period window %d-%d (start > end).",
            start_year,
            end_year,
        )
        return pd.DataFrame()

    if geo_level == "n6":
        payloads = _fetch_by_state_parallel(table_id, periods, classification, products, variables)
    else:
        payloads = _fetch_block(
            table_id, periods, geo_level, "all", classification, products, variables
        )

    frames: list[pd.DataFrame] = []
    for payload in payloads:
        if not payload or len(payload) < 2:
            continue
        # First row of every SIDRA payload is the human header — promote to columns.
        df = pd.DataFrame(payload)
        df.columns = df.iloc[0]
        df = df.iloc[1:].reset_index(drop=True)
        frames.append(df)

    if not frames:
        # SIDRA replied OK to every state but no rows came back — most often
        # because the requested year window is not yet published (PEVS has a
        # ~1-year publication lag). Return an empty DataFrame so the caller
        # can skip the GCS/BQ load instead of poisoning Bronze with junk.
        logger.warning(
            "SIDRA returned no rows for periods %d-%d. "
            "Expected when the window runs ahead of the latest release; see "
            "`embrapa discover ibge-periods --table-id %s`.",
            start_year,
            end_year,
            table_id,
        )
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    combined.columns = [_clean_column_name(c) for c in combined.columns]
    return combined


__all__ = [
    "BRAZIL_STATES",
    "SidraLimitExceeded",
    "SidraRequestError",
    "fetch_sidra_dataframe",
]
