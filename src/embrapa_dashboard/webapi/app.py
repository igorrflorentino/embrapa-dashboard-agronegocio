"""Flask app factory for the dashboard's REST layer + SPA host.

One Cloud Run service serves both the built React SPA (the design-system
prototype) and the ``/api`` JSON endpoints — same origin, so no CORS, and the
single IAP in front protects everything. In dev, Vite serves the SPA on :5173
and proxies ``/api`` here (:8000), so this app is API-only locally.

gunicorn entrypoint: ``embrapa_dashboard.webapi.app:app``.
"""

from __future__ import annotations

import datetime
import decimal
import logging
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, jsonify, send_from_directory
from flask.json.provider import DefaultJSONProvider

from embrapa_dashboard.serving.cache import init_cache_safely

from .routes import api

logger = logging.getLogger(__name__)


def _json_safe(obj):
    """Coerce non-JSON-native scalars to JSON-safe values, recursively.

    Backend reads round-trip through pandas DataFrames (gateway.run_query →
    .to_dataframe → .to_dict), so numpy scalars (numpy.integer / numpy.floating /
    numpy.bool_) and date/datetime/pandas.Timestamp can reach serialization. The
    stdlib json encoder rejects all of those (numpy.integer/bool_ and datetimes
    are not JSON-serializable; a bare NaN/Inf float serializes to an invalid `NaN`
    literal that JSON.parse rejects). Normalizing here guarantees every endpoint
    emits spec-valid JSON instead of 500-ing on an un-coerced field (e.g.
    /source-meta maturityDate/cobertura).
    """
    # pandas missing-value singletons (pd.NA from a nullable Int64/boolean column, pd.NaT
    # from a nullable date/timestamp) reach here from BigQuery NULLs in non-float columns —
    # the raw-table inspection (/api/table) is the first endpoint that surfaces them. They
    # are NOT float NaN: the json encoder rejects pd.NA (500) and pd.NaT.isoformat() would
    # leak the string "NaT". Map both to JSON null. (`is` is exact + array-safe.)
    if obj is pd.NA or obj is pd.NaT:
        return None
    # numpy.bool_ next: it is NOT a subclass of float/int, so it must be caught before
    # the numeric branches (Python bool is the JSON-native fall-through).
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    # decimal.Decimal (a BigQuery NUMERIC/BIGNUMERIC column materializes as one in
    # df.values.tolist() — the raw-table inspector) is not a float subclass, so the
    # stdlib encoder would 500 on it. Coerce to float and fall through to the NaN/Inf
    # guard (a NUMERIC NaN is then mapped to null too). No Gold/serving column is
    # NUMERIC today, so this is cheap latent insurance (JSON-1).
    if isinstance(obj, (np.floating, decimal.Decimal)):
        obj = float(obj)  # fall through to the NaN/Inf check below
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    # pandas.Timestamp is a datetime subclass, so datetime covers it too.
    if isinstance(obj, (datetime.date, datetime.datetime)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


class SafeJSONProvider(DefaultJSONProvider):
    """App JSON provider that sanitizes NaN/Inf → null before serializing."""

    ensure_ascii = False  # keep pt-BR accents readable on the wire

    def dumps(self, obj, **kwargs):
        return super().dumps(_json_safe(obj), **kwargs)


def _spa_dir() -> Path | None:
    """Where the built SPA (``frontend/dist``) lives. The prod image sets
    ``SPA_DIST_DIR``; in a dev repo it defaults to ``<repo>/frontend/dist`` if a
    build exists (else None → API-only, which is the normal dev setup)."""
    env = os.environ.get("SPA_DIST_DIR")
    if env:
        p = Path(env)
        return p if p.is_dir() else None
    candidate = Path(__file__).resolve().parents[3] / "frontend" / "dist"
    return candidate if candidate.is_dir() else None


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.json = SafeJSONProvider(app)

    # Bound the request body so a POST endpoint (/municipio-yearly, the curation
    # writers) can't buffer an arbitrarily large payload before the handler runs;
    # Flask returns 413 for an oversize body. 1 MiB comfortably fits the largest
    # legitimate body (the município code list, itself capped at _MAX_MUNICIPIO_CODES)
    # while closing the defense-in-depth gap behind IAP. Defense in depth, not the
    # primary guard — IAP gates the front and gunicorn/Cloud Run impose their own limits.
    app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024

    # flask-caching needs GCP settings (project/dataset/TTLs). Best-effort so the
    # module still imports for lint/tests without a configured .env; at runtime
    # (Cloud Run / dev with .env) it binds and the gateway memoization works.
    # init_cache_safely binds a no-op NullCache if settings/binding fail, so the
    # cache is ALWAYS present — a misconfigured env (e.g. a fresh worktree with no
    # .env) then surfaces the REAL error from the data endpoints (uncached) instead
    # of a cryptic `KeyError: 'cache'` from an unbound cache. See serving/cache.py.
    init_cache_safely(app)

    app.register_blueprint(api, url_prefix="/api")

    @app.get("/healthz")
    def healthz():
        return jsonify(status="ok")

    @app.route("/api", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    @app.route("/api/<path:_unmatched>", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    def api_not_found(_unmatched: str = ""):
        # Unknown /api path → machine-readable JSON 404, never the SPA's
        # index.html with HTTP 200 (the SPA fetch layer checks r.ok then
        # r.json(), so an HTML 200 burns its retry budget on parse errors).
        # Werkzeug ranks the blueprint's static rules above this path-converter
        # rule, so every registered /api endpoint still wins.
        return jsonify(error="rota da API não encontrada", code=404), 404

    spa = _spa_dir()
    if spa is not None:
        logger.info("Serving SPA from %s", spa)

        @app.get("/")
        @app.get("/<path:path>")
        def spa_catchall(path: str = ""):
            # Serve a real static asset if it exists; otherwise hand back
            # index.html so the client-side router (deep-links like ?v=&b=) loads.
            if path and (spa / path).is_file():
                return send_from_directory(spa, path)
            # index.html is the unhashed entrypoint. It references the JS bundle by
            # content hash and the static CSS by a ?v=<version> query, so a stale
            # cached index.html would pin the browser to the OLD css/js and any
            # ?v= bump would never take effect. Force revalidation on every load.
            resp = send_from_directory(spa, "index.html")
            resp.headers["Cache-Control"] = "no-cache"
            return resp

    return app


app = create_app()
