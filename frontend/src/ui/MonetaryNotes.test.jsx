// MonetaryNotes.test.jsx — the two honest-labelling atoms for monetary series.
//
// ValueGapNote exists because a SUM skips a NULL in silence: € sem correção only exists
// from 1999, COMEX starts in 1997, and until v1.78.0 a "1997–2026" euro total was quietly a
// 1999–2026 one. The note is the half of the fix the reader sees — so it must name the
// years, say what happened to them, and never round the part left out down to "0%".

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

beforeAll(async () => {
  // The real formatter (ui/data.js), inlined: this suite must not depend on the data layer.
  window.fmtPct = (n, digits = 1) => (n == null ? '—' : (n * 100).toFixed(digits).replace('.', ',') + '%');
  await import('./MonetaryNotes.jsx');
});

afterEach(() => cleanup());

const nota = (props) => render(<window.ValueGapNote {...props} />).container;

describe('ValueGapNote', () => {
  it('sem lacuna não diz nada — nada foi deixado de fora', () => {
    expect(nota({ gap: null, unit: '€' }).textContent).toBe('');
    expect(nota({ gap: { years: [], share: 0 }, unit: '€' }).textContent).toBe('');
  });

  it('nomeia os anos, o motivo do euro e quanto comércio ficou de fora', () => {
    // ÂNCORA EXTERNA, medida em produção 2026-09-13: Acre × castanha, € sem correção.
    const texto = nota({ gap: { years: [1997, 1998], share: 0.0038 }, unit: '€' }).textContent;
    expect(texto).toContain('Sem valor nesta convenção em 1997–1998');
    expect(texto).toContain('O euro só existe desde 1999');
    expect(texto).toContain('Esses anos ficam fora da soma');
    // Uma fração pequena com zero casas virava "0%", que se lê como "não ficou nada de fora".
    expect(texto).toContain('0,4% do comércio do recorte');
    expect(texto).not.toContain(' 0% ');
  });

  it('na sazonalidade os anos saem das MÉDIAS, não de uma soma', () => {
    const texto = nota({ gap: { years: [1998], share: null }, unit: '€', alvo: 'médias' }).textContent;
    expect(texto).toContain('Esse ano fica fora das médias');
    expect(texto).not.toContain('do comércio do recorte'); // sem base, sem fração inventada
  });

  it('um ano que falta só EM PARTE não é chamado de "o ano" fora da soma', () => {
    // ÂNCORA EXTERNA, medida em produção 2026-09-13: em US$ · IPCA, todas as 2.275 linhas
    // de agosto de 2026 do COMEX estão sem valor corrigido (o IPCA do mês ainda não entrou).
    // A primeira versão desta nota dizia "Esse ano fica fora da soma" — falso: saiu agosto.
    const texto = nota({ gap: { years: [2026], partial: [2026], share: 0.002 }, unit: 'US$' })
      .textContent;
    expect(texto).toContain('Parte do comércio de 2026 não tem valor nesta convenção');
    expect(texto).toContain('Isso fica fora da soma — 0,2% do comércio do recorte');
    expect(texto).not.toContain('Esse ano fica');
    expect(texto).not.toContain('Sem valor nesta convenção em 2026');
  });

  it('anos inteiros E um ano parcial na mesma janela', () => {
    const texto = nota({
      gap: { years: [1997, 1998, 2026], partial: [2026], share: 0.006 }, unit: '€',
    }).textContent;
    expect(texto).toContain('Sem valor nesta convenção em 1997–1998. E parte do comércio de 2026');
    expect(texto).toContain('O euro só existe desde 1999');
    expect(texto).toContain('Isso fica fora da soma');
  });

  it('anos não consecutivos são listados, não viram um intervalo falso', () => {
    const texto = nota({ gap: { years: [2003, 1997, 1999], share: 0.2 }, unit: 'R$' }).textContent;
    expect(texto).toContain('1997, 1999 e 2003');
    expect(texto).not.toContain('O euro'); // o motivo do euro só vale para o euro antes de 1999
    expect(texto).toContain('20% do comércio');
  });
});

