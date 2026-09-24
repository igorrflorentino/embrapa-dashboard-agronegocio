{#-
    Q1 outlier / problemático detection — IMPLIED-PRICE CONSISTENCY (validated on live
    BigQuery 2026-06-26; see PLANS/quality_outliers_and_visibility_gate.md).

    A data-entry typo breaks the implied price (value ÷ quantity) — which is scale-invariant,
    so it NEVER confuses a legitimate giant (São Paulo cana, a billion-dollar soy shipment)
    with an error. A pure magnitude fence can't make that distinction; this does:
      • PROBLEMÁTICO  — the implied price is >price_k× or <1/price_k× the product's median
                        price  ⇒  a value or quantity typo. Attributed to whichever measure
                        is the more anomalous (|excess|). Two-sided: 57% of the
                        PROBLEMATIC_QUANTITY rows have a quantity BELOW the median (the
                        weight=1 placeholder), the rest above (a weight with extra digits),
                        measured 2026-09-24 with the v1.90.0 floor.
      • OUTLIER       — the measure is in the product's high tail AND the price is within
                        price_k× of the median ⇒ "bem acima do esperado mas válido" (a real
                        big number). "High tail" is relative to the product's WHOLE history,
                        so the tier tracks the product's secular trend (PAM: 0,92% of scored
                        rows since 2010 vs 0,37% before).

    Measured rates, 2026-09-24, with the v1.90.0 detector (PROBLEMÁTICO rows / all Gold rows):
    PAM 6 (0,0002%), PEVS 30 (0,0022%), PPM 1, COMEX 25 (0,006%), COMTRADE 4.016 (0,195%).
    The rates this header and dbt_project.yml carried until v1.89.0 (COMEX 0,19%, PAM 0,03%, …)
    were never what this macro produced: COMEX/PEVS/COMTRADE were measured without the floor,
    and PAM/PPM before the 1985 currency fix (80464a3), when that year was 1.000× too small —
    the first defect this detector found (223 → 4 PAM rows once fixed), and a pipeline error,
    not a typo. Reconstructed from the Gold backups in
    docs/audits/qualidade_dados_audit_2026-09-24.md § A6.

    The value MUST be DEFLATED for IBGE — nominal manufactures a fake 20% near-zero-price tail
    (pre-1995 hyperinflation) — and by IGP-DI (val_real_igpdi_brl), the one BCB index that
    reaches every IBGE year. It was IPCA until v1.90.0; IPCA starts in 1980, so PAM/PPM 1974–1979
    (355.644 rows) could never be scored. One index for the whole window, never a coalesce of
    two: mixing IPCA and IGP-DI years would bend the very median the price is judged against.
    Trade uses nominal USD (no BR-inflation).

    Wiring per gold model (gated by var enable_quality_outliers, default false → these emit
    `cast(null as string)` and the data_quality_flag off-branch yields the legacy taxonomy):
      , scored as (
          select e.*,
      {{ quality_scored_bounds('<deflated_value>', '<quantity>') }}
          from <prior_cte> e
          window _qw as (partition by <product/code grouping>)
      )
    then `from {% if var('enable_quality_outliers', false) %}scored{% else %}<prior_cte>{% endif %}`
    and pass quality_qty_level(...) / quality_val_level(...) to data_quality_flag.
    Group grain: IBGE (product_code, family); trade (flow, code). Sample gate quality_min_obs.
-#}

