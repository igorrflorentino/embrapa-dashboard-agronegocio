// ufCoverage.test.jsx — the per-UF rows of the map year, and "UFs cobertas" · "Anos cobertos"
// (the hero's SELEÇÃO ATIVA) with the coverage line of the Visão geral quality card: ONE count,
// made by applyFilters over the grid that honours the selection (v1.108.21).
//
// Two defects, measured on prod (2026-11-27) and reproduced here on a miniature analytic base:
//  1. With no basket, the per-UF rows were the snapshot's, which are the banco's LATEST year
//     whatever the period. PAM over 1990–2000 drew Mato Grosso at R$ 133 bi under "· 2000"
//     (its 2025 value; R$ 3,07 bi that year), in the Visão geral, Geografia and Concentração
//     maps alike, and "UFs cobertas" counted 2025's UFs.
//  2. Under a basket the counter did not wait for the basket's cube: PAM's açaí over 1990–2000
//     read "27 / 27", the whole banco's, until the cube landed, and for good when it failed.
//     The card counted on its own, with the same two faults.
// And one criterion, a product decision (2026-11-27): what the recorte covers is where and when
// it had PRODUCTION — a value or a quantity above zero — in some year of the period. "UFs
// cobertas" counted the UFs with a value in the map year, and "Anos cobertos" the years with rows,
// so PAM's açaí × RS read "UFs 0 / 27 · Anos 11 / 52" (RS: a zero row for each município, every
// year).
//
// The base is Gold rows, one per (product, UF, year), and the reads are DERIVED from it as the
// server derives them: the per-product series, the all-products UF × year grid, the snapshot's
// per-UF rows (that grid's latest year, flagged `real` by the server) and the basket's cube.
// Every expectation is computed from the base (`valorPorUf`, `ufsComProducao`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
// The REAL engine and the modules the overview reads, as ViewOverview.test.jsx loads them.
import './dataFilters.js';
import './RecorteNote.jsx';
import './filtersSchema.js';
import './countUnits.js';

// ── The miniature analytic base ──────────────────────────────────────────────────────────────
const PRODUTOS = [
  { code: 'MILHO', name: 'Milho', family: 'mass', unit: 't', tabela: '5457' },
  { code: 'ACAI', name: 'Açaí', family: 'mass', unit: 't', tabela: '5457' },
  { code: 'CAFE', name: 'Café', family: 'mass', unit: 't', tabela: '5457' },
];
const ANOS = [1999, 2000, 2025];
const TILES = [
  { uf: 'PA', name: 'Pará', region: 'N', col: 1, row: 1 },
  { uf: 'MT', name: 'Mato Grosso', region: 'CO', col: 1, row: 2 },
  { uf: 'SP', name: 'São Paulo', region: 'SE', col: 2, row: 3 },
  { uf: 'RS', name: 'Rio Grande do Sul', region: 'S', col: 2, row: 4 },
];
const REGIOES = [{ id: 'N' }, { id: 'CO' }, { id: 'SE' }, { id: 'S' }];
// A zero row is a cell the municipal survey publishes empty: a Gold row, not production.
const GOLD = [
  // Mato Grosso: rows with no production in 1999 and 2000, production only in 2025.
  { code: 'MILHO', uf: 'MT', year: 1999, value: 0, q: 0 },
  { code: 'MILHO', uf: 'MT', year: 2000, value: 0, q: 0 },
  { code: 'MILHO', uf: 'MT', year: 2025, value: 133, q: 50 },
  { code: 'MILHO', uf: 'SP', year: 1999, value: 10, q: 4 },
  { code: 'MILHO', uf: 'SP', year: 2000, value: 12, q: 5 },
  { code: 'MILHO', uf: 'SP', year: 2025, value: 106, q: 40 },
  { code: 'MILHO', uf: 'RS', year: 2000, value: 20, q: 8 },
  { code: 'MILHO', uf: 'RS', year: 2025, value: 30, q: 9 },
  { code: 'MILHO', uf: 'PA', year: 2000, value: 1, q: 1 },
  { code: 'MILHO', uf: 'PA', year: 2025, value: 2, q: 1 },
  // Açaí: produced in Pará; Rio Grande do Sul has its rows every year and no production
  // (açaí × RS on prod: 496 rows a year, every one zero).
  { code: 'ACAI', uf: 'PA', year: 2000, value: 5, q: 2 },
  { code: 'ACAI', uf: 'PA', year: 2025, value: 8, q: 3 },
  { code: 'ACAI', uf: 'RS', year: 1999, value: 0, q: 0 },
  { code: 'ACAI', uf: 'RS', year: 2000, value: 0, q: 0 },
  { code: 'ACAI', uf: 'RS', year: 2025, value: 0, q: 0 },
  // Café: Pará produced it in 1999 and has a zero row in 2000, the map year of 1999–2000;
  // São Paulo has a quantity and no value (PEVS's pinheiro brasileiro in 2025, on prod: 3 UFs
  // with a quantity, none with a value). Both UFs also have milho in 2000, so the counts with no
  // basket stay those of milho.
  { code: 'CAFE', uf: 'PA', year: 1999, value: 9, q: 3 },
  { code: 'CAFE', uf: 'PA', year: 2000, value: 0, q: 0 },
  { code: 'CAFE', uf: 'SP', year: 2000, value: 0, q: 2 },
];
const TODOS = PRODUTOS.map((p) => p.code);

