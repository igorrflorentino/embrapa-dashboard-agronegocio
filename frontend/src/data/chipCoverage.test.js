// chipCoverage.test.js — the filter-chip coverage resolution (FINDING #2).
// On first load / banco switch, before the active banco's snapshot lands,
// applyFilters returns the PEVS synthetic globals (12 products, 1986–2024). The
// chips must instead show the ACTIVE banco's real product count + data range.

import { describe, expect, it } from 'vitest';

import { resolveChipBasket, resolveChipCoverage } from './chipCoverage.js';

// applyFilters fallback shape when the snapshot is cold (PEVS synthetic globals).
const PEVS_FALLBACK = { productsTotal: 12, yearStart: 1986, yearEnd: 2024 };

describe('resolveChipCoverage', () => {
  it('uses the LIVE source-meta coverage when the snapshot is not loaded yet', () => {
    // COMEX: real catalog = 5 products, range 1997–2026. The chip must NOT show the
    // PEVS default the cold applyFilters returned.
    const out = resolveChipCoverage({
      snapLoaded: false,
      applied: PEVS_FALLBACK,
      meta: { coverage: { productsTotal: 5, yearStart: 1997, yearEnd: 2026 } },
      hasDateSel: false,
    });
    expect(out).toEqual({ total: 5, yearStart: 1997, yearEnd: 2026 });
  });

  it('falls back to the banco registry prov when source-meta has not resolved', () => {
    const out = resolveChipCoverage({
      snapLoaded: false,
      applied: PEVS_FALLBACK,
      meta: { coverage: null, prov: { productsTotal: 5, yearStart: 1997, yearEnd: 2024 } },
      hasDateSel: false,
    });
    expect(out).toEqual({ total: 5, yearStart: 1997, yearEnd: 2024 });
  });

  it('prefers source-meta coverage over the registry prov when both exist', () => {
    const out = resolveChipCoverage({
      snapLoaded: false,
      applied: PEVS_FALLBACK,
      meta: {
        coverage: { productsTotal: 5, yearStart: 1997, yearEnd: 2026 }, // live Gold
        prov: { productsTotal: 5, yearStart: 1997, yearEnd: 2024 }, // frozen registry
      },
      hasDateSel: false,
    });
    expect(out.yearEnd).toBe(2026); // the live value, not the registry 2024
  });

  it('trusts applyFilters once the snapshot IS loaded (real banco values)', () => {
    // Snapshot present → applyFilters already reflects the banco; meta is ignored.
    const out = resolveChipCoverage({
      snapLoaded: true,
      applied: { productsTotal: 3, yearStart: 1986, yearEnd: 2024 }, // real PEVS
      meta: { coverage: { productsTotal: 999, yearStart: 1, yearEnd: 2 } },
      hasDateSel: false,
    });
    expect(out).toEqual({ total: 3, yearStart: 1986, yearEnd: 2024 });
  });

  it('keeps an explicit date selection (deep link) instead of the banco span', () => {
    // hasDateSel → applyFilters already carries the user window; do not override it.
    const out = resolveChipCoverage({
      snapLoaded: false,
      applied: { productsTotal: 12, yearStart: 2000, yearEnd: 2010 }, // user window
      meta: { coverage: { productsTotal: 5, yearStart: 1997, yearEnd: 2026 } },
      hasDateSel: true,
    });
    expect(out.yearStart).toBe(2000); // selection preserved
    expect(out.yearEnd).toBe(2010);
    expect(out.total).toBe(5); // product total still corrected to the banco's
  });

  it('degrades to the applied values when no banco metadata is available', () => {
    const out = resolveChipCoverage({
      snapLoaded: false,
      applied: PEVS_FALLBACK,
      meta: null,
      hasDateSel: false,
    });
    expect(out).toEqual({ total: 12, yearStart: 1986, yearEnd: 2024 });
  });

  // v1.108.5: under a PEVS origin the chip counts over the ORIGIN's products. It read
  // "Todos (10)" under "Extração vegetal", whose picker offers 7.
  it('counts over the origin’s products once the snapshot is loaded', () => {
    const out = resolveChipCoverage({
      snapLoaded: true,
      applied: { productsTotal: 10, productUniverse: EXTRACAO, yearStart: 1986, yearEnd: 2025 },
      meta: null,
      hasDateSel: false,
    });
    expect(out.total).toBe(7);
  });
});

// The PEVS halves (codes from prod): 7 produtos in extração (289), 3 in silvicultura (291).
const EXTRACAO = ['3403', '3404', '3405', '3433', '3434', '3435', '3450']
  .map((code) => ({ code, tabela: '289' }));
const SILVICULTURA = ['3455', '3456', '3457'].map((code) => ({ code, tabela: '291' }));
const PEVS = [...EXTRACAO, ...SILVICULTURA];

describe('resolveChipBasket — the basket the products chip counts', () => {
  const sob = (productUniverse) => ({ products: PEVS, productUniverse });

  it('no basket stays null ("Todos"), loaded or not', () => {
    expect(resolveChipBasket({ snapLoaded: true, basket: null, applied: sob(EXTRACAO) })).toBeNull();
    expect(resolveChipBasket({ snapLoaded: false, basket: undefined, applied: null })).toBeNull();
  });

  it('before the snapshot loads, the basket is left as it came', () => {
    // applied.products is the empty fallback then: clamping to it would erase the basket.
    const basket = ['3403', '9999'];
    expect(resolveChipBasket({ snapLoaded: false, basket, applied: { products: [] } })).toBe(basket);
  });

  it('a code the banco no longer has is dropped, and a basket of only such codes is "Todos"', () => {
    expect(resolveChipBasket({ snapLoaded: true, basket: ['3403', '9999'], applied: sob(PEVS) }))
      .toEqual(['3403']);
    expect(resolveChipBasket({ snapLoaded: true, basket: ['9999'], applied: sob(PEVS) })).toBeNull();
  });

  it('under an origin, keeps only the origin’s produtos', () => {
    expect(resolveChipBasket({ snapLoaded: true, basket: ['3403', '3456'], applied: sob(EXTRACAO) }))
      .toEqual(['3403']);
  });

  it('a basket with none of the origin’s produtos is EMPTY ("Nenhum"), never "Todos"', () => {
    // The screen draws nothing for it (applyFilters' selectedProducts is empty).
    expect(resolveChipBasket({ snapLoaded: true, basket: ['3455', '3456'], applied: sob(EXTRACAO) }))
      .toEqual([]);
  });

  it('without an origin the universe is the banco’s, and nothing else changes', () => {
    expect(resolveChipBasket({ snapLoaded: true, basket: ['3403', '3456'], applied: sob(PEVS) }))
      .toEqual(['3403', '3456']);
    // An applyFilters result without the field (older shape) clamps to the banco alone.
    expect(resolveChipBasket({ snapLoaded: true, basket: ['3403', '3456'], applied: { products: PEVS } }))
      .toEqual(['3403', '3456']);
  });
});
