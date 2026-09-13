"""Foreign price indices (US CPI · euro-area HICP) — Bronze pipeline.

Why this package exists: a value expressed in US$ or € has to be corrected by the
inflation of the economy that issues the currency. Until v1.82.0 the project had only
Brazilian indices (IPCA / IGP-M / IGP-DI), so every "real" figure the dashboard showed
in a foreign currency was a BRL deflation wearing a foreign symbol — arithmetically
right, but the answer to a question nobody asked when they picked "US$ · IPCA".

Scope: these are REFERENCE series, not a banco. They produce no products, no geography
and no Gold table of their own — they feed ``silver_foreign_inflation`` → the shared
deflation CTEs, exactly as ``bcb/inflation.py`` feeds ``silver_bcb_inflation``.
"""

from embrapa_dashboard.foreign_inflation.pipeline import FOREIGN_INDICES, ForeignIndexSpec, run

__all__ = ["FOREIGN_INDICES", "ForeignIndexSpec", "run"]
