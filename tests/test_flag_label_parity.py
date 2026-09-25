"""The quality-flag labels live in TWO places, and nothing compared them until v1.93.0.

``frontend/src/ui/data.js`` (``window.QUALITY_FLAGS``) labels the legend, the filter chips
and the rows the SPA builds itself; ``serializers._FLAG_LABEL_PT`` labels the donut rows the
API sends. The researcher reads both on the same screen, so a flag renamed in one and not
the other shows up under two names. The v1.93.0 rename touched all fourteen at once, which
is exactly when a copy gets missed.

Same idiom as ``test_partner_price_floor_parity.py``: read the JS source, compare.
"""

from __future__ import annotations

import re
from pathlib import Path

from embrapa_dashboard.webapi import serializers

_JS = Path(__file__).resolve().parents[1] / "frontend" / "src" / "ui" / "data.js"
_ENTRY = re.compile(r"\{ id: '([A-Z_]+)',\s+label: '([^']+)'")


def _js_labels() -> dict[str, str]:
    src = _JS.read_text(encoding="utf-8")
    start = src.index("window.QUALITY_FLAGS = [")
    block = src[start : src.index("];", start)]
    return dict(_ENTRY.findall(block))


def test_the_scan_finds_every_flag() -> None:
    """Guard of the scanner itself: a broken regex would make the parity test pass empty."""
    assert len(_js_labels()) == 14


def test_ui_and_api_name_every_flag_the_same_way() -> None:
    assert _js_labels() == serializers._FLAG_LABEL_PT


def test_no_label_promises_what_the_detector_does_not_check() -> None:
    """The old "(válido)" read as a guarantee: the detector only asks that the price be within
    100× of the median, and up to 9,8% of those rows sit 10× or more away (2026-09-24)."""
    for flag, label in _js_labels().items():
        assert not re.search(r"válid|normal", label, re.I), (flag, label)
