// absenceOfMeasure.test.js — a AUSÊNCIA de uma medida não é ZERO.
//
// O defeito que estes testes trancam (v1.49.0): as séries de valor deflacionado /
// convertido não cobrem toda a janela do banco — medido em produção 2026-09-06:
//
//   banco      janela    IPCA   IGP-DI   IGP-M   USD    EUR
//   PAM/PPM    1974–     1980   1980     1989    1994   1999
//   PEVS       1986–     1986   1986     1989    1994   1999
//
// O serializer devolvia NULL→0.0, o gráfico desenhava uma reta no zero por 6 a 25
// anos, e "Variação acumulada" dividia por esse zero e imprimia "+0%" — para uma
// série de abacaxi que foi de R$ 0,474 bi (1980) a R$ 4,724 bi (2024), +896% real.
//
// A âncora destes testes é EXTERNA ao código: a tabela de cobertura acima veio de
// `SELECT MIN(IF(col IS NOT NULL, reference_year, NULL))` nas marts de produção, e os
// números do abacaxi de `serving_pam_annual`. Um teste que só comparasse a função
// consigo mesma passaria com o defeito de volta.

import { beforeAll, describe, expect, it } from 'vitest';

import './data.js';        // fmtSigned/numBR reais — é a ponta que o usuário lê
import './seriesUtils.js'; // as primitivas sob teste

// Os anos que o IPCA NÃO alcança na PAM chegam como `v: null` (serializers._measure).
// Valores reais de `serving_pam_annual`, abacaxi, val_real_ipca_brl (R$ bi).
const ABACAXI_IPCA = [
  { y: 1974, v: null }, { y: 1975, v: null }, { y: 1976, v: null },
  { y: 1977, v: null }, { y: 1978, v: null }, { y: 1979, v: null },
  { y: 1980, v: 0.4745 }, { y: 1981, v: 0.5952 },
  { y: 2024, v: 4.7240 },
];

describe('primitivas de ausência — o zero afirmativo não pode voltar', () => {
  it('addPresent/sumPresent somam o que existe e só devolvem null quando NADA existe', () => {
    expect(window.sumPresent([null, null, null])).toBeNull();   // ano inteiro descoberto
    expect(window.sumPresent([])).toBeNull();                   // cesta vazia
    expect(window.sumPresent([null, 2, null, 3])).toBe(5);      // parcial soma o presente
    expect(window.sumPresent([0, 0])).toBe(0);                  // zero MEDIDO continua zero
  });

  it('scalePresent não deixa a aritmética recriar o zero (null * 1e9 === 0 em JS)', () => {
    expect(null * 1e9).toBe(0);                       // o comportamento do JS que causava o bug
    expect(window.scalePresent(null, 1e9)).toBeNull(); // o nosso, que não
    expect(window.scalePresent(2, 1e9)).toBe(2e9);
  });

  it('ratioPresent recusa denominador ausente ou não-positivo em vez de devolver 0', () => {
    expect(window.ratioPresent(10, 4)).toBe(2.5);
    expect(window.ratioPresent(10, 0)).toBeNull();
    expect(window.ratioPresent(10, null)).toBeNull();
    expect(window.ratioPresent(null, 4)).toBeNull();
  });

  it('deltaPct devolve o número certo quando a base existe, e null quando não', () => {
    const de1980 = ABACAXI_IPCA.find((d) => d.y === 1980).v;
    const de2024 = ABACAXI_IPCA.find((d) => d.y === 2024).v;
    // O número honesto da série real: +896% entre 1980 e 2024.
    expect(window.deltaPct(de1980, de2024)).toBeCloseTo(895.6, 0);
    // A base que a tela usava (1974, sem IPCA) não responde.
    expect(window.deltaPct(ABACAXI_IPCA[0].v, de2024)).toBeNull();
  });
});

