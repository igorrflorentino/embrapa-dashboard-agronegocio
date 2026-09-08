# React Migration — Contract Map (the single spec)

> **Status: COMPLETE & LIVE** — merged PR #74 (3a3f9bb), deployed to prod Cloud Run behind direct IAP.
> Kept as the migration spec/history; the design below is the live contract.

> Status: **authoritative**. Replaces the stalled extraction workflow; built from ground
> truth — `frontend/src/ui/contracts.js` (shapes), `webapi/seam.py` (BFF output; since split into
> `seam_base.py` / `seam_cross.py` / `seam_curation.py`),
> `serving/sql.py` (exact gateway columns), and a full read of the reused views +
> producers. Decision of record: migrate the dashboard from Dash to a **React SPA over a
> Flask REST API**, charts in **Plotly.js** (zoom/hover/pan). Dash was removed at the end of the cutover.

## 0. Architecture decisions

1. **The API emits the full per-banco `BancoSnapshot`; filtering stays client-side.**
   The reused views read `window.applyFilters(summary, bancoId)` (`dataFilters.js`), which
   narrows the *full* snapshot in JS (year window, basket, states, flags). The serving marts
   are already pre-aggregated to annual/product/UF grain (small), so shipping the whole
   snapshot honors Pushdown — the heavy aggregation already happened in BigQuery. We do **not**
   reimplement `applyFilters` in Python. `dataStore.js` + `dataFilters.js` are reused unchanged.
   *(Refinement: the geography split is now **hybrid** — the snapshot's `ufYearly` is all-products,
   so to narrow the territorial split by a product basket `applyFilters` pulls a basket-scoped
   product×UF×year cube on demand via `/geo-yearly` and still slices period/state client-side.
   Every other dimension stays purely client-side over the full snapshot.)*

2. **Conventions (currency × correction) are applied SERVER-SIDE via column selection.**
   The prototype faked correction with a single client multiplier on a canonical value — wrong
   for a research tool whose point is real per-year deflation. **Every live mart — production
   (PEVS/PAM) AND trade (COMEX/Comtrade) — carries the full `{nominal, real IPCA/IGP-M/IGP-DI}
   × {BRL, USD, EUR}` matrix** (`val_yearfx_{brl,usd,eur}` + `val_real_{ipca,igpm,igpdi}_{brl,usd,eur}`,
   the real BCB-PTAX year-FX / deflated values Gold computes, NULL pre-1994). The trade marts used
   to drop everything but `*_usd`, which forced the frontend to cross-convert US$→R$/€ via a frozen
   **mock** FX rate (the wrong-number path on explicit BRL/EUR selection — now fixed). The trade
   serving builders (`trade_overview`, `comex_by_uf`, `comex_by_uf_yearly`) + their gateway readers
   take a `value_column` so the seam can pick the requested currency; `seam.effective_value_column(banco, conv)`
   maps (currency, correction) → the right column with a documented fallback (trade keeps a FOB/CIF
   valuation-basis note on the label, since the figure is the year-FX conversion of customs US$). So the
   **snapshot fetch is parameterized by `currency` + `correction`**; changing either re-fetches.
   The client-side `convFactor` AND the base-aware `convFactorFor` are **neutralized to 1.0** — the
   server already serves the value IN the requested currency for every banco, so no client conversion
   of real data exists (`CURRENCY_FX` is now a symbol-only table, NO numeric rate). The physical-unit
   conversion (`massQtyMul`/`volumeQtyMul`) and `autoScale` magnitude abbreviation stay client-side.
   → patch to `MetricConventions.jsx` (§6). An unmodelled currency/correction combo (e.g. USD × IGP-M,
   no `*_igpm_usd` in the allowlist) → seam falls back to the same correction in BRL with a label note
   (honest, still a real column — never a mock conversion).

3. **Client-side registries stay in the frontend** — they are presentation metadata, not data:
   UF tile coords (`col`/`row`) + region names (`UF_DATA`/`REGIONS`), quality-flag `label`/`color`
   (`QUALITY_FLAGS`), `VIZ_SCALE` colors, the `bancos.js`/`views.js`/`filtersSchema.js` registries,
   and the `MetricConventions` factor tables. The API returns the *keys* to join on (`uf`, flag
   `id`); the JS data layer decorates with `col`/`row`/`label`/`color`. Joining server-side would
   duplicate registries and invite drift.

