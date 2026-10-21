"""HTTP client for the MDIC Comex Stat bulk CSV files.

This is a *file downloader*, not a JSON API client: each call fetches one
per-year, per-flow CSV (``EXP_<year>.csv`` / ``IMP_<year>.csv``, ``;``-separated,
latin-1, history since 1997) and filters it down to the configured products
locally. Two deliberate departures from the BCB/IBGE clients, both forced by
the file sizes (tens to hundreds of MB):

1. **Stream to disk, not memory.** ``core_http.get_drained`` buffers the whole
   body in RAM — fine for small JSON payloads, wrong for a 100 MB CSV. So the
   download here streams ``iter_content`` straight to a temp file under its own
   wall-clock deadline, reusing only the shared retry *policy*.
2. **Chunked parse + early column filter.** ``pandas.read_csv(chunksize=...)``
   keeps memory bounded while we keep only rows whose ``CO_NCM`` matches a
   configured 8-digit code or whose first two digits match a configured HS
   chapter. The filter is column-precise on ``CO_NCM`` on purpose: a substring
   match on the raw line would false-match e.g. country code ``445`` for
   chapter ``44``.

Shape confirmed live (2026-05-30) against EXP/IMP_{1997,2023,2026}: EXP has 11
columns; IMP adds ``VL_FRETE`` and ``VL_SEGURO``. The two schemas are unioned
(:data:`SOURCE_COLUMNS`) so export rows simply carry NULL for the two
import-only columns.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import os
import tempfile
import time
from io import BytesIO
from pathlib import Path

import certifi
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

from embrapa_dashboard import observability
from embrapa_dashboard.comex._ca import SECTIGO_INTERMEDIATE_PEM, SERPRO_INTERMEDIATE_PEM
from embrapa_dashboard.core import SourceTransientError
from embrapa_dashboard.core import http as core_http

logger = logging.getLogger(__name__)

# Export columns (11). Import is a strict superset adding the two below.
EXP_COLUMNS: list[str] = [
    "CO_ANO",
    "CO_MES",
    "CO_NCM",
    "CO_UNID",
    "CO_PAIS",
    "SG_UF_NCM",
    "CO_VIA",
    "CO_URF",
    "QT_ESTAT",
    "KG_LIQUIDO",
    "VL_FOB",
]
IMP_ONLY_COLUMNS: list[str] = ["VL_FRETE", "VL_SEGURO"]
# Union schema every Bronze row is reindexed onto: export rows get NULL for the
# two import-only columns.
SOURCE_COLUMNS: list[str] = [*EXP_COLUMNS, *IMP_ONLY_COLUMNS]

# Logical flow → file-name prefix. Also the closed domain accepted in .env.
FILE_PREFIX: dict[str, str] = {"export": "EXP", "import": "IMP"}

# Per-attempt wall-clock ceiling for one file download. A ~100 MB file over a
# slow link can legitimately take minutes; this only guards against a
# slow-byte hang (1 byte every <read-timeout seconds) stranding the worker.
DOWNLOAD_DEADLINE_S: float = 1200.0
# Cumulative ceiling across all retries for one file — keeps a single stuck
# file from blocking the whole multi-year ingest indefinitely.
RETRY_TOTAL_DEADLINE_S: float = 3600.0
# Rows per pandas read chunk while filtering — bounds memory on huge files.
PARSE_CHUNK_ROWS: int = 200_000


_ca_bundle_path: str | None = None


def _ca_bundle() -> str:
    """Path to a CA bundle = certifi + the vendored intermediates.

    Both Comex hosts omit their issuing intermediate from the TLS handshake, so
    plain certifi verification fails (see :mod:`embrapa_dashboard.comex._ca`).
    Appending the intermediates to certifi's roots lets ``requests`` verify
    without ever disabling TLS checks. Built once and cached for the process.
    """
    global _ca_bundle_path
    if _ca_bundle_path and os.path.exists(_ca_bundle_path):
        return _ca_bundle_path
    base = Path(certifi.where()).read_text(encoding="utf-8")
    fd, path = tempfile.mkstemp(prefix="comex_ca_", suffix=".pem")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(base)
        fh.write("\n")
        fh.write(SECTIGO_INTERMEDIATE_PEM)
        fh.write("\n")
        fh.write(SERPRO_INTERMEDIATE_PEM)
    _ca_bundle_path = path
    # Best-effort cleanup at interpreter exit so the (public-cert) temp PEM doesn't
    # linger after the process ends (COMEX-2). Created at most once per process; the OS
    # would reclaim it on container exit anyway — this just keeps a long-lived dev shell tidy.
    atexit.register(_unlink_quietly, path)
    return path


def _unlink_quietly(path: str) -> None:
    """Delete a temp file, swallowing the error if it's already gone (atexit handler)."""
    with contextlib.suppress(OSError):
        os.unlink(path)


class ComexRequestError(Exception):
    """Non-200 response from the Comex Stat file host (base class)."""


