"""Shared pytest fixtures.

Centralizes the one isolation hazard several suites repeat by hand: ``Settings``
reads ``.env`` at repo root (``config.Settings.model_config env_file=".env"``),
and the documented dev setup (``cp .env.example .env``) puts a real one there. A
test that constructs ``Settings(...)`` without ``_env_file=None`` therefore reads
whatever the developer happens to have in ``.env`` / their shell, which makes
default-dependent assertions flaky. ``settings_factory`` builds an isolated
``Settings`` (``_env_file=None``) so new tests can opt in without re-deriving the
trick.
"""

from __future__ import annotations

import pathlib

import pytest


@pytest.fixture
def settings_factory():
    """Return a builder for env-isolated ``Settings`` (never reads ``.env``)."""
    from embrapa_dashboard.config import Settings

    def _build(**overrides):
        overrides.setdefault("gcp_project_id", "test-project")
        return Settings(_env_file=None, **overrides)

    return _build


@pytest.fixture(autouse=True)
def _no_real_heartbeat_writes(monkeypatch):
    """No test may write an ingest heartbeat to the real warehouse.

    `_tracked_run` (cli.py) records one heartbeat per ingest run, so every test that
    exercises an ingest command reaches `ingestion_heartbeat.record` — which, with a
    developer's ADC present, happily INSERTed into production `research_inputs`. It did:
    a full `pytest` run left ~a dozen rows there, all `duration_s=0.0`, which then made
    `doctor` report "every scheduled ingest ran" off the back of the test suite.

    Patching `_bq_client` (not `record`) is deliberate: it neutralises only the path that
    resolves a REAL client, so `record`'s own logic still runs and stays testable — the
    heartbeat tests inject their own client and are untouched by this.
    """
    from unittest.mock import MagicMock

    from embrapa_dashboard import ingestion_heartbeat

    monkeypatch.setattr(ingestion_heartbeat, "_bq_client", lambda *a, **k: MagicMock())


@pytest.fixture(autouse=True)
def _no_live_comex_gap_lookup(monkeypatch):
    """No test may reach BigQuery through the COMEX value-gap lookup.

    Since v1.78/v1.79 every COMEX read under a non-US$ convention first asks the monthly
    mart's SCHEMA whether it carries the column, then which months it cannot value — and
    `seam.snapshot` does it on EVERY COMEX call, where a dozen seam tests stub only the
    readers they know. An empty schema means "no column, no gap", so no query follows. A
    test that exercises the gap stubs `fetch_comex_seasonality_columns` itself.
    """
    try:
        from embrapa_dashboard.serving import gateway
    except ImportError:  # the webapi extra (flask-caching) is not installed
        return
    monkeypatch.setattr(gateway, "fetch_comex_seasonality_columns", lambda: frozenset())


@pytest.fixture(autouse=True)
def _no_live_currency_eras(monkeypatch, request):
    """`seam.snapshot` must not reach BigQuery for the currency-reform boundaries.

    The read-side twin of `_no_real_heartbeat_writes`, and it appeared the same way:
    `value_era_breaks` (v1.49.0) is called from every `seam.snapshot()`, and the seam
    tests monkeypatch the fetchers they KNOW about — a new one falls through to a live
    query the moment a developer has ADC. `make test` advertises itself as credential-free
    and it stopped being so silently, because `value_era_breaks` swallows the failure by
    design (a comparability HINT must never break the snapshot). CI, having no credentials,
    took the swallowed path and reported the lines as uncovered; the laptop, having ADC,
    reported them green. Same code, opposite verdicts.

    The fixture serves the REAL seed — `dbt/seeds/historical_currency_factors.csv`, the very
    file dbt loads — so the stub cannot drift from what Silver divides by. A test that wants
    a different roster still overrides it.
    """
    # Escape para o teste que precisa exercitar o LEITOR de verdade (ele injeta o seu
    # próprio run_query, então continua sem tocar o BigQuery).
    if request.node.get_closest_marker("real_currency_eras"):
        return

    import csv

    import pandas as pd

    seed = pathlib.Path(__file__).resolve().parents[1] / "dbt/seeds/historical_currency_factors.csv"
    with seed.open(encoding="utf-8") as fh:
        linhas = [
            {
                "unit_of_measure": r["unit_of_measure"],
                "year_from": int(r["year_from"]),
                "year_to": int(r["year_to"]),
            }
            for r in csv.DictReader(fh)
        ]
    eras = pd.DataFrame(linhas)

    try:
        from embrapa_dashboard.serving import gateway
    except Exception:  # optional extra not installed — nothing to guard
        return
    monkeypatch.setattr(gateway, "fetch_currency_eras", lambda: eras)
