// urlState.test.js — the shared deep-link codec contract (urlState.js). Pins the
// encode/decode round-trip so a share/cite link reproduces the exact panel state.
// Regression guard for the RVC-1 audit finding (the v1.5.2 sub-UF/município geo
// dims were silently dropped from share links) and the urlDecodeNum NaN guard.

import { describe, expect, it } from 'vitest';

import './urlState.js';
import './territoryCompare.js';

describe('urlState — array codec', () => {
  it('encodes null→"" (all), []→"-" (explicit none), subset→csv', () => {
    expect(window.urlEncodeArr(null)).toBe('');
    expect(window.urlEncodeArr([])).toBe('-');
    expect(window.urlEncodeArr(['a', 'b'])).toBe('a,b');
  });

  it('decodes absent/""→null, "-"→[], csv→array', () => {
    const q = new URLSearchParams('x=-&y=a,b');
    expect(window.urlDecodeArr(q, 'missing')).toBe(null);
    expect(window.urlDecodeArr(q, 'x')).toEqual([]);
    expect(window.urlDecodeArr(q, 'y')).toEqual(['a', 'b']);
  });

  it('round-trips null / [] / subset through encode→parse→decode', () => {
    for (const original of [null, [], ['3101', '3102']]) {
      const qs = `g=${window.urlEncodeArr(original)}`;
      const q = new URLSearchParams(qs);
      expect(window.urlDecodeArr(q, 'g')).toEqual(original);
    }
  });
});

describe('urlState — numeric codec (NaN guard)', () => {
  it('absent/"" → null, finite → Number, garbage → null (no NaN leak)', () => {
    const q = new URLSearchParams('a=42&b=abc&c=');
    expect(window.urlDecodeNum(q, 'missing')).toBe(null);
    expect(window.urlDecodeNum(q, 'a')).toBe(42);
    expect(window.urlDecodeNum(q, 'c')).toBe(null);
    // The whole point: a hand-edited junk value must NOT become NaN.
    expect(window.urlDecodeNum(q, 'b')).toBe(null);
  });
});

describe('urlState — COMTRADE país reporter/parceiro (rp/pt)', () => {
  it('URL_STATE_KEYS carries rp + pt', () => {
    expect(window.URL_STATE_KEYS).toContain('rp');
    expect(window.URL_STATE_KEYS).toContain('pt');
  });

  it('encodes reporter 3-state: Brasil/absent → "", world → "ALL", subset → csv', () => {
    const enc = (reporters) => window.buildUrlState({ summary: { reporters } }).rp;
    expect(enc(undefined)).toBe(''); // Brazil default → dropped
    expect(enc('__all__')).toBe('ALL'); // world sentinel (distinct from the "-" empty)
    expect(enc(['BRA', 'CHN'])).toBe('BRA,CHN');
  });

  it('encodes partner as the standard array (null → "" all, subset → csv)', () => {
    const enc = (partners) => window.buildUrlState({ summary: { partners } }).pt;
    expect(enc(null)).toBe('');
    expect(enc(['CHN', 'USA'])).toBe('CHN,USA');
  });
});

describe('urlState — own-state gate + key registry', () => {
  it('URL_STATE_KEYS carries the v1.5.2 sub-UF geography keys', () => {
    for (const k of ['me', 'mc', 'it', 'im', 'mn']) {
      expect(window.URL_STATE_KEYS).toContain(k);
    }
  });

  it('urlHasOwnState detects our keys and ignores foreign ones', () => {
    expect(window.urlHasOwnState(new URLSearchParams('t=123'))).toBe(false);
    expect(window.urlHasOwnState(new URLSearchParams('mn=3550308'))).toBe(true);
    expect(window.urlHasOwnState(new URLSearchParams('v=overview'))).toBe(true);
  });
});