class ComexTransientError(ComexRequestError, SourceTransientError):
    """Transient (retryable) error: 5xx/408/429 or a slow-byte download hang."""


def _head_retry_url(args: tuple, kwargs: dict) -> str:
    """Rebuild the probed file URL for a ``head_source(base_url, flow, year)`` retry.

    ``args[0]`` is only the *base* URL, so the file URL must be rebuilt from
    ``(flow, year)`` or every freshness probe would be misattributed to the base
    path's last segment (one bogus ``ncm`` series)."""
    base_url = args[0] if len(args) > 0 else kwargs.get("base_url", "?")
    flow = args[1] if len(args) > 1 else kwargs.get("flow", "?")
    year = args[2] if len(args) > 2 else kwargs.get("year", "?")
    try:
        return file_url(str(base_url), str(flow), year)
    except KeyError:  # unknown flow — fall back to the base URL
        return str(base_url)


def _emit_retry(retry_state):  # type: ignore[no-untyped-def]
    """Tenacity ``before_sleep`` hook: surface retries in ``embrapa monitor``.

    Wired to two retried functions with different signatures:
    :func:`_download_to_disk(url, dest)` and :func:`head_source(base_url, flow,
    year)`.
    """
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    args = retry_state.args or ()
    kwargs = retry_state.kwargs or {}
    is_head = getattr(getattr(retry_state, "fn", None), "__name__", "") == "head_source"
    if is_head:
        op = "HEAD"
        url = _head_retry_url(args, kwargs)
    else:
        op = "download"
        url = args[0] if args else kwargs.get("url", "?")
    observability.emit(
        "retry",
        series=str(url).rsplit("/", 1)[-1],  # the EXP_2023.csv basename
        window="",
        attempt=retry_state.attempt_number,
        reason=str(exc)[:200] if exc else "?",
    )
    logger.warning(
        "Retrying Comex %s url=%s attempt=%d: %s",
        op,
        url,
        retry_state.attempt_number,
        exc,
    )


@core_http.http_retry_policy(
    transient_exc=ComexTransientError,
    deadline_s=RETRY_TOTAL_DEADLINE_S,
    max_attempts=3,
    before_sleep=_emit_retry,
)
def _download_to_disk(url: str, dest_path: str) -> None:
    """Stream one CSV to ``dest_path`` under a wall-clock deadline.

    Raises :class:`ComexTransientError` on retryable HTTP status or a slow-byte
    hang, :class:`ComexRequestError` on a permanent 4xx (e.g. 404 for a year
    that doesn't exist yet).
    """
    # Start the wall-clock budget BEFORE issuing the request so it also bounds
    # the TLS handshake / header trickle, not just the post-200 body stream.
    deadline = time.monotonic() + DOWNLOAD_DEADLINE_S
    logger.info("Comex download %s", url)
    with requests.get(
        url,
        stream=True,
        timeout=core_http.DEFAULT_TIMEOUT,
        headers=core_http.DEFAULT_HEADERS,
        verify=_ca_bundle(),
    ) as response:
        # A slow handshake / header trickle can already blow the budget before
        # the first byte of body — fail here too, not only inside the loop.
        if time.monotonic() > deadline:
            raise ComexTransientError(
                f"download exceeded {DOWNLOAD_DEADLINE_S}s total budget "
                f"(slow handshake/headers) for {url}"
            )
        if response.status_code != 200:
            msg = f"HTTP {response.status_code} for {url}"
            if response.status_code in core_http.RETRYABLE_STATUS_CODES:
                raise ComexTransientError(msg)
            raise ComexRequestError(msg)
        with open(dest_path, "wb") as fh:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if time.monotonic() > deadline:
                    raise ComexTransientError(
                        f"download exceeded {DOWNLOAD_DEADLINE_S}s total budget "
                        f"(slow-byte hang) for {url}"
                    )
                if chunk:
                    fh.write(chunk)


def file_url(base_url: str, flow: str, year: int) -> str:
    """The Comex Stat CSV URL for one ``(flow, year)`` — ``{base}/{EXP|IMP}_{year}.csv``."""
    return f"{base_url.rstrip('/')}/{FILE_PREFIX[flow]}_{year}.csv"