4. **Magnitudes the API emits match the prototype's internal scale** so reused views work
   unchanged: `productTS.v` in **millions**, `overviewTS.v` in **billions**, mass quantity in
   **mil t** (÷1e3 from t), volume in **mi m³** (÷1e6 from m³), `ufData.value` in **millions**.
   Verified at `dataFilters.js:99` (`ts.v = productTS.v / 1000`).

## 1. REST API (`/api/*`, blueprint in `webapi/routes.py`)

All GET unless noted. `banco` ∈ {`ibge_pevs`,`mdic_comex`,`un_comtrade`}. Responses are JSON in
contracts.js shape. `preview:false` on all live producers (real data).

| Endpoint | Params | seam fn | Response (contracts.js typedef) |
|---|---|---|---|
| `/catalog` | — | `produto_catalog()` | `{cid:{id,name,pevs[],comex[],comtrade[]}}` ✅ done |
| `/source-meta` | `banco` | `source_meta(banco)` | provenance row dict ✅ done |
| `/snapshot` | `banco,currency,correction` | `snapshot(banco,conv)` *(summary=None → full)* | `BancoSnapshot` (§2) |
| `/product-uf` | `banco,code,currency,correction,startDate?,endDate?` | `product_uf_ranking(banco,code,conv,summary)` | `{uf:[{uf,name,region,value}]}` |
| `/geo-yearly` | `banco,codes?,currency,correction` | `geo_yearly(banco,conv,summary)` | `{ufYearly:[{year,uf,name,region,value,q_mass,q_vol}]}` — basket-scoped product×UF×year cube (full history; client slices period/state). `[]` for a banco with no geo grain. Lets the hero/choropleth/series respect state+product+período together |
| `/productivity` | `banco,crop?,y0?,y1?` | `productivity(banco,crop,summary)` | `ProductivityData` (PAM only; basket N/A — crop is the picker) |
| `/flow` | `banco,codes?,states?,y0?,y1?` | `flow_data(banco,summary)` | `FlowData` (Sankey nodes/links); `states` = origin-UF filter (COMEX only) |
| `/partners` | `banco,metric?,codes?,states?,y0?,y1?,reporters?,partners?` | `partner_data(banco,summary,metric)` | `PartnerData` (exp/imp split + `weight`/`price`/`pricedShare` + `belowFloor`); `metric` picks the SERVER-side ranking dimension, because the row order is the top-N cut; `states` = origin-UF filter (COMEX only) |
| `/monthly` | `banco,codes?,y0?,y1?` | `monthly_data(banco,summary)` | `MonthlyData` (COMEX only); UF (`states`) N/A — mart collapses UF away |
| `/cross/metric-refs` | — | `cross_metric_refs()` | `[{banco,banco_short,metric,label,family}]` |
| `/cross/series` | `banco,metric,y0?,y1?` | `cross_series(banco,metric,y0,y1)` | `SeriesResult` — `points` already in display unit |
| `/cross/export-coef` | `commodity?` | `export_coefficient(commodity)` | `ExportCoefficient` (camel `byUf`) |
| `/cross/market-share` | `commodity?` | `market_share(commodity)` | `MarketShare` (camel `byProduct`) |
| `/cross/price-spread` | `commodity?` | `price_spread(commodity)` | `PriceSpread` |
| `/cross/mirror` | `commodity?` | `trade_mirror(commodity)` | `TradeMirror` |
| `/cross/value-added` | `commodity?` | `value_added(commodity)` | `ValueAddedAnalysis` (add `years`,`byLevel`,`priceB/P`) |
| `/curation/worklist` | — | `curation_worklist()` | `{rows[],total,classified,pending,by_level}` |
| `/curation/code-level` | **POST** `{source,code,level}` | `record_code_level(...)` | writer result; author via IAP (`webapi/auth.current_author`) |
| `/tables` | `banco` | `inspectable_tables(banco)` | `[{id,label,grain,layer}]` — the allowlisted tables a researcher may browse across ALL FOUR medallion layers (`layer` ∈ bronze/silver/gold/serving), grouped per layer in the "Estrutura de dados" perspective; `[]` for a non-live banco. No dataset attr on the wire |
| `/table` | `banco,table,limit?,offset?,order_by?,order_dir?,filters?` | `table_page(banco,table,…)` | `{columns:[{name,type}],rows:[[…]],total,table,label,grain}` — one page of RAW rows for an allowlisted `(banco,table)`. Plain browse is FREE (`list_rows`, 0 bytes billed); a sort/filter runs a query under a tighter `RAW_TABLE_MAX_BYTES` cap. `filters` = JSON `[{col,op,val}]`, op ∈ eq/ne/gt/ge/lt/le/contains/is_null/not_null, ≤5 filters, page ≤500. Out-of-allowlist `(banco,table)`, an out-of-schema column, or a malformed value → 400 (never an opaque 500) |

