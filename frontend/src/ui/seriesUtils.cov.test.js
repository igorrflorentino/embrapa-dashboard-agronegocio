// seriesUtils.cov.test.js — closes the remaining seriesUtils.js gap: corrColor
// (the correlation-cell tint, lines 118-120) plus the small VIZ_SCALE/vizColor and
// accumPct helpers the M2 contract test (seriesUtils.test.js) does not exercise.
//
// seriesUtils.js registers its helpers on `window` via a side-effect import.

import { describe, expect, it } from 'vitest';

import './seriesUtils.js';

describe('corrColor — correlation-cell tint (token-driven color-mix)', () => {
  it('positive r uses the institutional green --ok token', () => {
    const css = window.corrColor(0.5);
    expect(css).toContain('var(--ok)');
    expect(css).toContain('color-mix(in srgb');
    expect(css).toContain('transparent');
  });

  it('negative r uses the terracotta --err token', () => {
    const css = window.corrColor(-0.5);
    expect(css).toContain('var(--err)');
    expect(css).not.toContain('var(--ok)');
  });

  it('alpha scales with |r|: 0.12 floor at r=0, ~0.72 at |r|=1', () => {
    // pct = round((0.12 + |r|*0.6) * 100)
    expect(window.corrColor(0)).toContain('12%'); // floor
    expect(window.corrColor(1)).toContain('72%'); // 0.12 + 0.6 = 0.72
    expect(window.corrColor(-1)).toContain('72%');
  });

  it('r=0 is treated as non-negative (>= 0 → green)', () => {
    expect(window.corrColor(0)).toContain('var(--ok)');
  });
});

describe('vizColor + VIZ_SCALE — wrap-around categorical ramp', () => {
  it('VIZ_SCALE is the 10-stop --viz token ramp', () => {
    expect(window.VIZ_SCALE).toHaveLength(10);
    expect(window.VIZ_SCALE[0]).toBe('var(--viz-1)');
    expect(window.VIZ_SCALE[9]).toBe('var(--viz-10)');
  });

  it('wraps around the scale for indices past the end', () => {
    expect(window.vizColor(0)).toBe('var(--viz-1)');
    expect(window.vizColor(10)).toBe('var(--viz-1)'); // 10 % 10 = 0
    expect(window.vizColor(11)).toBe('var(--viz-2)');
  });

  it('handles a negative index via the double-modulo guard', () => {
    expect(window.vizColor(-1)).toBe('var(--viz-10)'); // (-1 % 10 + 10) % 10 = 9
  });
});

describe('accumPct + seriesGrowth — basic helpers', () => {
  it('accumPct is the total percent change, NULL when the base cannot answer', () => {
    expect(window.accumPct(100, 150)).toBeCloseTo(50, 6);
    // Base ausente ou não-positiva: a razão é INDEFINIDA. Devolver 0 aqui (o que este
    // teste afirmava até a v1.49.0) fazia a tela dizer "não variou" para uma série que
    // saiu de R$ 0,47 bi para R$ 4,72 bi — o defeito estava fixado pelo próprio teste.
    expect(window.accumPct(0, 150)).toBeNull();
    expect(window.accumPct(-5, 150)).toBeNull();
    expect(window.accumPct(null, 150)).toBeNull();
    expect(window.accumPct(100, null)).toBeNull();
  });

  it('seriesGrowth returns YoY ratios and 0 on a zero base', () => {
    const g = window.seriesGrowth([{ v: 100 }, { v: 110 }, { v: 0 }, { v: 5 }]);
    expect(g[0]).toBeCloseTo(0.1, 6);
    expect(g[2]).toBe(0); // previous v was 0 → guard returns 0
    expect(window.seriesGrowth(undefined)).toEqual([]);
  });

  it('pearson returns 0 for n<2 and zero-variance inputs', () => {
    expect(window.pearson([1], [1])).toBe(0); // n<2
    expect(window.pearson([2, 2, 2], [1, 5, 9])).toBe(0); // a has zero variance
  });
});
