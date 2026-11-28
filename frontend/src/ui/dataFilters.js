// dataFilters.js — applies the active filter selection to every dataset
// used by the views, so charts/KPIs ONLY show rows that match.
//
// Import explícito (e não só a ordem em main.jsx): este módulo depende dos
// primitivos de ausência de seriesUtils (addPresent). A ordem em main.jsx já
// garantia isso em produção, mas os testes importam dataFilters sozinho — a
// dependência precisa ser real, não convencional.
import './seriesUtils.js';
// countGroups: the basket's counts, split by what they count (countUnits.js).
import './countUnits.js';
// productsInOrigin: the products the screen's origin (SIDRA table) offers (v1.108.5).
import './productOrigin.js';
//
// Input shape (from FilterMenu.onApply):
//   { basket:    string[]  // product codes;  null = all · [] = none
//   , flags:     string[]  // quality flags;   null = all · [] = none
//   , states:    string[]  // UF codes;        null = all · [] = none
//   , munis:     string[]  // município codes (cascade); narrows the município cube
//                          //   (and thus the cube-ranked topMunis), code-keyed
//   , nations, regions     // cascade parents; their effect reaches the data
//                          //   through `states` (deselecting prunes states)
//   , startDate, endDate   // 'YYYY-MM-01'
//   }
//
// Output: { ts, productTS, ufData, regionData, topMunis, topProducts,
//           qualityFlags, qualityFlagsFull, qualityTs, selectedProducts, yearStart, yearEnd,
//           notFilteredByBasket, _shares }

