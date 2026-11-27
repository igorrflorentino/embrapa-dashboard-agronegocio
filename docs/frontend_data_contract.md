# Frontend data contract — Gold → snapshot mapping

**Audience:** anyone maintaining the dashboard's data-access layer (the Flask BFF
in `src/embrapa_dashboard/serving/` + `webapi/`). **Purpose:** spell out, field
by field, how the frontend's in-memory snapshot shapes (defined in
`dataStore.js` / `contracts.js`) are produced from the
**Gold** tables — so the BFF is a thin mapping and the UI lights up without rework.

> This is a **data contract**. **Update (2026-06 Dash→React migration):** both
> halves now EXIST — the BFF / data-access layer (`src/embrapa_dashboard/serving/`
> queries the pre-aggregated `serving` marts in `dbt/models/serving/` instead of
> loading Gold in memory) **and** the React SPA + Flask REST UI (`frontend/` +
> `src/embrapa_dashboard/webapi/`), live on Cloud Run behind IAP. What the
> backend guarantees is below: column names, **magnitudes**, units, and the few
> transforms (family vocab, region code, `world_exp`) the BFF must apply.

The single seam is `dataset_for(banco_id)` + the generic adapters + the
cross-source layer. Everything here feeds those; no view/chart/router changes.

---

## 1. Gold tables (the only things the BFF reads)

| Table | Grain | Backs |
|---|---|---|
| `gold.gold_pevs_production` | year × UF × city × product | IBGE PEVS (production) |
| `gold.gold_pam_production` | year × UF × city × product | IBGE PAM (production), with area/yield columns `area_planted_ha`, `area_harvested_ha`, `yield_kg_ha`, served via the `/api/productivity` seam |
| `gold.gold_comex_flows` | flow × year × **month** × NCM × country × UF × **via** | MDIC COMEX (Brazil trade) |
| `gold.gold_comtrade_flows` | flow × year × reporter × partner × cmd(HS6) | UN Comtrade (global trade) |
| `gold.gold_produto_agrupamento` | (source, code) → agrupamento_id | cross-source product bridge |
| `gold.gold_source_metadata` | one row per source | provenance for `dataStore.meta(id)` (§9) |

