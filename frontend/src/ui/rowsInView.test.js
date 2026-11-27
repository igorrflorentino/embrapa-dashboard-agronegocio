// rowsInView.test.js — o contador "Linhas" CONTA as linhas do recorte (v1.108.9).
//
// Até a v1.108.8 ele estimava: o total do banco vezes a fração dos produtos, a dos anos e a
// das UFs. A fração dos anos supõe que todo produto tem linhas em todo ano, e não tem: o açaí
// da PAM começa em 2015, e o recorte açaí × 1990–2000 lia milhares de linhas num período em que
// ele não tem linha alguma. Agora cada leitura por trás da série da tela devolve as linhas da
// base analítica que cada ponto soma (`rows`), e applyFilters as soma sobre exatamente o que a
// série soma.
//
// A fixture é uma base analítica em miniatura (GOLD, uma linha por registro), e as leituras são
// DERIVADAS dela como o servidor as deriva: a série por produto, a grade UF × ano, o cubo da
// cesta e o cubo por município, cada ponto com a sua contagem. Toda expectativa é um
// `count(*)` sobre GOLD com o recorte — a mesma conta que se faz na produção para conferir.
//
// "Anos cobertos" sai das mesmas contagens (v1.108.15): `yearsWithRows`, os anos da série que
// levam linhas, conferidos contra `count(distinct year)` sobre GOLD (os blocos do fim).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── A base analítica em miniatura ────────────────────────────────────────────────────────────
const CIDADES = [
  { cityCode: 'c1', cityName: 'Portel', uf: 'PA', meso: { code: 'M1' }, micro: { code: 'mi1' },
    intermediaria: { code: 'I1' }, imediata: { code: 'im1' } },
  { cityCode: 'c2', cityName: 'Breves', uf: 'PA', meso: { code: 'M1' }, micro: { code: 'mi2' },
    intermediaria: { code: 'I1' }, imediata: { code: 'im2' } },
  { cityCode: 'c3', cityName: 'Belém', uf: 'PA', meso: { code: 'M2' }, micro: { code: 'mi3' },
    intermediaria: { code: 'I2' }, imediata: { code: 'im3' } },
  { cityCode: 'c4', cityName: 'Campinas', uf: 'SP', meso: { code: 'M3' }, micro: { code: 'mi4' },
    intermediaria: { code: 'I3' }, imediata: { code: 'im4' } },
];
const ANOS = [2013, 2014, 2015, 2016];
const PRODUTOS = [
  { code: 'ACAI', name: 'Açaí', family: 'mass', unit: 't', tabela: '5457' },
  { code: 'MILHO', name: 'Milho', family: 'mass', unit: 't', tabela: '5457' },
];

// Uma linha por (produto, município, ano) em que o produto existe ali — com duas exceções que
// a contagem tem de respeitar: um buraco (milho em Belém, 2014) e um registro duplo (milho em
// Campinas, 2016), porque `count(*)` conta LINHAS, não grupos.
const GOLD = [];
for (const c of CIDADES) {
  for (const year of ANOS) {
    const linha = { city: c.cityCode, uf: c.uf, year };
    if (!(c.cityCode === 'c3' && year === 2014)) GOLD.push({ ...linha, code: 'MILHO' });
    if (c.cityCode === 'c4' && year === 2016) GOLD.push({ ...linha, code: 'MILHO' });
    // O açaí só no Pará, e só de 2015 em diante.
    if (c.uf === 'PA' && year >= 2015) GOLD.push({ ...linha, code: 'ACAI' });
  }
}

const anoDe = (d) => (d ? Number(String(d).slice(0, 4)) : null);

// count(*) sobre GOLD com o recorte: o oráculo de cada teste.
function linhasGold({ codes, y0 = -Infinity, y1 = Infinity, ufs = null, cities = null }) {
  return GOLD.filter((r) => codes.includes(r.code) && r.year >= y0 && r.year <= y1
    && (!ufs || ufs.includes(r.uf)) && (!cities || cities.includes(r.city)));
}
const contarGold = (recorte) => linhasGold(recorte).length;
// count(distinct year) sobre GOLD com o recorte, em ordem: o oráculo de "Anos cobertos".
const anosGold = (recorte) => [...new Set(linhasGold(recorte).map((r) => r.year))].sort((a, b) => a - b);

