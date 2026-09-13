// correctionEconomy.test.jsx — a correção acontece em ALGUMA economia, e a tela tem de
// dizer em qual.
//
// O defeito que este arquivo guarda não era um número errado: era um número certo com
// rótulo errado. "US$ · IPCA" produz val_real_ipca_usd, que é real deflacionado pelo
// IPCA e convertido ao câmbio de HOJE — poder de compra brasileiro, apresentado em
// dólares. Lido de relance, porém, a faixa afirmava que dólares estavam sendo corrigidos
// por inflação brasileira, que não é uma operação que exista. A partir da v1.82.0 existe
// também val_real_cpi_usd, que converte pelo câmbio do ANO e corrige pelo CPI: outra
// pergunta, outro número, e agora as duas cabem na mesma faixa — o que só é seguro se a
// faixa as distinguir.
//
// Por isso os testes abaixo verificam TRÊS coisas e não só a terceira:
//   1. que as duas leituras continuam sendo convenções distintas (não uma renomeando a
//      outra);
//   2. que um índice nunca pode ser oferecido para uma moeda que ele não mede;
//   3. que o que aparece na tela — banda, frase, chip — nomeia a economia.

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

const BASE = { currency: 'BRL', correction: 'IPCA', units: { mass: 't', volume: 'm³' }, autoScale: false };

function strip(conv, extra = {}) {
  return render(
    <MetricConventions value={{ ...BASE, ...conv }} onChange={extra.onChange || (() => {})}
                       families={['mass']} banco={extra.banco || 'ibge_pevs'}
                       expanded onToggleExpanded={() => {}} />
  );
}

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

describe('um índice só é oferecido para a moeda que ele mede', () => {
  it.each([
    ['BRL', 'CPI'],
    ['BRL', 'HICP'],
    ['EUR', 'CPI'],
    ['USD', 'HICP'],
  ])('%s × %s não é servível', (currency, correction) => {
    expect(window.servableConvention(currency, correction)).toBe(false);
    // …e o motivo explica a REGRA, não só a ausência: quem lê tem de aprender que o
    // índice pertence a uma moeda, senão volta a tentar a mesma combinação.
    expect(window.unservableReason(currency, correction)).toMatch(/mede os preços/);
  });

  it('mantém servível o que o mart realmente carrega', () => {
    for (const c of ['BRL', 'USD', 'EUR']) expect(window.servableConvention(c, 'Nominal')).toBe(true);
    for (const c of ['BRL', 'USD', 'EUR']) expect(window.servableConvention(c, 'IPCA')).toBe(true);
    expect(window.servableConvention('USD', 'CPI')).toBe(true);
    expect(window.servableConvention('EUR', 'HICP')).toBe(true);
    // A lacuna antiga (não há val_real_{igpm,igpdi}_usd) continua valendo.
    expect(window.servableConvention('USD', 'IGP-M')).toBe(false);
    expect(window.servableConvention('EUR', 'IGP-DI')).toBe(true);
  });
});

describe('clampConvention substitui pela INTENÇÃO, não pelo padrão', () => {
  it('troca de moeda mantendo "corrigir pela própria moeda"', () => {
    // Quem estava em US$ · CPI pediu a inflação da própria moeda. Ao ir para o euro, a
    // resposta equivalente é o HICP — cair no IPCA devolveria justamente a leitura que
    // essa pessoa escolheu não usar.
    expect(window.clampConvention({ currency: 'EUR', correction: 'CPI' }).correction).toBe('HICP');
    expect(window.clampConvention({ currency: 'USD', correction: 'HICP' }).correction).toBe('CPI');
  });

  it('cai no IPCA quando não existe índice próprio para a moeda', () => {
    // Não há índice "do real" entre os estrangeiros, então R$ × CPI volta ao IPCA —
    // que é, de fato, a inflação do real.
    expect(window.clampConvention({ currency: 'BRL', correction: 'CPI' }).correction).toBe('IPCA');
  });

  it('mantém o comportamento antigo para um índice brasileiro sem coluna em US$', () => {
    // Aqui a medição (preços do Brasil) sobrevive à troca, então o IPCA é o vizinho certo.
    expect(window.clampConvention({ currency: 'USD', correction: 'IGP-M' }).correction).toBe('IPCA');
    expect(window.clampConvention({ currency: 'USD', correction: 'IGP-DI' }).correction).toBe('IPCA');
  });

  it('nunca devolve uma combinação que o servidor teria de substituir por baixo', () => {
    for (const currency of ['BRL', 'USD', 'EUR']) {
      for (const c of window.CORRECTIONS) {
        const out = window.clampConvention({ currency, correction: c.id });
        expect(window.servableConvention(out.currency, out.correction)).toBe(true);
        expect(out.currency).toBe(currency); // a moeda é do usuário; a correção é que cede
      }
    }
  });
});

