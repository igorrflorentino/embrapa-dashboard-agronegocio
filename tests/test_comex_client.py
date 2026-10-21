"""Tests for the Comex Stat client — two-phase: extract (CSV→raw Parquet) and
filter (raw Parquet→Bronze rows). HTTP/TLS mocked; parsing offline.

CSV shape pinned from the live validation (2026-05-30): ';'-separated, latin-1,
EXP 11 cols, IMP adds VL_FRETE/VL_SEGURO. The product filter is column-precise
on CO_NCM (a substring match would false-hit country code 445 for chapter 44).
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import responses

from embrapa_dashboard.comex import client

EXP_CSV = (
    '"CO_ANO";"CO_MES";"CO_NCM";"CO_UNID";"CO_PAIS";"SG_UF_NCM";"CO_VIA";"CO_URF";'
    '"QT_ESTAT";"KG_LIQUIDO";"VL_FOB"\n'
    '"2023";"02";"08012100";"10";"589";"AC";"07";"0230154";251580;251580;257813\n'
    '"2023";"11";"44072920";"16";"245";"RO";"01";"0917800";42;46165;41176\n'
    '"2023";"08";"16024900";"10";"445";"PA";"01";"0217800";5;5;100\n'
    '"2023";"03";"84139190";"10";"445";"RJ";"04";"0817700";107365;5;20\n'
)
IMP_CSV = (
    '"CO_ANO";"CO_MES";"CO_NCM";"CO_UNID";"CO_PAIS";"SG_UF_NCM";"CO_VIA";"CO_URF";'
    '"QT_ESTAT";"KG_LIQUIDO";"VL_FOB";"VL_FRETE";"VL_SEGURO"\n'
    '"2023";"02";"08012200";"10";"160";"SP";"01";"0817800";21;21;899;75;12\n'
    '"2023";"12";"62129000";"11";"160";"SP";"01";"0817800";33692;3295;29555;453;12\n'
)

NCM_CODES = {"08012100", "08012200"}
CHAPTER_CODES = {"44"}


def _csv_to_parquet_bytes(csv: str) -> bytes:
    """The verbatim raw Parquet (all NCMs, all source columns) for a CSV string."""
    df = pd.read_csv(BytesIO(csv.encode("latin-1")), sep=";", encoding="latin-1", dtype=str)
    buf = BytesIO()
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), buf, compression="snappy")
    return buf.getvalue()


# ─── file_url ────────────────────────────────────────────────────────────────
def test_file_url_export_and_import_prefixes() -> None:
    assert client.file_url("https://h/ncm/", "export", 2023) == "https://h/ncm/EXP_2023.csv"
    assert client.file_url("https://h/ncm", "import", 2026) == "https://h/ncm/IMP_2026.csv"


# ─── filter_products (Phase 2, from raw Parquet bytes) ───────────────────────
def test_filter_products_keeps_castanha_and_chapter44_only() -> None:
    df = client.filter_products(_csv_to_parquet_bytes(EXP_CSV), NCM_CODES, CHAPTER_CODES)
    assert set(df["CO_NCM"]) == {"08012100", "44072920"}


def test_filter_products_no_falsematch_country_code_on_chapter() -> None:
    df = client.filter_products(_csv_to_parquet_bytes(EXP_CSV), NCM_CODES, CHAPTER_CODES)
    assert "16024900" not in set(df["CO_NCM"])  # country 445, chapter 16
    assert "84139190" not in set(df["CO_NCM"])  # country 445, chapter 84


def test_filter_products_export_gets_union_columns_null_import_only() -> None:
    df = client.filter_products(_csv_to_parquet_bytes(EXP_CSV), NCM_CODES, CHAPTER_CODES)
    assert list(df.columns) == client.SOURCE_COLUMNS  # reindexed to 13-col union
    assert df["VL_FRETE"].isna().all()
    assert df["VL_SEGURO"].isna().all()


def test_filter_products_import_keeps_freight_and_insurance() -> None:
    df = client.filter_products(_csv_to_parquet_bytes(IMP_CSV), NCM_CODES, CHAPTER_CODES)
    assert set(df["CO_NCM"]) == {"08012200"}  # 62129000 (chapter 62) dropped
    row = df.iloc[0]
    assert row["VL_FRETE"] == "75"
    assert row["VL_SEGURO"] == "12"


def test_filter_products_heading_4digit_keeps_wood_via_prefix() -> None:
    # No chapter; heading 4407 (sawn wood) selects 44072920 by its first 4 digits,
    # alongside the exact castanha NCMs. This is the madeira-narrowing path.
    df = client.filter_products(_csv_to_parquet_bytes(EXP_CSV), NCM_CODES, set(), {"4407"})
    assert set(df["CO_NCM"]) == {"08012100", "44072920"}


def test_filter_products_heading_is_narrower_than_chapter() -> None:
    # A 4-digit heading is stricter than the 2-digit chapter: 4403 (logs) must NOT
    # match 44072920 (heading 4407), so with no NCM/chapter the frame is empty.
    df = client.filter_products(_csv_to_parquet_bytes(EXP_CSV), set(), set(), {"4403"})
    assert df.empty
    assert list(df.columns) == client.SOURCE_COLUMNS


def test_filter_products_empty_when_nothing_matches() -> None:
    csv = (
        '"CO_ANO";"CO_MES";"CO_NCM";"CO_UNID";"CO_PAIS";"SG_UF_NCM";"CO_VIA";"CO_URF";'
        '"QT_ESTAT";"KG_LIQUIDO";"VL_FOB"\n'
        '"2023";"08";"16024900";"10";"445";"PA";"01";"0217800";5;5;100\n'
    )
    df = client.filter_products(_csv_to_parquet_bytes(csv), NCM_CODES, CHAPTER_CODES)
    assert df.empty
    assert list(df.columns) == client.SOURCE_COLUMNS


# ─── _csv_to_parquet (Phase 1 verbatim conversion) ───────────────────────────
def test_csv_to_parquet_is_verbatim_all_rows_all_cols(tmp_path: Path) -> None:
    csv_path = tmp_path / "EXP_2023.csv"
    csv_path.write_text(EXP_CSV, encoding="latin-1")
    out = tmp_path / "EXP_2023.parquet"
    rows = client._csv_to_parquet(str(csv_path), str(out))
    assert rows == 4  # every row archived, no filtering
    df = pd.read_parquet(out)
    assert list(df.columns) == client.EXP_COLUMNS  # native 11 cols, not the union
    assert set(df["CO_NCM"]) == {"08012100", "44072920", "16024900", "84139190"}
    assert df["CO_MES"].iloc[0] == "02"  # zero-padding preserved as string


def test_csv_to_parquet_empty_download_is_transient_not_hard_failure(tmp_path: Path) -> None:
    """A truly-empty (0-byte) CSV — a transient empty 200 / truncated stream — raises
    pandas EmptyDataError, which the download retry policy can't catch. _csv_to_parquet
    reclassifies it as a retryable ComexTransientError instead of a hard chunk failure
    (COMEX-1)."""
    empty = tmp_path / "EXP_2023.csv"
    empty.write_bytes(b"")  # 0 bytes — no columns to parse
    out = tmp_path / "EXP_2023.parquet"
    with pytest.raises(client.ComexTransientError):
        client._csv_to_parquet(str(empty), str(out))


def test_csv_to_parquet_header_only_is_valid_zero_rows(tmp_path: Path) -> None:
    """A header-only CSV (valid, 0 data rows) is NOT an error — it converts to a 0-row
    parquet, distinguishing it from the truly-empty transient case above."""
    header_only = tmp_path / "EXP_2023.csv"
    header_only.write_text(";".join(client.EXP_COLUMNS) + "\n", encoding="latin-1")
    out = tmp_path / "EXP_2023.parquet"
    assert client._csv_to_parquet(str(header_only), str(out)) == 0


def test_extract_to_parquet_downloads_then_converts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, str] = {}

    def fake_download(url: str, dest_path: str) -> None:
        captured["url"] = url
        Path(dest_path).write_text(EXP_CSV, encoding="latin-1")

    monkeypatch.setattr(client, "_download_to_disk", fake_download)
    out = tmp_path / "raw.parquet"
    rows = client.extract_to_parquet("https://h/ncm", "export", 2023, str(out))
    assert captured["url"] == "https://h/ncm/EXP_2023.csv"
    assert rows == 4
    assert out.exists()


# ─── head_source (freshness) ─────────────────────────────────────────────────
@responses.activate
def test_head_source_returns_provenance_headers() -> None:
    responses.add(
        responses.HEAD,
        "https://h/ncm/EXP_2023.csv",
        status=200,
        headers={"ETag": '"abc"', "Last-Modified": "Wed, 07 Feb 2024 19:13:21 GMT"},
    )
    prov = client.head_source("https://h/ncm", "export", 2023)
    assert prov["source_url"] == "https://h/ncm/EXP_2023.csv"
    assert prov["source_etag"] == '"abc"'
    assert prov["source_last_modified"] == "Wed, 07 Feb 2024 19:13:21 GMT"


@responses.activate
def test_head_source_raises_transient_on_5xx() -> None:
    responses.add(responses.HEAD, "https://h/ncm/EXP_2023.csv", status=503)
    with pytest.raises(client.ComexTransientError):
        client.head_source.__wrapped__("https://h/ncm", "export", 2023)  # type: ignore[attr-defined]


# ─── download HTTP handling (retry stripped via __wrapped__) ──────────────────
@responses.activate
def test_download_to_disk_writes_body(tmp_path: Path) -> None:
    responses.add(responses.GET, "https://host/EXP_2023.csv", body=EXP_CSV, status=200)
    dest = str(tmp_path / "out.csv")
    client._download_to_disk.__wrapped__("https://host/EXP_2023.csv", dest)  # type: ignore[attr-defined]
    assert Path(dest).read_text(encoding="latin-1") == EXP_CSV


@responses.activate
def test_download_to_disk_raises_transient_on_5xx(tmp_path: Path) -> None:
    responses.add(responses.GET, "https://host/EXP_2023.csv", status=503)
    with pytest.raises(client.ComexTransientError):
        client._download_to_disk.__wrapped__(  # type: ignore[attr-defined]
            "https://host/EXP_2023.csv", str(tmp_path / "out.csv")
        )


@responses.activate
def test_download_to_disk_raises_permanent_on_404(tmp_path: Path) -> None:
    responses.add(responses.GET, "https://host/EXP_2099.csv", status=404)
    with pytest.raises(client.ComexRequestError) as exc:
        client._download_to_disk.__wrapped__(  # type: ignore[attr-defined]
            "https://host/EXP_2099.csv", str(tmp_path / "out.csv")
        )
    assert not isinstance(exc.value, client.ComexTransientError)  # 404 is not retried


def test_download_to_disk_deadline_covers_handshake_before_status_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wall-clock deadline must bound the request issuance / handshake /
    header trickle, not just the body-streaming loop: a slow response that has
    already blown the budget by the time headers return is rejected BEFORE the
    status_code check (so even a 200 with no body iteration fails)."""
    # monotonic advances past the deadline between deadline-compute and the
    # post-response check, simulating a slow handshake/header trickle.
    ticks = iter([0.0, client.DOWNLOAD_DEADLINE_S + 1.0])
    monkeypatch.setattr(client.time, "monotonic", lambda: next(ticks))

    class _Resp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def iter_content(self, chunk_size):  # pragma: no cover - must not be reached
            raise AssertionError("body stream must not start after deadline blown")

    monkeypatch.setattr(client.requests, "get", lambda url, **kw: _Resp())
    with pytest.raises(client.ComexTransientError) as exc:
        client._download_to_disk.__wrapped__(  # type: ignore[attr-defined]
            "https://host/EXP_2023.csv", str(tmp_path / "out.csv")
        )
    assert "budget" in str(exc.value)


