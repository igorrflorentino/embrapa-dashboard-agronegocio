// choroplethScale.test.js — the pure classification logic behind EVERY territorial
// map (maplibre itself needs WebGL, so those are verified in the browser, not here).

import { describe, expect, it } from 'vitest';

import {
  NODATA, RAMP, escapeHtml, fillColorExpression, fmtMapValue, presentValue, quantileIndexer,
  quantileThresholds, rowsSignature, ufColorScaleQuantile,
} from './choroplethScale';

describe('quantileIndexer — the rule every map now shares', () => {
  it('spreads a concentrated series across all buckets where a linear split collapses it', () => {
    // The real PEVS 2024 per-UF valor: one dominant state and a long tail. A linear
    // (v-min)/(max-min) split put 21 of these 25 in the SAME lightest bucket.
    const vals = [2908, 1122, 386, 354, 242, 200, 145, 108, 99, 98, 97, 97, 86, 81,
                  65, 52, 51, 31, 26, 26, 11, 5, 3, 3, 1];
    const idx = quantileIndexer(vals, 7);
    const used = new Set(vals.map((v) => idx.indexOf(v)));
    expect(used.size).toBe(7);            // every bucket earns at least one UF
    expect(idx.indexOf(2908)).toBe(6);    // the maximum is darkest
    expect(idx.indexOf(1)).toBe(0);       // the minimum is lightest
  });

  it('reports -1 for non-positive / non-numeric values (absent ≠ smallest)', () => {
    const idx = quantileIndexer([10, 20, 0], 6);
    expect(idx.indexOf(0)).toBe(-1);
    expect(idx.indexOf(-5)).toBe(-1);
    expect(idx.indexOf(undefined)).toBe(-1);
    expect(idx.indexOf(NaN)).toBe(-1);
    expect(quantileIndexer([], 6).indexOf(1)).toBe(-1);
  });

  it('gives equal values the same bucket', () => {
    const idx = quantileIndexer([5, 5, 5, 100], 6);
    expect(idx.indexOf(5)).toBe(idx.indexOf(5));
    expect(idx.indexOf(100)).toBeGreaterThan(idx.indexOf(5));
  });

  it('puts a lone value in the DARKEST bucket, not the lightest', () => {
    // rank/n would put rank 0 of n=1 at position 0 — the lightest — for a value that
    // is at once the smallest and the largest. Reachable from the map's own
    // click-to-filter, which narrows the selection to a single UF.
    expect(quantileIndexer([2_900_000_000], 6).indexOf(2_900_000_000)).toBe(5);
  });

  it('agrees with the plain split exactly at n === bucketCount (no jump at the seam)', () => {
    const idx = quantileIndexer([1, 2, 3, 4, 5, 6], 6);
    expect([1, 2, 3, 4, 5, 6].map((v) => idx.indexOf(v))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('quantileThresholds describes each bucket and nulls the empty ones', () => {
    const idx = quantileIndexer([10, 20], 6);
    const t = quantileThresholds(idx, RAMP);
    expect(t.filter(Boolean)).toHaveLength(2); // 2 values → the top 2 buckets
    expect(t[0]).toBeNull();
    t.filter(Boolean).forEach((b) => expect(b.min).toBeLessThanOrEqual(b.max));
  });
});

describe('ufColorScaleQuantile (MAPA-3: spreads a concentrated distribution across every bucket)', () => {
  it('uses every ramp bucket for a concentrated distribution the linear scale collapses', () => {
    // Mirrors the measured PEVS 2024 shape: one dominant state, a long tail of
    // much smaller ones. The linear scale puts all but the top 2 in bucket 0.
    const rows = [
      { uf: 'PA', v: 2908 }, { uf: 'MT', v: 1122 }, { uf: 'MA', v: 386 }, { uf: 'AM', v: 354 },
      { uf: 'RO', v: 242 }, { uf: 'CE', v: 200 }, { uf: 'BA', v: 145 }, { uf: 'AC', v: 108 },
      { uf: 'SC', v: 99 }, { uf: 'PE', v: 98 }, { uf: 'PI', v: 97 }, { uf: 'PR', v: 51 },
      { uf: 'SP', v: 0 }, { uf: 'RJ', v: 0 },
    ];
    const { byUf, thresholds } = ufColorScaleQuantile(rows, 'v');
    const usedBuckets = new Set(Object.values(byUf).filter((c) => c !== NODATA));
    expect(usedBuckets.size).toBe(RAMP.length); // every bucket gets at least one UF
    expect(byUf.PA).toBe(RAMP[RAMP.length - 1]); // the maximum still lands darkest
    expect(byUf.SP).toBe(NODATA);
    expect(byUf.RJ).toBe(NODATA);
    // Every non-empty threshold's min/max come from UFs actually assigned that color.
    thresholds.filter(Boolean).forEach((t) => expect(t.min).toBeLessThanOrEqual(t.max));
  });

  it('is safe on empty / all-zero data', () => {
    expect(ufColorScaleQuantile([], 'v').byUf).toEqual({});
    expect(ufColorScaleQuantile([{ uf: 'SP', v: 0 }], 'v').byUf).toEqual({ SP: NODATA });
    expect(ufColorScaleQuantile([{ uf: 'SP', v: 0 }], 'v').thresholds.every((t) => t === null)).toBe(true);
  });

  it('paints a lone positive UF darkest, not lightest, regardless of its magnitude', () => {
    // A straight rank/n split puts rank 0 of n=1 at position 0/1=0 — the lightest
    // bucket — for a value that is simultaneously the smallest AND the largest.
    // Caught via the map's own click-to-filter: selecting a single UF narrowed the
    // choropleth to n=1 and painted it pale regardless of its real magnitude.
    const { byUf } = ufColorScaleQuantile([{ uf: 'PA', v: 2_900_000_000 }], 'v');
    expect(byUf.PA).toBe(RAMP[RAMP.length - 1]);
  });

  it('spreads a handful of UFs (fewer than the ramp) across the DARKEST buckets, ascending', () => {
    const { byUf } = ufColorScaleQuantile(
      [{ uf: 'PA', v: 300 }, { uf: 'MT', v: 100 }, { uf: 'SP', v: 0 }],
      'v',
    );
    expect(byUf.MT).toBe(RAMP[RAMP.length - 2]); // smaller of the two
    expect(byUf.PA).toBe(RAMP[RAMP.length - 1]); // larger — darkest
    expect(byUf.SP).toBe(NODATA);
  });

  it('agrees with the plain quantile split exactly at n === ramp.length (no jump at the threshold)', () => {
    const rows = RAMP.map((_, i) => ({ uf: `UF${i}`, v: i + 1 })); // 6 UFs, 6 buckets
    const { byUf } = ufColorScaleQuantile(rows, 'v');
    RAMP.forEach((color, i) => expect(byUf[`UF${i}`]).toBe(color));
  });
});

describe('fillColorExpression', () => {
  it('builds a maplibre match expression on the uf property, fallback last', () => {
    const expr = fillColorExpression({ SP: '#aaa', PA: '#bbb' }, '#fff');
    expect(expr[0]).toBe('match');
    expect(expr[1]).toEqual(['get', 'uf']);
    expect(expr).toContain('SP');
    expect(expr).toContain('#aaa');
    expect(expr[expr.length - 1]).toBe('#fff');
  });

  it('matches on a caller-supplied property (the municipal meshes key on codarea)', () => {
    // This was hardcoded to 'uf'. The municipal choropleth then produced a valid
    // `match` that matched NOTHING — every município fell through to the fallback and
    // the whole state painted no-data grey, with no error anywhere to explain it.
    const expr = fillColorExpression({ 1500107: '#aaa' }, '#fff', 'codarea');
    expect(expr[1]).toEqual(['get', 'codarea']);
    expect(expr).toContain('1500107');
    // Default stays 'uf' so the UF choropleth is untouched.
    expect(fillColorExpression({ SP: '#aaa' }, '#fff')[1]).toEqual(['get', 'uf']);
  });

  it('returns the constant fallback when there is nothing to color', () => {
    expect(fillColorExpression({}, '#fff')).toBe('#fff');
    expect(fillColorExpression(null, '#fff')).toBe('#fff');
  });

  it('drops malformed pairs so maplibre never reads .length on undefined (FINDING #5)', () => {
    // A null/undefined/non-string color injected into a maplibre `match` makes the
    // expression compiler deref `.length` on a missing operand and throw, blanking
    // the choropleth without the WebGL fallback. Bad pairs must be filtered out.
    const expr = fillColorExpression(
      { SP: '#aaa', PA: undefined, RJ: null, MG: 42, AC: '#ccc' },
      '#fff',
    );
    expect(expr[0]).toBe('match');
    // Only the two well-formed pairs survive (SP, AC) + the fallback.
    expect(expr).toContain('SP');
    expect(expr).toContain('#aaa');
    expect(expr).toContain('AC');
    expect(expr).toContain('#ccc');
    expect(expr).not.toContain('PA');
    expect(expr).not.toContain('RJ');
    expect(expr).not.toContain('MG');
    // No undefined/null leaked into the expression operands.
    expect(expr.every((x) => x != null)).toBe(true);
    expect(expr[expr.length - 1]).toBe('#fff');
  });

  it('falls back to the constant when every pair is malformed', () => {
    expect(fillColorExpression({ PA: undefined, RJ: null }, '#fff')).toBe('#fff');
  });
});

// ── A legenda descreve as cores que o mapa de fato pinta (v1.93.1) ────────────
describe('quantileThresholds with tied values', () => {
  // Ties are common among small municípios (many report R$ 1 mil or R$ 2 mil). The legend
  // placed values by array POSITION while the colour came from indexOf, which gives every
  // copy of a value the rank of its first copy — so buckets 1 and 2 below appeared in the
  // legend with no polygon painted in them, and bucket 3 claimed a "1" painted as bucket 0.
  const vals = [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 50, 900, 1200];

  it('lists only the buckets some value is actually painted with', () => {
    const idx = quantileIndexer(vals, RAMP.length);
    const painted = new Set(vals.map((v) => idx.indexOf(v)));
    const t = quantileThresholds(idx, RAMP);
    t.forEach((bucket, i) => expect(Boolean(bucket), `bucket ${i}`).toBe(painted.has(i)));
  });

  it('puts every value in the bucket of its own colour', () => {
    const idx = quantileIndexer(vals, RAMP.length);
    const t = quantileThresholds(idx, RAMP);
    for (const v of vals) {
      const b = t[idx.indexOf(v)];
      expect(b && v >= b.min && v <= b.max, `value ${v}`).toBe(true);
    }
  });
});

describe('map value helpers', () => {
  it('presentValue keeps absence apart from a measured zero', () => {
    for (const absent of [null, undefined, '', NaN, 'x', Infinity]) {
      expect(presentValue(absent), String(absent)).toBeNull();
    }
    expect(presentValue(0)).toBe(0);
    expect(presentValue('12.5')).toBe(12.5);
  });

  it('fmtMapValue returns null for an absent value instead of "0"', () => {
    expect(fmtMapValue(null)).toBeNull();
    expect(fmtMapValue(undefined)).toBeNull();
    expect(fmtMapValue(0)).toBe('0');
  });

  it('rowsSignature changes with the painted content and nothing else', () => {
    const a = [{ uf: 'PA', value: 1, name: 'Pará' }];
    expect(rowsSignature([{ ...a[0] }], 'uf', 'value')).toBe(rowsSignature(a, 'uf', 'value'));
    expect(rowsSignature([{ ...a[0], name: 'outro' }], 'uf', 'value'))
      .toBe(rowsSignature(a, 'uf', 'value')); // a name does not change the colours
    expect(rowsSignature([{ uf: 'PA', value: 2 }], 'uf', 'value'))
      .not.toBe(rowsSignature(a, 'uf', 'value'));
    expect(rowsSignature([], 'uf', 'value')).toBe('');
    expect(rowsSignature(null, 'uf', 'value')).toBe('');
  });

  it('escapeHtml neutralises markup in a name', () => {
    expect(escapeHtml(`Olho d'Água & <Cia>`)).toBe('Olho d&#39;Água &amp; &lt;Cia&gt;');
    expect(escapeHtml(null)).toBe('');
  });
});
