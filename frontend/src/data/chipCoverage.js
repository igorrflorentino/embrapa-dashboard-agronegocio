// chipCoverage.js — pure helper backing the FilterTriggerBar chip summary.
//
// FINDING #2: on first load / banco switch the active banco's per-convention
// snapshot has not arrived yet, so applyFilters falls back to the PEVS synthetic
// globals (12 products, 1986–2024). Building the chips straight from that showed
// the cross-source catalog count + the PEVS year span for EVERY banco (COMEX read
// "Todos (12) · 1986–2024" instead of its real "Todos (5) · 1997–2026").
//
// This resolves the product TOTAL and the PERIOD the chips should show, preferring
// — when the snapshot is NOT yet loaded — the ACTIVE banco's own metadata (the
// live /api/source-meta coverage if it resolved, else the banco-specific registry
// prov), never the PEVS default. Once the snapshot is loaded, applyFilters already
// carries the banco's real values, so we use those. It also resolves the BASKET the
// products chip counts (resolveChipBasket), clamped to the banco and to the origin.
//
// Pure (no window / no React) so it is unit-testable in isolation.

/**
 * `total` is the product universe the chip counts over: the products the screen's ORIGIN
 * offers (applyFilters' `productUniverse`, v1.108.5), all of the banco's without one. Under
 * "Extração vegetal" that is the 7 extração produtos, so the chip reads "Todos (7)", like the
 * picker that writes it, and no longer "Todos (10)" beside the extração's numbers. Before the
 * snapshot loads, the banco's own metadata stands in; it knows no origin, so the chip may read
 * the banco's count for that moment and corrects when the snapshot lands.
 *
 * @param {object} args
 * @param {boolean} args.snapLoaded   - true once the banco's snapshot is in the store
 * @param {object|null} args.applied  - applyFilters() result ({ productUniverse, productsTotal, yearStart, yearEnd })
 * @param {object|null} args.meta     - dataStore.meta(banco) ({ coverage, prov })
 * @param {boolean} args.hasDateSel   - true when the summary carries an explicit date window
 * @returns {{ total:number, yearStart:number, yearEnd:number }}
 */
export function resolveChipCoverage({ snapLoaded, applied, meta, hasDateSel }) {
  const f = applied || {};
  const appliedTotal = Array.isArray(f.productUniverse)
    ? f.productUniverse.length
    : f.productsTotal != null ? f.productsTotal : (f.products || []).length;

  // Snapshot present → applyFilters already reflects the active banco; trust it.
  if (snapLoaded) {
    return { total: appliedTotal, yearStart: f.yearStart, yearEnd: f.yearEnd };
  }

  const cov = (meta && meta.coverage) || null;
  const prov = (meta && meta.prov) || null;
  const pick = (key) => {
    if (cov && cov[key] != null) return cov[key];
    if (prov && prov[key] != null) return prov[key];
    return null;
  };
  const fbTotal = pick('productsTotal');
  const fbY0 = pick('yearStart');
  const fbY1 = pick('yearEnd');

  return {
    total: fbTotal != null ? fbTotal : appliedTotal,
    // An explicit date selection already yields the right window via applyFilters;
    // only the unselected default would otherwise fall back to the PEVS span.
    yearStart: !hasDateSel && fbY0 != null ? fbY0 : f.yearStart,
    yearEnd: !hasDateSel && fbY1 != null ? fbY1 : f.yearEnd,
  };
}

/**
 * The basket the products chip counts, for a summary rebuilt from a link (main.jsx
 * withChips). `null` = no product filter ("Todos (N)").
 *
 * Two clamps, both only once the snapshot is loaded (before that `applied.products` is the
 * empty fallback, and clamping to it would erase the basket):
 *   1. To the banco's products. A shared or bookmarked link may carry a code the Curadoria
 *      later hid, or one from another banco, and the data layer intersects it away; counting
 *      it would show a phantom "1 de N". A basket left with none → null, as before.
 *   2. To the ORIGIN's products (v1.108.5), the universe `resolveChipCoverage` counts over.
 *      Under "Extração vegetal" a basket keeps only its extração produtos, and one with none
 *      of them comes back EMPTY, which the chip writes "Nenhum": the screen draws nothing for
 *      it (applyFilters' selectedProducts is empty), so "Todos" would be the wrong claim.
 *      Without an origin the universe is the banco's, and this changes nothing.
 *
 * @param {object} args
 * @param {boolean} args.snapLoaded  - true once the banco's snapshot is in the store
 * @param {string[]|null|undefined} args.basket - the summary's basket (codes)
 * @param {object|null} args.applied - applyFilters() result ({ products, productUniverse })
 * @returns {string[]|null}
 */
export function resolveChipBasket({ snapLoaded, basket, applied }) {
  const b = basket || null;
  if (!snapLoaded || !b) return b;
  const f = applied || {};
  const inBanco = new Set((f.products || []).map((p) => p.code));
  const clamped = b.filter((c) => inBanco.has(c));
  if (!clamped.length) return null;
  if (!Array.isArray(f.productUniverse)) return clamped;
  const inOrigin = new Set(f.productUniverse.map((p) => p.code));
  return clamped.filter((c) => inOrigin.has(c));
}