# ─── TLS bundle ──────────────────────────────────────────────────────────────
def test_ca_bundle_appends_intermediate_to_certifi() -> None:
    import certifi

    path = client._ca_bundle()
    content = Path(path).read_text(encoding="ascii")
    assert client.SECTIGO_INTERMEDIATE_PEM.strip() in content
    assert client.SERPRO_INTERMEDIATE_PEM.strip() in content
    assert len(content) > len(Path(certifi.where()).read_text(encoding="ascii"))
    assert client._ca_bundle() == path  # cached


def test_vendored_intermediates_are_the_ones_proved() -> None:
    """The vendored certificates are public CA material downloaded over plain http (AIA), so the
    only thing that makes them trustworthy is that they are the ones whose chain was proved
    (leaf -> intermediate -> certifi root). Pin the SHA-256: any edit — a re-vendor included —
    has to repeat the proof and update the fingerprint on purpose."""
    import hashlib
    import ssl

    from embrapa_dashboard.comex import _ca

    def fingerprint(pem: str) -> str:
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest().upper()
        return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))

    assert fingerprint(_ca.SERPRO_INTERMEDIATE_PEM) == (
        "F2:70:95:D0:B4:0D:F7:65:59:94:04:01:1C:F8:B1:67:DA:06:26:0E:81:DD:A7:27:F1:63:EF:08:22:10:71:E4"
    )
    assert fingerprint(_ca.SECTIGO_INTERMEDIATE_PEM) != fingerprint(_ca.SERPRO_INTERMEDIATE_PEM)