**Capabilities** (drive the brief's view gating; match `bancos.js`):

| bank | geo (UF) | monthly | product detail | flows/partners | productivity/yield |
|---|---|---|---|---|---|
| `ibge_pevs` | ✅ (UF+city) | ❌ annual | product_code | ❌ (production, not flows) | ❌ |
| `ibge_pam` | ✅ (UF+city) | ❌ annual | product_code | ❌ (production, not flows) | ✅ |
| `mdic_comex` | ✅ (UF origin) | ✅ (`reference_month`) | NCM8 | ✅ | ❌ |
| `un_comtrade` | ❌ (country↔country) | ❌ annual | HS6 | ✅ | ❌ |

→ COMTRADE has **no** `ufData` and **no** `monthlyData` (Geografia / Concentração-
geográfica / Sazonalidade resolve to "Não se aplica"). COMEX has both.

---

## 2. Magnitude & unit rules (read this first — it's what breaks integrations)

Gold stores **raw** numbers in base units. The BFF scales to the snapshot's display
magnitude. Get this wrong and axes/KPIs break.

| Gold column | Raw unit | Snapshot field | Display magnitude | BFF transform |
|---|---|---|---|---|
| `val_real_ipca_brl` (PEVS) | R$ | `overviewTS.v` | **R$ bi** | ÷ 1e9 |
| `val_yearfx_usd` (COMEX/COMTRADE) | US$ | `overviewTS.v` | **US$ bi** | ÷ 1e9 |
| `val_*` (productTS) | R$ / US$ | `productTS.v` | **mi** | ÷ 1e6 |
| `net_weight_kg` | kg | `q_mass` | **mil t** | ÷ 1e6 |
| `qty_base` (family=massa) | t | `q_mass` (PEVS) | **mil t** | ÷ 1e3 |
| `qty_base` (family=volume) | m³ | `q_vol` (PEVS) | **mi m³** | ÷ 1e6 |
| cross `exp_value`/`imp_value`/`world_exp` | US$ | `points[].v` | **US$ bi** | ÷ 1e9 |

> **A VALUE field may be `null`, and that is not zero (v1.49.0).** A banco's year range is
> not its MEASURE's year range: PAM/PPM start in 1974 but IPCA/IGP-DI only reach back to
> 1980, IGP-M to 1990 (the series starts in 1989-06 and a year needs its twelve months), USD to 1994 and EUR to **1999** — in EUR, 25 of PAM's 51 years have
> no value at all. The BFF serializes those as JSON `null` (`serializers._measure`), NOT
> 0.0, so the chart draws a GAP and the KPI formatters render '—'. Consumers must never do
> plain arithmetic on these fields: in JS `null * 1e9 === 0`, which silently re-fabricates
> the very zero the BFF just removed. Use the `seriesUtils` primitives
> (`scalePresent`/`ratioPresent`/`addPresent`/`deltaPct`). QUANTITY fields keep the old
> `_num` coercion — there a zero is measured (verified on prod: `qty_base` is NULL in 0 of
> 42.529 mart rows, against 13.430 for `val_real_ipca_brl`).
| cross `exp_weight` | kg | `points[].v` | **mil t** | ÷ 1e6 |

**Axis/ratio rule (brief §4):** two cross series share a Y-axis (or form a ratio)
**iff their `unit` strings are identical**. Keep display units consistent:
`'US$ bi'`, `'mil t'`, `'US$/kg'`. So `exp_value` and `world_exp` (both `'US$ bi'`)
mix; `exp_weight` (`'mil t'`) never mixes with them.

---

## 3. `dataset_for(banco_id)` → snapshot (brief §2)

### 3.1 `products` — `[{ code, tabela, name, unit, family }]`
`SELECT DISTINCT` the product key from the bank's Gold table.

| field | PEVS | COMEX | COMTRADE |
|---|---|---|---|
| `code` | `product_code` | `ncm_code` | `cmd_code` (HS6) |
| `tabela` | `289` / `291` | `ncm` | `hs` |
| `name` | `product_description` | `ncm_description` | `cmd_description` |
| `unit` | `base_unit` | `base_unit` | `base_unit` |
| `family` | `family` → **en** (see §7) | idem | idem |

> `code` MUST match the keys of `productTS`. They do — both come from the same Gold
> product column.

> **A code whose rows mix units names ONE of them, taken from one row (v1.108.8).** `unit`,
> `unit_native` and `family` leave together, as one
> `array_agg(struct(family, base_unit, unit_native) order by … limit 1)` per code
> (`sql.products`), in a total order: a known family before an unknown one (a row in
> "Sem unidade (N/A)" carries no quantity and says nothing of how the code is measured), then
> the family with the most rows, the family name, the unit with the most rows inside that
> family, then `base_unit` and `unit_native`. The rows are grouped by the three fields
> first, so two candidates always differ in one of them and nothing can tie. `name`,
> `tabela` and `measure_kind` stay `any_value`: they are constant per code (0 codes with
> more than one value in the five marts, measured on prod 2026-11-23).
>
> Until v1.108.8 each of the three was an independent `any_value`, which skips NULLs and
> returns whichever row BigQuery reads first. In the UN COMTRADE mart, where 99 of the 100
> codes mix units (measured on prod 2026-11-23: the real unit beside "Sem unidade (N/A)",
> and two real units in 20 codes), three identical reads with the result cache off gave
> 6 codes different answers. 9 codes came out with a combination none of their rows has:
> 440331–440334 and 440723 as family `desconhecida` with unit `m³`, which left them with no
> quantity axis at all. COMEX and the three IBGE marts have one unit per code, so the rule
> changes nothing there.

> **`tabela` travels for EVERY banco since v1.47.2** — including the single-table ones,
> where the value is constant (PAM `5457`, COMEX `ncm`, COMTRADE `hs`). It
> was emitted only for PEVS/PPM until then, behind a `_TABELA_SOURCES` set; that set was
> the last *"does this banco have a table?"* branch on the read path, and it is gone. A
> consumer reads the identity the same way in all five bancos — **constant is simpler than
> absent**.
>
> Why it matters even where it looks redundant: a produto's identity is
> `(banco, tabela, código)`, and in PEVS three products exist in BOTH halves under the same
> NAME with different codes (Carvão vegetal, Lenha, Madeira em tora). Without the field the
> Donut and the product comparison show two identical entries. `window.labelProductRows`
> uses it to suffix a name only when it repeats.
>
> The UI does **not** show a table filter for single-table bancos — a one-option segment
> would be noise. The symmetry is in the data and the code, not on screen.

> **Under a PEVS origin (`tb=289|291`) the COUNTS follow the origin (v1.108.5).** The list
> stays banco-wide (both halves), so the hero keeps the banco's denominator ("PRODUTOS
> 7 / 10"). ONE rule narrows it, `window.productsInOrigin(products, tabela)`
> (`ui/productOrigin.js`): `applyFilters` returns it as **`productUniverse`** and counts
> `selectedProducts` inside it, the filter chip counts over it ("Todos (7)"), and the picker
> offers only it. A table that no produto of the banco carries (a hand-edited `tb=289` on
> COMEX, whose readers ignore it) narrows nothing. Inside the menu the selection keeps what
> it holds of the other origin, unseen: switching the origin back and forth, or "Selecionar
> tudo" / "Limpar" / "Inverter" (which act on what is listed), lose nothing. Only the
> origin's part is counted and applied, and a URL basket that crosses the halves is counted
> the same way. Until v1.108.5 the NUMBERS followed the origin (v1.108.4) and the counts did
> not: under "Extração vegetal" the screen read "PRODUTOS 10 / 10", "LINHAS 1,4 mi de
> 1,4 mi", "Todos (10)" and "10 de 10 produtos", and the picker listed all 10.

> **Livestock (IBGE PPM) adds two things.** (1) `products` carries an extra
> **`measure_kind`** (`stock` | `flow`) — emitted ONLY for PPM (the gateway's
> `with_measure_kind` flag; the column lives only in `serving_ppm_annual`). `stock` =
> the herd (efetivo, a value-less headcount); `flow` = animal products (eggs/milk, with
> value). It lets the UI gate the **Rebanho** view and tell the two apart. (2) The
> **`count`** family (heads, eggs, PAM's counted fruits) gets its own quantity track,
> in mi un, and it is **never one total** (v1.108.0). Per product, one product counts one
> thing: `productTS` carries it as `q`, and `serving.product_uf` / `products_by_uf` /
> `products_by_municipio` as `q_count`. Every reader that sums ACROSS products (`ufData`,
> `ufYearly`, `municipioYearly`) returns two totals instead (`sql._count_split`):
> **`q_count_stock`**, the herd (`measure_kind = 'stock'`, PPM only), and
> **`q_count_flow`**, every other count. Nothing adds them, and `overviewTS` carries no
> count at all. Until v1.108.0 one `q_count` summed both, and the Geografia map put
> Mato Grosso 2025 at 3,88 bi "cabeças": 80,4 mi heads of eight species plus 3,80 bi eggs.
>
> One total can still hold products that count different things (eggs and fruits would
> share `q_count_flow` in a banco that had both), so `products` also carries
> **`unit_native`**, the unit as the source publishes it ("Cabeças", "Mil dúzias",
> "Mil frutos"): `unit` is the family's base, and every count's base is `un`. The client
> groups the basket's counts by total and by what they count (`countUnits.js`), names
> each group from it ("Efetivo (cabeças)", "Quantidade (ovos)") and refuses to draw a group
> whose products count different things, naming them instead.

### 3.2 `overviewTS` — annual `[{ y, v, q_mass, q_vol, q }]`
Aggregate to the year. **COMEX is monthly in Gold → SUM over months for the annual
overview** (monthly detail is served by `monthlyData`, §4.3).

| field | PEVS | COMEX | COMTRADE |
|---|---|---|---|
| `y` | `reference_year` | `reference_year` | `reference_year` |
| `v` | `SUM(val_real_ipca_brl)` ÷1e9 | `SUM(val_yearfx_usd)` ÷1e9 | `SUM(val_yearfx_usd)` ÷1e9 |
| `q_mass` | `SUM(qty_base WHERE family='massa')` ÷1e3 | `SUM(net_weight_kg)` ÷1e6 | `SUM(net_weight_kg)` ÷1e6 |
| `q_vol` | `SUM(qty_base WHERE family='volume')` ÷1e6 | — (omit) | — (omit) |
| `q` | = `q_mass` (back-compat alias) | idem | idem |

> Do **not** emit `q_vol` for COMEX/COMTRADE — those rows carry no volume family in
> the current scope. Only emit families that exist (group `qty_base` BY `family`).

### 3.3 `productTS` — `{ [code]: [{ y, v, q, vPriced, qPriced, family, rows }] }`
One annual series per product, keyed by the same `code` as `products`.

- `v` = `SUM(value)` ÷ 1e6 (**mi**) — PEVS `val_real_ipca_brl`, trade `val_yearfx_usd`.
  (`overviewTS.v` in bi = Σ `productTS.v` ÷ 1000 — keep the factor.) It sums EVERY row of
  the code-year, whatever its unit.
- `family` = the product's `family` (→ en), as `products` lists it, in EVERY point
  (v1.108.8) — in the snapshot and in `GET /api/product-ts` alike.
- `q` = the quantity in that family's display unit (mass → mil t, volume → mi m³,
  count → mi un), read from the family's own track (`q_mass` / `q_vol` / `q_count`, each a
  `SUM(qty_base)` over the rows of that family only). Rows in another unit add nothing to
  it. `null` — absent, never 0 — when the year has no quantity in the product's unit (a
  COMTRADE year with no row in it, or rows in it that carry no quantity), and for the
  families with no display scale (energia/área/desconhecida).
- `vPriced` / `qPriced` (v1.108.10) = the two halves of the implied price, over the SAME rows:
  the value (mi, like `v`) and the quantity (the scale of `q`) of the rows of the product's
  family track that carry BOTH measures (`priced_value_<track>` / `priced_qty_<track>`, from
  `sql._priced_sums`, one condition for both). The price is `vPriced ÷ qPriced`, never
  `v ÷ q`; `vPriced ÷ v` is how much of the year's value stands behind it. Both `null` —
  absent, never 0 — when no row of the year has both, and for the families with no display
  scale. PPM's herd rows have no value, so they add to neither half (the value side reads
  the flow rows only, like `v`).
- `rows` = `SUM(source_rows)`, the Gold rows behind the point (v1.108.9). Only the
  snapshot's read asks for it (`with_rows=True`); the per-UF read of §3.6 does not, since
  the counter reads the UF grid there. The hero's "Linhas" counter sums it (§3.5). Like `v`,
  it counts every row of the code-year, whatever its unit.

> **The point's family is the product's, not its year's (v1.108.8).** The SQL still ranks a
> family per year, by the same keys `products` ranks with and over the rows the series sums;
> the serializer keeps it only as the fallback for a code the list does not name. A year can
> be in another unit than its product under a reporter filter: with the United States as
> reporter, 440311 (listed in m³) has more rows in "Número de itens" than in m³ in
> 2018–2021. Each point used to carry its year's family (`any_value`), so those years could
> come out as counts. Perfil do produto, which labels the axis from `products` and plots each
> point's `q`, then drew item counts on the m³ axis, and `applyFilters`, which routes each
> point's `q` by the POINT's family, added them to the count total. Measured on prod
> 2026-11-23: in the Brazil scope the year's family is the product's in every code-year with
> a known unit. It is `desconhecida` in 3 of 1.404 code-years (Brazil) and 32 of 1.792
> (every reporter).

