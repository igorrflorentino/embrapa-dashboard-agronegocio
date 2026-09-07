"""Coverage tests for the FROZEN Engenharia de Atributos feature.

Targets the currently-uncovered branches in the seam readers
(``webapi/seam_attribute_engineering.py``) and the serving writers
(``serving/attribute_engineering.py``):

  * seam: the empty-DataFrame degrade paths of ``attribute_editor_emails`` /
    ``_current_code_levels`` (and the latter's success row-mapping), the
    commodity-scope ``continue`` in ``_value_added_codes_by_level``, the
    empty-value ``continue`` in ``_value_added_accumulate``, and the seed-driven
    ``market_nature`` analysis (now backed by ``gateway.fetch_market_nature_series``).
  * serving: the industrialization-level validation raise
    (``_validate_code_edit``) and the ``market_nature_series`` SQL builder.

The gateway readers are monkeypatched with synthetic DataFrames — no live
warehouse. Reuses the house pattern ``pytest.importorskip('flask_caching')``.
"""

from __future__ import annotations

import pandas as pd
import pytest


def _curation():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam_attribute_engineering

    return seam_attribute_engineering


def _writer():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.serving import attribute_engineering

    return attribute_engineering


# ── seam line 64: attribute_editor_emails returns empty set on an empty DataFrame ────────


def test_attribute_editor_emails_empty_when_table_empty(monkeypatch):
    seam = _curation()
    # The allowlist table EXISTS (no NotFound) but holds no rows → empty set, which
    # makes routes fall back to "any IAP-authenticated caller may curate".
    monkeypatch.setattr(seam.gateway, "fetch_attribute_editors", lambda: pd.DataFrame())
    assert seam.attribute_editor_emails() == set()


def test_attribute_editor_emails_empty_when_none(monkeypatch):
    seam = _curation()
    monkeypatch.setattr(seam.gateway, "fetch_attribute_editors", lambda: None)
    assert seam.attribute_editor_emails() == set()


# ── seam lines 78-80: _current_code_levels empty + success row mapping ──────────


def test_current_code_levels_empty_when_view_empty(monkeypatch):
    seam = _curation()
    # The SCD2 view exists (no NotFound) but is empty → {} (worklist still renders).
    monkeypatch.setattr(
        seam.gateway, "fetch_current_code_industrialization", lambda: pd.DataFrame()
    )
    assert seam._current_code_levels() == {}


def test_current_code_levels_maps_rows_to_levels(monkeypatch):
    seam = _curation()
    df = pd.DataFrame(
        [
            {"source": "mdic_comex", "code": "0801", "industrialization_level": "processada"},
            {"source": "ibge_pevs", "code": 5, "industrialization_level": "bruta"},
        ]
    )
    monkeypatch.setattr(seam.gateway, "fetch_current_code_industrialization", lambda: df)
    out = seam._current_code_levels()
    # Codes are stringified (note ibge_pevs code 5 -> "5").
    assert out == {("mdic_comex", "0801"): "processada", ("ibge_pevs", "5"): "bruta"}


# ── seam line 173: _value_added_codes_by_level skips out-of-scope codes ─────────


def test_value_added_codes_by_level_drops_out_of_scope_code(monkeypatch):
    seam = _curation()
    from embrapa_dashboard.webapi import seam_base

    # Two classified COMEX codes; the commodity scope only includes "A" → "B" is
    # dropped via the `scope is not None and code not in scope` continue (line 173).
    monkeypatch.setattr(
        seam,
        "_current_code_levels",
        lambda: {("mdic_comex", "A"): "commodity_pura", ("mdic_comex", "B"): "commodity_pura"},
    )
    monkeypatch.setattr(seam_base, "_codes", lambda cid, src: ["A"])  # scope = {"A"}

    by_level = seam._value_added_codes_by_level("castanha")
    # Only present levels are returned; "B" is excluded by the scope filter.
    assert by_level == {"commodity_pura": ["A"]}


# ── seam line 196: _value_added_accumulate skips a level whose value is empty ────


def test_value_added_accumulate_skips_level_with_empty_value(monkeypatch):
    seam = _curation()
    from embrapa_dashboard.webapi import seam_base

    calls = []

    def fake_xyear(metric, codes, uf_codes=()):
        calls.append(metric)
        # exp_value returns empty → the level is skipped at line 196 BEFORE the
        # exp_weight query ever runs (so no exp_weight call is recorded).
        return {}

    monkeypatch.setattr(seam_base, "_xyear", fake_xyear)

    acc, n = seam._value_added_accumulate({"commodity_pura": ["A"]})
    assert acc == {} and n == 0
    # Only the value query ran; the `continue` short-circuited the weight query.
    assert calls == ["mdic_comex:exp_value"]


def test_value_added_returns_empty_when_value_query_empty(monkeypatch):
    """End-to-end: value_added surfaces an empty series when the export-value
    reader yields nothing for the classified level (the line-196 path)."""
    seam = _curation()
    from embrapa_dashboard.webapi import seam_base

    monkeypatch.setattr(
        seam, "_current_code_levels", lambda: {("mdic_comex", "A"): "commodity_pura"}
    )
    monkeypatch.setattr(seam_base, "_xyear", lambda metric, codes, uf_codes=(): {})
    out = seam.value_added()
    assert out == {
        "series": [],
        "levels": [],
        "premium": None,  # sem dois níveis com preço, o prêmio NÃO EXISTE (v1.54.0)
        "predominant": None,
        "n_codes": 0,
    }


