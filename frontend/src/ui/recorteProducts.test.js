// recorteProducts.test.js — the basket's products INSIDE a sub-UF recorte (v1.108.2).
//
// Until then the Visão geral's composition and the Concentração's product half read the
// NATIONAL per-product series under a sub-UF chip: Portel + Breves (PA) on PPM showed the
// country's Leite 70% / Ovos 28% while the recorte loaded, after it failed, and once it had
// loaded. This reader is what replaces that series, so each of its states is pinned here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './recorteProducts.js';

// The recorte's município cube (applyFilters' muniYearlySeries): Portel and Breves.
const ROWS = [
  { year: 2022, cityCode: 1505809, uf: 'PA', value: 5 },
  { year: 2023, cityCode: 1505809, uf: 'PA', value: 6 },
  { year: 2023, cityCode: 1501808, uf: 'PA', value: 0 }, // a row: it recorded the basket in 2023
  { year: 2024, cityCode: 1501808, uf: 'PA', value: 1 }, // outside the window below
];
const resolved = (over = {}) => ({
  subUfRequested: true, subUfLoading: false, subUfLoadError: null, subUfLoaded: true,
  yearStart: 2000, yearEnd: 2023, muniYearlySeries: ROWS, ...over,
});
const LEITE = { code: '2682', name: 'Leite', measure_kind: 'flow', value: 10, q_count: 4 };

let pbm;
beforeEach(() => {
  pbm = vi.fn(() => ({ products: [LEITE], loading: false, unavailable: false, loadError: null }));
  window.productsByMunicipio = pbm;
});
afterEach(() => { delete window.productsByMunicipio; });

describe('recorteProducts — no recorte, or a recorte not resolved yet', () => {
  it('no sub-UF recorte asked for → null: the caller keeps its national path', () => {
    expect(window.recorteProducts({ subUfRequested: false }, {}, 'ibge_ppm', {})).toBeNull();
    expect(window.recorteProducts(null, {}, 'ibge_ppm', {})).toBeNull();
    expect(pbm).not.toHaveBeenCalled();
  });

  it('the recorte on its way → loading, with nothing asked yet', () => {
    const r = window.recorteProducts(
      resolved({ subUfLoading: true, subUfLoaded: false, muniYearlySeries: [] }), {}, 'ibge_ppm', {});
    expect(r).toEqual({ year: null, products: null, loading: true, loadError: null, unavailable: false });
    expect(pbm).not.toHaveBeenCalled();
  });

  it('the recorte failed → its error: never "loading", never an empty list', () => {
    const r = window.recorteProducts(
      resolved({ subUfLoadError: 'HTTP 503', subUfLoaded: false, muniYearlySeries: [] }), {}, 'ibge_ppm', {});
    expect(r).toEqual({ year: null, products: null, loading: false, loadError: 'HTTP 503', unavailable: false });
    expect(pbm).not.toHaveBeenCalled();
  });
});

describe('recorteProducts — the one-year read over the recorte’s municípios', () => {
  it('reads the latest year with a row in the window, for the cities with a row in it', () => {
    const conv = { currency: 'BRL', correction: 'Nominal' };
    const r = window.recorteProducts(resolved(), { basket: ['2682'] }, 'ibge_ppm', conv);
    expect(r).toEqual({ year: 2023, products: [LEITE], loading: false, loadError: null, unavailable: false });
    expect(pbm).toHaveBeenCalledWith(
      'ibge_ppm',
      { basket: ['2682'], startDate: '2023-01-01', endDate: '2023-12-01' },
      conv,
      ['1505809', '1501808'],
    );
  });

  it('the UF filter narrows the cities, like every cube row on screen', () => {
    const rows = [...ROWS, { year: 2023, cityCode: 2100055, uf: 'MA', value: 3 }];
    window.recorteProducts(resolved({ muniYearlySeries: rows }), { states: ['PA'] }, 'ibge_ppm', {});
    expect(pbm.mock.calls[0][3]).toEqual(['1505809', '1501808']);
  });

  it('no row in the window → a measured empty answer, and nothing to ask', () => {
    const r = window.recorteProducts(resolved({ muniYearlySeries: [] }), {}, 'ibge_ppm', {});
    expect(r).toEqual({ year: null, products: [], loading: false, loadError: null, unavailable: false });
    expect(pbm).not.toHaveBeenCalled();
  });

  it.each([
    ['on its way', { products: [], loading: true, unavailable: false, loadError: null },
      { year: 2023, products: null, loading: true, loadError: null, unavailable: false }],
    ['failed', { products: [], loading: false, unavailable: false, loadError: 'HTTP 500' },
      { year: 2023, products: null, loading: false, loadError: 'HTTP 500', unavailable: false }],
    ['refused by the banco', { products: [], loading: false, unavailable: true, loadError: null },
      { year: 2023, products: null, loading: false, loadError: null, unavailable: true }],
    ['measured empty', { products: [], loading: false, unavailable: false, loadError: null },
      { year: 2023, products: [], loading: false, loadError: null, unavailable: false }],
  ])('the products read %s', (_estado, read, esperado) => {
    // `products: []` arrives in every state of the producer; only the last is a measurement.
    window.productsByMunicipio = () => read;
    expect(window.recorteProducts(resolved(), {}, 'ibge_ppm', {})).toEqual(esperado);
  });
});
