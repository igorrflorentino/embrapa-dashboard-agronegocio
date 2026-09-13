"""Metric-conventions model + pt-BR month names for the serving/serializer layer.

Maps a (currency, correction) convention pair to the **real** Gold/serving value
column, so the dashboard deflates with actual data (unlike the prototype, which
multiplied one value by demo FX rates). ``monetary_column`` returns the canonical
column; the seam validates it against what the mart has.

The prototype's pt-BR number/currency *formatters* (fmtBRL/fmtMoney/fmtNum/…) were
removed: the React frontend does all user-facing number formatting in JS
(``frontend/src/data/data.js``), so a parallel Python copy was dead code (and
carried latent rounding/sign bugs). Only the conventions model and the month
abbreviations — both consumed by the seam/serializers — remain.
"""

from __future__ import annotations

# ── Metric conventions ───────────────────────────────────────────────────────

CURRENCY_SYMBOL = {"BRL": "R$", "USD": "US$", "EUR": "€"}

# Correction id → the Gold/serving column infix. 'Nominal' uses the year-FX
# (un-deflated) value; the others use the IPCA/IGP-M/IGP-DI real columns.
_CORRECTION_INFIX = {
    "Nominal": "yearfx",
    "IPCA": "real_ipca",
    "IGP-M": "real_igpm",
    "IGP-DI": "real_igpdi",
}
_CURRENCY_SUFFIX = {"BRL": "brl", "USD": "usd", "EUR": "eur"}


def monetary_column(currency: str, correction: str) -> str:
    """Canonical serving value column for a (currency, correction) pair.

    e.g. (BRL, IPCA) → ``val_real_ipca_brl``; (USD, Nominal) → ``val_yearfx_usd``.
    The seam validates the result against the columns the banco's mart actually
    carries and falls back to the banco default when a combo is unavailable.
    """
    infix = _CORRECTION_INFIX.get(correction, "real_ipca")
    suffix = _CURRENCY_SUFFIX.get(currency, "brl")
    return f"val_{infix}_{suffix}"


def column_currency(column: str) -> str | None:
    """Currency a monetary column is denominated in — the inverse of
    :func:`monetary_column`'s suffix (``val_real_ipca_usd`` → ``'USD'``); ``None`` for a
    non-monetary column.

    A payload's unit must come from the column actually summed, not from the request:
    the seam falls back to R$ when a mart lacks the requested combo (US$ × IGP-M).
    """
    suffix = column.rsplit("_", 1)[-1]
    return next((cur for cur, suf in _CURRENCY_SUFFIX.items() if suf == suffix), None)


def convention_value_label(conv: dict) -> str:
    """Human label for the active monetary convention, e.g. 'Valor real (IPCA) — R$'."""
    sym = CURRENCY_SYMBOL.get(conv.get("currency", "BRL"), "R$")
    corr = conv.get("correction", "IPCA")
    if corr == "Nominal":
        return f"Valor nominal — {sym}"
    return f"Valor real ({corr}) — {sym}"


# pt-BR month abbreviations (index 0 → January), for seasonality axes/labels.
MONTH_ABBR_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
