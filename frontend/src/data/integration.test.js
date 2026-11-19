// integration.test.js — the cross-module data path no unit suite exercises end to
// end: the REAL dataStore (fetching a mocked /api/snapshot) → the REAL decorate →
// the REAL producers (geoYearly cube) → the REAL applyFilters, asserting on the
// hero/territorial outputs a view would render.
//
// Why this exists (audit follow-up): dataStore.test.js stops at ds.get(); the
// dataFilters.test.js suite starts from a STUBBED window.dataStore.get returning a
// static snapshot. So a contract drift AT THE SEAM between them — decorate emitting
// a field shape applyFilters doesn't read, the snapshot's ufYearly grain being lost
// in the store, the geoYearly producer's cube key diverging from what applyFilters
// expects — passes every unit test while the live app renders blank. These wire the
// modules together with ONLY the network mocked, the one place that bug surfaces.

import { describe, expect, it, vi } from 'vitest';

// The fetch → decorate → cache chain resolves over a few microtask ticks; a
// macro-task tick also drains the resource-cache (geoYearly) fetch.
const settle = () => new Promise((r) => setTimeout(r, 0));

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

// A PEVS-shaped snapshot, scaled by convention so a currency switch is observable
// end-to-end. ufData is the latest-year (2021) per-UF scope; ufYearly carries both
// years (it backs the state-narrowed series + the all-time UF universe). Regions
// arrive as DISPLAY NAMES ("Norte"/"Sul") so decorate's name→code normalization is
// genuinely exercised (not pre-canonical test data).
function snapshotFor(currency) {
  const s = currency === 'USD' ? 0.2 : 1; // USD ≈ 1/5 BRL — just needs to differ
  const f = (n) => Math.round(n * s * 1000) / 1000;
  return {
    products: [
      { code: 'A', name: 'Açaí', unit: 't', family: 'mass' },
      { code: 'B', name: 'Babaçu', unit: 't', family: 'mass' },
      { code: 'C', name: 'Castanha', unit: 't', family: 'mass' },
    ],
    productTS: {
      A: [{ y: 2020, v: f(30), q: 3, family: 'mass' }, { y: 2021, v: f(33), q: 3.3, family: 'mass' }],
      B: [{ y: 2020, v: f(20), q: 2, family: 'mass' }, { y: 2021, v: f(22), q: 2.2, family: 'mass' }],
      C: [{ y: 2020, v: f(10), q: 1, family: 'mass' }, { y: 2021, v: f(11), q: 1.1, family: 'mass' }],
    },
    overviewTS: [{ y: 2020, v: f(0.06) }, { y: 2021, v: f(0.066) }],
    ufData: [
      { uf: 'PA', value: f(100), q_mass: 50, q_vol: 0, region: 'Norte' },
      { uf: 'RS', value: f(40), q_mass: 20, q_vol: 0, region: 'Sul' },
    ],
    ufYearly: [
      { year: 2020, uf: 'PA', value: f(90), q_mass: 45, q_vol: 0, region: 'Norte' },
      { year: 2021, uf: 'PA', value: f(100), q_mass: 50, q_vol: 0, region: 'Norte' },
      { year: 2020, uf: 'RS', value: f(36), q_mass: 18, q_vol: 0, region: 'Sul' },
      { year: 2021, uf: 'RS', value: f(40), q_mass: 20, q_vol: 0, region: 'Sul' },
    ],
    quality: [{ id: 'OK', count: 9 }],
    qualityTs: [],
  };
}

// Basket-scoped (UF × year) cube for product 'A' only (what /api/geo-yearly returns
// when a basket narrows products). Smaller than the all-products snapshot so the
// "cube took over" assertions can't accidentally match the snapshot totals.
const GEO_CUBE_A = {
  ufYearly: [
    { year: 2020, uf: 'PA', name: 'Pará', region: 'Norte', value: 50, q_mass: 25, q_vol: 0 },
    { year: 2021, uf: 'PA', name: 'Pará', region: 'Norte', value: 55, q_mass: 27, q_vol: 0 },
    { year: 2020, uf: 'RS', name: 'Rio Grande do Sul', region: 'Sul', value: 8, q_mass: 4, q_vol: 0 },
    { year: 2021, uf: 'RS', name: 'Rio Grande do Sul', region: 'Sul', value: 9, q_mass: 4.5, q_vol: 0 },
  ],
};