// The oracles: sums and distinct UFs over GOLD with the recorte.
function linhasGold({ codes = TODOS, y0 = -Infinity, y1 = Infinity, ufs = null }) {
  return GOLD.filter((r) => codes.includes(r.code) && r.year >= y0 && r.year <= y1
    && (!ufs || ufs.includes(r.uf)));
}
const valorPorUf = (recorte) => linhasGold(recorte)
  .reduce((m, r) => ({ ...m, [r.uf]: (m[r.uf] || 0) + r.value }), {});
const ufsComProducao = (recorte) => new Set(
  linhasGold(recorte).filter((r) => r.value > 0 || r.q > 0).map((r) => r.uf)).size;

function agrupar(linhas, chave) {
  const m = new Map();
  for (const r of linhas) m.set(chave(r), [...(m.get(chave(r)) || []), r]);
  return [...m.values()];
}
const soma = (g, k) => g.reduce((s, r) => s + r[k], 0);
// The UF × year grid of some rows (all products: the snapshot's; the basket's: its cube).
const grade = (linhas) => agrupar(linhas, (r) => `${r.uf}|${r.year}`).map((g) => {
  const tile = TILES.find((t) => t.uf === g[0].uf);
  return { year: g[0].year, uf: g[0].uf, name: tile.name, region: tile.region,
           value: soma(g, 'value'), q_mass: soma(g, 'q'), q_vol: 0,
           q_count_stock: 0, q_count_flow: 0, rows: g.length };
});

function snapshot() {
  const productTS = {};
  for (const g of agrupar(GOLD, (r) => `${r.code}|${r.year}`)) {
    (productTS[g[0].code] ||= []).push(
      { y: g[0].year, v: soma(g, 'value'), q: soma(g, 'q'), family: 'mass', rows: g.length });
  }
  const ufYearly = grade(GOLD);
  const ultimo = Math.max(...ufYearly.map((r) => r.year));
  return {
    products: PRODUTOS,
    productTS,
    overviewTS: ANOS.map((y) => ({ y, v: 1 })),
    // The snapshot's per-UF rows: the grid's LATEST year, as the server sends them and
    // decorate.js dresses them (tile position, `real`).
    ufData: ufYearly.filter((r) => r.year === ultimo).map(({ year: _y, rows: _n, ...r }) => {
      const tile = TILES.find((t) => t.uf === r.uf);
      return { ...r, col: tile.col, row: tile.row, real: true };
    }),
    ufYearly,
    quality: [{ id: 'OK', label: 'OK', color: 'var(--ok)', count: GOLD.length, share: 1 }],
    qualityTs: [],
    topMunis: [],
    regions: REGIOES,
    qualityByProduct: PRODUTOS.map((p) => ({
      code: p.code, tabela: p.tabela, name: p.name, rows: GOLD.filter((r) => r.code === p.code).length,
    })),
  };
}