describe('conventionExplain diz o que o número É', () => {
  it('nega explicitamente a leitura errada quando o índice é brasileiro e a moeda não', () => {
    const frase = window.conventionExplain({ currency: 'USD', correction: 'IPCA' }, 'ibge_pevs');
    expect(frase).toContain('BRASIL');
    expect(frase).toContain('câmbio de hoje');
    // A negativa é o ponto: sem ela o leitor completa a frase sozinho, e completa errado.
    expect(frase).toContain('não é a inflação dos EUA');
  });

  it('descreve a ordem inversa para o índice da própria moeda', () => {
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
    expect(frase).toBe('Deflacionado pelo IPCA: reais de hoje.');
  });

  it('diz para que serve o nominal, na moeda certa', () => {
    expect(window.conventionExplain({ currency: 'USD', correction: 'Nominal' }, 'mdic_comex'))
      .toContain('dólares de cada ano');
    expect(window.conventionExplain({ currency: 'BRL', correction: 'Nominal' }, 'ibge_pevs'))
      .toContain('reais de cada ano');
  });

  it('dá frases DIFERENTES para as duas leituras sob o mesmo símbolo', () => {
    const viaBrasil = window.conventionExplain({ currency: 'USD', correction: 'IPCA' }, 'ibge_pevs');
    const viaEua = window.conventionExplain({ currency: 'USD', correction: 'CPI' }, 'ibge_pevs');
    expect(viaBrasil).not.toBe(viaEua);
  });
});

describe('a faixa mostra as bandas, a frase e o chip', () => {
  it('separa as correções em bandas por economia', () => {
    const { container } = strip({ currency: 'USD', correction: 'CPI' });
    const bandas = [...container.querySelectorAll('.mc-corr-band-label')].map(e => e.textContent);
    expect(bandas).toEqual([
      'Sem correção',
      'Inflação do Brasil · câmbio de hoje',
      'Inflação da própria moeda · câmbio do ano',
    ]);
  });

  it('não anuncia uma conversão que não acontece quando a moeda é o real', () => {
    const { container } = strip({ currency: 'BRL' });
    const bandas = [...container.querySelectorAll('.mc-corr-band-label')].map(e => e.textContent);
    expect(bandas).toContain('Inflação do Brasil');
    expect(bandas.join(' ')).not.toContain('Inflação do Brasil · câmbio de hoje');
  });

  it('desabilita o CPI e o HICP sob R$, com o motivo no title', () => {
    const { container } = strip({ currency: 'BRL' });
    const desabilitados = [...container.querySelectorAll('.seg-opt.disabled')];
    const ids = desabilitados.map(e => e.textContent);
    expect(ids.join(' ')).toContain('CPI');
    expect(ids.join(' ')).toContain('HICP');
    const cpi = desabilitados.find(e => e.textContent.startsWith('CPI'));
    expect(cpi.getAttribute('title')).toMatch(/mede os preços dos EUA/);
  });

  it('sob US$ o CPI fica clicável e o HICP não', () => {
    const onChange = vi.fn();
    const { container } = strip({ currency: 'USD' }, { onChange });
    const botao = (id) => [...container.querySelectorAll('.seg-opt')].find(e => e.textContent.startsWith(id));
    expect(botao('CPI').classList.contains('disabled')).toBe(false);
    expect(botao('HICP').classList.contains('disabled')).toBe(true);
    fireEvent.click(botao('CPI'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ correction: 'CPI' }));
  });

  it('imprime a frase de explicação junto do grupo', () => {
    const { container } = strip({ currency: 'USD', correction: 'IPCA' });
    const explica = container.querySelector('.mc-corr-explain');
    expect(explica.textContent).toContain('não é a inflação dos EUA');
  });

  it('o chip recolhido carrega a economia, não só o índice', () => {
    expect(window.correctionChip({ currency: 'USD', correction: 'IPCA' })).toBe('IPCA · Brasil');
    expect(window.correctionChip({ currency: 'USD', correction: 'CPI' })).toBe('CPI · EUA');
    expect(window.correctionChip({ currency: 'EUR', correction: 'HICP' })).toBe('HICP · zona do euro');
    expect(window.correctionChip({ currency: 'BRL', correction: 'Nominal' })).toBe('Sem correção');
  });

  it('mostra o chip com a economia já no estado recolhido', () => {
    const { container } = render(
      <MetricConventions value={{ ...BASE, currency: 'USD', correction: 'IPCA' }} onChange={() => {}}
                         families={['mass']} banco="ibge_pevs" expanded={false} onToggleExpanded={() => {}} />
    );
    const chips = [...container.querySelectorAll('.fm-chip-filter')].map(e => e.textContent);
    expect(chips.some(c => c.includes('IPCA · Brasil'))).toBe(true);
  });
});

describe('conventionMonetaryLabel nomeia a economia quando o símbolo não basta', () => {
  it('marca o índice brasileiro sob moeda estrangeira', () => {
    expect(window.conventionMonetaryLabel({ currency: 'USD', correction: 'IPCA' })).toBe('USD · IPCA (Brasil)');
    expect(window.conventionMonetaryLabel({ currency: 'EUR', correction: 'IGP-M' })).toBe('EUR · IGP-M (Brasil)');
  });

  it('não polui o rótulo quando o índice já é o da moeda exibida', () => {
    expect(window.conventionMonetaryLabel({ currency: 'BRL', correction: 'IPCA' })).toBe('BRL · IPCA');
    expect(window.conventionMonetaryLabel({ currency: 'USD', correction: 'CPI' })).toBe('USD · CPI');
    expect(window.conventionMonetaryLabel({ currency: 'USD', correction: 'Nominal' })).toBe('USD · nominal');
  });
});
