"""User feedback writer — the backend of the dashboard's "Reportar problema" button.

Append-only log of researcher-submitted feedback (bug / dúvida / sugestão), mirroring
the curation-log pattern: a typed BigQuery table in the ``research_inputs`` dataset, the
author taken from the IAP-verified header (never the service account), parameterized
DML. After the write, the report is best-effort forwarded to GitHub as an issue when
``feedback_github_repo`` + ``feedback_github_token`` are both configured — the
"loop fechado". The forward is non-fatal: a failure (or no configuration) is logged and
swallowed so it never blocks, nor loses, the durable BigQuery write. The dashboard runs
fully decoupled from the GitHub side.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping

from google.cloud import bigquery

from embrapa_dashboard.config import Settings, get_settings
from embrapa_dashboard.gcp.bigquery import ensure_dataset
from embrapa_dashboard.gcp.clients import resolve_bq_client
from embrapa_dashboard.serving import sql as sqlbuild
from embrapa_dashboard.serving.iap import author_email_from_headers

logger = logging.getLogger(__name__)

# Free-text caps — cheap guards against a runaway paste bloating the immutable audit
# row, not content restrictions (the message is open-vocabulary by design).
MAX_MESSAGE_LEN = 5000
MAX_URL_LEN = 4000
MAX_UA_LEN = 1000
# The client idempotency key doubles as the stored feedback_id; a 32-char uuid hex normally,
# 128 is generous headroom that still caps a pathologically long value.
MAX_CHANGE_ID_LEN = 128
MAX_VIEW_LEN = 200
MAX_BANCO_LEN = 100
MAX_VERSION_LEN = 50

# The UI offers exactly these report types; anything else is rejected (→ 400).
FEEDBACK_CATEGORIES = ("bug", "duvida", "sugestao")

_GITHUB_API = "https://api.github.com"
_GITHUB_TIMEOUT = (3.05, 8)  # (connect, read) seconds

# Explicit schema — autodetect is never used (it drifts silently across runs).
# `view_id` (not `view`) sidesteps the BigQuery reserved word.
FEEDBACK_LOG_SCHEMA = [
    bigquery.SchemaField("feedback_id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("category", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("message", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("url", "STRING", mode="NULLABLE"),
    bigquery.SchemaField("view_id", "STRING", mode="NULLABLE"),
    bigquery.SchemaField("banco", "STRING", mode="NULLABLE"),
    bigquery.SchemaField("app_version", "STRING", mode="NULLABLE"),
    bigquery.SchemaField("browser_info", "STRING", mode="NULLABLE"),
    bigquery.SchemaField("submitted_by", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("submitted_at", "TIMESTAMP", mode="REQUIRED"),
    bigquery.SchemaField("issue_url", "STRING", mode="NULLABLE"),
]


class FeedbackValidationError(ValueError):
    """Empty/over-length message or bad category — the route maps it to HTTP 400."""


def _clip(value: str | None, limit: int) -> str | None:
    """Trim + length-cap an optional free-text field; '' → None (stored as NULL)."""
    if not value:
        return None
    value = value.strip()
    return value[:limit] or None


def _md_inline(value: str) -> str:
    """Neutralise a client-controlled string for embedding in a Markdown line: strip
    newlines/backticks so it can neither break onto a fresh line nor open a code span, and
    wrap the result in an inline code span so any residual Markdown/@-mention is inert. All
    whitespace runs collapse to single spaces so a multi-line injection flattens cleanly."""
    flat = " ".join(value.replace("`", "ʼ").split())
    return f"`{flat}`" if flat else "`—`"


def _safe_http_url(value: str | None) -> str | None:
    """Return the URL only when it is a plain single-line http(s) URL; else None. Blocks a
    ``javascript:``/``data:`` scheme or an embedded-newline injection from reaching the
    GitHub issue body."""
    if not value:
        return None
    candidate = value.strip()
    if "\n" in candidate or "\r" in candidate:
        return None
    if not (candidate.startswith("http://") or candidate.startswith("https://")):
        return None
    return candidate


def _validate(category: str, message: str) -> str:
    # pt-BR: these messages surface to the researcher in the feedback dialog (via b.error).
    message = (message or "").strip()
    if not message:
        raise FeedbackValidationError("A mensagem é obrigatória.")
    if len(message) > MAX_MESSAGE_LEN:
        raise FeedbackValidationError(f"A mensagem excede {MAX_MESSAGE_LEN} caracteres.")
    if category not in FEEDBACK_CATEGORIES:
        raise FeedbackValidationError(
            f"Categoria inválida — use uma de: {', '.join(FEEDBACK_CATEGORIES)}."
        )
    return message


def _stored_feedback(bq: bigquery.Client, table_fqn: str, feedback_id: str) -> dict | None:
    """The stored feedback row for ``feedback_id`` (the idempotency key), echoed on a retried
    submit so it returns what was PERSISTED instead of inserting a duplicate. None if absent."""
    sql = f"""
        select feedback_id, category, message, url, view_id, banco, submitted_by, issue_url
        from `{table_fqn}` where feedback_id = @feedback_id limit 1
    """
    params = [bigquery.ScalarQueryParameter("feedback_id", "STRING", feedback_id)]
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    if not rows:
        return None
    r = rows[0]
    return {
        "feedback_id": r["feedback_id"],
        "category": r["category"],
        "message": r["message"],
        "url": r["url"],
        "view": r["view_id"],
        "banco": r["banco"],
        "submitted_by": r["submitted_by"],
        "issue_url": r["issue_url"],
        "deduped": True,
    }


def ensure_feedback_log_table(
    settings: Settings | None = None,
    client: bigquery.Client | None = None,
) -> str:
    """Create the feedback-log dataset + table if missing (idempotent, auto-heal)."""
    cfg = settings or get_settings()
    bq = client or resolve_bq_client(cfg)
    table_fqn = sqlbuild.table_ref(cfg, "bq_research_inputs_dataset", cfg.bq_feedback_log_table)
    ensure_dataset(bq, f"{cfg.gcp_project_id}.{cfg.bq_research_inputs_dataset}", cfg.bq_location)
    table = bigquery.Table(table_fqn, schema=FEEDBACK_LOG_SCHEMA)
    table.clustering_fields = ["category"]
    bq.create_table(table, exists_ok=True)
    logger.info("Feedback log ready at %s", table_fqn)
    return table_fqn


def _forward_to_github(
    cfg: Settings,
    *,
    category: str,
    message: str,
    submitted_by: str,
    url: str | None,
    view_id: str | None,
    banco: str | None,
) -> str | None:
    """Open a GitHub issue for the report ("loop fechado"). Best-effort: returns the
    issue URL on success, or None when GitHub is not configured or the call fails
    (logged, never raised — the feedback is already safe in BigQuery)."""
    repo, token = cfg.feedback_github_repo, cfg.feedback_github_token
    if not (repo and token):
        return None
    # Lazy import: keep the optional integration out of the webapi import path.
    import requests

    title = f"[Feedback/{category}] {message.splitlines()[0][:80]}"
    # SEC-1: the body renders as Markdown — fence the user message so it cannot inject
    # Markdown or @-mention pings; neutralise triple-backtick runs so it cannot break out.
    safe_message = message.replace("```", "ʼʼʼ")
    body = [
        "```text",
        safe_message,
        "```",
        "",
        "---",
        f"- **Reportado por:** {submitted_by}",
        f"- **Categoria:** {category}",
    ]
    # SEC-1 (cont.): view_id / banco / url are ALSO client-controlled — sanitise them the
    # same way so they cannot inject Markdown or @-mention pings into the issue body. url is
    # additionally required to be a plain http(s) URL (else it is dropped, not embedded).
    if view_id:
        body.append(f"- **Perspectiva:** {_md_inline(view_id)}")
    if banco:
        body.append(f"- **Banco:** {_md_inline(banco)}")
    safe_url = _safe_http_url(url)
    if safe_url:
        body.append(f"- **Reproduzir:** {_md_inline(safe_url)}")
    body.append("\n_Aberto automaticamente pelo canal de feedback do painel._")
    try:
        resp = requests.post(
            f"{_GITHUB_API}/repos/{repo}/issues",
            json={"title": title, "body": "\n".join(body), "labels": ["feedback", category]},
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=_GITHUB_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("html_url")
    except Exception as exc:
        logger.warning("Feedback → GitHub issue failed (repo=%s, %s): %s", repo, category, exc)
        return None


def record_feedback(
    *,
    category: str,
    message: str,
    headers: Mapping[str, str],
    url: str | None = None,
    view: str | None = None,
    banco: str | None = None,
    app_version: str | None = None,
    browser_info: str | None = None,
    author: str | None = None,
    change_id: str | None = None,
    settings: Settings | None = None,
    client: bigquery.Client | None = None,
) -> dict:
    """Append one feedback report (durably) and then best-effort open a GitHub issue.

    The author email is ``author`` when given (the route captures it once for the rate-limit),
    else read from the IAP-verified header in ``headers`` (never the service account). Raises
    :class:`FeedbackValidationError` (→ 400) on an empty/over-length message or bad category,
    and ``PermissionError`` / ``InvalidIapAssertionError`` (→ 401/403) when no trustworthy
    identity is present. The BigQuery write happens BEFORE the GitHub forward (audit FB-1), so a
    GitHub failure can never lose the report; ``issue_url`` is stamped back on success.
    """
    category = (category or "bug").strip().lower()
    message = _validate(category, message)
    cfg = settings or get_settings()
    url = _clip(url, MAX_URL_LEN)
    view_id = _clip(view, MAX_VIEW_LEN)
    banco = _clip(banco, MAX_BANCO_LEN)
    app_version = _clip(app_version, MAX_VERSION_LEN)
    browser_info = _clip(browser_info, MAX_UA_LEN)

    # Identity first — a missing/forged author raises here, before any write. Use the
    # caller-supplied author when given (the route captures it once for the rate-limit).
    submitted_by = author or author_email_from_headers(
        headers, dev_fallback=cfg.dev_author, audience=cfg.iap_audience
    )
    # A client-supplied change_id is the IDEMPOTENCY KEY (it doubles as the feedback_id); a
    # retried submit reusing it is deduped below. Absent → a fresh uuid, which can't pre-exist.
    supplied_key = (change_id or "").strip()
    if len(supplied_key) > MAX_CHANGE_ID_LEN:
        raise FeedbackValidationError(
            f"O identificador de alteração (change_id) excede {MAX_CHANGE_ID_LEN} caracteres."
        )
    feedback_id = supplied_key or uuid.uuid4().hex
    bq = client or resolve_bq_client(cfg)
    table_fqn = sqlbuild.table_ref(cfg, "bq_research_inputs_dataset", cfg.bq_feedback_log_table)
    ensure_feedback_log_table(cfg, bq)

    # Idempotency: a retried submit with the SAME key (a timeout that actually landed, or a
    # double-click) must NOT insert a second row NOR open a second GitHub issue. Echo the
    # stored report instead. Best-effort SELECT-then-INSERT (a true concurrent race could
    # still double-insert), mirroring the catalog writer — acceptable for an append-only log.
    if supplied_key:
        stored = _stored_feedback(bq, table_fqn, feedback_id)
        if stored is not None:
            logger.info("feedback: duplicate change_id %s ignored (%s)", feedback_id, category)
            return stored

    # FB-1: durable BigQuery write FIRST (issue_url NULL) so a GitHub hiccup can never lose
    # the report. The GitHub forward + the issue_url stamp happen afterwards.
    insert_sql = f"""
        insert into `{table_fqn}`
            (feedback_id, category, message, url, view_id, banco, app_version,
             browser_info, submitted_by, submitted_at, issue_url)
        values
            (@feedback_id, @category, @message, @url, @view_id, @banco, @app_version,
             @browser_info, @submitted_by, current_timestamp(), null)
    """
    insert_params = [
        bigquery.ScalarQueryParameter("feedback_id", "STRING", feedback_id),
        bigquery.ScalarQueryParameter("category", "STRING", category),
        bigquery.ScalarQueryParameter("message", "STRING", message),
        bigquery.ScalarQueryParameter("url", "STRING", url),
        bigquery.ScalarQueryParameter("view_id", "STRING", view_id),
        bigquery.ScalarQueryParameter("banco", "STRING", banco),
        bigquery.ScalarQueryParameter("app_version", "STRING", app_version),
        bigquery.ScalarQueryParameter("browser_info", "STRING", browser_info),
        bigquery.ScalarQueryParameter("submitted_by", "STRING", submitted_by),
    ]
    bq.query(
        insert_sql, job_config=bigquery.QueryJobConfig(query_parameters=insert_params)
    ).result()

    # The report is now safe in BigQuery — best-effort open a GitHub issue and stamp it back.
    issue_url = _forward_to_github(
        cfg,
        category=category,
        message=message,
        submitted_by=submitted_by,
        url=url,
        view_id=view_id,
        banco=banco,
    )
    if issue_url:
        try:
            bq.query(
                f"update `{table_fqn}` set issue_url = @issue_url where feedback_id = @feedback_id",
                job_config=bigquery.QueryJobConfig(
                    query_parameters=[
                        bigquery.ScalarQueryParameter("issue_url", "STRING", issue_url),
                        bigquery.ScalarQueryParameter("feedback_id", "STRING", feedback_id),
                    ]
                ),
            ).result()
        except Exception as exc:  # the issue exists; stamping it back is best-effort
            logger.warning(
                "feedback %s: issue created but issue_url stamp failed: %s", feedback_id, exc
            )

    logger.info(
        "feedback (%s) by %s%s", category, submitted_by, f" → {issue_url}" if issue_url else ""
    )
    return {
        "feedback_id": feedback_id,
        "category": category,
        "message": message,
        "url": url,
        "view": view_id,
        "banco": banco,
        "submitted_by": submitted_by,
        "issue_url": issue_url,
    }