// The basket's cube (window.geoYearly): ready, on its way, or failed.
function instalarCubo(estado = 'pronto') {
  window.geoYearly = (banco, summary) => {
    if (estado === 'carregando') return { rows: null, priceBase: null, loading: true, loadError: null };
    if (estado === 'falha') return { rows: null, priceBase: null, loading: false, loadError: 'HTTP 503' };
    return { rows: grade(GOLD.filter((r) => summary.basket.includes(r.code))),
             priceBase: null, loading: false, loadError: null };
  };
}

const GLOBAIS = ['dataStore', 'snapshotFor', 'UF_DATA', 'REGIONS', 'VIZ_SCALE', 'isCanonicalUf',
  'geoYearly', 'municipioYearly', 'geoMeshState'];
let guardados;
beforeEach(() => {
  guardados = Object.fromEntries(GLOBAIS.map((k) => [k, window[k]]));
  const snap = snapshot();
  window.dataStore = { get: () => snap, meta: () => ({ prov: { yearsTotal: ANOS.length } }) };
  window.snapshotFor = () => null;
  window.UF_DATA = TILES;
  window.REGIONS = REGIOES;
  window.VIZ_SCALE = ['var(--viz-1)'];
  window.isCanonicalUf = (uf) => TILES.some((t) => t.uf === uf);
  instalarCubo();
});
afterEach(() => {
  cleanup();
  Object.assign(window, guardados);
});

const af = (summary) => window.applyFilters(summary, 'ibge_pam');
const PERIODO_ANTIGO = { startDate: '1999-01-01', endDate: '2000-12-01' };

// ── 1. The map year's rows ───────────────────────────────────────────────────────────────────
describe('applyFilters — sem cesta, as linhas por UF são as do ano do mapa', () => {
  it('1999–2000: as de 2000, e não as de 2025 que o resumo traz', () => {
    const f = af(PERIODO_ANTIGO);
    expect(f.ufLatestYear).toBe(2000);
    const valor = Object.fromEntries(f.ufData.map((u) => [u.uf, u.value]));
    expect(valor).toEqual(valorPorUf({ y0: 2000, y1: 2000 }));
    expect(valor.MT).toBe(0);
    // What the snapshot's rows say, and the map used to draw under "2000": Mato Grosso's 2025.
    expect(window.dataStore.get().ufData.find((u) => u.uf === 'MT').value).toBe(133);
  });

  it('as regiões somam o ano do mapa', () => {
    const f = af(PERIODO_ANTIGO);
    const regiao = Object.fromEntries(f.regionData.map((r) => [r.id, r.value]));
    const v2000 = valorPorUf({ y0: 2000, y1: 2000 });
    expect(regiao).toEqual({ N: v2000.PA, CO: v2000.MT, SE: v2000.SP, S: v2000.RS });
  });

  it('cada linha leva a posição do mosaico e o nome, como as do resumo', () => {
    const pa = af(PERIODO_ANTIGO).ufData.find((u) => u.uf === 'PA');
    expect(pa).toMatchObject({ name: 'Pará', region: 'N', col: 1, row: 1 });
  });

  it('um período que termina no último ano: as próprias linhas do resumo, com a marca `real`', () => {
    const f = af({ startDate: '1999-01-01', endDate: '2025-12-01' });
    expect(f.ufLatestYear).toBe(2025);
    expect(f.ufData).toEqual(window.dataStore.get().ufData);
  });

  it('um período sem linha na grade: nenhuma UF, e não as de 2025', () => {
    const f = af({ startDate: '1980-01-01', endDate: '1990-12-01' });
    expect(f.ufData).toEqual([]);
  });
});

