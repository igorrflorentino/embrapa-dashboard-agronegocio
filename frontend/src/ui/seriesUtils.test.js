// seriesUtils.test.js — locks the year-aware correlation (M2). The cross-source
// ratio + correlation used to pair series BY ARRAY INDEX, which silently misaligns
// the moment one series has an internal year gap. pearsonByYear aligns by point.y.
//
// seriesUtils.js registers its helpers on `window` (window-global style); importing
// it for side-effects under jsdom populates window.pearson / window.pearsonByYear.

import { describe, expect, it } from 'vitest';

import './seriesUtils.js';

describe('pearsonByYear — aligns two series BY YEAR, not by array index (M2)', () => {
  it('perfectly co-moving, gap-free series → +1', () => {
    // VARYING growth (a constant-growth/geometric series has zero growth variance,
    // for which Pearson is undefined → 0 by convention). Identical varying growth → +1.
    const a = [{ y: 2000, v: 10 }, { y: 2001, v: 20 }, { y: 2002, v: 15 }, { y: 2003, v: 30 }];
    const b = [{ y: 2000, v: 100 }, { y: 2001, v: 200 }, { y: 2002, v: 150 }, { y: 2003, v: 300 }];
    expect(window.pearsonByYear(a, b)).toBeCloseTo(1, 6);
  });

  // O pareamento por ÍNDICE que `pearsonByYear` substituiu. Vivia em produção como
  // `window.seriesGrowth`, lido só por testes; virou andaime local na v1.51.0. O contraste
  // com ele É o ponto destes dois testes — sem uma referência, "alinha por ano" não se
  // distingue de "alinha por índice" em séries que por acaso coincidem.
  const crescimentoPorIndice = (pts, key = 'v') =>
    (pts || []).slice(1).map((d, i) => (pts[i][key] ? (d[key] - pts[i][key]) / pts[i][key] : 0));

  it('equals the legacy index correlation when years are identical & gap-free', () => {
    const a = [{ y: 2010, v: 5 }, { y: 2011, v: 6 }, { y: 2012, v: 4 }, { y: 2013, v: 9 }];
    const b = [{ y: 2010, v: 50 }, { y: 2011, v: 40 }, { y: 2012, v: 55 }, { y: 2013, v: 30 }];
    const legacy = window.pearson(crescimentoPorIndice(a), crescimentoPorIndice(b));
    expect(window.pearsonByYear(a, b)).toBeCloseTo(legacy, 6);
  });

  it('an internal year gap no longer misaligns the pairing', () => {
    // A is missing 2003 and carries a far-future 2010; B is dense through 2003.
    // The common, calendar-adjacent years are 2000-2002, where the two series move
    // identically → +1. The OLD index path would have paired A[3]=2010 against
    // B[3]=2003 and produced a spurious value.
    const a = [{ y: 2000, v: 10 }, { y: 2001, v: 20 }, { y: 2002, v: 30 }, { y: 2010, v: 5 }];
    const b = [{ y: 2000, v: 10 }, { y: 2001, v: 20 }, { y: 2002, v: 30 }, { y: 2003, v: 99 }];
    expect(window.pearsonByYear(a, b)).toBeCloseTo(1, 6);
    const legacy = window.pearson(crescimentoPorIndice(a), crescimentoPorIndice(b));
    expect(Math.abs(legacy - 1)).toBeGreaterThan(0.01); // the buggy index path diverges
  });

  it('skips growth across a gap and never crashes on sparse overlap', () => {
    const a = [{ y: 2000, v: 100 }, { y: 2001, v: 110 }, { y: 2003, v: 121 }];
    const b = [{ y: 2000, v: 100 }, { y: 2001, v: 90 }, { y: 2002, v: 80 }, { y: 2003, v: 70 }];
    const r = window.pearsonByYear(a, b);
    // A lacuna 2001→2003 descarta aquele par, sobrando UM (2000→2001): abaixo do mínimo
    // de dois, então a resposta honesta é a ausência. Antes saía 0 — descorrelação
    // perfeita afirmada sobre um ponto só.
    expect(r).toBeNull();
    // E com pares suficientes ela volta a existir, dentro do intervalo.
    const c = [{ y: 2000, v: 100 }, { y: 2001, v: 110 }, { y: 2002, v: 121 }];
    const d = [{ y: 2000, v: 100 }, { y: 2001, v: 90 }, { y: 2002, v: 80 }];
    const r2 = window.pearsonByYear(c, d);
    expect(Number.isFinite(r2)).toBe(true);
    expect(r2).toBeGreaterThanOrEqual(-1);
    expect(r2).toBeLessThanOrEqual(1);
  });

  it('correlates on a custom key (q for a value-less herd, not v)', () => {
    // ViewProductCompare passes key="q" for an all-herd basket: v=0 for a stock, so the
    // default key="v" would read zero growth (variance 0 → 0). On "q" (cabeças) the same
    // co-moving growth gives +1 — the measure-aware correlation the audit fix added.
    const a = [{ y: 2000, q: 10, v: 0 }, { y: 2001, q: 20, v: 0 }, { y: 2002, q: 15, v: 0 }, { y: 2003, q: 30, v: 0 }];
    const b = [{ y: 2000, q: 100, v: 0 }, { y: 2001, q: 200, v: 0 }, { y: 2002, q: 150, v: 0 }, { y: 2003, q: 300, v: 0 }];
    expect(window.pearsonByYear(a, b, 'q')).toBeCloseTo(1, 6);
    // Valor todo zero ⇒ deltaPct recusa cada par (base não-positiva) ⇒ nenhum par
    // sobra ⇒ n<2. Não é "variância zero", é falta de base — e a resposta é null.
    expect(window.pearsonByYear(a, b, 'v')).toBeNull();
  });
});