function agrupar(linhas, chave) {
  const m = new Map();
  for (const r of linhas) {
    const k = chave(r);
    m.set(k, [...(m.get(k) || []), r]);
  }
  return [...m.values()];
}

// As leituras, como o servidor as monta. `semLinhas` reproduz uma resposta de antes da v1.108.9.
function leituras(linhas, { semLinhas = false } = {}) {
  const n = (g) => (semLinhas ? {} : { rows: g.length });
  const productTS = {};
  for (const g of agrupar(linhas, (r) => `${r.code}|${r.year}`)) {
    (productTS[g[0].code] ||= []).push(
      { y: g[0].year, v: g.length, q: g.length, family: 'mass', ...n(g) });
  }
  const ufYearly = agrupar(linhas, (r) => `${r.uf}|${r.year}`).map((g) => ({
    year: g[0].year, uf: g[0].uf, name: g[0].uf, region: g[0].uf === 'PA' ? 'N' : 'SE',
    value: g.length, q_mass: g.length, q_vol: 0, q_count_stock: 0, q_count_flow: 0, ...n(g),
  }));
  const municipioYearly = agrupar(linhas, (r) => `${r.city}|${r.year}`).map((g) => ({
    year: g[0].year, cityCode: g[0].city, uf: g[0].uf,
    value: g.length, q_mass: g.length, q_vol: 0, q_count_stock: 0, q_count_flow: 0, ...n(g),
  }));
  return { productTS, ufYearly, municipioYearly };
}

function snapshot({ semLinhas = false, semGradeUf = false } = {}) {
  const { productTS, ufYearly } = leituras(GOLD, { semLinhas });
  return {
    products: PRODUTOS,
    productTS,
    overviewTS: ANOS.map((y) => ({ y, v: 1 })),
    ufData: [
      { uf: 'PA', name: 'Pará', region: 'N', value: 1, q_mass: 1, q_vol: 0 },
      { uf: 'SP', name: 'São Paulo', region: 'SE', value: 1, q_mass: 1, q_vol: 0 },
    ],
    ufYearly: semGradeUf ? [] : ufYearly,
    quality: [{ id: 'OK', count: GOLD.length }],
    qualityTs: [],
    topMunis: [],
    regions: [{ id: 'N' }, { id: 'SE' }],
    qualityByProduct: PRODUTOS.map((p) => ({
      code: p.code, tabela: p.tabela, name: p.name, OK: 1,
      rows: GOLD.filter((r) => r.code === p.code).length,
    })),
  };
}

// Os dois cubos sob demanda, servidos da mesma base (a cesta e as cidades do pedido).
function instalarCubos({ cubo = 'pronto', municipios = 'pronto', semLinhas = false } = {}) {
  const daCesta = (summary) => GOLD.filter((r) => summary.basket == null || summary.basket.includes(r.code));
  window.geoYearly = vi.fn((banco, summary) => {
    if (cubo === 'carregando') return { rows: null, priceBase: null, loading: true, loadError: null };
    if (cubo === 'falha') return { rows: null, priceBase: null, loading: false, loadError: 'HTTP 503' };
    return { rows: leituras(daCesta(summary), { semLinhas }).ufYearly,
             priceBase: null, loading: false, loadError: null };
  });
  window.municipioYearly = vi.fn((banco, summary, cityCodes) => {
    if (municipios === 'carregando') return { rows: null, priceBase: null, loading: true, loadError: null };
    if (municipios === 'falha') return { rows: null, priceBase: null, loading: false, loadError: 'HTTP 503' };
    const y0 = anoDe(summary.startDate) ?? -Infinity;
    const y1 = anoDe(summary.endDate) ?? Infinity;
    const linhas = daCesta(summary)
      .filter((r) => cityCodes.includes(r.city) && r.year >= y0 && r.year <= y1);
    return { rows: leituras(linhas, { semLinhas }).municipioYearly,
             priceBase: null, loading: false, loadError: null };
  });
}

