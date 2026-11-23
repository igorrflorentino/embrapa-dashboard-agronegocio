// productOrigin.test.js — as contagens de produtos e de linhas seguem a origem (v1.108.5).
//
// Sob um filtro de origem do PEVS (`tb=289` ou `tb=291`) os números já eram os da metade
// escolhida desde a v1.108.4, mas as contagens não: "Seleção ativa" dizia "PRODUTOS 10 / 10"
// e "LINHAS 1,4 mi de 1,4 mi", o resumo dos filtros "Todos (10)", a Visão geral "10 de 10
// produtos", e o seletor listava os 10. A regra única é `productsInOrigin`; applyFilters a
// aplica à seleção e mede o contador de linhas pelas linhas de cada produto.
//
// Fixture: os 10 produtos do PEVS, com as linhas medidas na produção em 2026-11-23
// (gold_pevs_production, contagem por tabela × produto). A base é um cubo denso, então
// todo produto de uma metade tem as mesmas linhas: 156.934 na extração, 94.891 na
// silvicultura — 1.098.538 + 284.673 = 1.383.211.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { productsInOrigin } from './productOrigin.js';

const EXTRACAO = [
  ['3403', 'Açaí (fruto)', 'mass', 't'],
  ['3404', 'Castanha-de-caju', 'mass', 't'],
  ['3405', 'Castanha-do-pará', 'mass', 't'],
  ['3433', 'Carvão vegetal', 'mass', 't'],
  ['3434', 'Lenha', 'volume', 'm³'],
  ['3435', 'Madeira em tora', 'volume', 'm³'],
  ['3450', 'Pinheiro brasileiro (madeira em tora)', 'volume', 'm³'],
].map(([code, name, family, unit]) => ({ code, name, family, unit, tabela: '289' }));
const SILVICULTURA = [
  ['3455', 'Carvão vegetal', 'mass', 't'],
  ['3456', 'Lenha', 'volume', 'm³'],
  ['3457', 'Madeira em tora', 'volume', 'm³'],
].map(([code, name, family, unit]) => ({ code, name, family, unit, tabela: '291' }));
const PEVS = [...EXTRACAO, ...SILVICULTURA];
const codigos = (lista) => lista.map((p) => p.code);

const LINHAS_EXTRACAO = 156934;     // por produto
const LINHAS_SILVICULTURA = 94891;  // por produto
const LINHAS_TOTAL = 7 * LINHAS_EXTRACAO + 3 * LINHAS_SILVICULTURA;

describe('productsInOrigin — os produtos que uma origem oferece', () => {
  it('sem origem (ausente ou "all"), todos, na ordem', () => {
    expect(productsInOrigin(PEVS, undefined)).toBe(PEVS);
    expect(productsInOrigin(PEVS, null)).toBe(PEVS);
    expect(productsInOrigin(PEVS, 'all')).toBe(PEVS);
  });

  it('com uma tabela, só os produtos dela, na ordem', () => {
    expect(codigos(productsInOrigin(PEVS, '289'))).toEqual(codigos(EXTRACAO));
    expect(codigos(productsInOrigin(PEVS, '291'))).toEqual(codigos(SILVICULTURA));
  });

  it('uma tabela que nenhum produto do banco tem não estreita nada', () => {
    // Um link editado à mão leva o `tb=289` do PEVS ao COMEX, cujos leitores ignoram a tabela
    // no servidor. Esvaziar a lista esconderia todo produto ao lado de números que são de todos.
    const comex = [{ code: '12019000', tabela: 'ncm' }, { code: '09011110', tabela: 'ncm' }];
    expect(productsInOrigin(comex, '289')).toBe(comex);
    // A mesma coisa para uma lista de antes de os produtos levarem a tabela.
    const semTabela = [{ code: 'A' }, { code: 'B' }];
    expect(productsInOrigin(semTabela, '289')).toBe(semTabela);
  });

  it('lista ausente vira lista vazia', () => {
    expect(productsInOrigin(null, '289')).toEqual([]);
    expect(productsInOrigin(undefined, 'all')).toEqual([]);
  });
});

