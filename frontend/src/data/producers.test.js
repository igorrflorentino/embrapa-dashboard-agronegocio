// producers.test.js — the crosswalk catalog producer that feeds the multi-source
// commodity picker. The cross/* endpoints key on the agrupamento_id SLUG, so the
// picker must offer slugs (from /api/catalog), not PEVS product codes — this
// guards that mapping + the sync-over-async loading shape (cold → [], hot → list).

import { describe, expect, it, vi } from 'vitest';

const tick = () => new Promise((r) => setTimeout(r, 0));

function jsonRes(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

// /api/catalog shape: { agrupamento_id -> {id, name, family, pevs[], comex[], comtrade[]} }.
// `family` is the PEVS unit family in pt-BR (the backend emits it raw; agrupamentoCatalog
// normalizes it to the English keys the views use, and null = no single family).
const CATALOG = {
  castanha_caju: { id: 'castanha_caju', name: 'Castanha de caju', family: 'massa', pevs: ['49101'], comex: ['0801'], comtrade: ['0801'] },
  acai: { id: 'acai', name: 'Açaí', family: 'volume', pevs: ['40102'], comex: ['0810'], comtrade: ['0810'] },
};

// Fresh resource+producers modules per load so the module-level resource cache
// (and window.agrupamentoCatalog) start clean; fetch is reassigned directly (matches
// the other data-layer suites — restoreMocks doesn't track a direct assignment).
async function loadProducers(fetchImpl) {
  globalThis.fetch = fetchImpl;
  vi.resetModules();
  await import('./producers.js');
  return window.agrupamentoCatalog;
}

// Reload producers and return the full window surface for the filter tests.
async function loadAll(fetchImpl) {
  globalThis.fetch = fetchImpl;
  vi.resetModules();
  // bancoDim is read by the trade producers for axis labels; stub it minimally so
  // the producers don't depend on the registry module in this unit suite.
  window.bancoDim = () => ({ label: 'X' });
  await import('./producers.js');
  return window;
}

const urlOf = (f, i = 0) => f.mock.calls[i][0];

describe('agrupamentoCatalog', () => {
  it('returns [] while cold and kicks off exactly one /api/catalog fetch', async () => {
    const f = vi.fn(() => jsonRes(CATALOG));
    const agrupamentoCatalog = await loadProducers(f);

    expect(agrupamentoCatalog()).toEqual([]); // cold cache → empty, no crash
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toContain('/api/catalog');

    agrupamentoCatalog(); // a re-render before the fetch resolves must not re-fetch
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('maps to slug-keyed {code,name,family} options, family normalized, sorted pt-BR', async () => {
    const f = vi.fn(() => jsonRes(CATALOG));
    const agrupamentoCatalog = await loadProducers(f);

    agrupamentoCatalog(); // kick the fetch
    await tick();
    const opts = agrupamentoCatalog(); // cache hot now

    // code is the agrupamento_id SLUG the cross/* endpoints expect (not a PEVS code);
    // family is normalized pt-BR ('massa'/'volume') → the English keys the views gate on.
    // hasCustoms diz se existe lado aduaneiro: sem ele não há numerador para o
    // coeficiente de exportação, e a view precisa saber para não ABRIR numa recusa.
    expect(opts).toEqual([
      { code: 'acai', name: 'Açaí', family: 'volume', hasCustoms: true },
      { code: 'castanha_caju', name: 'Castanha de caju', family: 'mass', hasCustoms: true },
    ]);
  });

  it('family is null when the commodity has no single PEVS family (gated pickers skip it)', async () => {
    // A COMEX/COMTRADE-only commodity (no PEVS side) arrives without a family — the
    // export-coef / price-spread pickers (families:['mass']) must drop it.
    const f = vi.fn(() => jsonRes({
      soja: { id: 'soja', name: 'Soja', family: null, pevs: [], comex: ['1201'], comtrade: ['1201'] },
    }));
    const agrupamentoCatalog = await loadProducers(f);
    agrupamentoCatalog();
    await tick();
    expect(agrupamentoCatalog()).toEqual([
      { code: 'soja', name: 'Soja', family: null, hasCustoms: true },
    ]);
  });

  it('hasCustoms é false quando o agrupamento não tem NCM no cruzamento', async () => {
    // Café e cana-de-açúcar existem só na PAM e não têm correspondência aduaneira (o
    // abacaxi também não tinha, até a v1.100.0). Desde a v1.58.0 eles chegam aos pickers
    // de massa, e sem esta bandeira
    // a view abria no primeiro da ordem alfabética — uma recusa como tela inicial.
    const f = vi.fn(() => jsonRes({
      cafe: { id: 'cafe', name: 'Café', family: 'massa', pevs: [], pam: ['40139'],
              comex: [], comtrade: [] },
    }));
    const agrupamentoCatalog = await loadProducers(f);
    agrupamentoCatalog();
    await tick();
    expect(agrupamentoCatalog()).toEqual([
      { code: 'cafe', name: 'Café', family: 'mass', hasCustoms: false },
    ]);
  });
});

// The audit bug: the trade/productivity producers accepted only bancoId and
// dropped the active filter summary, so a basket/year window changed no chart.
// These lock that the summary is serialized into query params AND folded into the
// resource cache key (so a changed filter refetches scoped data, not the first
// snapshot).
describe('trade producers thread the active filter summary', () => {
  const SUMMARY = { basket: ['0801', '0802'], startDate: '2018-01-01', endDate: '2022-12-01' };

  it.each([
    ['flowData', 'flow'],
    ['partnerData', 'partners'],
    ['monthlyData', 'monthly'],
  ])('%s serializes basket→codes + period→y0/y1 into /api/%s', async (fn, path) => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);

    w[fn]('mdic_comex', SUMMARY);
    const url = urlOf(f);
    expect(url).toContain(`/api/${path}`);
    expect(url).toContain('codes=0801%2C0802');
    expect(url).toContain('y0=2018');
    expect(url).toContain('y1=2022');
  });

  it('partnerData sends the active currency × correction and keys the cache by it', async () => {
    // Until v1.77.0 it sent neither: the ranking stayed nominal US$ under a conventions
    // strip saying "IPCA", and switching the strip re-rendered the same answer.
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    let conv = { currency: 'USD', correction: 'IPCA' };
    w.dataStore = { ...(w.dataStore || {}), conv: () => conv };
    w.CURRENCY_FX = { BRL: { symbol: 'R$' }, USD: { symbol: 'US$' } };

    const cold = w.partnerData('mdic_comex', {}, 'value');
    expect(urlOf(f)).toContain('currency=USD');
    expect(urlOf(f)).toContain('correction=IPCA');
    expect(cold.unit).toBe('US$'); // the loading shell already names the chosen currency

    w.partnerData('mdic_comex', {}, 'value'); // same convention → cache hit
    expect(f).toHaveBeenCalledTimes(1);
    conv = { currency: 'BRL', correction: 'Nominal' };
    w.partnerData('mdic_comex', {}, 'value'); // the strip changed → refetch
    expect(f).toHaveBeenCalledTimes(2);
    expect(urlOf(f, 1)).toContain('currency=BRL');
    expect(urlOf(f, 1)).toContain('correction=Nominal');
  });

  it('flowData sends the active currency × correction and keys the cache by it', async () => {
    // Same defect as partnerData, same fix: the Sankey was nominal US$ under any convention.
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    let conv = { currency: 'EUR', correction: 'IPCA' };
    w.dataStore = { ...(w.dataStore || {}), conv: () => conv };
    w.CURRENCY_FX = { EUR: { symbol: '€' }, USD: { symbol: 'US$' } };

    const cold = w.flowData('mdic_comex', {});
    expect(urlOf(f)).toContain('currency=EUR');
    expect(urlOf(f)).toContain('correction=IPCA');
    expect(cold.unit).toBe('€');

    w.flowData('mdic_comex', {}); // same convention → cache hit
    expect(f).toHaveBeenCalledTimes(1);
    conv = { currency: 'USD', correction: 'Nominal' };
    w.flowData('mdic_comex', {}); // the strip changed → refetch
    expect(f).toHaveBeenCalledTimes(2);
    expect(urlOf(f, 1)).toContain('currency=USD');
  });

  it('monthlyData sends the active currency × correction and keys the cache by it', async () => {
    // The third view of the same defect: Sazonalidade was nominal US$ under any convention.
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    let conv = { currency: 'BRL', correction: 'IGP-M' };
    w.dataStore = { ...(w.dataStore || {}), conv: () => conv };
    w.CURRENCY_FX = { BRL: { symbol: 'R$' } };

    const cold = w.monthlyData('mdic_comex', {});
    expect(urlOf(f)).toContain('currency=BRL');
    expect(urlOf(f)).toContain('correction=IGP-M');
    expect(cold.unit).toBe('R$');

    w.monthlyData('mdic_comex', {}); // same convention → cache hit
    expect(f).toHaveBeenCalledTimes(1);
    conv = { currency: 'BRL', correction: 'IPCA' };
    w.monthlyData('mdic_comex', {}); // the strip changed → refetch
    expect(f).toHaveBeenCalledTimes(2);
    expect(urlOf(f, 1)).toContain('correction=IPCA');
  });

  it('keys the resource by the filter signature so a changed window refetches', async () => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);

    w.flowData('mdic_comex', SUMMARY); // first window
    w.flowData('mdic_comex', SUMMARY); // same → cache hit, no new fetch
    expect(f).toHaveBeenCalledTimes(1);

    w.flowData('mdic_comex', { ...SUMMARY, endDate: '2024-12-01' }); // changed window
    expect(f).toHaveBeenCalledTimes(2);
    expect(urlOf(f, 1)).toContain('y1=2024');
  });

  it('an unfiltered call sends no codes/y0/y1 (the prior default behaviour)', async () => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);

    w.flowData('mdic_comex');
    const url = urlOf(f);
    expect(url).not.toContain('codes=');
    expect(url).not.toContain('y0=');
    expect(url).not.toContain('y1=');
  });
});