async function carregar(snap) {
  vi.resetModules();
  window.dataStore = { get: () => snap };
  window.snapshotFor = () => null;
  window.REGIONS = snap.regions;
  window.UF_DATA = [
    { uf: 'PA', name: 'Pará', region: 'N', col: 1, row: 1 },
    { uf: 'SP', name: 'São Paulo', region: 'SE', col: 2, row: 2 },
  ];
  window.VIZ_SCALE = ['var(--viz-1)'];
  window.VALUE_PRESETS = [];
  window.MUNI_PICKER_NAMES = new Set();
  window.geoMeshState = () => ({ municipios: CIDADES, loading: false, loadError: null });
  window.geoMesh = () => CIDADES;
  await import('./dataFilters.js');
  return window.applyFilters;
}

const GLOBAIS = ['dataStore', 'snapshotFor', 'REGIONS', 'UF_DATA', 'VIZ_SCALE', 'VALUE_PRESETS',
  'MUNI_PICKER_NAMES', 'geoMeshState', 'geoMesh', 'geoYearly', 'municipioYearly', 'applyFilters'];
let guardados;
beforeEach(() => {
  guardados = Object.fromEntries(GLOBAIS.map((k) => [k, window[k]]));
  instalarCubos();
});
afterEach(() => { Object.assign(window, guardados); });

const TODOS = PRODUTOS.map((p) => p.code);

// ── O caminho nacional: a série por produto ──────────────────────────────────────────────────
describe('rowsInView — sem geografia, a soma da série por produto', () => {
  it('sem filtro algum, todas as linhas do banco', async () => {
    const f = (await carregar(snapshot()))({}, 'ibge_pam');
    expect(f.rowsInView).toBe(GOLD.length);
  });

  it('o açaí antes de existir: zero linhas, contadas — e a estimativa dizia outra coisa', async () => {
    const applyFilters = await carregar(snapshot());
    const f = applyFilters(
      { basket: ['ACAI'], startDate: '2013-01-01', endDate: '2014-12-01' }, 'ibge_pam');
    expect(f.rowsInView).toBe(0);
    expect(contarGold({ codes: ['ACAI'], y0: 2013, y1: 2014 })).toBe(0);
    // Contraprova: a estimativa de antes (fração das linhas do açaí × fração dos anos) afirmava
    // linhas num período em que o produto não tem nenhuma.
    const estimativa = Math.round(GOLD.length * f._shares.productShare * f._shares.yearShare);
    expect(estimativa).toBeGreaterThan(0);
  });

  it('cesta e período: as linhas da cesta nos anos escolhidos', async () => {
    const f = (await carregar(snapshot()))(
      { basket: ['ACAI', 'MILHO'], startDate: '2015-01-01', endDate: '2016-12-01' }, 'ibge_pam');
    expect(f.rowsInView).toBe(contarGold({ codes: TODOS, y0: 2015, y1: 2016 }));
  });

  it('a seleção de qualidade não muda a contagem', async () => {
    const applyFilters = await carregar(snapshot());
    const semFlag = applyFilters({}, 'ibge_pam').rowsInView;
    expect(semFlag).toBe(GOLD.length);
    expect(applyFilters({ flags: ['OK'] }, 'ibge_pam').rowsInView).toBe(semFlag);
    expect(applyFilters({ flags: [] }, 'ibge_pam').rowsInView).toBe(semFlag);
  });

  it('nenhum produto selecionado: zero, qualquer que seja a geografia', async () => {
    const applyFilters = await carregar(snapshot());
    expect(applyFilters({ basket: [] }, 'ibge_pam').rowsInView).toBe(0);
    expect(applyFilters({ basket: [], states: ['PA'] }, 'ibge_pam').rowsInView).toBe(0);
  });
});