describe('urlState — full geo share round-trip (RVC-1)', () => {
  it('a sub-UF/município narrowing survives encode→decode; "all" is omitted', () => {
    const summary = {
      mesos: ['3101'],
      micros: null, // all → must be dropped from the URL
      inters: ['3501'],
      imediatas: null,
      munis: ['3550308', '3304557'],
    };
    const state = {
      v: 'geografia',
      me: window.urlEncodeArr(summary.mesos),
      mc: window.urlEncodeArr(summary.micros),
      it: window.urlEncodeArr(summary.inters),
      im: window.urlEncodeArr(summary.imediatas),
      mn: window.urlEncodeArr(summary.munis),
    };
    const qs = window.urlEncodeState(state);
    // "all" (null) dims are dropped entirely — never serialize the full universe.
    expect(qs).not.toMatch(/(^|&)mc=/);
    expect(qs).not.toMatch(/(^|&)im=/);

    const q = new URLSearchParams(qs);
    expect(window.urlDecodeArr(q, 'me')).toEqual(['3101']);
    expect(window.urlDecodeArr(q, 'mc')).toBe(null);
    expect(window.urlDecodeArr(q, 'it')).toEqual(['3501']);
    expect(window.urlDecodeArr(q, 'im')).toBe(null);
    expect(window.urlDecodeArr(q, 'mn')).toEqual(['3550308', '3304557']);
  });
});

describe('urlState — a região viaja na URL (v1.93.7)', () => {
  // Without it, reloading or sharing "Brasil › Norte › Pará" came back as "Brasil › Pará":
  // the URL kept the state and lost the rung above it.
  const rg = (regions) => window.buildUrlState({ summary: { regions } }).rg;

  it('grava uma região escolhida', () => {
    expect(rg(['N'])).toBe('N');
    expect(window.URL_STATE_KEYS).toContain('rg');
  });

  it('não grava nada quando não há recorte de região', () => {
    expect(rg(null)).toBe('');
    expect(rg(undefined)).toBe('');
    expect(rg([])).toBe('');
    expect(rg(['N', 'NE', 'CO', 'SE', 'S'])).toBe('');  // todas = sem recorte
  });

  it('a região gravada volta pela mesma decodificação dos outros eixos', () => {
    const q = new URLSearchParams(window.urlEncodeState({ rg: rg(['N']), st: 'PA' }));
    expect(window.urlDecodeArr(q, 'rg')).toEqual(['N']);
    expect(window.urlDecodeArr(q, 'st')).toEqual(['PA']);
  });
});

describe('urlState — o comparativo entre territórios viaja na URL (v1.94.0)', () => {
  const tcState = (territoryCompare, view = 'territory_compare') =>
    window.buildUrlState({ view, summary: {}, territoryCompare });

  it('grava os lugares, a métrica e a escala', () => {
    const out = tcState({
      items: [{ level: 'regiao', code: 'N' }, { level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' }],
      metric: 'mass', mode: 'index',
    });
    expect(out.tc).toBe('R:N,U:PA,M:1501402');
    expect(out.tm).toBe('mass');
    expect(out.tx).toBe('index');
    expect(window.URL_STATE_KEYS).toEqual(expect.arrayContaining(['tc', 'tm', 'tx']));
  });

  it('os padrões não sujam a URL: valor e valores absolutos são o ponto de partida', () => {
    const out = tcState({ items: [{ level: 'uf', code: 'PA' }], metric: 'value', mode: 'abs' });
    expect([out.tm, out.tx]).toEqual(['', '']);
  });

  it('distingue "ainda não escolheu" de "esvaziou de propósito"', () => {
    // null → nada gravado, a tela mostra os 3 maiores. [] → '-', e a leitura devolve []:
    // recarregar mantém a tela vazia em vez de trazer o padrão de volta.
    expect(tcState({ items: null }).tc).toBe('');
    expect(tcState({ items: [] }).tc).toBe('-');
    expect(window.territoryCompare.decode('-')).toEqual([]);
  });

  it('só a tela do comparativo grava essas chaves', () => {
    const out = tcState({ items: [{ level: 'uf', code: 'PA' }], metric: 'mass', mode: 'index' }, 'geo');
    expect([out.tc, out.tm, out.tx]).toEqual(['', '', '']);
  });

  it('a seleção gravada volta igual', () => {
    const items = [{ level: 'uf', code: 'SP' }, { level: 'municipio', code: '3550308' }];
    const q = new URLSearchParams(window.urlEncodeState(tcState({ items })));
    expect(window.territoryCompare.decode(q.get('tc'))).toEqual(items);
  });
});