describe('exportCoefficient decorates byUf rows with tile coords (F1.2)', () => {
  // The export-coef byUf rows feed BrazilTileMap, which positions each tile by
  // col/row — coords the /api omits. Like snapshot.ufData + productivity byUF, the
  // producer MUST decorate them, or every tile lands at undefined·64 = NaN.
  it('joins col/row/region/name from UF_DATA onto the resolved byUf rows', async () => {
    const payload = {
      preview: false, unit: 'mil t',
      byUf: [{ uf: 'PA', production: 10, exportV: 4, coefPct: 40 }],
      national: { coefPct: 40, production: 10 }, timeseries: [{ y: 2020, v: 40 }],
    };
    const f = vi.fn(() => jsonRes(payload));
    const w = await loadAll(f);
    window.UF_DATA = [{ uf: 'PA', col: 7, row: 2, region: 'Norte', name: 'Pará' }];

    w.exportCoefficient('castanha_caju'); // cold → kicks fetch, shell []
    await tick();
    const data = w.exportCoefficient('castanha_caju'); // hot
    expect(data.byUf[0]).toMatchObject({ uf: 'PA', col: 7, row: 2, region: 'Norte', name: 'Pará' });
  });

  it('keeps the contract `byUf` key and survives the empty loading shell', async () => {
    const f = vi.fn(() => jsonRes(null)); // cold forever → shell
    const w = await loadAll(f);
    window.UF_DATA = [];
    const shell = w.exportCoefficient('castanha_caju');
    expect(Array.isArray(shell.byUf)).toBe(true); // not undefined → no NaN tiles
    expect(shell.byUf).toEqual([]);
  });
});

