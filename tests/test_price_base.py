"""The price base travels with the data (v1.105.0).

A deflated value is at the prices of ONE month — the latest month of its index when Gold was
built — and that month moves with every build that ingests a new one. Gold stamps it on every
row, the marts carry it, and each reader reads it back in the SAME select that sums the value;
the screen names it. These tests pin each link of that chain, and the one rule that holds it
together: absence is not a guess. No month, or two, is ``None`` — never a month picked.
"""

from __future__ import annotations

import datetime as dt
import re
from pathlib import Path

import pandas as pd
import pytest
import yaml

from embrapa_dashboard.serving import sql as sqlbuild
from embrapa_dashboard.webapi import format as fmt
from embrapa_dashboard.webapi import price_base

try:  # captured at import: the autouse fixture in conftest stubs it for every test
    from embrapa_dashboard.serving import gateway as _gateway

    _REAL_FETCH_TABLE_COLUMNS = _gateway.fetch_table_columns
except ImportError:  # the webapi extra (flask-caching) is not installed
    _gateway = None

_RAIZ = Path(__file__).resolve().parents[1]
_DBT = _RAIZ / "dbt"

OUTUBRO = dt.date(2026, 10, 1)

# The seven columns Gold stamps and the marts carry. Written out on purpose: the Python maps
# are DERIVED from these names, and a parity test that derived its expectation from the same
# maps would agree with any typo.
SETE = frozenset(
    {
        "ipca_base_month",
        "igpm_base_month",
        "igpdi_base_month",
        "cpi_base_month",
        "hicp_base_month",
        "fx_usd_base_date",
        "fx_eur_base_date",
    }
)
GOLD = (
    "gold_pevs_production",
    "gold_pam_production",
    "gold_ppm_production",
    "gold_comex_flows",
    "gold_comtrade_flows",
)
MARTS = (
    "serving_pevs_annual",
    "serving_pam_annual",
    "serving_ppm_annual",
    "serving_comex_annual",
    "serving_comtrade_annual",
    "serving_comex_seasonality",
)


# ── 1. Reading the base off a frame ────────────────────────────────────────────


def test_one_month_is_the_base_normalised_to_its_first_day():
    assert price_base.from_values([pd.Timestamp("2026-10-15")]) == price_base.PriceBase(OUTUBRO)
    # Every DATE shape pandas may hand over is the same month.
    for valor in (OUTUBRO, dt.datetime(2026, 10, 1, 0, 0), "2026-10-01", pd.Timestamp(OUTUBRO)):
        assert price_base.from_values([valor, valor]).month == OUTUBRO


@pytest.mark.parametrize(
    "meses",
    [
        [],
        [None, pd.NaT, float("nan")],
        # Two distinct months: one frame summed from rows corrected to two dates has no month
        # to name, and choosing one would date the other rows wrong.
        [OUTUBRO, dt.date(2026, 9, 1)],
    ],
)
def test_no_month_or_two_months_is_no_base(meses):
    assert price_base.from_values(meses) is None


def test_absent_rows_do_not_count_as_a_second_month():
    """A NULL month is a row with no corrected value (the deflator gap), not a disagreement."""
    assert price_base.from_values([OUTUBRO, None, pd.NaT]) == price_base.PriceBase(OUTUBRO)


def test_the_ptax_day_travels_with_the_month_and_two_days_are_no_base():
    dia = dt.date(2026, 11, 14)
    assert price_base.from_values([OUTUBRO], [dia, dia]) == price_base.PriceBase(OUTUBRO, dia)
    assert price_base.from_values([OUTUBRO], [pd.NaT]) == price_base.PriceBase(OUTUBRO, None)
    assert price_base.from_values([OUTUBRO], [dia, dt.date(2026, 11, 13)]) is None


def test_take_reads_the_base_and_drops_its_columns():
    df = pd.DataFrame(
        {
            "reference_year": [2024, 2025],
            "total_value": [1.0, 2.0],
            "price_base_month": [pd.Timestamp(OUTUBRO)] * 2,
            "price_base_fx_date": [pd.NaT] * 2,
        }
    )
    resto, base = price_base.take(df)
    assert base == price_base.PriceBase(OUTUBRO)
    assert list(resto.columns) == ["reference_year", "total_value"]
    assert "price_base_month" in df.columns  # the caller's frame is not mutated