> **Why the price has its own pair (v1.108.10).** `v` covers every row and `q` only the rows
> in the product's unit, so `v ÷ q` — what Perfil do produto drew until v1.108.10 — divided
> more rows than the quantity covers wherever a year mixes units: the shape CLAUDE.md calls
> *"the two halves of a ratio must cover the same rows"*. Measured on prod 2026-11-23 with the
> readers' own SQL (COMTRADE, export + import, nominal US$):
> - Brazil scope: 15 of 1.401 priced code-years were above 1,5× (38 above 1,1×, 2,11% of the
>   value). Worst, 200919 in 2002: US$ 69.906/t before, US$ 5.649/t now, with 8,08% of the
>   year's value behind it;
> - every reporter: 81 of 1.760 above 1,5× and 227 above 1,1×, holding 7,09% of the value.
>   Worst, 440310 in 2022: US$ 52.514/m³ before (3.158×), US$ 16,63/m³ now, over 0,03% of
>   the value. The three code-years v1.108.8 gave a quantity axis: 440332/2000 7,4×,
>   440333/2001 367×, 440334/2000 315×.
>
> In all 227, most of the excess was value in rows without the product's unit, not rows in it
> without a quantity. Now Perfil do produto and the per-product CSV
> (`preco_implicito_<moeda>`, `parcela_do_valor_no_preco`) divide `vPriced ÷ qPriced`, and a
> year whose `vPriced ÷ v` is below 0,9 (`window.PRICED_SHARE_MIN`, shared with the
> partners' `pricedShare`, §4.2) is named on screen with its share — 36 code-years in
> the Brazil scope, 218 over every reporter. In PEVS, PAM, PPM and COMEX the two forms give
> the same number (0 code-years differ under the nominal, IPCA and IGP-DI columns, measured
> the same day), so there the change is one of construction. The pair reads no column the
> series did not already read: every read processes the same bytes as before.
> The per-product CSV writes an absent quantity as an empty cell (until v1.108.10,
> `(d.q || 0)` wrote 0).

The snapshot's series are **national**: the marts carry a UF grain and the snapshot sums it
away. Under a UF subset `applyFilters` swaps them for the selected UFs' own series from
`GET /api/product-ts` (§3.6, v1.108.3), so no screen draws this national one under a
geography filter. Until v1.108.3 four perspectives did: Pará's Leite stacked at Brazil's
~R$ 90 bi under a "1 UF" chip, beside a Pará total of R$ 1,6 bi.

Both reads of the series, this national one and the per-UF one, follow the screen's SIDRA
table (`tabela`, the `tb` chip) since v1.108.4. Every other production read of the snapshot
already did. Until then neither passed it. Under "Extração vegetal" the PEVS series summed
BOTH halves of the survey beside a total that read one: R$ 43,00 bi of series under a
R$ 5,87 bi total in 2024, measured on prod 2026-11-19. The `q_mass`/`q_vol` of `overviewTS`
are summed FROM these series (`seam._with_overview_quantities`), so under either half they
were the whole survey's. Without a table (absent or `all`) the read carries no `tabela`
key, and its SQL and cache key are unchanged.

### 3.4 `ufData` — COMEX + PEVS only (`geo` capability)
`[{ uf, name, region, col, row, value, q_mass, q_vol, q_count_stock, q_count_flow }]`,
grouped by UF. The two count totals are §3.1's: the herd and every other count, never
added.

| field | source |
|---|---|
| `uf` | `state_acronym` |
| `name` | `state_name` |
| `region` | `region` → **abbrev** (see §7): Norte→`N`, Nordeste→`NE`, Centro-Oeste→`CO`, Sudeste→`SE`, Sul→`S` |
| `col`, `row` | **frontend's** `frontend/src/ui/data.js` `UF_DATA` tile-map — NOT in Gold; the BFF copies the grid |
| `value` | `SUM(val_yearfx_usd)` (COMEX) / `SUM(val_real_ipca_brl)` (PEVS) |
| `q_mass` | `SUM(net_weight_kg)` (COMEX) / `SUM(qty_base WHERE family='massa')` (PEVS) |
| `q_vol` | `SUM(qty_base WHERE family='volume')` |

> **COMTRADE → do not produce `ufData`** (no Brazilian UF; `geo` absent in `bancos.js`).

### 3.5 `quality` — `[{ id, label, color, count, share }]`
`GROUP BY data_quality_flag`.

- `id` = `data_quality_flag` (see §7 for the exact id set — **not** the brief's
  example `ESTIMATED`/`OUTLIER`).
- `count` = row count; `share` = count ÷ total (Σ ≈ 1).
- `label`, `color` = mapped by the React frontend from `id` (keep the palette in
  the frontend; backend ships only `id`+`count`).

**`qualityByProduct` — `[{ code, tabela, name, rows, <flag id>: share, … }]`**, one entry
per produto (matched on `(code, tabela)`, its identity), ranked by `rows`; banco-wide, like
`quality`. The flag shares divide by `rows`, and since v1.108.5 `rows` itself travels too.
`_shares.productShare` is the selection's share of the banco's ROWS (Σ `rows` of the
selected produtos ÷ Σ `rows`), no longer its share of PRODUCTS, because products are far
from even (prod, 2026-11-23): a COMEX NCM code holds from 1 to 32,549 of the 496,160 rows
the panel reads; PAM's açaí, which starts in 2015, 60,557 beside 257,294 for most crops; the
3 PEVS silvicultura produtos are 3 of 10 but 20.6% of the rows. Σ `rows` equals Σ
`quality[].count`, and every `products` entry finds its `rows` by `(code, tabela)` (checked
in all five bancos, prod 2026-11-23, PPM's two tables included). A payload without `rows`
falls back to the count share. Since v1.108.9 the share only backs the counter's fallback
estimate (below).

**The hero's "Linhas" counter COUNTS (v1.108.9).** It shows `applyFilters.rowsInView`, the
sum of `rows` over the points of `filtered.ts`, the series the screen draws, which is already
cut to the selection: produtos, period and territory. Every read that can feed `ts` carries
the Gold rows behind each of its points:

| `ts` comes from | read | `rows` is |
|---|---|---|
| no UF subset, no basket (or a basket whose UF cube is not in yet) | snapshot `productTS` (§3.3), summed over the selected produtos | `SUM(source_rows)` |
| a UF subset, no basket | snapshot `ufYearly` | `SUM(source_rows)` |
| a basket, with or without a UF subset | `GET /api/geo-yearly` (§3.6) | `SUM(source_rows)` |
| a sub-UF recorte | `POST /api/municipio-yearly` (§3.6) | `count(*)` on Gold |

A mart's `source_rows` is the `count(*)` of the Gold rows it folded, so the sum equals Gold's
`count(*)` under the same visibility gate (`tests/test_source_rows.py` derives the five marts
from the gateway and fails if one stops carrying it). The sum is STRICT (`addCount` in
`dataFilters.js`): one point without a count makes the whole count `null`, never a smaller
number. A value total is lenient on purpose (summing the present ones is the right reading);
a count that skipped a point would be a wrong number, not a partial one. A produto with no
point in a year adds 0: the marts hold only the (produto, year) groups that exist.

Checked against prod Gold `count(*)` on 2026-11-23, counter = Gold in every case:

| recorte | before (estimate) | counted |
|---|---|---|
| PAM, açaí, 1990–2000 (açaí starts in 2015) | 13 mil | 0 |
| PEVS, Pará, 2010–2020: both origins / extração / silvicultura | 14 mil / – / 3 mil | 11,170 / 10,801 / 369 |
| PEVS, Portel + Breves, every year | 497 | 560 |
| COMEX, 44079990, export, 2015–2024, Pará | 402 | 1,716 |
| COMTRADE, the default (Brazil as reporter, export + import) | 2,6 mi | 36,963 |

**What the count follows.** Period, produtos (the basket) and industrialization level (`ni`)
in every banco; the PEVS origin (`tb`) on every read of the table above; UFs and every sub-UF
level down to the município in the IBGE bancos; UFs and flow (`fx`) in COMEX; flow, partners
and reporters in COMTRADE (the national path, whose reporter pin is Brazil by default). **Not
the data-quality selection**, by a decision older than the count (recorded in
`MainScreen.jsx`): no pre-aggregated table carries `data_quality_flag`, so the quality
selection cuts no series, and a counter that followed it would claim a recorte no chart
draws. `_shares.flagShare` stays exposed as a number, never as a multiplier. The estimate
also kept a `valueShare` multiplier, always 1 since `_shares` lost the key in v1.45.0; it is
gone.

**When it cannot count.** `rowsInView` is `null` when a point arrives without `rows` (a
payload from before v1.108.9) or a UF subset meets a snapshot with no UF grid. The counter
then falls back to the old estimate, total × `productShare` × `yearShare` × (`muniShare` ??
`stateShare`), and marks it: "≈ 61 mil", with a tooltip that says it is an estimate. A counted
number carries the exact figure in its tooltip ("60.557 linhas da base analítica neste
recorte."). While the territory is loading (`subUfLoading`, `geoComboPending`) it reads "…",
and after a failure (`subUfLoadError`, `geoComboLoadError`) "—": never the estimate, which
would count whole states (Portel and Breves would read as all of Pará).

### 3.6 Sub-UF geography cascade — `geo-mesh` + município cube (IBGE PEVS/PAM/PPM)
The geography filter descends BELOW UF via three dedicated endpoints (the snapshot stays
UF-grained) — the mesh, the per-(município, year) cube, and the per-product breakdown
WITHIN a município selection (`POST /api/products-by-municipio`, added v1.29.0: the cube
groups by city and sums the produtos away, so it can draw a place's trajectory but never
name what is behind it). Two PARALLEL IBGE divisions sit between UF and município and do **not** nest:
classic **mesorregião → microrregião** and 2017 **região intermediária → imediata**; a
município passes the cascade iff it clears every active facet (intersection).

- **`GET /api/geo-mesh`** → `{ municipios: [{ cityCode, cityName, uf, region, meso, micro,
  intermediaria, imediata }] }`. Each sub-UF level is a `{ code, name }` pair — blank
  `{code:'',name:''}` for a município with no grouping at that level (e.g. a post-2017
  município has no classic meso/micro). The static IBGE mesh (~5570 rows, from
  `dim_geo_municipio`), fetched once + cached; the cascade builds its level option-lists +
  the `cityCode → ancestry` map from it. `{ municipios: [] }` if the dim isn't built.
- **`POST /api/municipio-yearly`** — body `{ cityCodes: [...] }`; `banco` / `codes` /
  `currency` / `correction` in the query string → `{ municipioYearly: [{ year, cityCode,
  uf, value, q_mass, q_vol, q_count_stock, q_count_flow, rows }] }` (`rows`, since v1.108.9:
  the Gold rows behind the cell, a `count(*)` in the same select). The basket + **city-scoped** per-(município,
  year) cube, read straight from Gold (`maximum_bytes_billed`-guarded). **POST, not GET**:
  the resolved city set can be hundreds of codes — too large for a query string (gunicorn's
  ~4 KB request-line limit → 414). A **non-empty `cityCodes` is required** (so the backend
  never scans the full ~146k-row município grid). Same `/1e6`-style scaling as `ufData`
  (§3.4). The client rolls these city rows up to whichever sub-UF level is active.
  `{ municipioYearly: [], priceBase: null }` for a banco with no município grain
  (COMEX/COMTRADE) or a not-built table. `priceBase` (§3.8) is the cube's OWN: it reads
  Gold, not the snapshot's mart, so a build landing between the two requests can date them
  differently — the screen names both rather than borrowing one.
- **Client side of the two município reads (v1.108.1).** `window.geoMeshState()` →
  `{ municipios, loading, loadError }` and `window.municipioYearly(...)` →
  `{ rows, priceBase, loading, loadError }` (`contracts.js` § Município-level loaders).
  `municipios`/`rows` are `null` while the answer is NOT known — pending, or failed after the
  cache's retries — and `[]` only for a measured empty answer, so a screen never reads a
  failed request as "carregando" forever or as "sem dados". `rows` and `priceBase` come from
  the same response by construction (the separate `municipioYearlyPriceBase` accessor is
  gone). `window.geoMesh()` is kept as a bare name lookup (`municipios` or `null`) for code
  that only resolves a city code to its name.
- **`GET /api/products-by-uf`** (`states` required) and **`POST /api/products-by-municipio`**
  (body `{ cityCodes }`) → `{ products: [{ code, name, tabela, measure_kind, value, q_mass,
  q_vol, q_count }], priceBase, available }` — what a place produces, one row per product, value
  in currency mi and quantities at the §3.4 magnitudes. The by-UF reader serves PEVS, PAM and
  PPM from their serving marts and COMEX from its export side (PAM and PPM since v1.107.0).
  `measure_kind` is `'stock' | 'flow'` on PPM rows and `null` elsewhere: a herd arrives with
  `value: null` BY NATURE, a flow the convention does not reach with `value: null` too, and only
  this field tells the two apart. **`available` is whether the banco has a reader at that grain
  at all** — an empty `products` with `available: false` was never measured (COMTRADE; COMEX by
  município); with `available: true` it is a measured "nothing registered". The producers
  (`productsByUf`, `productsByMunicipio`) add `loading` and `loadError` on top, so a screen never
  reads a pending or failed request as an empty place.
- **The basket's UF cube on the client (v1.108.2).** `window.geoYearly(banco, summary)` — the
  `GET /api/geo-yearly` cube `applyFilters` reads when a basket subset meets the UF grid —
  returns `{ rows, priceBase, loading, loadError }`, in the same three states as the two
  município reads (`contracts.js` § GeoYearlyState; the separate `geoYearlyPriceBase` accessor
  is gone). Until then it returned the bare rows, `null` both in flight and after a failure,
  so a failed cube left `geoComboPending` pending for good ("cruzando produto × UF…" forever).
  `applyFilters` now reports a failure as `basketGeoLoadError`, and as `geoComboLoadError` when
  a UF subset needed the cross; `geoComboPending` is pending-only.
- **The per-product series of a UF subset (v1.108.3).** `GET /api/product-ts` — `banco`,
  `states` (required, comma-separated), `currency` / `correction` and the filter axes
  (`flow`, `customs`, `market`, `tabela`, `niveis`, the country lists) in the query string →
  `{ productTS, priceBase, available }`. `productTS` has the §3.3 shape, summed over the
  selected UFs only, over every year (the client slices the window). It is the snapshot's
  per-product read with ONE more predicate, `state_acronym IN UNNEST(@uf_codes)`, and the
  same filter arguments by construction (`seam._product_ts_filter_kwargs`, pinned by
  `tests/test_product_ts_by_uf.py`): COMEX follows the selected flow, like the hero and the
  UF cube. Since v1.108.4 the production bancos also follow the SIDRA table the total reads
  (`tests/test_series_por_produto_tabela.py`, §3.3). The two reads had agreed with each
  other only because both left the table out, so agreeing proved nothing. **Cost, measured on prod 2026-11-19** (one real run per banco, nominal R$, every
  year): 0,49 MB (PEVS) · 0,92 MB (PAM) · 1,05 MB (PPM) · 6,78 MB (COMEX) processed, each
  billed at BigQuery's 10 MB per-query floor, exactly like the national read beside it.
  `available: false` with an empty `productTS` for COMTRADE, which has no UF. The client side
  is `window.productTSByUf(banco, summary)` → `{ productTS, priceBase, loading, loadError,
  unavailable }` (`contracts.js` § ProductTSByUfState). `applyFilters` uses it for
  `productTS`, `allProductTS` and `topProducts` whenever a UF subset is selected, and
  reports its state as `productUfRequested` / `productUfLoading` / `productUfLoadError` /
  `productUfUnavailable` and its month as `productPriceBase`:
  - *loading* and *failed* leave the three EMPTY — the national series under the UF chip is
    the defect itself — and every screen that reads them says which (`window.seriesPorUf`,
    `window.SeriesPorUfNote`); the CSV is refused with `carregando-series-uf` /
    `falha-series-uf`;
  - *unavailable* (no reader for the banco) keeps the NATIONAL series, and the screens say
    plainly that the numbers per product are Brazil's;
  - *resolved* is a measurement: `{}` means the UFs record none of the banco's products.
  The CSV of per-product series carries an `abrangencia_geografica` column ("Brasil", or the
  UF acronyms), since a file has no chip beside it.
- **What a sub-UF recorte can and cannot narrow (v1.108.2).** `applyFilters.subUfRequested` is
  true whenever a sub-UF recorte is ASKED for — loading, failed or resolved. Three rules hang
  on it:
  - *The recorte's products.* `window.recorteProducts(filtered, summary, banco, conv)`
    (`frontend/src/ui/recorteProducts.js`) answers what the chosen municípios produce: one
    `POST /api/products-by-municipio` for the latest year of the selected period with a row in
    the município cube, over the cities with a row that year. `null` without a recorte; the
    recorte's own `loading`/`loadError` while it resolves; `products: []` only when measured.
    Visão geral's composition and Concentração's product half read it instead of the national
    per-product series.
  - *Series that exist only nationally, or only by whole UF* (`productTS` — by whole UF since
    v1.108.3 —, the herd by species, PAM's area and yield): Perfil do produto, Comparativo
    entre produtos, Rebanho, Produtividade and Valor × Volume's per-product compositions cannot
    narrow to municípios in ANY state.
    They keep their numbers and say so (`window.recorteNaoSeAplica`), or withhold the chart
    (Valor × Volume), and their CSV is refused with `recorte-nao-se-aplica` — waiting would not
    help, so `carregando-recorte` would promise a file that never comes.
  - *Row counts.* Under a resolved recorte "Linhas" COUNTS (v1.108.9, §3.5): the município
    cube's `rows` survive the rollup to (UF, year) (`rollupMuniCubeToUf`), so Portel and Breves
    read 560, Gold's own `count(*)`. Until then `_shares.muniShare` (the municípios in scope
    over the whole mesh) sized an estimate — 497 for the same two — and it now backs only the
    fallback for a payload without `rows`. While the recorte loads the counter shows "…", after
    a failure "—", in every case: never the estimate, and never a count of the UF grid.

### 3.7 `valueGap` — the periods the active convention cannot value (every banco)
`{ years, partial, months, valuedRange, share: null }` or `null`.

Since v1.80.0 every banco carries it, not only COMEX. The annual bancos (IBGE PEVS/PAM/PPM,
COMTRADE) deflate by the MEAN of the year's monthly indices (v1.103.0; December's before)
and only when the index covers all twelve months, so where the index series does not reach, a
whole year has no corrected value — measured on the serving marts 2026-09-13: **PAM and PPM
have no R$ · IPCA in 1974–1979** (the first index offered for R$; the dashboard opens on
Nominal since v1.88.0), no IGP-M in 1974–1989 (1974–1988 until v1.102.0); PEVS has no IGP-M
in 1986–1989; all three have no € sem correção before 1999. They are read by `gateway.fetch_annual_value_gap` from their annual
mart; a row only counts when it has a value in the banco's own currency (`val_yearfx_brl`,
or `val_yearfx_usd` for COMTRADE), so PPM's herd — valueless in every convention — is not a
gap. `valuedRange` (first and last year with value) lets the note say WHY: a hole at the
START is an index series that begins later ("A série do IPCA não alcança esses anos"), one
at the END an index not ingested yet. COMEX (below) is read month by month.

`coveredBy` (v1.81.0) lists the OTHER corrections, in the same currency, that value every
whole year of the gap — asked of the data (`seam._value_gap_alternatives` fetches their gaps
only when the active convention has one; `serializers._covering` keeps a correction only if
each year has valued rows and no valueless one). PAM/PPM in R$ · IPCA get `["IGP-DI"]` once
the inflation is ingested from `BCB_START_YEAR=1974`, and the note adds "IGP-DI alcança
esses anos". `[]` when none — before that backfill IGP-DI has the same hole, so nothing is
offered. Annual bancos with a corrected convention only.

The COMEX snapshot readers all sit on annual marts, whose build SUMs the months — and a
SUM swallows the month a convention cannot value. Two such holes exist: the **latest
month before its deflator index is ingested** (measured 2026-09-13: all 2.275 rows of
2026-08 without IPCA/IGP-DI; IGP-M was already in) and **€ sem correção before 1999**.
Until v1.79.0 the corrected 2026 total covered Jan–Jul under a "2026" label while the
nominal one covered through August, on every COMEX screen but the three trade views.

- Read by `gateway.fetch_comex_value_gap_by_month` from the MONTHLY mart, unfiltered: Gold
  joins the deflator and the FX by year + month, so a missing index nulls EVERY row of its
  month — exact for any product/UF/flow the browser selects.
- `partial` = years with some valued month; `months` names their missing ones
  (`{"2026": [8]}`) so the note says "parte do comércio de 2026 (agosto)", never "2026".
- No `share`: it depends on the client-side selection.
- The screens cut it to the selected period (`window.windowValueGap`) and MUST name it;
  `MainScreen` renders one `ValueGapNote` under the conventions strip for every COMEX
  view except the three trade views, which carry their own (with the share — §4).

### 3.8 `priceBase` — the month a corrected value is at (every value payload, v1.105.0)
`{ column, month: 'YYYY-MM', fxDate: 'YYYY-MM-DD' | null }` or `null`.

A deflated value is not "in today's money": it is at the prices of ONE month, the latest
month of its index when Gold was built, and that month moves with every build that ingests
a new one (the 2026-11-17 build moved every IPCA value from September's prices to October's,
+0,14%). So the base travels WITH the data:

- Gold stamps it on every row — `{ipca,igpm,igpdi,cpi,hicp}_base_month` (the first day of
  the latest month of EACH index: they follow different publisher calendars) and
  `fx_{usd,eur}_base_date` (the single PTAX day a cross column converts at). The marts carry
  them as `max()`; `assert_price_base_single_valued` fails the build if one ever holds two.
- Each reader that sums a corrected column reads it back with `max()` in the SAME select
  (`serving.sql._price_base_select`), opted in with `with_price_base=True`. `price_base.take`
  reads it off the frame and DROPS the two columns, so nothing downstream ever meets them.
- `column` names the value column the base dates, so the screen can refuse to borrow a base
  for a different convention (`window.priceBaseFor`). It is `null` on the bare-frame
  payloads (`products`, `municipioYearly`), whose serializer never learns the column — the
  base still belongs to the request's own convention.
- `fxDate` is set only for a cross column (a Brazilian index under US$ or €). An
  own-currency column converts at each period's rate and has no single day.

`null` means unknown, never a guess: a nominal or quantity column (no month to name), an
empty frame, two distinct months in one frame, or a mart that predates v1.105.0 — the app and
the marts deploy in parallel, so the reader asks the table schema first (free metadata) and
fails closed. The screen then prints the honest fallback, "a preços do mês mais recente do
índice". Where the payload carries its own `valueLabel` (snapshot, §4.1–§4.3) the server
already appended " · a preços de outubro de 2026" — or that fallback — as its LAST clause.

What a price base is NOT: an interest rate. Deflating changes the unit of measure; it adds no
return and is not the present value of finance.

**Which payloads carry one.** Every request of its own that sums a corrected column: the
snapshot (from its overview read), flows, partners, the monthly profile, the cross series,
the município cube, the two product rankings (by UF and by município) and the UF cube
(`geo-yearly` → `{ ufYearly, priceBase }`). Not the one-product UF ranking of Perfil do
produto (`/api/product-uf`), a single card read from the same mart as the snapshot.

**What can still disagree, and for how long.** The server caches each READ for 10 minutes,
per instance (`CACHE_DEFAULT_TIMEOUT`). Only a build that ingests a new index month moves the
base, and for up to 10 minutes after it two reads can sit on either side of it. Between
separate requests the screen sees it and says so: `window.PriceBaseSkewNote` compares the
snapshot with the cubes `applyFilters` reads (in `MainScreen`) and with a perspective's own
reads (Perfil do território, Geografia, Comparação de territórios), and the CSV names no month
when they differ. Inside ONE payload it cannot: the snapshot is assembled from several cached
reads (overview, per-product series, per-UF rows), and only the overview's base is stamped.
The difference is one month of the index while it lasts.

---

## 4. Generic adapters (brief §3)

### 4.1 `flowData` → Sankey origin→destination
`{ preview, unit, valueLabel, priceBase, originLabel, destLabel, nodes, links, total,
routeCount, topOrigin, topDest, sumRange }`.
- COMEX: origin = `state_acronym` (UF), dest = `country_name` — exports only.
- COMTRADE: origin = `reporter_name`, dest = `partner_name`.
- value = `SUM(<value column>)`, the column `currency` + `correction` resolve through
  `seam.effective_value_column` — the same rule as §4.2. Until v1.77.0 it was fixed at
  `val_yearfx_usd`, so the Sankey was nominal US$ under any convention.
- `unit` = symbol of the column ACTUALLY summed (a US$ × IGP-M request falls back to R$);
  `valueLabel` = the convention as the view prints it.
- `node.value` = Σ of the links touching it (pre-summed), in **`unit` mi**.
- `valueGap` = `{ years, share }` or `null` — same meaning as in §4.2. A link with no value
  in the convention (traded only in those years) is not drawn: it lies wholly inside the
  gap the view names.
- `total` = Σ of EVERY route's value in **`unit` mi** (`null` when none has one), and
  `routeCount` = how many routes have a value — both computed BEFORE the diagram's cut to
  the 40 largest. Until v1.105.0 the "Fluxo total" card summed only the drawn routes.
- `topOrigin` / `topDest` = `{ label, value }` of the origin and destination with the largest
  total over EVERY route (`unit` mi), or `null`. The largest NODE sums only the drawn routes:
  on 2026-11-17 the "Maior origem" card read Mato Grosso US$ 292,7 bi against US$ 373,9 bi
  over all 3.063 routes (COMEX exports, US$ · CPI).
- `sumRange` = `[first, last]` year actually summed, or `null` (v1.105.0): a multi-year sum
  must say its period. The years the convention cannot value are `valueGap`'s, not these.
- `priceBase` = §3.8, and `valueLabel` already ends with it.

### 4.2 `partnerData` → partner ranking
`{ preview, flowLabel, unit, valueLabel, priceBase, sumRange, partners: [{ name, exp, imp,
value, weight, price, pricedShare }], belowFloor: [...] }`.

The ranking DIMENSION is chosen server-side (`/api/partners?metric=value|weight|price` →
`rank_by`), because the row order IS the top-N cut: the SQL has no `LIMIT` and the
serializer's `head(max_rows)` does the cutting, so re-sorting a value-ranked page in the
client would drop the niche high-price buyer the price ranking exists to find.

The VALUATION follows the conventions strip: `currency` + `correction` (default R$ · Nominal
since v1.88.0, same as `/snapshot`) resolve the summed column through
`seam.effective_value_column`, and
every monetary measure — exp, imp, value, the priced share and the price numerator — reads
that ONE column. Until v1.77.0 the endpoint took neither and always summed nominal US$
while the strip claimed "IPCA"; a historical ranking is where that hurts most, because the
oldest flows get the largest correction and the order itself can change.

- `unit` = symbol of the column ACTUALLY summed (R$ / US$ / €) — not of the request: a
  combo the mart lacks (US$ × IGP-M) falls back to R$, and the unit follows it.
- `valueLabel` = the convention as the view prints it, e.g. "Valor real (CPI · inflação dos
  EUA) — US$ · FOB … · a preços de outubro de 2026" — the price base (§3.8) is always the
  LAST clause, after the FOB/CIF note.