describe('NominalSeriesNote', () => {
  it('diz que a série é nominal e para que ela serve', () => {
    const texto = render(<window.NominalSeriesNote />).container.textContent;
    expect(texto).toContain('nominais');
    expect(texto).toContain('no mesmo ano');
    expect(texto).toContain('não para comparar anos distantes');
  });
});

// A correção pela média do índice do ano (v1.103.0) deixa os anos até 1994 indicativos: com
// inflação de dois dígitos por mês, o valor anual não diz como se distribuiu entre os meses. O
// aviso só vale para R$ corrigido por índice brasileiro, e só quando o período começa em 1994 ou
// antes — senão diria "indicativo" numa série de comércio que começa em 1997.
describe('inflacaoAltaNoPeriodo / HighInflationNote', () => {
  const ipca = { currency: 'BRL', correction: 'IPCA' };

  it('vale para as três correções brasileiras em R$, e para mais nenhuma convenção', () => {
    for (const c of ['IPCA', 'IGP-M', 'IGP-DI']) {
      expect(window.inflacaoAltaNoPeriodo({ currency: 'BRL', correction: c }, '1974-01-01')).toBe(true);
    }
    // nominal: tem a regra própria das reformas monetárias; US$/€: só existem depois de 1994/1999
    expect(window.inflacaoAltaNoPeriodo({ currency: 'BRL', correction: 'Nominal' }, '1974-01-01')).toBe(false);
    expect(window.inflacaoAltaNoPeriodo({ currency: 'USD', correction: 'CPI' }, '1974-01-01')).toBe(false);
    expect(window.inflacaoAltaNoPeriodo({ currency: 'EUR', correction: 'HICP' }, '1974-01-01')).toBe(false);
    expect(window.inflacaoAltaNoPeriodo(null, '1974-01-01')).toBe(false);
  });

  it('o limite é 1994: começar em 1994 mostra, em 1995 não; sem início conhecido não afirma nada', () => {
    expect(window.inflacaoAltaNoPeriodo(ipca, '1994-01-01')).toBe(true);
    expect(window.inflacaoAltaNoPeriodo(ipca, 1994)).toBe(true);
    expect(window.inflacaoAltaNoPeriodo(ipca, '1995-01-01')).toBe(false);
    expect(window.inflacaoAltaNoPeriodo(ipca, null)).toBe(false);
    expect(window.inflacaoAltaNoPeriodo(ipca, '')).toBe(false);
    expect(window.inflacaoAltaNoPeriodo(ipca, 'não é data')).toBe(false);
  });

  it('o comércio, que começa em 1997 e 2000, nunca vê o aviso', () => {
    expect(window.inflacaoAltaNoPeriodo(ipca, '1997-01-01')).toBe(false);
    expect(window.inflacaoAltaNoPeriodo(ipca, '2000-01-01')).toBe(false);
  });

  it('o texto diz o que é indicativo, por quê, e o que não fazer', () => {
    const texto = render(<window.HighInflationNote conventions={ipca} start="1974-01-01" />).container.textContent;
    expect(texto).toContain('Valores corrigidos de anos até 1994 são indicativos');
    expect(texto).toContain('mais de 10% ao mês em pelo menos seis meses de cada ano');
    expect(texto).toContain('média do índice do ano');
    expect(texto).toContain('Comparar esses anos com 1995 em diante pode distorcer');
  });

  it('fora da regra não renderiza nada', () => {
    expect(render(<window.HighInflationNote conventions={{ currency: 'BRL', correction: 'Nominal' }} start="1974-01-01" />).container.textContent).toBe('');
    expect(render(<window.HighInflationNote conventions={ipca} start="2000-01-01" />).container.textContent).toBe('');
  });
});