describe('cagrPct + spanYears — annualize over the calendar-YEAR span, not array length (NUM-1)', () => {
  it('spanYears returns the calendar span, immune to internal year gaps', () => {
    // A 4-element window covering 2000..2005 spans 5 years, NOT 3 (length-1). This is
    // exactly the case that made the old `win.length - 1` overstate the CAGR.
    expect(window.spanYears([{ y: 2000 }, { y: 2001 }, { y: 2004 }, { y: 2005 }])).toBe(5);
    expect(window.spanYears([{ y: 1995 }, { y: 2024 }])).toBe(29);
  });

  it('spanYears falls back to 1 for a single/empty series (no 1/0 exponent)', () => {
    expect(window.spanYears([{ y: 2010 }])).toBe(1);
    expect(window.spanYears([])).toBe(1);
    expect(window.spanYears(undefined)).toBe(1);
  });

  it('CAGR over a gapped window uses the 5-year span (≈14.87%), not the 3-period count', () => {
    const win = [{ y: 2000, v: 100 }, { y: 2001, v: 110 }, { y: 2004, v: 180 }, { y: 2005, v: 200 }];
    const v0 = win[0].v, vT = win[win.length - 1].v;
    const correct = window.cagrPct(v0, vT, window.spanYears(win));   // (200/100)^(1/5)-1
    const buggy = window.cagrPct(v0, vT, win.length - 1);           // (200/100)^(1/3)-1
    expect(correct).toBeCloseTo((Math.pow(2, 1 / 5) - 1) * 100, 6);
    expect(buggy).toBeGreaterThan(correct + 5); // the old index path materially overstates
  });

  it('returns the analytic CAGR for a clean N-year span and NULL for a base that cannot answer', () => {
    // 100 → 200 over 10 years = 2^(1/10)-1 ≈ 7.18% a.a.
    expect(window.cagrPct(100, 200, 10)).toBeCloseTo((Math.pow(2, 0.1) - 1) * 100, 6);
    // v0 <= 0 ou extremo ausente → indefinido → null ('—'), NUNCA 0 ("cresceu 0% a.a.").
    expect(window.cagrPct(0, 200, 10)).toBeNull();
    expect(window.cagrPct(null, 200, 10)).toBeNull();
    expect(window.cagrPct(100, null, 10)).toBeNull();
    expect(window.cagrPct(100, 200, 0)).toBeCloseTo(100, 6); // periods<=0 → 1 (single point)
  });
});