- `priceBase` = §3.8. `sumRange` = `[first, last]` year actually summed, or `null` — the
  ranking is a multi-year sum, and a sum must say its period (v1.105.0).
- `valueGap` = `{ years, partial, share }` or `null`: the years inside the window the
  convention cannot value, which of them are missing only IN PART (`partial`), and the share
  of the window's trade — measured in the declared US$, which never goes missing — they
  leave out of the sum. A partial year is the latest COMEX month before its deflator index
  is ingested (Gold deflates month by month; measured 2026-09-13, every August 2026 row had
  no `val_real_ipca_*`): the view says "parte do comércio de 2026", never "2026". For
  COMEX the coverage comes from the MONTHLY mart (`gateway.fetch_comex_value_gap`, same
  filters): the annual mart's build SUMs the months, so a month without a deflator vanishes
  inside a non-null year total — measured at the annual grain the gap was 0,2% of Acre ×
  castanha, at the monthly grain 2,05%. COMTRADE's Gold is annual, so its own frame sees it. € sem correção only exists from 1999
  and COMEX starts in 1997: a SUM skips the NULL in silence, so a "1997–2026" euro total
  was a 1999–2026 total (v1.78.0). Computed over the whole window, before the top-N cut.
  The view MUST name it. A partner traded only in those years gets `value: null`, never 0,
  and the price divides value by the weight of the SAME rows (both halves conditioned).