// ── As UFs: a grade UF × ano e o cubo da cesta ───────────────────────────────────────────────
describe('rowsInView — um subconjunto de UFs', () => {
  it('só UFs: a grade do snapshot, somada nas UFs escolhidas', async () => {
    const f = (await carregar(snapshot()))({ states: ['PA'] }, 'ibge_pam');
    expect(f.rowsInView).toBe(contarGold({ codes: TODOS, ufs: ['PA'] }));
  });

  it('UFs e período', async () => {
    const f = (await carregar(snapshot()))(
      { states: ['SP'], startDate: '2016-01-01', endDate: '2016-12-01' }, 'ibge_pam');
    // Campinas 2016 tem o registro duplo: 2 linhas, não 1 grupo.
    expect(f.rowsInView).toBe(2);
    expect(f.rowsInView).toBe(contarGold({ codes: TODOS, ufs: ['SP'], y0: 2016, y1: 2016 }));
  });

  it('cesta × UF com o cubo carregado: as linhas da cesta nas UFs', async () => {
    const f = (await carregar(snapshot()))({ basket: ['ACAI'], states: ['PA'] }, 'ibge_pam');
    expect(window.geoYearly).toHaveBeenCalled();
    expect(f.rowsInView).toBe(contarGold({ codes: ['ACAI'], ufs: ['PA'] }));
  });

  it('cesta × UF com o cubo a caminho ou em falha: não conta — a série soma todos os produtos ali', async () => {
    instalarCubos({ cubo: 'carregando' });
    let f = (await carregar(snapshot()))({ basket: ['ACAI'], states: ['PA'] }, 'ibge_pam');
    expect(f.geoComboPending).toBe(true);
    expect(f.rowsInView).toBeNull();
    instalarCubos({ cubo: 'falha' });
    f = (await carregar(snapshot()))({ basket: ['ACAI'], states: ['PA'] }, 'ibge_pam');
    expect(f.geoComboLoadError).toBe('HTTP 503');
    expect(f.rowsInView).toBeNull();
  });

  it('cesta sem UF com o cubo em falha: a série nacional honra a cesta, e a contagem também', async () => {
    instalarCubos({ cubo: 'falha' });
    const f = (await carregar(snapshot()))({ basket: ['ACAI'] }, 'ibge_pam');
    expect(f.rowsInView).toBe(contarGold({ codes: ['ACAI'] }));
  });

  it('UFs sem grade UF × ano no snapshot: a série não as honra, e a contagem recusa', async () => {
    const f = (await carregar(snapshot({ semGradeUf: true })))({ states: ['PA'] }, 'ibge_pam');
    expect(f.rowsInView).toBeNull();
  });
});

// ── Abaixo da UF: o cubo por município ───────────────────────────────────────────────────────
describe('rowsInView — um recorte abaixo da UF', () => {
  it('uma mesorregião: as linhas dos municípios dela', async () => {
    const f = (await carregar(snapshot()))({ mesos: ['M1'] }, 'ibge_pam');
    expect(f.rowsInView).toBe(contarGold({ codes: TODOS, cities: ['c1', 'c2'] }));
  });

  it('dois municípios, uma cesta e um período', async () => {
    const f = (await carregar(snapshot()))({
      munis: ['c1', 'c2'], basket: ['ACAI'], startDate: '2016-01-01', endDate: '2016-12-01',
    }, 'ibge_pam');
    expect(f.rowsInView).toBe(contarGold({ codes: ['ACAI'], cities: ['c1', 'c2'], y0: 2016, y1: 2016 }));
    expect(f.rowsInView).toBe(2);
  });

  it('o recorte e o filtro de UF juntos: só o que passa pelos dois', async () => {
    const f = (await carregar(snapshot()))({ mesos: ['M1', 'M3'], states: ['PA'] }, 'ibge_pam');
    expect(f.rowsInView).toBe(contarGold({ codes: TODOS, cities: ['c1', 'c2'] }));
  });

  it('a caminho ou em falha: não conta', async () => {
    instalarCubos({ municipios: 'carregando' });
    let f = (await carregar(snapshot()))({ mesos: ['M1'] }, 'ibge_pam');
    expect(f.subUfLoading).toBe(true);
    expect(f.rowsInView).toBeNull();
    instalarCubos({ municipios: 'falha' });
    f = (await carregar(snapshot()))({ mesos: ['M1'] }, 'ibge_pam');
    expect(f.subUfLoadError).toBe('HTTP 503');
    expect(f.rowsInView).toBeNull();
  });
});