describe('a recusa chega à tela com MOTIVO, não como "+0%"', () => {
  const first = ABACAXI_IPCA[0];                          // 1974, v: null
  const last = ABACAXI_IPCA[ABACAXI_IPCA.length - 1];     // 2024, v: 4.724

  it('deltaTitle nomeia o ano e a convenção quando a base falta', () => {
    const titulo = window.deltaTitle('Variação acumulada', first, last);
    expect(titulo).toContain('—');
    expect(titulo).toContain('1974');
    expect(titulo).not.toMatch(/\+0\s*%/);   // a afirmação falsa do print original
  });

  it('deltaTitle volta a ser só o número quando os extremos respondem', () => {
    const de1980 = ABACAXI_IPCA.find((d) => d.y === 1980);
    expect(window.deltaTitle('Variação acumulada', de1980, last)).toBe('Variação acumulada: +896%');
  });

  it('deltaWhyNot distingue base AUSENTE de base ZERO — motivos diferentes', () => {
    expect(window.deltaWhyNot({ y: 1974, v: null }, last)).toContain('sem valor em 1974');
    expect(window.deltaWhyNot({ y: 1974, v: 0 }, last)).toContain('valor nulo em 1974');
    expect(window.deltaWhyNot({ y: 1980, v: 0.4745 }, last)).toBeNull();
  });

  it('deltaWhyNot nomeia o ano FINAL quando é ele que falta, e recusa a série sem extremos', () => {
    // O caso simétrico: a base existe e é o ÚLTIMO ponto que a convenção não alcança
    // (uma janela que termina num ano ainda sem deflator publicado).
    const base = { y: 1980, v: 0.4745 };
    expect(window.deltaWhyNot(base, { y: 2025, v: null })).toContain('sem valor em 2025');
    expect(window.deltaWhyNot(null, last)).toBe('série sem extremos');
    expect(window.deltaWhyNot(base, null)).toBe('série sem extremos');
    // Base negativa: existe, é finita, e ainda assim não serve de denominador.
    expect(window.deltaWhyNot({ y: 1980, v: -3 }, last)).toContain('valor nulo em 1980');
  });
});

describe('estatísticas derivadas não podem consumir o zero fabricado', () => {
  it('cagrPct recusa a base ausente em vez de anunciar "0% ao ano"', () => {
    expect(window.cagrPct(null, 4.724, 50)).toBeNull();
    expect(window.cagrPct(0.4745, 4.724, 44)).toBeCloseTo(5.36, 1);  // valor real da série
  });

  it('linearFit ignora os anos ausentes — a tendência não é puxada para o zero', () => {
    const comAusentes = window.linearFit(ABACAXI_IPCA);
    const semAusentes = window.linearFit(ABACAXI_IPCA.filter((d) => d.v != null));
    expect(comAusentes.slope).toBeCloseTo(semAusentes.slope, 10);
    expect(comAusentes.slope).toBeGreaterThan(0);
  });

  it('pearsonByYear DESCARTA o par sem crescimento definido em vez de injetar 0%', () => {
    // Duas séries que crescem juntas, mas cujos dois primeiros anos não têm deflator.
    const a = [{ y: 1978, v: null }, { y: 1979, v: null }, { y: 1980, v: 10 }, { y: 1981, v: 12 }, { y: 1982, v: 15 }];
    const b = [{ y: 1978, v: null }, { y: 1979, v: null }, { y: 1980, v: 20 }, { y: 1981, v: 24 }, { y: 1982, v: 30 }];
    // Crescimento idêntico nos anos cobertos ⇒ correlação 1. Os zeros injetados pelo
    // código antigo diluíam isso com pares "0% vs 0%" que ninguém mediu.
    expect(window.pearsonByYear(a, b)).toBeCloseTo(1, 6);
  });
});

describe('os formatadores pt-BR já sabiam renderizar ausência — era só deixar chegar', () => {
  beforeAll(() => { expect(typeof window.fmtSigned).toBe('function'); });

  it('fmtSigned(null) é o travessão, e fmtSigned(0) continua sendo "+0%"', () => {
    expect(window.fmtSigned(null, 0)).toBe('—');
    expect(window.fmtSigned(0, 0)).toBe('+0%');   // um zero MEDIDO ainda se lê como zero
  });
});

