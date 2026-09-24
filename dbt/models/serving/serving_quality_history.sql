{{
    config(
        materialized='incremental',
        full_refresh=false,
        on_schema_change='append_new_columns'
    )
}}

-- ────────────────────────────────────────────────────────────────────────────
-- serving_quality_history — one copy of serving_quality_by_source per build.
--
-- The quality donut is rebuilt from scratch on every `dbt build`, so until v1.91.0 the
-- only record of what it said LAST week was whatever someone had pasted into a comment.
-- That is how the 2026-06-26 calibration rates survived for three months after they
-- stopped being true: on 2026-06-27 the 1985 currency fix (80464a3) moved PAM's
-- PROBLEMÁTICO rows from 223 to 4 — the detector doing exactly its job — and nothing
-- noticed, because nothing kept the 223 to compare against
-- (docs/audits/qualidade_dados_audit_2026-09-24.md § A6).
--
-- This table keeps it. `embrapa doctor` (quality-drift) compares each build with the one
-- before and warns when a tag's share moves, so a change like that one is visible the day
-- it lands, whether it is a fix, a regression, or a release that meant to move the tags.
--
-- Append-only by construction:
--   • incremental with no unique_key — dbt-bigquery merges `on false`, which only inserts;
--   • full_refresh=false — `dbt build --full-refresh` (the prod workflow's opt-in input)
--     must NOT wipe the history, which is the one thing here that cannot be recomputed;
--   • current_timestamp() is constant within the statement, so every row of one build
--     shares one `built_at`, and `invocation_id` names the build.
-- ~31 rows per build (5 bancos × the tags each emits); the table stays tiny for decades.
-- ────────────────────────────────────────────────────────────────────────────

select
    current_timestamp()          as built_at,
    '{{ invocation_id }}'        as invocation_id,
    source,
    data_quality_flag,
    n_rows,
    share,
    value_share
from {{ ref('serving_quality_by_source') }}