describe('stackYearMax — per-year stacked max across RAGGED layers, by year not index (NUM-2)', () => {
  it('aggregates by .y so a shorter layer never throws or drops tail years', () => {
    const layers = [
      { data: [{ y: 2000, q: 10 }, { y: 2001, q: 20 }, { y: 2002, q: 30 }] }, // full span
      { data: [{ y: 2002, q: 5 }] },                                          // introduced late
    ];
    // 2002 total = 30 + 5 = 35 is the max; the old index path read layers[1].data[1]
    // (undefined) and threw a TypeError that blanked the whole ValueVolume view.
    expect(() => window.stackYearMax(layers, 'q')).not.toThrow();
    expect(window.stackYearMax(layers, 'q')).toBe(35);
  });

  it('ignores non-finite values and returns 0 for empty input', () => {
    expect(window.stackYearMax([{ data: [{ y: 2000, v: NaN }, { y: 2001, v: 7 }] }])).toBe(7);
    expect(window.stackYearMax([])).toBe(0);
    expect(window.stackYearMax(undefined)).toBe(0);
  });
});

describe('linearFit — OLS trend line (the "linha de tendência" overlay)', () => {
  it('recovers the slope/intercept of a perfectly linear series', () => {
    // v = 2·y - 4000 over 2000..2003
    const pts = [{ y: 2000, v: 0 }, { y: 2001, v: 2 }, { y: 2002, v: 4 }, { y: 2003, v: 6 }];
    const fit = window.linearFit(pts);
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.predict(2004)).toBeCloseTo(8, 6);
    // line endpoints span the x-range and lie on the fit
    expect(fit.line[0]).toMatchObject({ y: 2000 });
    expect(fit.line[1].y).toBe(2003);
    expect(fit.line[1].v).toBeCloseTo(6, 6);
  });

  it('fits a least-squares slope through noisy points', () => {
    const pts = [{ y: 1, v: 1 }, { y: 2, v: 3 }, { y: 3, v: 2 }, { y: 4, v: 5 }, { y: 5, v: 4 }];
    const fit = window.linearFit(pts);
    expect(fit.slope).toBeCloseTo(0.8, 6); // classic textbook OLS result
  });

  it('returns null on fewer than 2 finite points or zero x-variance', () => {
    expect(window.linearFit([])).toBeNull();
    expect(window.linearFit([{ y: 2000, v: 5 }])).toBeNull();
    expect(window.linearFit([{ y: 2000, v: 1 }, { y: 2000, v: 9 }])).toBeNull(); // all x equal
    expect(window.linearFit([{ y: 2000, v: NaN }, { y: 2001, v: 3 }])).toBeNull();
  });

  it('honours a custom value key', () => {
    const pts = [{ y: 2000, q: 10 }, { y: 2001, q: 20 }];
    const fit = window.linearFit(pts, 'q');
    expect(fit.slope).toBeCloseTo(10, 6);
    expect(fit.line[0].q).toBeDefined();
  });
});

