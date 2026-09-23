"""Two-phase (extract→raw→Bronze) pipeline for the foreign price indices.

Shape-identical to :mod:`embrapa_dashboard.bcb.series` on purpose — same raw-zone
archive, same ``(series_code, reference_date_str)`` natural key, same delta rewind —
so the operator story ("ingest, then dbt build") is the same sentence for every
inflation series the project carries.

What is NOT shared with the BCB generic: that one is explicitly scoped to SGS (its
``data``/``valor`` payload, its per-series 404-as-empty behaviour, its year chunking).
Two publishers with different pagination, different response formats and an optional
API key would have to be bent onto ``BcbSeriesSpec`` as a third and fourth knob, which
its own docstring asks callers not to do. The clients normalise to the same two columns
instead, and the ~80 lines below are the price of not owning a four-knob abstraction.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import pandas as pd
from google.cloud import bigquery, storage

from embrapa_dashboard.config import Settings
from embrapa_dashboard.core import land_raw, list_raw, read_raw
from embrapa_dashboard.foreign_inflation import client as api
from embrapa_dashboard.gcp.bigquery import ensure_dataset, latest_reference_date, load_dataframe
from embrapa_dashboard.gcp.clients import resolve_clients

logger = logging.getLogger(__name__)

RAW_SOURCE = "foreign"
RAW_DATASET = "inflation"

# Nominal overlap re-fetched on each delta run. BLS revises seasonally-adjusted CPI
# for up to five years, but CUUR0000SA0 (NOT seasonally adjusted) is never revised
# once published; the ECB does restate HICP occasionally. A whole-year rewind is the
# same strictly-over-fetching floor the BCB inflation pipeline uses.
DELTA_OVERLAP_MONTHS = 12

BRONZE_SCHEMA: list[bigquery.SchemaField] = [
    bigquery.SchemaField("series_code", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("series_name", "STRING", mode="REQUIRED"),
    # Stored, not derived: Silver must never have to guess which API a row came from
    # by pattern-matching the series id, and a second US or euro-area index (core CPI,
    # HICP excluding energy) would make any such pattern wrong on arrival.
    bigquery.SchemaField("provider", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("economy", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("reference_date_str", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("value_str", "STRING", mode="NULLABLE"),
    bigquery.SchemaField("ingestion_timestamp", "TIMESTAMP", mode="REQUIRED"),
]

CLUSTERING_FIELDS = ["series_code", "reference_date_str"]


@dataclass(frozen=True)
class ForeignIndexSpec:
    """One foreign price index: who publishes it, whose prices it measures.

    ``economy`` and ``currency`` are what make the index usable as a DEFLATOR rather
    than just a series: they say which money this index corrects. Nothing downstream
    is allowed to pair an index with a currency it does not name here — that pairing
    is the whole defect this feature exists to fix.
    """

    label: str  # 'CPI' — the id the UI and the dbt pivot use
    provider: str  # 'bls' | 'ecb'
    economy: str  # 'US' | 'EA'
    currency: str  # the currency this index deflates
    code_attr: str  # the Settings field holding the provider's series id
    description: str


FOREIGN_INDICES: tuple[ForeignIndexSpec, ...] = (
    ForeignIndexSpec(
        label="CPI",
        provider="bls",
        economy="US",
        currency="USD",
        code_attr="foreign_inflation_cpi_code",
        description="US CPI-U, all items, US city average, not seasonally adjusted (BLS)",
    ),
    ForeignIndexSpec(
        label="HICP",
        provider="ecb",
        economy="EA",
        currency="EUR",
        code_attr="foreign_inflation_hicp_code",
        description="Euro-area HICP, all items, index 2025=100 (ECB Data Portal)",
    ),
)


def series_code(spec: ForeignIndexSpec, settings: Settings) -> str:
    return str(getattr(settings, spec.code_attr))


def _fetch(spec: ForeignIndexSpec, settings: Settings, start: int, end: int) -> pd.DataFrame:
    code = series_code(spec, settings)
    if spec.provider == "bls":
        return api.fetch_bls_series(
            code, start, end, base_url=settings.bls_api_base_url, api_key=settings.bls_api_key
        )
    if spec.provider == "ecb":
        return api.fetch_ecb_series(code, start, end, base_url=settings.ecb_api_base_url)
    raise ValueError(f"Unknown foreign-inflation provider {spec.provider!r}")


def extract(
    settings: Settings, bq_client: bigquery.Client, table_fqn: str, *, full: bool
) -> pd.DataFrame:
    """Fetch every configured index, tag it, and project the Bronze columns.

    A COLD series (no prior Bronze rows, so this run is its full-window backfill) that
    comes back empty is a misconfiguration — a typo'd or retired series id — and fails
    loudly naming the offender. Reporting success while a deflator stays permanently
    absent is the exact failure mode this feature was built to end: the column would be
    NULL, the screen would say "sem valor nesta convenção", and nothing would say why.
    A WARM series returning empty in delta mode is the benign "nothing new".
    """
    frames: list[pd.DataFrame] = []
    cold_empty: list[str] = []
    for spec in FOREIGN_INDICES:
        code = series_code(spec, settings)
        if not code:
            raise RuntimeError(
                f"{spec.code_attr.upper()} is empty — the {spec.label} deflator has no series id."
            )
        if full:
            start, cold = settings.foreign_inflation_start_year, True
        else:
            last = latest_reference_date(bq_client, table_fqn, code)
            cold = last is None
            start = (
                settings.foreign_inflation_start_year
                if cold
                else max(
                    settings.foreign_inflation_start_year, last.year - (DELTA_OVERLAP_MONTHS // 12)
                )
            )
        end = settings.bcb_end_year
        logger.info(
            "Foreign inflation %s (%s): fetching %d-%d (%s)",
            spec.label,
            spec.provider,
            start,
            end,
            "full" if full else "delta",
        )
        df = _fetch(spec, settings, start, end)
        if df.empty:
            if cold:
                cold_empty.append(f"{spec.label}:{code}")
            continue
        df = df.copy()
        df["series_code"] = code
        df["series_name"] = spec.label
        df["provider"] = spec.provider
        df["economy"] = spec.economy
        df = df.rename(columns={"data": "reference_date_str", "valor": "value_str"})
        frames.append(
            df[
                [
                    "series_code",
                    "series_name",
                    "provider",
                    "economy",
                    "reference_date_str",
                    "value_str",
                ]
            ]
        )
    if cold_empty:
        window = f"{settings.foreign_inflation_start_year}-{settings.bcb_end_year}"
        raise RuntimeError(
            f"No data returned for foreign inflation series {', '.join(cold_empty)} over the "
            f"full backfill window {window}. Check FOREIGN_INFLATION_CPI_CODE / "
            "FOREIGN_INFLATION_HICP_CODE for a typo'd or retired series id."
        )
    if not frames:
        logger.info("Foreign inflation: no new rows since last ingest.")
        return pd.DataFrame()
    # Verbatim: no ingestion_timestamp here — that is a Bronze concept stamped in
    # Phase 2, so the raw archive holds exactly what the publishers returned.
    return pd.concat(frames, ignore_index=True)


def extract_raw(
    settings: Settings,
    *,
    storage_client: storage.Client,
    bq_client: bigquery.Client,
    table_fqn: str,
    full: bool,
) -> str | None:
    """Phase 1: fetch the window and archive it as a run-stamped raw object."""
    df = extract(settings, bq_client, table_fqn, full=full)
    if df.empty:
        return None
    # Label the object by the window actually archived, not the configured one: in delta
    # mode each series fetches only its own recent overlap, and HICP does not exist as
    # far back as CPI, so the configured start year would claim a span the object lacks.
    years = df["reference_date_str"].str[-4:]
    window_start, window_end = years.min(), years.max()
    run_ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    basename = f"{run_ts}_{window_start}_{window_end}"
    land_raw(
        df,
        settings=settings,
        storage_client=storage_client,
        source=RAW_SOURCE,
        dataset=RAW_DATASET,
        basename=basename,
        provenance={
            "source": "foreign-inflation",
            "series": ",".join(f"{s.provider}:{series_code(s, settings)}" for s in FOREIGN_INDICES),
            "window": f"{window_start}-{window_end}",
            "mode": "full" if full else "delta",
        },
    )
    return basename


def bronze_from_raw(
    settings: Settings,
    basenames: list[str],
    *,
    storage_client: storage.Client,
    bq_client: bigquery.Client,
    destination: str,
) -> str:
    """Phase 2: read each raw object, stamp ingestion_timestamp, append to Bronze."""
    for basename in basenames:
        df = read_raw(
            storage_client,
            settings=settings,
            source=RAW_SOURCE,
            dataset=RAW_DATASET,
            basename=basename,
        )
        df["ingestion_timestamp"] = pd.Timestamp.now(tz=UTC)
        load_dataframe(
            bq_client,
            df,
            destination,
            BRONZE_SCHEMA,
            time_partitioning_field="ingestion_timestamp",
            clustering_fields=CLUSTERING_FIELDS,
        )
    return destination


def run(settings: Settings, *, full: bool = False, from_raw: bool = False) -> str:
    """Extract→raw (Phase 1) then raw→Bronze (Phase 2). Returns destination, or ``""``."""
    bq_client, storage_client = resolve_clients(settings)
    dataset_id = f"{settings.gcp_project_id}.{settings.bq_bronze_foreign_dataset}"
    ensure_dataset(bq_client, dataset_id, settings.bq_location)
    destination = f"{dataset_id}.{settings.bq_bronze_foreign_inflation_table}"

    if from_raw:
        basenames = list_raw(
            storage_client, settings=settings, source=RAW_SOURCE, dataset=RAW_DATASET
        )
        if not basenames:
            logger.info("Foreign inflation --from-raw: no raw archived.")
            return ""
    else:
        basename = extract_raw(
            settings,
            storage_client=storage_client,
            bq_client=bq_client,
            table_fqn=destination,
            full=full,
        )
        if basename is None:
            return ""
        basenames = [basename]

    return bronze_from_raw(
        settings,
        basenames,
        storage_client=storage_client,
        bq_client=bq_client,
        destination=destination,
    )
