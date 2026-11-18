// geoDimensions.js — the metrics the Geografia map offers for a basket.
//
// Kept out of ViewGeography so the rule can be tested without rendering the view, and
// because the rule is where the defect lived (recorded in CHANGELOG v1.107.0, Notas): ONE
// "Quantidade (cabeças)" button read the whole 'contagem' family, and Mato Grosso 2025 put
// 80,4 mi heads and 3,80 bi eggs into one figure of 3,88 bi. Now each count group
// (countUnits.js) is its own metric, named by what it counts, and a group whose products
// count different things gets no metric at all — the view names those products instead
// (CountRefusedNote).

import './countUnits.js';

(function () {
  /**
   * @param {object}   a
   * @param {string[]} a.families     the basket's quantity families ('mass', 'volume', 'count')
   * @param {object[]} a.countGroups  applyFilters' countGroups for the basket
   * @param {object[]} a.rows         the per-UF rows the map draws (real UFs only)
   * @param {object}   a.units        { value, mass, volume: {unit, mul}, count: {mul} }
   * @param {object}   a.conv         the active conventions (names a count group's unit)
   * @returns {{dims: object[], refused: object[], massUnavail: boolean, volUnavail: boolean}}
   *   `dims` is never empty (a basket with nothing to draw falls back to Valor); a count
   *   dimension carries its `group`. `refused` are the count groups no metric may draw.
   */
  function geoDimensions({ families, countGroups, rows, units, conv }) {
    const fam = (f) => (families || []).includes(f);
    // A metric is offered only when the per-UF rows CARRY it: a family in the basket whose
    // per-UF reader returns no quantity would otherwise draw an all-zero map.
    const has = (key) => (rows || []).some((u) => (u[key] || 0) > 0);
    const massAvail = fam('mass') && has('q_mass');
    const volAvail = fam('volume') && has('q_vol');
    const groups = fam('count') ? (countGroups || []) : [];
    const countDims = groups
      .filter((g) => !g.mixed)
      .map((g) => ({
        id: g.id,
        label: g.label,
        key: g.key,
        unit: window.countGroupUnit(g, conv),
        mul: units.count.mul,
        available: has(g.key),
        group: g,
      }));
    const valueDim = { id: 'value', label: 'Valor', key: 'value', ...units.value };
    // Value is the universal measure of a MONETARY banco, but a value-less stock (the herd)
    // has no value in any UF: gated like the quantities, so the herd opens on its own map.
    const dims = [
      { ...valueDim, available: has('value') },
      { id: 'mass', label: 'Quantidade (massa)', key: 'q_mass', ...units.mass, available: massAvail },
      { id: 'volume', label: 'Quantidade (volume)', key: 'q_vol', ...units.volume, available: volAvail },
      ...countDims,
    ].filter((d) => d.available);
    if (!dims.length) dims.push({ ...valueDim, available: true });
    return {
      dims,
      refused: groups.filter((g) => g.mixed),
      massUnavail: fam('mass') && !massAvail,
      volUnavail: fam('volume') && !volAvail,
    };
  }

  window.geoDimensions = geoDimensions;
})();
