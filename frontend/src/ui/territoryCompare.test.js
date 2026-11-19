// territoryCompare.test.js — the data behind "Comparativo entre territórios".
//
// The rules pinned here are the ones that would read fine while being wrong:
//   - the geography FILTER is ignored on purpose (the places are chosen on the screen), so
//     a state outside the filter still shows its own number, not a zero;
//   - a year with no row is a measured 0 (the cube is sparse), but a year whose value the
//     chosen correction does not reach stays ABSENT — never painted as 0;
//   - a região is the sum of its states, inside the selected period only;
//   - a município on a banco without that grain is declared unavailable, not zeroed;
//   - mixing levels is allowed, and the overlaps (Belém inside Pará inside Norte) are found.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import './data.js';          // REGIONS / UF_DATA reais: a região de cada UF vem daqui
import './seriesUtils.js';   // addPresent real: a regra "ausência não é zero"
import './countUnits.js';    // the real count groups, as applyFilters builds them
import './territoryCompare.js';

const tc = () => window.territoryCompare;

// Pará and Amazonas are Norte; São Paulo is Sudeste. 2018 lies OUTSIDE the window.
const UF_ROWS = [
  { year: 2018, uf: 'PA', value: 50, q_mass: 5 },
  { year: 2019, uf: 'PA', value: 100, q_mass: 10 },
  { year: 2019, uf: 'AM', value: 20, q_mass: 2 },
  { year: 2019, uf: 'SP', value: 100, q_mass: 30 },
  { year: 2020, uf: 'PA', value: 200, q_mass: 20 },
  { year: 2020, uf: 'SP', value: 150, q_mass: 35 },   // AM produced nothing in 2020
  { year: 2021, uf: 'PA', value: 300, q_mass: 30 },
  { year: 2021, uf: 'AM', value: 40, q_mass: 4 },
  { year: 2021, uf: 'SP', value: 200, q_mass: 40 },
];

const MESH = [
  { cityCode: 1501402, cityName: 'Belém', uf: 'PA', region: 'N' },
  { cityCode: 3550308, cityName: 'São Paulo', uf: 'SP', region: 'SE' },
];

const MUNI_ROWS = [
  { year: 2019, cityCode: '1501402', uf: 'PA', value: 10, q_mass: 1 },
  { year: 2021, cityCode: '1501402', uf: 'PA', value: 30, q_mass: 3 },
];

let calls;
function stub({ rows = UF_ROWS, geoLevel = 'municipio', muni = () => MUNI_ROWS, geoYearly = null,
  geoYearlyError = null, products = [{ code: 'a' }, { code: 'b' }], muniBase = null,
  muniError = null } = {}) {
  calls = { muni: [], geoYearly: 0 };
  window.dataStore = { get: () => ({ ufYearly: rows, products }) };
  window.applyFilters = () => ({ yearStart: 2019, yearEnd: 2021 });
  window.geoLevelFor = () => geoLevel;
  window.geoMesh = () => MESH;
  // The cube's read STATE (v1.108.1): `muni()` gives the rows (null = still on its way);
  // `muniError` is a read that failed for good; the base comes in the same response.
  window.municipioYearly = (banco, summary, codes) => {
    calls.muni.push(codes);
    const rows = muniError ? null : muni();
    return { rows, priceBase: rows ? muniBase : null, loading: !muniError && rows == null, loadError: muniError };
  };
  // The basket cube's read STATE too (v1.108.2): `geoYearly` gives its rows (null = still on
  // its way); `geoYearlyError` is a read that failed for good.
  window.geoYearly = () => {
    calls.geoYearly += 1;
    const rows = geoYearlyError ? null : geoYearly;
    return { rows, priceBase: null, loading: !geoYearlyError && rows == null, loadError: geoYearlyError };
  };
}

const pts = (item) => item.points.map((p) => p.v);

afterEach(() => {
  delete window.dataStore;
  delete window.applyFilters;
  delete window.geoLevelFor;
  delete window.geoMesh;
  delete window.municipioYearly;
  delete window.geoYearly;
});

