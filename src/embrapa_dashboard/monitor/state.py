"""Monitor state — event aggregation, diagnosis heuristic, ETA computations.

This module is intentionally Rich-free so it can be unit-tested without
booting any terminal UI. The companion ``render`` module imports from here
and adds the Rich rendering on top.

The single class :class:`MonitorState` is mutable in place: callers feed it
JSON event dicts via :meth:`MonitorState.apply` and read aggregates off
its attributes. The ``_handlers`` dispatch table dispatches on the
``event`` field.
"""

from __future__ import annotations

import statistics
import time
from collections import deque
from datetime import UTC, datetime
from typing import Any, ClassVar

# A state with no event for this long is flagged "STUCK". Calibrated to
# SIDRA's typical per-state response (<5s) plus a few retry-and-backoff cycles.
STUCK_THRESHOLD_S = 90
# How many recent events to keep on screen.
RECENT_EVENTS = 8
# How many error history entries to keep + display.
ERROR_HISTORY = 6
# Brazilian federative units that IBGE PEVS covers — used as the state-bar total.
STATES_PER_CHUNK = 27
# IBGE client paralellism — matches MAX_PARALLEL_STATE_FETCHES in ibge.client.
PARALLEL_STATE_FETCHES = 4
# Sliding window of state durations used for ETAs — keep one chunk's worth.
STATE_DUR_WINDOW = 27


def _parse_ts(s: str) -> float:
    """ISO-8601 → epoch seconds (UTC). Falls back to time.time() on parse error."""
    try:
        return datetime.fromisoformat(s).timestamp()
    except (ValueError, TypeError):
        return time.time()


def _fmt_duration(seconds: float) -> str:
    s = int(seconds)
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


def _fmt_eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "?"
    return _fmt_duration(seconds)


# ── Diagnosis heuristic ──────────────────────────────────────────────────
#
# Each entry is (patterns, message). ``patterns`` is a tuple of lowercase
# substrings; **any** match triggers the diagnosis. Order matters — first
# match wins, just like an if/elif chain, but the loop reduces cyclomatic
# complexity from D(30) to A(3).
_DIAGNOSIS_PATTERNS: list[tuple[tuple[str, ...], str]] = [
    (
        ("read timed out", "read timeout"),
        "SIDRA stopped sending bytes (slow-byte) — could be overload or an unstable connection.",
    ),
    (
        ("connection refused",),
        "Connection refused — IBGE may be under maintenance or blocking your IP.",
    ),
    (
        ("connection reset", "remotedisconnected"),
        "Connection reset by the server mid-response — SIDRA is unstable right now.",
    ),
    (
        ("name or service not known", "nodename nor servname"),
        "DNS failure — check your internet connection.",
    ),
    (
        ("limite de valores", "limite excedido"),
        "SIDRA cell limit exceeded — reduce --chunk-years or the number of products.",
    ),
    (
        ("retryerror", "stop_after_delay", "stop_after_attempt"),
        "180s per-state deadline exhausted after multiple retries — SIDRA is too slow.",
    ),
    (
        ("401", "unauthorized"),
        "Not authenticated — run `gcloud auth application-default login`.",
    ),
    (
        ("403", "forbidden"),
        "No permission — check IAM on GCP_PROJECT_ID.",
    ),
    (
        ("404", "not found"),
        "Resource not found — verify IBGE_TABLE_ID and the product codes.",
    ),
    (
        ("500", "502", "503", "504"),
        "SIDRA server returned a 5xx error — temporarily down, retry in a few minutes.",
    ),
    (
        ("ssl", "certificate"),
        "SSL error — check the system date/time and root certificates.",
    ),
    (
        ("memoryerror", "out of memory"),
        "Out of memory — reduce --chunk-years.",
    ),
    (
        ("returned no rows", "no rows for the requested"),
        "SIDRA returned empty — the year has probably not been published yet "
        "(PEVS has ~1 year of staleness) — expected while IBGE_END_YEAR floats "
        "ahead of the latest release; nothing to change.",
    ),
]

_GCS_PERMISSION_DIAGNOSIS = "No permission on the GCS bucket — check IAM."
_FALLBACK_DIAGNOSIS = "No automatic diagnosis — see the full message."