{%- macro quality_scored_bounds(value_expr, qty_expr) -%}
        percentile_cont(safe.ln(safe_divide({{ value_expr }}, {{ qty_expr }})), 0.5) over _qw as _q_ln_med_price,
        percentile_cont(safe.ln({{ value_expr }}), 0.5)  over _qw as _q_ln_med_val,
        percentile_cont(safe.ln({{ value_expr }}), 0.75) over _qw as _q_p75_val,
        percentile_cont(safe.ln({{ qty_expr }}), 0.5)    over _qw as _q_ln_med_qty,
        percentile_cont(safe.ln({{ qty_expr }}), 0.75)   over _qw as _q_p75_qty,
        {#- The sample gate counts the SAME population the price median is taken over. It
            counted safe_divide(v, q) until v1.89.0, which includes value=0 rows whose ln is
            NULL — rows the median ignores — so a product could pass `quality_min_obs` on
            prices the median never saw. 0 rows affected when changed (measured 2026-09-24). #}
        count(safe.ln(safe_divide({{ value_expr }}, {{ qty_expr }}))) over _qw as _q_n
{%- endmacro -%}

{%- macro _q_price_dev(value_expr, qty_expr) -%}
abs(safe.ln(safe_divide({{ value_expr }}, {{ qty_expr }})) - _q_ln_med_price)
{%- endmacro -%}

{%- macro _q_val_excess(value_expr) -%}
safe_divide(safe.ln({{ value_expr }}) - _q_ln_med_val, nullif(_q_p75_val - _q_ln_med_val, 0))
{%- endmacro -%}

{%- macro _q_qty_excess(qty_expr) -%}
safe_divide(safe.ln({{ qty_expr }}) - _q_ln_med_qty, nullif(_q_p75_qty - _q_ln_med_qty, 0))
{%- endmacro -%}

{#- Guard shared by both level macros: need both measures positive, a price center, a sample big
    enough to trust the per-product distribution, AND a MATERIAL row. The magnitude floor is
    load-bearing — without it, tiny-municipality rounding (small value/qty → erratic implied price)
    over-flags: validated on prod 2026-06-26, PAM dropped 1.96% → 0.03% at the floor, PPM 1.65% →
    0.002%.

    MATERIAL BY EITHER MEASURE (v1.90.0). The floor tests the larger of the reported value and the
    EXPECTED value — the quantity priced at the product's median, q × exp(median ln price). Until
    v1.90.0 it tested the reported value alone, which made it blind to one side of the error it
    exists to catch: a typo that SHRINKS the value (digits dropped from it, or a weight inflated
    against a small value) pushed the row below the floor, and it was never scored. Measured
    2026-09-24, rows under the old floor with a price ≤ 1/100 of the median while their quantity
    was material: COMTRADE 1.030 (against 2.986 flagged), PEVS 24 (against 20 flagged).
    What this does NOT reopen is the rounding noise the floor was built for: rounding a small value
    moves the price by a fraction, never by the price_k× that PROBLEMÁTICO requires. Most of the
    rows it admits are simply examined and cleared ('OK') — the price is compared, and it holds. -#}
{%- macro _q_guard(value_expr, qty_expr) -%}
{{ value_expr }} is null or {{ value_expr }} <= 0 or {{ qty_expr }} is null or {{ qty_expr }} <= 0
       or _q_ln_med_price is null or _q_n < {{ var('quality_min_obs', 100) }}
       or greatest({{ value_expr }}, {{ qty_expr }} * exp(_q_ln_med_price)) < {{ var('quality_value_floor', 100000) }}
{%- endmacro -%}

{#- Attribution of a PROBLEMÁTICO row to value vs quantity. The two conditions are exact
    complements (>= vs >), so a row whose price is ≥ price_k× off ALWAYS lands in exactly one of
    the two — and that must hold even when an excess is NULL. `_q_*_excess` is NULL when the
    measure's p75 equals its median (a degenerate spread: nullif of a zero denominator), and a
    bare `abs(NULL) >= abs(x)` is NULL, which fails BOTH conditions: the price anomaly was then
    silently dropped and the row fell through to 'OK'. The coalesce reads "spread unknown" as
    "not the anomalous side", so the blame goes to the other measure (to the value when both are
    unknown). 0 rows reached this on 2026-09-24 in any banco — correct by data until v1.89.0,
    correct by construction since. -#}
{%- macro _q_blame_value(value_expr, qty_expr) -%}
abs(coalesce({{ _q_val_excess(value_expr) }}, 0)) >= abs(coalesce({{ _q_qty_excess(qty_expr) }}, 0))
{%- endmacro -%}

{%- macro quality_val_level(value_expr, qty_expr) -%}
{%- if not var('enable_quality_outliers', false) -%}cast(null as string)
{%- else -%}
case
  when {{ _q_guard(value_expr, qty_expr) }} then null
  when {{ _q_price_dev(value_expr, qty_expr) }} >= ln({{ var('quality_price_k', 100) }})
       and {{ _q_blame_value(value_expr, qty_expr) }} then 'problematic'
  when {{ _q_val_excess(value_expr) }} >= {{ var('quality_outlier_k', 4.0) }} then 'outlier'
  else null
end
{%- endif -%}
{%- endmacro -%}

{%- macro quality_qty_level(value_expr, qty_expr) -%}
{%- if not var('enable_quality_outliers', false) -%}cast(null as string)
{%- else -%}
case
  when {{ _q_guard(value_expr, qty_expr) }} then null
  when {{ _q_price_dev(value_expr, qty_expr) }} >= ln({{ var('quality_price_k', 100) }})
       and not ({{ _q_blame_value(value_expr, qty_expr) }}) then 'problematic'
  when {{ _q_qty_excess(qty_expr) }} >= {{ var('quality_outlier_k', 4.0) }} then 'outlier'
  else null
end
{%- endif -%}
{%- endmacro -%}

{#-
    "O detector CONSEGUIU escorar esta linha?" — o que separa `OK` (examinada e
    aprovada) de uma linha que ele nunca olhou.

    Antes disto, `_q_guard` devolvia null tanto para a linha limpa quanto para a que não
    pôde ser escorada, e o `else 'OK'` do data_quality_flag juntava as duas. Medido em
    produção 2026-09-06 na PAM: das 2.511.800 linhas "OK", apenas 844.250 (33,6%) tinham
    passado pelo detector. As outras eram célula vazia do cubo (valor e quantidade zero),
    valor abaixo do piso de materialidade, ou o próprio valor deflacionado AUSENTE
    (1974–1979, que o IPCA não alcançava) — todas apresentadas como verificadas.

    `quality_unscored_scope` escolhe o QUANTO disso vira uma marca própria:
      • 'absent' (padrão) — só a linha cujo valor escorado NÃO EXISTE. É a lacuna de
        infraestrutura: nem o detector nem o pesquisador têm o número. Eram 355.644 linhas
        em PAM+PPM enquanto o IBGE era escorado pelo IPCA; pelo IGP-DI (v1.90.0), 0.
      • 'all' — toda linha que a guarda bloqueou, incluindo o piso de materialidade e
        as células zeradas. Mais honesto e MUITO mais visível: move ~66% da PAM.
      • false — desliga (taxonomia anterior, `OK` como estava).
-#}
{%- macro quality_scored(value_expr, qty_expr) -%}
{%- set scope = var('quality_unscored_scope', 'absent') -%}
{%- if not var('enable_quality_outliers', false) or not scope -%}true
{%- elif scope == 'absent' -%}
({{ value_expr }} is not null)
{%- else -%}
(not ({{ _q_guard(value_expr, qty_expr) }}))
{%- endif -%}
{%- endmacro -%}
