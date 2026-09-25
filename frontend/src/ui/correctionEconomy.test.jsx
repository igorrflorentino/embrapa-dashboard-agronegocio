// correctionEconomy.test.jsx — a correção acontece em ALGUMA economia, e o índice
// acompanha a moeda.
//
// Até a v1.87 a faixa oferecia duas operações sob o mesmo símbolo: "US$ · IPCA"
// (val_real_ipca_usd — real deflacionado pelo IPCA e convertido ao câmbio de HOJE: poder
// de compra brasileiro, apresentado em dólares) e "US$ · CPI" (val_real_cpi_usd — câmbio
// do ANO, corrigido pela inflação americana). As duas eram legítimas, mas a primeira
// confundia mais do que servia — quem pede dólares corrigidos pela inflação espera a
// inflação do dólar — e exigia três bandas e uma frase de negação para ser lida certo.
// Desde a v1.88.0 (decisão do mantenedor, 2026-09-23) o painel só oferece, para cada
// moeda, "sem correção" ou um índice da PRÓPRIA economia dela.
//
// Os testes abaixo guardam três coisas:
//   1. a regra: R$ → IPCA · IGP-M · IGP-DI; US$ → CPI; € → HICP; Nominal em todas;
//   2. que NENHUM caminho — clique, troca de moeda, deep link — produz outra combinação,
//      e que o padrão é o Nominal;
//   3. que a tela diz de que economia é a inflação oferecida.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

let MetricConventions;

beforeEach(async () => {
  await import('./data.js');
  await import('./bancos.js');
  await import('./MetricConventions.jsx');
  MetricConventions = window.MetricConventions;
});

afterEach(() => cleanup());

const BASE = { currency: 'BRL', correction: 'Nominal', units: { mass: 't', volume: 'm³' }, autoScale: false };

function strip(conv, extra = {}) {
  return render(
    <MetricConventions value={{ ...BASE, ...conv }} onChange={extra.onChange || (() => {})}
                       families={['mass']} banco={extra.banco || 'ibge_pevs'}
                       expanded onToggleExpanded={() => {}} />
  );
}

const opcoesDaCorrecao = (container) =>
  [...container.querySelectorAll('.mc-group-corr .seg-opt')].map(e => e.firstChild.textContent);

describe('o catálogo de correções sabe qual economia cada índice mede', () => {
  it('pareia cada índice com a economia dos preços que ele mede', () => {
    expect(window.CORRECTION_ECONOMY).toMatchObject({
      IPCA: 'BR', 'IGP-M': 'BR', 'IGP-DI': 'BR', CPI: 'US', HICP: 'EA',
    });
    // 'Nominal' não corrige nada, então não tem economia — e não pode ganhar uma por
    // descuido, senão passaria a ser tratada como uma correção pelas regras abaixo.
    expect(window.CORRECTION_ECONOMY.Nominal).toBeUndefined();
  });

  it('espelha o mapa economia → moeda que o backend usa para escolher a coluna', () => {
    expect(window.ECONOMY_CURRENCY).toEqual({ BR: 'BRL', US: 'USD', EA: 'EUR' });
    expect(window.CURRENCY_ECONOMY).toEqual({ BRL: 'BR', USD: 'US', EUR: 'EA' });
  });

  it.each([
    ['BRL', 'IPCA', true],
    ['USD', 'CPI', true],
    ['EUR', 'HICP', true],
    ['USD', 'IPCA', false],
    ['EUR', 'IGP-M', false],
    ['USD', 'Nominal', false],
  ])('deflatesOwnCurrency(%s, %s) === %s', (currency, correction, own) => {
    expect(window.deflatesOwnCurrency(currency, correction)).toBe(own);
  });
});

describe('cada moeda oferece só a inflação da própria economia', () => {
  it.each([
    ['BRL', ['Nominal', 'IPCA', 'IGP-M', 'IGP-DI']],
    ['USD', ['Nominal', 'CPI']],
    ['EUR', ['Nominal', 'HICP']],
  ])('%s oferece %j', (currency, ids) => {
    expect(window.correctionsFor(currency).map(c => c.id)).toEqual(ids);
  });

  it.each([
    ['USD', 'IPCA'], ['USD', 'IGP-M'], ['USD', 'IGP-DI'], ['USD', 'HICP'],
    ['EUR', 'IPCA'], ['EUR', 'IGP-M'], ['EUR', 'IGP-DI'], ['EUR', 'CPI'],
    ['BRL', 'CPI'], ['BRL', 'HICP'],
  ])('%s × %s não é oferecido', (currency, correction) => {
    expect(window.offeredConvention(currency, correction)).toBe(false);
  });

  it('o padrão é o Nominal, e ele é oferecido em toda moeda', () => {
    expect(window.DEFAULT_CONVENTIONS.correction).toBe('Nominal');
    for (const c of ['BRL', 'USD', 'EUR']) expect(window.offeredConvention(c, 'Nominal')).toBe(true);
  });
});