describe('decode / encode — the selection in the URL', () => {
  it('round-trips a mixed-level selection', () => {
    const list = tc().decode('R:N,U:PA,M:1501402');
    expect(list).toEqual([
      { level: 'regiao', code: 'N' },
      { level: 'uf', code: 'PA' },
      { level: 'municipio', code: '1501402' },
    ]);
    expect(tc().encode(list)).toBe('R:N,U:PA,M:1501402');
  });

  it('drops what it cannot read and repeated entries, instead of guessing', () => {
    // A hand-edited or stale link: unknown prefix, missing code, a repeat.
    expect(tc().decode('X:1,U:,R:N,R:N,U:PA')).toEqual([
      { level: 'regiao', code: 'N' },
      { level: 'uf', code: 'PA' },
    ]);
    expect(tc().decode('')).toEqual([]);
    expect(tc().decode(null)).toEqual([]);
  });

  it('caps a link at the screen limit', () => {
    const ufs = ['PA', 'AM', 'SP', 'RJ', 'MG', 'BA', 'PR', 'RS', 'SC', 'GO'];
    expect(tc().decode(ufs.map((u) => `U:${u}`).join(','))).toHaveLength(window.TERRITORY_COMPARE_MAX);
    expect(window.TERRITORY_COMPARE_MAX).toBe(8);
  });
});