describe('productivityData honours the period window but not the basket', () => {
  it('serializes only y0/y1 (no codes) and flags the basket as not-applicable', async () => {
    const f = vi.fn(() => jsonRes(null)); // cold → loading shell
    const w = await loadAll(f);

    const shell = w.productivityData('ibge_pam', '2713', {
      basket: ['9999'],
      startDate: '2010-01-01',
      endDate: '2020-12-01',
    });
    const url = urlOf(f);
    expect(url).toContain('y0=2010');
    expect(url).toContain('y1=2020');
    expect(url).not.toContain('codes='); // the basket is N/A for this view's grain
    // The basket can't apply here — surfaced honestly, not silently dropped.
    expect(shell.notApplicable).toBeTruthy();
    expect(shell.notApplicable.basket).toContain('lavoura');
  });

  it('omits notApplicable when no basket is active', async () => {
    const f = vi.fn(() => jsonRes(null));
    const w = await loadAll(f);

    const shell = w.productivityData('ibge_pam', '2713', { startDate: '2010-01-01' });
    expect(shell.notApplicable).toBeUndefined();
  });
});

// The audit gap (deferred item 2): the origin-UF dimension was dropped on the
// trade flow/partner readers. The producers must serialize summary.states into
// the `states` param for the COMEX-origin readers, and — for grains that cannot
// honour it (COMTRADE's country origin; the UF-less seasonality mart) — surface an
// honest notApplicable note instead of silently sending or dropping the filter.
describe('trade producers thread the origin-UF (states) filter', () => {
  // Origin kind drives applicability: COMEX origin = uf (filterable), COMTRADE =
  // country (not). UF_DATA gives the 27-UF universe so a proper-subset selection
  // counts as a genuine narrowing (all-selected default does not).
  const stubRegistry = (w) => {
    w.bancoDim = (id, dim) => {
      const kind = id === 'mdic_comex' && dim === 'origin' ? 'uf' : 'country';
      return { label: 'X', kind };
    };
    w.UF_DATA = Array.from({ length: 27 }, (_, i) => ({ uf: `U${i}` }));
  };

  it.each([
    ['flowData', 'flow'],
    ['partnerData', 'partners'],
  ])('%s serializes states→states param for COMEX origin', async (fn, path) => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    stubRegistry(w);

    const data = w[fn]('mdic_comex', { states: ['PA', 'SP'] });
    const url = urlOf(f);
    expect(url).toContain(`/api/${path}`);
    expect(url).toContain('states=PA%2CSP');
    expect(data.notApplicable).toBeUndefined(); // COMEX honours it → no note
  });

  it('keys the resource by the states selection so a changed UF filter refetches', async () => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    stubRegistry(w);

    w.flowData('mdic_comex', { states: ['PA'] });
    w.flowData('mdic_comex', { states: ['PA'] }); // same → cache hit
    expect(f).toHaveBeenCalledTimes(1);
    w.flowData('mdic_comex', { states: ['PA', 'SP'] }); // changed → refetch
    expect(f).toHaveBeenCalledTimes(2);
    expect(urlOf(f, 1)).toContain('states=PA%2CSP');
  });

  it.each([
    ['flowData', 'flow'],
    ['partnerData', 'partners'],
  ])('%s drops states + surfaces notApplicable for COMTRADE (country origin)', async (fn, path) => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    stubRegistry(w);

    const data = w[fn]('un_comtrade', { states: ['PA', 'SP'] });
    const url = urlOf(f);
    expect(url).toContain(`/api/${path}`);
    expect(url).not.toContain('states='); // never sent to a grain that can't honour it
    expect(data.notApplicable).toBeTruthy();
    expect(data.notApplicable.states).toContain('UF');
  });

  it('monthlyData now sends states (P6: the seasonality mart keeps state_acronym)', async () => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    stubRegistry(w);

    // The seasonality mart now keeps state_acronym in its grain, so a UF selection
    // narrows the seasonal profile — the producer sends it (no more "não se aplica").
    const data = w.monthlyData('mdic_comex', { states: ['PA'] });
    const url = urlOf(f);
    expect(url).toContain('/api/monthly');
    expect(url).toContain('states=PA');
    expect(data.notApplicable).toBeUndefined();
  });

  it('the all-UFs-selected default is not a narrowing → no note', async () => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    stubRegistry(w);

    // states = all 27 (the FilterMenu default): not a genuine narrowing.
    const allUfs = w.UF_DATA.map((u) => u.uf);
    const data = w.flowData('un_comtrade', { states: allUfs });
    expect(data.notApplicable).toBeUndefined();
  });
});

