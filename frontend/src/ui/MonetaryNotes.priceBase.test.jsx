// MonetaryNotes.priceBase.test.jsx — o mês-base na tela (v1.105.0).
//
// Um valor corrigido está a preços de UM mês — o mais recente do índice quando a base
// analítica foi construída —, e esse mês anda a cada build que traz um índice novo. Estes
// auxiliares escrevem esse mês (e o período de uma soma de vários anos) e avisam quando duas
// leituras da mesma tela chegaram a meses diferentes. O que nunca podem fazer: adivinhar um
// mês, escolher um de dois, ou afirmar um período que inclua anos sem valor.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

beforeAll(async () => {
  await import('./MonetaryNotes.jsx');
});

afterEach(() => {
  cleanup();
  delete window.dataStore;
});

const IPCA_BRL = { currency: 'BRL', correction: 'IPCA' };
const OUTUBRO = { column: 'val_real_ipca_brl', month: '2026-10', fxDate: null };

describe('mesBase / precosDe — o mês por extenso, ou a frase que não o nomeia', () => {
  it('nomeia o mês em português', () => {
    expect(window.mesBase(OUTUBRO)).toBe('outubro de 2026');
    expect(window.mesBase({ month: '2026-01' })).toBe('janeiro de 2026');
    expect(window.mesBase({ month: '2025-12' })).toBe('dezembro de 2025');
    expect(window.precosDe(OUTUBRO)).toBe('a preços de outubro de 2026');
  });

  it('sem base, ou com uma que não é um mês, não adivinha', () => {
    for (const pb of [null, undefined, {}, { month: null }, { month: '2026-13' }, { month: '2026-00' }, { month: 'outubro' }]) {
      expect(window.mesBase(pb)).toBeNull();
      expect(window.precosDe(pb)).toBe('a preços do mês mais recente do índice');
    }
  });
});

describe('cambioDe — o dia de PTAX de uma coluna cruzada', () => {
  it('escreve a data no formato brasileiro', () => {
    expect(window.cambioDe({ ...OUTUBRO, fxDate: '2026-11-14' })).toBe('ao câmbio de 14/11/2026');
  });

  it('sem o dia, não inventa um', () => {
    expect(window.cambioDe(OUTUBRO)).toBe('ao câmbio mais recente');
    expect(window.cambioDe(null)).toBe('ao câmbio mais recente');
  });
});

describe('periodoDaSoma — os anos que uma soma soma', () => {
  it('um ano, ou o primeiro e o último', () => {
    expect(window.periodoDaSoma([2024, 2024])).toBe('soma de 2024');
    expect(window.periodoDaSoma([1997, 2026])).toBe('soma de 1997 a 2026');
    expect(window.periodoDaSoma(['1997', '2026'])).toBe('soma de 1997 a 2026');
  });

  it('sem período conhecido, nada — nunca "soma de null"', () => {
    for (const r of [null, undefined, [], [2024], [null, 2024], [2024, undefined], 'x']) {
      expect(window.periodoDaSoma(r)).toBeNull();
    }
  });
});

describe('faixaComValor — o período sai das linhas somadas, não da janela pedida', () => {
  const linhas = [
    { year: 2018, value: null },   // a correção não alcança: fora da soma
    { year: 2019, value: 0 },      // zero presente: é medida, entra
    { year: 2020, value: 5 },
    { year: 2021, value: NaN },
    { year: 2022, value: 7 },      // fora da janela
  ];

  it('o primeiro e o último ano COM valor dentro da janela', () => {
    expect(window.faixaComValor(linhas, 'year', 'value', 2018, 2021)).toEqual([2019, 2020]);
    expect(window.faixaComValor(linhas, 'year', 'value')).toEqual([2019, 2022]);
  });

  it('sem nenhum ano com valor, null', () => {
    expect(window.faixaComValor(linhas, 'year', 'value', 2018, 2018)).toBeNull();
    expect(window.faixaComValor([], 'year', 'value')).toBeNull();
    expect(window.faixaComValor(null, 'year', 'value')).toBeNull();
    // Um ano ausente não vira o ano 0 (Number(null) === 0).
    expect(window.faixaComValor([{ year: null, value: 1 }], 'year', 'value')).toBeNull();
  });
});

describe('valueColumnFor — a coluna corrigida que a convenção pede', () => {
  it('índice e moeda, inclusive as colunas cruzadas', () => {
    expect(window.valueColumnFor(IPCA_BRL)).toBe('val_real_ipca_brl');
    expect(window.valueColumnFor({ currency: 'USD', correction: 'CPI' })).toBe('val_real_cpi_usd');
    expect(window.valueColumnFor({ currency: 'USD', correction: 'IPCA' })).toBe('val_real_ipca_usd');
    expect(window.valueColumnFor({ currency: 'EUR', correction: 'HICP' })).toBe('val_real_hicp_eur');
  });

  it('nominal (a preços do próprio ano) e o desconhecido não têm mês-base', () => {
    expect(window.valueColumnFor({ currency: 'BRL', correction: 'Nominal' })).toBeNull();
    expect(window.valueColumnFor({ currency: 'XYZ', correction: 'IPCA' })).toBeNull();
    expect(window.valueColumnFor(null)).toBeNull();
  });
});

describe('PriceBaseSkewNote — duas leituras, dois meses', () => {
  const snapshotEm = (pb) => {
    window.dataStore = { get: () => ({ priceBase: pb }), conv: () => IPCA_BRL };
  };
  const nota = (props) => render(
    <window.PriceBaseSkewNote database="ibge_pevs" conventions={IPCA_BRL} {...props} />,
  ).container.textContent;

  it('com um mês só, ou nenhum, não diz nada', () => {
    snapshotEm(OUTUBRO);
    expect(nota({ bases: [{ month: '2026-10' }, null] })).toBe('');
    expect(nota({ bases: [] })).toBe('');
  });

  it('nomeia os meses em ordem de data, não na ordem em que as leituras chegaram', () => {
    snapshotEm({ ...OUTUBRO, month: '2026-11' });
    expect(nota({ bases: [{ month: '2026-09' }, { month: '2026-10' }] }))
      .toContain('a preços de meses diferentes: setembro de 2026, outubro de 2026 e novembro de 2026.');
  });

  it('a base de um snapshot de OUTRA convenção não entra na conta', () => {
    snapshotEm({ ...OUTUBRO, column: 'val_real_igpm_brl', month: '2026-11' });
    expect(nota({ bases: [{ month: '2026-10' }] })).toBe('');
  });

  it('não repete o aviso que outra nota da mesma tela já dá', () => {
    snapshotEm(OUTUBRO);
    // A outra nota (snapshot × setembro) já está na tela: esta se cala.
    expect(nota({ bases: [{ month: '2026-11' }], jaComparadas: [{ month: '2026-09' }] })).toBe('');
    // A outra calada (tudo em outubro): as bases dela entram na conta desta.
    expect(nota({ bases: [{ month: '2026-11' }], jaComparadas: [{ month: '2026-10' }] }))
      .toContain('outubro de 2026 e novembro de 2026');
  });
});