// ── 2. One count, held while its grid is on its way ─────────────────────────────────────────
describe('applyFilters — "UFs cobertas" espera a grade que honra a seleção', () => {
  it('cesta com o cubo a caminho: nenhum número, carregando', () => {
    instalarCubo('carregando');
    const f = af({ basket: ['ACAI'] });
    expect(f.ufsCovered).toBeNull();
    expect(f.ufsCoveredLoading).toBe(true);
    expect(f.ufsCoveredLoadError).toBeNull();
  });

  it('cesta com o cubo em falha: nenhum número, e a falha', () => {
    instalarCubo('falha');
    const f = af({ basket: ['ACAI'] });
    expect(f.ufsCovered).toBeNull();
    expect(f.ufsCoveredLoading).toBe(false);
    expect(f.ufsCoveredLoadError).toBe('HTTP 503');
  });

  it('cesta × UF: espera e falha do mesmo jeito', () => {
    instalarCubo('carregando');
    expect(af({ basket: ['ACAI'], states: ['RS'] })).toMatchObject(
      { ufsCovered: null, ufsCoveredLoading: true, ufsCoveredLoadError: null });
    instalarCubo('falha');
    expect(af({ basket: ['ACAI'], states: ['RS'] })).toMatchObject(
      { ufsCovered: null, ufsCoveredLoading: false, ufsCoveredLoadError: 'HTTP 503' });
  });

  it('cubo pronto: as UFs onde a cesta produz, não as que só têm linhas', () => {
    const f = af({ basket: ['ACAI'] });
    expect(f.ufsCovered).toBe(ufsComProducao({ codes: ['ACAI'] }));
    expect(f.ufsCovered).toBe(1); // Pará; Rio Grande do Sul has rows and no production
    expect(f.ufsCoveredLoading).toBe(false);
  });

  it('sem cesta, 1999–2000: as UFs com produção no período, sem Mato Grosso', () => {
    const f = af(PERIODO_ANTIGO);
    expect(f.ufsCovered).toBe(ufsComProducao({ y0: 1999, y1: 2000 }));
    expect(f.ufsCovered).toBe(3);
  });

  it('sem produto escolhido: nenhuma UF', () => {
    expect(af({ basket: [] }).ufsCovered).toBe(0);
  });

  it('o denominador: as UFs reais do banco em toda a sua história', () => {
    expect(af(PERIODO_ANTIGO).ufsTotal).toBe(TILES.length);
  });
});

// ── 3. The criterion: production in some year of the period ─────────────────────────────────
describe('applyFilters — cobre onde e quando houve produção, em valor ou quantidade', () => {
  it('açaí × RS: linhas em todo ano, nenhuma produção; nenhuma UF e nenhum ano', () => {
    const f = af({ basket: ['ACAI'], states: ['RS'] });
    expect(f.yearsWithRows).toEqual(ANOS); // the zero rows "Linhas" counts
    expect(f.ufsCovered).toBe(ufsComProducao({ codes: ['ACAI'], ufs: ['RS'] }));
    expect(f.ufsCovered).toBe(0);
    expect(f.yearsCovered).toEqual([]);
  });

  it('uma UF que produziu no período e não no ano do mapa conta', () => {
    const f = af({ basket: ['CAFE'], states: ['PA'], ...PERIODO_ANTIGO });
    expect(f.ufLatestYear).toBe(2000);
    expect(f.ufData.find((u) => u.uf === 'PA').value).toBe(0); // the map's year: nothing
    expect(f.ufsCovered).toBe(ufsComProducao({ codes: ['CAFE'], ufs: ['PA'], y0: 1999, y1: 2000 }));
    expect(f.ufsCovered).toBe(1);
    expect(f.yearsCovered).toEqual([1999]);
  });

  it('uma quantidade sem valor é produção, para a UF e para o ano', () => {
    const f = af({ basket: ['CAFE'], states: ['SP'], ...PERIODO_ANTIGO });
    expect(f.ufsCovered).toBe(1);
    expect(f.yearsCovered).toEqual([2000]);
    // Nationally too: 2000 has no value anywhere, and São Paulo's quantity.
    const br = af({ basket: ['CAFE'], ...PERIODO_ANTIGO });
    expect(br.ts.find((d) => d.y === 2000).v).toBe(0);
    expect(br.yearsCovered).toEqual([1999, 2000]);
    expect(br.ufsCovered).toBe(ufsComProducao({ codes: ['CAFE'], y0: 1999, y1: 2000 }));
    expect(br.ufsCovered).toBe(2);
  });

  it('os anos seguram onde "Linhas" segura, e sem produto escolhido são nenhum', () => {
    instalarCubo('carregando');
    expect(af({ basket: ['ACAI'], states: ['RS'] }).yearsCovered).toBeNull();
    expect(af({ basket: [] }).yearsCovered).toEqual([]);
  });
});