def test_take_leaves_a_frame_without_the_columns_as_it_was():
    df = pd.DataFrame({"reference_year": [2024], "total_value": [1.0]})
    resto, base = price_base.take(df)
    assert base is None and resto is df
    assert price_base.take(None) == (None, None)
    vazio, base = price_base.take(pd.DataFrame(columns=["price_base_month", "total_value"]))
    assert base is None and list(vazio.columns) == ["total_value"]


# ── 2. What the screen prints ──────────────────────────────────────────────────


def test_the_phrase_names_the_month_in_full():
    assert price_base.prices_phrase(price_base.PriceBase(OUTUBRO)) == "a preços de outubro de 2026"
    nomes = [
        price_base.month_phrase(price_base.PriceBase(dt.date(2026, m, 1))) for m in range(1, 13)
    ]
    assert nomes == [f"{n} de 2026" for n in fmt.MONTH_NAME_PT]


def test_an_unknown_base_says_what_is_still_true():
    """Every corrected value IS at the prices of its index's latest month; the fallback just
    cannot name it. It must never become a guess ("de hoje") or disappear."""
    assert price_base.prices_phrase(None) == "a preços do mês mais recente do índice"


@pytest.mark.parametrize(
    ("coluna", "base", "sufixo"),
    [
        ("val_real_ipca_brl", price_base.PriceBase(OUTUBRO), " · a preços de outubro de 2026"),
        ("val_real_cpi_usd", None, " · a preços do mês mais recente do índice"),
        # A nominal value is at the prices of its own year; a quantity has no price.
        ("val_yearfx_brl", price_base.PriceBase(OUTUBRO), ""),
        ("qty_base", None, ""),
        (None, price_base.PriceBase(OUTUBRO), ""),
    ],
)
def test_label_suffix_only_dates_a_deflated_column(coluna, base, sufixo):
    assert price_base.label_suffix(coluna, base) == sufixo


def test_payload_is_null_unless_a_deflated_column_has_a_known_base():
    assert price_base.payload("val_real_ipca_brl", None) is None
    assert price_base.payload("val_yearfx_usd", price_base.PriceBase(OUTUBRO)) is None
    assert price_base.payload("val_real_ipca_brl", price_base.PriceBase(OUTUBRO)) == {
        "column": "val_real_ipca_brl",
        "month": "2026-10",
        "fxDate": None,
    }
    cruzada = price_base.PriceBase(OUTUBRO, dt.date(2026, 11, 14))
    assert price_base.payload("val_real_ipca_usd", cruzada)["fxDate"] == "2026-11-14"
    # The bare-frame readers never learn the column: the base still belongs to the request.
    assert price_base.payload(None, price_base.PriceBase(OUTUBRO))["column"] is None


# ── 3. The SQL asks for it in the same select ──────────────────────────────────


def test_every_deflated_column_has_a_base_and_only_the_cross_ones_a_ptax_day():
    """Derived from the column NAME, not from the maps under test: ``val_real_<idx>_<cur>``
    is cross when a Brazilian index is printed in another currency."""
    deflated = {c for c in sqlbuild.ALLOWED_VALUE_COLUMNS if c.startswith("val_real_")}
    assert set(sqlbuild.PRICE_BASE_MONTH_COLUMN) == deflated
    cruzadas = set()
    for coluna in deflated:
        indice, moeda = re.fullmatch(r"val_real_(\w+)_(brl|usd|eur)", coluna).groups()
        assert sqlbuild.PRICE_BASE_MONTH_COLUMN[coluna] == f"{indice}_base_month"
        if indice in {"ipca", "igpm", "igpdi"} and moeda != "brl":
            cruzadas.add(coluna)
            assert sqlbuild.PRICE_BASE_FX_COLUMN[coluna] == f"fx_{moeda}_base_date"
    assert set(sqlbuild.PRICE_BASE_FX_COLUMN) == cruzadas
    assert sqlbuild.PRICE_BASE_COLUMNS == SETE