// ── materialityFloor — o piso de materialidade ─────────────────────────────
//
// ÂNCORA EXTERNA: os números abaixo são a PAM 2024 em produção (medidos em
// 2026-09-07 sobre serving_pam_annual), não uma fixture inventada. A pergunta que o
// teste faz é a que o defeito respondia errado na tela: com 205 ha de cana, 0,002%
// da área nacional, o DF encabeçava o ranking de "UFs mais produtivas".
describe('materialityFloor — quem não tem base não compete pelo topo', () => {
  // As 8 UFs de MAIOR rendimento em cana-de-açúcar na safra 2024, na ordem em que a
  // fonte as devolve. Repare que a ordem por rendimento é quase o INVERSO da ordem
  // por área: é isso que faz o piso ser necessário e não decorativo.
  const CANA_2024 = [
    { uf: 'DF', areaHa: 205, yieldKgHa: 85000 },
    { uf: 'TO', areaHa: 36105, yieldKgHa: 81663 },
    { uf: 'MT', areaHa: 241946, yieldKgHa: 81479 },
    { uf: 'GO', areaHa: 1015810, yieldKgHa: 79735 },
    { uf: 'MS', areaHa: 672523, yieldKgHa: 78063 },
    { uf: 'SP', areaHa: 5398676, yieldKgHa: 77532 },
    { uf: 'MG', areaHa: 1118810, yieldKgHa: 74869 },
    { uf: 'BA', areaHa: 74564, yieldKgHa: 74768 },
  ];

  it('tira do topo a UF de área desprezível e promove a primeira UF comparável', () => {
    const { kept, dropped } = window.materialityFloor(CANA_2024, 'areaHa', window.AREA_FLOOR);
    const lider = kept.slice().sort((a, b) => b.yieldKgHa - a.yieldKgHa)[0];
    // TO é o líder que a consulta sobre as 27 UFs REAIS também devolve com o piso
    // ligado — a fixture de 8 linhas reproduz a conclusão do conjunto inteiro.
    expect(lider.uf).toBe('TO');
    expect(dropped.map((u) => u.uf)).toEqual(['DF']);
  });

  it('a metade ABSOLUTA salva quem é coadjuvante nacional mas tem base sólida', () => {
    // O TO tem 36.105 ha de cana: 0,42% do recorte, ABAIXO do piso relativo. Um piso
    // só relativo o apagaria — e ele é o líder real da lavoura. Este teste é o que
    // separa a regra entregue da que foi descartada por medição.
    const { kept, shareOf } = window.materialityFloor(CANA_2024, 'areaHa', window.AREA_FLOOR);
    const to = CANA_2024[1];
    expect(shareOf(to)).toBeLessThan(window.AREA_FLOOR.minShare); // reprova no relativo
    expect(to.areaHa).toBeGreaterThanOrEqual(window.AREA_FLOOR.minAbs); // passa no absoluto
    expect(kept.map((u) => u.uf)).toContain('TO');
    // E some assim que a metade absoluta é desligada — a prova de que é ELA que o salva.
    const soRelativo = window.materialityFloor(CANA_2024, 'areaHa', { minShare: 0.005 });
    expect(soRelativo.kept.map((u) => u.uf)).not.toContain('TO');
  });

  it('a metade RELATIVA salva quem pesa na lavoura mesmo com pouca área absoluta', () => {
    // Numa lavoura pequena, 400 ha podem ser 10% do país. O piso absoluto sozinho
    // (1.000 ha) apagaria a UF mais relevante que existe para aquele produto.
    const LAVOURA_PEQUENA = [
      { uf: 'CE', areaHa: 2600, yieldKgHa: 700 },
      { uf: 'PI', areaHa: 900, yieldKgHa: 650 },
      { uf: 'RN', areaHa: 400, yieldKgHa: 600 },
    ];
    const { kept, dropped } = window.materialityFloor(LAVOURA_PEQUENA, 'areaHa', window.AREA_FLOOR);
    expect(kept.map((u) => u.uf).sort()).toEqual(['CE', 'PI', 'RN']); // 900 e 400 ha ficam
    expect(dropped).toEqual([]);
    const soAbsoluto = window.materialityFloor(LAVOURA_PEQUENA, 'areaHa', { minAbs: 1000 });
    expect(soAbsoluto.dropped.map((u) => u.uf).sort()).toEqual(['PI', 'RN']);
  });

  it('devolve os descartados para que a tela possa NOMEÁ-LOS (nada some em silêncio)', () => {
    const { kept, dropped } = window.materialityFloor(CANA_2024, 'areaHa', window.AREA_FLOOR);
    // A regra do projeto: filtrar sem dizer é proibido. O contrato do helper é
    // devolver as duas metades, e kept ∪ dropped tem de ser a entrada INTEIRA.
    expect(kept.length + dropped.length).toBe(CANA_2024.length);
    expect([...kept, ...dropped].map((u) => u.uf).sort())
      .toEqual(CANA_2024.map((u) => u.uf).sort());
  });

  it('shareOf devolve a fração real de cada linha', () => {
    const total = CANA_2024.reduce((a, u) => a + u.areaHa, 0);
    const { shareOf } = window.materialityFloor(CANA_2024, 'areaHa', window.AREA_FLOOR);
    expect(shareOf(CANA_2024[0])).toBeCloseTo(205 / total, 12);
    expect(shareOf(CANA_2024[0])).toBeLessThan(0.0001); // o DF é 0,002% do recorte
  });

  it('não discrimina quando não há base: sem a coluna, ou com total zero, tudo passa', () => {
    // Um banco que não informa área não pode ter o ranking silenciosamente esvaziado.
    const semArea = [{ uf: 'MT', yieldKgHa: 8 }, { uf: 'GO', yieldKgHa: 7 }];
    expect(window.materialityFloor(semArea, 'areaHa', window.AREA_FLOOR).kept).toHaveLength(2);
    expect(window.materialityFloor(semArea, 'areaHa', window.AREA_FLOOR).total).toBeNull();
    const zerada = [{ uf: 'MT', areaHa: 0 }, { uf: 'GO', areaHa: 0 }];
    expect(window.materialityFloor(zerada, 'areaHa', window.AREA_FLOOR).kept).toHaveLength(2);
  });

  it('um piso que derrubaria TODO mundo não derruba ninguém — melhor sem piso que em branco', () => {
    const { kept, dropped } = window.materialityFloor(CANA_2024, 'areaHa', { minShare: 0.99, minAbs: 1e12 });
    expect(kept).toHaveLength(CANA_2024.length);
    expect(dropped).toHaveLength(0);
  });

  it('a área AUSENTE é descartada, não tratada como zero comparável', () => {
    const comBuraco = [...CANA_2024, { uf: 'ZZ', areaHa: null, yieldKgHa: 999999 }];
    const { kept, dropped } = window.materialityFloor(comBuraco, 'areaHa', window.AREA_FLOOR);
    expect(kept.map((u) => u.uf)).not.toContain('ZZ');
    expect(dropped.map((u) => u.uf)).toContain('ZZ');
  });

  it('sem opções não filtra nada (os dois pisos default são 0)', () => {
    expect(window.materialityFloor(CANA_2024, 'areaHa').dropped).toEqual([]);
  });

  it('entrada não-array não quebra', () => {
    expect(window.materialityFloor(null, 'areaHa', window.AREA_FLOOR).kept).toEqual([]);
    expect(window.materialityFloor(undefined, 'areaHa', window.AREA_FLOOR).dropped).toEqual([]);
  });
});