// ── 4. On screen: the hero and the card, one number ─────────────────────────────────────────
// MainScreen renders the hero AND the active view, here the REAL ViewOverview, both on the REAL
// applyFilters: what the researcher sees side by side.
describe('a faixa e o cartão da Visão geral mostram o mesmo número', () => {
  let MainScreen;
  beforeEach(async () => {
    await import('./data.js'); // the real QUALITY_FLAGS
    await import('./ViewOverview.jsx');
    await import('./MainScreen.jsx');
    MainScreen = window.MainScreen;
    Object.assign(window, {
      BANCOS: [{ id: 'ibge_pam', short: 'IBGE PAM', sub: 'Lavouras', status: 'live', maturity: 'estavel', prov: {} }],
      VIEW_GROUPS: [{ id: 'aggregate', label: 'Análise agregada', views: [{ id: 'overview', label: 'Visão geral' }] }],
      GLOSSARY: {},
      bancoById: () => window.BANCOS[0],
      bancoTable: (id) => `gold_${id}`,
      bancoMeta: () => ({ domain: 'Produção', source: 'IBGE', maturityDate: null }),
      familiesInBasket: () => ['mass'],
      missingCapsLabel: () => '—',
      bancosSupporting: () => window.BANCOS,
      fmtRows: (n) => (n == null ? '—' : String(n)),
      DEFAULT_CONVENTIONS: { currency: 'BRL', correction: 'Nominal' },
      DEFAULT_CROSS_STATE: { series: [] },
      viewById: (id) => ({ id, label: id, group: { label: 'grupo' }, status: 'live' }),
      viewComponent: () => window.ViewOverview,
      viewAppliesTo: () => ({ applies: true, missing: [] }),
      MaturityBanner: () => null,
      MaturityTag: () => null,
      UsageTag: () => null,
      conventionMonetaryLabel: () => 'R$',
      valueAxisLabel: () => 'R$',
      canonCurrencyFor: () => 'BRL',
      convFactorFor: () => 1,
      formatValue: (v) => `val:${v}`,
      formatMassQty: (v) => `mass:${v}`,
      formatVolumeQty: (v) => `vol:${v}`,
      formatCountQty: (v) => `count:${v}`,
      fmtSigned: () => '+0%',
      fmtPct: (x) => `${Math.round((x || 0) * 100)}%`,
      convertSeries: (s) => s,
      scaleSeries: (data, _max, _conv, _key, label) => ({ data, label }),
      KpiCardSpark: ({ label, value }) => <div className="kpi"><span>{label}</span><span>{value}</span></div>,
      SectionHeader: ({ title }) => <div className="sh-title">{title}</div>,
      UnitFamilyBanner: () => null,
      UnitFamilyTag: () => null,
      // Under a UF subset the composition card notes it is national here (no product × UF read).
      NotApplicableNote: () => null,
      LineChart: () => null,
      Donut: () => null,
      BrazilTileMap: () => null,
    });
  });

  const tela = (filters) => render(
    <MainScreen filters={filters} database="ibge_pam" view="overview" />).container;
  const faixa = (c) => [...c.querySelectorAll('.meta-row')]
    .find((e) => e.querySelector('.meta-label')?.textContent === 'UFs cobertas')
    .querySelector('.meta-val');
  const cartao = (c) => [...c.querySelectorAll('.sh-title')]
    .find((e) => e.textContent.startsWith('Cobertura geográfica da seleção')).textContent;
  const anos = (c) => [...c.querySelectorAll('.meta-row')]
    .find((e) => e.querySelector('.meta-label')?.textContent === 'Anos cobertos')
    .querySelector('.meta-val');

  it('sem cesta, 1999–2000: as 3 UFs com produção, e não as 4 de 2025', () => {
    const c = tela(PERIODO_ANTIGO);
    expect(faixa(c).textContent).toBe('3 / 4');
    expect(cartao(c)).toBe('Cobertura geográfica da seleção: 3 / 4 UFs');
  });

  it('cesta com o cubo a caminho: "…" nos dois, e a dica diz o que falta', () => {
    instalarCubo('carregando');
    const c = tela({ basket: ['ACAI'] });
    expect(faixa(c).textContent).toBe('… / 4');
    expect(faixa(c).getAttribute('title'))
      .toBe('A distribuição por UF da cesta selecionada ainda está carregando.');
    expect(cartao(c)).toBe('Cobertura geográfica da seleção: … / 4 UFs');
  });

  it('cesta com o cubo em falha: "—" nos dois, e a dica diz que não carregou', () => {
    instalarCubo('falha');
    const c = tela({ basket: ['ACAI'] });
    expect(faixa(c).textContent).toBe('— / 4');
    expect(faixa(c).getAttribute('title'))
      .toBe('Não foi possível carregar a distribuição por UF da cesta selecionada.');
    expect(cartao(c)).toBe('Cobertura geográfica da seleção: — / 4 UFs');
  });

  it('contraprova: o cubo pronto mostra o número nos dois', () => {
    const c = tela({ basket: ['ACAI'] });
    expect(faixa(c).textContent).toBe('1 / 4');
    expect(cartao(c)).toBe('Cobertura geográfica da seleção: 1 / 4 UFs');
  });

  // The criterion on screen. Both read differently on main: "Anos cobertos 3 / 3" beside
  // "UFs 0 / 4" for açaí × RS (the years with rows), and "0 / 4" for café (no value in 2000).
  it('açaí × RS: nenhuma UF e nenhum ano, e não os anos das linhas zeradas', () => {
    const c = tela({ basket: ['ACAI'], states: ['RS'] });
    expect(anos(c).textContent).toBe('0 / 3');
    expect(anos(c).getAttribute('title'))
      .toBe('Nenhum ano com valor ou quantidade acima de zero neste recorte.');
    expect(faixa(c).textContent).toBe('0 / 4');
    expect(faixa(c).getAttribute('title'))
      .toBe('Nenhuma UF com valor ou quantidade acima de zero no período.');
    expect(cartao(c)).toBe('Cobertura geográfica da seleção: 0 / 4 UFs');
  });

  it('café, 1999–2000: a UF que produziu antes do ano do mapa e a que só tem quantidade', () => {
    const c = tela({ basket: ['CAFE'], ...PERIODO_ANTIGO });
    expect(faixa(c).textContent).toBe('2 / 4');
    expect(faixa(c).getAttribute('title'))
      .toBe('2 UFs com valor ou quantidade acima de zero em algum ano do período.');
    expect(anos(c).textContent).toBe('2 / 3');
    expect(cartao(c)).toBe('Cobertura geográfica da seleção: 2 / 4 UFs');
  });
});