**Active-filter params (`codes`/`states`/`y0`/`y1`)** — the trade adapters (`/flow`, `/partners`,
`/monthly`) and `/productivity` honour the view's FilterMenu selection. The producers serialize
the active summary into query params; `routes._filter_summary()` parses `codes` (comma-joined
product codes → `basket`), `states` (comma-joined UF acronyms → `states`, the origin-UF filter)
and `y0`/`y1` (year window → `startDate`/`endDate`) into the seam's summary shape; the seam threads
them into the gateway readers (`_basket` + `_states` + `_years_from_summary`). The UF filter binds
as an `IN UNNEST(@uf_codes)` predicate on `state_acronym` in `trade_flows`/`trade_by_partner`
(parameterized, never f-string-interpolated; empty/absent = no filter). Each producer's resource
cache key includes the filter signature (basket + states + window), so a changed selection
refetches scoped data instead of serving the first-loaded snapshot. **Not-applicable surfacing**:
`/productivity` honours the year window but NOT the product basket — its crop selector *is* the
product dimension — so `productivityData` returns `notApplicable.basket` (an honest pt-BR note)
when a basket is active, mirroring the cross-analytics' `incompatible` flag. The origin-UF filter
(`states`) applies to the **COMEX** flow/partner readers only — COMTRADE's origin is a reporter
country (no UF column) and the seasonality mart collapses UF away, so for those grains the producer
omits the `states` param and surfaces `notApplicable.states` (the same honest-note convention)
rather than silently dropping a genuine UF narrowing. The all-UFs-selected FilterMenu default is
NOT treated as a narrowing (no spurious note).

**`/source-meta` latest-year completeness (honest YoY).** The serialized `/source-meta` payload
carries a latest-year completeness signal so the frontend can compute YoY against the last
*complete* year instead of reading a partial latest year as a crash/boom. A monthly-sourced
banco (COMEX) publishes the current year month-by-month, so its `yearEnd` is usually partial
(the audit caught COMEX 2026 ≈ 39% of 2025 surfacing as a spurious −41% headline). The seam
derives the signal from `serving_comex_seasonality` (distinct `reference_month` per year); annual
bancos (PEVS/PAM/COMTRADE — `cadence:'annual'`) are complete by construction and issue no extra
query. Fields (camelCase, on the same payload as `yearStart`/`yearEnd`/`lastRefresh`):
- **`monthsInLatestYear`** `int|null` — distinct months present in `yearEnd` for a monthly banco;
  `null` for an annual banco (no month grain).
- **`latestYearComplete`** `bool` — `true` iff `yearEnd` has all 12 months. Always `true` for an
  annual banco. The frontend should **suppress or footnote the headline YoY when this is `false`**.
- **`latestCompleteYear`** `int|null` — the most recent FULLY-covered year (`yearEnd` when complete,
  else `yearEnd − 1`). Anchor the YoY base year on this to compare full-year vs full-year.

The frontend computes the YoY delta; the backend only supplies the truth about which year is
complete. No frontend change is shipped in this backend campaign — wiring the signal into the
Overview YoY is the frontend agent's follow-up.