// ── deltaUp — a direção da seta do KPI ────────────────────────────────────────
describe('deltaUp — a ausência não aponta direção', () => {
  it('true quando subiu, false quando caiu, null quando não há variação', () => {
    expect(window.deltaUp(4.2)).toBe(true);
    expect(window.deltaUp(0)).toBe(true);   // não caiu
    expect(window.deltaUp(-3)).toBe(false);
    expect(window.deltaUp(null)).toBeNull();
    expect(window.deltaUp(undefined)).toBeNull();
    expect(window.deltaUp(NaN)).toBeNull();
  });

  it('recusa null EM VEZ de deixar o JS respondê-lo — as três formas erradas', () => {
    // Cada linha é uma das respostas que estavam espalhadas pelos call sites. Todas
    // concordam com deltaUp no número presente e divergem exatamente na ausência,
    // que é o único lugar onde a resposta importava.
    const d = null;
    expect(d >= 0).toBe(true);                                  // virava VERDE ↑
    expect(d != null && d >= 0).toBe(false);                    // virava VERMELHO ↓
    expect(window.deltaUp(d)).toBeNull();                       // não aponta nada
    // E o caso mais traiçoeiro: colorir pela MEDIDA CRUA em vez da variação.
    const [prev, last] = [{ q: null }, { q: null }];
    expect(last.q >= prev.q).toBe(true);                        // dois ausentes "subiram"
    expect(window.deltaUp(window.deltaPct(prev.q, last.q))).toBeNull();
  });

  it('encadeia com deltaPct sem que a ausência vire direção', () => {
    expect(window.deltaUp(window.deltaPct(100, 120))).toBe(true);
    expect(window.deltaUp(window.deltaPct(120, 100))).toBe(false);
    expect(window.deltaUp(window.deltaPct(0, 100))).toBeNull();    // base não-positiva
    expect(window.deltaUp(window.deltaPct(null, 100))).toBeNull(); // base ausente
  });
});