// The per-product series of the UF subset {PA} (what /api/product-ts returns, v1.108.3): Pará's
// own, a fraction of the national productTS above, with Castanha absent (none in Pará).
const PRODUCT_TS_PA = {
  productTS: {
    A: [{ y: 2020, v: 3, q: 0.3, family: 'mass' }, { y: 2021, v: 4, q: 0.4, family: 'mass' }],
    B: [{ y: 2020, v: 2, q: 0.2, family: 'mass' }, { y: 2021, v: 1, q: 0.1, family: 'mass' }],
  },
  priceBase: null,
  available: true,
};

// A URL-dispatching fetch mock: /snapshot varies by the currency query param,
// /source-meta returns minimal provenance, /geo-yearly returns the basket cube.
function makeFetch({ snapshot = snapshotFor, geoCube = GEO_CUBE_A, productTs = PRODUCT_TS_PA } = {}) {
  return vi.fn((url) => {
    const u = String(url);
    if (u.includes('/source-meta')) {
      return jsonRes({ table: 'gold_pevs_production', yearStart: 2020, yearEnd: 2021 });
    }
    if (u.includes('/geo-yearly')) return jsonRes(geoCube);
    if (u.includes('/product-ts')) return jsonRes(productTs);
    if (u.includes('/snapshot')) {
      const cur = new URL(u, 'http://x').searchParams.get('currency') || 'BRL';
      return jsonRes(snapshot(cur));
    }
    return jsonRes({});
  });
}

// Boot the data layer the way the app does: registries on window, then the three
// modules that attach window.dataStore / window.geoYearly / window.applyFilters.
// vi.resetModules() gives each test a fresh store + resource cache.
async function boot(fetchImpl) {
  globalThis.fetch = fetchImpl;
  vi.resetModules();
  // Tile-grid + region + quality registries the API omits (decorate joins these).
  window.UF_DATA = [
    { uf: 'PA', col: 7, row: 2, region: 'N', name: 'Pará' },
    { uf: 'RS', col: 3, row: 8, region: 'S', name: 'Rio Grande do Sul' },
  ];
  window.REGIONS = [
    { id: 'N', label: 'Norte' },
    { id: 'S', label: 'Sul' },
  ];
  window.QUALITY_FLAGS = [{ id: 'OK', label: 'Sem ressalvas', color: 'var(--ok)' }];
  window.VIZ_SCALE = ['var(--viz-1)'];
  window.VALUE_PRESETS = [];
  window.MUNI_PICKER_NAMES = new Set();
  // bancoById drives tableOf (dataStore) AND the geo-capability gate (geoYearly).
  window.bancoById = (id) => ({
    id,
    table: 'gold_pevs_production',
    provides: ['product', 'geo', 'quality'],
  });
  // Order matters: dataStore.js (window.dataStore) → producers.js (window.geoYearly,
  // reads window.dataStore.conv) → ui/dataFilters.js (window.applyFilters, reads
  // both). decorate.js (imported by the first two) installs normalizeRegion.
  await import('./dataStore.js');
  await import('./producers.js');
  await import('../ui/dataFilters.js');
  return { ds: window.dataStore, applyFilters: window.applyFilters };
}

