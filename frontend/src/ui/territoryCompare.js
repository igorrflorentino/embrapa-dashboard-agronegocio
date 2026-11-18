// territoryCompare.js — the data behind "Comparativo entre territórios".
//
// ViewProductCompare fixes the place and compares produtos; this fixes the produtos (the
// basket, the period, the currency and correction all still apply) and compares PLACES,
// side by side, at any mix of levels: a região against a state against a município.
//
// The territories are chosen on the screen, not in the geography filter. The filter says
// "what the dashboard is about"; here the researcher says "which places to put next to
// each other", and a município of another state must be addable without narrowing the rest
// of the dashboard to it. So the global geography facets are deliberately NOT applied.
//
// Kept out of the view so the CSV export (which only receives view, banco, summary and
// conventions) builds the SAME numbers from the same function instead of a second copy.

(function () {
  const MAX = 8;
  const PREFIX = { regiao: 'R', uf: 'U', municipio: 'M' };
  const LEVEL_OF = { R: 'regiao', U: 'uf', M: 'municipio' };
  const LEVEL_LABEL = { regiao: 'região', uf: 'estado', municipio: 'município' };
  // The cube columns for each metric, in the units the serializers emit: value in millions
  // of the chosen currency (nullable: the chosen correction may not reach a year), mass in
  // mil t, volume in mi m³, each count total in mi un. A count is TWO metrics, the herd
  // and the counted production, because the cube never adds them (countUnits.js).
  const FIELD = {
    value: 'value', mass: 'q_mass', volume: 'q_vol',
    count_stock: 'q_count_stock', count_flow: 'q_count_flow',
  };
  const LABEL = { value: 'Valor', mass: 'Quantidade (massa)', volume: 'Quantidade (volume)' };

  /** The metrics a basket can be compared on: value always, the quantity families it
   *  carries (tonnes are never summed with cubic metres, here as everywhere), and one
   *  metric per count group that counts ONE thing — "Efetivo (cabeças)" and "Quantidade
   *  (ovos)" are two metrics, never one. A group whose products count different things
   *  has no unit and is not offered; `refused` lists it for the note that says why. */
  function metricsFor(database, summary) {
    const families = (window.familiesInBasket
      ? window.familiesInBasket(summary && summary.basket, database) : []) || [];
    const options = [{ id: 'value', label: LABEL.value }];
    ['mass', 'volume'].forEach((m) => {
      if (families.includes(m)) options.push({ id: m, label: LABEL[m] });
    });
    const groups = families.includes('count') && window.applyFilters
      ? (window.applyFilters(summary || {}, database).countGroups || []) : [];
    groups.filter((g) => !g.mixed).forEach((g) => options.push({ id: g.id, label: g.label, group: g }));
    return { options, refused: groups.filter((g) => g.mixed) };
  }

  /** The metric in force. A link from before v1.108.0 says `tm=count`, the one count total
   *  of the time: with ONE count group in the basket that total was this group, so the link
   *  opens it with the same numbers; with two it was heads plus eggs, which no metric is any
   *  more, and the link opens on the default. */
  function metricOf(requested, options) {
    const ids = options.map((o) => o.id);
    if (ids.includes(requested)) return requested;
    const counts = options.filter((o) => o.group);
    if (requested === 'count' && counts.length === 1) return counts[0].id;
    return 'value';
  }

  const keyOf = (t) => `${PREFIX[t.level]}:${t.code}`;

  /** "R:N,U:PA,M:1501402" → [{level, code}], deduplicated, capped at MAX. Anything it
   *  cannot read is dropped rather than guessed (a hand-edited or stale link). */
  function decode(str) {
    if (!str) return [];
    const seen = new Set();
    const out = [];
    for (const part of String(str).split(',')) {
      const [p, code] = part.split(':');
      const level = LEVEL_OF[p];
      if (!level || !code) continue;
      const k = `${p}:${code}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ level, code });
      if (out.length >= MAX) break;
    }
    return out;
  }

  function encode(list) {
    return (list || []).filter((t) => t && PREFIX[t.level] && t.code).map(keyOf).join(',');
  }

  const ufRow = (uf) => (window.UF_DATA || []).find((u) => u.uf === uf) || null;
  const regionOfUf = (uf) => (ufRow(uf) || {}).region || null;
  const muniRow = (code) => ((window.geoMesh && window.geoMesh()) || [])
    .find((m) => String(m.cityCode) === String(code)) || null;

  /** Display name of a territory. A município carries its UF, because the same name exists
   *  in several states (there are five "Bom Jesus"). */
  function labelOf(t) {
    if (t.level === 'regiao') {
      return ((window.REGIONS || []).find((r) => r.id === t.code) || {}).label || t.code;
    }
    if (t.level === 'uf') return (ufRow(t.code) || {}).name || t.code;
    const m = muniRow(t.code);
    return m ? `${m.cityName} (${m.uf})` : t.code;
  }

  /** The (UF × year) grid for the active products. With no basket narrowing, the
   *  snapshot's all-products grid (already in memory); with one, the basket-scoped cube.
   *  Both honour currency, correction, SIDRA table and industrialization level. */
  function ufGrid(database, summary) {
    const snap = window.dataStore && window.dataStore.get ? window.dataStore.get(database) : null;
    const all = snap && Array.isArray(snap.ufYearly) ? snap.ufYearly : [];
    const basket = summary && summary.basket;
    const prods = (snap && snap.products) || [];
    if (Array.isArray(basket) && basket.length === 0) return { rows: [], loading: false };
    const narrowed = Array.isArray(basket) && basket.length < prods.length;
    if (!narrowed) return { rows: all, loading: false };
    const cube = window.geoYearly ? window.geoYearly(database, summary) : null;
    return { rows: cube || [], loading: cube == null };
  }

  /** One point per year. A year with NO row for the territory produced nothing there (the
   *  cube is sparse), so it is a measured 0. A year whose rows all carry a null value is
   *  a year the chosen correction does not reach: that stays null (a gap), never 0. */
  function yearly(rows, match, field, years) {
    return years.map((y) => {
      const hits = rows.filter((r) => r.year === y && match(r));
      if (!hits.length) return { y, v: 0 };
      if (field === 'value') {
        return { y, v: hits.reduce((acc, r) => window.addPresent(acc, r.value == null ? NaN : r.value), null) };
      }
      return { y, v: hits.reduce((acc, r) => acc + (r[field] || 0), 0) };
    });
  }

  /** Everything the view and the CSV need for a selection.
   *  Returns { items, brasil, years, loading, loadError, muniCapable, priceBases,
   *  comparedPriceBases }. An item carries `loading`, `loadError` or `unavailable` when it
   *  has no points to show, and only an item with none of the three is a measurement. */
  // `max` caps the selection (the screen's limit); the default-picking scan passes
  // Infinity, since it ranks all 27 states and must not see only the first eight.
  function build({ database, summary, selection, metric = 'value', max = MAX }) {
    const field = FIELD[metric] || FIELD.value;
    const f = window.applyFilters ? window.applyFilters(summary || {}, database) : {};
    const y0 = f.yearStart;
    const y1 = f.yearEnd;
    const muniCapable = (window.geoLevelFor ? window.geoLevelFor(database) : null) === 'municipio';
    const grid = ufGrid(database, summary);
    const inWindow = (r) => (y0 == null || r.year >= y0) && (y1 == null || r.year <= y1);
    const ufRows = grid.rows.filter(inWindow);

    const sel = (selection || []).slice(0, max);
    const muniCodes = sel.filter((t) => t.level === 'municipio').map((t) => String(t.code));
    // The cube's read: { rows, priceBase, loading, loadError } (window.municipioYearly), or
    // null when nothing is asked (no município chosen, or a banco without that grain).
    const muniRead = muniCapable && muniCodes.length && window.municipioYearly
      ? window.municipioYearly(database, summary, muniCodes) : null;
    const muniCube = muniRead ? muniRead.rows : (muniCodes.length ? [] : null);
    const muniRows = (muniCube || []).filter(inWindow);

    const years = [...new Set([...ufRows, ...muniRows].map((r) => r.year))].sort((a, b) => a - b);

    const items = sel.map((t) => {
      const base = { ...t, key: keyOf(t), label: labelOf(t), levelLabel: LEVEL_LABEL[t.level] };
      if (t.level === 'municipio') {
        if (!muniCapable) return { ...base, unavailable: true, points: [] };
        // A failed read is not a pending one: until v1.107.3 it read "carregando…" for good.
        if (muniRead && muniRead.loadError) return { ...base, loadError: muniRead.loadError, points: [] };
        if (muniCube == null) return { ...base, loading: true, points: [] };
        return { ...base, points: yearly(muniRows, (r) => String(r.cityCode) === String(t.code), field, years) };
      }
      if (grid.loading) return { ...base, loading: true, points: [] };
      const match = t.level === 'uf'
        ? (r) => r.uf === t.code
        : (r) => regionOfUf(r.uf) === t.code;
      return { ...base, points: yearly(ufRows, match, field, years) };
    });

    // The whole country for the SAME metric, for the share column. Every row counts,
    // including a trade banco's non-state origins, so the share is of the national total.
    const brasil = grid.loading ? [] : yearly(ufRows, () => true, field, years);
    // The month the município cube is at (v1.105.0) — same response as its rows. It reads
    // the analytical base directly while `brasil` comes from the pre-aggregated tables, and
    // the share divides one by the other: across a build they can be a month apart, and the
    // view says so. `comparedPriceBases` are applyFilters' cubes, whose skew MainScreen's
    // note already reports — passed on so the view never says it twice.
    const muniPriceBase = muniRead ? muniRead.priceBase : null;
    return {
      items,
      brasil,
      years,
      loading: items.some((it) => it.loading),
      // The first failed read, for the view's one note (each failed item is also marked).
      loadError: (items.find((it) => it.loadError) || {}).loadError || null,
      muniCapable,
      priceBases: muniPriceBase ? [muniPriceBase] : [],
      comparedPriceBases: [f.muniPriceBase, f.geoPriceBase],
    };
  }

  /** The comparison shown before the researcher chooses anything: the three largest
   *  states by the latest value. Shared by the view and the CSV so the file holds what
   *  the screen shows. */
  function defaultSelection(database, summary) {
    return build({
      database, summary, metric: 'value', max: Infinity,
      selection: (window.UF_DATA || []).map((u) => ({ level: 'uf', code: u.uf })),
    }).items
      .map((it) => ({ t: { level: it.level, code: it.code }, v: (it.points[it.points.length - 1] || {}).v }))
      .filter((x) => Number.isFinite(x.v) && x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map((x) => x.t);
  }

  /** The selection in force: the researcher's (even an emptied one), else the default. */
  function selectionOf(state, database, summary) {
    return state && Array.isArray(state.items) ? state.items : defaultSelection(database, summary);
  }

  /** The names of the places in force, for everything that DESCRIBES the comparison
   *  instead of drawing it: the filter strip, the CSV confirmation, the ABNT citation.
   *  One function, so the three cannot name the selection differently. */
  function selectionLabels(state, database, summary) {
    return selectionOf(state, database, summary).map(labelOf);
  }

  /** The places the Geografia map hands to the comparison ("Comparar com outros"): what
   *  is selected there, at the finest level — municípios, then states, then the região —
   *  so the researcher starts from where they were and adds the others.
   *
   *  - A região entered on the map also writes its states to the filter; those states ARE
   *    the região, so it goes over as one região, not as its 7 (or 9) states.
   *  - A list over the limit is not cut to fit (which would drop places silently): the
   *    next coarser level goes instead.
   *  - With nothing selected the map shows Brasil split into its five regions, and those
   *    five are what it hands over. */
  function fromMapFocus({ cities = null, ufs = null, region = null, regionUfs = null } = {}) {
    const fits = (list) => Array.isArray(list) && list.length >= 1 && list.length <= MAX;
    if (fits(cities)) return cities.map((c) => ({ level: 'municipio', code: String(c) }));
    const isRegionItself = !!region && Array.isArray(ufs) && Array.isArray(regionUfs)
      && ufs.length === regionUfs.length && ufs.every((u) => regionUfs.includes(u));
    if (fits(ufs) && !isRegionItself) return ufs.map((u) => ({ level: 'uf', code: u }));
    if (region) return [{ level: 'regiao', code: region }];
    return (window.REGIONS || []).map((r) => ({ level: 'regiao', code: r.id }));
  }

  /** Pairs where one selected territory lies inside another ("Pará está dentro de
   *  Norte"). Mixing levels is allowed on purpose, and the reader needs to know when two
   *  lines overlap: Pará's value is PART of Norte's, not a rival to it. */
  function containments(selection) {
    const sel = selection || [];
    const ufOf = (t) => (t.level === 'uf' ? t.code : t.level === 'municipio' ? (muniRow(t.code) || {}).uf : null);
    const regionOf = (t) => (t.level === 'regiao' ? t.code : regionOfUf(ufOf(t)));
    const out = [];
    for (const inner of sel) {
      for (const outer of sel) {
        if (inner === outer) continue;
        const inside =
          (outer.level === 'regiao' && inner.level !== 'regiao' && regionOf(inner) === outer.code) ||
          (outer.level === 'uf' && inner.level === 'municipio' && ufOf(inner) === outer.code);
        if (inside) out.push({ inner, outer });
      }
    }
    return out;
  }

  window.TERRITORY_COMPARE_MAX = MAX;
  window.territoryCompare = {
    decode, encode, build, containments, labelOf, keyOf, defaultSelection, selectionOf,
    selectionLabels, fromMapFocus, metricsFor, metricOf, LEVEL_LABEL,
  };
})();
