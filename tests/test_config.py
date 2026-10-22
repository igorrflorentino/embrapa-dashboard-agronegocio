"""Tests for runtime settings (validators, parsers, default-derivation, helpers)."""

from __future__ import annotations

import itertools
from unittest.mock import MagicMock, patch

import pytest

from embrapa_dashboard import config as config_module
from embrapa_dashboard.config import (
    Settings,
    _parse_code_label,
    get_credentials,
    get_settings,
)


# ─── _parse_code_label ───────────────────────────────────────────────────────
def test_parse_code_label_simple_pair() -> None:
    assert _parse_code_label("433:IPCA") == {"433": "IPCA"}


def test_parse_code_label_multiple_pairs() -> None:
    assert _parse_code_label("433:IPCA,189:IGPM,190:IGPDI") == {
        "433": "IPCA",
        "189": "IGPM",
        "190": "IGPDI",
    }


def test_parse_code_label_strips_whitespace() -> None:
    # Spaces and tabs around items / inside pairs are all stripped.
    assert _parse_code_label(" 433 : IPCA ,  189:IGPM ") == {"433": "IPCA", "189": "IGPM"}


def test_parse_code_label_skips_empty_items() -> None:
    # Trailing comma must not introduce an empty entry.
    assert _parse_code_label("433:IPCA,,") == {"433": "IPCA"}


def test_parse_code_label_empty_string_returns_empty_map() -> None:
    assert _parse_code_label("") == {}


def test_parse_code_label_missing_colon_raises() -> None:
    with pytest.raises(ValueError, match="Expected 'CODE:LABEL'"):
        _parse_code_label("433_no_colon")


def test_parse_code_label_empty_code_raises() -> None:
    with pytest.raises(ValueError, match="Empty code or label"):
        _parse_code_label(":IPCA")


def test_parse_code_label_empty_label_raises() -> None:
    with pytest.raises(ValueError, match="Empty code or label"):
        _parse_code_label("433:")


def test_parse_code_label_duplicate_code_raises() -> None:
    with pytest.raises(ValueError, match="Duplicate series code"):
        _parse_code_label("433:IPCA,433:IGPM")


def test_parse_code_label_transposed_pair_raises() -> None:
    # A transposed 'LABEL:CODE' (e.g. 'IPCA:433') has a non-numeric code and
    # must fail loudly here, naming the offending item, instead of silently
    # parsing to {'IPCA': '433'} and failing downstream with a confusing error.
    with pytest.raises(ValueError, match="must be numeric") as exc_info:
        _parse_code_label("IPCA:433")
    assert "IPCA" in str(exc_info.value)


def test_parse_code_label_non_numeric_code_raises() -> None:
    with pytest.raises(ValueError, match="must be numeric"):
        _parse_code_label("433:IPCA,abc:IGPM")


def test_parse_code_label_rejects_unicode_digit_code() -> None:
    # Fullwidth digits pass str.isdigit() (and even int()), but are not valid
    # ASCII SGS/NCM ids — the isascii() guard must reject them. (RUF001 ambiguous-
    # unicode is globally ignored for the pt-BR typography this project uses.)
    assert "４３３".isdigit()
    with pytest.raises(ValueError, match="must be numeric"):
        _parse_code_label("４３３:IPCA")


# ─── COMEX code-length validation ───────────────────────────────────────────
# A wrong-width COMEX code passes _parse_code_label (numeric+ASCII only) but then
# matches ZERO rows in the ingest filter, silently skipping the chunk. The comex_*_map
# properties enforce the fixed widths (NCM=8, HS heading=4, HS chapter=2).
def test_comex_ncm_map_accepts_8_digit(settings_factory) -> None:
    assert settings_factory(comex_ncm_codes="80012100:ok").comex_ncm_map == {"80012100": "ok"}


def test_comex_ncm_map_rejects_wrong_length(settings_factory) -> None:
    with pytest.raises(ValueError, match=r"COMEX NCM code '8001210' has 7 digits; expected 8"):
        _ = settings_factory(comex_ncm_codes="8001210:short").comex_ncm_map


def test_comex_heading_map_rejects_non_4_digit(settings_factory) -> None:
    with pytest.raises(ValueError, match=r"COMEX HS heading code '440' has 3 digits; expected 4"):
        _ = settings_factory(comex_heading_codes="440:short").comex_heading_map


def test_comex_chapter_map_rejects_non_2_digit(settings_factory) -> None:
    with pytest.raises(ValueError, match=r"COMEX HS chapter code '4' has 1 digits; expected 2"):
        _ = settings_factory(comex_chapter_codes="4:short").comex_chapter_map


