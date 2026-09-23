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
# (un-deflated) value; the others use the real columns.
_CORRECTION_INFIX = {
    "Nominal": "yearfx",
    "IPCA": "real_ipca",
    "IGP-M": "real_igpm",
    "IGP-DI": "real_igpdi",
    "CPI": "real_cpi",
    "HICP": "real_hicp",
}
_CURRENCY_SUFFIX = {"BRL": "brl", "USD": "usd", "EUR": "eur"}

# ── Which economy each correction measures — the fact this whole model turns on ──
#
# An inflation index measures ONE economy's prices, so it can only say what something
# was worth in THAT economy's money. Two things follow, and the dashboard has to show
# both rather than blend them into a single "correção" axis:
#
#   • index economy == display currency → the value is converted at the exchange rate
#     of the YEAR OF RECORD and then deflated. "Dollars of the time, brought to dollars
#     of today." For a customs banco, whose source value already IS US$, no exchange
#     rate is involved at all.
#   • index economy != display currency → the value is deflated in the INDEX's money
#     and converted at TODAY's rate. The number measures Brazilian purchasing power and
#     is merely printed with a foreign symbol; it is a legitimate reading and it is not
#     "the dollar corrected for inflation".
#
# Until v1.82.0 only the second existed and was labelled as if it were the first —
# "US$ · IPCA" reads as dollars corrected by Brazilian inflation, which is not a thing.
CORRECTION_ECONOMY = {
    "IPCA": "BR",
    "IGP-M": "BR",
    "IGP-DI": "BR",
    "CPI": "US",
    "HICP": "EA",
}
ECONOMY_CURRENCY = {"BR": "BRL", "US": "USD", "EA": "EUR"}
# pt-BR — it reaches the screen (see convention_value_label).
ECONOMY_LABEL = {"BR": "Brasil", "US": "EUA", "EA": "zona do euro"}


def correction_economy(correction: str) -> str | None:
    """The economy whose price level ``correction`` measures; ``None`` for 'Nominal'."""
    return CORRECTION_ECONOMY.get(correction)


# The correction the dashboard assumes when none is given — and the one its screen opens
# on. Nominal since v1.88.0 (it was IPCA): a correction is the researcher's methodological
# choice, not something the tool presumes. Mirrors window.DEFAULT_CONVENTIONS.
DEFAULT_CORRECTION = "Nominal"


def correction_offered(currency: str, correction: str) -> bool:
    """Whether the dashboard OFFERS this pairing: 'Nominal', or an index of the currency's
    OWN economy (R$ → IPCA/IGP-M/IGP-DI, US$ → CPI, € → HICP).

    Mirrors ``window.correctionsFor`` in frontend/src/ui/MetricConventions.jsx. Narrower
    than what the marts carry: ``val_real_ipca_usd`` still exists (a Brazilian index under
    a foreign symbol — "Brazilian purchasing power, printed in dollars") and is still
    served to a request that names it, but since v1.88.0 the strip no longer offers it, so
    nothing the BFF SUGGESTS to the screen may point at it either.
    """
    if correction == "Nominal":
        return True
    economy = CORRECTION_ECONOMY.get(correction)
    return economy is not None and ECONOMY_CURRENCY.get(economy) == currency


def deflates_own_currency(currency: str, correction: str) -> bool:
    """True when the index measures the prices of the money being displayed.

    The two sides of the distinction the conventions strip must make visible: True is
    "US$ corrigidos pela inflação americana", False is "reais corrigidos e convertidos".
    'Nominal' is neither — nothing is corrected — so it answers False.
    """
    economy = CORRECTION_ECONOMY.get(correction)
    return economy is not None and ECONOMY_CURRENCY.get(economy) == currency


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
    """Human label for the active monetary convention.

    The label has to carry WHICH ECONOMY corrected the number whenever that is not
    obvious, because the same currency symbol can head two different measurements:

      (BRL, IPCA)  → 'Valor real (IPCA) — R$'
      (USD, CPI)   → 'Valor real (CPI · inflação dos EUA) — US$'
      (USD, IPCA)  → 'Valor real (IPCA · inflação do Brasil, ao câmbio de hoje) — US$'

    The third is the one that used to read simply 'Valor real (IPCA) — US$', which
    states something that does not exist: dollars corrected by Brazilian inflation.
    R$ × a Brazilian index keeps the short form — there is nothing to disambiguate.
    """
    currency = conv.get("currency", "BRL")
    sym = CURRENCY_SYMBOL.get(currency, "R$")
    corr = conv.get("correction", DEFAULT_CORRECTION)
    if corr == "Nominal":
        return f"Valor nominal — {sym}"
    economy = CORRECTION_ECONOMY.get(corr)
    if economy is None:
        return f"Valor real ({corr}) — {sym}"
    if ECONOMY_CURRENCY.get(economy) == currency:
        if economy == "BR":
            return f"Valor real ({corr}) — {sym}"
        return f"Valor real ({corr} · inflação {_DA_ECONOMIA[economy]}) — {sym}"
    return f"Valor real ({corr} · inflação {_DA_ECONOMIA[economy]}, ao câmbio de hoje) — {sym}"


# pt-BR contraction per economy ("do Brasil" · "dos EUA" · "da zona do euro"), so the
# label reads as a sentence instead of gluing a bare noun onto "inflação".
_DA_ECONOMIA = {"BR": "do Brasil", "US": "dos EUA", "EA": "da zona do euro"}


# pt-BR month abbreviations (index 0 → January), for seasonality axes/labels.
MONTH_ABBR_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
