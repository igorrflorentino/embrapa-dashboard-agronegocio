// MonetaryNotes.reasons.test.jsx — the note says WHY the convention has no value (v1.80.0).
//
// Three holes exist, each with its own cause, and the note names the cause only when the
// facts it has settle it: the euro before 1999; an index series that begins after the
// history does (a hole at the START — PAM/PPM have no IPCA in 1974–1979, and R$ · IPCA is
// the dashboard's default convention); an index not ingested yet (a hole at the END — the
// latest COMEX month, measured 2026-09-13).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

beforeAll(async () => {
  await import('./data.js');        // fmtSigned/fmtPct reais — é a ponta que o usuário lê
  await import('./seriesUtils.js'); // deltaTitle
  await import('./MonetaryNotes.jsx');
});

afterEach(() => cleanup());

const texto = (props) => render(<window.ValueGapNote alvo="somas" {...props} />).container.textContent;

describe('ValueGapNote — o motivo', () => {
  it('lacuna no INÍCIO numa correção: a série do índice não alcança esses anos', () => {
    // ÂNCORA EXTERNA, medida em produção 2026-09-13: PAM em R$ · IPCA, 1974–2024.
    const gap = { years: [1974, 1975, 1976, 1977, 1978, 1979], partial: [], months: {},
      valuedRange: [1980, 2024], share: null };
    const t = texto({ gap, unit: 'R$', correcao: 'IPCA' });
    expect(t).toContain('Sem valor nesta convenção em 1974–1979.');
    expect(t).toContain('A série do IPCA não alcança esses anos.');
    expect(t).toContain('Esses anos ficam fora das somas.');
  });

  it('lacuna no FIM numa correção: o índice ainda não entrou na base', () => {
    const gap = { years: [2026], partial: [2026], months: { 2026: [8] },
      valuedRange: [1997, 2026], share: null };
    const t = texto({ gap, unit: 'R$', correcao: 'IPCA' });
    expect(t).toContain('Parte do comércio de 2026 (agosto)');
    expect(t).toContain('O IPCA desse período ainda não entrou na base.');
  });

  it('o ano inteiro depois do último com valor (o COMTRADE incompleto) também é "ainda não entrou"', () => {
    const gap = { years: [2026], partial: [], months: {}, valuedRange: [2000, 2025], share: null };
    expect(texto({ gap, unit: 'US$', correcao: 'IGP-DI' }))
      .toContain('O IGP-DI desse período ainda não entrou na base.');
  });

  it('o euro sem correção antes de 1999 é o nascimento do euro, não um índice', () => {
    const gap = { years: [1986, 1987, 1988], partial: [], months: {}, valuedRange: [1989, 2024], share: null };
    const t = texto({ gap, unit: '€', correcao: 'Nominal' });
    expect(t).toContain('O euro só existe desde 1999');
    expect(t).not.toContain('série do');
  });

  it('sem fatos para o motivo, a nota não inventa um', () => {
    // Sem valuedRange, nem a correção: diz o QUE falta e onde, sem afirmar o porquê.
    const t = texto({ gap: { years: [1990], partial: [], share: null }, unit: 'R$' });
    expect(t).toContain('Sem valor nesta convenção em 1990.');
    expect(t).not.toMatch(/série do|ainda não entrou|euro/);
  });
});

describe('Variação acumulada — o motivo da recusa', () => {
  // ÂNCORA EXTERNA: abacaxi na PAM, R$ · IPCA, serving_pam_annual (R$ bi) — 1974 sem valor.
  const p1974 = { y: 1974, v: null };
  const p2024 = { y: 2024, v: 4.724 };
  const PAM_IPCA = { years: [1974, 1975, 1976, 1977, 1978, 1979], partial: [], months: {},
    valuedRange: [1980, 2024], share: null };

  it('diz que a série do índice não alcança o ano inicial', () => {
    const motivo = window.valueGapMotivo(PAM_IPCA, { currency: 'BRL', correction: 'IPCA' });
    expect(window.deltaTitle('Variação acumulada', p1974, p2024, { motivo }))
      .toBe('Variação acumulada: — · sem valor em 1974 nesta convenção — a série do IPCA não alcança esse ano');
  });

  it('o ano final sem índice ainda é "ainda não entrou na base"', () => {
    const gap = { years: [2026], partial: [2026], months: { 2026: [8] }, valuedRange: [1997, 2026], share: null };
    const motivo = window.valueGapMotivo(gap, { currency: 'USD', correction: 'IPCA' });
    expect(window.deltaWhyNot({ y: 1997, v: 1 }, { y: 2026, v: null }, null, motivo))
      .toBe('sem valor em 2026 nesta convenção — o IPCA desse período ainda não entrou na base');
  });

  it('o euro sem correção antes de 1999', () => {
    const gap = { years: [1986, 1998], partial: [], months: {}, valuedRange: [1999, 2024], share: null };
    const motivo = window.valueGapMotivo(gap, { currency: 'EUR', correction: 'Nominal' });
    expect(motivo(1986)).toBe('o euro só existe desde 1999');
    expect(window.valueGapMotivo(gap, { currency: 'BRL', correction: 'Nominal' })(1986)).toBeNull();
  });

  it('um ano fora da lacuna, ou sem lacuna nenhuma, fica sem motivo — nunca inventado', () => {
    const motivo = window.valueGapMotivo(PAM_IPCA, { currency: 'BRL', correction: 'IPCA' });
    expect(motivo(1990)).toBeNull();
    expect(window.valueGapMotivo(null, { currency: 'BRL', correction: 'IPCA' })).toBeNull();
    // Sem motivo, a recusa volta à forma da v1.49.0.
    expect(window.deltaWhyNot(p1974, p2024, null, null)).toBe('sem valor em 1974 nesta convenção');
    // Um ano do meio da série que a correção não explica (nem início, nem fim).
    const meio = { years: [1990], partial: [], months: {}, valuedRange: [1980, 2024], share: null };
    expect(window.valueGapMotivo(meio, { currency: 'BRL', correction: 'IPCA' })(1990)).toBeNull();
  });
});