describe('build — the numbers per territory', () => {
  beforeEach(() => stub());

  it('sums a região from its states, inside the selected period only', () => {
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'regiao', code: 'N' }] });
    expect(out.years).toEqual([2019, 2020, 2021]);            // 2018 is outside the window
    expect(pts(out.items[0])).toEqual([120, 200, 340]);         // PA + AM
    expect(out.items[0].label).toBe('Norte');
    expect(out.items[0].levelLabel).toBe('região');
  });

  it('ignores the geography filter: a state outside it keeps its own number', () => {
    // The dashboard filtered to São Paulo; the comparison still puts Pará beside it.
    const summary = { states: ['SP'], regions: ['SE'] };
    const out = tc().build({ database: 'ibge_pevs', summary, selection: [{ level: 'uf', code: 'PA' }] });
    expect(pts(out.items[0])).toEqual([100, 200, 300]);
  });

  it('compares the whole country for the share, with every row', () => {
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'uf', code: 'SP' }] });
    expect(out.brasil.map((p) => p.v)).toEqual([220, 350, 540]);
  });

  it('a year with no row is a measured 0; a year the correction does not reach stays absent', () => {
    stub({ rows: [
      { year: 2019, uf: 'PA', value: null, q_mass: 10 },   // deflator gap
      { year: 2019, uf: 'AM', value: null, q_mass: 2 },
      { year: 2020, uf: 'PA', value: 200, q_mass: 20 },     // AM has no 2020 row
      { year: 2021, uf: 'AM', value: 40, q_mass: 4 },
    ] });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [
      { level: 'uf', code: 'AM' }, { level: 'regiao', code: 'N' },
    ] });
    expect(pts(out.items[0])).toEqual([null, 0, 40]);
    expect(pts(out.items[1])).toEqual([null, 200, 40]);
    // The quantity has no such gap: the tonnes were measured.
    const mass = tc().build({ database: 'ibge_pevs', summary: {}, metric: 'mass',
      selection: [{ level: 'regiao', code: 'N' }] });
    expect(pts(mass.items[0])).toEqual([12, 20, 4]);
  });

  it('reads a município from the city cube, scoped to the chosen cities', () => {
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [
      { level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' },
    ] });
    expect(calls.muni).toEqual([['1501402']]);
    expect(out.items[1].label).toBe('Belém (PA)');
    expect(pts(out.items[1])).toEqual([10, 0, 30]);
    expect(out.loading).toBe(false);
  });

  it('asks nothing of the city cube when no município is chosen', () => {
    tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'uf', code: 'PA' }] });
    expect(calls.muni).toEqual([]);
  });

  it('marks a município as loading while its cube is on the way', () => {
    stub({ muni: () => null });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'municipio', code: '1501402' }] });
    expect(out.items[0].loading).toBe(true);
    expect(out.loading).toBe(true);
    expect(out.loadError).toBeNull();
  });

  // Until v1.108.1 a failed cube came back null like a pending one: the place read
  // "carregando…" for good, and the CSV kept saying "espere".
  it('marks a município as FAILED, not loading, when its cube failed for good', () => {
    stub({ muniError: 'HTTP 503' });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'municipio', code: '1501402' }] });
    expect(out.items[0]).toMatchObject({ loadError: 'HTTP 503', points: [] });
    expect(out.items[0].loading).toBeFalsy();
    expect(out.loading).toBe(false);
    expect(out.loadError).toBe('HTTP 503');
  });

  it('a failed município does not hold the places that did load', () => {
    stub({ muniError: 'HTTP 503' });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [
      { level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' },
    ] });
    expect(out.items[0].loadError).toBeUndefined();
    expect(pts(out.items[0]).length).toBeGreaterThan(0);
    expect(out.items[1].loadError).toBe('HTTP 503');
  });

  it('a município measured with no rows is a row of zeros, neither loading nor failed', () => {
    stub({ muni: () => [] });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [
      { level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' },
    ] });
    expect(out.items[1].loading).toBeFalsy();
    expect(out.items[1].loadError).toBeUndefined();
    expect(pts(out.items[1]).every((v) => v === 0)).toBe(true);
    expect(out.loadError).toBeNull();
  });

  it('declares a município unavailable on a banco without that grain, instead of zeroing it', () => {
    stub({ geoLevel: 'uf' });
    const out = tc().build({ database: 'mdic_comex', summary: {}, selection: [
      { level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' },
    ] });
    expect(out.muniCapable).toBe(false);
    expect(out.items[1].unavailable).toBe(true);
    expect(out.items[1].points).toEqual([]);
    expect(calls.muni).toEqual([]);
  });

  it('uses the basket-scoped cube when the basket is narrowed, and waits for it', () => {
    stub({ geoYearly: null });
    let out = tc().build({ database: 'ibge_pevs', summary: { basket: ['a'] }, selection: [{ level: 'uf', code: 'PA' }] });
    expect(calls.geoYearly).toBe(1);
    expect(out.items[0].loading).toBe(true);

    stub({ geoYearly: [{ year: 2020, uf: 'PA', value: 7, q_mass: 1 }] });
    out = tc().build({ database: 'ibge_pevs', summary: { basket: ['a'] }, selection: [{ level: 'uf', code: 'PA' }] });
    expect(pts(out.items[0])).toEqual([7]);
  });

  // Until v1.108.2 the cube came back null both in flight and after it failed, so every UF
  // and região line said "carregando…" for good.
  it('a failed basket cube fails its UF and região lines, and withholds the Brasil line', () => {
    stub({ geoYearlyError: 'HTTP 503' });
    const out = tc().build({ database: 'ibge_pevs', summary: { basket: ['a'] }, selection: [
      { level: 'uf', code: 'PA' }, { level: 'regiao', code: 'N' },
    ] });
    for (const item of out.items) {
      expect(item).toMatchObject({ loadError: 'HTTP 503', points: [] });
      expect(item.loading).toBeFalsy();
    }
    expect(out.loadError).toBe('HTTP 503');
    expect(out).toMatchObject({ gridLoading: false, gridLoadError: 'HTTP 503' });
    // No share against a national line read from a grid that never came.
    expect(out.brasil).toEqual([]);
  });

  it('the grid state says why a default selection is empty', () => {
    stub({ geoYearly: null });
    let out = tc().build({ database: 'ibge_pevs', summary: { basket: ['a'] }, selection: [] });
    expect(out).toMatchObject({ gridLoading: true, gridLoadError: null });
    stub();
    out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [] });
    expect(out).toMatchObject({ gridLoading: false, gridLoadError: null });
  });

  it('an emptied basket gives no years at all, not a row of zeros', () => {
    const out = tc().build({ database: 'ibge_pevs', summary: { basket: [] }, selection: [{ level: 'uf', code: 'PA' }] });
    expect(out.years).toEqual([]);
    expect(out.items[0].points).toEqual([]);
  });

  it('caps the selection at the screen limit', () => {
    const sel = window.UF_DATA.slice(0, 10).map((u) => ({ level: 'uf', code: u.uf }));
    expect(tc().build({ database: 'ibge_pevs', summary: {}, selection: sel }).items).toHaveLength(8);
  });
});