// ── applyFilters ─────────────────────────────────────────────────────────────────────────────
// O snapshot como o servidor o devolve sob `tb=289`: a lista de produtos e a qualidade são do
// banco inteiro (as duas metades), as séries e o mapa são da extração.
function snapshotPevs({ comLinhas = true } = {}) {
  const linhasDe = (p) => (p.tabela === '289' ? LINHAS_EXTRACAO : LINHAS_SILVICULTURA);
  return {
    products: PEVS,
    productTS: Object.fromEntries(EXTRACAO.map((p) => [p.code, [
      { y: 2023, v: 100, q: 10, family: p.family },
      { y: 2024, v: 110, q: 11, family: p.family },
    ]])),
    overviewTS: [{ y: 2023, v: 0.7 }, { y: 2024, v: 0.77 }],
    ufData: [{ uf: 'PA', name: 'Pará', region: 'N', value: 500, q_mass: 50, q_vol: 5 }],
    ufYearly: [
      { year: 2023, uf: 'PA', name: 'Pará', region: 'N', value: 450, q_mass: 45, q_vol: 4 },
      { year: 2024, uf: 'PA', name: 'Pará', region: 'N', value: 500, q_mass: 50, q_vol: 5 },
    ],
    quality: [{ id: 'OK', count: LINHAS_TOTAL }],
    qualityTs: [],
    topMunis: [],
    regions: [{ id: 'N' }],
    qualityByProduct: PEVS.map((p) => ({
      code: p.code, tabela: p.tabela, name: p.name, OK: 1,
      ...(comLinhas ? { rows: linhasDe(p) } : {}),
    })),
  };
}

async function loadApplyFilters(snap) {
  vi.resetModules();
  window.dataStore = { get: () => snap };
  window.REGIONS = snap.regions;
  window.VIZ_SCALE = ['var(--viz-1)'];
  window.VALUE_PRESETS = [];
  window.MUNI_PICKER_NAMES = new Set();
  window.snapshotFor = () => null;
  await import('./dataFilters.js');
  return window.applyFilters;
}

beforeEach(() => { delete window.applyFilters; delete window.geoYearly; });
afterEach(() => { delete window.geoYearly; });