// ── Uma resposta sem contagem ────────────────────────────────────────────────────────────────
describe('rowsInView — sem a contagem na resposta, a contagem é desconhecida, nunca menor', () => {
  it('uma resposta de antes da v1.108.9: nulo, e a estimativa segue disponível', async () => {
    // A cesta pede o cubo também, e um servidor antigo o devolve igualmente sem contagem.
    instalarCubos({ semLinhas: true });
    const applyFilters = await carregar(snapshot({ semLinhas: true }));
    for (const summary of [{}, { basket: ['MILHO'] }, { states: ['PA'] }]) {
      const f = applyFilters(summary, 'ibge_pam');
      expect(f.rowsInView).toBeNull();
      expect(f._shares.productShare).toBeGreaterThan(0);
    }
  });

  it('um único ponto sem contagem torna a soma desconhecida', async () => {
    const snap = snapshot();
    delete snap.productTS.MILHO[0].rows;
    const f = (await carregar(snap))({}, 'ibge_pam');
    expect(f.rowsInView).toBeNull();
  });

  it('o mesmo no cubo por município', async () => {
    instalarCubos({ semLinhas: true });
    const f = (await carregar(snapshot()))({ mesos: ['M1'] }, 'ibge_pam');
    expect(f.rowsInView).toBeNull();
  });

  it('cada ponto da série da tela leva a sua contagem', async () => {
    const f = (await carregar(snapshot()))({ states: ['PA'] }, 'ibge_pam');
    for (const d of f.ts) {
      expect(d.rows).toBe(contarGold({ codes: TODOS, ufs: ['PA'], y0: d.y, y1: d.y }));
    }
  });
});

// ── A origem do PEVS ─────────────────────────────────────────────────────────────────────────
describe('rowsInView — sob uma origem do PEVS, as linhas da metade escolhida', () => {
  // Sob `tb=291` o servidor lê a série por produto só da silvicultura (v1.108.4): os produtos da
  // extração não têm série alguma ali, e a seleção não passa da origem (v1.108.5).
  it('Silvicultura: só as linhas dos produtos dela', async () => {
    const pevs = [
      { code: 'X1', name: 'Açaí (fruto)', family: 'mass', unit: 't', tabela: '289' },
      { code: 'S1', name: 'Madeira em tora', family: 'mass', unit: 't', tabela: '291' },
    ];
    const snap = snapshot();
    snap.products = pevs;
    snap.productTS = { S1: snap.productTS.MILHO }; // a série da silvicultura, e só ela
    snap.qualityByProduct = pevs.map((p) => ({ code: p.code, tabela: p.tabela, OK: 1, rows: 10 }));
    const f = (await carregar(snap))({ tabela: '291' }, 'ibge_pevs');
    expect(f.selectedProducts).toEqual(['S1']);
    expect(f.rowsInView).toBe(contarGold({ codes: ['MILHO'] }));
  });
});