describe('integration: snapshot → decorate → applyFilters (baseline, no filter)', () => {
  it('the hero series + territorial split reflect the REAL decorated snapshot', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);

    const res = await ds.load('ibge_pevs');
    expect(res.status).toBe('ready');

    const view = applyFilters({}, 'ibge_pevs');

    // National hero series = Σ productTS.v ÷ 1000 (mi → bi), all products, both years.
    expect(view.ts.find((d) => d.y === 2020).v).toBeCloseTo(0.06); // (30+20+10)/1000
    expect(view.ts.find((d) => d.y === 2021).v).toBeCloseTo(0.066); // (33+22+11)/1000
    expect(view.ts.find((d) => d.y === 2021).q_mass).toBeCloseTo(6.6); // 3.3+2.2+1.1

    // ufData came through decorate: tile coords joined, region NAME → CODE normalized.
    const pa = view.ufData.find((u) => u.uf === 'PA');
    expect(pa).toMatchObject({ value: 100, col: 7, row: 2, region: 'N', name: 'Pará' });

    // regionData groups ufData by region CODE — would be empty if decorate left "Norte".
    expect(view.regionData.find((r) => r.id === 'N').value).toBe(100);
    expect(view.regionData.find((r) => r.id === 'S').value).toBe(40);

    // All-time UF universe (the "/27" denominator) spans every covered year.
    expect(view.ufDataFull.map((u) => u.uf).sort()).toEqual(['PA', 'RS']);
    expect(view.notFilteredByBasket).toBe(false);
  });

  it('decorates the quality breakdown via the shared taxonomy', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);
    await ds.load('ibge_pevs');
    const view = applyFilters({}, 'ibge_pevs');
    expect(view.qualityFlags[0]).toMatchObject({ id: 'OK', label: 'Sem ressalvas', color: 'var(--ok)' });
  });
});

describe('integration: a state filter reaches the hero through the real ufYearly', () => {
  it('derives the series + map from the selected UF, not the national curve', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);
    await ds.load('ibge_pevs');

    const view = applyFilters({ states: ['PA'] }, 'ibge_pevs');

    // PA-only series from ufYearly (mi → bi): 90/1000, 100/1000 — NOT the national 60/66.
    expect(view.ts.find((d) => d.y === 2020).v).toBeCloseTo(0.09);
    expect(view.ts.find((d) => d.y === 2021).v).toBeCloseTo(0.1);
    expect(view.ts.find((d) => d.y === 2021).q_mass).toBe(50);
    // The choropleth/ranking drops RS entirely.
    expect(view.ufData.map((u) => u.uf)).toEqual(['PA']);
    expect(view.ufData[0].value).toBe(100);
  });
});

// v1.108.3: under a UF subset the per-product series are Pará's own, read from /api/product-ts.
// Until they land NO per-product series stands — the national one under the UF chip was the
// defect (Pará's Leite at Brazil's R$ 90 bi, measured 2026-11-18).
describe('integration: a state filter reaches the per-product series through /api/product-ts', () => {
  it('holds them while the read is cold, then they are the UF’s — never the national ones', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);
    await ds.load('ibge_pevs');

    const cold = applyFilters({ states: ['PA'] }, 'ibge_pevs');
    expect(cold.productUfLoading).toBe(true);
    expect(cold.productTS).toEqual({});
    expect(cold.topProducts).toEqual([]);
    const pedido = f.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/product-ts'));
    expect(pedido).toContain('banco=ibge_pevs');
    expect(pedido).toContain('states=PA');

    await settle();

    const hot = applyFilters({ states: ['PA'] }, 'ibge_pevs');
    expect(hot.productUfLoading).toBe(false);
    expect(hot.productTS.A.map((d) => d.v)).toEqual([3, 4]); // the national is 30 → 33
    expect(hot.productTS.C).toBeUndefined();
    expect(hot.topProducts.map((p) => [p.name, p.share])).toEqual([['Açaí', 0.8], ['Babaçu', 0.2]]);
    // The aggregate series stays the UF grid's, as before.
    expect(hot.ts.find((d) => d.y === 2021).v).toBeCloseTo(0.1);
  });
});