- `name` = `country_name` (COMEX) / `partner_name` (COMTRADE).
- `exp` = `SUM(<value column> WHERE flow='export')`, `imp` = import; `value` = exp+imp,
  all in **`unit` mi**. `weight` = net weight in **mil t**.
- `price` = **`unit`/kg**, `null` when the partner has no weight (never 0 — see §2).
- `pricedShare` (0–1, nullable) = how much of that partner's trade BACKS the price. The
  price divides only the value of rows that HAVE a weight, because the two halves of a
  ratio must cover the same rows: COMTRADE publishes 79.528 rows (3,87% of the mart,
  measured 2026-09-07) with a value and no net weight, and dividing the WHOLE value by
  the weight of part of it inflated the number (Guam ranked 6th at US$ 1,251/kg and
  belongs 41st at US$ 0,567). Below **0,9** the view names the partner — a value computed
  over a subset must say which. COMEX is immune by DATA (zero rows without weight), not
  by construction.
- `belowFloor` = partners the materiality floor set aside BEFORE the top-N cut, non-empty
  only for `metric=price` (100 t + 0,001% of the window's weight; a ratio over a tiny base
  is not a measurement — the old top was Lesoto with 1 kg). The view MUST name them; the
  additive rankings need no floor and get an empty list.
- **Self-trade is excluded server-side**: the row where the partner is the declaring
  country itself is returned merchandise, not a market. COMEX has a country code for it
  (105, ISO BRA); COMTRADE simply has `reporter = partner`.
