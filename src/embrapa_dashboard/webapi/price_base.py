"""The price base of a corrected value: at which month's prices it is, and at which PTAX
day a cross column converted (v1.105.0).

A deflated number is not "in today's money". It is at the prices of ONE month — the latest
month of its index when Gold was built — and that month moves with every build that ingests
a new one: the 2026-11-17 build moved every IPCA-corrected value from September's prices to
October's, +0,14%, and no screen said so. The base therefore travels WITH the data: Gold
stamps it on every row (``<index>_base_month``, ``fx_<cur>_base_date``), the marts carry
it, and each reader that sums a corrected column reads it back with ``max()`` in the SAME
select (``serving.sql._price_base_select``). This module turns what came back into what the
screen prints.

Absence is not a guess. No column, no row, or two distinct months in one frame → ``None``,
which the screen renders as the honest fallback ("a preços do mês mais recente do índice").
Two months would mean one table mixes values corrected to two different dates; picking one
would date the others wrong.

What a price base is NOT: an interest rate. Deflating changes the UNIT a value is measured
in — the purchasing power of a reference month — and adds no return. Bringing a value "to
the present" in the financial sense (capitalizing it at the opportunity cost of money)
answers a different question, and the panel deliberately does not ask it.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from typing import Any, NamedTuple

import pandas as pd

from embrapa_dashboard.serving.sql import PRICE_BASE_MONTH_COLUMN

from .format import MONTH_NAME_PT

# The two aliases ``_price_base_select`` emits. Dropped from the frame once read (see
# :func:`take`), so no consumer downstream ever meets a DATE column it did not ask for.
BASE_COLUMNS = ("price_base_month", "price_base_fx_date")

# What the screen says when the base is unknown: the mart predates v1.105.0 (the app and the
# marts deploy in parallel), or the reader could not read the schema. It is still TRUE —
# every corrected value is at the prices of its index's latest month — it just cannot name
# the month.
UNKNOWN_BASE_PHRASE = "a preços do mês mais recente do índice"


class PriceBase(NamedTuple):
    """The month a corrected value is at, and the PTAX day a cross column converted at
    (``None`` for an own-currency column, which converts at the rate of each period)."""

    month: dt.date
    fx_date: dt.date | None = None


def _as_date(value: Any) -> dt.date | None:
    """A BigQuery DATE as pandas hands it over (``datetime.date``, a Timestamp, a numpy
    datetime64, an ISO string) → ``datetime.date``; ``None`` for a NULL / NaT."""
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):  # an array-like is not a scalar NULL
        return None
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    try:
        return pd.Timestamp(value).date()
    except (TypeError, ValueError):
        return None


def _distinct(values: Iterable[Any]) -> set[dt.date]:
    return {d for d in (_as_date(v) for v in values) if d is not None}


def from_values(months: Iterable[Any], fx_dates: Iterable[Any] = ()) -> PriceBase | None:
    """The single price base the values agree on — or ``None`` when they do not.

    ``None`` when there is no month, and ALSO when there are two: one frame summed from rows
    corrected to two different months has no month to name, and choosing one would be the
    guess this module exists to avoid. The same holds for two PTAX days. The month is
    normalised to its first day (Gold already truncates it).
    """
    found = _distinct(months)
    if len(found) != 1:
        return None
    days = _distinct(fx_dates)
    if len(days) > 1:
        return None
    month = found.pop().replace(day=1)
    return PriceBase(month, days.pop() if days else None)


def from_frame(df: pd.DataFrame | None) -> PriceBase | None:
    """The price base of a frame a reader fetched ``with_price_base`` (``None`` if absent)."""
    if df is None or df.empty or BASE_COLUMNS[0] not in df.columns:
        return None
    fx = df[BASE_COLUMNS[1]].tolist() if BASE_COLUMNS[1] in df.columns else ()
    return from_values(df[BASE_COLUMNS[0]].tolist(), fx)


def take(df: pd.DataFrame | None) -> tuple[pd.DataFrame | None, PriceBase | None]:
    """Read the price base off a freshly fetched frame, and drop its columns.

    The frame goes on to merges, sums and record dumps that predate the base; it leaves
    here exactly as it was before v1.105.0, and the base continues as its own value.
    """
    if df is None:
        return None, None
    base = from_frame(df)
    present = [c for c in BASE_COLUMNS if c in df.columns]
    return (df.drop(columns=present) if present else df), base


def month_phrase(base: PriceBase) -> str:
    """'outubro de 2026'."""
    return f"{MONTH_NAME_PT[base.month.month - 1]} de {base.month.year}"


def prices_phrase(base: PriceBase | None) -> str:
    """'a preços de outubro de 2026' — or the fallback, when the base is unknown."""
    return UNKNOWN_BASE_PHRASE if base is None else f"a preços de {month_phrase(base)}"


def has_base(column: str | None) -> bool:
    """Whether ``column`` is at the prices of one month (a deflated column). A nominal value
    is at the prices of its own year, and a quantity has no price."""
    return column in PRICE_BASE_MONTH_COLUMN


def label_suffix(column: str | None, base: PriceBase | None) -> str:
    """' · a preços de outubro de 2026' for a deflated column; '' for any other.

    Appended LAST to a value label, after the FOB/CIF note, so the label reads as "what
    this is — its basis — whose prices"."""
    return f" · {prices_phrase(base)}" if has_base(column) else ""


def payload(column: str | None, base: PriceBase | None) -> dict | None:
    """The ``priceBase`` every value payload carries — ``null`` when unknown or nominal.

    ``column`` names what the base dates, so the screen can refuse to borrow it for a
    different convention (``window.priceBaseFor``). ``month`` is 'YYYY-MM', ``fxDate``
    'YYYY-MM-DD' (or null: an own-currency column converts at each period's rate).

    ``column=None`` is for the bare-frame readers (products by UF / município, the UF and
    município cubes, the selected UFs' per-product series), whose serializer never learns
    which column was summed. Their base can still only
    have come from a deflated column — the SQL dates no other kind — and it belongs to the
    request's own convention, so the payload just leaves the column out.
    """
    if base is None or (column is not None and not has_base(column)):
        return None
    return {
        "column": column,
        "month": f"{base.month.year:04d}-{base.month.month:02d}",
        "fxDate": base.fx_date.isoformat() if base.fx_date else None,
    }