def test_default_comex_host_is_the_one_whose_intermediate_is_vendored() -> None:
    """The default points at the CURRENT MDIC host. The legacy balanca.economia.gov.br leaf
    certificate expired (2026-10), so no bundle could verify it: defaulting back to it would
    silently stop every COMEX run."""
    from urllib.parse import urlparse

    from embrapa_dashboard.config import Settings

    host = urlparse(Settings.model_fields["comex_csv_base_url"].default).hostname
    assert host == "balanca.mdic.gov.br"


def test_ca_bundle_reads_non_ascii_certifi_comment_via_utf8(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """certifi's bundle is read/written as UTF-8: a CA root carrying a non-ASCII
    byte in a comment (issuer names occasionally do) must not blow up the way the
    old ascii codec would. The vendored intermediate is still appended."""
    fake_certifi = tmp_path / "cacert.pem"
    # 'ã' is non-ASCII; ascii decode would raise UnicodeDecodeError here.
    fake_certifi.write_text("# Autoridade Certificadora — São Paulo\nPEMBODY\n", encoding="utf-8")
    monkeypatch.setattr(client.certifi, "where", lambda: str(fake_certifi))
    monkeypatch.setattr(client, "_ca_bundle_path", None)  # bypass the process cache

    path = client._ca_bundle()
    content = Path(path).read_text(encoding="utf-8")
    assert "São Paulo" in content  # comment survived the round-trip
    assert client.SECTIGO_INTERMEDIATE_PEM.strip() in content


def test_download_passes_verify_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class _Resp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def iter_content(self, chunk_size):
            return iter([b"data"])

    def fake_get(url, **kwargs):
        captured.update(kwargs)
        return _Resp()

    monkeypatch.setattr(client.requests, "get", fake_get)
    client._download_to_disk.__wrapped__("https://host/EXP_2023.csv", str(tmp_path / "o.csv"))  # type: ignore[attr-defined]
    assert captured["verify"] == client._ca_bundle()


def test_download_wires_emit_retry_as_before_sleep() -> None:
    assert client._download_to_disk.retry.before_sleep is client._emit_retry  # type: ignore[attr-defined]


def test_emit_retry_emits_event_with_file_basename(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        client.observability, "emit", lambda event, **kw: events.append((event, kw))
    )
    retry_state = SimpleNamespace(
        args=("https://host/ncm/EXP_2023.csv", "/tmp/x.csv"),
        kwargs={},
        attempt_number=2,
        outcome=SimpleNamespace(exception=lambda: client.ComexTransientError("HTTP 503")),
    )
    client._emit_retry(retry_state)
    assert events[0][1]["series"] == "EXP_2023.csv"
    assert events[0][1]["attempt"] == 2


def test_head_source_wires_emit_retry_as_before_sleep() -> None:
    assert client.head_source.retry.before_sleep is client._emit_retry  # type: ignore[attr-defined]


def test_emit_retry_attributes_head_source_to_flow_year_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """head_source(base_url, flow, year) retries must be attributed to the actual
    (flow, year) file — args[0] is only the BASE url, so naming its last path
    segment would collapse every freshness probe into one bogus 'ncm' series."""
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        client.observability, "emit", lambda event, **kw: events.append((event, kw))
    )
    retry_state = SimpleNamespace(
        fn=client.head_source.__wrapped__,  # type: ignore[attr-defined]
        args=("https://host/ncm", "export", 2023),
        kwargs={},
        attempt_number=3,
        outcome=SimpleNamespace(exception=lambda: client.ComexTransientError("HTTP 503")),
    )
    client._emit_retry(retry_state)
    assert events[0][1]["series"] == "EXP_2023.csv"  # not 'ncm'
    assert events[0][1]["attempt"] == 3