(function () {
  const yearOf = (iso) => iso ? parseInt(iso.slice(0, 4), 10) : null;

  // ── Sub-UF / município geography facets (the IBGE mesh cascade) ─────────────
  // The FilterMenu emits five CODE arrays — mesos/micros (classic division) +
  // inters/imediatas (2017 division) + munis. A facet CONSTRAINS the data only when
  // it is a PROPER, NON-EMPTY subset of its universe: null, [] (a cascade-emptied
  // child — selecting a parent after "Limpar" leaves children empty), and the full
  // selection ALL mean "no constraint". This both avoids fetching the heavy município
  // cube when nothing is narrowed AND keeps a parent-only narrowing (e.g. one
  // mesorregião, children untouched/empty) correct. Needs the mesh for the per-level
  // universe sizes.
  const GEO_FACET_KEYS = ['mesos', 'micros', 'inters', 'imediatas', 'munis'];
  const _facetCode = {
    mesos: (m) => (m.meso && m.meso.code) || '',
    micros: (m) => (m.micro && m.micro.code) || '',
    inters: (m) => (m.intermediaria && m.intermediaria.code) || '',
    imediatas: (m) => (m.imediata && m.imediata.code) || '',
    munis: (m) => m.cityCode,
  };
  function geoFacetSets(summary, mesh) {
    const sets = {};
    const constrained = {};
    const universe = {};
    if (mesh) {
      for (const k of GEO_FACET_KEYS) {
        const u = new Set();
        for (const m of mesh) { const c = _facetCode[k](m); if (c) u.add(c); }
        universe[k] = u.size;
      }
    }
    let active = false;
    for (const k of GEO_FACET_KEYS) {
      const arr = summary[k];
      sets[k] = arr == null ? null : new Set(arr);
      const c = !!(mesh && sets[k] && sets[k].size > 0 && sets[k].size < (universe[k] || Infinity));
      constrained[k] = c;
      if (c) active = true;
    }
    return { sets, constrained, active };
  }
  // A município passes a facet iff that facet does NOT constrain, or its code is in
  // the selection. A blank code ('' — e.g. a post-classic município has no classic
  // meso/micro) is never in the set, so a NARROWING classic facet correctly excludes
  // it (it genuinely belongs to no mesorregião); it stays filterable by the 2017
  // levels it does have, and is unaffected when a facet isn't narrowing.
  function muniPassesFacets(anc, gf) {
    const ok = (k, code) => !gf.constrained[k] || gf.sets[k].has(code);
    return ok('mesos', (anc.meso && anc.meso.code) || '')
      && ok('micros', (anc.micro && anc.micro.code) || '')
      && ok('inters', (anc.intermediaria && anc.intermediaria.code) || '')
      && ok('imediatas', (anc.imediata && anc.imediata.code) || '')
      && (!gf.constrained.munis || gf.sets.munis.has(anc.cityCode));
  }
  // Roll the município cube up to (UF, year), summing ONLY the municípios that clear
  // every active facet (resolved via the mesh cityCode→ancestry). Output rows are
  // shape-identical to the UF cube (window.geoYearly), so they slot straight into the
  // existing geoSource / ufData / sumStates logic — the map stays a UF choropleth,
  // narrowed to the selected sub-UF groups.
  function rollupMuniCubeToUf(muniCube, mesh, gf) {
    const anc = {};
    for (const m of mesh) anc[m.cityCode] = m;
    const byUfYear = new Map();
    for (const r of muniCube) {
      const a = anc[r.cityCode];
      if (!a || !muniPassesFacets(a, gf)) continue;
      const key = `${r.uf}|${r.year}`;
      let row = byUfYear.get(key);
      // `value` nasce null (ausente) e só vira número quando algum município do
      // recorte tiver valor — mesma regra de sumStates/addPresent. As quantidades
      // nascem em 0 porque ali o zero é um zero de verdade.
      if (!row) {
        row = { uf: r.uf, year: r.year, value: null, q_mass: 0, q_vol: 0,
                q_count_stock: 0, q_count_flow: 0, rows: 0 };
        byUfYear.set(key, row);
      }
      row.value = window.addPresent(row.value, r.value == null ? NaN : r.value);
      row.q_mass += r.q_mass || 0;
      row.q_vol += r.q_vol || 0;
      // The herd and the counted production stay two totals (countUnits.js).
      row.q_count_stock += r.q_count_stock || 0;
      row.q_count_flow += r.q_count_flow || 0;
      row.rows = addCount(row.rows, r.rows);
    }
    return [...byUfYear.values()];
  }

  // The Gold rows behind a sum of points (v1.108.9), added STRICTLY: one point that came
  // without its count (`rows`, a payload from before the reads carried it) makes the whole
  // sum unknown (null), never a smaller number. The opposite of addPresent, on purpose: a
  // value total may skip a missing value and stay a total of what is present, but a row
  // count that skips a point is simply a wrong count.
  function addCount(acc, n) {
    return (acc != null && Number.isFinite(n)) ? acc + n : null;
  }

  // The donut's slices from rows of { name, tabela?, value } — biggest first, at most seven
  // (else the six biggest plus "Outros"), each with its `share` and colour. ONE function for
  // the national composition (applyFilters' topProducts) and the recorte's (Visão geral under
  // a sub-UF recorte), so the two cannot slice one basket two ways.
  window.compositionSlices = function compositionSlices(rows) {
    const raw = (rows || [])
      // Uma FATIA é uma parte de um total. Um produto sem valor medido naquele ano (a
      // convenção escolhida não alcança o ano) não é uma fatia de tamanho zero — ele
      // não é fatia nenhuma. Deixá-lo entrar como 0 fazia o Donut listar produtos com
      // "0%" como se tivessem sido medidos e não tivessem produzido nada.
      .filter(p => Number.isFinite(p.value))
      .sort((a, b) => b.value - a.value);
    // Sem `|| 1`: ele fabricava o denominador. Com total não-positivo não há composição
    // a mostrar — um donut de zeros rotula "0%" em cada fatia (Donut.jsx desenha o
    // rótulo), afirmando participação nula onde o que existe é ausência de dado.
    const total = window.sumPresent(raw.map(p => p.value));
    const COLORS = [...window.VIZ_SCALE, 'var(--pres-gray-300)', 'var(--pres-gray-400)'];
    if (!total || total <= 0) return [];
    if (raw.length <= 7) {
      return raw.map((p, i) => ({
        ...p, share: window.ratioPresent(p.value, total), color: COLORS[i % COLORS.length],
      }));
    }
    const head = raw.slice(0, 6);
    const tailVal = raw.slice(6).reduce((s, p) => s + p.value, 0);
    return [
      ...head.map((p, i) => ({
        ...p, share: window.ratioPresent(p.value, total), color: COLORS[i],
      })),
      { name: 'Outros', value: tailVal, share: window.ratioPresent(tailVal, total),
        color: 'var(--pres-gray-200)', muted: true },
    ];
  };

  window.applyFilters = function (summary, bancoId) {
    summary = summary || {};

    // ── Resolve the in-memory snapshot for the active banco ────────────
    // Banco-aware seam: when a bancoId is given and its snapshot is loaded,
    // read from it. Every call site passes the active bancoId; the snapshot is
    // the single data source (src/data/dataStore.js → /api/snapshot).
    const fromStore = (bancoId && window.dataStore && window.dataStore.get)
      ? window.dataStore.get(bancoId) : null;
    // Optional per-banco fallback hook (window.snapshotFor) — returns null today,
    // kept as a seam for a future pre-load source.
    const fromSynth = (!fromStore && bancoId && window.snapshotFor)
      ? window.snapshotFor(bancoId) : null;
    // No snapshot loaded yet (or it errored): degrade to an EMPTY dataset so the
    // views render blank rather than fabricated figures. (The prototype used to
    // fall back to synthetic PEVS globals here; those were removed with the move
    // to the API-backed snapshot — see src/data/.)
    const snap = fromStore || fromSynth || {
      products: [], productTS: {}, overviewTS: [], ufData: [], ufYearly: [],
      quality: [], qualityTs: [], topMunis: [], regions: window.REGIONS || [],
      qualityByProduct: [],
    };
    const PRODUCTS_T   = snap.products   || [];
    const PRODUCT_TS_T = snap.productTS  || {};
    const OVERVIEW_T   = snap.overviewTS || [];
    const UF_DATA_T    = snap.ufData     || [];
    const QUALITY_T    = snap.quality    || [];
    const QUALITY_TS_T = snap.qualityTs  || [];
    const REGIONS_T    = snap.regions    || window.REGIONS || [];

    const allProducts = PRODUCTS_T.map(p => p.code);
    // The products the screen's ORIGIN offers: one SIDRA table, or all of them (v1.108.5).
    // The selection never reaches past it. Under "Extração vegetal" the silvicultura produtos
    // are not selected, so every count of the selection leaves them out, as the numbers
    // already did (the series are read per table since v1.108.4). `allProducts` stays the
    // banco's universe, the hero's denominator.
    const productUniverse = window.productsInOrigin(PRODUCTS_T, summary.tabela);
    const universeCodes = new Set(productUniverse.map(p => p.code));
    // Distinguish "no product filter applied" (basket == null → all) from
    // "explicitly cleared" (basket == [] → none). Zero always means none.
    const basket = summary.basket == null ? allProducts : summary.basket;
    const selectedProducts = basket.filter(c => universeCodes.has(c));

    const yearStart = yearOf(summary.startDate) || (OVERVIEW_T[0] && OVERVIEW_T[0].y) || 1986;
    const yearEnd   = yearOf(summary.endDate)   || (OVERVIEW_T[OVERVIEW_T.length - 1] && OVERVIEW_T[OVERVIEW_T.length - 1].y) || 2024;

    // Same null-vs-empty rule as the basket: undefined/null = "no filter"
    // (all); an explicit empty array = "none selected" (zero rows). An empty
    // Set is truthy, so the `!set ||` / `set ?` guards downstream correctly
    // resolve null→all and empty-Set→none.
    const flagSet  = summary.flags  == null ? null : new Set(summary.flags);
    const stateSet = summary.states == null ? null : new Set(summary.states);

    // ── Geography-aware aggregation (product × UF × year) ──────────────
    // The national per-product series (PRODUCT_TS_T) can honour a product basket
    // and a year window, but NOT a state filter (it has no UF grain). The snapshot's
    // ufYearly carries (UF × year) but is ALL-products (so it can honour state + year
    // but not a basket). To make VALOR TOTAL / the choropleth / the series respect
    // state + product + period TOGETHER, we pull a basket-scoped (UF × year) cube on
    // demand (window.geoYearly → /api/geo-yearly) and aggregate it client-side.
    const hasGeoData = UF_DATA_T.length > 0;
    const ufYearlyAll = Array.isArray(snap.ufYearly) ? snap.ufYearly : [];
    // A basket genuinely narrows products only when a proper, non-empty subset is
    // selected (null = all; [] = none → handled by the empty-series path below).
    //
    // "Proper" is measured against the ORIGIN's products (v1.108.5): under "Extração
    // vegetal" the snapshot's grid is already the extração's, so a basket of all 7 extração
    // produtos narrows nothing and needs no cube. A basket that names produtos of the banco
    // but NONE of the origin (only silvicultura codes under "Extração vegetal") still asks
    // for the cube, which comes back empty: that measured "nothing" is the answer, where the
    // snapshot's grid would show every extração produto. Without an origin this is the rule
    // it always was (the basket ∩ the banco, non-empty and short of the banco).
    const basketNamesBanco = basket.some((c) => allProducts.includes(c));
    const basketActive =
      hasGeoData && summary.basket != null &&
      basketNamesBanco && selectedProducts.length < productUniverse.length;
    // A state filter genuinely narrows only below the canonical 27-UF universe (the
    // all-selected default is NOT a narrowing). Summing the (UF × year) grid over a
    // proper subset is the only case where it diverges from the national series.
    const _ufUniverse = (window.UF_DATA || []).length || 27;
    const stateNarrowing =
      hasGeoData && stateSet != null &&
      (stateSet.size === 0 || stateSet.size < _ufUniverse);
    // Sub-UF / município narrowing (the IBGE mesh cascade): when the user picks
    // specific meso/micro/intermediária/imediata/município groups, the UF cube is too
    // coarse — pull the município cube (basket-scoped, /api/municipio-yearly) and roll
    // it up to (UF, year) over ONLY the municípios passing every active facet (via the
    // mesh). The result is UF-yearly rows, so it flows through the SAME series/map
    // logic below; the map stays a UF choropleth, narrowed to the chosen sub-UF groups.
    // Fetch the mesh up front (cheap, cached) so geoFacetSets can size each facet's
    // universe and decide whether it genuinely narrows (proper non-empty subset).
    // Only a NON-EMPTY facet array is a real narrowing that needs the heavy IBGE mesh:
    // null (all) and [] (a cascade-emptied child) both mean "no constraint" (see above),
    // so a trade banco — whose hidden cascade stays at full selection (→ null) — never
    // triggers a wasted ~5570-row mesh fetch (DATA-2).
    const _hasGeoKeys = GEO_FACET_KEYS.some((k) => Array.isArray(summary[k]) && summary[k].length);
    const meshState = (_hasGeoKeys && window.geoMeshState) ? window.geoMeshState() : null;
    const mesh = meshState ? meshState.municipios : null;
    // A real sub-UF narrowing was requested but the mesh hasn't landed yet: treat the
    // geography as PENDING (below) so the views show loading rather than the un-narrowed
    // all-UF grid for that transient (GEO-2). Mitigated by main.jsx warming the mesh at
    // startup, so this is usually already false by the time a filter is applied.
    // A mesh that FAILED is not pending: nothing is coming, and the narrowing cannot be
    // resolved at all. It is reported apart (subUfLoadError, below) — until v1.108.1 it
    // read as pending forever, and the screens said "carregando" for good.
    const subUfMeshError = (_hasGeoKeys && meshState && meshState.loadError) || null;
    const subUfMeshPending = _hasGeoKeys && !mesh && !subUfMeshError;
    const geoFacets = geoFacetSets(summary, mesh);
    // Resolve the active sub-UF/município selection to its município code set (via the
    // mesh) and pass it to the cube, so the Gold scan covers only those cities.
    const narrowedCities = (geoFacets.active && mesh)
      ? mesh.filter((m) => muniPassesFacets(m, geoFacets)).map((m) => m.cityCode)
      : null;
    // A sub-UF/município narrowing is active once the mesh is loaded AND a facet narrows.
    const subUfActive = narrowedCities != null;
    // The município cube's read (window.municipioYearly): `rows` is null in flight AND after
    // a failure — `loading`/`loadError` say which — [] when it loaded empty (zero cities
    // pass the facets, or those cities produce none of the basket), [...] = rows. We MUST
    // distinguish loaded-empty from not-loaded so an empty selection shows an honest "no
    // data" instead of an eternal spinner, a failure from both so it never reads as either
    // — and NEVER fall back to the all-UF grid (which would display data the selection
    // explicitly excludes).
    const muniState = subUfActive
      ? (narrowedCities.length && window.municipioYearly
          ? window.municipioYearly(bancoId, summary, narrowedCities)
          // zero cities pass → determinately empty, not a pending fetch
          : { rows: [], priceBase: null, loading: false, loadError: null })
      : null;
    const muniCube = muniState ? muniState.rows : null;
    const subUfLoaded = subUfActive && muniCube != null; // [] counts as loaded
    // The narrowing failed for good — its mesh, or its cube. Neither the narrowed numbers nor
    // the un-narrowed ones may stand in for the selection; the views say it failed. Gated on
    // geo data exactly like the pending flags below: a banco with no territory has nothing
    // a sub-UF facet left over from another banco could narrow.
    const subUfLoadError = hasGeoData
      ? (subUfMeshError || (muniState && muniState.loadError) || null)
      : null;
    // A requested narrowing whose mesh failed can never be resolved, yet it still OWNS the
    // geo grid, like an active narrowing with no rows: without this the grid fell back to the
    // un-narrowed one, and a screen drew whole states under a sub-UF chip, right below the
    // note saying the narrowing failed. A failed cube needs nothing extra: an active
    // narrowing already owns the grid.
    const subUfUnresolved = !!(hasGeoData && subUfMeshError);
    const subUfCube = (subUfLoaded && mesh) ? rollupMuniCubeToUf(muniCube, mesh, geoFacets) : null;
    // The basket-scoped (UF × year) cube's read (window.geoYearly): `rows` is null in flight
    // AND after a failure — `loading`/`loadError` say which — and [] when it loaded empty.
    // Only fetched when a basket is active — a state-only narrowing reads the all-products
    // ufYearly already in the snapshot (no extra round-trip).
    const basketGeoState = (basketActive && window.geoYearly)
      ? window.geoYearly(bancoId, summary) : null;
    const basketGeoCube = basketGeoState ? basketGeoState.rows : null;
    // Precedence: a sub-UF narrowing OWNS the geo grid (its rollup once loaded — even
    // when empty; nothing when it cannot be resolved); else the basket cube; else the
    // snapshot's all-products grid.
    const subUfOwnsGrid = subUfActive || subUfUnresolved;
    const geoCube = subUfOwnsGrid ? subUfCube : basketGeoCube;
    // The basket cube is loaded once its rows are KNOWN, an empty list included: a measured
    // "nothing" is an answer. Until v1.108.2 its `length` stood for "loaded", so a basket with
    // no row in any UF kept the all-products map and, beside a UF subset, held VALOR TOTAL at
    // "…" for good — the same eternal wait a failed cube caused.
    const useCube = subUfOwnsGrid ? subUfLoaded : basketGeoCube != null;
    // The basket cube failed for good while the grid needed it (a sub-UF narrowing owns the
    // grid otherwise, and its município cube already carries the basket).
    const basketGeoLoadError = (!subUfOwnsGrid && basketGeoState && basketGeoState.loadError) || null;
    // Pending ONLY while the cube fetch is in flight — NOT when it loaded empty, and not
    // when it failed (subUfLoadError).
    const subUfPending = hasGeoData && subUfActive && !subUfLoaded && !subUfLoadError;
    // The (UF × year) source for the geo-derived series/map. A sub-UF narrowing reads its
    // own rollup (rows, or [] when empty/pending) — never the all-UF fallback; else the
    // basket cube when ready, else the snapshot's all-products grid.
    const geoSource = subUfOwnsGrid ? (subUfCube || []) : (useCube ? geoCube : ufYearlyAll);
    // When narrowing states, restrict to the selected UFs; with no narrowing sum the
    // WHOLE grid (incl. COMEX non-state pseudo-origins) so the national total matches
    // PRODUCT_TS_T exactly (those pseudo-origins are not selectable UFs).
    const sumStates = (rows, y) => {
      // `v` começa em null e sobe por addPresent: um ano em que NENHUMA UF tem valor
      // (o deflator/moeda escolhido não alcança aquele ano) termina AUSENTE, não zero.
      // As quantidades continuam somando de 0 — elas vêm direto da fonte, sem
      // dependência de índice, e um zero ali é um zero de verdade.
      let v = null;
      let qMass = 0, qVol = 0, qStock = 0, qFlow = 0;
      // The Gold rows behind this year's sum, over the very rows summed (addCount).
      let nRows = 0;
      for (const r of rows) {
        if (r.year !== y) continue;
        if (stateNarrowing && !stateSet.has(r.uf)) continue;
        // ufYearly value is mi → ts.v is bi
        v = window.addPresent(v, r.value == null ? NaN : r.value / 1000);
        qMass += (r.q_mass || 0);        // already mil t
        qVol  += (r.q_vol  || 0);        // already mi m³
        qStock += (r.q_count_stock || 0); // already mi un — heads (the herd)
        qFlow  += (r.q_count_flow || 0);  // already mi un — eggs, fruits
        nRows = addCount(nRows, r.rows);
      }
      return { v, q_mass: qMass, q_vol: qVol, q_count_stock: qStock, q_count_flow: qFlow,
               rows: nRows };
    };
    // Engage the geo-derived series only when it adds correctness the national series
    // can't: a real state narrowing, OR a basket whose territorial cube has loaded —
    // and only when the (UF × year) grid actually carries rows (a snapshot without
    // ufYearly falls back to the national series rather than zeroing it out).
    // For a sub-UF narrowing, ALWAYS use the cube-derived series once loaded — even if
    // it sums to zero (an empty selection must read as zero, not the national curve).
    // The same holds for a basket cube that loaded EMPTY beside a UF subset: the national
    // series it would fall back to has no UF grain, so it would answer for every state.
    const geoDerivedTs = hasGeoData && (
      (subUfActive && subUfLoaded) ||
      (!subUfOwnsGrid && geoSource.length > 0 && (stateNarrowing || useCube)) ||
      (!subUfOwnsGrid && stateNarrowing && useCube)
    );

    // ── Aggregated time series ────────────────────────────────────────
    // A count is routed to the SAME two totals the server returns for a sum across
    // products (sql._count_split): the herd (stock) and the counted production (flow).
    // There is no `q_count`: heads plus eggs is not a quantity (countUnits.js).
    const isStock = {};
    PRODUCTS_T.forEach(p => { isStock[p.code] = p.measure_kind === 'stock'; });
    const allYears = OVERVIEW_T.map(d => d.y).filter(y => y >= yearStart && y <= yearEnd);
    // Each point also carries `rows`, the Gold rows behind it (null when not counted).
    const ts = allYears.map(y => {
      if (geoDerivedTs) {
        const g = sumStates(geoSource, y);
        return { y, v: g.v, q: g.q_mass, q_mass: g.q_mass, q_vol: g.q_vol,
                 q_count_stock: g.q_count_stock, q_count_flow: g.q_count_flow, rows: g.rows };
      }
      // National path (no state narrowing): per-product series, basket + year aware.
      // Mesma regra do sumStates: o valor só existe se ALGUM produto da cesta tiver
      // valor naquele ano; senão fica null e vira lacuna no gráfico.
      let v = null;
      let qMass = 0, qVol = 0, qStock = 0, qFlow = 0;
      // A product with no point that year has no Gold row in it: the marts hold only the
      // (product, year) groups that exist. So a missing point adds 0, a counted one its rows.
      let nRows = 0;
      selectedProducts.forEach(code => {
        const series = PRODUCT_TS_T[code];
        if (!series) return;
        const pt = series.find(p => p.y === y);
        if (!pt) return;
        v = window.addPresent(v, pt.v == null ? NaN : pt.v / 1000);  // productTS.v is mi → ts.v is bi
        if (pt.family === 'mass')   qMass += pt.q;
        if (pt.family === 'volume') qVol  += pt.q;
        if (pt.family === 'count') {
          if (isStock[code]) qStock += pt.q; else qFlow += pt.q;
        }
        nRows = addCount(nRows, pt.rows);
      });
      return { y, v, q: qMass, q_mass: qMass, q_vol: qVol, q_count_stock: qStock, q_count_flow: qFlow,
               rows: nRows };
    });

    // ── Per-product series of a UF subset (v1.108.3) ──────────────────
    // PRODUCT_TS_T is NATIONAL: the snapshot sums its mart's UF grain away. Under a UF subset
    // it put Brazil's figure under the UF chip in every per-product number — Pará's Leite
    // stacked at R$ 90 bi beside a Pará total of R$ 1,6 bi. So under a UF subset the series
    // come from the per-UF read (window.productTSByUf → /api/product-ts): the same mart, value
    // column and axes, summed over the selected UFs only, sliced below exactly like the
    // snapshot's. Its four states:
    //   resolved    — the UFs' own series ({} = measured, no product there);
    //   loading     — NO series stands: the national one is the defect itself, so the
    //                 screens hold every per-product number and say it is loading;
    //   loadError   — the same hold, saying it failed;
    //   unavailable — a banco the read cannot serve keeps the NATIONAL series, and the
    //                 screens say plainly that they are national (productUfUnavailable).
    // An EMPTY UF selection is "none": no series, measured, and no request. Without a UF
    // subset nothing changes: the snapshot's series is the answer.
    const productUfAsked = stateNarrowing && stateSet.size > 0;
    const productUfState = (productUfAsked && window.productTSByUf)
      ? window.productTSByUf(bancoId, summary) : null;
    // No reader at all (no producer, or none for this banco) is "unavailable", never "loading":
    // nothing is on its way, and a screen waiting for it would wait for good.
    const productUfUnavailable = productUfAsked && (!productUfState || !!productUfState.unavailable);
    const productUfLoading = !!(productUfState && productUfState.loading);
    const productUfLoadError = (productUfState && productUfState.loadError) || null;
    const PRODUCT_SERIES = !stateNarrowing ? PRODUCT_TS_T
      : !productUfAsked ? {}
      : productUfUnavailable ? PRODUCT_TS_T
      : (productUfState.productTS || {});

    // ── Per-product time series, restricted to basket + window ───────
    const productTS = {};
    selectedProducts.forEach(code => {
      const series = PRODUCT_SERIES[code];
      if (!series) return;
      productTS[code] = series.filter(d => d.y >= yearStart && d.y <= yearEnd);
    });

    // ── UF / region / municipio data ─────────────────────────────────────
    // Per-UF rows for the choropleth + ranking, restricted by the state filter and —
    // when the basket's (UF × year) cube has loaded (useCube) — by the product basket
    // too, so the map reflects the SELECTED products. Until that cube lands (or when
    // no basket is active) the map shows the snapshot's latest-year per-UF totals
    // (all products), narrowed by state. State filtering is always exact.
    // `notFilteredByBasket` stays true ONLY while a basket is active but its cube has
    // not loaded (in flight, or failed: `basketGeoLoadError` says which) — the geo views
    // render an honest pt-BR note for that. The old code faked a basket × UF split by
    // scaling every UF uniformly by selected/all (fabricated geography); the cube is the
    // REAL product × UF × year grain instead. Never under a sub-UF narrowing: its município
    // cube already carries the basket, and the grid it owns is never the all-products one
    // (it is empty until the cube lands, so the note claimed a map that was not drawn).
    const notFilteredByBasket = hasGeoData && basketActive && !useCube && !subUfOwnsGrid;
    // The ONE combination the client cannot aggregate faithfully: BOTH a product
    // basket AND a UF subset, before the product×UF×year cube has loaded. The
    // national per-product series has no UF grain; the all-products UF grid has no
    // basket grain — so the geo-derived `ts` here would sum ALL products over the
    // selected UFs, SILENTLY dropping the basket from VALOR TOTAL / YoY / acumulada.
    // We refuse to show that wrong number: flag it so the view holds the value at a
    // loading state until the cube resolves (then it computes the exact selection),
    // instead of reporting a figure that disregards the user's product filter.
    // PENDING only: a sub-UF narrowing that failed resolves nothing, ever, and is
    // reported apart (subUfLoadError). The guard is needed because the first term reads
    // `useCube`, which a failed sub-UF cube leaves false exactly like a pending one. The
    // basket cube's own failure is likewise reported apart (geoComboLoadError, below).
    const geoComboPending = !subUfLoadError && (
      (hasGeoData && basketActive && stateNarrowing && !useCube && !basketGeoLoadError) ||
      subUfPending ||
      (hasGeoData && subUfMeshPending));
    // The same combination when the basket cube FAILED: nothing is coming, and the
    // geo-derived `ts` sums ALL products over the selected UFs — the number geoComboPending
    // refuses to show. Until v1.108.2 a failure read as pending, and VALOR TOTAL said "…"
    // for good; the views now hold it with a dash and say why.
    const geoComboLoadError = (!subUfLoadError && !subUfMeshPending && hasGeoData
      && basketActive && stateNarrowing && !useCube && basketGeoLoadError) || null;

    // Tile-grid (col/row) join for cube-derived UF rows: the snapshot's ufData is
    // already decorated (decorate.js), but cube rows come straight from the serializer,
    // so attach col/row/name/region from the UF registry (mirrors decorateUfRows).
    const _ufTiles = {};
    (window.UF_DATA || []).forEach(u => { _ufTiles[u.uf] = u; });
    const _normRegion = window.normalizeRegion || ((api, tile) => api || tile);
    const _decorateUf = (rows) => rows.map(r => {
      const t = _ufTiles[r.uf] || {};
      // Normalize region to the canonical CODE — same as decorateUfRows — so the
      // cube-derived ufData matches the regionData groupBy (`u.region === r.id`).
      return { ...r, col: r.col ?? t.col, row: r.row ?? t.row,
               region: _normRegion(r.region, t.region), name: r.name || t.name };
    });

    // The per-(UF, year) grid backing the map + its TRUE data year: the basket cube
    // when loaded, else the snapshot's all-products grid. The map's data year is the
    // max reference_year present IN the window (NOT yearEnd) — if the endDate runs past
    // the last year with UF rows (future/partial trade year), labelling with yearEnd
    // would lie. Falls back to yearEnd when the grid is empty (synthetic/older payloads).
    const ufYearly = geoSource;
    const ufYearsInWindow = ufYearly
      .map(r => r.year)
      .filter(y => typeof y === 'number' && y >= yearStart && y <= yearEnd);
    const ufLatestYear = ufYearsInWindow.length ? Math.max(...ufYearsInWindow) : yearEnd;
    // One grid's rows at the map year, shaped like the snapshot's per-UF rows.
    const _gridAtMapYear = (grid, keep) => _decorateUf(
      grid
        .filter(r => r.year === ufLatestYear)
        .filter(u => keep(u.uf))
        .map(r => ({ uf: r.uf, name: r.name, region: r.region,
                     value: r.value, q_mass: r.q_mass, q_vol: r.q_vol,
                     q_count_stock: r.q_count_stock, q_count_flow: r.q_count_flow })),
    );
    // The snapshot's per-UF rows (`ufData`) are the banco's LATEST year, whatever the period:
    // the snapshot request carries no period. Until v1.108.21 they stood for every map year,
    // so with no basket PAM over 1990–2000 drew Mato Grosso at R$ 133 bi under "· 2000" (its
    // 2025 value; it made R$ 3,07 bi in 2000, and Brazil R$ 34,6 bi), and the Visão geral,
    // Geografia and Concentração maps, their CSVs and "UFs cobertas" read 2025 under the label
    // of 2000. An earlier map year now reads the all-products grid (`ufYearly`), which comes in
    // the same snapshot. At the latest year the two are the same rows, field by field (measured
    // on PAM, PEVS, PPM and COMEX, 2026-11-27), so the snapshot's own rows, decorated and
    // flagged `real` by the server, keep standing there; they also stand alone when the grid is
    // missing (a payload without it).
    const _ufYearlyLatest = ufYearlyAll.reduce((m, r) => (r.year > m ? r.year : m), -Infinity);
    const _snapshotRowsStand = !ufYearlyAll.length || ufLatestYear === _ufYearlyLatest;
    // A sub-UF narrowing reads the cube even while pending/empty (geoCube=null → []),
    // so the map shows loading/empty rather than the all-UF snapshot it excludes.
    const _ufRowsWhere = (keep) => (subUfOwnsGrid || useCube)
      ? _gridAtMapYear(geoCube || [], keep)
      : _snapshotRowsStand
        ? UF_DATA_T
            .filter(u => keep(u.uf))
            .map(u => ({ ...u }))
        : _gridAtMapYear(ufYearlyAll, keep);
    const ufData = _ufRowsWhere(uf => !stateSet || stateSet.has(uf));
    // The same rows with the STATE filter lifted — the honest denominator for the
    // "parcial" mark on region totals below. Deliberately the IDENTICAL path (same year,
    // same basket, same sub-UF scope), so the count it yields means exactly "what this
    // would show if you cleared the UF filter" and nothing else. No extra work when
    // there is no filter to lift.
    const ufDataNoStateFilter = stateSet ? _ufRowsWhere(() => true) : ufData;
    // The map year is "partial" when it falls SHORT of the requested window end — the
    // researcher asked through yearEnd but the latest UF data stops earlier (newer year
    // not yet in Gold, or an in-progress year). Lets the geo views annotate honestly.
    const ufYearPartial = hasGeoData && ufLatestYear < yearEnd;

    // The "UFs cobertas" denominator (ViewOverview/MainScreen) must be the banco's
    // ALL-TIME UF universe, not just the latest year's UFs. ufData is latest-year-
    // scoped (see above), so using it as the denominator would, on a SPARSE trade
    // year (fewer states reporting), under-count the universe. ufYearly spans every
    // covered year, so its distinct UF set IS the all-time universe — first row per
    // UF carries name/region/real for the real-UF tally. Fall back to the latest-year
    // ufData when ufYearly is absent (synthetic / older payloads). Counts are capped
    // at 27 downstream, so this only ever CORRECTS an under-count, never inflates.
    // Always derived from the ALL-products grid (ufYearlyAll), never the basket cube —
    // the denominator is the banco's FULL territorial universe, so it stays "/27"
    // rather than shrinking to the subset of UFs that happen to grow the basket.
    const ufUniverse = (() => {
      if (!ufYearlyAll.length) return UF_DATA_T;
      const seen = new Map();
      ufYearlyAll.forEach(r => { if (!seen.has(r.uf)) seen.set(r.uf, r); });
      return Array.from(seen.values());
    })();

    // productShare is NO LONGER used to scale displayed UF/region/heatmap values
    // (that fabricated geography — see above). It survives only as the product
    // multiplier of the hero "Linhas" ESTIMATE, the fallback for when the rows could not be
    // counted (rowsInView, v1.108.9); the counter itself counts them.
    //
    // It is the selection's share of the banco's ROWS, from each produto's own row count
    // (qualityByProduct[].rows, v1.108.5), not its share of PRODUCTS. Products are far from
    // even (prod, 2026-11-23): a COMEX NCM code holds from 1 to 32,549 of the 496,160 rows
    // the panel reads; PAM's açaí, which starts in 2015, 60,557 beside 257,294 for most
    // crops; the 3 PEVS silvicultura produtos are 3 of 10 but 20.6% of the rows, so the
    // count share read "Silvicultura" at +46%. A produto is matched on (code, tabela), its
    // identity. If any
    // produto's row count is missing (a payload from before v1.108.5), it falls back to the
    // count share, so the estimate keeps a figure rather than none. The estimate is exact
    // along the product dimension only: the period and the UFs scale every produto alike.
    const rowsByProduto = new Map();
    (snap.qualityByProduct || []).forEach((r) => {
      if (Number.isFinite(r.rows)) rowsByProduto.set(`${r.code}|${r.tabela || ''}`, r.rows);
    });
    const rowsOf = (p) => rowsByProduto.get(`${p.code}|${p.tabela || ''}`);
    const rowsKnown = PRODUCTS_T.length > 0 && PRODUCTS_T.every((p) => Number.isFinite(rowsOf(p)));
    const productShare = (() => {
      const rowsAll = rowsKnown ? PRODUCTS_T.reduce((s, p) => s + rowsOf(p), 0) : 0;
      if (!(rowsAll > 0)) {
        return allProducts.length ? (selectedProducts.length / allProducts.length) : 0;
      }
      // Both halves sum the same field over the same product list (a share of a partition):
      // the selection's produtos, in the origin, over every produto of the banco.
      const selectedSet = new Set(selectedProducts);
      const rowsSelected = productUniverse
        .filter((p) => selectedSet.has(p.code))
        .reduce((s, p) => s + rowsOf(p), 0);
      return rowsSelected / rowsAll;
    })();

    // region totals derived from the REAL (state-filtered) ufData
    //
    // A row here NAMES a whole region but SUMS only the UFs that survived the filter:
    // with the Pará selected, `{ id: 'N', label: 'Norte' }` carries the PARÁ's number.
    // Summing only what is filtered is correct (never show data outside the filter) —
    // presenting it under the region's bare name is not. That is the same wrong-subject
    // defect as labelling a region's value with a UF's name (v1.33.25), one grain up.
    // So each row also carries WHAT IT IS MADE OF, and the views spell it out.
    const regionData = REGIONS_T.map(r => {
      const ufs = ufData.filter(u => u.region === r.id);
      const unfiltered = ufDataNoStateFilter.filter(u => u.region === r.id);
      return {
        ...r,
        value:  ufs.reduce((s, u) => s + u.value,  0),
        q_mass: ufs.reduce((s, u) => s + u.q_mass, 0),
        q_vol:  ufs.reduce((s, u) => s + u.q_vol,  0),
        // The two count totals, each summed over the region's UFs — never into each other.
        q_count_stock: ufs.reduce((s, u) => s + (u.q_count_stock || 0), 0),
        q_count_flow:  ufs.reduce((s, u) => s + (u.q_count_flow || 0), 0),
        ufs:    ufs.length,
        // How many UFs this region WOULD carry without the state filter, and whether the
        // sum is therefore a fraction of the region it is named after.
        ufsTotal: unfiltered.length,
        partial:  ufs.length < unfiltered.length,
        // The UFs actually summed, biggest first (name tie-break keeps it deterministic
        // for a value-less banco, where every value is 0 — the livestock herd).
        ufNames: ufs.slice()
          .sort((a, b) => (b.value || 0) - (a.value || 0)
                       || String(a.name || a.uf).localeCompare(String(b.name || b.uf), 'pt-BR'))
          .map(u => u.name || u.uf),
      };
    }).filter(r => r.ufs > 0);

    // top municipios — ranked from the REAL basket-scoped município cube
    // (window.municipioYearly), latest year in window, cityCode→name via the mesh.
    // The cube is fetched only when a sub-UF/município narrowing is active, so without
    // a narrowing the list is empty and the Geografia view shows an honest empty-state
    // (prompting a sub-UF/município filter) rather than a silently blank panel. This
    // replaces the legacy name-keyed snapshot.topMunis path, which had no backend
    // producer (always []) and a dead muniNames filter. Values are already at the
    // município grain and per-family scaled identically to ufData (value mi, q_mass
    // mil t, q_vol mi m³, both count totals mi un), so they slot into the same valueKey/mul.
    let topMunis = [];
    if (subUfLoaded && mesh && Array.isArray(muniCube) && muniCube.length) {
      const meshByCode = {};
      for (const m of mesh) meshByCode[m.cityCode] = m;
      const muniYears = muniCube
        .map(r => r.year)
        .filter(y => typeof y === 'number' && y >= yearStart && y <= yearEnd);
      const muniLatest = muniYears.length ? Math.max(...muniYears) : null;
      if (muniLatest != null) {
        topMunis = muniCube
          .filter(r => r.year === muniLatest)
          .filter(r => !stateSet || stateSet.has(r.uf))
          // Apply the same facet filter as the UF rollup — robust even if the cube
          // returns cities beyond the narrowed set (it shouldn't, but don't trust it).
          .filter(r => { const a = meshByCode[r.cityCode]; return a && muniPassesFacets(a, geoFacets); })
          .map(r => ({
            // cityCode is the IBGE 7-digit code — the join key for the municipal
            // choropleth (it matches `codarea` in the vendored per-UF meshes).
            cityCode: r.cityCode,
            city: (meshByCode[r.cityCode] || {}).cityName || r.cityCode,
            uf: r.uf,
            product: '',  // the cube is basket-aggregated (no per-product split here)
            value: r.value, q_mass: r.q_mass, q_vol: r.q_vol,
            q_count_stock: r.q_count_stock, q_count_flow: r.q_count_flow,
          }))
          .sort((a, b) => (b.value || 0) - (a.value || 0));
        // NOT truncated here. This used to .slice(0, 100), which is a DISPLAY cap
        // living in the engine — and once the municipal choropleth started drawing
        // from these rows it turned into a data error: every município past rank 100
        // had no row to match, so the map painted it as "sem produção registrada"
        // and counted it in the grey tally (PA: 144 municípios → a false "44 sem
        // produção"). The view caps the RANKING it lists; the map needs them all.
      }
    }

    // ── Top products composition (donut / share) ─────────────────────
    // Take last endpoint from per-product TS, keep only basket products.
    const compositionRaw = selectedProducts
      .map(code => {
        const prod = PRODUCTS_T.find(p => p.code === code);
        const series = PRODUCT_SERIES[code];
        if (!prod || !series) return null;
        const lastInWindow = series.filter(d => d.y >= yearStart && d.y <= yearEnd).slice(-1)[0];
        if (!lastInWindow) return null;
        // `tabela` viaja junto: madeira, lenha e carvão existem nas DUAS tabelas do
        // PEVS com o MESMO nome, e sem ela o Donut mostra duas fatias com rótulo idêntico.
        // Quem rotula é `labelProductRows`, no consumidor — aqui só não se perde o dado.
        return { name: prod.name, tabela: prod.tabela, value: lastInWindow.v };
      })
      .filter(Boolean);
    // The selected UFs' under a UF subset, national otherwise (PRODUCT_SERIES, above). Under a
    // sub-UF recorte the Visão geral reads the recorte's own products instead
    // (recorteProducts.js) and slices them the same way.
    const topProducts = window.compositionSlices(compositionRaw);

    // ── Quality flag distribution ─────────────────────────────────────
    const qualityFlagsAll = QUALITY_T;
    const filteredFlags = flagSet
      ? qualityFlagsAll.filter(f => flagSet.has(f.id))
      : qualityFlagsAll;
    // As frações NÃO são renormalizadas pelas flags marcadas — elas são do ACERVO, que é
    // o que a tela promete: a legenda do strip diz "Distribuição no acervo completo do
    // banco" e o subtítulo do card do Panorama diz "acervo do banco".
    //
    // A renormalização (que existiu até aqui) tinha dois problemas, e o segundo é o pior:
    //
    //  1. Ela alcançava só os cartões. A linha temporal e a área empilhada leem `qualityTs`
    //     cru, do acervo — então com um subconjunto marcado a tela mostrava DOIS
    //     denominadores ao mesmo tempo: os cartões somando 100% e o gráfico logo abaixo
    //     somando 34%. Espalhar a renormalização para o `qualityTs` faria os dois baterem,
    //     mas no denominador errado.
    //  2. Uma fração renormalizada MUDA quando o leitor clica, sem o dado mudar. Marcar só
    //     "Valor problemático" — 14 linhas no PEVS — fazia o cartão ler "100%". As chips de
    //     flag escolhem O QUE OLHAR, não redefinem a população.
    //
    // O corte por flag segue existindo: ele decide quais cartões, séries e colunas aparecem.
    // A composição POR PRODUTO (`ViewQuality.qaByProduct`) continua renormalizando por
    // linha, e isso é outra coisa — ali a barra empilhada precisa fechar em 100% para ser
    // legível, o que é uma afirmação sobre o produto, não sobre o acervo.
    const qualityFlags = filteredFlags;

    // quality time series — pass-through, optionally trim to window
    const qualityTs = QUALITY_TS_T.filter(d => d.y >= yearStart && d.y <= yearEnd);

    // ── Row counter (for hero "SELEÇÃO ATIVA · Linhas") ────────────────
    // The Gold rows behind exactly what `ts` sums — the same reads, years, UFs, products and
    // axes (origin, flow, níveis, the COMTRADE countries: each read already applies them) —
    // so the counter COUNTS them (v1.108.9). Until then it multiplied the banco's total by
    // shares of the selection, and a share of the products' rows spread evenly over the years
    // is not the rows of the recorte: PAM's açaí over 1990–2000, a period it has no row in,
    // read thousands. Null when it cannot be counted — a point without `rows` (a payload from
    // before v1.108.9), or a geography `ts` itself does not honour: a UF subset with no UF
    // grid, a sub-UF recorte not resolved, a basket × UF cross whose cube is pending or failed
    // (`ts` sums every product there). MainScreen then holds the mark or shows the estimate
    // below and says it is one. The quality selection stays out by decision (MainScreen).
    // No product selected holds no row, whatever the geography.
    const rowsCountable = !geoComboPending && !geoComboLoadError
      && (geoDerivedTs || (!stateNarrowing && !subUfOwnsGrid));
    const rowsInView = !selectedProducts.length ? 0
      : rowsCountable ? ts.reduce((acc, d) => addCount(acc, d.rows), 0)
      : null;
    // ── Years with rows (the base of "Anos cobertos", below) ───────────
    // The years of `ts` whose point carries at least one Gold row, read off the very counts
    // rowsInView adds (v1.108.15), so the two cannot disagree: no row is no year, and where the
    // rows are unknown the years are too (null). `ts` has a point for EVERY year of the banco
    // inside the period, rows or not, and its length was the counter until then: PAM's açaí
    // over 1990–2000 read "Linhas 0" beside "Anos cobertos 11 / 52", and a COMEX code with one
    // row in 2010 read "30 / 30". Ascending, as `ts` is; [] with no product selected, whatever
    // the geography (as rowsInView, `ts` sums every product there).
    const yearsWithRows = rowsInView == null ? null
      : !selectedProducts.length ? []
      : ts.filter((d) => d.rows > 0).map((d) => d.y);

    // ── Coverage (hero "UFs cobertas" · "Anos cobertos", and Visão geral's quality card) ──
    // What the recorte COVERS is where and when it had PRODUCTION: a value or a quantity above
    // zero, in some year of the period (v1.108.21).
    // - Never a row: the municipal surveys (PAM, PPM) publish a zero row for every município, so
    //   every product of theirs has rows in all 27 UFs (measured on prod, 2026-11-27: 28 of 28).
    // - Never one year alone. Until v1.108.21 "UFs cobertas" counted the UFs with a value in the
    //   MAP year, and "Anos cobertos" the years with rows, so the two answered different questions
    //   side by side. PAM's açaí × RS read "UFs 0 / 27 · Anos 11 / 52": RS has a zero row for each
    //   of its municípios every year since 2015. PPM's lã read "6 / 27" over a history in which
    //   14 UFs produced it.
    // - A quantity keeps the count still under any currency or deflator, whose gaps leave the
    //   value absent, never the quantity.
    //
    // ONE count of the UFs, read by both surfaces that show it; until v1.108.21 the hero and the
    // card counted apart, each its own way. It waits for the grid that honours the selection, as
    // "Linhas" does: "…" while a sub-UF recorte or the basket's cube is on its way, "—" after
    // either failed. Until then it did not wait for the basket's cube and counted the
    // all-products grid meanwhile: PAM's açaí over 1990–2000 read "27 / 27" before settling on
    // "0 / 27", and kept "27 / 27" for good when the cube failed. (`notFilteredByBasket` is that
    // wait, and its failure, without a UF subset; `geoComboPending`/`geoComboLoadError` are it
    // beside one.)
    const ufsCoveredLoadError = subUfLoadError || geoComboLoadError
      || (notFilteredByBasket ? basketGeoLoadError : null) || null;
    const ufsCoveredLoading = !ufsCoveredLoadError && (geoComboPending || notFilteredByBasket);
    // Grid cells carry the value as `value`, the series' points as `v`.
    const _produced = (c) => c.value > 0 || c.v > 0 || c.q_mass > 0 || c.q_vol > 0
      || c.q_count_stock > 0 || c.q_count_flow > 0;
    const _isRealUfRow = (u) => (u.real != null ? u.real
      : (window.isCanonicalUf ? window.isCanonicalUf(u.uf) : true));
    // Every year of the period, in the grid that honours the selection. A payload without the
    // UF × year grid has only the map's rows to offer.
    const _hasYearGrid = subUfOwnsGrid || useCube || ufYearlyAll.length > 0;
    const _coverageCells = _hasYearGrid
      ? geoSource.filter((r) => r.year >= yearStart && r.year <= yearEnd)
      : ufData;
    // No product selected covers no UF, whatever the grid sums then (every product).
    const ufsCovered = (ufsCoveredLoading || ufsCoveredLoadError) ? null
      : !selectedProducts.length ? 0
      : new Set(_coverageCells
          .filter((c) => (!stateSet || stateSet.has(c.uf)) && _isRealUfRow(c) && _produced(c))
          .map((c) => c.uf)).size;
    // The denominator: the banco's real UFs across its whole history, capped at the canonical 27.
    const ufsTotal = Math.min(27, ufUniverse.filter(_isRealUfRow).length || 27);
    // The years with production, read off the screen's series (it sums exactly the selection),
    // among the years with rows: production needs a row, so they hold where "Linhas" holds (null)
    // and are none with no product selected. With no geographic filter the two are the same
    // years for every product (156 in four bancos, measured on prod 2026-11-27); a UF filter
    // brings in the zero rows, and there they part.
    const _yearsProduced = new Set(ts.filter(_produced).map((d) => d.y));
    const yearsCovered = yearsWithRows && yearsWithRows.filter((y) => _yearsProduced.has(y));
    // The shares below survive only as the FALLBACK estimate of that count.
    const flagShare  = flagSet
      ? filteredFlags.reduce((s, f) => s + f.share, 0)
      : 1;
    // yearShare = fraction of the banco's COVERED years that fall in the window. Base it
    // on the COUNT of covered years in-window over the total covered count — never the
    // window SPAN (yearEnd-yearStart+1) over the count, which a gap-y annual series makes
    // >1 (M1). Clamp for safety.
    const _yearsInWindow = (OVERVIEW_T || []).filter(d => d.y >= yearStart && d.y <= yearEnd).length;
    const yearShare = Math.min(1, _yearsInWindow / ((OVERVIEW_T && OVERVIEW_T.length) || 39));
    // stateShare = selected UFs over the banco's REAL UF universe. Numerator and
    // denominator must share a universe: count only real UFs (a trade banco's ufData
    // carries non-state pseudo-origins ND/EX/ZN that must not shrink the denominator),
    // and clamp at 1 so a mismatch never yields >100% (M1). stateSet is null when the
    // selection is full (applyAndClose normalizes full→null) → "no narrowing" → 1.
    const _realUfCount = ((UF_DATA_T || []).filter(u => u.real !== false).length) || 27;
    const stateShare = stateSet ? Math.min(1, stateSet.size / _realUfCount) : 1;
    // Under a sub-UF recorte the selection is a set of MUNICÍPIOS, and stateShare (whole
    // states) overstates it: Portel and Breves read as the whole Pará. muniShare = the
    // municípios in scope (the facets, intersected with the state filter, exactly as the
    // cube rows are) over the whole mesh. Null without a resolved recorte; the counter shows
    // "…"/"—" while it loads or after it failed (MainScreen), never the state estimate.
    const muniShare = (subUfActive && mesh && mesh.length)
      ? Math.min(1, mesh.filter(m => muniPassesFacets(m, geoFacets)
          && (!stateNarrowing || stateSet.has(m.uf))).length / mesh.length)
      : null;

    return {
      ts, productTS, ufData, regionData, topMunis, topProducts,
      qualityFlags,
      // A lista SEM o corte por flag — como `ufDataFull`, e pelo mesmo motivo: um total do
      // acervo ("X de Y linhas", "% do valor examinado") não pode encolher porque o leitor
      // desmarcou uma chip. Quem quer o recorte usa `qualityFlags`.
      qualityFlagsFull: qualityFlagsAll,
      qualityTs, selectedProducts,
      // The basket's counts by what they count: one group per server total (the herd,
      // the counted production), each named from its products' native unit, and REFUSED
      // (`mixed`) when its products count different things. Every screen that draws a
      // count reads the group's `key` and `label` from here (countUnits.js).
      countGroups: window.countGroups(PRODUCTS_T, selectedProducts),
      yearStart, yearEnd,
      // The choropleth/tile map's TRUE data year (max UF year within the window),
      // and whether it stops short of the requested yearEnd. The geo views label the
      // map with `ufLatestYear` (not `yearEnd`) and annotate `ufYearPartial` so the
      // year shown always matches the data plotted (FINDING #1).
      ufLatestYear, ufYearPartial,
      // Banco-aware metadata so product/quality views read the ACTIVE banco's
      // dimensions instead of reaching into the PEVS globals (window.PRODUCTS …):
      products:        PRODUCTS_T,                 // active banco product list
      productsTotal:   allProducts.length,
      // The products the screen's origin offers (all of them without one): what the picker
      // lists and the product chip counts over (main.jsx), v1.108.5. `productsTotal` stays the
      // banco's, the denominator of the hero and of "N de M produtos".
      productUniverse,
      // Every product's series over the whole history — unfiltered by basket and period, but
      // the selected UFs' under a UF subset (PRODUCT_SERIES), like productTS and topProducts.
      allProductTS:    PRODUCT_SERIES,
      // Where the per-product series of a UF subset stand (v1.108.3). Requested: a UF subset
      // narrows them (an empty selection included). Loading / failed: productTS, allProductTS
      // and topProducts are EMPTY, held, and the screens say which — an empty series here is
      // not "nothing produced". Unavailable: they are the NATIONAL ones, and the screens say so.
      productUfRequested: stateNarrowing,
      productUfLoading,
      productUfLoadError,
      productUfUnavailable,
      // The month the UFs' corrected values are at — read off their own response (v1.105.0);
      // null with no UF subset, while it loads, or under a nominal convention. A request cached
      // on its own, so across a build it can be a month apart from the snapshot
      // (window.PriceBaseSkewNote, csvExport's correcao_monetaria).
      productPriceBase: (productUfState && !productUfUnavailable && productUfState.priceBase) || null,
      // The banco's ALL-TIME UF universe (distinct UFs across every covered year),
      // not just the latest year's — so the "UFs cobertas" denominator never under-
      // counts on a sparse trade year. Falls back to the latest-year UF list when
      // ufYearly is absent. [] when the banco has no geography.
      ufDataFull:      ufUniverse,
      qualityByProduct: snap.qualityByProduct || [],
      // Honest flag for the geo views: true when a product basket is active but
      // the per-UF/region/heatmap totals are NOT narrowed by it (no per-product ×
      // UF grain in the snapshot). The views render a pt-BR note instead of
      // silently showing all-products territorial figures under a basket chip.
      notFilteredByBasket,
      // True while VALOR TOTAL/YoY/série cannot honour basket × UF simultaneously
      // (the product×UF cube is still loading) — the view shows a loading state
      // instead of a basket-dropped value. See geoComboPending above.
      geoComboPending,
      // The same combination after the basket cube FAILED (its error, else null): the value
      // stays held, with a dash and a note instead of "…" for good.
      geoComboLoadError,
      // The basket cube's failure whenever the grid needed it — beside a UF subset or not.
      // Without a UF subset the series stays right (the national per-product one honours the
      // basket); only the map falls back to all products, and its note says why.
      basketGeoLoadError,
      // The FULL (UF × year) grid — every year, not just ufLatestYear — already
      // scoped by basket + state + sub-UF narrowing exactly like `ufData` above (it
      // IS `ufData`'s own source, pre-slice). CONF-1: the Geografia heatmap used to
      // read the snapshot's always-all-products `ufYearly` directly instead of this,
      // so a basket that had already narrowed the map/ranking (once its cube loaded)
      // left the heatmap silently showing every product's total — a 3.4x divergence
      // measured for a single-product PEVS basket, with no on-screen warning once
      // `notFilteredByBasket` had cleared. Rows may omit `name`/`region` (the
      // município rollup doesn't carry them); resolve labels from the UF registry.
      ufYearlySeries: ufYearly,
      // The RAW basket-scoped (município × year) cube — every year, every município
      // that cleared the active sub-UF facets — for a município-scope temporal view.
      // [] both when no sub-UF narrowing is active and while the fetch is pending;
      // `subUfActive`/`subUfLoaded` distinguish "not narrowed" from "narrowed, still
      // loading" so the view can render the right empty/loading state instead of
      // guessing from an empty array alone.
      muniYearlySeries: (subUfLoaded && Array.isArray(muniCube)) ? muniCube : [],
      subUfActive, subUfLoaded,
      // Where a REQUESTED sub-UF narrowing stands, for the screens that must not show a number
      // until it is resolved. Loading: the mesh that names its cities, or the cube that sums
      // them, is on its way. Failed: one of them failed for good — the selection cannot be
      // computed, and neither the narrowed numbers nor the un-narrowed ones may stand in for
      // it. Both false with no sub-UF facet requested.
      subUfLoading: hasGeoData && (subUfMeshPending || subUfPending),
      subUfLoadError,
      // A sub-UF recorte has been ASKED for, whatever its state: on its way, failed, or
      // resolved. The perspectives that cannot apply one at all — their series exist only
      // for the whole country or whole states — say so in all three states (window.
      // recorteNaoSeAplica): loading or failing changes nothing for a screen that never reads
      // the recorte, and until v1.108.2 they showed national numbers under its chip, silently.
      subUfRequested: hasGeoData && (subUfActive || subUfMeshPending || subUfPending || !!subUfLoadError),
      // The month that cube's corrected values are at (v1.105.0) — null with no cube, while
      // it loads, or under a nominal convention. Read off the cube's own response (one read).
      // The cube reads the analytical base directly and the snapshot reads the pre-aggregated
      // tables, so across a build the two can be at different months; MainScreen compares
      // them (window.PriceBaseSkewNote).
      muniPriceBase: muniState ? muniState.priceBase : null,
      // The same for the basket cube (UF × year), when it is the grid the screen draws. It
      // reads the same pre-aggregated tables as the snapshot, but in a request cached on its
      // own, so across a build it too can come back at another month.
      // Read off the cube's own response, like its rows (window.geoYearly).
      geoPriceBase: (!subUfOwnsGrid && useCube && basketGeoState)
        ? basketGeoState.priceBase
        : null,
      // The active sub-UF recorte, named. Every UF row above carries a FRACTION of its
      // state when this is set — the state's own value never appears — so a surface that
      // prints a UF name beside a number has to say so where the number is. The chip and
      // the citation state it for the panel; a map popup and a card need it locally, or
      // the reader takes "Pará · R$ 655 mi" for the Pará. Null when nothing narrows.
      recorte: (subUfActive && window.subUfChipText)
        ? window.subUfChipText(summary, mesh || [])
        : null,
      // The município code set the active sub-UF/município facets resolve to (null when
      // no facet narrows). Exported because a view that lets the researcher FOCUS on one
      // território has to offer only territories the filter actually allows — otherwise
      // it profiles a place the filter excluded, which is the no-invisible-filtering
      // violation in its purest form.
      scopedCityCodes: narrowedCities,
      // The Gold rows of the recorte, counted (see the Row counter above); null when they
      // could not be. `_shares` only backs the estimate MainScreen shows in that case.
      rowsInView,
      // The years of the series that carry those rows, ascending — null exactly when
      // rowsInView is (see Years with rows above).
      yearsWithRows,
      // Coverage (see Coverage above), the one count the hero and the Visão geral card show.
      // `ufsCovered` is null exactly while held: `ufsCoveredLoading` (a sub-UF recorte or the
      // basket's cube on its way) or `ufsCoveredLoadError` (either failed). `ufsTotal` is its
      // denominator. `yearsCovered`: the years with production, ascending; null exactly when
      // `yearsWithRows` is.
      ufsCovered, ufsCoveredLoading, ufsCoveredLoadError, ufsTotal,
      yearsCovered,
      _shares: { productShare, flagShare, yearShare, stateShare, muniShare },
    };
  };
})();