// ── "Anos cobertos": os anos com linhas, das mesmas contagens (v1.108.15) ────────────────────
// Até a v1.108.11 o contador de anos era `ts.length`: a série tem um ponto para cada ano do
// banco dentro do período, com linhas ou sem. Na produção, o açaí da PAM em 1990–2000 lia
// "Linhas 0" ao lado de "Anos cobertos 11 / 52". `yearsWithRows` são os anos dos pontos que
// levam linhas, lidos das mesmas contagens que `rowsInView` soma.
describe('yearsWithRows — os anos com linhas, das contagens de "Linhas"', () => {
  it('sem filtro algum, todo ano em que o banco tem linhas', async () => {
    const f = (await carregar(snapshot()))({}, 'ibge_pam');
    expect(f.yearsWithRows).toEqual(anosGold({ codes: TODOS }));
    expect(f.yearsWithRows).toEqual(ANOS);
  });

  it('o açaí antes de existir: nenhum ano, e o período tem dois', async () => {
    const f = (await carregar(snapshot()))(
      { basket: ['ACAI'], startDate: '2013-01-01', endDate: '2014-12-01' }, 'ibge_pam');
    expect(f.yearsWithRows).toEqual([]);
    expect(anosGold({ codes: ['ACAI'], y0: 2013, y1: 2014 })).toEqual([]);
    expect(f.rowsInView).toBe(0);
    // Contraprova: a série tem os dois anos do período, e o tamanho dela era a contagem de antes.
    expect(f.ts.map((d) => d.y)).toEqual([2013, 2014]);
  });

  it('um período que pega o açaí pela metade: só os anos em que ele tem linhas', async () => {
    const f = (await carregar(snapshot()))({ basket: ['ACAI'] }, 'ibge_pam');
    expect(f.yearsWithRows).toEqual([2015, 2016]);
    expect(f.yearsWithRows).toEqual(anosGold({ codes: ['ACAI'] }));
    expect(f.ts).toHaveLength(ANOS.length);
  });

  it('um ano sem linhas no meio da série fica de fora (milho em Belém, sem 2014)', async () => {
    const f = (await carregar(snapshot()))({ basket: ['MILHO'], munis: ['c3'] }, 'ibge_pam');
    expect(f.yearsWithRows).toEqual([2013, 2015, 2016]);
    expect(f.yearsWithRows).toEqual(anosGold({ codes: ['MILHO'], cities: ['c3'] }));
  });

  it('UFs: a grade do snapshot, nos anos em que as UFs escolhidas têm linhas', async () => {
    const f = (await carregar(snapshot()))(
      { states: ['SP'], startDate: '2014-01-01', endDate: '2016-12-01' }, 'ibge_pam');
    expect(f.yearsWithRows).toEqual(anosGold({ codes: TODOS, ufs: ['SP'], y0: 2014, y1: 2016 }));
  });

  it('cesta × UF com o cubo carregado: os anos da cesta nas UFs, e nenhum onde ela não está', async () => {
    const applyFilters = await carregar(snapshot());
    expect(applyFilters({ basket: ['ACAI'], states: ['PA'] }, 'ibge_pam').yearsWithRows)
      .toEqual(anosGold({ codes: ['ACAI'], ufs: ['PA'] }));
    const semAcai = applyFilters({ basket: ['ACAI'], states: ['SP'] }, 'ibge_pam');
    expect(semAcai.yearsWithRows).toEqual([]);
    expect(semAcai.rowsInView).toBe(0);
  });

  it('uma mesorregião: os anos dos municípios dela', async () => {
    const f = (await carregar(snapshot()))({ mesos: ['M1'], basket: ['ACAI'] }, 'ibge_pam');
    expect(f.yearsWithRows).toEqual(anosGold({ codes: ['ACAI'], cities: ['c1', 'c2'] }));
  });

  it('nenhum produto selecionado: nenhum ano, qualquer que seja a geografia', async () => {
    const applyFilters = await carregar(snapshot());
    expect(applyFilters({ basket: [] }, 'ibge_pam').yearsWithRows).toEqual([]);
    // Com UFs a série soma a grade de todos os produtos, que tem linhas em todo ano.
    const comUf = applyFilters({ basket: [], states: ['PA'] }, 'ibge_pam');
    expect(comUf.ts.some((d) => d.rows > 0)).toBe(true);
    expect(comUf.yearsWithRows).toEqual([]);
  });

  it('sob a origem Silvicultura do PEVS, os anos dos produtos dela', async () => {
    const pevs = [
      { code: 'X1', name: 'Açaí (fruto)', family: 'mass', unit: 't', tabela: '289' },
      { code: 'S1', name: 'Madeira em tora', family: 'mass', unit: 't', tabela: '291' },
    ];
    const snap = snapshot();
    snap.products = pevs;
    snap.productTS = { S1: snap.productTS.ACAI }; // a série da silvicultura, e só ela
    snap.qualityByProduct = pevs.map((p) => ({ code: p.code, tabela: p.tabela, OK: 1, rows: 10 }));
    const f = (await carregar(snap))({ tabela: '291' }, 'ibge_pevs');
    expect(f.yearsWithRows).toEqual(anosGold({ codes: ['ACAI'] }));
  });
});