describe('applyFilters — a seleção fica dentro da origem', () => {
  it('Extração vegetal: 7 dos 10 produtos do banco, e o contador mede as linhas deles', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    const f = applyFilters({ tabela: '289' }, 'ibge_pevs');
    expect(f.selectedProducts).toEqual(codigos(EXTRACAO));
    expect(codigos(f.productUniverse)).toEqual(codigos(EXTRACAO));
    expect(f.productsTotal).toBe(10);   // o denominador do cabeçalho segue o do banco
    // 1.098.538 de 1.383.211 linhas. A fração por CONTAGEM (7/10) dava 968 mil.
    expect(f._shares.productShare).toBeCloseTo((7 * LINHAS_EXTRACAO) / LINHAS_TOTAL, 12);
    expect(Math.round(LINHAS_TOTAL * f._shares.productShare)).toBe(1098538);
  });

  it('Silvicultura: 3 produtos, 20,6% das linhas (a contagem dizia 30%)', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    const f = applyFilters({ tabela: '291' }, 'ibge_pevs');
    expect(f.selectedProducts).toEqual(codigos(SILVICULTURA));
    expect(Math.round(LINHAS_TOTAL * f._shares.productShare)).toBe(284673);
  });

  it('Ambas: todos os produtos, o banco inteiro', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    for (const summary of [{}, { tabela: 'all' }]) {
      const f = applyFilters(summary, 'ibge_pevs');
      expect(f.selectedProducts).toEqual(codigos(PEVS));
      expect(codigos(f.productUniverse)).toEqual(codigos(PEVS));
      expect(f._shares.productShare).toBe(1);
    }
  });

  it('uma cesta que cruza as metades é medida pelas linhas dela, não pela contagem', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    const f = applyFilters({ basket: ['3403', '3456'] }, 'ibge_pevs');
    expect(f._shares.productShare)
      .toBeCloseTo((LINHAS_EXTRACAO + LINHAS_SILVICULTURA) / LINHAS_TOTAL, 12);
    expect(f._shares.productShare).not.toBeCloseTo(2 / 10, 3);
  });

  it('sob a origem, a cesta só conta o que dela está na origem', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    const f = applyFilters({ tabela: '289', basket: ['3403', '3456'] }, 'ibge_pevs');
    expect(f.selectedProducts).toEqual(['3403']);
    expect(f._shares.productShare).toBeCloseTo(LINHAS_EXTRACAO / LINHAS_TOTAL, 12);
  });

  it('sem a contagem por produto (resposta de antes da v1.108.5), volta à fração por contagem', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs({ comLinhas: false }));
    const f = applyFilters({ tabela: '289' }, 'ibge_pevs');
    expect(f.selectedProducts).toEqual(codigos(EXTRACAO));
    expect(f._shares.productShare).toBeCloseTo(7 / 10, 12);
  });

  it('uma tabela que o banco não tem não esvazia a seleção', async () => {
    const comex = {
      ...snapshotPevs(),
      products: [{ code: '12019000', name: 'Soja', tabela: 'ncm' }, { code: '09011110', name: 'Café', tabela: 'ncm' }],
      qualityByProduct: [
        { code: '12019000', tabela: 'ncm', name: 'Soja', rows: 30000, OK: 1 },
        { code: '09011110', tabela: 'ncm', name: 'Café', rows: 10000, OK: 1 },
      ],
    };
    const applyFilters = await loadApplyFilters(comex);
    const f = applyFilters({ tabela: '289' }, 'mdic_comex');
    expect(f.selectedProducts).toEqual(['12019000', '09011110']);
    expect(f._shares.productShare).toBe(1);
  });
});

describe('applyFilters — o cubo da cesta sob uma origem', () => {
  const cubo = (rows) => vi.fn(() => ({ rows, priceBase: null, loading: false, loadError: null }));

  it('uma cesta só com produtos da outra metade pede o cubo, e o vazio que volta é a resposta', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    window.geoYearly = cubo([]);
    const f = applyFilters({ tabela: '289', basket: codigos(SILVICULTURA) }, 'ibge_pevs');
    expect(f.selectedProducts).toEqual([]);
    expect(window.geoYearly).toHaveBeenCalled();
    // O mapa do snapshot é o da extração inteira, e não pode aparecer sob uma cesta vazia.
    expect(f.ufData).toEqual([]);
    expect(f.ts.map((d) => d.v)).toEqual([null, null]);
  });

  it('uma cesta com todos os produtos da extração não estreita nada: sem cubo, o mapa do snapshot', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    window.geoYearly = cubo([]);
    const f = applyFilters({ tabela: '289', basket: codigos(EXTRACAO) }, 'ibge_pevs');
    expect(window.geoYearly).not.toHaveBeenCalled();
    expect(f.notFilteredByBasket).toBe(false);
    expect(f.ufData.map((u) => u.value)).toEqual([500]);
  });

  it('sem origem a regra é a de sempre: um subconjunto pede o cubo, a cesta inteira não', async () => {
    const applyFilters = await loadApplyFilters(snapshotPevs());
    window.geoYearly = cubo([]);
    applyFilters({ basket: codigos(PEVS) }, 'ibge_pevs');
    expect(window.geoYearly).not.toHaveBeenCalled();
    applyFilters({ basket: ['3403', '3456'] }, 'ibge_pevs');
    expect(window.geoYearly).toHaveBeenCalled();
  });
});