// ── Produtores BLOQUEADOS: ausência, não zero ────────────────────────────────
describe('produtores data-blocked devolvem AUSÊNCIA nas medidas', () => {
  it('chainBalance e harvestShipmentLag não fabricam zeros', async () => {
    // Os dois não têm fonte (SEFAZ inter-UF; PEVS mensal, que o IBGE não publica) e a
    // view carrega banner dizendo que é demonstração. Mas devolver 0 fazia a tela
    // afirmar "Produção = 0 mil t" e "Exportado = 0,0%" — zero é uma AFIRMAÇÃO, e aqui
    // não há nem fonte para afirmar. As LISTAS seguem vazias: uma série inexistente é
    // uma série vazia, não uma série de nulos.
    await loadProducers(vi.fn(() => jsonRes({})));
    const b = window.chainBalance('acai', 2024);
    for (const k of ['produced', 'exported', 'internal', 'domestic',
                     'expFrac', 'intFrac', 'domFrac', 'worldShare', 'worldTotal', 'exportUsd']) {
      expect(b[k], `chainBalance.${k} afirmou um número`).toBeNull();
    }
    expect(b.sankey.nodes).toEqual([]);
    expect(b.preview).toBe(true);

    const l = window.harvestShipmentLag();
    for (const k of ['peakHarvest', 'peakShip', 'lagMonths', 'corrAtLag']) {
      expect(l[k], `harvestShipmentLag.${k} afirmou um número`).toBeNull();
    }
    expect(l.months).toEqual([]);
    expect(l.preview).toBe(true);
  });
});