- COMTRADE: **World is already excluded** in Silver (no `partner_code='0'`), so the
  ranking is clean — no extra filter needed.

### 4.3 `monthlyData` → seasonality (**COMEX only**)
COMEX Gold has `reference_month`. Build `matrix[year][1..12]`, `monthlyAvg[12]`,
`series[{ym,y,m,v}]` from `SUM(<value column>)` by (year, month), in **`unit` mi**.
- The column follows the conventions strip like §4.1/§4.2: `unit` = symbol of the column
  actually summed, `valueLabel` = the convention on screen, `priceBase` = §3.8 (COMEX
  deflates month by month, but every month is brought to the prices of the same base month).
- `valueGap` = `{ years, share }` or `null` (§4.2). A month whose rows exist but the
  convention cannot value (€ sem correção before 1999) is `null` in `matrix` and out of
  `monthlyAvg`; a month with no ROW stays `0` — COMEX lists only what was traded. Until
  v1.78.0 both were `0`, and the fake zeros pulled every monthly average down.
- The mart only carries the full currency matrix since v1.77.0, and a merge deploys the
  app and rebuilds the marts IN PARALLEL (on 2026-09-09 the app was live 3m32s before the
  mart). So while `serving_comex_seasonality` lacks the requested column, the seam serves
  the nominal US$ it always had and `valueLabel` says so — instead of the query failing
  for everyone on the default BRL·IPCA. The schema check is table metadata (free), cached
  at the mart TTL.