@pytest.mark.parametrize("coluna", sorted(sqlbuild.PRICE_BASE_MONTH_COLUMN))
def test_the_select_fragment_per_column(coluna):
    trecho = sqlbuild._price_base_select(coluna, True)
    mes = sqlbuild.PRICE_BASE_MONTH_COLUMN[coluna]
    assert f"max({mes}) as price_base_month" in trecho
    fx = sqlbuild.PRICE_BASE_FX_COLUMN.get(coluna)
    esperado = f"max({fx})" if fx else "cast(null as date)"
    assert f"{esperado} as price_base_fx_date" in trecho
    assert sqlbuild._price_base_select(coluna, False) == ""


@pytest.mark.parametrize("coluna", ["val_yearfx_brl", "val_yearfx_usd", "qty_base"])
def test_nothing_is_asked_for_a_column_without_a_base(coluna):
    assert sqlbuild._price_base_select(coluna, True) == ""


def _builders():
    """Each grouped builder that sums a value column, with the minimum arguments it needs."""
    return {
        "production_overview": lambda **k: sqlbuild.production_overview("t", **k),
        "production_by_municipio_yearly": lambda **k: sqlbuild.production_by_municipio_yearly(
            "t", **k
        ),
        "products_by_municipio": lambda **k: sqlbuild.products_by_municipio("t", **k),
        "products_by_uf": lambda **k: sqlbuild.products_by_uf(
            "t", code_column="product_code", name_column="product_description", **k
        ),
        # The basket cube (/api/geo-yearly): its own request, cached apart from the snapshot.
        "production_by_uf_yearly": lambda **k: sqlbuild.production_by_uf_yearly("t", **k),
        "comex_by_uf_yearly": lambda **k: sqlbuild.comex_by_uf_yearly("t", **k),
        "comex_seasonality": lambda **k: sqlbuild.comex_seasonality("t", **k),
        "trade_overview": lambda **k: sqlbuild.trade_overview("t", code_column="ncm_code", **k),
        "trade_by_partner": lambda **k: sqlbuild.trade_by_partner(
            "t",
            partner_code_column="country_code",
            partner_name_column="country_name",
            code_column="ncm_code",
            **k,
        ),
        "trade_flows": lambda **k: sqlbuild.trade_flows(
            "t",
            origin_code_column="state_acronym",
            origin_name_column="state_acronym",
            dest_code_column="country_code",
            dest_name_column="country_name",
            code_column="ncm_code",
            **k,
        ),
    }


@pytest.mark.parametrize("nome", sorted(_builders()))
def test_each_builder_reads_the_base_in_the_select_that_sums(nome):
    montar = _builders()[nome]
    sem, _ = montar(value_column="val_real_ipca_brl")
    # Off by default: every existing caller builds the SQL it built before v1.105.0.
    assert "price_base" not in sem
    assert montar(value_column="val_real_ipca_brl", price_base=False)[0] == sem

    com, _ = montar(value_column="val_real_ipca_brl", price_base=True)
    assert "max(ipca_base_month) as price_base_month" in com
    # Same select: the base comes before the FROM that closes the select summing the value.
    assert com.index("price_base_month") < com.index("from `t`")
    # Grouped readers: max() of a per-build constant, never a group-by key.
    assert "price_base_month" not in com[com.index("group by") :]

    nominal, _ = montar(value_column="val_yearfx_usd", price_base=True)
    assert "price_base" not in nominal


# ── 4. The gateway fails closed ────────────────────────────────────────────────


@pytest.fixture
def gateway():
    if _gateway is None:
        pytest.skip("webapi extra not installed")
    return _gateway


def test_the_base_is_asked_only_once_the_table_carries_it(gateway, monkeypatch):
    monkeypatch.setattr(gateway, "fetch_table_columns", lambda *a: SETE | {"total_value"})
    assert gateway.price_base_enabled("bq_serving_dataset", "serving_pevs_annual") is True
    monkeypatch.setattr(gateway, "fetch_table_columns", lambda *a: SETE - {"hicp_base_month"})
    assert gateway.price_base_enabled("bq_serving_dataset", "serving_pevs_annual") is False


def test_an_unreadable_schema_is_a_no(gateway, monkeypatch, caplog):
    def falha(*a):
        raise RuntimeError("metadata unavailable")

    monkeypatch.setattr(gateway, "fetch_table_columns", falha)
    assert gateway.price_base_enabled("bq_serving_dataset", "serving_pevs_annual") is False
    assert "could not read the schema" in caplog.text


