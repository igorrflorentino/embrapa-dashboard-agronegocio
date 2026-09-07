{#-
    Q1 outlier / problemático detection — IMPLIED-PRICE CONSISTENCY (validated on live
    BigQuery 2026-06-26; see PLANS/quality_outliers_and_visibility_gate.md).

    A data-entry typo breaks the implied price (value ÷ quantity) — which is scale-invariant,
    so it NEVER confuses a legitimate giant (São Paulo cana, a billion-dollar soy shipment)
    with an error. A pure magnitude fence can't make that distinction; this does:
      • PROBLEMÁTICO  — the implied price is >price_k× or <1/price_k× the product's median
                        price  ⇒  a value or quantity typo. Attributed to whichever measure
                        is the more anomalous (|excess|). Validated rate: COMEX 0.19%, PEVS 0.003%.
      • OUTLIER       — the measure is in the product's high tail AND the price is consistent
                        ⇒  "bem acima do esperado mas válido" (a real big number).

    The value MUST be DEFLATED for IBGE (val_real_ipca_brl) — nominal manufactures a fake 20%
    near-zero-price tail (pre-1995 hyperinflation). Trade uses nominal USD (no BR-inflation).

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
        count(safe_divide({{ value_expr }}, {{ qty_expr }})) over _qw as _q_n
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
    enough to trust the per-product distribution, AND a MATERIAL value. The magnitude floor is
    load-bearing — without it, tiny-municipality rounding (small value/qty → erratic implied price)
    over-flags: validated on prod, PAM dropped 1.96% → 0.03% at the floor, PPM 1.65% → 0.002%, while
    the real typos (weight=1 placeholders, dropped digits) stay flagged. Below the floor a row is
    low-stakes, so it is never flagged. -#}
{%- macro _q_guard(value_expr, qty_expr) -%}
{{ value_expr }} is null or {{ value_expr }} <= 0 or {{ qty_expr }} is null or {{ qty_expr }} <= 0
       or _q_ln_med_price is null or _q_n < {{ var('quality_min_obs', 100) }}
       or {{ value_expr }} < {{ var('quality_value_floor', 100000) }}
{%- endmacro -%}

{%- macro quality_val_level(value_expr, qty_expr) -%}
{%- if not var('enable_quality_outliers', false) -%}cast(null as string)
{%- else -%}
case
  when {{ _q_guard(value_expr, qty_expr) }} then null
  when {{ _q_price_dev(value_expr, qty_expr) }} >= ln({{ var('quality_price_k', 100) }})
       and abs({{ _q_val_excess(value_expr) }}) >= abs({{ _q_qty_excess(qty_expr) }}) then 'problematic'
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
       and abs({{ _q_qty_excess(qty_expr) }}) > abs({{ _q_val_excess(value_expr) }}) then 'problematic'
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
    (1974–1979, que o IPCA não alcança) — todas apresentadas como verificadas.

    `quality_unscored_scope` escolhe o QUANTO disso vira uma marca própria:
      • 'absent' (padrão) — só a linha cujo valor escorado NÃO EXISTE. É a lacuna de
        infraestrutura: nem o detector nem o pesquisador têm o número. 355.644 linhas
        em PAM+PPM.
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