def test_comex_chapter_map_accepts_2_digit(settings_factory) -> None:
    assert settings_factory(comex_chapter_codes="44:madeira").comex_chapter_map == {"44": "madeira"}


# ─── default bucket derivation ──────────────────────────────────────────────
def _make_settings(**overrides: object) -> Settings:
    """Build a Settings instance without picking up the user's local .env."""
    base = {"gcp_project_id": "test-project", "_env_file": None}
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def test_default_bucket_derives_from_project_when_unset() -> None:
    s = _make_settings()
    assert s.gcs_bucket == "test-project-datalake"


def test_default_bucket_respects_explicit_value() -> None:
    s = _make_settings(gcs_bucket="my-custom-bucket")
    assert s.gcs_bucket == "my-custom-bucket"


def test_default_bucket_treats_empty_string_as_unset() -> None:
    # The validator checks `if not self.gcs_bucket`, so "" also triggers the default.
    s = _make_settings(gcs_bucket="")
    assert s.gcs_bucket == "test-project-datalake"


# ─── series-map properties ──────────────────────────────────────────────────
def test_inflation_series_map_parses_default() -> None:
    s = _make_settings()
    assert s.inflation_series_map == {"433": "IPCA", "189": "IGPM", "190": "IGPDI"}


def test_currency_series_map_parses_default() -> None:
    s = _make_settings()
    # Daily PTAX venda: SGS 1 = USD, 21619 = EUR.
    assert s.currency_series_map == {"1": "USD", "21619": "EUR"}


def test_inflation_series_map_reflects_override() -> None:
    s = _make_settings(bcb_inflation_series="999:CUSTOM")
    assert s.inflation_series_map == {"999": "CUSTOM"}


def test_currency_series_map_propagates_parse_errors() -> None:
    s = _make_settings(bcb_currency_series="bad-no-colon")
    with pytest.raises(ValueError, match="Expected 'CODE:LABEL'"):
        _ = s.currency_series_map


# ─── product_codes helper ───────────────────────────────────────────────────
def test_product_codes_splits_and_strips() -> None:
    s = _make_settings(ibge_product_codes=" 3405, 3435 ,3450 ")
    assert s.product_codes == ["3405", "3435", "3450"]


def test_product_codes_drops_empty_entries() -> None:
    s = _make_settings(ibge_product_codes="3405,,3435,")
    assert s.product_codes == ["3405", "3435"]


def test_product_codes_raises_when_empty() -> None:
    s = _make_settings(ibge_product_codes="  , ,")
    with pytest.raises(ValueError, match="IBGE_PRODUCT_CODES is empty"):
        _ = s.product_codes


# ─── defaults sanity ────────────────────────────────────────────────────────
def test_defaults_match_documented_values() -> None:
    s = _make_settings()
    assert s.bq_location == "US"
    assert s.bq_bronze_ibge_dataset == "bronze_ibge"
    assert s.bq_bronze_bcb_dataset == "bronze_bcb"
    assert s.bq_silver_dataset == "silver"
    assert s.bq_gold_dataset == "gold"
    assert s.ibge_table_id == "289"
    assert s.ibge_classification_id == "193"
    # IBGE_START_YEAR is intentionally None — the discover step must populate it.
    assert s.ibge_start_year is None
    # 1974 = the first PAM/PPM year: IGP-DI (since 1944) deflates 1974–1979 (v1.81.0).
    assert s.bcb_start_year == 1974


