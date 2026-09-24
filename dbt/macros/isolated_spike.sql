{#-
    ISOLATED_SPIKE — a large production registered in ONE year, with nothing the year before
    or after, that single-handedly makes its state's series jump (v1.92.0).

    Why a second detector. The implied-price detector (quality_outlier_ctes.sql) judges each
    row's PRICE, and a product booked under the wrong table at a market price has a perfectly
    good price. The case that motivated this: Ortigueira and Telêmaco Borba (PR) register
    native-forest timber in 2011 only — 200.000 and 123.500 m³, both at exactly R$ 100/m³ — with
    nothing before or after, while their planted-forest output runs to hundreds of millions a
    year. Probably planted wood booked as native extraction. Both rows were 'OK', and together
    they are 46,8% of Paraná's native timber that year: the state series goes 351 → 691 → 313
    mil m³. See docs/divergencias_de_conteudo.md.

    The rule, per (tabela, product, state, year), measured on prod 2026-09-24 before it was
    written (docs/audits/qualidade_dados_audit_2026-09-24.md):
      • ISOLATED — the row has a positive value and the same município × produto has none in
        the year before and the year after (no row, or a zero). A first or last survey year
        has no neighbor on one side and is never called isolated.
      • THE STATE JUMPS — the state's total that year is ≥ quality_spike_jump × the average of
        its totals the year before and after, and BOTH neighbors have production. A state
        whose whole series is sporadic (soy planted one year in Ceará) cannot jump: an
        isolated record there dominates the state trivially, and that is not an anomaly.
      • THE ISOLATED ROWS EXPLAIN IT — the isolated rows of that state-year, SUMMED, are
        ≥ quality_spike_explained of the excess over the neighbors' average. Summing is what
        catches neighbors that erred together: Ortigueira alone explains 56% of Paraná's 2011
        excess and Telêmaco Borba 34%; together, 90%.
      • MATERIAL — each flagged row is ≥ quality_value_floor, the same bar as the price
        detector.
    Measured: 138 rows in 60 state-year jumps (PEVS 81 / 45, PAM 52 / 11, PPM 5 / 4), among
    them 5 Pernambuco municípios with exactly 1.500 of pineapple in 2010 and 1.000.000 m³ of
    firewood in Paragominas in 2002.

    What it is NOT: proof of an error. Timber extraction is episodic, and a single large
    harvest can be real. The tag says "look before you use this year of this state's series".

    Wiring, per IBGE gold model (inside the enable_quality_outliers branch):
        enriched as (...)
        {{ isolated_spike_ctes('<deflated value>') }}      -- appends the CTEs, or nothing
        ...
        select e.*, <bounds>, {{ isolated_spike_select() }}
        from enriched e
        {{ isolated_spike_join('e') }}
    and pass spike='_q_isolated_spike' to data_quality_flag.
-#}

{%- macro isolated_spike_enabled() -%}
{{- return(var('enable_quality_outliers', false) and var('quality_isolated_spike', true)) -}}
{%- endmacro -%}

{%- macro isolated_spike_ctes(value_expr) -%}
{%- if isolated_spike_enabled() %},

_spike_rows as (
    select
        tabela,
        state_acronym,
        city_code,
        product_code,
        reference_year,
        {{ value_expr }} as _v,
        min(reference_year) over (partition by tabela) as _y0,
        max(reference_year) over (partition by tabela) as _y1,
        max(case when {{ value_expr }} > 0 then reference_year end) over (
            partition by tabela, city_code, product_code
            order by reference_year
            rows between unbounded preceding and 1 preceding
        ) as _prev_prod_year,
        min(case when {{ value_expr }} > 0 then reference_year end) over (
            partition by tabela, city_code, product_code
            order by reference_year
            rows between 1 following and unbounded following
        ) as _next_prod_year
    from enriched
),

_spike_isolated as (
    select
        *,
        coalesce(
            _v > 0
            and reference_year > _y0
            and reference_year < _y1
            and (_prev_prod_year is null or _prev_prod_year < reference_year - 1)
            and (_next_prod_year is null or _next_prod_year > reference_year + 1),
            false
        ) as _isolated
    from _spike_rows
),

_spike_state_year as (
    select
        tabela,
        product_code,
        state_acronym,
        reference_year,
        sum(case when _v > 0 then _v else 0 end) as _tot,
        sum(case when _isolated then _v else 0 end) as _iso_tot
    from _spike_isolated
    group by tabela, product_code, state_acronym, reference_year
),

_spike_jumps as (
    select
        cur.tabela,
        cur.product_code,
        cur.state_acronym,
        cur.reference_year
    from _spike_state_year as cur
    inner join _spike_state_year as prv
        on prv.tabela = cur.tabela
        and prv.product_code = cur.product_code
        and prv.state_acronym = cur.state_acronym
        and prv.reference_year = cur.reference_year - 1
    inner join _spike_state_year as nxt
        on nxt.tabela = cur.tabela
        and nxt.product_code = cur.product_code
        and nxt.state_acronym = cur.state_acronym
        and nxt.reference_year = cur.reference_year + 1
    where prv._tot > 0
        and nxt._tot > 0
        and cur._tot >= {{ var('quality_spike_jump', 1.5) }} * (prv._tot + nxt._tot) / 2
        and cur._iso_tot >= {{ var('quality_spike_explained', 0.5) }}
            * (cur._tot - (prv._tot + nxt._tot) / 2)
),

-- Prefixed columns: this joins back into a subquery that selects `e.*` and windows on
-- unqualified product_code / tabela, so no name here may shadow one of those.
_spike_flagged as (
    select
        iso.tabela as _s_tabela,
        iso.city_code as _s_city,
        iso.product_code as _s_product,
        iso.reference_year as _s_year
    from _spike_isolated as iso
    inner join _spike_jumps as jmp
        on jmp.tabela = iso.tabela
        and jmp.product_code = iso.product_code
        and jmp.state_acronym = iso.state_acronym
        and jmp.reference_year = iso.reference_year
    where iso._isolated
        and iso._v >= {{ var('quality_value_floor', 100000) }}
)
{%- endif -%}
{%- endmacro -%}

{%- macro isolated_spike_select() -%}
{%- if isolated_spike_enabled() -%}
(_sf._s_city is not null) as _q_isolated_spike
{%- else -%}
false as _q_isolated_spike
{%- endif -%}
{%- endmacro -%}

{%- macro isolated_spike_join(alias) -%}
{%- if isolated_spike_enabled() -%}
left join _spike_flagged as _sf
        on _sf._s_tabela = {{ alias }}.tabela
        and _sf._s_city = {{ alias }}.city_code
        and _sf._s_product = {{ alias }}.product_code
        and _sf._s_year = {{ alias }}.reference_year
{%- endif -%}
{%- endmacro -%}