def _diagnose(error_text: str) -> str:
    """Map a raw error message to a probable-cause line in English.

    Heuristic-only; runs on every error event so keep the cost low (lowercased
    substring matches against :data:`_DIAGNOSIS_PATTERNS`). Returns a short
    sentence ending in a period.
    """
    if not error_text:
        return "No error message recorded."
    e = error_text.lower()

    # Two-condition special case (both substrings must match).
    if "permission denied" in e and "gs://" in e:
        return _GCS_PERMISSION_DIAGNOSIS

    for patterns, message in _DIAGNOSIS_PATTERNS:
        if any(p in e for p in patterns):
            return message

    return _FALLBACK_DIAGNOSIS


# ── Mutable state class + per-event handlers ─────────────────────────────


class MonitorState:
    """Mutable in-memory aggregation of events seen so far."""

    def __init__(self) -> None:
        self.pipeline: str | None = None
        self.run_id: str | None = None
        self.params: dict[str, Any] = {}
        self.started_at: float | None = None
        self.ended_at: float | None = None
        self.chunks_total: int = 0
        self.chunks_done: int = 0
        self.chunks_failed: int = 0
        self.active_chunk: str | None = None
        self.active_chunk_started_at: float | None = None
        self.rows_total: int = 0
        self.retries: int = 0
        self.errors: int = 0
        # state_acronym → {"status", "rows", "duration_s", "started_at", "last_seen"}
        self.states: dict[str, dict[str, Any]] = {}
        # Only IBGE-style pipelines (PEVS/PAM) emit state_* events — COMEX/
        # COMTRADE/BCB chunks have no per-UF sweep. Sticky across chunks so the
        # renderer can decide whether the "Chunk states x/27" bar applies at all.
        self.saw_state_events: bool = False
        # Whether any event has carried a row count yet — lets the renderer show
        # "rows ?" instead of a misleading 0 for pipelines that never report rows.
        self.rows_seen: bool = False
        self.recent: deque[tuple[str, str, str]] = deque(maxlen=RECENT_EVENTS)
        self.last_event_at: float | None = None
        # ── ETA fuel ──────────────────────────────────────────────────────
        self.chunk_durations: list[float] = []
        # Sliding window so a slow state long ago doesn't bias the chunk ETA forever.
        self.state_durations: deque[float] = deque(maxlen=STATE_DUR_WINDOW)
        # ── Errors panel ──────────────────────────────────────────────────
        self.error_history: deque[dict[str, Any]] = deque(maxlen=ERROR_HISTORY)

    def apply(self, ev: dict[str, Any]) -> None:
        """Dispatch a single event dict to the appropriate handler."""
        ts = _parse_ts(ev.get("ts", ""))
        evt = ev.get("event", "?")
        self.last_event_at = ts
        summary = _summarize(ev)
        self.recent.append((datetime.fromtimestamp(ts, UTC).strftime("%H:%M:%S"), evt, summary))

        handler = self._handlers.get(evt)
        if handler is not None:
            handler(self, ev, ts)

    # ── Per-event handlers (private, called via dispatch table) ────────

    def _on_pipeline_start(self, ev: dict[str, Any], ts: float) -> None:
        self.pipeline = ev.get("pipeline")
        self.run_id = ev.get("run_id")
        self.params = ev.get("params", {})
        self.started_at = ts
        self.chunks_total = int(ev.get("chunks_total", 0) or 0)

    def _on_chunk_start(self, ev: dict[str, Any], ts: float) -> None:
        self.active_chunk = ev.get("chunk_id")
        self.active_chunk_started_at = ts
        # New chunk → fresh state grid (each chunk is a new sweep of UFs).
        self.states = {}

    def _on_state_start(self, ev: dict[str, Any], ts: float) -> None:
        self.saw_state_events = True
        uf = ev.get("state", "?")
        self.states[uf] = {
            "status": "running",
            "rows": None,
            "duration_s": None,
            "started_at": ts,
            "last_seen": ts,
        }

    def _on_state_end(self, ev: dict[str, Any], ts: float) -> None:
        self.saw_state_events = True
        uf = ev.get("state", "?")
        self.states.setdefault(uf, {"started_at": ts})
        self.states[uf].update(
            status="ok",
            rows=ev.get("rows"),
            duration_s=ev.get("duration_s"),
            last_seen=ts,
        )
        d = ev.get("duration_s")
        if isinstance(d, int | float):
            self.state_durations.append(float(d))

    def _on_state_error(self, ev: dict[str, Any], ts: float) -> None:
        self.saw_state_events = True
        uf = ev.get("state", "?")
        self.states.setdefault(uf, {"started_at": ts})
        err = ev.get("error", "?")
        self.states[uf].update(status="error", error=err, last_seen=ts)
        self.errors += 1
        self.error_history.append({"ts": ts, "kind": "state", "target": uf, "error": str(err)})

    def _on_retry(self, ev: dict[str, Any], ts: float) -> None:
        self.retries += 1
        # Refresh the last_seen of the state so it doesn't go STUCK while retrying.
        uf = ev.get("state")
        if uf and uf in self.states:
            self.states[uf]["last_seen"] = ts

    def _on_ingest_loaded(self, ev: dict[str, Any], ts: float) -> None:
        self.rows_total += int(ev.get("rows", 0) or 0)
        self.rows_seen = True

    def _on_chunk_end(self, ev: dict[str, Any], ts: float) -> None:
        self.chunks_done += 1
        # Not every producer reports rows on chunk_end (ChunkTracker.finish
        # doesn't) — only count + mark rows as known when the field is present.
        if "rows" in ev:
            self.rows_total += int(ev.get("rows", 0) or 0)
            self.rows_seen = True
        d = ev.get("duration_s")
        if isinstance(d, int | float):
            self.chunk_durations.append(float(d))
        self.active_chunk = None
        self.active_chunk_started_at = None

    def _on_chunk_error(self, ev: dict[str, Any], ts: float) -> None:
        self.chunks_failed += 1
        err = ev.get("error", "?")
        chunk_id = ev.get("chunk_id", "?")
        self.errors += 1
        self.error_history.append(
            {"ts": ts, "kind": "chunk", "target": chunk_id, "error": str(err)}
        )
        d = ev.get("duration_s")
        if isinstance(d, int | float):
            # Count failed chunk durations too — they reflect real wall-clock cost.
            self.chunk_durations.append(float(d))
        self.active_chunk = None
        self.active_chunk_started_at = None

    def _on_pipeline_end(self, ev: dict[str, Any], ts: float) -> None:
        self.ended_at = ts

    # Dispatch table — class-level, built once.
    _handlers: ClassVar[dict[str, Any]] = {
        "pipeline_start": _on_pipeline_start,
        "chunk_start": _on_chunk_start,
        "state_start": _on_state_start,
        "state_end": _on_state_end,
        "state_error": _on_state_error,
        "retry": _on_retry,
        "ingest_loaded": _on_ingest_loaded,
        "chunk_end": _on_chunk_end,
        "chunk_error": _on_chunk_error,
        "pipeline_end": _on_pipeline_end,
    }