def test_no_metadata_call_is_spent_when_nothing_would_be_dated(gateway, monkeypatch):
    chamadas = []
    monkeypatch.setattr(gateway, "fetch_table_columns", lambda *a: chamadas.append(a) or SETE)
    assert gateway._asks_price_base(False, "val_real_ipca_brl", "d", "t") is False
    assert gateway._asks_price_base(True, "val_yearfx_usd", "d", "t") is False
    assert chamadas == []
    assert gateway._asks_price_base(True, "val_real_ipca_brl", "d", "t") is True
    assert chamadas == [("d", "t")]


def test_a_failed_schema_read_is_not_remembered(gateway, monkeypatch):
    """flask-caching stores only a RETURNED value: the error of the first read must not
    become the answer for a whole TTL. The real function runs here, on a SimpleCache."""
    from tests.test_serving import _bind_simplecache, _isolated_settings

    class _Campo:
        def __init__(self, name):
            self.name = name

    class _Tabela:
        schema = tuple(_Campo(c) for c in SETE)

    class _Cliente:
        def __init__(self):
            self.vezes = 0

        def get_table(self, ref):
            self.vezes += 1
            if self.vezes == 1:
                raise RuntimeError("transient")
            return _Tabela()

    cliente = _Cliente()
    monkeypatch.setattr(gateway, "fetch_table_columns", _REAL_FETCH_TABLE_COLUMNS)
    monkeypatch.setattr(gateway, "_client", lambda: cliente)
    monkeypatch.setattr(gateway, "get_settings", lambda: _isolated_settings())
    app, cache = _bind_simplecache()
    with app.app_context():
        cache.clear()
        assert gateway.price_base_enabled("bq_serving_dataset", "serving_pevs_annual") is False
        assert gateway.price_base_enabled("bq_serving_dataset", "serving_pevs_annual") is True
        # …and the success IS remembered: no third metadata call.
        assert gateway.price_base_enabled("bq_serving_dataset", "serving_pevs_annual") is True
    assert cliente.vezes == 2


def test_a_reader_selects_the_base_only_when_asked_and_carried(gateway, monkeypatch):
    from tests.test_serving import _bind_simplecache, _isolated_settings

    consultas = []
    monkeypatch.setattr(gateway, "run_query", lambda sql, params, **k: consultas.append(sql))
    monkeypatch.setattr(gateway, "get_settings", lambda: _isolated_settings())
    monkeypatch.setattr(gateway, "fetch_table_columns", lambda *a: SETE)
    app, cache = _bind_simplecache()
    with app.app_context():
        cache.clear()
        gateway.fetch_production_overview(value_column="val_real_ipca_brl")
        gateway.fetch_production_overview(value_column="val_real_ipca_brl", with_price_base=True)
        monkeypatch.setattr(gateway, "fetch_table_columns", lambda *a: frozenset())
        gateway.fetch_production_overview(value_column="val_real_igpm_brl", with_price_base=True)
    sem, com, mart_antigo = consultas
    assert "price_base" not in sem
    assert "max(ipca_base_month) as price_base_month" in com
    assert "price_base" not in mart_antigo


# ── 5. dbt ↔ Python: the seven columns exist where the readers ask for them ────


def _modelos(yml: Path) -> dict[str, set[str]]:
    doc = yaml.safe_load(yml.read_text(encoding="utf-8"))
    return {m["name"]: {c["name"] for c in (m.get("columns") or [])} for m in doc["models"]}


def _descricoes(yml: Path) -> list[str]:
    doc = yaml.safe_load(yml.read_text(encoding="utf-8"))
    return [
        str(c.get("description", ""))
        for m in doc["models"]
        for c in (m.get("columns") or [])
        if c["name"] in SETE
    ]


def test_every_gold_model_stamps_and_documents_the_seven():
    documentado = _modelos(_DBT / "models" / "gold" / "_gold.yml")
    for modelo in GOLD:
        texto = (_DBT / "models" / "gold" / f"{modelo}.sql").read_text(encoding="utf-8")
        faltam = {c for c in SETE if not re.search(rf"\b{c}\b", texto)}
        assert not faltam, f"{modelo}.sql não seleciona {sorted(faltam)}"
        # persist_docs drops a description whose column name is wrong without a word.
        faltam = SETE - documentado[modelo]
        assert not faltam, f"_gold.yml: {modelo} sem {sorted(faltam)}"


