// glossary.cov.test.js — coverage for glossary.js, the pt-BR per-banco glossary
// data structure. glossary.js is a side-effect module: importing it registers
// window.GLOSSARY and (if a window.auditBancoCoverage hook is present) runs a
// coverage lint. We assert the structure has every expected banco section + the
// thematic groups, that each term carries the documented shape, and we exercise
// BOTH branches of the auditBancoCoverage coverage-lint hook.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let GLOSSARY;

// Sections that must always be present (per the bancos in bancos.js + the
// cross-cutting thematic groups authored at the bottom of glossary.js).
const BANCO_SECTIONS = ['ibge_pevs', 'ibge_pam', 'ibge_ppm', 'mdic_comex', 'un_comtrade', 'sefaz_nf'];
const THEMATIC_SECTIONS = ['cross_analysis', 'metodos'];

describe('GLOSSARY structure', () => {
  beforeEach(async () => {
    // No auditBancoCoverage hook → the coverage-lint block is skipped (false branch).
    delete window.auditBancoCoverage;
    vi.resetModules();
    await import('./glossary.js');
    GLOSSARY = window.GLOSSARY;
  });

  afterEach(() => {
    delete window.auditBancoCoverage;
  });

  it('registers a non-empty object on window.GLOSSARY', () => {
    expect(GLOSSARY).toBeTruthy();
    expect(typeof GLOSSARY).toBe('object');
    expect(Object.keys(GLOSSARY).length).toBeGreaterThan(0);
  });

  it('has every banco section, each with label/sub/terms', () => {
    for (const id of BANCO_SECTIONS) {
      const section = GLOSSARY[id];
      expect(section, `missing section ${id}`).toBeTruthy();
      expect(typeof section.label).toBe('string');
      expect(section.label.length).toBeGreaterThan(0);
      expect(typeof section.sub).toBe('string');
      expect(Array.isArray(section.terms)).toBe(true);
      expect(section.terms.length).toBeGreaterThan(0);
    }
  });

  it('has the cross-cutting thematic groups (análise cruzada + métodos)', () => {
    for (const id of THEMATIC_SECTIONS) {
      expect(GLOSSARY[id]).toBeTruthy();
      expect(GLOSSARY[id].kind).toBe('tema');
      expect(Array.isArray(GLOSSARY[id].terms)).toBe(true);
    }
  });

  it('includes the Engenharia de atributos section (unfrozen): industrialization editable + market-nature seed', () => {
    expect(GLOSSARY.curadoria).toBeDefined();
    expect(GLOSSARY.curadoria.label).toBe('Engenharia de atributos');
    const terms = GLOSSARY.curadoria.terms.map((t) => t.term);
    expect(terms).toContain('Nível de industrialização');
    expect(terms).toContain('Finalidade econômica (tipo de mercado)');
  });

  it('marks SEFAZ NFe as pending (not yet ingested)', () => {
    expect(GLOSSARY.sefaz_nf.pending).toBe(true);
  });

  it('every term carries a non-empty `term` and `short`', () => {
    for (const [id, section] of Object.entries(GLOSSARY)) {
      for (const t of section.terms) {
        expect(typeof t.term, `${id} term name`).toBe('string');
        expect(t.term.length).toBeGreaterThan(0);
        expect(typeof t.short, `${id}/${t.term} short`).toBe('string');
        expect(t.short.length).toBeGreaterThan(0);
        // optional fields, when present, are strings
        if ('tag' in t) expect(typeof t.tag).toBe('string');
        if ('cat' in t) expect(typeof t.cat).toBe('string');
      }
    }
  });

  it('documents the data_quality_flag column for each live banco', () => {
    // The 5 ingested bancos each define a data_quality_flag term; SEFAZ (pending)
    // is the only one without (its Gold table is still planned).
    const liveBancos = ['ibge_pevs', 'ibge_pam', 'ibge_ppm', 'mdic_comex', 'un_comtrade'];
    for (const id of liveBancos) {
      const terms = GLOSSARY[id].terms.map((t) => t.term);
      expect(terms, `${id} should define data_quality_flag`).toContain('data_quality_flag');
    }
  });

  it('keeps data_quality_flag short and points to the legend instead of copying it', () => {
    // Until v1.92.2 each banco carried a 183–235-word copy of the whole legend, and the copy
    // drifted: the legend was corrected in v1.89.0 and the glossary kept calling an outlier
    // "em geral um gigante de verdade". The legend in data.js is the one place the flags are
    // explained; the glossary says what the column is and where to read more.
    const entries = Object.values(GLOSSARY).flatMap((s) => s.terms)
      .filter((t) => t.term === 'data_quality_flag');
    expect(entries).toHaveLength(5);
    for (const t of entries) {
      expect(t.short.split(/\s+/).length, t.short).toBeLessThanOrEqual(110);
      expect(t.short).toContain('Qualidade dos dados');
      expect(t.short).not.toMatch(/—|gigante/);
    }
  });

  it('says an old nominal value looks SMALLER without correction, not larger', () => {
    // The entry said the opposite until v1.92.2. Prices rose, so a 1990 value in the money of
    // its day understates what it was worth.
    const t = GLOSSARY.metodos.terms.find((x) => x.term === 'Deflacionar');
    expect(t.short).toContain('parece muito menor');
    expect(t.short).not.toContain('parece muito maior');
  });

  it('names the per-banco Gold table in each banco section', () => {
    const expectedTable = {
      ibge_pevs: 'gold_pevs_production',
      ibge_pam: 'gold_pam_production',
      ibge_ppm: 'gold_ppm_production',
      mdic_comex: 'gold_comex_flows',
      un_comtrade: 'gold_comtrade_flows',
      sefaz_nf: 'gold_nfe_flows',
    };
    for (const [id, table] of Object.entries(expectedTable)) {
      const terms = GLOSSARY[id].terms.map((t) => t.term);
      expect(terms, `${id} should reference ${table}`).toContain(table);
    }
  });

  it('métodos group glosses the statistical concepts used in perspective names', () => {
    const terms = GLOSSARY.metodos.terms.map((t) => t.term);
    expect(terms).toContain('Índice de Gini');
    expect(terms).toContain('CAGR');
    expect(terms).toContain('HHI (Herfindahl-Hirschman)');
  });
});

// ── auditBancoCoverage hook — exercise both code paths of the trailing lint ───
describe('glossary.js coverage-lint hook (auditBancoCoverage)', () => {
  afterEach(() => {
    delete window.auditBancoCoverage;
    vi.restoreAllMocks();
  });

  it('invokes window.auditBancoCoverage when present, with a working predicate', async () => {
    const calls = [];
    window.auditBancoCoverage = (label, predicate) => {
      calls.push({ label, predicate });
    };
    vi.resetModules();
    await import('./glossary.js');

    expect(calls).toHaveLength(1);
    expect(calls[0].label).toContain('glossário');
    // The predicate returns true for a banco that HAS a section, false otherwise.
    expect(calls[0].predicate({ id: 'ibge_pevs' })).toBe(true);
    expect(calls[0].predicate({ id: 'banco_inexistente' })).toBe(false);
  });

  it('does not throw when the hook is absent (false branch of the guard)', async () => {
    delete window.auditBancoCoverage;
    vi.resetModules();
    await expect(import('./glossary.js')).resolves.toBeDefined();
    expect(window.GLOSSARY).toBeTruthy();
  });
});