# ── Event summarisers ────────────────────────────────────────────────────


def _summarize_pipeline_start(ev: dict[str, Any]) -> str:
    p = ev.get("pipeline")
    params = ev.get("params", {}) or {}
    chunks = f"chunks={ev.get('chunks_total', '?')}"
    # Only show the years segment when the pipeline carries a year window (PEVS/PAM/
    # PPM). BCB / COMTRADE emit params without start_year/end_year, so rendering
    # them unconditionally printed a bogus "years=None-None".
    start_year = params.get("start_year")
    end_year = params.get("end_year")
    if start_year is not None or end_year is not None:
        return f"{p} years={start_year}-{end_year} {chunks}"
    return f"{p} {chunks}"


def _summarize_chunk_start(ev: dict[str, Any]) -> str:
    return f"chunk {ev.get('chunk_n', '?')}/{ev.get('chunk_total', '?')} → {ev.get('chunk_id')}"


def _summarize_chunk_end(ev: dict[str, Any]) -> str:
    # `... or 0`, not get(..., 0): a present-but-null scalar (torn/foreign log line)
    # would make dict.get return None and crash the f-string format (OBS-2).
    return (
        f"chunk {ev.get('chunk_id')} ok "
        f"rows={ev.get('rows') or 0:,} {ev.get('duration_s') or 0:.1f}s"
    )


def _summarize_chunk_error(ev: dict[str, Any]) -> str:
    return f"chunk {ev.get('chunk_id')} FAILED {str(ev.get('error', '?'))[:60]}"


def _summarize_state_end(ev: dict[str, Any]) -> str:
    return f"{ev.get('state')} ok rows={ev.get('rows') or 0:,} {ev.get('duration_s') or 0:.1f}s"


def _summarize_state_error(ev: dict[str, Any]) -> str:
    return f"{ev.get('state')} ERROR {str(ev.get('error', ''))[:60]}"