describe('integration: a product basket pulls the geoYearly cube through to the map', () => {
  it('is honest (notFilteredByBasket) while the cube loads, then narrows to it', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);
    await ds.load('ibge_pevs');

    // First render: the cube fetch is COLD → geoYearly returns null → the territorial
    // split still shows the all-products snapshot, flagged honestly.
    const cold = applyFilters({ basket: ['A'] }, 'ibge_pevs');
    expect(cold.notFilteredByBasket).toBe(true);
    expect(cold.ufData.find((u) => u.uf === 'PA').value).toBe(100); // all-products snapshot
    // The national series IS basket-aware via productTS even before the cube (product A only).
    expect(cold.ts.find((d) => d.y === 2021).v).toBeCloseTo(0.033); // 33/1000

    // The geoYearly resource fetch resolves; the boundary would re-render.
    await settle();

    // Second render: the cube is hot → the map reflects product A × UF, note cleared.
    const hot = applyFilters({ basket: ['A'] }, 'ibge_pevs');
    expect(hot.notFilteredByBasket).toBe(false);
    expect(hot.ufData.find((u) => u.uf === 'PA').value).toBe(55); // cube 2021 PA, decorated
    expect(hot.ufData.find((u) => u.uf === 'PA')).toMatchObject({ col: 7, row: 2, region: 'N' });
    // Series from the cube: Σ all cube UFs ÷ 1000 for 2021 = (55+9)/1000.
    expect(hot.ts.find((d) => d.y === 2021).v).toBeCloseTo(0.064);
  });

  it('issues exactly one /geo-yearly fetch for the basket cube', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);
    await ds.load('ibge_pevs');

    applyFilters({ basket: ['A'] }, 'ibge_pevs'); // kicks the cube fetch
    await settle();
    applyFilters({ basket: ['A'] }, 'ibge_pevs'); // cube hot → no new fetch

    const geoCalls = f.mock.calls.filter((c) => String(c[0]).includes('/geo-yearly')).length;
    expect(geoCalls).toBe(1);
    // The cube URL carries the active convention + the basket codes.
    const geoUrl = f.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/geo-yearly'));
    expect(geoUrl).toContain('codes=A');
    expect(geoUrl).toContain('currency=BRL');
  });
});

describe('integration: a convention switch re-fetches and flows to the filtered output', () => {
  it('re-runs the snapshot under USD and the new values reach applyFilters', async () => {
    const f = makeFetch();
    const { ds, applyFilters } = await boot(f);

    await ds.load('ibge_pevs'); // BRL|IPCA
    expect(applyFilters({}, 'ibge_pevs').ufData.find((u) => u.uf === 'PA').value).toBe(100);

    ds.setConventions({ currency: 'USD', correction: 'IPCA' }); // re-fetch under USD
    await settle();

    expect(ds.status('ibge_pevs')).toBe('ready');
    // The USD snapshot (PA scaled 100 → 20) reached the territorial split end-to-end.
    expect(applyFilters({}, 'ibge_pevs').ufData.find((u) => u.uf === 'PA').value).toBe(20);
    const snapUrls = f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/snapshot'));
    expect(snapUrls.pop()).toContain('currency=USD');
  });
});

describe('integration: a drifted snapshot fails loudly instead of rendering blank', () => {
  it('surfaces status=error and applyFilters degrades to empty (no fabricated data)', async () => {
    // productTS arrives as an array (contract drift) — assertSnapshotShape rejects it.
    const bad = (cur) => ({ ...snapshotFor(cur), productTS: [] });
    const f = makeFetch({ snapshot: bad });
    const { ds, applyFilters } = await boot(f);

    const res = await ds.load('ibge_pevs');
    expect(res.status).toBe('error');
    expect(ds.error('ibge_pevs')).toMatch(/contrato.*productTS/i);
    expect(ds.get('ibge_pevs')).toBe(null);

    // applyFilters with an unloaded banco must NOT throw — it degrades to the empty
    // dataset fallback (no store data), proving the gate fails safe rather than
    // crashing the view. With no overviewTS/productTS loaded there is no fabricated
    // VALUE series — the hero/series render empty, not a wrong number.
    const view = applyFilters({}, 'ibge_pevs');
    expect(view.ts).toEqual([]);
    expect(view.selectedProducts).toEqual([]);
  });
});
