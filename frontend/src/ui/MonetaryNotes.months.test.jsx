// MonetaryNotes.months.test.jsx — the snapshot's month-level gap (v1.79.0).
//
// Every COMEX screen but the three trade views sits on annual marts, whose build SUMs the
// months: the latest month without a deflator index vanished inside a "2026" total. The
// snapshot now names the months (`gap.months`), and the screens cut the history's list
// to the period they show (`windowValueGap`).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

beforeAll(async () => {
  window.fmtPct = (n, digits = 1) => (n == null ? '—' : (n * 100).toFixed(digits).replace('.', ',') + '%');
  await import('./MonetaryNotes.jsx');
});

afterEach(() => cleanup());

const texto = (props) => render(<window.ValueGapNote {...props} />).container.textContent;

// ÂNCORA EXTERNA, medida em produção 2026-09-13: em IPCA, todas as 2.275 linhas de agosto
// de 2026 sem valor; em € sem correção, todos os meses de 1997–1998.
const IPCA = { years: [2026], partial: [2026], months: { 2026: [8] }, share: null };
const EURO = { years: [1997, 1998], partial: [], months: {}, share: null };

describe('ValueGapNote — o mês nomeado', () => {
  it('diz QUAL mês ficou de fora, e fora das somas das telas anuais', () => {
    const t = texto({ gap: IPCA, unit: 'R$', alvo: 'somas' });
    expect(t).toContain('Parte do comércio de 2026 (agosto) não tem valor nesta convenção');
    expect(t).toContain('Isso fica fora das somas');
    expect(t).not.toContain('do comércio do recorte'); // sem fração inventada
  });

  it('vários meses faltando viram uma lista pt-BR', () => {
    const t = texto({ gap: { ...IPCA, months: { 2026: [7, 8] } }, unit: 'R$', alvo: 'somas' });
    expect(t).toContain('2026 (julho e agosto)');
  });

  it('anos inteiros continuam sem lista de meses', () => {
    const t = texto({ gap: EURO, unit: '€', alvo: 'somas' });
    expect(t).toContain('Sem valor nesta convenção em 1997–1998');
    expect(t).toContain('Esses anos ficam fora das somas');
  });
});

describe('windowValueGap — só o que a tela mostra', () => {
  it('um período sem o ano da lacuna não gera nota', () => {
    expect(window.windowValueGap(IPCA, '2010-01-01', '2025-12-31')).toBeNull();
    expect(window.windowValueGap(EURO, '1999', '2026')).toBeNull();
  });

  it('corta a lista às pontas do período — datas ou anos', () => {
    const tudo = { years: [1997, 1998, 2026], partial: [2026], months: { 2026: [8] }, share: null };
    expect(window.windowValueGap(tudo, '1998-01-01', '2026-12-31')).toEqual({
      years: [1998, 2026], partial: [2026], months: { 2026: [8] }, share: null,
    });
    expect(window.windowValueGap(tudo, null, 1997).years).toEqual([1997]);
  });

  it('sem período (tudo) devolve a lista inteira; sem lacuna, nada', () => {
    expect(window.windowValueGap(EURO, undefined, undefined).years).toEqual([1997, 1998]);
    expect(window.windowValueGap(null, '1997', '2026')).toBeNull();
  });
});