// ── roundPresent — arredondar sem re-fabricar o zero ──────────────────────────
describe('roundPresent — Math.round(null) é 0, e isso apagava a ausência', () => {
  it('arredonda o que existe e devolve null para o que não existe', () => {
    expect(window.roundPresent(3500.6)).toBe(3501);
    expect(window.roundPresent(0)).toBe(0);      // zero MEDIDO continua zero
    expect(window.roundPresent(null)).toBeNull();
    expect(window.roundPresent(undefined)).toBeNull();
    expect(window.roundPresent(NaN)).toBeNull();
  });

  it('é o contraste com Math.round que dá sentido ao helper', () => {
    // Sem esta linha, "arredonda preservando ausência" não se distingue de Math.round
    // em nenhum caso que um teste ingênuo cobriria.
    expect(Math.round(null)).toBe(0);
    expect(window.roundPresent(null)).toBeNull();
  });

  it('encadeia com numBR: a ausência chega à tela como travessão, não como zero', () => {
    expect(window.numBR(window.roundPresent(null), 0)).toBe('—');
    expect(window.numBR(Math.round(null), 0)).toBe('0'); // o que a tela mostrava antes
  });
});

describe('pricedShareLow / fmtPctSig — the share of the value behind a price (v1.108.10)', () => {
  it('names a share below 0,9, never one at it, and never one nobody knows', () => {
    expect(window.pricedShareLow(0.8999)).toBe(true);
    expect(window.pricedShareLow(0.9)).toBe(false);
    // `null < 0.9` is true in JS: an UNKNOWN share must not read as a low one.
    expect(window.pricedShareLow(null)).toBe(false);
    expect(window.pricedShareLow(undefined)).toBe(false);
    expect(window.pricedShareLow(NaN)).toBe(false);
  });

  it('keeps one significant digit below 1%: 0,03% is not "0,0%"', () => {
    // 440310 in 2022, every reporter (prod, 2026-11-23): 0.03% of the value behind the price.
    expect(window.fmtPct(0.0003)).toBe('0,0%'); // what fmtPct alone would print
    expect(window.fmtPctSig(0.0003)).toBe('0,03%');
    expect(window.fmtPctSig(0.0027)).toBe('0,3%');
    expect(window.fmtPctSig(0.00004)).toBe('0,004%');
    // At and above 1% it is fmtPct: one decimal on screen, the floor the caller asks for.
    expect(window.fmtPctSig(0.1)).toBe('10,0%');
    expect(window.fmtPctSig(0.1, 2)).toBe('10,00%');
    expect(window.fmtPctSig(0.0003, 2)).toBe('0,03%');
    expect(window.fmtPctSig(0)).toBe('0,0%');
    expect(window.fmtPctSig(null)).toBe('—');
  });
});

