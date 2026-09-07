// contracts.js — THE SINGLE SOURCE OF TRUTH FOR DATA SHAPE.
//
// The dashboard has ONE seam between data and UI: a per-banco serving
// snapshot, four preview adapters, the cross-source/analytics/chain builders
// and the enrichment layer. Every one of those returns a fixed SHAPE; to go
// live the backend swaps the *body* of the producer and keeps the shape.
//
// "Single source of truth for the SHAPE" means the docs and code agree on what
// the frontend expects — it does NOT make the frontend an absolute authority
// over the real data. If the backend genuinely cannot produce a shape here, the
// rule is NOT to silently bend either side: the backend agent asks the project's
// LEAD DEVELOPER (final word), then changes the contract or adapts the backend.
// See design_handoff_commodities_backend/01_CONTRACT.md → "Escalation rule".
//
// This file is where that shape is DEFINED ONCE — in code, executable and
// enforced — so it can never silently drift from prose docs:
//
//   1. @typedef blocks below  → the human-readable shape reference. The API-backed
//      producers (src/data/producers.js + src/data/enrichment.js) and the handoff
//      doc (design_handoff_commodities_backend/02_SNAPSHOT_CONTRACTS.md) POINT
//      here instead of re-typing keys — no duplication, no drift.
//
//   2. window.SNAPSHOT_CONTRACTS  → the machine-readable required-keys
//      registry. One entry per producer; lists the keys a view depends on.
//
//   3. window.auditSnapshotContracts()  → a runtime drift LINT. It calls each
//      live producer and console.warns (once) if the returned object is
//      missing a contracted key. Mirrors window.auditBancoCoverage: console
//      only, never touches data. So if a builder loses a key the contract
//      promises, you see it in the console instead of a broken chart.
//
// The CONCRETE demo values (castanha chain etc.) live in the preview shells
// returned by src/data/producers.js and are NOT part of the contract — only the
// shape is normative.