def test_get_settings_returns_settings_instance(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # get_settings() reads GCP_PROJECT_ID from the environment via pydantic-settings.
    # Chdir into an empty tmp dir so any developer-local .env can't bleed in.
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GCP_PROJECT_ID", "env-project")
    s = get_settings()
    assert isinstance(s, Settings)
    assert s.gcp_project_id == "env-project"


def test_get_settings_returns_fresh_instance_each_call(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """get_settings has no @lru_cache — each call re-reads the environment.

    This is intentional (see config.py); callers that want a singleton should
    keep their own reference rather than relying on caching here.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("GCP_PROJECT_ID", "first-project")
    first = get_settings()

    monkeypatch.setenv("GCP_PROJECT_ID", "second-project")
    second = get_settings()

    assert first.gcp_project_id == "first-project"
    assert second.gcp_project_id == "second-project"
    assert first is not second


# ─── get_credentials ────────────────────────────────────────────────────────
def test_get_credentials_returns_none_without_impersonation() -> None:
    s = _make_settings()
    assert get_credentials(s) is None


def test_get_credentials_builds_impersonated_creds() -> None:
    s = _make_settings(gcp_impersonation_sa="sa@test-project.iam.gserviceaccount.com")
    fake_source = MagicMock(name="source-creds")
    with (
        patch("google.auth.default", return_value=(fake_source, "test-project")) as default,
        patch("google.auth.impersonated_credentials.Credentials") as creds_cls,
    ):
        result = get_credentials(s)

    default.assert_called_once()
    creds_cls.assert_called_once()
    kwargs = creds_cls.call_args.kwargs
    assert kwargs["source_credentials"] is fake_source
    assert kwargs["target_principal"] == "sa@test-project.iam.gserviceaccount.com"
    assert kwargs["target_scopes"] == ["https://www.googleapis.com/auth/cloud-platform"]
    assert result is creds_cls.return_value


def test_get_credentials_uses_get_settings_when_none_passed() -> None:
    """When `settings` is None, get_credentials() falls back to get_settings()."""
    fake_settings = _make_settings(gcp_impersonation_sa="sa@x.iam")
    fake_source = MagicMock()
    with (
        patch.object(config_module, "get_settings", return_value=fake_settings) as gs,
        patch("google.auth.default", return_value=(fake_source, "p")),
        patch("google.auth.impersonated_credentials.Credentials") as creds_cls,
    ):
        get_credentials()

    gs.assert_called_once()
    creds_cls.assert_called_once()


def test_pam_counted_pair_is_a_count_not_a_weight():
    """40092 (Abacaxi) and 40145 (Coco-da-baía) are the two asterisked products of SIDRA 5457,
    and the asterisk is a unit warning: IBGE counts both in mil frutos in EVERY year while
    the API labels them "Toneladas" (verified 2026-10-21 against the Anuário Estatístico do
    Brasil 2023, whose tables print the same figures "em 1 000 frutos").

    Until v1.100.0 this test pinned the OPPOSITE ("lands in mass") from a check that compared
    the label to the API — a label that reads "Toneladas" even for the fruits IBGE counted until
    2000. What must hold is the pairing: both configured AND both declared a COUNT in the seed,
    never also given a weight-per-fruit era (the two seeds are disjoint)."""
    # _make_settings pins _env_file=None: the assertion is about the DECLARED default,
    # not about whatever the machine running the tests happens to have in its .env.
    codes = _make_settings().pam_product_codes_list
    assert "40092" in codes
    assert "40145" in codes

    import csv
    from pathlib import Path

    seeds = Path(__file__).resolve().parent.parent / "dbt/seeds"
    with (seeds / "pam_count_unit_products.csv").open(encoding="utf-8") as f:
        counted = {r["product_code"]: r for r in csv.DictReader(f)}
    assert {"40092", "40145"} <= set(counted)
    for code in ("40092", "40145"):
        assert counted[code]["family"] == "contagem"
        assert float(counted[code]["to_base"]) == 1000  # mil frutos -> frutos
    assert not ({r["product_code"] for r in _unit_eras()} & set(counted))


def test_env_example_lists_the_same_pam_codes_as_the_default():
    """.env.example drifted once already: it carried eight codes while the default
    carried ten, so anyone bootstrapping from it silently ingested a smaller product
    set than the deployed job."""
    from pathlib import Path

    # Anchored on the repo, not the cwd: pytest's working directory is not a contract.
    example_file = Path(__file__).resolve().parent.parent / ".env.example"
    line = next(
        ln for ln in example_file.read_text().splitlines() if ln.startswith("PAM_PRODUCT_CODES=")
    )
    example = sorted(c.strip() for c in line.split("=", 1)[1].split(",") if c.strip())
    assert example == sorted(_make_settings().pam_product_codes_list)


# ─── PAM fruit counted until 2000 (laranja, limão, tangerina, banana) ──────────
# SIDRA 5457 labels every quantity "Toneladas", but up to 2000 IBGE COUNTED these fruits
# (mil frutos; mil cachos for banana). Measured 2026-10-20 on the national series: laranja
# x0.16, limão x0.12, tangerina x0.19 and banana x10.9 between 2000 and 2001, with the yield
# moving the same way (115 mil -> 20 mil "kg/ha"). The pairing below is what keeps a fruit code
# from being ingested without its conversion.
_FRUIT_CODES = {"40151": "laranja", "40152": "limão", "40271": "tangerina", "40136": "banana"}


def _unit_eras() -> list[dict]:
    import csv
    from pathlib import Path

    seed = Path(__file__).resolve().parent.parent / "dbt/seeds/pam_fruit_unit_eras.csv"
    with seed.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_pam_citrus_codes_are_configured():
    """40151 Laranja · 40152 Limão · 40271 Tangerina — codes confirmed against the SIDRA
    classification-782 listing (`discover ibge-products --table-id 5457`), not typed from memory."""
    codes = _make_settings().pam_product_codes_list
    for code in ("40151", "40152", "40271"):
        assert code in codes


def test_pam_fruit_products_have_a_unit_era():
    """Adding a counted fruit WITHOUT its era would publish mil frutos as tonnes: a 6-11x error
    that the price detector tolerates (it accepts up to 100x) and that no label reveals."""
    eras = {r["product_code"] for r in _unit_eras()}
    configured = set(_make_settings().pam_product_codes_list)
    for code, nome in _FRUIT_CODES.items():
        assert code in configured, f"{nome} ({code}) is no longer in the PAM set"
        assert code in eras, f"{nome} ({code}) has no row in pam_fruit_unit_eras"
    # And the other direction: an era for a produto outside the set is dead data.
    assert eras <= configured


def test_pam_unit_eras_seed_is_well_formed():
    """Mirrors the dbt guards (assert_pam_unit_eras_no_overlap + the column tests), so a bad edit
    fails in `make test`, not only in the next prod build: overlapping ranges would fan the Silver
    rows out, and a non-positive weight would zero or negate a whole series."""
    rows = _unit_eras()
    assert len(rows) >= len(_FRUIT_CODES), "the seed reader found no rows"
    by_product: dict[str, list[tuple[int, int]]] = {}
    for r in rows:
        year_from, year_to, kg = int(r["year_from"]), int(r["year_to"]), float(r["kg_per_unit"])
        assert year_from <= year_to, r
        assert kg > 0, r
        assert r["reason"].strip(), (
            f"{r['product_code']}: the sentence a researcher would cite is empty"
        )
        # The break is documented at 2001: IBGE weighs from that year, so a range reaching
        # into it would convert a quantity that is already in tonnes.
        assert year_to <= 2000, r
        by_product.setdefault(r["product_code"], []).append((year_from, year_to))
    for code, ranges in by_product.items():
        ranges.sort()
        for (_, prev_to), (next_from, _) in itertools.pairwise(ranges):
            assert next_from > prev_to, f"{code}: overlapping year ranges {ranges}"


def test_pam_unit_era_factors_are_the_ones_ibge_printed():
    """Pins the four numbers to the table in IBGE's note (sidra.ibge.gov.br/content/documentos/
    pam/AlteracoesUnidadesMedidaFrutas.pdf, 'Peso mediano por unidade de fruto', kg per fruit):
    laranja 0.16 · limão 0.10 · tangerina 0.15 · banana (cacho) 10.20. A factor is a methodological
    decision; changing one must be a deliberate edit of this test, not a drive-by."""
    factors = {r["product_code"]: float(r["kg_per_unit"]) for r in _unit_eras()}
    assert factors == {"40151": 0.16, "40152": 0.10, "40271": 0.15, "40136": 10.20}


# ─── silvicultura helpers ─────────────────────────────────────────────────────
def test_silvicultura_product_codes_list_parses_and_rejects_empty() -> None:
    """An empty code list would make the SIDRA request return everything (or nothing);
    failing loudly beats ingesting a slice nobody chose."""
    from embrapa_dashboard.config import Settings

    s = Settings(
        gcp_project_id="p",
        gcs_bucket="b",
        silvicultura_product_codes=" 3455 , 3456 ",
        _env_file=None,
    )  # type: ignore[call-arg]
    assert s.silvicultura_product_codes_list == ["3455", "3456"]

    empty = Settings(
        gcp_project_id="p", gcs_bucket="b", silvicultura_product_codes="  ,  ", _env_file=None
    )  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="SILVICULTURA_PRODUCT_CODES"):
        _ = empty.silvicultura_product_codes_list


def test_silvicultura_variable_codes_is_quantity_then_value() -> None:
    """Order matters only for readability, but the PAIR is load-bearing: dropping 143
    would empty the value column for origem='silvicultura' with no error."""
    from embrapa_dashboard.config import Settings

    s = Settings(gcp_project_id="p", gcs_bucket="b", _env_file=None)  # type: ignore[call-arg]
    assert s.silvicultura_variable_codes == "142,143"