describe('clampConvention: a moeda é do usuário, a correção é que cede', () => {
  it.each([
    ['USD', 'IPCA', 'CPI'],     // link antigo de "poder de compra brasileiro em dólares"
    ['USD', 'IGP-DI', 'CPI'],
    ['EUR', 'IGP-M', 'HICP'],
    ['EUR', 'CPI', 'HICP'],     // trocou de moeda estando no CPI
    ['USD', 'HICP', 'CPI'],
    ['BRL', 'CPI', 'IPCA'],
    ['BRL', 'HICP', 'IPCA'],
  ])('%s × %s → índice da própria moeda (%s): a correção pedida continua ligada', (currency, correction, esperado) => {
    const out = window.clampConvention({ currency, correction });
    expect(out.currency).toBe(currency);
    expect(out.correction).toBe(esperado);
  });

  it('algo que não é índice nenhum cai no Nominal — sem saber o pedido, não presume correção', () => {
    expect(window.clampConvention({ currency: 'BRL', correction: 'XYZ' }).correction).toBe('Nominal');
    expect(window.clampConvention({ currency: 'USD', correction: undefined }).correction).toBe('Nominal');
  });

  it('não toca no que já é oferecido (e devolve a MESMA referência)', () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      for (const c of window.correctionsFor(currency)) {
        const conv = { currency, correction: c.id };
        expect(window.clampConvention(conv)).toBe(conv);
      }
    }
  });

  it('nunca devolve uma combinação que a faixa não oferece', () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      for (const correction of ['Nominal', 'IPCA', 'IGP-M', 'IGP-DI', 'CPI', 'HICP', 'lixo']) {
        const out = window.clampConvention({ currency, correction });
        expect(window.offeredConvention(out.currency, out.correction)).toBe(true);
      }
    }
  });

  it('tolera uma convenção ausente', () => {
    expect(window.clampConvention(null)).toBeNull();
    expect(window.clampConvention(undefined)).toBeUndefined();
  });
});

describe('conventionExplain diz o que o número É', () => {
  it('descreve câmbio do ano + inflação da própria economia para o índice estrangeiro', () => {
    const frase = window.conventionExplain({ currency: 'USD', correction: 'CPI' }, 'ibge_pevs');
    expect(frase).toContain('câmbio do ano');
    expect(frase).toContain('dos EUA');
  });

  it('num banco de aduana em US$, diz que não passa por câmbio nenhum', () => {
    // O valor do COMEX JÁ É declarado em dólares, então corrigi-lo pelo CPI não envolve
    // taxa de câmbio em ponto algum — é a leitura com menos intermediários do painel.
    const frase = window.conventionExplain({ currency: 'USD', correction: 'CPI' }, 'mdic_comex');
    expect(frase).toContain('não passa por câmbio');
  });

  it('não inventa uma conversão quando a moeda é o real', () => {
    const frase = window.conventionExplain({ currency: 'BRL', correction: 'IPCA' }, 'ibge_pevs');
    expect(frase).toBe('Corrigido pela inflação do Brasil (IPCA), em reais de hoje.');
  });

  it('diz para que serve o nominal — e para que NÃO serve — na moeda certa', () => {
    // É a primeira frase que o pesquisador lê: o painel abre no nominal.
    const reais = window.conventionExplain({ currency: 'BRL', correction: 'Nominal' }, 'ibge_pevs');
    expect(reais).toContain('reais de cada ano');
    expect(reais).toContain('não para comparar anos distantes');
    expect(window.conventionExplain({ currency: 'USD', correction: 'Nominal' }, 'mdic_comex'))
      .toContain('dólares de cada ano');
  });
});