// ── A ranking holds only rows that produced (v1.108.22) ──────────────────────────────────
// Visão geral and Rebanho sorted every UF row, and PAM publishes a zeroed row for every
// município: açaí × RS read "3 maiores: RS" with RS at R$ 0 in every year.
describe('topPositive — only rows with a positive measure are ranked', () => {
  const v = (r) => r.v;

  it('drops zero, negative, null, undefined and NaN, and sorts the rest largest first', () => {
    const rows = [
      { k: 'a', v: 0 }, { k: 'b', v: 5 }, { k: 'c', v: null }, { k: 'd', v: -2 },
      { k: 'e', v: undefined }, { k: 'f', v: NaN }, { k: 'g', v: 9 },
    ];
    expect(window.topPositive(rows, v, 3).map((r) => r.k)).toEqual(['g', 'b']);
  });

  it('keeps at most n rows', () => {
    const rows = [1, 4, 2, 8, 3].map((x) => ({ v: x }));
    expect(window.topPositive(rows, v, 3).map(v)).toEqual([8, 4, 3]);
  });

  it('nothing produced, or no rows at all: an empty list, which the screen writes as "—"', () => {
    expect(window.topPositive([{ v: 0 }, { v: null }], v, 3)).toEqual([]);
    expect(window.topPositive(undefined, v, 3)).toEqual([]);
  });

  it('does not reorder the array it was given', () => {
    const rows = [{ v: 1 }, { v: 3 }];
    window.topPositive(rows, v, 3);
    expect(rows.map(v)).toEqual([1, 3]);
  });
});

// ── A maximum of zeros is no maximum (v1.108.23) ─────────────────────────────────────────
// Each "Pico histórico" took its own maximum, which named the FIRST year of a window of
// zeros: codornas × AP read "0 cabeças em 2015", açaí × RS "R$ 0 em 2015".
describe('peakOf — the largest year above zero, or why there is none', () => {
  const q = (d) => d.q;

  it('names the largest point above zero, skipping zeros and absences', () => {
    const rows = [{ y: 2015, q: 0 }, { y: 2016, q: 30 }, { y: 2017, q: null }, { y: 2018, q: 10 }];
    expect(window.peakOf(rows, q)).toEqual({ peak: { y: 2016, q: 30 }, why: null });
  });

  it('a tie names the earliest year, as the old maximum did', () => {
    const rows = [{ y: 2015, q: 5 }, { y: 2016, q: 9 }, { y: 2017, q: 9 }];
    expect(window.peakOf(rows, q).peak.y).toBe(2016);
  });

  it('every figure at zero: no peak, and the card says so', () => {
    const rows = [{ y: 2015, q: 0 }, { y: 2016, q: 0 }, { y: 2017, q: null }];
    expect(window.peakOf(rows, q)).toEqual({ peak: null, why: 'nenhum ano acima de zero' });
  });

  it('no figure at all is a different reason, kept apart from the zeros', () => {
    expect(window.peakOf([{ y: 2015, q: null }, { y: 2016, q: undefined }], q))
      .toEqual({ peak: null, why: 'sem dados na janela' });
    expect(window.peakOf([], q)).toEqual({ peak: null, why: 'sem dados na janela' });
    expect(window.peakOf(undefined, q)).toEqual({ peak: null, why: 'sem dados na janela' });
  });

  it('a negative or NaN figure never becomes the peak', () => {
    const rows = [{ y: 2015, q: -4 }, { y: 2016, q: NaN }, { y: 2017, q: 0 }];
    expect(window.peakOf(rows, q)).toEqual({ peak: null, why: 'nenhum ano acima de zero' });
  });
});