// ════════════════════════════════════════════════════════════════════════
//  SHAPE REFERENCE (@typedef) — the canonical definition the docs point to
// ════════════════════════════════════════════════════════════════════════
//
// ── Per-banco serving snapshot — window.snapshotFor(bancoId) ─────────────
//    PEVS-shaped pre-aggregated result a pushdown query returns. IBGE PEVS is
//    the reference (served from data.js globals via dataStore.datasetFor);
//    every other banco produces the SAME keys from window.snapshotFor.
//
// @typedef {Object} BancoSnapshot
// @property {{code:string,name:string,unit:string,family:string,measure_kind?:string}[]} products       Product universe (family ∈ mass|volume|count|…). `measure_kind` (stock|flow) is present ONLY for livestock (PPM): 'stock' = herd headcount (value-less), 'flow' = animal product (eggs/milk). Lets the UI gate the herd ('Rebanho') view.
// @property {Object.<string,{y:number,v:number,q:(number|null),family:string}[]>} productTS  Per-product annual series, keyed by code. v=value (canonical), q=quantity in the family base unit (mass→mil t, volume→mi m³, count→mi un i.e. millions of head/eggs); q is null only for families with no display scale (energia/área).
// @property {{y:number,v:number,q:number,q_mass:number,q_vol?:number,q_count?:number}[]} overviewTS  Annual aggregate from the snapshot (v in bi; q_* per family). NOTE: overviewTS now carries q_count too (for parity with productTS/ufData), but the DISPLAYED herd count series is still recomputed client-side in dataFilters (filtered.ts.q_count) from productTS — never read off snapshot.overviewTS, never blended across families.
// @property {{uf:string,name:string,region:string,col:number,row:number,value:number,q_mass:number,q_vol?:number,q_count?:number}[]} ufData  Per-UF tile-map rows. ONLY for bancos providing `geo` (empty otherwise). q_count = mi un per UF (head/eggs). `region` is the canonical 2-letter region CODE (N/NE/CO/SE/S, window.REGIONS ids) — decorateUfRows normalizes a display-name region ("Norte") to its code so RegionBars matches.
// @property {{year:number,uf:string,name:string,region:string,col:number,row:number,value:number,q_mass:number,q_vol?:number,q_count?:number}[]} [ufYearly]  Per-(UF, year) Gold history backing the geography 'ano × UF' heatmap. ONLY for geo bancos with a per-year-by-UF mart (null otherwise). col/row decorated client-side.
// @property {{id:string,label:string,color:string,count:number,share:number}[]} quality  Quality-flag distribution (shared taxonomy).
// @property {{y:number,ok:number,missing_value:number,missing_quantity:number,missing_weight?:number,incomplete?:number,outlier_quantity?:number,problematic_quantity?:number,outlier_value?:number,problematic_value?:number,inferred_quantity?:number,inferred_value?:number,area_inconsistent?:number,unscored?:number}[]} [qualityTs]  Quality over coverage years. Each flag is a per-year SHARE (fraction 0–1, NOT a raw count) — the views multiply by 100 for %. Flags: OK/MISSING_VALUE/MISSING_QUANTITY/INCOMPLETE (+COMEX MISSING_WEIGHT); the OUTLIER_*/PROBLEMATIC_* tiers appear only when the dbt var enable_quality_outliers is on; INFERRED_QUANTITY/INFERRED_VALUE are reserved for a future auto-fill pipeline (accepted-but-absent, always 0 today); UNSCORED marks a row the outlier detector could not examine (no deflated value for that year), kept apart from OK so "examined and cleared" is not confused with "never examined".
// @property {Object[]} [qualityByProduct]  Per-product flag shares (keys = flag ids).
// @property {Object[]} [qualityByUf]       Per-UF not_ok share (tile-map shaped).
// @property {Object[]} [topMunis]          Municipality table (may be empty).
// @property {Object[]} [regions]           Region registry passthrough.
// @property {string}   [table]             Backend-reported Gold table name.
// @property {boolean}  [_synthetic]        Marker: representative, not real Gold.
//
// ── Preview adapters (src/data/producers.js) ─────────────────────────────
//
// @typedef {Object} FlowData            window.flowData(bancoId, summary)
// @property {boolean} preview
// @property {string}  unit
// @property {string}  originLabel        Dimension label for the origin side.
// @property {string}  destLabel          Dimension label for the destination side.
// @property {{id:string,label:string,side:'origin'|'dest',value:number}[]} nodes
// @property {{source:string,target:string,value:number}[]} links
//
// @typedef {Object} PartnerData         window.partnerData(bancoId, summary, metric)
// @property {boolean} preview
// @property {string}  flowLabel
// @property {string}  unit
// @property {{name:string,exp:number,imp:number,value:number,weight:number,price:(number|null)}[]} partners  value/exp/imp = US$ mi · weight = mil t (net) · price = US$/kg (value÷weight; null when no weight). Row order = the server-side ranking metric (Capital/Volume/Preço médio).
//
// @typedef {Object} MonthlyData         window.monthlyData(bancoId, summary)
// @property {boolean} preview
// @property {string}  unit               Value (Capital) unit — 'US$'.
// @property {string}  weightUnit         Volume unit — 'mil t' (net weight).
// @property {number[]} years
// @property {number[]} months           [1..12]
// @property {Object.<number,number[]>} matrix         year → 12 monthly VALUE (US$ mi) values.
// @property {number[]} monthlyAvg       12 value (US$ mi) values.
// @property {Object.<number,number[]>} weightMatrix   year → 12 monthly WEIGHT (mil t) values.
// @property {number[]} weightMonthlyAvg 12 weight (mil t) values.
// @property {{ym:string,y:number,m:number,v:number,w:number}[]} series   v = value (US$ mi), w = weight (mil t).
//
// @typedef {Object} ProductivityData    window.productivityData(bancoId, cropCode, summary)
// @property {boolean} preview
// @property {string}  yieldUnit         e.g. 'kg/ha' (intensity — area-weighted mean, NEVER summed).
// @property {string}  areaUnit          e.g. 'ha'.
// @property {{code:string,name:string}}   crop
// @property {{code:string,name:string}[]} crops
// @property {{yieldKgHa:number,areaHa:number,prodT:number,yieldCagr:number}} national
// @property {{y:number,yieldKgHa:number,areaHa:number,prodT:number}[]} series   prodT = yieldKgHa × areaHa ÷ 1000.
// @property {{uf:string,name:string,region:string,col:number,row:number,yieldKgHa:number,areaHa:number,prodT:number}[]} byUF   col/row decorated client-side (decorateUfRows).
//
// ── Cross-source builders (src/data/producers.js) ────────────────────────
//
// @typedef {Object} SeriesResult        window.crossSeries(bancoId, metricId, {y0,y1})
// @property {string}  banco
// @property {string}  metric
// @property {Object}  bancoMeta          Registry object (bancos.js).
// @property {Object}  metricMeta         Registry object (bancos.js).
// @property {string}  key                'banco:metric' — stable id.
// @property {string}  label
// @property {string}  unit               DISPLAY unit incl. magnitude (e.g. 'US$ bi', 'mil t'). Two series share an axis IFF unit strings match.
// @property {string}  family             currency | mass | volume | ratio | area | rendimento
// @property {boolean} preview
// @property {[number,number]} coverage
// @property {{y:number,v:number}[]} points
//
// ── Cross analytics (src/data/producers.js) ──────────────────────────────
//
// @typedef {Object} ExportCoefficient   window.exportCoefficient(productCode)
// @property {boolean} preview
// @property {string}  unit
// @property {{uf:string,name:string,region:string,col:number,row:number,production:number,exportV:number,coefPct:number}[]} byUf
// @property {{production:number,exportV:number,coefPct:number}} national
// @property {{y:number,v:number}[]} timeseries
//
// @typedef {Object} MarketShare         window.marketShare(productCode)
// @property {boolean} preview
// @property {string}  unit
// @property {{y:number,br:number,world:number,share:number}[]} series
// @property {{code:string,name:string,share:number}[]} byProduct
//
// @typedef {Object} PriceSpread         window.priceSpread(productCode)
// @property {boolean} preview
// @property {string}  unit
// @property {{y:number,gate:number,fob:number,spread:number,markup:number}[]} series
//
// @typedef {Object} TradeMirror         window.tradeMirror(productCode)
// @property {boolean} preview
// @property {string}  unit
// @property {{y:number,mdic:number,comtrade:number,partners:(number|null)}[]} series   BR exports as seen by MDIC (SECEX), by UN Comtrade (reporter = Brazil), AND the partner-reported mirror (partners = partners' reported imports FROM Brazil, un_comtrade:partner_exp; null when that year has no partner data). All three series are plotted in ViewsMultiSource ("Reportado pelos parceiros").
// @property {{y:number,v:number}[]} discrepancy
//
// ── Cross chain — EXTENDED contracts (src/data/producers.js) ─────────────
//
// @typedef {Object} ChainBalance        window.chainBalance(productCode, year)
// @property {boolean} preview
// @property {string}  unit
// @property {number}  year
// @property {number}  produced          produced = exported + internal + domestic (mass conserved).
// @property {number}  exported
// @property {number}  internal
// @property {number}  domestic
// @property {number}  expFrac
// @property {number}  intFrac
// @property {number}  domFrac
// @property {number}  worldShare
// @property {number}  worldTotal
// @property {number}  exportUsd
// @property {{nodes:{id:string,label:string,side:string,value:number}[],links:{source:string,target:string,value:number}[]}} sankey
//
// @typedef {Object} HarvestShipmentLag  window.harvestShipmentLag(productCode)
// @property {boolean}  preview
// @property {string[]} months           12 labels.
// @property {number[]} production        12 monthly values (peak=100; MODELED from annual PEVS).
// @property {number[]} shipments         12 monthly values (peak=100; MDIC monthly).
// @property {number}   peakHarvest       Month index 0–11.
// @property {number}   peakShip          Month index 0–11.
// @property {number}   lagMonths         Best cross-correlation lag.
// @property {number}   corrAtLag
// @property {{lag:number,corr:number}[]} lagProfile   lag −6…+6.
//
// ── Enrichment analyses (src/data/enrichment.js) ─────────────────────────
//
// @typedef {Object} ValueAddedAnalysis  window.valueAddedAnalysis(groupId)
// Since v1.9.4 the industrialization axis is an open-vocabulary 8-level ordinal scale
// (no longer the fixed {bruta, processada} pair). The by-level maps are pivoted
// DYNAMICALLY over `levels`, keyed by each level id — the frontend reads byLevel[l.id]
// (see enrichment.js / producers.js).
// @property {boolean}  preview
// @property {string[]} levels         Ordered level ids present in the analysis (least→most processed).
// @property {number[]} years
// @property {Object.<string,{y:number,v:number}[]>} byLevel        {<levelId>: [{y,v}]} — value (US$ bi) per level, a point per year (0 where absent).
// @property {Object.<string,{y:number,v:number}[]>} byLevelWeight  {<levelId>: [{y,v}]} — volume (mil t) per level; backs the 100% volume composition.
// @property {Object.<string,{y:number,v:number}[]>} byLevelPrice   {<levelId>: [{y,v}]} — unit price (US$/kg) per level.
// @property {Object[]} series          One row per year: {y, levels:{<levelId>:{v,w,price}}} — the raw per-level pivot source.
// @property {number}   premium         Price premium of the most- vs least-processed level.
// @property {?string}  predominant     Level id with the largest value share.
// @property {number}   nCodes   Count of classified COMEX codes included in the analysis (the "Códigos na análise" KPI).
//
// @typedef {Object} MarketNatureAnalysis  window.marketNatureAnalysis()
// @property {boolean}  preview
// @property {number[]} years
// @property {Object[]} series            One row per year; a key per ENRICH_MARKETS id.
// @property {Object}   latest            Last series row.