def _summarize_retry(ev: dict[str, Any]) -> str:
    # IBGE retries carry "state" (a UF); COMEX/COMTRADE/BCB carry "series".
    target = ev.get("state") or ev.get("series") or "?"
    return (
        f"retry {target} attempt={ev.get('attempt', '?')} reason={str(ev.get('reason', '?'))[:50]}"
    )


def _summarize_pipeline_end(ev: dict[str, Any]) -> str:
    # The running row total lives in MonitorState.rows_total / the progress bar, NOT on
    # this event — pipeline_run/chunked_run emit duration + chunks_ok/chunks_failed. Show
    # rows only when a producer actually carries rows_total (don't fabricate a rows=0),
    # and the chunk tally otherwise. `... or 0` guards a present-but-null scalar (OBS-1/2).
    parts: list[str] = []
    if ev.get("rows_total") is not None:
        parts.append(f"rows={ev.get('rows_total') or 0:,}")
    ok, failed = ev.get("chunks_ok"), ev.get("chunks_failed")
    if ok is not None or failed is not None:
        parts.append(f"chunks {ok or 0} ok/{failed or 0} failed")
    parts.append(f"dur={ev.get('duration_s') or 0:.1f}s")
    return "done " + " ".join(parts)


_SUMMARIZERS: dict[str, Any] = {
    "pipeline_start": _summarize_pipeline_start,
    "chunk_start": _summarize_chunk_start,
    "chunk_end": _summarize_chunk_end,
    "chunk_error": _summarize_chunk_error,
    "state_end": _summarize_state_end,
    "state_error": _summarize_state_error,
    "retry": _summarize_retry,
    "pipeline_end": _summarize_pipeline_end,
}


def _summarize(ev: dict[str, Any]) -> str:
    """Compress an event dict into a one-line human summary for the recent panel."""
    evt = ev.get("event", "")
    fn = _SUMMARIZERS.get(evt)
    if fn is not None:
        return fn(ev)
    return ", ".join(f"{k}={v}" for k, v in ev.items() if k not in ("ts", "event"))[:80]


# ── ETA computations ─────────────────────────────────────────────────────


def _states_finished_in_chunk(state: MonitorState) -> int:
    return sum(1 for info in state.states.values() if info["status"] in ("ok", "error"))


def _states_running_in_chunk(state: MonitorState) -> int:
    return sum(1 for info in state.states.values() if info["status"] == "running")


def _median(values: list[float] | deque[float]) -> float | None:
    seq = list(values)
    if not seq:
        return None
    return statistics.median(seq)


def _pipeline_eta(state: MonitorState) -> float | None:
    """Avg of completed chunks times remaining chunks. None until we have data."""
    if state.ended_at:
        return 0.0
    if not state.chunk_durations:
        return None
    remaining = max(0, (state.chunks_total or 0) - state.chunks_done - state.chunks_failed)
    if remaining == 0:
        # All chunks accounted for but no pipeline_end yet — assume imminent.
        return None
    avg = sum(state.chunk_durations) / len(state.chunk_durations)
    eta = remaining * avg
    # Subtract whatever the current chunk has already burned (it's part of remaining).
    if state.active_chunk_started_at:
        eta -= time.time() - state.active_chunk_started_at
    return max(eta, 0.0)


def _chunk_eta(state: MonitorState) -> float | None:
    """Per-chunk ETA from median state duration divided by parallel workers.

    Uses a sliding window so a 240s outlier earlier doesn't poison the
    estimate after SIDRA recovers.
    """
    if not state.active_chunk:
        return None
    median = _median(state.state_durations)
    if median is None:
        return None
    finished = _states_finished_in_chunk(state)
    remaining = max(0, STATES_PER_CHUNK - finished)
    if remaining == 0:
        return 0.0
    # Wall-clock model: 4 workers process states in parallel, so completing
    # `remaining` takes ceil(remaining/4) * median, biased optimistically.
    batches = max(1, (remaining + PARALLEL_STATE_FETCHES - 1) // PARALLEL_STATE_FETCHES)
    return batches * median


def _state_eta(info: dict[str, Any], state: MonitorState, now: float) -> float | None:
    """How long the current running state is *expected* to still take."""
    median = _median(state.state_durations)
    if median is None or "started_at" not in info:
        return None
    elapsed = now - info["started_at"]
    return max(0.0, median - elapsed)