# ── seam market_nature: analysis over serving_comtrade_annual.market_nature ──────
# The market_nature column is edit-driven again (dim_flow_market_scd2 LEFT JOINed at build
# time). This analysis just sums that mart column via gateway.fetch_market_nature_series;
# the editable-log path (matrix editor) is covered in test_webapi_seam / test_webapi_routes.


def test_market_nature_empty_when_reader_returns_none(monkeypatch):
    """The gateway reader returning None (or an empty frame) degrades to an empty
    series rather than raising — mirrors the value_added empty path."""
    seam = _curation()
    monkeypatch.setattr(seam.gateway, "fetch_market_nature_series", lambda codes=(): None)
    assert seam.market_nature() == {"years": [], "series": [], "latest": {}}


def test_market_nature_empty_when_reader_returns_empty_df(monkeypatch):
    seam = _curation()
    monkeypatch.setattr(seam.gateway, "fetch_market_nature_series", lambda codes=(): pd.DataFrame())
    assert seam.market_nature() == {"years": [], "series": [], "latest": {}}


def test_market_nature_accumulates_series_from_mart(monkeypatch):
    """Rows (reference_year, market_nature, value_usd) are summed into the
    {consumo, processamento} series, scaled to US$ bi, with `latest` = last year."""
    seam = _curation()
    df = pd.DataFrame(
        [
            {"reference_year": 2020, "market_nature": "consumo", "value_usd": 2e9},
            {"reference_year": 2020, "market_nature": "processamento", "value_usd": 1e9},
            {"reference_year": 2021, "market_nature": "consumo", "value_usd": 3e9},
        ]
    )
    monkeypatch.setattr(seam.gateway, "fetch_market_nature_series", lambda codes=(): df)
    out = seam.market_nature()
    assert out["years"] == [2020, 2021]
    assert out["series"] == [
        {"y": 2020, "consumo": 2.0, "processamento": 1.0},
        {"y": 2021, "consumo": 3.0, "processamento": 0.0},
    ]
    assert out["latest"] == {"y": 2021, "consumo": 3.0, "processamento": 0.0}


def test_market_nature_scoped_commodity_without_codes_returns_empty(monkeypatch):
    """A commodity with no COMTRADE (HS) codes short-circuits to empty, never
    hitting the unscoped all-commodities total."""
    seam = _curation()
    from embrapa_dashboard.webapi import seam_base

    monkeypatch.setattr(seam_base, "_codes", lambda cid, src: [])
    called = {"reader": False}

    def _reader(codes=()):
        called["reader"] = True
        return pd.DataFrame()

    monkeypatch.setattr(seam.gateway, "fetch_market_nature_series", _reader)
    assert seam.market_nature("castanha") == {"years": [], "series": [], "latest": {}}
    assert called["reader"] is False  # short-circuited before the reader


def test_market_nature_scoped_commodity_passes_codes(monkeypatch):
    """A scoped commodity forwards its HS codes to the gateway reader."""
    seam = _curation()
    from embrapa_dashboard.webapi import seam_base

    monkeypatch.setattr(seam_base, "_codes", lambda cid, src: ["0801", "0802"])
    seen: dict = {}

    def _reader(codes=()):
        seen["codes"] = codes
        return pd.DataFrame(
            [{"reference_year": 2022, "market_nature": "consumo", "value_usd": 5e9}]
        )

    monkeypatch.setattr(seam.gateway, "fetch_market_nature_series", _reader)
    out = seam.market_nature("castanha")
    assert seen["codes"] == ("0801", "0802")
    assert out["latest"] == {"y": 2022, "consumo": 5.0, "processamento": 0.0}


# ── writer: _validate_code_edit rejects an over-length industrialization level ────


def test_validate_code_edit_rejects_long_level():
    curation = _writer()
    too_long = "x" * (curation.MAX_STAGE_LEN + 1)
    with pytest.raises(ValueError, match="industrialization_level excede"):
        curation._validate_code_edit("mdic_comex", "0801", too_long, None)


# ── serving/sql: market_nature_series builds the grouped-sum query + code param ──


def test_market_nature_series_sql_unscoped():
    from embrapa_dashboard.serving import sql as sqlbuild

    query, params = sqlbuild.market_nature_series("proj.serving.serving_comtrade_annual")
    low = query.lower()
    assert "market_nature is not null" in low
    assert "sum(val_yearfx_usd) as value_usd" in low
    assert "group by market_nature, reference_year" in low
    # Sums only export/import (re-export/re-import are subsets → no double-count).
    assert "flow in unnest(@__sum_flows)" in low
    # No code scope → no cmd_code predicate; only the flow-total param.
    assert "cmd_code in unnest" not in low
    assert [p.name for p in params] == ["__sum_flows"]
    assert list(params[0].values) == ["export", "import"]


def test_market_nature_series_sql_scoped_by_codes():
    from embrapa_dashboard.serving import sql as sqlbuild

    query, params = sqlbuild.market_nature_series(
        "proj.serving.serving_comtrade_annual", codes=("0801", "0802")
    )
    assert "cmd_code in unnest(@cmd_codes)" in query.lower()
    assert "flow in unnest(@__sum_flows)" in query.lower()
    names = [p.name for p in params]
    assert names == ["__sum_flows", "cmd_codes"]
    cmd = next(p for p in params if p.name == "cmd_codes")
    assert list(cmd.values) == ["0801", "0802"]