(function () {
  // ── Machine-readable required-keys registry ──────────────────────────
  // One entry per producer. `required` = the keys a VIEW depends on (the
  // contracted surface, not every incidental field). `produce` calls the
  // live builder so the lint validates the real output. `appliesTo` gates
  // per-banco contracts to the bancos that declare the capability. `extra`
  // adds conditional checks (e.g. geo bancos must ship a non-empty ufData).
  const has = (b, cap) => !!(b && b.provides && b.provides.includes(cap));

  window.SNAPSHOT_CONTRACTS = {
    // ── per-banco producers ──────────────────────────────────────────
    perBanco: {
      snapshot: {
        typedef: 'BancoSnapshot',
        required: ['products', 'productTS', 'overviewTS', 'quality'],
        // PEVS serves from data.js globals (snapshotFor returns null) → skipped
        // here; it is the reference shape this contract is modelled on.
        produce: (b) => (window.snapshotFor ? window.snapshotFor(b.id) : null),
        extra: (o, b) => (has(b, 'geo') && !(o.ufData && o.ufData.length))
          ? ['ufData vazio (banco provê `geo`)'] : [],
      },
      flow: {
        typedef: 'FlowData',
        required: ['preview', 'unit', 'originLabel', 'destLabel', 'nodes', 'links'],
        appliesTo: (b) => has(b, 'flow'),
        produce: (b) => (window.flowData ? window.flowData(b.id, {}) : null),
      },
      partner: {
        typedef: 'PartnerData',
        required: ['preview', 'flowLabel', 'unit', 'partners'],
        appliesTo: (b) => has(b, 'partner'),
        produce: (b) => (window.partnerData ? window.partnerData(b.id, {}) : null),
      },
      monthly: {
        typedef: 'MonthlyData',
        required: ['preview', 'unit', 'years', 'months', 'matrix', 'monthlyAvg',
          'weightMatrix', 'weightMonthlyAvg', 'series'],
        appliesTo: (b) => has(b, 'monthly'),
        produce: (b) => (window.monthlyData ? window.monthlyData(b.id, {}) : null),
      },
      productivity: {
        typedef: 'ProductivityData',
        required: ['preview', 'yieldUnit', 'areaUnit', 'crop', 'crops', 'national', 'series', 'byUF'],
        appliesTo: (b) => has(b, 'yield'),
        produce: (b) => (window.productivityData ? window.productivityData(b.id, null, {}) : null),
      },
    },

    // ── global (commodity-level) producers — validated once on a sample ──
    global: {
      crossSeries: {
        typedef: 'SeriesResult',
        required: ['banco', 'metric', 'key', 'label', 'unit', 'family', 'preview', 'coverage', 'points'],
        produce: () => {
          const b = (window.visibleBancos ? window.visibleBancos() : (window.BANCOS || []))
            .find(x => x.metrics && x.metrics.length);
          return (b && window.crossSeries) ? window.crossSeries(b.id, b.metrics[0].id, {}) : null;
        },
      },
      exportCoefficient: {
        typedef: 'ExportCoefficient',
        required: ['preview', 'unit', 'byUf', 'national', 'timeseries'],
        produce: () => (window.exportCoefficient ? window.exportCoefficient(null) : null),
      },
      marketShare: {
        typedef: 'MarketShare',
        required: ['preview', 'unit', 'series', 'byProduct'],
        produce: () => (window.marketShare ? window.marketShare(null) : null),
      },
      priceSpread: {
        typedef: 'PriceSpread',
        required: ['preview', 'unit', 'series'],
        produce: () => (window.priceSpread ? window.priceSpread(null) : null),
      },
      tradeMirror: {
        typedef: 'TradeMirror',
        required: ['preview', 'unit', 'series', 'discrepancy'],
        produce: () => (window.tradeMirror ? window.tradeMirror(null) : null),
      },
      chainBalance: {
        typedef: 'ChainBalance',
        required: ['preview', 'unit', 'year', 'produced', 'exported', 'internal', 'domestic',
          'expFrac', 'intFrac', 'domFrac', 'worldShare', 'worldTotal', 'exportUsd', 'sankey'],
        produce: () => (window.chainBalance ? window.chainBalance(null, 2024) : null),
      },
      harvestShipmentLag: {
        typedef: 'HarvestShipmentLag',
        required: ['preview', 'months', 'production', 'shipments', 'peakHarvest', 'peakShip',
          'lagMonths', 'corrAtLag', 'lagProfile'],
        produce: () => (window.harvestShipmentLag ? window.harvestShipmentLag(null) : null),
      },
      valueAddedAnalysis: {
        typedef: 'ValueAddedAnalysis',
        required: ['preview', 'years', 'byLevel', 'byLevelWeight', 'series'],
        produce: () => (window.valueAddedAnalysis ? window.valueAddedAnalysis(null) : null),
      },
      marketNatureAnalysis: {
        typedef: 'MarketNatureAnalysis',
        required: ['preview', 'years', 'series', 'latest'],
        produce: () => (window.marketNatureAnalysis ? window.marketNatureAnalysis() : null),
      },
    },
  };

  // ── Runtime drift LINT ───────────────────────────────────────────────
  // Calls each live producer and collects any CONTRACTED key that is absent
  // from the returned object. Warns ONCE (console only — never touches data),
  // mirroring window.auditBancoCoverage. A null producer result is SKIPPED
  // (the banco doesn't serve that producer yet — e.g. snapshotFor for PEVS,
  // which is the data.js reference). Run it after the data layer has loaded.
  const missingKeys = (obj, required) => required.filter(k => !(k in obj));

  window.auditSnapshotContracts = function () {
    if (window.__contractsAudited) return;
    window.__contractsAudited = true;
    const C = window.SNAPSHOT_CONTRACTS;
    const bancos = window.visibleBancos ? window.visibleBancos() : (window.BANCOS || []);
    const problems = [];

    Object.entries(C.perBanco).forEach(([name, spec]) => {
      bancos.forEach(b => {
        if (spec.appliesTo && !spec.appliesTo(b)) return;
        let obj;
        try { obj = spec.produce(b); } catch (e) { problems.push(`${name}(${b.id}) threw: ${e.message}`); return; }
        if (obj == null) return;                       // not served here — skip
        const miss = missingKeys(obj, spec.required);
        const extra = spec.extra ? spec.extra(obj, b) : [];
        if (miss.length || extra.length) {
          problems.push(`${name}(${b.id}) [${spec.typedef}] → ${[...miss.map(k => 'missing `' + k + '`'), ...extra].join(', ')}`);
        }
      });
    });

    Object.entries(C.global).forEach(([name, spec]) => {
      let obj;
      try { obj = spec.produce(); } catch (e) { problems.push(`${name} threw: ${e.message}`); return; }
      if (obj == null) return;
      const miss = missingKeys(obj, spec.required);
      if (miss.length) problems.push(`${name} [${spec.typedef}] → ${miss.map(k => 'missing `' + k + '`').join(', ')}`);
    });

    if (problems.length) {
      console.warn(
        '[contract] shape drift detected in ' + problems.length + ' producer(s):\n  ' +
        problems.join('\n  ') +
        '\n→ align the builder with contracts.js (SNAPSHOT_CONTRACTS + matching @typedef), ' +
        'the single source of shape.'
      );
    }
  };

  // Defer the audit until the full data layer has executed (all sync <script>
  // builders run before window 'load'). The Babel/JSX views run later but the
  // lint only needs the plain-JS producers, all loaded by now.
  if (document.readyState === 'complete') window.auditSnapshotContracts();
  else window.addEventListener('load', () => window.auditSnapshotContracts());
})();
