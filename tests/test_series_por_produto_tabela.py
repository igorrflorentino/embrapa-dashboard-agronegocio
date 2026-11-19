"""The per-product series answer over the SIDRA table the screen is scoped to (v1.108.4).

Until v1.108.4 ``seam._product_ts_filter_kwargs`` returned nothing for the production
bancos, so both reads of the per-product series — the snapshot's national ``productTS``
and the per-UF read behind ``/api/product-ts`` — summed EVERY SIDRA table while the total
beside them read one. Measured on prod 2026-11-19, IBGE PEVS 2024 under "Extração vegetal"
(``tabela=289``): total R$ 5,87 bi, per-product series R$ 43,00 bi (both halves). The
volume and mass of that total, which ``_with_overview_quantities`` sums FROM the series,
were both halves' as well: 273,8 mi m³ and 7.483 mil t under either half.

The v1.108.3 test comparing the two reads argument by argument (``test_product_ts_by_uf``)
could not see it: the two agreed with each other by omitting the same filter. The oracle
here is the rule the total's reader always followed.

Pinned:

* every reader a seam entry point calls that CAN filter by table (its signature has a
  ``tabela`` parameter) receives the summary's table. The rule is read off the gateway's
  signatures, so a reader added later is covered without editing this file;
* without a table (absent or ``'all'``) the per-product reads carry NO ``tabela`` key: the
  call, its SQL and its cache key stay as they were;
* the quantities of the total follow the table, because they are summed from the series;
* the trade bancos have no table axis and keep their own filters.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable

import pandas as pd
import pytest

BRL = {"currency": "BRL", "correction": "Nominal"}


def _seam():
    pytest.importorskip("flask_caching")
    from embrapa_dashboard.webapi import seam

    return seam


def _record_every_reader(
    seam, monkeypatch, answers: dict[str, Callable[[dict], pd.DataFrame]] | None = None
) -> tuple[list[tuple[str, dict]], set[str]]:
    """Swap EVERY ``gateway.fetch_*`` for a recorder of ``(name, bound arguments)``.

    Positional arguments are bound to their parameter names, so ``fetch_x(banco, ...)`` and
    ``fetch_x(source=banco, ...)`` record the same. Only the arguments actually PASSED are
    recorded (``bind_partial`` applies no default): that is what tells "left out" from
    "passed as None". ``answers`` returns a frame for a given reader; every other reader
    answers an empty one.

    Also returns the readers whose ORIGINAL signature has a ``tabela`` parameter — read
    before the swap, since the recorder's own signature says nothing.
    """
    answers = answers or {}
    calls: list[tuple[str, dict]] = []
    takes_tabela: set[str] = set()

    def offline(*args, **kwargs):
        raise AssertionError("a read reached BigQuery: every reader here must be recorded")

    monkeypatch.setattr(seam.gateway, "run_query", offline)
    for name in dir(seam.gateway):
        original = getattr(seam.gateway, name)
        if not name.startswith("fetch_") or not callable(original):
            continue
        signature = inspect.signature(original)
        if "tabela" in signature.parameters:
            takes_tabela.add(name)

        def recorder(*args, _name=name, _signature=signature, **kwargs):
            arguments = dict(_signature.bind_partial(*args, **kwargs).arguments)
            calls.append((_name, arguments))
            answer = answers.get(_name)
            return answer(arguments) if answer else pd.DataFrame()

        monkeypatch.setattr(seam.gateway, name, recorder)
    return calls, takes_tabela


# Every seam entry point that reads a production mart under the screen's filters. The
# readers are all recorded, so the codes only need to be well-formed.
_CITY = "1505502"
ENTRADAS: dict[str, Callable] = {
    "snapshot": lambda seam, s: seam.snapshot("ibge_pevs", BRL, s),
    "product_ts_by_uf": lambda seam, s: seam.product_ts_by_uf(
        "ibge_pevs", BRL, {**s, "states": ["PA"]}
    ),
    "product_uf_ranking": lambda seam, s: seam.product_uf_ranking("ibge_pevs", "3435", BRL, s),
    "geo_yearly": lambda seam, s: seam.geo_yearly("ibge_pevs", BRL, s),
    "geo_municipio_yearly": lambda seam, s: seam.geo_municipio_yearly(
        "ibge_pevs", BRL, {**s, "cityCodes": [_CITY]}
    ),
    "products_by_municipio": lambda seam, s: seam.products_by_municipio(
        "ibge_pevs", BRL, {**s, "cityCodes": [_CITY]}
    ),
    "products_by_uf": lambda seam, s: seam.products_by_uf(
        "ibge_pevs", {**s, "states": ["PA"]}, BRL
    ),
}


@pytest.mark.parametrize("tabela", ["289", "291"])
@pytest.mark.parametrize("entrada", sorted(ENTRADAS))
def test_every_reader_that_can_filter_by_table_gets_the_screens_table(monkeypatch, entrada, tabela):
    """A reader that CAN narrow to one SIDRA table must be told which. One left out answers
    over both halves of PEVS under a chip naming one, and the planted half is ~5× the
    native: the number is wrong while the label is right."""
    seam = _seam()
    calls, takes_tabela = _record_every_reader(seam, monkeypatch)
    ENTRADAS[entrada](seam, {"tabela": tabela, "basket": ["3435", "3457"]})
    filtraveis = [(name, arguments) for name, arguments in calls if name in takes_tabela]
    assert filtraveis, f"{entrada} called no reader that filters by table: the sweep is vacuous"
    esquecidos = sorted(
        {name for name, arguments in filtraveis if arguments.get("tabela") != tabela}
    )
    assert not esquecidos, f"{entrada}: answered over every table in {esquecidos}"


@pytest.mark.parametrize(
    "summary",
    [None, {}, {"tabela": "all"}, {"states": ["PA"]}, {"states": ["PA"], "tabela": "all"}],
)
def test_without_a_table_the_series_reads_are_unchanged(monkeypatch, summary):
    """No table chosen (absent or 'all') sums the survey's own total, as before v1.108.4. The
    per-product reads must not even carry the key, so their SQL and their cache key stay
    as they were."""
    seam = _seam()
    calls, _ = _record_every_reader(seam, monkeypatch)
    seam.snapshot("ibge_pevs", BRL, summary)
    seam.product_ts_by_uf("ibge_pevs", BRL, summary)
    series = [arguments for name, arguments in calls if name == "fetch_product_timeseries"]
    assert series, "no per-product read was made"
    assert all("tabela" not in arguments for arguments in series)


@pytest.mark.parametrize(
    "banco,summary,esperado",
    [
        ("ibge_pevs", {"tabela": "289"}, {"tabela": "289"}),
        ("ibge_pevs", {"tabela": "291"}, {"tabela": "291"}),
        ("ibge_ppm", {"tabela": "74"}, {"tabela": "74"}),
        ("ibge_pevs", {"tabela": "all"}, {}),
        ("ibge_pevs", None, {}),
        ("ibge_pam", {}, {}),
    ],
)
def test_the_helper_adds_the_table_only_when_one_is_chosen(banco, summary, esperado):
    assert _seam()._product_ts_filter_kwargs(banco, summary) == esperado


@pytest.mark.parametrize("banco", ["mdic_comex", "un_comtrade"])
def test_the_trade_bancos_have_no_table_axis(banco):
    """One table per trade banco: nothing to choose, so the key never reaches their readers,
    and their own filters are untouched."""
    kwargs = _seam()._product_ts_filter_kwargs(banco, {"tabela": "289", "flow": "export"})
    assert "tabela" not in kwargs
    assert kwargs["flow"] == "export"


def test_the_totals_quantities_follow_the_table(monkeypatch):
    """The total's volume and mass are summed FROM the per-product series
    (``_with_overview_quantities``), so a series over both halves made the headline
    quantities both halves' too — under "Extração vegetal", the whole survey's volume. With
    the table reaching the series, the quantities are the chosen half's."""
    seam = _seam()
    serie = pd.DataFrame(
        [
            # one native and one planted product, both in m³ (the 'volume' family)
            {
                "code": "3435",
                "tabela": "289",
                "reference_year": 2024,
                "family": "volume",
                "total_value": 1.0e9,
                "q_vol": 10.0e6,
                "q_mass": None,
            },
            {
                "code": "3457",
                "tabela": "291",
                "reference_year": 2024,
                "family": "volume",
                "total_value": 6.0e9,
                "q_vol": 200.0e6,
                "q_mass": None,
            },
        ]
    )

    def da_tabela(arguments: dict) -> pd.DataFrame:
        tabela = arguments.get("tabela")
        return serie if tabela is None else serie[serie["tabela"] == tabela]

    def total(arguments: dict) -> pd.DataFrame:
        linhas = da_tabela(arguments)
        return pd.DataFrame(
            {"reference_year": [2024], "total_value": [linhas["total_value"].sum()]}
        )

    _record_every_reader(
        seam,
        monkeypatch,
        {
            "fetch_product_timeseries": lambda a: da_tabela(a).reset_index(drop=True),
            "fetch_production_overview": total,
        },
    )
    volume = {
        tabela: seam.snapshot("ibge_pevs", BRL, {"tabela": tabela} if tabela else None)[
            "overview_ts"
        ]["q_vol"].tolist()
        for tabela in (None, "289", "291")
    }
    assert volume == {None: [210.0e6], "289": [10.0e6], "291": [200.0e6]}
