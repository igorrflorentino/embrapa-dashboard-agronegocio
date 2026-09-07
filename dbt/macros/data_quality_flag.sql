{#-
    Row-level data quality enum.
    A row is OK only when it has a quantity (in any family) and a nominal BRL
    value. `qty` is the native quantity (presence of a source reading) — NOT
    qty_base, so an unconvertible unit (family='desconhecida') still counts as
    "has a quantity"; convertibility is surfaced separately for curation.
-#}
{#-
    `qty_level` / `val_level` are 'problematic' | 'outlier' | null expressions from the
    implied-price detector (macros/quality_outlier_ctes.sql), default null. When
    enable_quality_outliers is OFF (default) this emits the LEGACY 4-value CASE byte-for-byte
    (the level args are ignored), so a build with the flag off is identical to before. When
    ON, the 4 new tiers slot in by precedence: missing > problemático(valor) >
    problemático(quantidade) > outlier(valor) > outlier(quantidade) > UNSCORED > OK. A row
    can't be an outlier on an absent measure, so the MISSING/INCOMPLETE checks always win.

    `scored` (macros/quality_outlier_ctes.sql · quality_scored) says whether the detector
    could RUN on this row. Without it, a row it never examined was labelled 'OK' — the
    same word as a row it examined and cleared. Defaults to "true", so a caller that does
    not pass it compiles exactly as before.
-#}
{% macro data_quality_flag(qty, val_brl, qty_level="cast(null as string)", val_level="cast(null as string)", scored="true") -%}
{%- if not var('enable_quality_outliers', false) -%}
    CASE
        WHEN {{ qty }} IS NOT NULL AND {{ val_brl }} IS NOT NULL THEN 'OK'
        WHEN {{ qty }} IS NOT NULL AND {{ val_brl }} IS NULL     THEN 'MISSING_VALUE'
        WHEN {{ qty }} IS NULL     AND {{ val_brl }} IS NOT NULL THEN 'MISSING_QUANTITY'
        ELSE 'INCOMPLETE'
    END
{%- else -%}
    CASE
        WHEN {{ qty }} IS NULL AND {{ val_brl }} IS NULL THEN 'INCOMPLETE'
        WHEN {{ val_brl }} IS NULL                       THEN 'MISSING_VALUE'
        WHEN {{ qty }} IS NULL                           THEN 'MISSING_QUANTITY'
        WHEN ({{ val_level }}) = 'problematic'           THEN 'PROBLEMATIC_VALUE'
        WHEN ({{ qty_level }}) = 'problematic'           THEN 'PROBLEMATIC_QUANTITY'
        WHEN ({{ val_level }}) = 'outlier'               THEN 'OUTLIER_VALUE'
        WHEN ({{ qty_level }}) = 'outlier'               THEN 'OUTLIER_QUANTITY'
        -- O detector não conseguiu examinar esta linha. Chega DEPOIS de todas as
        -- marcas positivas (uma linha escorada e marcada continua marcada) e ANTES
        -- do OK, que a partir daqui significa "examinada e aprovada" — e só isso.
        WHEN NOT ({{ scored }})                          THEN 'UNSCORED'
        ELSE 'OK'
    END
{%- endif -%}
{%- endmacro %}