// Onde "Linhas" não tem número, "Anos cobertos" também não tem: os anos de uma contagem
// desconhecida são desconhecidos, nunca os do período.
describe('yearsWithRows — sem contagem, sem anos', () => {
  it('cesta × UF com o cubo a caminho ou em falha', async () => {
    instalarCubos({ cubo: 'carregando' });
    let f = (await carregar(snapshot()))({ basket: ['ACAI'], states: ['PA'] }, 'ibge_pam');
    expect(f.geoComboPending).toBe(true);
    expect(f.yearsWithRows).toBeNull();
    instalarCubos({ cubo: 'falha' });
    f = (await carregar(snapshot()))({ basket: ['ACAI'], states: ['PA'] }, 'ibge_pam');
    expect(f.geoComboLoadError).toBe('HTTP 503');
    expect(f.yearsWithRows).toBeNull();
  });

  it('um recorte abaixo da UF a caminho ou em falha', async () => {
    instalarCubos({ municipios: 'carregando' });
    let f = (await carregar(snapshot()))({ mesos: ['M1'] }, 'ibge_pam');
    expect(f.subUfLoading).toBe(true);
    expect(f.yearsWithRows).toBeNull();
    instalarCubos({ municipios: 'falha' });
    f = (await carregar(snapshot()))({ mesos: ['M1'] }, 'ibge_pam');
    expect(f.subUfLoadError).toBe('HTTP 503');
    expect(f.yearsWithRows).toBeNull();
  });

  it('UFs sem grade UF × ano no snapshot', async () => {
    const f = (await carregar(snapshot({ semGradeUf: true })))({ states: ['PA'] }, 'ibge_pam');
    expect(f.yearsWithRows).toBeNull();
  });

  it('uma resposta de antes da v1.108.9, sem contagem em ponto algum', async () => {
    instalarCubos({ semLinhas: true });
    const applyFilters = await carregar(snapshot({ semLinhas: true }));
    for (const summary of [{}, { basket: ['MILHO'] }, { states: ['PA'] }, { mesos: ['M1'] }]) {
      expect(applyFilters(summary, 'ibge_pam').yearsWithRows).toBeNull();
    }
  });

  it('um único ponto sem contagem: os outros anos não bastam', async () => {
    // O ponto sem contagem pode ser de um ano sem nenhuma outra linha; contar os demais daria
    // um número menor que o verdadeiro, com cara de contado.
    const snap = snapshot();
    delete snap.productTS.MILHO[0].rows;
    const f = (await carregar(snap))({}, 'ibge_pam');
    expect(f.yearsWithRows).toBeNull();
  });
});

// Os dois contadores vêm da mesma série e não podem se contradizer, em recorte nenhum: os
// anos são nulos exatamente quando as linhas são, nenhum ano exatamente quando nenhuma linha,
// e as linhas dos anos contados somam a contagem inteira.
describe('yearsWithRows e rowsInView nunca se contradizem', () => {
  const RECORTES = [
    {},
    { basket: ['ACAI'] },
    { basket: ['ACAI'], startDate: '2013-01-01', endDate: '2014-12-01' },
    { basket: ['MILHO'], startDate: '2014-01-01', endDate: '2014-12-01' },
    { basket: [] },
    { basket: [], states: ['SP'] },
    { states: ['PA'] },
    { states: ['SP'], startDate: '2016-01-01', endDate: '2016-12-01' },
    { basket: ['ACAI'], states: ['PA'] },
    { basket: ['ACAI'], states: ['SP'] },
    { mesos: ['M1'] },
    { munis: ['c3'], basket: ['MILHO'] },
    { munis: ['c4'], basket: ['ACAI'] },
    { mesos: ['M1', 'M3'], states: ['PA'] },
  ];
  const CENARIOS = [
    { nome: 'cubos prontos', cubos: {}, snap: {} },
    { nome: 'cubo da cesta a caminho', cubos: { cubo: 'carregando' }, snap: {} },
    { nome: 'cubo por município em falha', cubos: { municipios: 'falha' }, snap: {} },
    { nome: 'resposta sem contagem', cubos: { semLinhas: true }, snap: { semLinhas: true } },
    { nome: 'snapshot sem grade UF', cubos: {}, snap: { semGradeUf: true } },
  ];

  it.each(CENARIOS)('$nome', async ({ cubos, snap }) => {
    instalarCubos(cubos);
    const applyFilters = await carregar(snapshot(snap));
    for (const summary of RECORTES) {
      const f = applyFilters(summary, 'ibge_pam');
      expect(f.yearsWithRows === null, JSON.stringify(summary)).toBe(f.rowsInView === null);
      if (f.rowsInView === null) continue;
      expect(f.yearsWithRows.length === 0, JSON.stringify(summary)).toBe(f.rowsInView === 0);
      // Sem produto a série pode somar outros produtos (a grade por UF); ali os dois são zero.
      if (!f.selectedProducts.length) continue;
      const linhasDosAnos = f.ts.filter((d) => f.yearsWithRows.includes(d.y))
        .reduce((s, d) => s + d.rows, 0);
      expect(linhasDosAnos, JSON.stringify(summary)).toBe(f.rowsInView);
    }
  });
});
