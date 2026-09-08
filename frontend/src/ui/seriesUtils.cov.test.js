// seriesUtils.cov.test.js — closes the remaining seriesUtils.js gap: corrColor
// (the correlation-cell tint, lines 118-120) plus the small VIZ_SCALE/vizColor and
// accumPct helpers the M2 contract test (seriesUtils.test.js) does not exercise.
//
// seriesUtils.js registers its helpers on `window` via a side-effect import.

import { describe, expect, it } from 'vitest';

import './seriesUtils.js';

describe('corrColor — correlation-cell tint (token-driven color-mix)', () => {
  it('a correlação AUSENTE é neutra, não verde', () => {
    // `null >= 0` é true em JS, então a célula sem base para correlacionar vinha
    // pintada de verde — fraca, mas positiva. É o mesmo defeito de deltaUp, na matriz.
    expect(window.corrColor(null)).toBe('var(--bg-surface-2)');
    expect(window.corrColor(undefined)).toBe('var(--bg-surface-2)');
    expect(window.corrColor(NaN)).toBe('var(--bg-surface-2)');
    // E o contraste que dá sentido ao guarda: sem ele, o token seria o do positivo.
    expect(window.corrColor(0.5)).toContain('--ok');
    expect(window.corrColor(-0.5)).toContain('--err');
  });

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

describe('VIZ_SCALE — a rampa categórica compartilhada', () => {
  it('tem os 10 tons e usa só tokens, nunca hex cru', () => {
    expect(window.VIZ_SCALE).toHaveLength(10);
    expect(window.VIZ_SCALE.every((c) => c.startsWith('var(--viz-'))).toBe(true);
  });
});

describe('accumPct — variação acumulada', () => {
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


  it('pearson RECUSA sem base (n<2), mas mantém o 0 da variância zero', () => {
    // n<2 é falta de DADO, e devolver 0 ali afirmava descorrelação perfeita sobre um
    // único ponto — medido na tela: com a janela em 2023–2024 a matriz inteira do PEVS
    // mostrava "0,00" entre madeira, carvão e lenha.
    expect(window.pearson([1], [1])).toBeNull();
    expect(window.pearson([], [])).toBeNull();
    // A variância zero segue devolvendo 0, e isso é uma decisão DELIBERADA, registrada
    // em absenceGuard.test.js: uma série plana é propriedade medida, não dado faltante.
    expect(window.pearson([2, 2, 2], [1, 5, 9])).toBe(0);
  });
});