describe('a faixa mostra só as opções da moeda e diz de que economia é a inflação', () => {
  it.each([
    ['BRL', ['Nominal', 'IPCA', 'IGP-M', 'IGP-DI'], 'inflação do Brasil'],
    ['USD', ['Nominal', 'CPI'], 'inflação dos EUA'],
    ['EUR', ['Nominal', 'HICP'], 'inflação da zona do euro'],
  ])('sob %s: %j, com a nota "%s"', (currency, ids, nota) => {
    const { container } = strip({ currency });
    expect(opcoesDaCorrecao(container)).toEqual(ids);
    expect(container.querySelector('.mc-group-corr .mc-label-note').textContent).toBe(nota);
  });

  it('não mostra botão desabilitado nenhum — o que não faz sentido simplesmente não aparece', () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      const { container, unmount } = strip({ currency });
      expect(container.querySelectorAll('.seg-opt.disabled, .seg-opt[disabled]')).toHaveLength(0);
      unmount();
    }
  });

  it('clicar no índice da moeda o seleciona', () => {
    const onChange = vi.fn();
    const { container } = strip({ currency: 'USD' }, { onChange });
    const cpi = [...container.querySelectorAll('.mc-group-corr .seg-opt')].find(e => e.firstChild.textContent === 'CPI');
    fireEvent.click(cpi);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ currency: 'USD', correction: 'CPI' }));
  });

  it.each([
    [{ currency: 'BRL', correction: 'IGP-DI' }, 'USD', 'CPI'],
    [{ currency: 'USD', correction: 'CPI' }, 'EUR', 'HICP'],
    [{ currency: 'EUR', correction: 'HICP' }, 'BRL', 'IPCA'],
    [{ currency: 'BRL', correction: 'Nominal' }, 'EUR', 'Nominal'],
  ])('trocar a moeda de %j para %s leva a correção junto (%s)', (antes, moeda, esperado) => {
    const onChange = vi.fn();
    const { container } = strip(antes, { onChange });
    const botao = [...container.querySelectorAll('.mc-block-row > .mc-group:not(.mc-group-corr) .seg-opt')]
      .find(e => e.firstChild.textContent === moeda);
    fireEvent.click(botao);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ currency: moeda, correction: esperado }));
  });

  it('imprime a frase de explicação sob os dois grupos monetários', () => {
    const { container } = strip({ currency: 'USD', correction: 'CPI' });
    const explica = container.querySelector('.mc-block-money > .mc-corr-explain');
    expect(explica.textContent).toContain('dos EUA');
  });

  it('o chip recolhido carrega a economia, não só o índice', () => {
    expect(window.correctionChip({ currency: 'USD', correction: 'CPI' })).toBe('CPI · EUA');
    expect(window.correctionChip({ currency: 'EUR', correction: 'HICP' })).toBe('HICP · zona do euro');
    expect(window.correctionChip({ currency: 'BRL', correction: 'IPCA' })).toBe('IPCA · Brasil');
    expect(window.correctionChip({ currency: 'BRL', correction: 'Nominal' })).toBe('Sem correção');
  });

  it('mostra o chip com a economia já no estado recolhido', () => {
    const { container } = render(
      <MetricConventions value={{ ...BASE, currency: 'USD', correction: 'CPI' }} onChange={() => {}}
                         families={['mass']} banco="ibge_pevs" expanded={false} onToggleExpanded={() => {}} />
    );
    const chips = [...container.querySelectorAll('.fm-chip-filter')].map(e => e.textContent);
    expect(chips.some(c => c.includes('CPI · EUA'))).toBe(true);
  });
});

describe('o painel separa VALOR MONETÁRIO de UNIDADES', () => {
  it('moeda e correção numa área, as famílias físicas na outra', () => {
    const { container } = render(
      <MetricConventions value={BASE} onChange={() => {}} families={['mass', 'volume']} banco="ibge_pevs"
                         expanded onToggleExpanded={() => {}} />
    );
    const rotulos = (sel) => [...container.querySelectorAll(`${sel} .mc-label`)].map(e => e.textContent);
    expect(rotulos('.mc-block-money')).toEqual(['Moeda', 'Correção monetária']);
    expect(rotulos('.mc-block-units')).toEqual(['Massa', 'Volume']);
  });

  it('sem valor monetário, as unidades ocupam o painel sozinhas', () => {
    window.isMonetaryBanco = () => false;
    try {
      const { container } = render(
        <MetricConventions value={BASE} onChange={() => {}} families={['mass']} banco="future_physical"
                           expanded onToggleExpanded={() => {}} />
      );
      expect(container.querySelector('.mc-block-money')).toBeNull();
      expect(container.querySelector('.mc-block-units.mc-block-solo')).toBeTruthy();
    } finally {
      delete window.isMonetaryBanco;
    }
  });
});

describe('conventionMonetaryLabel nomeia a economia quando o símbolo não basta', () => {
  it('marca um índice brasileiro sob moeda estrangeira (convenção vinda de fora da faixa)', () => {
    expect(window.conventionMonetaryLabel({ currency: 'USD', correction: 'IPCA' })).toBe('USD · IPCA (Brasil)');
  });

  it('não polui o rótulo quando o índice já é o da moeda exibida', () => {
    expect(window.conventionMonetaryLabel({ currency: 'BRL', correction: 'IPCA' })).toBe('BRL · IPCA');
    expect(window.conventionMonetaryLabel({ currency: 'USD', correction: 'CPI' })).toBe('USD · CPI');
    expect(window.conventionMonetaryLabel({ currency: 'USD', correction: 'Nominal' })).toBe('USD · nominal');
  });
});
