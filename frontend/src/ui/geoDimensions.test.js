// geoDimensions.test.js — the metrics the Geografia map offers for a basket.
//
// Until v1.108.0 the map had ONE count metric, "Quantidade (cabeças)", over every count of
// the basket: Mato Grosso 2025 read 3,88 bi "cabeças", 3,80 bi of them eggs (measured on
// prod 2026-11-18). Pinned here: one metric per count group, named by what it counts; a
// group that counts different things gets no metric and is returned as refused; a metric
// the per-UF rows do not carry is not offered; the map always has something to draw.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import './data.js';            // the real UNIT_FAMILIES (count units of the convention)
import './geoDimensions.js';   // imports countUnits.js itself

const BOVINO = { code: '2670', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
const OVOS = { code: '2685', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
const ABACAXI = { code: '40092', family: 'count', unit_native: 'Mil frutos' };
const groupsOf = (...ps) => window.countGroups(ps, ps.map((p) => p.code));

const UNITS = {
  value: { unit: 'R$ mi', mul: 1 },
  mass: { unit: 'mil t', mul: 1 },
  volume: { unit: 'mi m³', mul: 1 },
  count: { mul: 1 },
};
const CONV = { units: { count: 'un' } };
// Mato Grosso 2025 on the PPM, in mi un: the herd's heads and a year's eggs, apart.
const MT = { uf: 'MT', value: 900, q_mass: 0, q_vol: 0, q_count_stock: 80.4, q_count_flow: 3803.2 };

const dims = (out) => out.dims.map((d) => [d.id, d.label, d.key, d.unit]);

beforeEach(() => { window.unitOf = (c, fam) => c.units[fam]; });
afterEach(() => { delete window.unitOf; });

describe('geoDimensions — a count metric per thing counted', () => {
  it('the herd and the eggs are two metrics, each in its own unit', () => {
    const out = window.geoDimensions({
      families: ['count'], countGroups: groupsOf(BOVINO, OVOS), rows: [MT], units: UNITS, conv: CONV,
    });
    expect(dims(out)).toEqual([
      ['value', 'Valor', 'value', 'R$ mi'],
      ['count_stock', 'Efetivo (cabeças)', 'q_count_stock', 'cabeças'],
      ['count_flow', 'Quantidade (ovos)', 'q_count_flow', 'ovos'],
    ]);
    expect(out.refused).toEqual([]);
    // No metric reads both totals.
    expect(out.dims.some((d) => d.key === 'q_count')).toBe(false);
  });

  it('a value-less herd opens on its own map: value is not offered where no UF has any', () => {
    const out = window.geoDimensions({
      families: ['count'], countGroups: groupsOf(BOVINO),
      rows: [{ uf: 'MT', value: null, q_count_stock: 80.4, q_count_flow: 0 }], units: UNITS, conv: CONV,
    });
    expect(dims(out)).toEqual([['count_stock', 'Efetivo (cabeças)', 'q_count_stock', 'cabeças']]);
  });

  it('a group the per-UF rows do not carry is not offered (an all-zero map says nothing)', () => {
    const out = window.geoDimensions({
      families: ['count'], countGroups: groupsOf(BOVINO, OVOS),
      rows: [{ uf: 'MT', value: 900, q_count_stock: 0, q_count_flow: 3803.2 }], units: UNITS, conv: CONV,
    });
    expect(out.dims.map((d) => d.id)).toEqual(['value', 'count_flow']);
  });

  it('a group that counts different things gets no metric, and comes back as refused', () => {
    const out = window.geoDimensions({
      families: ['count'], countGroups: groupsOf(OVOS, ABACAXI),
      rows: [{ uf: 'PA', value: 10, q_count_flow: 50 }], units: UNITS, conv: CONV,
    });
    expect(out.dims.map((d) => d.id)).toEqual(['value']);
    expect(out.refused.map((g) => [g.id, g.plurals])).toEqual([['count_flow', ['ovos', 'frutos']]]);
  });

  it('the count unit follows the convention, by the thing counted', () => {
    const out = window.geoDimensions({
      families: ['count'], countGroups: groupsOf(BOVINO, OVOS), rows: [MT],
      units: { ...UNITS, count: { mul: 1e-3 } }, conv: { units: { count: 'dz' } },
    });
    const flow = out.dims.find((d) => d.id === 'count_flow');
    expect([flow.unit, flow.mul]).toEqual(['dz', 1e-3]);
    expect(flow.group.noun).toBe('ovos');
  });

  it('count groups are read only when the basket has the count family', () => {
    const out = window.geoDimensions({
      families: ['mass'], countGroups: groupsOf(BOVINO), rows: [{ uf: 'MT', value: 1, q_mass: 2, q_count_stock: 5 }],
      units: UNITS, conv: CONV,
    });
    expect(out.dims.map((d) => d.id)).toEqual(['value', 'mass']);
    expect(out.refused).toEqual([]);
  });
});

describe('geoDimensions — mass, volume and the fallback', () => {
  it('a quantity family in the basket whose rows carry nothing is flagged, not drawn', () => {
    const out = window.geoDimensions({
      families: ['mass', 'volume'], countGroups: [], rows: [{ uf: 'PA', value: 10, q_mass: 3, q_vol: 0 }],
      units: UNITS, conv: CONV,
    });
    expect(out.dims.map((d) => d.id)).toEqual(['value', 'mass']);
    expect([out.massUnavail, out.volUnavail]).toEqual([false, true]);
  });

  it('with nothing to draw the map still has Valor, never an empty list', () => {
    const out = window.geoDimensions({
      families: ['count'], countGroups: groupsOf(BOVINO), rows: [], units: UNITS, conv: CONV,
    });
    expect(dims(out)).toEqual([['value', 'Valor', 'value', 'R$ mi']]);
    expect(out.dims[0].available).toBe(true);
  });
});