**`ufData[].real`** `bool` (FINDING #4) — each `ufData` row now flags whether it is a real
Brazilian UF (`true`) or a COMEX special trade pseudo-code (`false`: EX/ND/ZN/MN/RE…, which have
no `state_name` from the UF lookup — the same discriminator `gold_source_metadata.ufs_total` uses).
The frontend can count `real === true` for the "UFs cobertas" tally (27) instead of inflating it
with pseudo-codes. PEVS/PAM rows are always `real:true`.

**Data-blocked** (no source): `chainBalance`, `harvestShipmentLag`, `marketNatureAnalysis`,
and the regime×flow market-nature axis. These ship honest in-product placeholders client-side
(no endpoint) until SEFAZ inter-UF flows / monthly PEVS / the customs-procedure dim exist.

## 2. `/snapshot` serializer (`webapi/serializers.py`) — gateway columns → contracts.js

`seam.snapshot(banco, conv, summary=None)` returns DataFrames keyed `products, product_ts,
overview_ts, uf_data, quality` + `value_label`. Reshape (per-family q-scale where noted):

- **products** ← `products` df cols `{code,name,unit,unit_native,family}` → `[{code,name,unit,family}]`.
- **productTS** ← `product_ts` cols `{code,reference_year,total_value,total_qty_native,family}`,
  GROUP BY `code` → `{code: [{y:reference_year, v:total_value/1e6, q:total_qty_native/(1e3 if family=='massa' else 1e6), family}]}`.
  Map family `'massa'→'mass'`, `'volume'→'volume'` (contracts.js uses `mass`).
- **overviewTS** ← `overview_ts` cols `{reference_year,total_value,q_mass,q_vol}` →
  `[{y:reference_year, v:total_value/1e9, q:q_mass/1e3, q_mass:q_mass/1e3, q_vol:q_vol/1e6}]`.
- **ufData** ← `uf_data` cols `{state_acronym,state_name,region,region_abbrev,total_value,q_mass,q_vol}` →
  `[{uf:state_acronym, name:state_name, region:region_abbrev, value:total_value/1e6, q_mass:q_mass/1e3, q_vol:q_vol/1e6, real}]`.
  *(col/row added client-side from `UF_DATA`. q_mass/q_vol are REAL now — the by-UF readers
  (`production_by_uf` / `comex_by_uf`) sum `qty_base` per `family` (massa → t, volume → m³), scaled
  to mil t / mi m³ exactly like overviewTS. NULL family-quantity → 0.0. `real` flags a Brazilian UF
  vs a COMEX pseudo-code — see FINDING #4 note above. **The by-UF readers are scoped to the LATEST
  year in the active window (`latest_year_only=True`), matching the latest-year national KPI — they
  no longer cumulate the whole `[startDate,endDate]` window, which inflated every UF tile by the
  number of covered years.** The full per-year history lives in `ufYearly`.)*
- **ufYearly** ← `uf_yearly` cols `{state_acronym,state_name,region,region_abbrev,reference_year,total_value,q_mass,q_vol}` →
  `[{year:reference_year, uf:state_acronym, name:state_name, region:region_abbrev, value:total_value/1e6, q_mass:q_mass/1e3, q_vol:q_vol/1e6}]`.
  *(REAL per-(UF, year) Gold history at the marts' `reference_year × uf` grain (~27 UFs × covered years, small).
  Backs ViewGeography's 'ano × UF' heatmap, which previously FABRICATED each UF's curve as ufTotal × (national
  year value ÷ max) — every state got the identical national trajectory. The by-UF-yearly readers
  (`production_by_uf_yearly` / `comex_by_uf_yearly`) add `reference_year` to `production_by_uf` / `comex_by_uf`'s
  grain; same per-family `qty_base` split + display scaling as `ufData`. col/row added client-side from `UF_DATA`.
  Trade bancos rename `total_value_usd→total_value`; COMEX only (PEVS/PAM also serve it). NULL family-quantity → 0.0.)*
- **quality** ← `quality` cols `{source,data_quality_flag,n_rows,share}` →
  `[{id:data_quality_flag, label:<pt-BR>, count:n_rows, share}]`. The id is a REAL Gold flag:
  `OK | MISSING_VALUE | MISSING_QUANTITY | INCOMPLETE` (PEVS/PAM/COMTRADE) + `MISSING_WEIGHT`
  (COMEX). `label` is emitted in pt-BR by the serializer (the frontend QUALITY_FLAGS registry lacks
  INCOMPLETE/MISSING_WEIGHT, so without a server label decorate.js falls back to the raw English id).
  color still added client-side; `share` is a 0-1 fraction (fmtPct ×100 expects that).
- **qualityTs** ← `quality_ts` (year×flag counts) → per-year SHARES (0-1) keyed by the contract flag
  keys: `[{y, ok, missing_value, missing_quantity, missing_weight, incomplete}]`. Each key reads 0
  when absent that year; an unmapped flag still counts toward the denominator (shares never sum >1
  by ignoring it). *Note: contracts.js still types these as ok/missing_value/missing_quantity/
  estimated/outlier/boundary (the prototype's synthetic set) — the F2 contracts.js owner must rename
  estimated/outlier/boundary → missing_weight/incomplete to match this real-Gold shape.*
- **qualityByProduct** ← `quality_by_product` (product×flag counts, top-20 by row volume) →
  `[{code, name, OK, MISSING_VALUE, MISSING_QUANTITY, MISSING_WEIGHT, INCOMPLETE}]` (per-product
  shares 0-1, keyed by the flag IDS; absent flags read 0).
- Trade bancos: `snapshot` already renames `total_value_usd→total_value`; `uf_data` only for COMEX
  (and now carries q_mass/q_vol per family from qty_base).
- `qualityTs`/`qualityByProduct` ARE served (in the snapshot payload). `topMunis` still not served
  (optional key) → omit or `[]`. `qualityByUf` was in this list too and never got a producer or an
  endpoint; the view that consumed it was dead code behind a `.length > 0` that was always false, and
  both were removed in v1.51.0.
- **Trade mirror partners line**: a new gateway cross metric `un_comtrade:partner_exp`
  (`partner_iso_a3 = Brazil`, flow=import — every other country's declaration of imports FROM Brazil)
  is plumbed in `serving/sql.py` + `serving/gateway.py`. `seam.trade_mirror` must call
  `_xyear("un_comtrade:partner_exp", comtrade_codes)` (÷1e9) and add `partners` to each series row so
  TradeMirror's third line ("Reportado pelos parceiros") gets data — see §2 wiring note below.

**Cross-analytics** (already near-shape): pass through with snake→camel (`by_product→byProduct`,
`by_uf→byUf`) and add `preview:false`. `value_added` needs derived `years`, `byLevel`
(`{bruta:[{y,v}],processada:[{y,v}]}` from series `brutaV`/`procV`), `priceB`/`priceP`.
`cross_series.points[].v` is **already display magnitude** (don't rescale); add `preview:false`,
`bancoMeta`/`metricMeta` joined client-side from `bancos.js`.

## 3. JS data layer (`frontend/src/data/*.js`) — replace synthetic bodies, keep `window.*`

Reuse `dataStore.js`/`dataFilters.js`. Replace ONLY the producer bodies with API-backed ones,
keeping identical names/signatures (the `window.*` surface the views call):

- `dataStore.load(bancoId, conv)` → `fetch('/api/snapshot?banco='+id+'&currency='+c+'&correction='+k)`;
  on success cache `{status:'ready', data: decorate(json)}`. `decorate` joins `col/row/region`
  from `UF_DATA` onto `ufData` (by `uf`) and `label/color` from `QUALITY_FLAGS` onto `quality`
  (by `id`). Re-load when conventions' currency/correction changes.
- `window.snapshotFor` → for non-PEVS fallback, same fetch (dataStore is the primary path now).
- `flowData/partnerData/monthlyData(bancoId, summary)` → fetch `/api/flow|partners|monthly` with the
  active-filter params (`codes`/`states`/`y0`/`y1` from `summary`; see §1 "Active-filter params");
  decorate labels from `bancoDim`. The resource key carries the filter signature (basket + states +
  window) so a changed selection refetches. `states` (origin-UF) is sent only when the banco's origin
  is a UF (`bancoDim(banco,'origin').kind === 'uf'` → COMEX); for a country-origin banco (COMTRADE)
  or the UF-less seasonality grain the producer omits it and sets `notApplicable.states`.
  `productivityData(bancoId, crop, summary)` → `/api/productivity` with `y0`/`y1` only
  (basket N/A → `notApplicable.basket`).
- `crossSeries/crossCommonWindow` → `/cross/series`,`/cross/metric-refs`; `bancoMeta`/`metricMeta`
  from registries client-side.
- `exportCoefficient/marketShare/priceSpread/tradeMirror/valueAddedAnalysis` → `/cross/*`.
- `chainBalance/harvestShipmentLag/marketNatureAnalysis` → keep returning a `preview:true`
  placeholder (data-blocked); the views already render an honest banner.
- `enrichment.*` (curation) → `codes()` from `/curation/worklist`; `setCode/apply` POST
  `/curation/code-level`. Keep the optimistic draft/commit UX.

### 3.1 Sync-over-async gating (the critical frontend design)

The reused views call producers **synchronously** during render and use the result immediately
(`const r = window.crossSeries(b,m,{})`). API calls are async. Bridge WITHOUT refactoring the
reused views:

- **Per-banco path (overview/value/geo/concentration/quality/profile)** — already solved. The
  reused `DataBoundary.useBancoData(banco)` calls `dataStore.load(banco, conv)` (async) and gates
  rendering on status; the view then reads `dataStore.get(banco)` (sync) via `applyFilters`.
  Migration: make `dataStore.load` fetch `/api/snapshot` and cache the decorated snapshot.
  Re-load when conventions' currency/correction change (key the cache by `banco|currency|correction`).
- **Cross-source / analytics / curation views** — have **no gate** (they get `{view}` props and call
  producers directly). Add a thin **preload gate** (new glue, NOT a change to the reused views):
  a `CrossBoundary({view, commodity})` wrapper that, on mount/commodity-change, fires the needed
  fetches into a module cache and shows the loading state until resolved; then renders the reused
  view. The producers (`crossSeries`, `exportCoefficient`, …) become **sync cache reads**: return the
  cached value if present, else a `{preview, …, _pending:true}` placeholder + kick off the fetch +
  `notify()` subscribers (the boundary re-renders → cache now hot → view reads real data). One
  generic helper backs this: `resource(key, urlFactory)` → `{get(key), ensure(key), subscribe}`.
- **Mount the boundary at the router seam** (in the new `main.jsx`/a small `MainScreen` wrapper),
  not inside the reused views. The cross views stay byte-for-byte reused.
- **Curation** is read+write: `enrichment.codes()` reads the worklist resource; `setCode`/`apply`
  POST and then invalidate the worklist resource + `notify()` (optimistic draft UX preserved).

## 4. Chart → Plotly.js components (`frontend/src/charts/`) — same names + props as Charts*.jsx

Each replaces a hand-rolled SVG with a Plotly.js trace, identical export name + props, theme from
CSS vars (`--viz-*`, fonts) read via `getComputedStyle`. Sparkline stays SVG (tiny, no interaction).

| Component | Plotly type | props (unchanged) |
|---|---|---|
| `LineChart` | scatter (lines+fill) | `data:[{y,[valueKey]}], valueKey='v', label, color, height` |
| `MultiLineChart` | scatter ×N | `series:[{name,color,data:[{y,v}]}], valueKey, label` |
| `BarChart` | bar (horizontal) | `data:[{uf|name,[valueKey]}], valueKey='value', color` |
| `Donut` | stayed SVG (share ring, no Plotly trace) | `data:[{name,color,[valueKey]}], valueKey='share'` |
| `StackedArea` | scatter stackgroup | `series:[{name,color,data:[{y,[valueKey]}]}], valueKey` |
| `YoYBars` | bar (signed) | `data:[{y,[valueKey]}]` (compute YoY) |
| `BrazilTileMap` | heatmap/scatter on 8×9 grid | `data:[{uf,col,row,region,[valueKey]}], valueKey, onSelect?` |
| `Heatmap` | heatmap | `rows:[{id,label,values:[{y,v}]}], valueKey` |
| `MonthYearHeatmap` | heatmap | `matrix:{year:[12]}, years, unit` |
| `FlagBars` | bar (100% stacked horiz) | `rows:[{...flagId:frac}], flags:[{id,label,color}], labelKey` |
| `RegionBars` | bar (vertical) | `data:[{id,label,color,[valueKey],ufs}], valueKey` |
| `LorenzCurve` | scatter + diagonal | `values:number[], xLabel, yLabel` |
| `SankeyChart` | sankey | `nodes:[{id,label,side,value}], links:[{source,target,value}], unit` |
| `DualAxisLineChart` | scatter, 2 yaxes | `series:[{label,color,unit,bancoShort,data:[{y,v}]}]` (group by unit) |
| `StackedPanels` | subplots | `series:[...], panelHeight` |
| `MonthlyOverlay` | scatter ×2 | `series:[{name,color,data:[12]}], months, markers` |
| `LagBars` | bar (signed) | `profile:[{lag,corr}], best` |

Use a Plotly **partial bundle** (custom, `plotly.js/lib/core` + traces) — scatter/bar/sankey/heatmap.
(No `pie`: the `Donut` stayed SVG, so no chart emits a Plotly pie trace — see `plotlyBundle.js`.)
Shared layout helper: transparent bg, CSS-var colors, `displayModeBar` on hover, pan/zoom enabled,
unified hover, pt-BR number locale.

## 5. Boot (`frontend/src/main.jsx`) — port `Dashboard.html` inline script

Order of side-effect imports (each proto module assigns `window.*` at import): registries
(`bancos`,`views`,`filtersSchema`,`glossary`,`urlState`,`chipFmt`,`seriesUtils`,`dataFilters`,
`csvExport`) → **new** `src/data/*` (replaces synthetic `data/dataStore/previewData/crossSource/
crossAnalytics/crossChain/enrichment`) → **new** `src/charts/*` (replaces `Charts*`) → shell+views
(`Atoms`,`Icon`,`Status`,`Sparkline`,`UnitFamily`,`DataBoundary`,`AppShell`,`MainScreen`,`View*`,
`FilterMenu`,`FilterTriggerBar`,`MetricConventions`,`Glossary`) → mount `<Dashboard/>` with
`readStateFromURL()`. `window.React`/`window.ReactDOM` set first (proto uses globals, no imports).

## 6. Required reused-code patch — `MetricConventions.jsx`

`convFactor(conv)` returns **1.0 for the currency×correction component** (server now serves the
correct deflated column) while keeping unit conversion + autoScale. Concretely: drop
`CORRECTION_FACTOR[correction] × CURRENCY_FX[currency].rate` from the value path; keep
`massQtyMul`/`volumeQtyMul` and `scaleSeries`/`autoScaleNum`. Currency/correction selectors still
drive the `/snapshot` re-fetch (via dataStore).

**The base-aware `convFactorFor(base, conv)` is ALSO 1.0** (it delegates to `convFactor`). It once
cross-converted a US$-native trade banco (COMEX/Comtrade) to a non-default display currency via a
**frozen mock FX rate** (`CURRENCY_FX.USD.rate = 0.205` etc.) — the wrong-number path on explicit
BRL/EUR selection. Now the BFF serves a trade snapshot IN the requested currency (the real BRL/USD/EUR
Gold column the trade marts carry), so there is nothing left to cross-convert. `CURRENCY_FX` is a
**symbol-only label table** (R$ / US$ / €) — the numeric `rate` field is GONE, so no future edit can
silently reintroduce mock FX. The trade flow/partner/monthly ADAPTERS stay US$-only (their unit string
is an explicit `"US$"`; they are not part of the convention-driven snapshot path).

## 7. Deploy cutover (task #7)

Multi-stage image in `deploy/webapi/`: node stage `npm ci && npm run
build` → `frontend/dist`; python stage `uv sync --extra webapi`, copy `dist`, set
`SPA_DIST_DIR=/app/frontend/dist`, run `gunicorn embrapa_dashboard.webapi.app:app`. Same Cloud
Run **Service**, same IAP, same runtime SA `sa-web-dashboard-prod`. User triggers the deploy.

## 8. Task order

#3 serializers+routes (snapshot+cross+curation) → test vs BQ · #4 `src/data/*` + dataStore patch ·
#5 `src/charts/*` Plotly · #6 `main.jsx` boot + `npm run build` + E2E (vite proxy → flask) ·
#7 deploy image · #8 deleted `dashboard/` (relocated seam/format/registries to `webapi/`), updated docs/memory.
