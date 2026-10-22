"""Auxiliary discovery helpers used by `embrapa discover ...`.

These functions are NEVER called by the main ingestion pipeline. They exist
purely so the engineer can inspect what is available on the IBGE / BCB APIs
before committing exact codes to `.env`.
"""

from __future__ import annotations

import csv
import math
import statistics
from dataclasses import dataclass
from pathlib import Path

import requests

REQUEST_TIMEOUT = 30
# the national series of a whole classification is one request but a few hundred rows
SERIES_TIMEOUT = 120


# ─── IBGE SIDRA ──────────────────────────────────────────────────────────────
SIDRA_METADATA_URL = "https://servicodados.ibge.gov.br/api/v3/agregados/{table_id}/metadados"
SIDRA_PERIODS_URL = "https://servicodados.ibge.gov.br/api/v3/agregados/{table_id}/periodos"


@dataclass(frozen=True)
class ProductMatch:
    code: str
    name: str
    classification_id: str


def search_ibge_products(table_id: str, keywords: list[str]) -> list[ProductMatch]:
    """Return every product whose name contains any of the keywords (case-insensitive)."""
    response = requests.get(SIDRA_METADATA_URL.format(table_id=table_id), timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    payload = response.json()
    classifications = payload.get("classificacoes", [])
    needles = [k.lower() for k in keywords]

    matches: list[ProductMatch] = []
    for classification in classifications:
        for category in classification.get("categorias", []):
            name = str(category.get("nome", ""))
            if any(n in name.lower() for n in needles):
                matches.append(
                    ProductMatch(
                        code=str(category["id"]),
                        name=name,
                        classification_id=str(classification["id"]),
                    )
                )
    return sorted(matches, key=lambda m: (m.classification_id, m.code))


def list_ibge_periods(table_id: str) -> list[int]:
    """Return all years for which the table has data, sorted ascending."""
    response = requests.get(SIDRA_PERIODS_URL.format(table_id=table_id), timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    periods = response.json()
    years: list[int] = []
    for p in periods:
        raw = str(p.get("id") or (p.get("literals") or [""])[0])[:4]
        if raw.isdigit():
            years.append(int(raw))
    return sorted(set(years))


# ─── IBGE SIDRA: check a candidate BEFORE registering it ─────────────────────
# `embrapa discover ibge-series-check` runs, on the NATIONAL series of the candidates, the checks
# that found the problems of the units-and-deflation audit
# (docs/audits/unidades_e_deflacao_audit_2026-10-21.md, item D): a quantity SIDRA labels
# "Toneladas" that IBGE counted, a persistent level shift (a change of unit or method leaves a NEW
# stable level that stays; a harvest swing reverts), a unit with no conversion, a category born
# last year, an erratic series. It is the pre-registration half of a pair: the other half is the
# dbt test `assert_ibge_production_no_persistent_level_shift`, which reads what is already ingested.
SIDRA_VALUES_URL = "https://apisidra.ibge.gov.br/values/t/{table}/n1/all/v/{variable}/p/all/c{classification}/{codes}"

# table id -> (classification id, quantity variable id). Mirrors config.py (the *_table_id,
# *_classification_id and quantity variable fields); tests/test_discover_series_check.py pins the
# parity, so a change there cannot leave this stale.
SIDRA_QUANTITY_SPEC: dict[str, tuple[str, str]] = {
    "5457": ("782", "214"),  # PAM — lavouras
    "289": ("193", "144"),  # PEVS — extração vegetal
    "291": ("194", "142"),  # PEVS — silvicultura
    "74": ("80", "106"),  # PPM — produção de origem animal
    "3939": ("79", "105"),  # PPM — efetivo dos rebanhos
}

# a persistent level shift: the median of the 3 years from a year on, against the 3 years before it.
# dbt/tests/assert_ibge_production_no_persistent_level_shift.sql is the same rule in SQL: change one
# and the other must follow (tests/test_discover_series_check.py pins the numbers in the SQL file)
SHIFT_FACTOR = 3.0
# an erratic series: this many year-over-year steps of >= SHIFT_FACTOR
ERRATIC_STEPS = 3
SHORT_SERIES_YEARS = 5
# IBGE weighed the PAM fruits it used to count from 2001 (pam_fruit_unit_eras ends in 2000); the
# step's anchor year is the largest single-year step, so allow a year either side
COUNT_ERA_STEP_YEARS = (2000, 2001, 2002)

_REPO_SEEDS = Path(__file__).resolve().parents[2] / "dbt" / "seeds"


@dataclass(frozen=True)
class LevelShift:
    year: int  # the first year of the new level
    ratio: float  # after / before
    before: float
    after: float


@dataclass(frozen=True)
class SeriesCheck:
    code: str
    name: str
    units: tuple[str, ...]  # unit labels printed on the cells that HAVE a value
    years: tuple[int, ...]  # years with a positive quantity
    shifts: tuple[LevelShift, ...]
    steps_over_factor: int  # year-over-year steps of >= SHIFT_FACTOR (either direction)
    findings: tuple[
        str, ...
    ]  # each one is a reason to look BEFORE registering; empty = nothing found
    notes: tuple[str, ...]  # context that is not a problem


@dataclass(frozen=True)
class SeedFacts:
    """What the repository's seeds say, to compare the candidates against. None = the seeds are not
    on disk (an installed package, not a checkout): that comparison is skipped and says so."""

    convertible_units: frozenset[str] | None
    count_codes: frozenset[str] | None  # pam_count_unit_products
    era_codes: frozenset[str] | None  # pam_fruit_unit_eras


def load_seed_facts(seeds_dir: Path | None = None) -> SeedFacts:
    base = seeds_dir or _REPO_SEEDS

    def rows(name: str) -> list[dict] | None:
        path = base / name
        if not path.exists():
            return None
        with path.open(encoding="utf-8") as f:
            return list(csv.DictReader(f))

    units = rows("unit_family_conversions.csv")
    count = rows("pam_count_unit_products.csv")
    eras = rows("pam_fruit_unit_eras.csv")
    return SeedFacts(
        # a blank to_base means "needs a per-product factor" (saca, @, bushel): not a generic unit
        convertible_units=None
        if units is None
        else frozenset(r["unit_raw"].strip().lower() for r in units if r["to_base"].strip()),
        count_codes=None if count is None else frozenset(r["product_code"] for r in count),
        era_codes=None if eras is None else frozenset(r["product_code"] for r in eras),
    )


def level_shifts(series: dict[int, float], factor: float = SHIFT_FACTOR) -> list[LevelShift]:
    """Persistent level shifts of a yearly series.

    A change of unit or of method leaves a NEW level that stays; a harvest, a frost or a boom swings
    and comes back. So the test compares the median of the 3 years FROM a year on (y..y+2) with the
    median of the 3 years before it (y-3..y-1), and needs all six years present: a gap would fake a
    shift. A clean step at year Y is flagged at Y-1, Y and Y+1 (the windows that straddle it), so
    consecutive flagged years in one direction are ONE shift, anchored on the year of the largest
    single-year step.
    """
    positive = {y: v for y, v in series.items() if v > 0}
    flagged: list[tuple[int, float, float, float]] = []  # (year, ratio, before, after)
    for y in sorted(positive):
        if not all(w in positive for w in range(y - 3, y + 3)):
            continue
        before = statistics.median(positive[w] for w in (y - 3, y - 2, y - 1))
        after = statistics.median(positive[w] for w in (y, y + 1, y + 2))
        ratio = after / before
        if ratio >= factor or ratio <= 1 / factor:
            flagged.append((y, ratio, before, after))

    runs: list[list[tuple[int, float, float, float]]] = []
    for f in flagged:
        if runs and f[0] == runs[-1][-1][0] + 1 and (f[1] > 1) == (runs[-1][-1][1] > 1):
            runs[-1].append(f)
        else:
            runs.append([f])
    out: list[LevelShift] = []
    for run in runs:
        # the year of the new level = where the series itself stepped the most
        anchor = max(run, key=lambda f: abs(math.log(positive[f[0]] / positive[f[0] - 1])))
        out.append(LevelShift(anchor[0], anchor[1], anchor[2], anchor[3]))
    return out


def _steps_over_factor(series: dict[int, float], factor: float = SHIFT_FACTOR) -> int:
    n = 0
    for y, v in series.items():
        prev = series.get(y - 1)
        if prev and prev > 0 and v > 0:
            ratio = v / prev
            if ratio >= factor or ratio <= 1 / factor:
                n += 1
    return n


def _compress(years: list[int]) -> str:
    """[1990, 1991, 1992, 1995] -> '1990-1992, 1995'."""
    runs: list[list[int]] = []
    for y in years:
        if runs and y == runs[-1][-1] + 1:
            runs[-1].append(y)
        else:
            runs.append([y])
    return ", ".join(str(r[0]) if len(r) == 1 else f"{r[0]}-{r[-1]}" for r in runs)


def check_sidra_series(rows: list[dict], table_id: str, seeds: SeedFacts) -> list[SeriesCheck]:
    """The checks, per product, over the rows of one SIDRA `values` response (header row removed).

    Pure: no network, no disk. `rows` carry SIDRA's own keys — D3C year, D4C/D4N product, V value,
    MN unit. A cell with no value ('...', '-', 'X') says nothing about the unit: SIDRA leaves MN
    empty there, and that is NOT a missing unit (the audit read it as one for nine PEVS categories
    that only exist from 2025).
    """
    names: dict[str, str] = {}
    units: dict[str, set[str]] = {}
    series: dict[str, dict[int, float]] = {}
    for r in rows:
        code = str(r["D4C"])
        if code == "0":  # SIDRA's own 'Total' category: an aggregate, not a product
            continue
        names[code] = str(r.get("D4N", ""))
        try:
            value = float(r["V"])
            year = int(r["D3C"])
        except (TypeError, ValueError):
            continue
        series.setdefault(code, {})[year] = value
        if str(r.get("MN", "")).strip():
            units.setdefault(code, set()).add(str(r["MN"]).strip())

    out: list[SeriesCheck] = []
    for code, name in names.items():
        s = series.get(code, {})
        years = tuple(sorted(y for y, v in s.items() if v > 0))
        findings: list[str] = []
        notes: list[str] = []
        shifts = level_shifts(s)
        erratic = _steps_over_factor(s)
        unit_labels = tuple(sorted(units.get(code, set())))

        if not years and not name.strip():
            # SIDRA answers an unknown category with a full grid of '...' cells and an empty name
            findings.append(f"code {code} is not in table {table_id}'s classification")
        elif not years:
            findings.append("no year with a positive quantity: nothing to ingest")
        elif len(years) == 1:
            findings.append(
                f"only ONE year of data ({years[0]}): a category born that year, no history"
            )
        elif len(years) < SHORT_SERIES_YEARS:
            findings.append(f"short series: {len(years)} years ({years[0]}-{years[-1]})")
        if years:
            gaps = [y for y in range(years[0], years[-1] + 1) if y not in years]
            if gaps:
                findings.append(f"years without a quantity inside the series: {_compress(gaps)}")

        # the fruits IBGE counted until 2000 step at 2001 by construction; the seed converts them
        converted = table_id == "5457" and seeds.era_codes is not None and code in seeds.era_codes
        unexplained = []
        explained_by_seed = False
        for sh in shifts:
            if converted and sh.year in COUNT_ERA_STEP_YEARS:
                explained_by_seed = True
                notes.append(
                    f"x{sh.ratio:.2f} step in {sh.year} is the unit change, converted by "
                    "pam_fruit_unit_eras"
                )
            else:
                unexplained.append(sh)
        for sh in unexplained:
            findings.append(
                f"PERSISTENT LEVEL SHIFT x{sh.ratio:.2f} from {sh.year} "
                f"(median of 3 years: {sh.before:,.0f} before, {sh.after:,.0f} from then on)"
            )
        if erratic >= ERRATIC_STEPS and not shifts:
            findings.append(
                f"ERRATIC: {erratic} year-over-year steps of >= x{SHIFT_FACTOR:g}, no stable level"
            )
        elif erratic >= ERRATIC_STEPS:
            notes.append(f"{erratic} year-over-year steps of >= x{SHIFT_FACTOR:g}")

        if len(unit_labels) > 1:
            findings.append(f"the unit label changes inside the series: {', '.join(unit_labels)}")
        if seeds.convertible_units is None:
            notes.append("seeds not on disk (not a checkout): unit conversion NOT compared")
        else:
            for u in unit_labels:
                if u.lower() not in seeds.convertible_units:
                    findings.append(
                        f"unit {u!r} has NO row in unit_family_conversions: the quantity would "
                        "land in family 'desconhecida' with a NULL qty_base"
                    )

        if table_id == "5457" and "*" in name:
            if seeds.count_codes is None:
                notes.append(
                    "seeds not on disk: the '*' marker NOT compared with pam_count_unit_products"
                )
            elif code in seeds.count_codes:
                notes.append("'*' product, already a COUNT in pam_count_unit_products")
            else:
                findings.append(
                    "the name carries '*', SIDRA's marker for a COUNT (mil frutos) printed as "
                    "'Toneladas': add the product to pam_count_unit_products BEFORE registering it"
                )
        if converted and not explained_by_seed:
            notes.append("counted until 2000, converted by pam_fruit_unit_eras")

        if years:
            notes.append(f"{len(years)} years, {years[0]}-{years[-1]}")
        if unit_labels:
            notes.append(f"unit: {', '.join(unit_labels)}")
        out.append(
            SeriesCheck(
                code,
                name,
                unit_labels,
                years,
                tuple(shifts),
                erratic,
                tuple(findings),
                tuple(notes),
            )
        )
    return out


def scan_ibge_series(
    table_id: str, codes: list[str] | None = None, seeds: SeedFacts | None = None
) -> list[SeriesCheck]:
    """Fetch the NATIONAL quantity series of the candidate products (None = every product of the
    table) and check them. One request: SIDRA returns the whole classification at once."""
    if table_id not in SIDRA_QUANTITY_SPEC:
        raise ValueError(
            f"table {table_id!r} unknown; expected one of {sorted(SIDRA_QUANTITY_SPEC)}"
        )
    classification, variable = SIDRA_QUANTITY_SPEC[table_id]
    url = SIDRA_VALUES_URL.format(
        table=table_id,
        variable=variable,
        classification=classification,
        codes=",".join(codes) if codes else "all",
    )
    response = requests.get(url, timeout=SERIES_TIMEOUT)
    response.raise_for_status()
    rows = response.json()[1:]  # row 0 is SIDRA's header
    checks = check_sidra_series(rows, table_id, seeds if seeds is not None else load_seed_facts())
    # belt and braces: SIDRA answers an unknown code with empty cells (handled above), but if it
    # ever answers with no rows at all the candidate must not just vanish from the report
    known = {c.code for c in checks}
    checks.extend(
        SeriesCheck(
            c, "?", (), (), (), 0, (f"code {c} is not in table {table_id}'s classification",), ()
        )
        for c in (codes or [])
        if c not in known
    )
    return checks


# ─── BCB SGS ─────────────────────────────────────────────────────────────────
BCB_SAMPLE_URL = (
    "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados/ultimos/{n}?formato=json"
)


@dataclass(frozen=True)
class BcbSeriesSample:
    code: str
    sample: list[dict]


def sample_bcb_series(code: str, n: int = 5) -> BcbSeriesSample:
    """Pull the last N observations of an SGS series — useful to validate a code."""
    response = requests.get(BCB_SAMPLE_URL.format(code=code, n=n), timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    return BcbSeriesSample(code=code, sample=response.json())
