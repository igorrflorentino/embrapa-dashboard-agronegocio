{#-
    Set a 7-day default table expiration on every dbt-managed schema in the dev
    target. Sandboxed dev tables otherwise accumulate forever; the TTL means an
    abandoned dev branch self-cleans within a week.

    Runs as an `on-run-end` hook so it fires after dbt has already created the
    dev_silver / dev_gold schemas; `ALTER SCHEMA` would otherwise fail on a
    first build of a fresh project.

    The layer suffixes are read from the SAME env_var() defaults as the
    +schema config in dbt_project.yml (BQ_SILVER_DATASET / BQ_GOLD_DATASET /
    BQ_SERVING_DATASET), reconstructing the dev dataset name exactly as
    generate_schema_name does (<target.schema>_<custom_schema>). Hardcoding
    '_silver'/'_gold'/'_serving' would target the wrong (non-existent) datasets
    whenever an operator overrides one of those env vars.

    IDEMPOTENT: it reads the current TTL first and only ALTERs a schema whose TTL
    differs. `ALTER SCHEMA … SET OPTIONS` needs `bigquery.datasets.update`, which
    neither documented dev identity holds on the dbt_dev_* datasets (a human created
    them, and dataEditor / a dataset WRITER entry do not include it) — so an
    unconditional ALTER made every local dev build exit 2 AFTER
    `Done. PASS=… ERROR=0` (measured 2026-09-24). Reading SCHEMATA_OPTIONS needs only
    `bigquery.datasets.get`. A dataset whose TTL really is missing or different still
    gets the ALTER, and that still needs an identity allowed to update it (a dataset
    the dbt identity created itself it OWNS, so a fresh project works).

    Guarded by `execute`: at parse time run_query does not run, and the old version
    still logged "→ 7 days" as if it had.

    Intentionally a no-op in `prod` target — production datasets never expire.
-#}
{% macro apply_dev_ttl(days=7) -%}
    {% if target.name != 'dev' %}
        {{ log("apply_dev_ttl: target is " ~ target.name ~ ", skipping.", info=False) }}
    {% elif execute %}
        {% set schemas = [
            target.schema ~ '_' ~ env_var('BQ_SILVER_DATASET',  'silver'),
            target.schema ~ '_' ~ env_var('BQ_GOLD_DATASET',    'gold'),
            target.schema ~ '_' ~ env_var('BQ_SERVING_DATASET', 'serving'),
        ] %}
        {% set read_sql -%}
            select schema_name, option_value
            from `{{ target.project }}`.`region-{{ target.location or 'us' }}`.INFORMATION_SCHEMA.SCHEMATA_OPTIONS
            where option_name = 'default_table_expiration_days'
              and schema_name in ({% for s in schemas %}'{{ s }}'{{ ", " if not loop.last }}{% endfor %})
        {%- endset %}
        {% set current = {} %}
        {% for row in run_query(read_sql) %}
            {% do current.update({row[0]: row[1]}) %}
        {% endfor %}
        {% for schema in schemas %}
            {% if schema in current and current[schema] | float == days | float %}
                {{ log("apply_dev_ttl: " ~ schema ~ " already " ~ days ~ " days", info=True) }}
            {% else %}
                {% set sql -%}
                    alter schema `{{ target.project }}`.`{{ schema }}`
                    set options (default_table_expiration_days = {{ days }})
                {%- endset %}
                {% do run_query(sql) %}
                {{ log("apply_dev_ttl: " ~ schema ~ " → " ~ days ~ " days", info=True) }}
            {% endif %}
        {% endfor %}
    {% endif %}
{%- endmacro %}