> COMTRADE is annual → never call this for `un_comtrade` (Sazonalidade = "Não se aplica").

---

## 5. Cross-source metrics (brief §4)

`crossSeries(banco, metric, {y0,y1})` → annual `points:[{y,v}]` in the **DISPLAY_UNIT
magnitude**.

| metric.id | source | formula (per year, in scope) | DISPLAY_UNIT |
|---|---|---|---|
| `ibge_pevs:prod_value` | serving_pevs_annual | `SUM(val_real_ipca_brl WHERE tabela='289')` ÷1e9 | `R$ bi` |
| `ibge_pevs:prod_mass` | serving_pevs_annual | `SUM(qty_native WHERE tabela='289' AND family='massa')` ÷1e3 | `mil t` |
| `ibge_pevs:prod_volume` | serving_pevs_annual | `SUM(qty_native WHERE tabela='289' AND family='volume')` ÷1e6 | `mi m³` |
| `ibge_pevs:silv_value` | serving_pevs_annual | `SUM(val_real_ipca_brl WHERE tabela='291')` ÷1e9 | `R$ bi` |
| `ibge_pevs:silv_mass` | serving_pevs_annual | `SUM(qty_native WHERE tabela='291' AND family='massa')` ÷1e3 | `mil t` |
| `ibge_pevs:silv_volume` | serving_pevs_annual | `SUM(qty_native WHERE tabela='291' AND family='volume')` ÷1e6 | `mi m³` |
| `mdic_comex:exp_value` | gold_comex_flows | `SUM(val_yearfx_usd WHERE flow='export')` ÷1e9 | `US$ bi` |
| `mdic_comex:imp_value` | gold_comex_flows | import ÷1e9 | `US$ bi` |
| `mdic_comex:exp_weight` | gold_comex_flows | `SUM(net_weight_kg WHERE flow='export')` ÷1e6 | `mil t` |
| `mdic_comex:exp_price` | serving_comex_annual | `SUM(val_yearfx_usd)` ÷ `SUM(net_weight_kg)` over the export rows with BOTH (one condition, `sql.cross_price_annual`) | `US$/kg` |
| `un_comtrade:exp_value` | gold_comtrade_flows | `SUM(val_yearfx_usd WHERE flow='export')` ÷1e9 | `US$ bi` |
| `un_comtrade:imp_value` | gold_comtrade_flows | import ÷1e9 | `US$ bi` |
| `un_comtrade:world_exp` | gold_comtrade_flows | **see below** | `US$ bi` |

**`world_exp` (world total exports)** — the World partner (`W00`) is dropped in
Silver, so the world total is **derived by summing over all reporters**:
```sql
SELECT reference_year, SUM(val_yearfx_usd)/1e9 AS world_exp_usd_bi
FROM gold.gold_comtrade_flows
WHERE flow = 'export'          -- (filter cmd to the commodity for market share)
GROUP BY reference_year
```
This is the denominator for `cross_market_share` (Brazil ÷ world).

**The cross-source prices divide the value and the quantity of the SAME rows** (v1.108.12).
`exp_price` and the two prices of Preço: porteira vs. FOB (`priceSpread`) are value ÷
quantity per year, and until v1.108.11 each half was a sum over its own rows: `exp_price`
and the FOB price divided the `exp_value` series by the `exp_weight` series, and the
farm-gate price divided the production value by the native quantity of PEVS + PAM. A row
with a value and no quantity entered the numerator alone. Now both halves come from one
condition (`sql._priced_pair`: the row has the quantity AND the value): the COMEX side reads
`sql.cross_price_annual` (`total_value`, `priced_value`, `priced_qty` per year), and the
farm-gate side reads the mass track of the per-product series (`priced_value_mass`,
`priced_qty_mass`, §3.3), summed over PEVS and PAM before the division. With the data of
2026-11-23 no published number moves: no COMEX row has a value without a weight, and no
IBGE row a value without a quantity — the halves agreed by data, and now agree by
construction (`tests/test_cross_prices_same_rows.py` runs the real SQL with an unpaired row).

The share of the value behind each price travels with it, nullable (null when the year has
no price, or no value to divide): `exp_price` points are `{y, v, pricedShare}`, and each
`priceSpread.series` point carries `fobPricedShare` and `gatePricedShare`. Below 0,9
(`window.PRICED_SHARE_MIN`, shared with §3.3 and the partners' `pricedShare`, §4.2) Preço:
porteira vs. FOB names the year and the side, and its KPI says "apoiado em X% do valor".
`exp_price`'s `pricedShare` is not drawn yet in Cruzamento entre fontes (that view reads
the points as `{y, v}`).

**Each PEVS metric is ONE half of the survey** (v1.106.0): `prod_*` is native-forest
extraction (SIDRA 289) and `silv_*` is planted-forest silviculture (SIDRA 291). The
registry's `tabela` is pinned on EVERY read behind the series, and a PEVS metric that
declares none is refused by the seam (`seam_cross._pevs_tabela`), never defaulted. A
default is exactly what failed before: until v1.106.0 the three `prod_*` series summed
both halves under an extraction label, and `prod_value` served R$ 47.7 bi for 2024,
7.3× the extraction value. `tests/test_cross_pevs_tabela_guard.py` sweeps every read
behind every PEVS cross series and checks that the SPA and backend registries agree.
The two value series carry a `priceBase` (IPCA); the four quantity series carry none.

> `crossSeries.preview` **derives from the source banks' maturity** — true if any
> source lacks real data (`MATURITY[b.maturity].hasData` is false), not a hardcoded
> literal (see §9). Flip the real builder and the source's `maturity` together so a
> synthetic series never reads as real.

---

## 6. Product crosswalk (brief §6) — `gold_produto_agrupamento`

The keystone for every cross-source join (export coefficient, market share, price
spread, trade mirror, harvest→shipment lag). Resolved table, grain `(source, code)`:

| column | meaning |
|---|---|
| `agrupamento_id` | stable slug: `castanha_do_para`, `madeira_em_tora` |
| `agrupamento_nome` | display name |
| `source` | `pevs` \| `comex` \| `comtrade` |
| `code` | exact code in that source (PEVS code / NCM8 / HS6) |

**Usage** — join each fact's product code to get a comparable agrupamento:
```sql
SELECT x.agrupamento_id, SUM(c.val_yearfx_usd) AS comex_exp_usd
FROM gold.gold_comex_flows c
JOIN gold.gold_produto_agrupamento x ON x.source='comex' AND x.code = c.ncm_code
WHERE c.flow='export'
GROUP BY x.agrupamento_id
```
A product code matching no agrupamento is simply absent from the crosswalk →
**"não vinculado"** (graceful), never an error. Register a new produto by its exact
source code via the **"Cadastro de produtos"** admin view (writes to `research_inputs`
→ `core/dim_produto_catalog` → `gold_produto_agrupamento`) when the product scope grows.

Verified (2023): the crosswalk links castanha and roundwood across all three
sources, so e.g. the export coefficient (COMEX exports ÷ PEVS production) and the
trade mirror (COMEX vs COMTRADE Brazil) compute on a common agrupamento.

---

## 7. Vocabulary the BFF must reconcile

