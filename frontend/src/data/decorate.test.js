// decorate.test.js — the registry joins the /api/snapshot deliberately omits.
// Pure function; we stub the UI registries on window and assert the merge,
// including the "API value wins, registry fills the gap" precedence.

import { beforeEach, describe, expect, it } from 'vitest';

import { decorateSnapshot, isCanonicalUf } from './decorate.js';

describe('decorateSnapshot', () => {
  beforeEach(() => {
    // UF_DATA registry stores the canonical region CODE ('N'); REGIONS carries the
    // code id + its pt-BR display label so the normalizer can map a name → code.
    window.UF_DATA = [{ uf: 'PA', col: 7, row: 2, region: 'N', name: 'Pará' }];
    window.QUALITY_FLAGS = [{ id: 'OK', label: 'Sem ressalvas', color: 'var(--ok)' }];
    window.REGIONS = [
      { id: 'N', label: 'Norte' },
      { id: 'NE', label: 'Nordeste' },
      { id: 'CO', label: 'Centro-Oeste' },
      { id: 'SE', label: 'Sudeste' },
      { id: 'S', label: 'Sul' },
    ];
  });

  it('joins UF tile coords + region/name from the registry', () => {
    const out = decorateSnapshot({ ufData: [{ uf: 'PA', value: 1.5 }] });
    expect(out.ufData[0]).toMatchObject({
      uf: 'PA',
      value: 1.5,
      col: 7,
      row: 2,
      region: 'N', // canonical region CODE from the registry (no API region supplied)
      name: 'Pará',
    });
  });

  it('keeps values the API already provided, fills only the gaps', () => {
    // A valid region CODE from the API wins; col is kept verbatim (?? keeps 99);
    // a missing name is filled from the registry.
    const out = decorateSnapshot({ ufData: [{ uf: 'PA', value: 1, col: 99, region: 'NE' }] });
    expect(out.ufData[0].col).toBe(99); // API col wins (?? keeps 99)
    expect(out.ufData[0].region).toBe('NE'); // API region is a valid code → kept
    expect(out.ufData[0].name).toBe('Pará'); // missing → filled from the registry
  });

  it('joins quality flag label + color, falling back when the id is unknown', () => {
    const out = decorateSnapshot({ quality: [{ id: 'OK', count: 5 }, { id: 'WEIRD', count: 1 }] });
    expect(out.quality[0]).toMatchObject({ label: 'Sem ressalvas', color: 'var(--ok)' });
    expect(out.quality[1].label).toBe('WEIRD'); // unknown id, no server label → id as its own label
    expect(out.quality[1].color).toBe('var(--pres-gray-400)'); // fallback color
  });

  it('prefers the SERVER-supplied pt-BR label over the raw id for a registry-absent flag', () => {
    // serializers._FLAG_LABEL_PT emits a label for flags the client registry may
    // lack (e.g. INCOMPLETE/MISSING_WEIGHT). decorate must use it, not leak the id.
    const out = decorateSnapshot({ quality: [{ id: 'INCOMPLETE', count: 2, label: 'Sem valor nem quantidade' }] });
    expect(out.quality[0].label).toBe('Sem valor nem quantidade'); // server label wins over q.id
    expect(out.quality[0].color).toBe('var(--pres-gray-400)'); // still gets the fallback color
  });

  it('defaults regions and is null/empty-safe', () => {
    expect(decorateSnapshot(null)).toBe(null);
    const out = decorateSnapshot({});
    expect(out.regions).toEqual(window.REGIONS); // passthrough of the registry
    expect(out.ufData).toBeUndefined(); // no ufData key → left untouched
  });

  it('decorates in place (same object ref) and leaves empty arrays untouched', () => {
    const snap = { ufData: [], quality: [] };
    const out = decorateSnapshot(snap);
    expect(out).toBe(snap); // in-place contract — the views hold this same ref
    expect(out.ufData).toEqual([]); // empty arrays skip the map, stay []
    expect(out.quality).toEqual([]);
  });
});

describe('decorateUfRows — region normalized to the canonical CODE (M7)', () => {
  beforeEach(() => {
    window.UF_DATA = [
      { uf: 'PA', col: 7, row: 2, region: 'N', name: 'Pará' },
      { uf: 'BA', col: 5, row: 3, region: 'NE', name: 'Bahia' },
      { uf: 'SP', col: 4, row: 6, region: 'SE', name: 'São Paulo' },
    ];
    window.QUALITY_FLAGS = [];
    window.REGIONS = [
      { id: 'N', label: 'Norte' },
      { id: 'NE', label: 'Nordeste' },
      { id: 'CO', label: 'Centro-Oeste' },
      { id: 'SE', label: 'Sudeste' },
      { id: 'S', label: 'Sul' },
    ];
  });

  it('maps an API display NAME ("Norte") to its 2-letter code so RegionBars matches', () => {
    const out = decorateSnapshot({ ufData: [{ uf: 'PA', value: 1, region: 'Norte' }] });
    expect(out.ufData[0].region).toBe('N'); // not the verbatim "Norte"
  });

  it('keeps an API value that is already a valid code', () => {
    const out = decorateSnapshot({ ufData: [{ uf: 'BA', value: 1, region: 'NE' }] });
    expect(out.ufData[0].region).toBe('NE');
  });

  it('falls back to the registry code when the API region is unknown/absent', () => {
    // Unknown string → registry code (SP → SE), not the bogus verbatim value.
    const unknown = decorateSnapshot({ ufData: [{ uf: 'SP', value: 1, region: 'Sudeste/SP' }] });
    expect(unknown.ufData[0].region).toBe('SE');
    // Absent region → registry code.
    const absent = decorateSnapshot({ ufData: [{ uf: 'PA', value: 1 }] });
    expect(absent.ufData[0].region).toBe('N');
  });

  it('produces rows whose region matches the REGIONS ids (the RegionBars group key)', () => {
    // The downstream regionData groups ufData by `region === r.id`; every decorated
    // row must therefore carry a value present in the REGIONS id set.
    const codes = new Set(window.REGIONS.map((r) => r.id));
    const out = decorateSnapshot({
      ufData: [
        { uf: 'PA', value: 1, region: 'Norte' }, // display name
        { uf: 'BA', value: 2, region: 'NE' }, // already a code
        { uf: 'SP', value: 3 }, // absent
      ],
    });
    out.ufData.forEach((r) => expect(codes.has(r.region)).toBe(true));
  });
});

describe('isCanonicalUf (FINDING #4)', () => {
  beforeEach(() => {
    window.UF_DATA = [
      { uf: 'PA', name: 'Pará' },
      { uf: 'SP', name: 'São Paulo' },
    ];
  });

  it('accepts a registered Brazilian UF and rejects COMEX trade pseudo-codes', () => {
    expect(isCanonicalUf('PA')).toBe(true);
    expect(isCanonicalUf('SP')).toBe(true);
    // ND/EX/ZN/CB/RE/MC… are trade-origin pseudo-codes, NOT states — they must
    // not count toward the "UFs cobertas / 27" tally.
    expect(isCanonicalUf('ND')).toBe(false);
    expect(isCanonicalUf('EX')).toBe(false);
    expect(isCanonicalUf('ZN')).toBe(false);
  });

  it('is null/empty-safe and exposed on window for the reused views', () => {
    expect(isCanonicalUf(null)).toBe(false);
    expect(isCanonicalUf('')).toBe(false);
    expect(window.isCanonicalUf).toBe(isCanonicalUf);
  });
});
