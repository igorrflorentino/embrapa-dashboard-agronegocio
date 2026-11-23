// countUnits.test.js — what a count counts, and which counts may be added together.
//
// The defect this module closes (v1.108.0): the Geografia map read ONE count total and
// called it "Quantidade (cabeças)". On the PPM that total was the herd's heads PLUS a
// year's eggs — Mato Grosso 2025 showed 3,88 bi, of which 3,80 bi were eggs (measured on
// prod 2026-11-18). The rules pinned here:
//   - the herd (stock) and a counted production (flow) are two groups, never one;
//   - each group is named by what it counts, read from the unit the SOURCE publishes;
//   - a group whose products count different things — or something unknown — is REFUSED
//     (no label, no unit), so no screen can draw it;
//   - every count unit the dbt seeds can produce has a name here, and nothing else does.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import './data.js';        // the real UNIT_FAMILIES: the count units a convention may pick
import './countUnits.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SEEDS = resolve(AQUI, '../../../dbt/seeds');

// A minimal CSV reader for the seeds: quoted fields may hold commas and doubled quotes
// (pam_count_unit_products' `reason`).
function readSeed(name) {
  const text = readFileSync(resolve(SEEDS, name), 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}

// The normalization countUnits.js applies (case, accents, spacing): the test states it
// independently, so a change to the module's rule shows up here as a failing key.
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// Count products as the API serves them: the unit_native of each is the one measured on
// prod 2026-11-18 (PPM herds "Cabeças", eggs "Mil dúzias"; PAM "Mil frutos"); the codes of
// the herd species and of milk are illustrative.
const BOVINO = { code: '2670', name: 'Bovino', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
const SUINO = { code: '2675', name: 'Suíno - total', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
const OVOS = { code: '2685', name: 'Ovos de galinha', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
const CODORNA = { code: '2686', name: 'Ovos de codorna', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
const LEITE = { code: '2682', name: 'Leite', family: 'volume', measure_kind: 'flow', unit_native: 'Mil litros' };
// PAM: no measure_kind at all — a count there is a production, as the server reads it.
const ABACAXI = { code: '40092', name: 'Abacaxi*', family: 'count', unit_native: 'Mil frutos' };
const COCO = { code: '40145', name: 'Coco-da-baía*', family: 'count', unit_native: 'Mil frutos' };

const codes = (...ps) => ps.map((p) => p.code);

describe('countNounOf — what a product counts, from the unit its source publishes', () => {
  it('names the thing the unit names, whatever the case, accents and spacing', () => {
    expect(window.countNounOf(BOVINO)).toBe('cabecas');
    expect(window.countNounOf(OVOS)).toBe('ovos');
    expect(window.countNounOf(ABACAXI)).toBe('frutos');
    expect(window.countNounOf({ unit_native: ' MIL  Árvores ' })).toBe('arvores');
    expect(window.countNounOf({ unit_native: 'NUMERO (UNIDADE)' })).toBe('unidades');
    expect(window.countNounOf({ unit_native: 'Número de itens' })).toBe('unidades');
  });

  it('an unknown or absent unit names nothing — and nothing unknown is ever added', () => {
    expect(window.countNounOf({ unit_native: 'Toneladas' })).toBeNull();
    expect(window.countNounOf({ unit_native: '' })).toBeNull();
    expect(window.countNounOf({})).toBeNull();
    expect(window.countNounOf(null)).toBeNull();
  });
});

describe('COUNT_UNIT_NOUN — every count unit the seeds can produce, and nothing else', () => {
  // The four places a product's quantity becomes a 'contagem' in the pipeline.
  const conversions = readSeed('unit_family_conversions.csv');
  const countRaw = new Set(conversions.filter((r) => r.family === 'contagem').map((r) => r.unit_raw));
  // IBGE (and COMEX, through lower(trim(unit_name))): the conversion table itself.
  const fromConversions = [...countRaw];
  // PAM: the products IBGE counts while SIDRA labels them "Toneladas".
  const fromPam = readSeed('pam_count_unit_products.csv').map((r) => r.unit_label);
  // COMEX: unit_native is comex_unit.unit_name; it is a count when its lower(trim) is one.
  const fromComex = readSeed('comex_unit.csv').map((r) => r.unit_name)
    .filter((n) => countRaw.has(n.trim().toLowerCase()));
  // COMTRADE: unit_native is comtrade_unit.unit_name; the family comes from its unit_raw.
  const fromComtrade = readSeed('comtrade_unit.csv')
    .filter((r) => r.unit_raw && countRaw.has(r.unit_raw)).map((r) => r.unit_name);

  it('reads every source (a parser or filter that found nothing would prove nothing)', () => {
    expect(fromConversions).toEqual(expect.arrayContaining(['cabeças', 'mil dúzias', 'mil árvores']));
    expect(fromPam).toEqual(['Mil frutos', 'Mil frutos']);
    expect(fromComex.sort()).toEqual(['DUZIA', 'MILHEIRO', 'NUMERO (UNIDADE)', 'PARES']);
    expect(fromComtrade).toEqual(['Número de itens']);
  });

  it('names what every one of them counts', () => {
    const all = [...fromConversions, ...fromPam, ...fromComex, ...fromComtrade];
    const nameless = all.filter((u) => !(norm(u) in window.COUNT_UNIT_NOUN));
    expect(nameless).toEqual([]);
  });

  it('holds no unit that no seed produces (an invented key would name nothing real)', () => {
    const produced = new Set([...fromConversions, ...fromPam, ...fromComex, ...fromComtrade].map(norm));
    const stale = Object.keys(window.COUNT_UNIT_NOUN).filter((k) => !produced.has(k));
    expect(stale).toEqual([]);
  });

  it('the units that name a thing give that thing; the ones that only count give "unidades"', () => {
    const noun = (u) => window.COUNT_UNIT_NOUN[norm(u)];
    expect(['Cabeças', 'cabeça'].map(noun)).toEqual(['cabecas', 'cabecas']);
    expect(noun('Mil dúzias')).toBe('ovos');
    expect(noun('Mil frutos')).toBe('frutos');
    expect(noun('Mil árvores')).toBe('arvores');
    expect(['un', 'dúzia', 'milheiro', 'pares', 'NUMERO (UNIDADE)', 'Número de itens'].map(noun))
      .toEqual(Array(6).fill('unidades'));
  });

  it('every noun has its plural, and its singular for a price ("R$ por ovo")', () => {
    const nouns = new Set(Object.values(window.COUNT_UNIT_NOUN));
    for (const n of nouns) {
      expect(window.COUNT_NOUNS[n].plural).toMatch(/\S/);
      expect(window.COUNT_NOUNS[n].singular).toMatch(/\S/);
    }
  });
});

// ── One product alone (v1.108.7) ─────────────────────────────────────────────────────────
// The per-product screens (Perfil do produto, Rebanho, Comparativo entre produtos) and the
// per-product CSV wrote the convention's count unit beside a single product: "un" beside a
// herd, the eggs and the pineapples alike, and the CSV's `unidade` column said "un" for all
// of them. A product counts one thing, so no figure added different things — only the name
// was missing. These are the names they read now.
describe('countNameOf — what ONE product counts, in words', () => {
  it('the thing the source unit names, plural by default and singular for a rate', () => {
    expect([BOVINO, OVOS, ABACAXI].map((p) => window.countNameOf(p))).toEqual(['cabeças', 'ovos', 'frutos']);
    expect([BOVINO, OVOS, ABACAXI].map((p) => window.countNameOf(p, { singular: true })))
      .toEqual(['cabeça', 'ovo', 'fruto']);
    expect(window.countNameOf({ unit_native: 'NUMERO (UNIDADE)' })).toBe('unidades');
  });

  it('an unknown or absent unit is said, the same words the refused-total note uses', () => {
    for (const p of [{ unit_native: 'Caixas' }, { unit_native: '' }, {}, null]) {
      expect(window.countNameOf(p)).toBe('unidade não identificada');
      expect(window.countNameOf(p, { singular: true })).toBe('unidade não identificada');
    }
    const [g] = window.countGroups([{ code: 'X', family: 'count', unit_native: 'Caixas' }], ['X']);
    expect(g.plurals).toEqual([window.COUNT_UNKNOWN]);
  });
});

describe('countProductUnit — the unit ONE count product is shown in', () => {
  const conv = (unit) => ({ units: { count: unit } });
  afterEach(() => { delete window.unitOf; });
  const withConventions = () => { window.unitOf = (c, fam) => c.units[fam]; };

  it('a unit worth one of the thing is named by the thing, whichever the convention picked', () => {
    withConventions();
    for (const u of ['un', 'cab']) {
      expect([BOVINO, OVOS, ABACAXI].map((p) => window.countProductUnit(p, conv(u))))
        .toEqual(['cabeças', 'ovos', 'frutos']);
    }
    expect(window.countProductUnit(OVOS, conv('un'), { singular: true })).toBe('ovo');
  });

  it('with no convention to read, the thing itself', () => {
    expect(window.countProductUnit(ABACAXI, undefined)).toBe('frutos');
  });

  it('a multiple the researcher picked keeps its own label, as a total does', () => {
    withConventions();
    expect(window.countProductUnit(OVOS, conv('dz'))).toBe('dz');
    expect(window.countProductUnit(OVOS, conv('dz'), { singular: true })).toBe('dz');
    expect(window.countProductUnit(BOVINO, conv('milheiro'))).toBe('milheiro');
    const [eggs] = window.countGroups([OVOS], codes(OVOS));
    expect(window.countProductUnit(OVOS, conv('dz'))).toBe(window.countGroupUnit(eggs, conv('dz')));
  });

  it('an unknown unit says so in every convention — never "un", never "cab"', () => {
    withConventions();
    const X = { code: 'X', family: 'count' };
    expect(window.countProductUnit(X, conv('un'))).toBe('unidade não identificada');
    expect(window.countProductUnit(X, conv('cab'))).toBe('unidade não identificada');
    expect(window.countProductUnit(X, conv('un'), { singular: true })).toBe('unidade não identificada');
    // The number is still in dozens, so the multiple stays beside what is not known.
    expect(window.countProductUnit(X, conv('dz'))).toBe('dz (unidade não identificada)');
  });
});

describe('countGroups — the herd and the counted production, each named by what it counts', () => {
  it('the PPM herd and its eggs are two groups, never one', () => {
    const groups = window.countGroups([BOVINO, SUINO, OVOS, CODORNA, LEITE], codes(BOVINO, SUINO, OVOS, CODORNA, LEITE));
    expect(groups.map((g) => [g.id, g.total, g.key, g.noun, g.label, g.mixed])).toEqual([
      ['count_stock', 'stock', 'q_count_stock', 'cabecas', 'Efetivo (cabeças)', false],
      ['count_flow', 'flow', 'q_count_flow', 'ovos', 'Quantidade (ovos)', false],
    ]);
    // Heads of different species are one unit; hen and quail eggs too. Milk is no count.
    expect(groups.map((g) => g.products.map((p) => p.code))).toEqual([['2670', '2675'], ['2685', '2686']]);
  });

  it('only the basket counts: a product outside it is in no group', () => {
    const groups = window.countGroups([BOVINO, OVOS], codes(OVOS));
    expect(groups.map((g) => g.id)).toEqual(['count_flow']);
  });

  it('a count with no measure_kind is a production, as the server reads it (PAM fruits)', () => {
    const [g] = window.countGroups([ABACAXI, COCO], codes(ABACAXI, COCO));
    expect([g.id, g.label, g.mixed]).toEqual(['count_flow', 'Quantidade (frutos)', false]);
  });

  it('a total whose products count different things is refused: no noun, no label', () => {
    // No banco holds eggs and counted fruits together today; the server's flow total
    // would add them, so the rule is what keeps a future basket from drawing it.
    const [g] = window.countGroups([OVOS, ABACAXI], codes(OVOS, ABACAXI));
    expect([g.id, g.mixed, g.noun, g.plural, g.label]).toEqual(['count_flow', true, null, null, null]);
    expect(g.plurals).toEqual(['ovos', 'frutos']);
    expect(g.products.map((p) => p.code)).toEqual(['2685', '40092']);
  });

  it('a count in a unit nobody named is refused too, and says so', () => {
    const [g] = window.countGroups([{ code: 'X', family: 'count', unit_native: 'Caixas' }], ['X']);
    expect([g.mixed, g.label]).toEqual([true, null]);
    expect(g.plurals).toEqual(['unidade não identificada']);
  });

  it('a basket that counts nothing has no group', () => {
    expect(window.countGroups([BOVINO, LEITE], codes(LEITE))).toEqual([]);
    expect(window.countGroups([], [])).toEqual([]);
    expect(window.countGroups(undefined, undefined)).toEqual([]);
  });
});

describe('countGroupUnit — the unit a group is shown in', () => {
  const herd = () => window.countGroups([BOVINO], codes(BOVINO))[0];
  const eggs = () => window.countGroups([OVOS], codes(OVOS))[0];
  const conv = (unit) => ({ units: { count: unit } });
  afterEach(() => { delete window.unitOf; });

  it('a unit worth ONE of the thing is named by the thing: eggs never read "cab", a herd never "un"', () => {
    window.unitOf = (c, fam) => c.units[fam];
    expect(window.countGroupUnit(eggs(), conv('cab'))).toBe('ovos');
    expect(window.countGroupUnit(eggs(), conv('un'))).toBe('ovos');
    expect(window.countGroupUnit(herd(), conv('un'))).toBe('cabeças');
    expect(window.countGroupUnit(herd(), conv('cab'))).toBe('cabeças');
  });

  it('a multiple the researcher picked keeps its own label', () => {
    window.unitOf = (c, fam) => c.units[fam];
    expect(window.countGroupUnit(eggs(), conv('dz'))).toBe('dz');
    expect(window.countGroupUnit(herd(), conv('milheiro'))).toBe('milheiro');
  });

  it('with no convention to read, the thing itself', () => {
    expect(window.countGroupUnit(eggs(), undefined)).toBe('ovos');
  });
});

describe('countGroupWithData, hasCount, countColumn', () => {
  const groups = () => window.countGroups([BOVINO, OVOS], codes(BOVINO, OVOS));

  it('the group a single-measure reading draws: the herd first, if it has data', () => {
    const rows = [{ q_count_stock: 80.4, q_count_flow: 3803.2 }];
    expect(window.countGroupWithData(groups(), rows).id).toBe('count_stock');
    expect(window.countGroupWithData(groups(), [{ q_count_stock: 0, q_count_flow: 5 }]).id).toBe('count_flow');
    expect(window.countGroupWithData(groups(), [{ q_count_stock: 0 }])).toBeNull();
  });

  it('never a refused group, even with data', () => {
    const mixed = window.countGroups([OVOS, ABACAXI], codes(OVOS, ABACAXI));
    expect(window.countGroupWithData(mixed, [{ q_count_flow: 10 }])).toBeNull();
  });

  it('hasCount is a presence test over either total', () => {
    expect(window.hasCount({ q_count_stock: 1 })).toBe(true);
    expect(window.hasCount({ q_count_flow: 1 })).toBe(true);
    expect(window.hasCount({ q_count_stock: 0, q_count_flow: 0 })).toBe(false);
    expect(window.hasCount({})).toBe(false);
  });

  it('the CSV column is named by the total and what it counts', () => {
    expect(groups().map(window.countColumn)).toEqual(['efetivo_cabecas', 'qtd_ovos']);
    const [fruits] = window.countGroups([ABACAXI], codes(ABACAXI));
    expect(window.countColumn(fruits)).toBe('qtd_frutos');
  });
});