describe('the selection in force', () => {
  beforeEach(() => stub());

  it('defaults to the three largest states by the latest value, skipping the empty ones', () => {
    // Only three states have 2021 production here; the other 24 must not fill the slots.
    stub({ rows: [...UF_ROWS, { year: 2021, uf: 'RJ', value: 0 }] });
    expect(tc().defaultSelection('ibge_pevs', {})).toEqual([
      { level: 'uf', code: 'PA' }, { level: 'uf', code: 'SP' }, { level: 'uf', code: 'AM' },
    ]);
  });

  it('respects a selection emptied on purpose', () => {
    expect(tc().selectionOf({ items: [] }, 'ibge_pevs', {})).toEqual([]);
    expect(tc().selectionOf({}, 'ibge_pevs', {})).toHaveLength(3);
    expect(tc().selectionOf(null, 'ibge_pevs', {})).toHaveLength(3);
  });
});

describe('containments — mixing levels, and saying when two lines overlap', () => {
  beforeEach(() => stub());

  it('finds every inner-inside-outer pair across levels', () => {
    const N = { level: 'regiao', code: 'N' };
    const PA = { level: 'uf', code: 'PA' };
    const SP = { level: 'uf', code: 'SP' };
    const belem = { level: 'municipio', code: '1501402' };
    const pairs = tc().containments([N, PA, SP, belem])
      .map(({ inner, outer }) => `${tc().keyOf(inner)}<${tc().keyOf(outer)}`);
    expect(pairs.sort()).toEqual(['M:1501402<R:N', 'M:1501402<U:PA', 'U:PA<R:N']);
  });

  it('two regions, or two states, never contain each other', () => {
    expect(tc().containments([{ level: 'regiao', code: 'N' }, { level: 'regiao', code: 'SE' }])).toEqual([]);
    expect(tc().containments([{ level: 'uf', code: 'PA' }, { level: 'uf', code: 'SP' }])).toEqual([]);
  });
});

describe('fromMapFocus — what "Comparar com outros" hands over from the Geografia map', () => {
  const NORTE = ['RO', 'AC', 'AM', 'RR', 'PA', 'AP', 'TO'];

  it('the finest selection wins: municípios, then states, then the região', () => {
    expect(tc().fromMapFocus({ cities: [1501402], ufs: ['PA'], region: 'N', regionUfs: NORTE }))
      .toEqual([{ level: 'municipio', code: '1501402' }]);
    expect(tc().fromMapFocus({ ufs: ['PA'], region: 'N', regionUfs: NORTE }))
      .toEqual([{ level: 'uf', code: 'PA' }]);
  });

  it('a região entered on the map goes as ONE região, not as its seven states', () => {
    // Entering a região writes its states to the filter too; those states ARE the região.
    expect(tc().fromMapFocus({ ufs: NORTE, region: 'N', regionUfs: NORTE }))
      .toEqual([{ level: 'regiao', code: 'N' }]);
  });

  it('several states picked in the filter go over as those states', () => {
    expect(tc().fromMapFocus({ ufs: ['PA', 'AM'] }))
      .toEqual([{ level: 'uf', code: 'PA' }, { level: 'uf', code: 'AM' }]);
  });

  it('over the limit, the list is not cut (that would drop places silently): a coarser level goes', () => {
    const nine = ['PA', 'AM', 'SP', 'RJ', 'MG', 'BA', 'PR', 'RS', 'SC'];
    expect(tc().fromMapFocus({ ufs: nine })).toHaveLength(5);            // the five regions
    expect(tc().fromMapFocus({ ufs: nine })[0].level).toBe('regiao');
  });

  it('with nothing selected the map shows Brasil in five regions, and those five go over', () => {
    expect(tc().fromMapFocus({}).map((t) => t.code)).toEqual(['N', 'NE', 'CO', 'SE', 'S']);
    expect(tc().fromMapFocus({ cities: [], ufs: null }).every((t) => t.level === 'regiao')).toBe(true);
  });
});