### 7.1 Physical-unit `family` — Gold is Portuguese
Gold emits `family` in pt. Map to the frontend `UNIT_FAMILIES` ids (`frontend/src/ui/data.js`).
Proposed mapping (confirm the right-hand ids against the registry; if they differ
it is a one-line BFF map, never a Gold change):

| Gold `family` | base_unit | → `UNIT_FAMILIES` id |
|---|---|---|
| `massa` | t | `mass` |
| `volume` | m³ | `volume` |
| `energia` | MWh | `energy` |
| `contagem` | un | `count` |
| `area` | ha | `area` |
| `desconhecida` | (NULL) | `unknown` |

> Rule (brief §2.1): the backend **always carries** `family` — the frontend never
> guesses the dimension. `net_weight_kg` is a parallel always-massa measure; never
> `SUM(qty_base)` across families (GROUP BY `family`).

### 7.2 `data_quality_flag` — exact id set
The flags the macro emits (the frontend color map must cover **these**). The last four
(the implied-price tiers) are emitted only when the dbt var `enable_quality_outliers` is
`true` (on in prod):

| id | meaning | tables |
|---|---|---|
| `OK` | has quantity + value, and the detector EXAMINED the row and found the implied price plausible | all |
| `MISSING_VALUE` | quantity but no monetary value | all |
| `MISSING_QUANTITY` | value but no quantity (0 rows today: IBGE absences blank the whole cell and are dropped; trade marks the missing weight) | PEVS, PAM, PPM, COMTRADE (legacy flag) |
| `MISSING_WEIGHT` | value but no net weight — the detector prices trade per kilo (COMTRADE since v1.90.0: 79.536 rows, 92% chapter 44) | COMEX, COMTRADE |
| `INCOMPLETE` | neither | all |
| `OUTLIER_VALUE` / `OUTLIER_QUANTITY` | high-magnitude but price-consistent — a valid large value | all (gated) |
| `PROBLEMATIC_VALUE` / `PROBLEMATIC_QUANTITY` | implied price >100× or <1/100× the product median ⇒ likely typo | all (gated) |
| `INFERRED_QUANTITY` / `INFERRED_VALUE` | **reserved** auto-fill tiers (accepted-but-absent) — plumbed through `contracts.js` / `_gold.yml` but always 0 today; no Gold CASE emits them yet | all (gated) |
| `ISOLATED_SPIKE` | a value in ONE year (none the year before or after) that makes its state's series jump — the price detector cannot see it (v1.92.0, `macros/isolated_spike.sql`) | PEVS, PAM, PPM (gated) |
| `UNSCORED` | the detector had **no basis to examine** the row: value/qty non-positive (a measured zero — SIDRA's `-`, or a COMEX weight of 0), small by both measures (value and quantity × median price below the materiality floor), fewer than `quality_min_obs` rows for the product, or (PPM herd) a stock that has no price to score at all. (Until v1.90.0 also "value absent": PAM/PPM 1974–1979, before the IPCA the IBGE detector scored on; it scores on IGP-DI now.) **Not a defect** — until v1.49.0 these fell into `OK` and were indistinguishable from rows actually cleared (PAM: only 33,6% of `OK` had been scored). Display it as "Não avaliada", never as damage | all (gated) |

### 7.3 `region` — Gold is full names
Gold `region` ∈ {Norte, Nordeste, Centro-Oeste, Sudeste, Sul}. The brief's `ufData`
wants the abbreviations {N, NE, CO, SE, S} — map in the BFF.

---

## 8. Gold column reference

Both flows tables share the monetary conventions: `val_yearfx_*` (nominal at the
year/month FX), `val_real_{ipca,igpm,igpdi}_*` (deflated by a Brazilian index, then
converted at the latest PTAX in the base) and `val_real_cpi_usd` / `val_real_hicp_eur`
(converted at the record's FX, then deflated by the foreign index). This is **not** a
`correction × currency` grid — a foreign index pairs with its own currency only. Use any
`val_real_*` for cross-year comparison, naming which — and at which base month: every
Gold carries `{ipca,igpm,igpdi,cpi,hicp}_base_month` and `fx_{usd,eur}_base_date` (§3.8).
See `dbt/models/gold/_gold.yml` for per-column docs.

- **gold_pevs_production**: reference_year, reference_date, state_acronym, state_name,
  region, city_code, city_name, product_code, product_description, family, unit_native,
  qty_native, qty_base, base_unit, val_yearfx_{brl,usd,eur},
  val_real_{ipca,igpm,igpdi}_{brl,usd,eur}, val_real_cpi_usd, val_real_hicp_eur,
  data_quality_flag, last_refresh.
- **gold_comex_flows**: + reference_month, ncm_code, hs_chapter, ncm_description,
  country_code/name/iso_a3, transport_route_code, via_name, stat_unit_code,
  unit_native_symbol, net_weight_kg, val_freight_usd, val_insurance_usd, source_rows.
- **gold_comtrade_flows**: cmd_code, hs_chapter, cmd_description,
  reporter_code/name/iso_a3, partner_code/name/iso_a3, partner_is_group,
  qty_unit_code, unit_native_symbol, net_weight_kg, gross_weight_kg,
  val_cif_usd, val_fob_usd, source_rows. (annual — no reference_month.)
- **gold_produto_agrupamento**: agrupamento_id, agrupamento_nome, source, code.
- **gold_source_metadata**: source, gold_table, cadence, year_start, year_end,
  total_rows, products_total, ufs_total, last_refresh. (view; see §9.)

---

## 9. Status & provenance the BFF reports (brief CHANGELOG)

These are **runtime/BFF concerns — NOT in the Gold fact tables**. The data layer is
status-agnostic; what follows is what the BFF must report and how to derive it.

### 9.1 Status — three axes (the old `status:'live'|'soon'` is DERIVED, never set)

| Axis | What | Source |
|---|---|---|
| `maturity` | backend readiness, one of `planejado · desenvolvimento · ingestao · beta · estavel · manutencao · descontinuado` (+ optional `implNote`, `implDate`) | BFF/`bancos.js` runtime config |
| `visible` | bool — hide the bank from the whole UI when false | BFF/`bancos.js` |
| *uso* (active) | derived at runtime (the bank feeding the current view) | not a field |

Per-source `maturity` for this project (config, not data):

| source | maturity | implDate |
|---|---|---|
| `ibge_pevs` | `estavel` | — |
| `mdic_comex` | `estavel` | — |
| `un_comtrade` | `beta` | — |
| `ibge_pam` | `beta` | — |
| `sefaz_nf` | `planejado` (planned, no deadline; no Gold table yet) | none |

`status:'live'` is derived from `MATURITY[b.maturity].hasData`; `crossSeries.preview` derives
from the **source banks' maturity** — true if any source lacks real data (`MATURITY[b.maturity].hasData` is false).

### 9.2 Provenance seam — `dataStore.meta(id)` ← `gold_source_metadata`

The UI reads ALL bank provenance from the backend (never frontend literals), via
`dataStore.meta(id)` → `bancoMeta(id)`. `gold.gold_source_metadata` (one row per
source, a view → always current) supplies it, derived from the Gold tables so a
rename / new cadence / extended coverage / fresh load propagates to the whole UI:

| meta / `prov` field | gold_source_metadata column |
|---|---|
| table name (`bancoTable`) | `gold_table` |
| cadence (annual/monthly) | `cadence` |
| coverage / `yearStart`,`yearEnd` | `year_start`, `year_end` |
| `totalRows` | `total_rows` |
| `productsTotal` | `products_total` |
| `ufsTotal` | `ufs_total` (NULL for COMTRADE — no UF) |
| `lastCrop` (PEVS) | `year_end` |
| `refresh` / `goldVersion.at` / `isStale` | `last_refresh` |

`maturity` / `visible` are **not** in this table — they
are runtime config (§9.1). `source`, `granularity/scope`, and the human source name
are constants the BFF maps from `source` + this contract.
