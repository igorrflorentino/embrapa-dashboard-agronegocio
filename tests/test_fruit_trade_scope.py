"""The trade scope of laranja / limão / tangerina / abacaxi + suco de laranja (v1.100.0).

Every code was read off the UNFILTERED raw COMEX archive (all NCMs, 1997-2026) and confirmed in
the UN HS reference — not typed from memory. What these tests pin is the pairing that keeps a
code from reaching Gold without a name, and the two places a bad edit would be silent.
"""

from __future__ import annotations

import csv
from pathlib import Path

from embrapa_dashboard.config import Settings

_REPO = Path(__file__).resolve().parent.parent
_PENDING = "texto oficial pendente"

# NCM (COMEX) -> the agrupamento it belongs to. The retired codes are listed on purpose: they are
# in the history (08052000 until 2016, 08053000 until 2008) and a series without them starts late.
_NCM = {
    "08051000": "laranja",
    "20091100": "laranja",
    "20091200": "laranja",
    "20091900": "laranja",
    "08052000": "tangerina",
    "08052100": "tangerina",
    "08052200": "tangerina",
    "08052900": "tangerina",
    "08053000": "limao",
    "08055000": "limao",
    "08043000": "abacaxi",
}
_HS6 = {
    "080510": "laranja",
    "200911": "laranja",
    "200912": "laranja",
    "200919": "laranja",
    "080520": "tangerina",
    "080521": "tangerina",
    "080522": "tangerina",
    "080529": "tangerina",
    "080530": "limao",
    "080550": "limao",
    "080430": "abacaxi",
}
_RETIRED_NCM = {"08052000", "08053000"}
_RETIRED_HS6 = {"080520", "080530"}


def _settings() -> Settings:
    # _env_file=None: assert the DECLARED default, not whatever .env the machine has.
    return Settings(_env_file=None, gcp_project_id="x")


def _rows(name: str, key: str) -> dict[str, str]:
    seed = _REPO / "dbt/seeds" / name
    with seed.open(encoding="utf-8") as f:
        return {r[key]: r for r in csv.DictReader(f)}


def test_fruit_ncms_are_in_the_comex_scope():
    scope = _settings().comex_ncm_map
    missing = sorted(set(_NCM) - set(scope))
    assert not missing, f"fruit NCMs missing from comex_ncm_codes: {missing}"


def test_fruit_hs6_are_in_the_comtrade_scope():
    scope = _settings().comtrade_cmd_map
    missing = sorted(set(_HS6) - set(scope))
    assert not missing, f"fruit HS6 missing from comtrade_cmd_codes: {missing}"


def test_the_scope_is_explicit_leaves_never_the_wide_headings():
    """0805 also holds toranja and 'outros citros'; 0804 tâmaras/figos/abacates/mangas; 2009 every
    juice. A heading here would put all of them in Gold with no agrupamento to explain them."""
    s = _settings()
    for heading in ("0804", "0805", "2009"):
        assert heading not in s.comex_heading_map
        assert heading not in s.comtrade_cmd_map


def test_every_scoped_code_has_a_description_before_it_reaches_gold():
    """dbt's assert_trade_codes_have_a_description compares the seed against the DATA; this one
    fails earlier (in `make test`) for the codes we KNOW are coming."""
    ncm = _rows("comex_ncm.csv", "co_ncm")
    hs = _rows("comtrade_hs.csv", "cmd_code")
    assert not [c for c in _NCM if not ncm.get(c, {}).get("ncm_description", "").strip()]
    assert not [c for c in _HS6 if not hs.get(c, {}).get("description", "").strip()]


def test_no_code_carries_the_pending_marker():
    """The four retired codes carried the marker for a day; MDIC's NCM.csv / NCM_SH.csv (which,
    unlike the Siscomex API, keep retired codes) gave their official text on 2026-10-21. A marker
    back in the seed means a description left provisional — the dbt warning lists it too."""
    ncm = _rows("comex_ncm.csv", "co_ncm")
    hs = _rows("comtrade_hs.csv", "cmd_code")
    assert not [c for c in _NCM if _PENDING in ncm[c]["ncm_description"]]
    assert not [c for c in _HS6 if _PENDING in hs[c]["description"]]


def test_the_retired_codes_use_mdics_own_wording():
    """Pin the four texts: they were copied from NO_NCM_POR / NO_SH6_POR, not paraphrased, and the
    old provisional wording (the parent's, with the 'Citrus limon' binomials) must not return."""
    ncm = _rows("comex_ncm.csv", "co_ncm")
    hs = _rows("comtrade_hs.csv", "cmd_code")
    assert ncm["08053000"]["ncm_description"] == "Limões e limas, frescos ou secos"
    assert hs["080530"]["description"] == "Limões e limas, frescos ou secos"
    assert ncm["08052000"]["ncm_description"].startswith("Tangerinas, mandarinas e satsumas;")
    assert hs["080520"]["description"].startswith("Tangerinas, mandarinas, satsumas;")
    for c in _RETIRED_NCM:
        assert "Citrus" not in ncm[c]["ncm_description"]


def test_env_example_carries_the_same_trade_scopes_as_the_defaults():
    """.env.example had already drifted (no coco, no caju): anyone bootstrapping from it ingested
    a smaller scope than the deployed job."""
    text = (_REPO / ".env.example").read_text(encoding="utf-8")
    s = _settings()

    def line(key: str) -> list[str]:
        raw = next(ln for ln in text.splitlines() if ln.startswith(key + "="))
        return sorted(p.strip() for p in raw.split("=", 1)[1].split(",") if p.strip())

    assert line("COMEX_NCM_CODES") == sorted(s.comex_ncm_codes.split(","))
    assert line("COMTRADE_CMD_CODES") == sorted(s.comtrade_cmd_codes.split(","))