// ── Incomensurabilidade: os extremos EXISTEM, mas em moedas diferentes ────────
//
// Segundo defeito do mesmo par de KPIs. Em NOMINAL a série não tem lacuna nenhuma —
// 1974 vale R$ 0,00008363 (mil cruzeiros divididos pelo fator do seed) e 2024 vale
// R$ 4.380.115.000. A razão é exata e a leitura é lixo: +5.237.412.820.780.295%, que
// foi o que a tela mostrou. Os cortes abaixo são o seed historical_currency_factors
// LIDO DE PRODUÇÃO (silver.historical_currency_factors), não uma lista inventada aqui.
const CORTES_BRL_NOMINAL = [1967, 1970, 1986, 1989, 1990, 1993, 1994];

describe('reforma monetária — o número existe e mesmo assim não responde', () => {
  const p1974 = { y: 1974, v: 8.363127272727273e-5 };   // R$, nominal, valor real da mart
  const p2024 = { y: 2024, v: 4.380115e9 };             // R$, nominal, valor real da mart

  it('a razão crua é exatamente a que apareceu na tela — o defeito não era aritmético', () => {
    expect(window.deltaPct(p1974.v, p2024.v)).toBeCloseTo(5.237412820780295e15, -3);
  });

  it('deltaPctIn recusa o par quando uma reforma cai dentro da janela', () => {
    expect(window.deltaPctIn(p1974, p2024, CORTES_BRL_NOMINAL)).toBeNull();
  });

  it('o motivo nomeia a reforma, não a ausência — os dois valores existem', () => {
    const titulo = window.deltaTitle('Variação acumulada', p1974, p2024, { breaks: CORTES_BRL_NOMINAL });
    expect(titulo).toContain('moeda mudou');
    expect(titulo).not.toContain('sem valor');
    expect(titulo).not.toContain('5237412820780295');
  });

  it('o YoY também é recusado quando os DOIS anos adjacentes cruzam a reforma', () => {
    // 1993 (Cruzeiro Real) → 1994 (Real): +5359% que não é crescimento nenhum.
    const p1993 = { y: 1993, v: 5470683.27 }, p1994 = { y: 1994, v: 2.98659e8 };
    expect(window.deltaPct(p1993.v, p1994.v)).toBeGreaterThan(5000);          // a razão crua
    expect(window.deltaPctIn(p1993, p1994, CORTES_BRL_NOMINAL)).toBeNull();   // recusada
  });

  it('dentro da MESMA era o nominal volta a responder normalmente', () => {
    const p1995 = { y: 1995, v: 3.77171e8 };
    expect(window.deltaPctIn(p1995, p2024, CORTES_BRL_NOMINAL)).toBeCloseTo(1061.4, 0);
  });

  it('em convenção deflacionada os cortes vêm VAZIOS e nada é recusado por moeda', () => {
    // O seam só emite breaks para val_yearfx_brl; IPCA/IGP-M/USD/EUR chegam com [].
    const de1980 = { y: 1980, v: 0.4745 }, de2024 = { y: 2024, v: 4.724 };
    expect(window.deltaPctIn(de1980, de2024, [])).toBeCloseTo(895.6, 0);
    expect(window.spanComparable(1980, 2024, [])).toBeNull();
  });

  it('um corte na BORDA da janela: o ano inicial já está na era nova, então vale', () => {
    // (1994, 2024] não contém 1994 — a janela começa DEPOIS da troca.
    expect(window.spanComparable(1994, 2024, CORTES_BRL_NOMINAL)).toBeNull();
    // (1993, 2024] contém 1994 — a janela atravessa a troca.
    expect(window.spanComparable(1993, 2024, CORTES_BRL_NOMINAL)).toContain('1994');
  });
});
