"""`embrapa discover ibge-series-check`: the checks run BEFORE a SIDRA product is registered.

They exist because the 2026-10 audit (docs/audits/unidades_e_deflacao_audit_2026-10-21.md, item D)
found by hand, after the fact, what a short scan of the national series shows before: a quantity
SIDRA prints as "Toneladas" that IBGE counted, a series that settles at a new level, a unit no seed
converts, a category born last year. The analysis is pure (rows in, findings out); only
``scan_ibge_series`` touches the network, and it is mocked here.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import requests
from typer.testing import CliRunner

from embrapa_dashboard import cli, discover
from embrapa_dashboard.config import Settings
from embrapa_dashboard.discover import (
    SeedFacts,
    SeriesCheck,
    check_sidra_series,
    level_shifts,
    load_seed_facts,
    scan_ibge_series,
)

runner = CliRunner()
REPO = Path(__file__).resolve().parent.parent

SEEDS = SeedFacts(
    convertible_units=frozenset({"toneladas", "metros cúbicos", "mil árvores"}),
    count_codes=frozenset({"40092"}),
    era_codes=frozenset({"40151"}),
)
NO_SEEDS = SeedFacts(None, None, None)


def _years(f, start: int = 1990, end: int = 2020) -> dict[int, float]:
    return {y: f(y) for y in range(start, end + 1)}


def _rows(code: str, name: str, series: dict[int, float], unit: str = "Toneladas") -> list[dict]:
    return [
        {"D4C": code, "D4N": name, "D3C": str(y), "V": str(v), "MN": unit}
        for y, v in series.items()
    ]


def _check(rows: list[dict], table: str = "5457", seeds: SeedFacts = SEEDS) -> SeriesCheck:
    (only,) = check_sidra_series(rows, table, seeds)
    return only


# ─── level_shifts: the rule ──────────────────────────────────────────────────
def test_a_step_that_stays_is_one_shift_anchored_on_the_year_of_the_step() -> None:
    s = _years(lambda y: 100.0 if y < 2001 else 500.0)
    (shift,) = level_shifts(s)
    assert (shift.year, shift.ratio, shift.before, shift.after) == (2001, 5.0, 100.0, 500.0)


def test_a_fall_that_stays_is_a_shift_with_a_ratio_below_one() -> None:
    (shift,) = level_shifts(_years(lambda y: 400.0 if y < 2010 else 100.0))
    assert (shift.year, shift.ratio) == (2010, 0.25)


def test_a_swing_of_one_year_never_moves_the_median_of_three() -> None:
    """A harvest, a frost, a boom: ×6 for ONE year and back — what the rule exists to ignore."""
    assert level_shifts(_years(lambda y: 600.0 if y == 2005 else 100.0)) == []


def test_noise_around_a_constant_level_is_not_a_shift() -> None:
    assert level_shifts(_years(lambda y: 130.0 if y % 2 else 77.0)) == []


def test_the_factor_is_three_and_three_is_the_edge() -> None:
    assert level_shifts(_years(lambda y: 100.0 if y < 2001 else 290.0)) == []
    assert len(level_shifts(_years(lambda y: 100.0 if y < 2001 else 310.0))) == 1


def test_two_separate_shifts_are_two_findings() -> None:
    s = _years(lambda y: 100.0 if y < 1995 else (400.0 if y < 2010 else 80.0))
    assert [(sh.year, sh.ratio) for sh in level_shifts(s)] == [(1995, 4.0), (2010, 0.2)]


def test_a_two_year_episode_fires_as_an_up_down_pair() -> None:
    """Documented limit: only a ONE-year swing is invisible. Two years move the median of three, so
    the episode shows as an up and a down a couple of years apart — to be read together."""
    s = _years(lambda y: 700.0 if y in (2005, 2006) else 100.0)
    assert [(sh.year, sh.ratio > 1) for sh in level_shifts(s)] == [(2005, True), (2007, False)]


def test_a_gap_inside_the_window_hides_the_shift_rather_than_faking_one() -> None:
    s = {y: (100.0 if y < 2001 else 500.0) for y in range(1990, 2021) if y not in (2000, 2001)}
    assert level_shifts(s) == []


def test_zero_and_negative_years_are_gaps_not_levels() -> None:
    s = _years(lambda y: 100.0)
    s[2005] = 0.0
    s[2006] = -3.0
    assert level_shifts(s) == []


# ─── check_sidra_series: what each finding means ─────────────────────────────
def test_a_clean_product_has_no_findings() -> None:
    c = _check(_rows("40124", "Soja (em grão)", _years(lambda y: 100.0 + y % 7)))
    assert c.findings == ()
    assert c.units == ("Toneladas",)


def test_a_cell_without_a_value_does_not_count_as_a_unit_or_a_year() -> None:
    """SIDRA prints '...', '-', 'X' for a cell with no value. The audit once read the empty unit
    of such a cell as 'no unit' for nine PEVS categories that only exist from 2025."""
    rows = _rows("1", "Algo", _years(lambda y: 100.0 + y % 5, 1990, 2023))
    rows += [
        {"D4C": "1", "D4N": "Algo", "D3C": "2024", "V": "...", "MN": ""},
        {"D4C": "1", "D4N": "Algo", "D3C": "2025", "V": "-", "MN": "Mil árvores"},
    ]
    c = _check(rows)
    assert c.units == ("Toneladas",)  # the 'Mil árvores' on a '-' cell is not evidence
    assert c.findings == ()
    assert c.years[-1] == 2023


def test_a_unit_without_a_conversion_is_named_with_what_it_would_become() -> None:
    c = _check(_rows("9", "Coisa", _years(lambda y: 100.0 + y % 5), unit="Arrobas"))
    (finding,) = c.findings
    assert "'Arrobas'" in finding
    assert "desconhecida" in finding and "qty_base" in finding


def test_without_the_seeds_the_unit_is_not_judged_and_the_note_says_so() -> None:
    c = _check(_rows("9", "Coisa", _years(lambda y: 100.0 + y % 5), unit="Arrobas"), seeds=NO_SEEDS)
    assert c.findings == ()
    assert any("seeds not on disk" in n for n in c.notes)


def test_an_asterisk_product_missing_from_the_count_seed_is_a_finding() -> None:
    c = _check(_rows("40999", "Fruta nova*", _years(lambda y: 100.0 + y % 5)))
    (finding,) = c.findings
    assert "pam_count_unit_products" in finding and "BEFORE registering" in finding


def test_an_asterisk_product_already_a_count_is_a_note() -> None:
    c = _check(_rows("40092", "Abacaxi*", _years(lambda y: 100.0 + y % 5)))
    assert c.findings == ()
    assert any("already a COUNT" in n for n in c.notes)


def test_the_asterisk_only_means_a_count_in_pam() -> None:
    """In another table the name is just a name; the marker was measured on table 5457."""
    c = _check(_rows("1", "Coisa*", _years(lambda y: 100.0 + y % 5)), table="289")
    assert c.findings == ()


def test_the_unit_step_of_a_counted_fruit_is_explained_by_the_seed_but_another_is_not() -> None:
    """Laranja is converted up to 2000: its 2001 step is the known unit change. A SECOND shift,
    elsewhere, is not explained by anything and must still be reported."""
    explained = _check(_rows("40151", "Laranja", _years(lambda y: 100.0 if y < 2001 else 16.0)))
    assert explained.findings == ()
    assert any("converted by pam_fruit_unit_eras" in n for n in explained.notes)

    other = _check(_rows("40151", "Laranja", _years(lambda y: 100.0 if y < 1995 else 16.0)))
    assert len(other.findings) == 1 and "from 1995" in other.findings[0]


def test_a_shift_in_a_product_the_seed_does_not_cover_is_a_finding() -> None:
    c = _check(_rows("40264", "Marmelo", _years(lambda y: 100.0 if y < 2001 else 25.0)))
    assert len(c.findings) == 1 and "PERSISTENT LEVEL SHIFT x0.25 from 2001" in c.findings[0]


def test_sidras_total_row_is_not_a_product() -> None:
    assert check_sidra_series(_rows("0", "Total", _years(lambda y: 1.0)), "5457", SEEDS) == []


def test_an_unknown_code_is_named_not_reported_as_an_empty_series() -> None:
    """SIDRA answers an unknown category with a full grid of '...' and an EMPTY name (measured)."""
    rows = [
        {"D4C": "99999", "D4N": "", "D3C": str(y), "V": "...", "MN": "Toneladas"}
        for y in (1974, 1975)
    ]
    (finding,) = _check(rows).findings
    assert "99999" in finding and "not in table 5457" in finding


def test_a_product_born_last_year_has_no_history_to_judge() -> None:
    rows = _rows("5", "Nova", {2025: 10.0}) + [
        {"D4C": "5", "D4N": "Nova", "D3C": str(y), "V": "...", "MN": ""} for y in range(1990, 2025)
    ]
    (finding,) = _check(rows).findings
    assert "ONE year" in finding and "2025" in finding


def test_a_short_series_and_a_hole_inside_it_are_findings() -> None:
    short = _check(_rows("5", "Curta", {2021: 1.0, 2022: 2.0, 2023: 1.5}))
    assert any("short series: 3 years" in f for f in short.findings)

    holey = _check(
        _rows("6", "Furada", {y: 100.0 for y in range(1990, 2021) if y not in (2000, 2001, 2005)})
    )
    assert any("2000-2001, 2005" in f for f in holey.findings)


def test_a_unit_label_that_changes_inside_the_series_is_a_finding() -> None:
    rows = _rows("7", "Mudou", _years(lambda y: 100.0 + y % 5, 1990, 2000), unit="Toneladas")
    rows += _rows("7", "Mudou", _years(lambda y: 100.0 + y % 5, 2001, 2010), unit="Metros cúbicos")
    assert any("unit label changes" in f for f in _check(rows).findings)


def test_a_spiky_series_with_no_stable_level_is_reported_as_erratic() -> None:
    """Three one-year spikes: six year-over-year steps of x10, and a median of three that never
    moves — so no level shift explains it, and it must not pass silently either."""
    s = _years(lambda y: 1000.0 if y in (2000, 2005, 2010) else 100.0)
    assert level_shifts(s) == []
    c = _check(_rows("8", "Errática", s))
    assert any(f.startswith("ERRATIC: 6 year-over-year steps") for f in c.findings)


# ─── load_seed_facts: the real seeds ─────────────────────────────────────────
def test_the_real_seeds_say_what_the_checks_assume() -> None:
    facts = load_seed_facts()
    assert facts.convertible_units is not None
    assert {"toneladas", "metros cúbicos", "mil árvores", "mil dúzias"} <= facts.convertible_units
    # a blank to_base is 'needs a per-product factor', not a generic conversion
    assert not {"saca", "@", "arroba", "bushel", "barril"} & facts.convertible_units
    assert facts.count_codes == {"40092", "40145"}
    assert facts.era_codes is not None and len(facts.era_codes) == 17 and "40151" in facts.era_codes


def test_without_a_checkout_the_seeds_are_unknown_not_empty(tmp_path: Path) -> None:
    assert load_seed_facts(tmp_path) == NO_SEEDS


# ─── scan_ibge_series: the one request ───────────────────────────────────────
class _Resp:
    def __init__(self, payload: list[dict], status: int = 200) -> None:
        self._payload, self.status_code = payload, status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self) -> list[dict]:
        return self._payload


def test_scan_asks_for_the_national_quantity_of_the_given_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict = {}

    def fake_get(url: str, timeout: float) -> _Resp:
        seen.update(url=url, timeout=timeout)
        header = {"D4C": "Produto (Código)"}
        return _Resp([header, *_rows("40124", "Soja (em grão)", _years(lambda y: 100.0 + y % 7))])

    monkeypatch.setattr(discover.requests, "get", fake_get)
    checks = scan_ibge_series("5457", ["40124", "40151"], seeds=SEEDS)
    assert seen["url"].endswith("/t/5457/n1/all/v/214/p/all/c782/40124,40151")
    assert seen["timeout"] == discover.SERIES_TIMEOUT
    soja, absent = checks
    assert soja.code == "40124" and len(soja.years) == 31  # the header row was dropped
    assert absent.code == "40151" and "not in table 5457" in absent.findings[0]


def test_scan_without_codes_asks_for_the_whole_classification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    urls: list[str] = []
    monkeypatch.setattr(
        discover.requests, "get", lambda url, timeout: urls.append(url) or _Resp([{"h": 1}])
    )
    assert scan_ibge_series("289", None, seeds=SEEDS) == []
    assert urls[0].endswith("/t/289/n1/all/v/144/p/all/c193/all")


def test_scan_does_not_let_a_requested_code_vanish_from_the_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(discover.requests, "get", lambda url, timeout: _Resp([{"h": 1}]))
    (missing,) = scan_ibge_series("5457", ["12345"], seeds=SEEDS)
    assert missing.code == "12345" and "not in table 5457" in missing.findings[0]


def test_scan_rejects_a_table_it_does_not_know() -> None:
    with pytest.raises(ValueError, match="table '1612' unknown"):
        scan_ibge_series("1612", ["1"], seeds=SEEDS)


def test_scan_propagates_an_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover.requests, "get", lambda url, timeout: _Resp([], status=500))
    with pytest.raises(requests.HTTPError):
        scan_ibge_series("5457", ["40124"], seeds=SEEDS)


# ─── the pins: this module cannot drift from config.py or from the dbt test ──
def test_the_table_spec_matches_the_settings_defaults() -> None:
    s = Settings(_env_file=None, gcp_project_id="test-project")
    expected = {
        s.pam_table_id: (s.pam_classification_id, "214", s.pam_variable_codes_list),
        s.ibge_table_id: (s.ibge_classification_id, s.ibge_variable_quantity_code, None),
        s.silvicultura_table_id: (
            s.silvicultura_classification_id,
            s.silvicultura_variable_quantity_code,
            None,
        ),
        s.ppm_animal_table_id: (
            s.ppm_animal_classification_id,
            "106",
            s.ppm_animal_variable_codes_list,
        ),
        s.ppm_herd_table_id: (s.ppm_herd_classification_id, "105", s.ppm_herd_variable_codes_list),
    }
    assert set(discover.SIDRA_QUANTITY_SPEC) == set(expected)
    for table, (classification, variable, variables_fetched) in expected.items():
        assert discover.SIDRA_QUANTITY_SPEC[table] == (classification, variable), table
        if variables_fetched is not None:  # the quantity variable must be among those ingested
            assert variable in variables_fetched, table


def test_the_dbt_test_uses_the_same_rule_as_the_python() -> None:
    sql = (REPO / "dbt/tests/assert_ibge_production_no_persistent_level_shift.sql").read_text(
        encoding="utf-8"
    )
    factor = int(discover.SHIFT_FACTOR)
    assert f"after_level >= {factor} * before_level" in sql
    assert f"after_level <= before_level / {factor}" in sql
    # the six years y-3 .. y+2, all present: lag(3) and lead(2) landing on y-3 and y+2
    assert "lag(qty, 3)" in sql and "lead(qty, 2)" in sql
    assert "year_m3 = reference_year - 3" in sql and "year_p2 = reference_year + 2" in sql
    assert "severity='warn'" in sql


# ─── the command ─────────────────────────────────────────────────────────────
def _fake_scan(checks: list[SeriesCheck]):
    def scan(table_id: str, codes: list[str] | None = None, seeds=None) -> list[SeriesCheck]:
        scan.called_with = (table_id, codes)  # type: ignore[attr-defined]
        return checks

    return scan


def test_the_command_exits_1_and_explains_when_a_product_has_a_finding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bad = SeriesCheck(
        "40999", "Fruta nova*", ("Toneladas",), (2020, 2021), (), 0, ("faça algo",), ()
    )
    ok = SeriesCheck("40124", "Soja", ("Toneladas",), (2020, 2021), (), 0, (), ("2 years",))
    scan = _fake_scan([ok, bad])
    monkeypatch.setattr(cli.discover, "scan_ibge_series", scan)

    result = runner.invoke(
        cli.app, ["discover", "ibge-series-check", "-t", "5457", "-c", "40999, 40124"]
    )

    assert result.exit_code == 1, result.output
    assert scan.called_with == ("5457", ["40999", "40124"])  # type: ignore[attr-defined]
    assert "40999" in result.output and "faça algo" in result.output
    assert "40124" not in result.output.split("Table 5457")[0]  # the clean one stays quiet
    assert "2 products checked, 1 with something to look at" in result.output
    assert "prompt to look, not proof" in result.output


def test_the_command_lists_the_clean_products_with_all(monkeypatch: pytest.MonkeyPatch) -> None:
    ok = SeriesCheck("40124", "Soja", ("Toneladas",), (2020, 2021), (), 0, (), ("2 years",))
    monkeypatch.setattr(cli.discover, "scan_ibge_series", _fake_scan([ok]))

    result = runner.invoke(cli.app, ["discover", "ibge-series-check", "--all"])

    assert result.exit_code == 0, result.output
    assert "40124" in result.output and "0 with something to look at" in result.output


def test_the_command_scans_the_whole_table_when_no_codes_are_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scan = _fake_scan([])
    monkeypatch.setattr(cli.discover, "scan_ibge_series", scan)
    assert runner.invoke(cli.app, ["discover", "ibge-series-check"]).exit_code == 0
    assert scan.called_with == ("5457", None)  # type: ignore[attr-defined]


def test_the_command_exits_2_for_a_table_it_does_not_know() -> None:
    result = runner.invoke(cli.app, ["discover", "ibge-series-check", "-t", "1612"])
    assert result.exit_code == 2
    assert "unknown" in result.output