@core_http.http_retry_policy(
    transient_exc=ComexTransientError,
    deadline_s=120.0,
    max_attempts=3,
    before_sleep=_emit_retry,
)
def head_source(base_url: str, flow: str, year: int) -> dict[str, str]:
    """HEAD a ``(flow, year)`` file and return its provenance headers.

    Returns ``{source_url, source_etag?, source_last_modified?,
    source_content_length?}`` — the freshness fingerprint a two-phase sync
    compares against the archived raw object's stored provenance to decide
    whether to re-download. Raises like :func:`_download_to_disk` on HTTP error.
    """
    url = file_url(base_url, flow, year)
    response = requests.head(
        url,
        timeout=core_http.DEFAULT_TIMEOUT,
        headers=core_http.DEFAULT_HEADERS,
        allow_redirects=True,
        verify=_ca_bundle(),
    )
    if response.status_code != 200:
        msg = f"HTTP {response.status_code} (HEAD) for {url}"
        if response.status_code in core_http.RETRYABLE_STATUS_CODES:
            raise ComexTransientError(msg)
        raise ComexRequestError(msg)
    provenance = {"source_url": url}
    for header, key in (
        ("ETag", "source_etag"),
        ("Last-Modified", "source_last_modified"),
        ("Content-Length", "source_content_length"),
    ):
        value = response.headers.get(header)
        if value:
            provenance[key] = value
    return provenance


def _csv_to_parquet(csv_path: str, parquet_path: str) -> int:
    """Convert a Comex CSV to Parquet in chunks (memory-bounded). Returns row count.

    Verbatim: every column STRING, every row, no filtering — this is the raw
    archive. Streaming via ``ParquetWriter`` keeps peak memory at one chunk even
    for the ~1.5M-row full-year files.
    """
    writer: pq.ParquetWriter | None = None
    rows = 0
    try:
        reader = pd.read_csv(
            csv_path, sep=";", encoding="latin-1", dtype=str, chunksize=PARSE_CHUNK_ROWS
        )
        for chunk in reader:
            table = pa.Table.from_pandas(chunk, preserve_index=False)
            if writer is None:
                writer = pq.ParquetWriter(parquet_path, table.schema, compression="snappy")
            writer.write_table(table)
            rows += len(chunk)
    except pd.errors.EmptyDataError as exc:
        # A truly-empty (0-byte) download — a transient empty 200, or a slow-byte abort
        # that truncated the stream to zero before the per-attempt deadline fired —
        # yields "no columns to parse". EmptyDataError is a plain ValueError (not a
        # RequestException), so the download retry policy would NOT catch it and the
        # chunk would be recorded as a HARD failure (exit 1 / alert). Reclassify it as a
        # transient so continue-on-failure carries the run and the NEXT SCHEDULED RUN
        # re-attempts the chunk (COMEX-1). Note: this does NOT trigger an in-run tenacity
        # retry — extract_to_parquet is undecorated and only _download_to_disk carries
        # http_retry_policy; an immediate retry would re-truncate identically anyway. A
        # header-only CSV (valid 0-row) parses fine and never reaches here.
        raise ComexTransientError(
            f"empty Comex CSV ({csv_path}) — no columns to parse, likely a "
            "truncated/empty download; will retry"
        ) from exc
    finally:
        if writer is not None:
            writer.close()
    return rows


def extract_to_parquet(base_url: str, flow: str, year: int, parquet_path: str) -> int:
    """Phase 1: download one ``(flow, year)`` CSV and write it verbatim to Parquet.

    Returns the row count. The CSV is streamed to a temp file, then converted to
    Parquet in chunks, so neither step holds the whole file in memory.
    """
    fd, csv_path = tempfile.mkstemp(prefix=f"comex_{FILE_PREFIX[flow]}_{year}_", suffix=".csv")
    os.close(fd)
    try:
        _download_to_disk(file_url(base_url, flow, year), csv_path)
        return _csv_to_parquet(csv_path, parquet_path)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(csv_path)


def filter_products(
    raw_parquet: bytes,
    ncm_codes: set[str],
    chapter_codes: set[str],
    heading_codes: set[str] | None = None,
) -> pd.DataFrame:
    """Phase 2: filter a raw Parquet (all NCMs) to the configured products.

    A row is kept when ``CO_NCM`` is in ``ncm_codes`` (exact 8-digit), or its
    first FOUR digits are in ``heading_codes`` (HS heading, e.g. 4403 madeira),
    or its first TWO digits are in ``chapter_codes`` (whole HS chapter). All three
    are column-precise on ``CO_NCM`` — a substring match on the raw line would
    false-hit e.g. country code 445 for chapter 44. Streams via ``iter_batches``
    so memory stays bounded. Returns a frame with exactly :data:`SOURCE_COLUMNS`
    (import-only columns NULL for export files).
    """
    heading_codes = heading_codes or set()
    parquet_file = pq.ParquetFile(BytesIO(raw_parquet))
    frames: list[pd.DataFrame] = []
    for batch in parquet_file.iter_batches(batch_size=PARSE_CHUNK_ROWS):
        chunk = batch.to_pandas()
        ncm = chunk["CO_NCM"].astype(str)
        mask = (
            ncm.isin(ncm_codes) | ncm.str[:4].isin(heading_codes) | ncm.str[:2].isin(chapter_codes)
        )
        selected = chunk[mask]
        if not selected.empty:
            frames.append(selected)
    if not frames:
        return pd.DataFrame(columns=SOURCE_COLUMNS)
    return pd.concat(frames, ignore_index=True).reindex(columns=SOURCE_COLUMNS)