// The cubes' rows and the month their corrected values are at come from ONE response: the
// price-base producers reuse the cube's request helper, so they never cost a second fetch and
// can never describe a different read than the rows on screen (v1.105.0).
describe('the cubes and their price base read one response', () => {
  const OUTUBRO = { column: null, month: '2026-10', fxDate: null };

  it('geoYearly and geoYearlyPriceBase: one fetch, the rows and the month', async () => {
    const f = vi.fn(() => jsonRes({ ufYearly: [{ year: 2024, uf: 'PA', value: 1 }], priceBase: OUTUBRO }));
    const w = await loadAll(f);
    w.bancoById = () => ({ provides: ['geo'] });
    expect(w.geoYearly('ibge_pevs', {})).toBeNull();            // cold
    expect(w.geoYearlyPriceBase('ibge_pevs', {})).toBeNull();   // same key: no second fetch
    expect(f).toHaveBeenCalledTimes(1);
    expect(urlOf(f)).toContain('/api/geo-yearly');
    await tick();
    expect(w.geoYearly('ibge_pevs', {})).toEqual([{ year: 2024, uf: 'PA', value: 1 }]);
    expect(w.geoYearlyPriceBase('ibge_pevs', {})).toEqual(OUTUBRO);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a payload without the base (an app ahead of the build) reads as unknown', async () => {
    const f = vi.fn(() => jsonRes({ ufYearly: [] }));
    const w = await loadAll(f);
    w.bancoById = () => ({ provides: ['geo'] });
    w.geoYearly('ibge_pevs', {});
    await tick();
    expect(w.geoYearlyPriceBase('ibge_pevs', {})).toBeNull();
  });

  it('municipioYearly carries its base in the same state object, from one POST', async () => {
    const f = vi.fn(() => jsonRes({
      municipioYearly: [{ year: 2021, cityCode: '1500107', uf: 'PA', value: 9 }], priceBase: OUTUBRO,
    }));
    const w = await loadAll(f);
    w.bancoById = () => ({ provides: ['geo'] });
    expect(w.municipioYearly('ibge_pevs', {}, ['1500107'], [2019, 2021]))
      .toEqual({ rows: null, priceBase: null, loading: true, loadError: null });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][1].method).toBe('POST');
    await tick();
    const r = w.municipioYearly('ibge_pevs', {}, ['1500107'], [2019, 2021]);
    expect(r.priceBase).toEqual(OUTUBRO);
    expect(r.rows).toHaveLength(1);
    expect(r).toMatchObject({ loading: false, loadError: null });
    expect(f).toHaveBeenCalledTimes(1);
    // The separate accessor is gone (v1.108.1): rows, base and state are one response.
    expect(w.municipioYearlyPriceBase).toBeUndefined();
  });

  it('a banco without the geo grain asks nothing and has no base', async () => {
    const f = vi.fn(() => jsonRes({}));
    const w = await loadAll(f);
    w.bancoById = () => ({ provides: [] });
    expect(w.geoYearlyPriceBase('un_comtrade', {})).toBeNull();
    expect(w.municipioYearly('un_comtrade', {}, ['1500107']))
      .toEqual({ rows: [], priceBase: null, loading: false, loadError: null });
    expect(f).not.toHaveBeenCalled();
  });
});