def test_every_mart_carries_the_seven_as_max():
    documentado = _modelos(_DBT / "models" / "serving" / "_serving.yml")
    for mart in MARTS:
        texto = (_DBT / "models" / "serving" / f"{mart}.sql").read_text(encoding="utf-8")
        faltam = {c for c in SETE if not re.search(rf"max\({c}\)\s+as\s+{c}\b", texto)}
        assert not faltam, f"{mart}.sql não carrega {sorted(faltam)} como max()"
        faltam = SETE - documentado[mart]
        assert not faltam, f"_serving.yml: {mart} sem {sorted(faltam)}"


def _emitem_valor_corrigido(pasta: Path) -> set[str]:
    """The models that OUTPUT a deflated column (``... as val_real_x``). A model that only uses
    one as a weight inside a ratio — ``serving_quality_by_source`` aliases it ``as value`` and
    publishes a share, which no base month can move — outputs nothing a base would date."""
    return {
        f.stem
        for f in pasta.glob("*.sql")
        if re.search(r"\bas\s+val_real_\w+", f.read_text(encoding="utf-8"), re.IGNORECASE)
    }


def test_the_lists_above_are_every_model_that_outputs_a_corrected_value():
    """GOLD and MARTS are written out (see SETE), so this derives them back from the SQL: the
    next data source's Gold or mart cannot ship a val_real column without its base because
    nobody remembered to add it to a list here (docs/adding_a_data_source.md § 8)."""
    assert _emitem_valor_corrigido(_DBT / "models" / "gold") == set(GOLD)
    assert _emitem_valor_corrigido(_DBT / "models" / "serving") == set(MARTS)


def test_the_single_value_test_covers_every_mart_and_column():
    texto = (_DBT / "tests" / "assert_price_base_single_valued.sql").read_text(encoding="utf-8")
    for nome in (*MARTS, *SETE):
        assert nome in texto, f"assert_price_base_single_valued não cobre {nome}"


def test_no_persisted_description_names_a_month():
    """The month changes with every build; written into a description that ``persist_docs``
    stores, it would also change the build fingerprint (v1.97.0) and turn every push into
    a build. The month lives in the DATA, never in the docs."""
    nomes = "|".join(fmt.MONTH_NAME_PT)
    mes = re.compile(rf"\b(?:{nomes}) de \d{{4}}\b|\b\d{{4}}-\d{{2}}(?:-\d{{2}})?\b", re.I)
    for yml in (
        _DBT / "models" / "gold" / "_gold.yml",
        _DBT / "models" / "serving" / "_serving.yml",
    ):
        for descricao in _descricoes(yml):
            assert not mes.search(descricao), f"{yml.name}: {descricao!r}"


# ── 6. Every label the BFF can print ───────────────────────────────────────────


def _convencoes():
    for currency in ("BRL", "USD", "EUR"):
        for correction in ("Nominal", *fmt.CORRECTION_ECONOMY):
            yield {"currency": currency, "correction": correction}


@pytest.mark.parametrize(
    "base", [None, price_base.PriceBase(OUTUBRO, dt.date(2026, 11, 14))], ids=["sem", "com"]
)
def test_every_label_names_its_base_and_none_says_today(base):
    """Every banco × currency × correction, with and without a known base: a deflated column
    ends with the base, a nominal one names none, and none of them says 'hoje' — the PTAX day
    and the base month are dates, and today is neither."""
    from embrapa_dashboard.webapi import seam
    from embrapa_dashboard.webapi.registries import BANCOS

    vistos = 0
    for banco in BANCOS:
        for conv in _convencoes():
            coluna, rotulo = seam.effective_value_column(banco, conv, base)
            assert "hoje" not in rotulo.lower(), rotulo
            if price_base.has_base(coluna):
                assert rotulo.endswith(price_base.label_suffix(coluna, base)), rotulo
                vistos += 1
            else:
                assert "a preços" not in rotulo, rotulo
    assert vistos  # the sweep reached the deflated branch at all