// The share column divides the município cube (read from the analytical base) by `brasil`
// (the pre-aggregated tables): across a build the two can be a month apart, so the cube's
// price base travels with the result, and the view says so (v1.105.0).
describe('build — the month the município cube is at', () => {
  const NOVEMBRO = { column: null, month: '2026-11', fxDate: null };

  it('carries the cube base, read from the same request as the rows', () => {
    stub({ muniBase: NOVEMBRO });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [
      { level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' },
    ] });
    expect(out.priceBases).toEqual([NOVEMBRO]);
    // ONE read gives rows and base (v1.108.1: the separate accessor is gone).
    expect(calls.muni).toEqual([['1501402']]);
  });

  it('with no município chosen there is no own read, and so no base of its own', () => {
    stub({ muniBase: NOVEMBRO });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'uf', code: 'PA' }] });
    expect(out.priceBases).toEqual([]);
  });

  it('passes on the bases MainScreen already compares, so the view never repeats them', () => {
    stub();
    const SETEMBRO = { column: null, month: '2026-09', fxDate: null };
    window.applyFilters = () => ({ yearStart: 2019, yearEnd: 2021, muniPriceBase: SETEMBRO, geoPriceBase: null });
    const out = tc().build({ database: 'ibge_pevs', summary: {}, selection: [{ level: 'uf', code: 'PA' }] });
    expect(out.comparedPriceBases).toEqual([SETEMBRO, null]);
  });
});

// ── Counts (v1.108.0): one metric per thing counted ──────────────────────────
// Until v1.108.0 the comparison had ONE count metric over every count of the basket: on
// the PPM, the herd's heads plus a year's eggs.
describe('metricsFor / metricOf — a count metric per thing counted', () => {
  const BOVINO = { code: '2670', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
  const OVOS = { code: '2685', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
  const ABACAXI = { code: '40092', family: 'count', unit_native: 'Mil frutos' };
  function stubBasket(families, products) {
    window.familiesInBasket = () => families;
    window.applyFilters = () => ({
      yearStart: 2019, yearEnd: 2021,
      countGroups: window.countGroups(products, products.map((p) => p.code)),
    });
  }
  afterEach(() => { delete window.familiesInBasket; });

  it('offers value, the quantity families, and the herd and the eggs as two metrics', () => {
    stubBasket(['mass', 'count'], [BOVINO, OVOS]);
    const { options, refused } = tc().metricsFor('ibge_ppm', {});
    expect(options.map((o) => [o.id, o.label])).toEqual([
      ['value', 'Valor'],
      ['mass', 'Quantidade (massa)'],
      ['count_stock', 'Efetivo (cabeças)'],
      ['count_flow', 'Quantidade (ovos)'],
    ]);
    expect(refused).toEqual([]);
  });

  it('a group that counts different things is no metric, and comes back as refused', () => {
    stubBasket(['count'], [OVOS, ABACAXI]);
    const { options, refused } = tc().metricsFor('ibge_ppm', {});
    expect(options.map((o) => o.id)).toEqual(['value']);
    expect(refused.map((g) => g.plurals)).toEqual([['ovos', 'frutos']]);
  });

  it('a basket without the count family reads no count group at all', () => {
    stubBasket(['mass'], [BOVINO]);
    expect(tc().metricsFor('ibge_ppm', {}).options.map((o) => o.id)).toEqual(['value', 'mass']);
  });

  it('an old link (tm=count) opens its one count group; with two it was a sum, and opens on Valor', () => {
    stubBasket(['count'], [OVOS]);
    const one = tc().metricsFor('ibge_ppm', {}).options;
    expect(tc().metricOf('count', one)).toBe('count_flow');
    stubBasket(['count'], [BOVINO, OVOS]);
    const two = tc().metricsFor('ibge_ppm', {}).options;
    expect(tc().metricOf('count', two)).toBe('value');
    expect(tc().metricOf('count_stock', two)).toBe('count_stock');
    expect(tc().metricOf('volume', two)).toBe('value');   // not in this basket
    expect(tc().metricOf(undefined, two)).toBe('value');
  });

  it('each count metric reads its own total, never the other', () => {
    stub({ rows: [
      { year: 2019, uf: 'PA', value: null, q_mass: 0, q_count_stock: 20, q_count_flow: 1000 },
      { year: 2020, uf: 'PA', value: null, q_mass: 0, q_count_stock: 21, q_count_flow: 1100 },
    ] });
    const sel = [{ level: 'uf', code: 'PA' }];
    const herd = tc().build({ database: 'ibge_ppm', summary: {}, selection: sel, metric: 'count_stock' });
    const eggs = tc().build({ database: 'ibge_ppm', summary: {}, selection: sel, metric: 'count_flow' });
    expect(pts(herd.items[0])).toEqual([20, 21]);
    expect(pts(eggs.items[0])).toEqual([1000, 1100]);
    expect(herd.brasil.map((p) => p.v)).toEqual([20, 21]);
  });
});