// ── The município-level loaders: loading, failed and empty are three answers ──────────
// Until v1.108.1 window.geoMesh and window.municipioYearly returned null both in flight and
// after every retry failed, so a failed fetch read as "carregando municípios…" forever (the
// sub-UF selector) or as "Sem série" (Perfil do território). The shape is the one
// productsByUf established in v1.107.0; only a response with no error is a measurement.
describe('geoMeshState / municipioYearly tell loading, failed and empty apart', () => {
  const MESH = [{ cityCode: '1500107', cityName: 'Abaetetuba', uf: 'PA' }];
  // 503, not the 500 the products suite uses: the message must come from the response.
  const failing = () => vi.fn(() => Promise.resolve({ ok: false, status: 503 }));

  it('the mesh in flight is loading with no list yet, not an empty mesh', async () => {
    const f = vi.fn(() => jsonRes({ municipios: MESH }));
    const w = await loadAll(f);
    expect(w.geoMeshState()).toEqual({ municipios: null, loading: true, loadError: null });
    expect(urlOf(f)).toContain('/api/geo-mesh');
    await tick();
    expect(w.geoMeshState()).toEqual({ municipios: MESH, loading: false, loadError: null });
    expect(w.geoMesh()).toEqual(MESH); // the lookup accessor reads the same response
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a measured empty mesh is the only "no município"', async () => {
    const w = await loadAll(vi.fn(() => jsonRes({ municipios: [] })));
    w.geoMeshState();
    await tick();
    expect(w.geoMeshState()).toEqual({ municipios: [], loading: false, loadError: null });
  });

  it('the mesh is loading while retrying and failed once the retries run out', async () => {
    const f = failing();
    const w = await loadAll(f);
    // A transient failure is not announced: errorOf answers only after MAX_ATTEMPTS.
    for (let i = 0; i < 3; i++) {
      expect(w.geoMeshState()).toEqual({ municipios: null, loading: true, loadError: null });
      await tick();
    }
    expect(w.geoMeshState()).toEqual({ municipios: null, loading: false, loadError: 'HTTP 503' });
    expect(w.geoMesh()).toBeNull(); // a label falls back to the code; never [] (that is "measured")
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('the cube is loading while retrying and failed once the retries run out', async () => {
    const f = failing();
    const w = await loadAll(f);
    w.bancoById = () => ({ provides: ['geo'] });
    const read = () => w.municipioYearly('ibge_pam', {}, ['1500107']);
    for (let i = 0; i < 3; i++) {
      expect(read()).toEqual({ rows: null, priceBase: null, loading: true, loadError: null });
      await tick();
    }
    expect(read()).toEqual({ rows: null, priceBase: null, loading: false, loadError: 'HTTP 503' });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a measured empty cube is rows [] with no error', async () => {
    const w = await loadAll(vi.fn(() => jsonRes({ municipioYearly: [], priceBase: null })));
    w.bancoById = () => ({ provides: ['geo'] });
    w.municipioYearly('ibge_pam', {}, ['1500107']);
    await tick();
    expect(w.municipioYearly('ibge_pam', {}, ['1500107']))
      .toEqual({ rows: [], priceBase: null, loading: false, loadError: null });
  });

  it('no city set asks nothing and answers "nothing" (the caller knows why it is empty)', async () => {
    const f = vi.fn(() => jsonRes({ municipioYearly: [] }));
    const w = await loadAll(f);
    w.bancoById = () => ({ provides: ['geo'] });
    expect(w.municipioYearly('ibge_pam', {}, []))
      .toEqual({ rows: [], priceBase: null, loading: false, loadError: null });
    expect(f).not.toHaveBeenCalled();
  });
});

// ── Composição por produto: quatro estados, um só é medição ──────────────────
// Até a v1.107.0, carregando, falhado e "sem leitor" voltavam todos como `{ products: [] }`
// — o mesmo formato de "medi e não há nada" — e Perfil do território dizia "Sem produtos
// registrados" nos três.
describe('productsByUf / productsByMunicipio distinguem carregando, erro, indisponível e vazio', () => {
  const CONV = { currency: 'BRL', correction: 'Nominal' };
  const PA = { states: ['PA'] };

  it('com o pedido a caminho, está carregando — não vazio', async () => {
    const w = await loadAll(vi.fn(() => jsonRes({ products: [], available: true })));
    expect(w.productsByUf('ibge_pam', PA, CONV))
      .toEqual({ products: [], loading: true, unavailable: false, loadError: null });
  });

  it('respondido e vazio é a única resposta medida sem produtos', async () => {
    const w = await loadAll(vi.fn(() => jsonRes({ products: [], available: true })));
    w.productsByUf('ibge_pam', PA, CONV);
    await tick();
    expect(w.productsByUf('ibge_pam', PA, CONV)).toEqual({
      products: [], available: true, loading: false, unavailable: false, loadError: null,
    });
  });

  it('o servidor dizendo que não há leitor vira "indisponível", não vazio', async () => {
    const w = await loadAll(vi.fn(() => jsonRes({ products: [], available: false })));
    w.productsByUf('un_comtrade', PA, CONV);
    await tick();
    expect(w.productsByUf('un_comtrade', PA, CONV)).toMatchObject({
      products: [], loading: false, unavailable: true, loadError: null,
    });
  });

  it('os produtos chegam com os campos que o servidor mandou', async () => {
    // `...data` é espalhado: um campo novo do payload chega à tela sem tocar o produtor.
    const linha = { code: '2670', name: 'Bovino', tabela: '3939', measure_kind: 'stock', value: null };
    const w = await loadAll(vi.fn(() => jsonRes({ products: [linha], available: true, extra: 1 })));
    w.productsByUf('ibge_ppm', PA, CONV);
    await tick();
    const r = w.productsByUf('ibge_ppm', PA, CONV);
    expect(r.products).toEqual([linha]);
    expect(r.extra).toBe(1);
    expect(r.loading).toBe(false);
  });

  it('enquanto tenta de novo está carregando; esgotadas as tentativas, é erro', async () => {
    const f = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    const w = await loadAll(f);
    const pedir = () => w.productsByUf('ibge_pam', PA, CONV);
    // A falha transitória não é anunciada: errorOf só responde depois de MAX_ATTEMPTS.
    for (let i = 0; i < 3; i++) {
      expect(pedir()).toMatchObject({ loading: true, loadError: null });
      await tick();
    }
    expect(pedir()).toEqual({ products: [], loading: false, unavailable: false, loadError: 'HTTP 500' });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('por município: mesmo formato, e um conjunto vazio de cidades não vai ao servidor', async () => {
    const f = vi.fn(() => jsonRes({ products: [{ code: '1', name: 'Leite', value: 2 }], available: true }));
    const w = await loadAll(f);
    expect(w.productsByMunicipio('ibge_ppm', {}, CONV, []))
      .toEqual({ products: [], loading: false, unavailable: false, loadError: null });
    expect(f).not.toHaveBeenCalled();

    expect(w.productsByMunicipio('ibge_ppm', {}, CONV, ['1500107']))
      .toMatchObject({ products: [], loading: true, loadError: null });
    await tick();
    expect(w.productsByMunicipio('ibge_ppm', {}, CONV, ['1500107'])).toMatchObject({
      products: [{ code: '1', name: 'Leite', value: 2 }], loading: false, unavailable: false,
    });
    expect(f.mock.calls[0][1].method).toBe('POST');
  });
});
