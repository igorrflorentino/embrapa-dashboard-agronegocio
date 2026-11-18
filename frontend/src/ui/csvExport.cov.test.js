// csvExport.cov.test.js — coverage for csvExport.js, the "Exportar CSV" builder.
// csvExport.js is a side-effect IIFE that registers window.canExportView,
// window.exportActiveTableCSV. It depends on a handful of registry globals
// (applyFilters, applyConv, DEFAULT_CONVENTIONS, viewById, bancoById) which we
// STUB directly — the same pattern the View tests use — so we can drive every
// per-view buildRows branch deterministically and assert the emitted CSV text.
//
// To capture the download payload without a real browser, we intercept the
// global Blob constructor (the module does `new Blob([csv], …)`) and stub
// URL.createObjectURL / a.click(), so each export records its CSV string.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL recorte formatter, registered on window exactly as main.jsx loads it —
// stubbing it would let the test and the product disagree about what the file says.
import './geoDrill.js';
import './filtersSchema.js';
import './territoryCompare.js';
// The REAL phrase of the `correcao_monetaria` column (v1.105.0): the index and its economy
// (MetricConventions.correctionChip), the month (MonetaryNotes.precosDe) and the snapshot's
// base (seriesUtils.priceBaseFor). The per-test stubs below override what these also define.
import './MonetaryNotes.jsx';
import './seriesUtils.js';
import './MetricConventions.jsx';

// ── Capture harness for the download() side-effect ───────────────────────────
let lastCsv;
let lastDownloadName;
let RealBlob;

function installDownloadCapture() {
  lastCsv = undefined;
  lastDownloadName = undefined;
  RealBlob = global.Blob;
  // Record the CSV text passed to new Blob([...]) so we can assert on it.
  global.Blob = class {
    constructor(parts) {
      lastCsv = (parts || []).join('');
      // `size` porque prepareTableCSV mede o arquivo REAL com `new Blob([csv]).size` para
      // mostrar o tamanho na confirmação; sem isto ele sairia `undefined` no teste.
      this.size = lastCsv.length;
    }
  };
  window.URL.createObjectURL = vi.fn(() => 'blob:mock');
  window.URL.revokeObjectURL = vi.fn();
  // Capture the filename off the synthetic <a download> click.
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    const el = origCreate(tag);
    if (tag === 'a') {
      el.click = () => {
        lastDownloadName = el.download;
      };
    }
    return el;
  });
}

// ── Registry stubs (DEFAULT_CONVENTIONS shape mirrors MetricConventions.jsx) ──
const CONV = { currency: 'BRL', correction: 'IPCA', units: { mass: 't', volume: 'm³' }, autoScale: false };

// The last column of every file that carries a value (v1.105.0): what the number IS. CONV is
// R$ · IPCA and no snapshot names a month in these tests, so the phrase is the one that names
// none. The comma makes the CSV quote the cell.
const CORRECAO = 'IPCA · Brasil, a preços do mês mais recente do índice';
const CORRECAO_CSV = `"${CORRECAO}"`;

const PRODUCTS = [
  { code: 'P1', name: 'Açaí', family: 'mass' },
  { code: 'P2', name: 'Madeira', family: 'volume' },
  { code: 'P3', name: 'Bovino', family: 'count' },
  { code: 'P9', name: 'Sem família' }, // no family → FAM_Q fallback to mass
];

function stubRegistry(filtered) {
  window.DEFAULT_CONVENTIONS = CONV;
  window.applyConv = (v) => v; // identity (BRL→BRL, factor 1)
  window.applyFilters = () => filtered;
  // live banco with a short label
  window.bancoById = () => ({ id: 'ibge_pevs', short: 'IBGE PEVS', status: 'live' });
  window.viewById = (id) => ({ id, exportable: id !== 'docs' });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  installDownloadCapture();
  // Importing registers the window.* functions (cached after first import, which
  // is fine — the closures read the live window stubs we set per-test). The module
  // binding itself is unused — the tests call the registered window.* helpers.
  await import('./csvExport.js');
});

afterEach(() => {
  global.Blob = RealBlob;
  vi.restoreAllMocks();
  // ViewGeography mirrors its local scope/município rows here (CONF-4) only while
  // mounted; a test that sets them without cleanup would otherwise leak into the
  // NEXT test, silently steering its 'geo' export through the wrong branch.
  delete window.geoExportScope;
  delete window.geoExportMunis;
  delete window.geoExportMuniRead;
});

// ── canExportView ────────────────────────────────────────────────────────────
describe('canExportView', () => {
  it('true when the view registry entry is exportable', () => {
    window.viewById = () => ({ exportable: true });
    expect(window.canExportView('overview')).toBe(true);
  });
  it('false when the entry omits the flag (or is missing)', () => {
    window.viewById = () => ({ exportable: false });
    expect(window.canExportView('fluxos')).toBe(false);
    window.viewById = () => null;
    expect(window.canExportView('nope')).toBe(false);
  });
});

// ── exportActiveTableCSV: guard branches ─────────────────────────────────────
describe('exportActiveTableCSV — guards (no download)', () => {
  it('warns and returns when banco is not live', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRegistry({ ts: [], products: PRODUCTS });
    window.bancoById = () => ({ short: 'SEFAZ', status: 'pending' });
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'sefaz_nf' });
    expect(warn).toHaveBeenCalled();
    expect(lastCsv).toBeUndefined(); // nothing written
  });

  it('warns and returns when banco is missing entirely', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRegistry({ ts: [], products: PRODUCTS });
    window.bancoById = () => null;
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'x' });
    expect(warn).toHaveBeenCalled();
    expect(lastCsv).toBeUndefined();
  });

  it('warns and returns when the built rows are empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRegistry({ ts: [], products: PRODUCTS }); // overview with empty ts → 0 rows
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    expect(warn).toHaveBeenCalledWith('[csv] nothing to export for view', 'overview');
    expect(lastCsv).toBeUndefined();
  });

  it('warns and returns for an unknown view (buildRows default → null)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRegistry({ ts: [], products: PRODUCTS });
    window.exportActiveTableCSV({ view: 'mystery_view', summary: {}, database: 'ibge_pevs' });
    expect(warn).toHaveBeenCalled();
    expect(lastCsv).toBeUndefined();
  });
});

// ── prepareTableCSV: monta SEM baixar, e o baixar() grava o que foi montado ──
describe('prepareTableCSV — o descritor que a janela de confirmação mostra', () => {
  const FILTRADO = {
    products: PRODUCTS,
    ts: [
      { y: 2020, v: 1.5, q_mass: 10, q_vol: 2 },
      { y: 2021, v: 2.0, q_mass: 12, q_vol: 3 },
    ],
  };

  it('MONTA sem baixar — o clique não pode gravar nada por si', () => {
    stubRegistry(FILTRADO);
    const p = window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    expect(p.erro).toBe(false);
    // Quem sinaliza "gravou" é o clique no <a download>, não o Blob: `prepareTableCSV`
    // constrói um Blob de propósito, só para medir o tamanho real que a janela mostra.
    expect(lastDownloadName, 'preparar não pode gravar arquivo').toBeUndefined();
    expect(p.bytes).toBe(lastCsv.length);   // e o tamanho é o do arquivo montado
  });

  it('descreve o que SERÁ gravado: linhas, colunas, banco e nome do arquivo', () => {
    stubRegistry(FILTRADO);
    const p = window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    expect(p.linhas).toBe(2);                                   // uma por ano em `ts`
    expect(p.colunas).toEqual(['ano', 'valor_BRL', 'qtd_massa_t', 'qtd_volume_m3', 'correcao_monetaria']);
    expect(p.banco).toBe('IBGE PEVS');
    expect(p.assunto).toMatch(/Série anual agregada/);
    expect(p.arquivo).toBe('ibge_pevs_serie_agregada_2020-2021.csv');
  });

  // ── o período do NOME vem dos dados, não da intenção ─────────────────────────────────
  it('o período no nome é o do ARQUIVO, mesmo sem filtro de período', () => {
    // Antes o nome saía "…_completo.csv" enquanto o chip dizia "1986–2024" — coerente, mas
    // lado a lado na janela de confirmação lê como contradição. A âncora é a coluna `ano`
    // do próprio arquivo: é a única que não pode discordar do conteúdo.
    stubRegistry(FILTRADO);                                       // ts: 2020 e 2021
    const p = window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    p.baixar();
    const anos = lastCsv.replace('\uFEFF', '').split('\n').slice(1).map((l) => l.split(';')[0]);
    expect(anos).toEqual(['2020', '2021']);                       // o que o arquivo contém
    expect(lastDownloadName).toContain('2020-2021');              // e o que o nome diz
    expect(lastDownloadName).not.toContain('completo');
  });

  it('um único ano no arquivo vira um ano só no nome, não "2024-2024"', () => {
    stubRegistry({ products: PRODUCTS, ts: [{ y: 2024, v: 1, q_mass: 1, q_vol: 1 }] });
    const p = window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    expect(p.arquivo).toBe('ibge_pevs_serie_agregada_2024.csv');
  });

  it('sem coluna `ano` (qualidade), cai no período do filtro — e nunca no travessão', () => {
    // O chip da tela usa "–" (travessão), que não é caractere para nome de arquivo; o
    // fallback normaliza. Sem nenhuma fonte, "completo" continua sendo a resposta honesta.
    stubRegistry({ products: PRODUCTS, qualityFlags: [{ id: 'OK', label: 'Íntegra', count: 5, share: 1 }] });
    const comChip = window.prepareTableCSV({
      view: 'quality', summary: { period: '1997–2024' }, database: 'ibge_pevs' });
    expect(comChip.arquivo).toBe('ibge_pevs_qualidade_1997-2024.csv');

    const semNada = window.prepareTableCSV({ view: 'quality', summary: {}, database: 'ibge_pevs' });
    expect(semNada.arquivo).toBe('ibge_pevs_qualidade_completo.csv');
  });

  it('o baixar() grava EXATAMENTE o que o descritor descreveu', () => {
    // O ponto da confirmação: a janela mostra uma coisa e o arquivo é outra se o download
    // remontar. Aqui a asserção é externa ao descritor — conta as linhas do CSV escrito e
    // lê o cabeçalho dele, e confronta com o que o descritor prometeu.
    stubRegistry(FILTRADO);
    const p = window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    p.baixar();
    const linhas = lastCsv.replace('\uFEFF', '').split('\n');
    expect(lastDownloadName).toBe(p.arquivo);
    expect(linhas[0].split(';')).toEqual(p.colunas);
    expect(linhas.length - 1).toBe(p.linhas);                   // menos o cabeçalho
  });

  it('a mudança do estado ENTRE preparar e baixar não altera o arquivo', () => {
    // É o que "nada é recalculado no download" quer dizer. Se `baixar()` remontasse, o
    // arquivo sairia com os dados novos e a janela teria mentido.
    stubRegistry(FILTRADO);
    const p = window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    stubRegistry({ products: PRODUCTS, ts: [{ y: 1999, v: 9, q_mass: 9, q_vol: 9 }] });
    p.baixar();
    const linhas = lastCsv.replace('\uFEFF', '').split('\n');
    expect(linhas.length - 1).toBe(2);            // os 2 anos preparados, não o 1 novo
    expect(lastCsv).not.toContain('1999');
  });

  it('devolve o MOTIVO quando não há o que baixar, em vez de só avisar no console', () => {
    // Antes isto era um console.warn: o botão simplesmente não fazia nada, e quem usava
    // não tinha como saber por quê. A janela precisa do motivo para dizer o que houve.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRegistry({ ts: [], products: PRODUCTS });
    expect(window.prepareTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' }))
      .toMatchObject({ erro: true, motivo: 'sem-linhas' });

    window.bancoById = () => ({ short: 'SEFAZ NFe', status: 'pending' });
    expect(window.prepareTableCSV({ view: 'overview', summary: {}, database: 'sefaz_nf' }))
      .toMatchObject({ erro: true, motivo: 'banco-indisponivel', banco: 'SEFAZ NFe' });
    expect(lastDownloadName).toBeUndefined();
    warn.mockRestore();
  });
});

// ── overview / value: annual aggregate series ────────────────────────────────
describe('exportActiveTableCSV — overview/value aggregate series', () => {
  const FILTERED = {
    products: PRODUCTS,
    ts: [
      { y: 2020, v: 1.5, q_mass: 2.0, q_vol: 3.0 },
      { y: 2021, v: 2.5, q_mass: 1.0, q_vol: 0 },
    ],
  };

  it('emits BOM + header + scaled rows, semicolon-delimited', () => {
    stubRegistry(FILTERED);
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    expect(lastCsv).toBeTruthy();
    expect(lastCsv.startsWith('﻿')).toBe(true); // Excel UTF-8 BOM
    const lines = lastCsv.replace('﻿', '').split('\n');
    // No count column: this basket counts nothing (one per count group, see the end).
    expect(lines[0]).toBe('ano;valor_BRL;qtd_massa_t;qtd_volume_m3;correcao_monetaria');
    // v*1e9 (applyConv identity) → 1.5e9 ; q_mass*1e3 → 2000 ; q_vol*1e6 → 3e6
    expect(lines[1]).toBe(`2020;1500000000;2000;3000000;${CORRECAO_CSV}`);
    expect(lines[2]).toBe(`2021;2500000000;1000;0;${CORRECAO_CSV}`);
  });

  it('o ano sem valor na convenção escolhida sai com a célula VAZIA, nunca com 0', () => {
    // O CSV é pior que a tela: um zero ali é citável, entra em planilha e vira média
    // sem que ninguém veja a lacuna. Anos e valores da PAM em produção — 1974 sem IPCA
    // (o índice começa em 1980), 1980 em R$ 0,4745 bi.
    stubRegistry({
      products: PRODUCTS,
      ts: [
        { y: 1974, v: null, q_mass: 329.2, q_vol: 0 },
        { y: 1980, v: 0.4745, q_mass: 377.2, q_vol: 0 },
      ],
    });
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('\ufeff', '').split('\n');
    expect(lines[1]).toBe(`1974;;329200;0;${CORRECAO_CSV}`);   // valor vazio, quantidade presente
    expect(lines[2]).toBe(`1980;474500000;377200;0;${CORRECAO_CSV}`);
    expect(lines[1]).not.toContain(';0;329200');      // o zero fabricado de antes
  });

  it("'value' view yields the same aggregate subject (shared case)", () => {
    stubRegistry(FILTERED);
    window.exportActiveTableCSV({ view: 'value', summary: {}, database: 'ibge_pevs' });
    expect(lastCsv).toContain('valor_BRL');
  });

  it('o nome carrega o período do ARQUIVO, não o do filtro, quando os dois diferem', () => {
    // Mudança deliberada (v1.44.1). O filtro pede 2005–2021, mas os dados só cobrem
    // 2020–2021: nomear o arquivo "2005-2021" prometeria uma cobertura que o conteúdo não
    // entrega — o rótulo nomeando o todo enquanto o número é a parte, que é a regra que
    // este projeto já registrou. O filtro descreve a INTENÇÃO; a coluna `ano` descreve o
    // que saiu, e é o arquivo que o pesquisador vai abrir seis meses depois.
    stubRegistry(FILTERED);
    window.exportActiveTableCSV({
      view: 'overview',
      summary: { startDate: '2005-01-01', endDate: '2021-12-31' },
      database: 'ibge_pevs',
    });
    const anos = lastCsv.replace('\uFEFF', '').split('\n').slice(1).map((l) => l.split(';')[0]);
    expect(anos[0]).toBe('2020');                          // o que o arquivo realmente tem
    expect(anos[anos.length - 1]).toBe('2021');
    expect(lastDownloadName).toBe('ibge_pevs_serie_agregada_2020-2021.csv');
  });

  it("'completo' fica só para quando NENHUMA fonte de período existe", () => {
    // Sem filtro, sem chip e sem coluna `ano` não há o que afirmar — e inventar seria pior
    // que admitir. Com coluna `ano`, o nome passa a trazê-la (ver os testes de período).
    stubRegistry({ products: PRODUCTS, qualityFlags: [{ id: 'OK', label: 'Íntegra', count: 1, share: 1 }] });
    window.exportActiveTableCSV({ view: 'quality', summary: {}, database: 'ibge_pevs' });
    expect(lastDownloadName).toBe('ibge_pevs_qualidade_completo.csv');
  });
});

// ── product_profile / product_compare: per-product, per-family unit labelling ─
describe('exportActiveTableCSV — per-product series with per-family units', () => {
  const FILTERED = {
    products: PRODUCTS,
    productTS: {
      P1: [{ y: 2020, v: 1.0, q: 2.0 }], // mass → t, mul 1e3
      P2: [{ y: 2020, v: 1.0, q: 2.0 }], // volume → m³, mul 1e6
      P3: [{ y: 2020, v: 1.0, q: 2.0 }], // count → un, mul 1e6
      P9: [{ y: 2020, v: 1.0, q: undefined }], // no family → mass fallback; q || 0
    },
  };

  it('labels each family with its correct base unit (mass→t, volume→m³, count→un)', () => {
    stubRegistry(FILTERED);
    window.exportActiveTableCSV({ view: 'product_compare', summary: {}, database: 'ibge_pevs' });
    expect(lastCsv).toBeTruthy();
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('ano;codigo;produto;valor_BRL;quantidade;unidade;familia;correcao_monetaria');
    const body = lines.slice(1);
    // mass row: q*1e3 = 2000, unit t
    expect(body).toContain(`2020;P1;Açaí;1000000;2000;t;mass;${CORRECAO_CSV}`);
    // volume row: q*1e6 = 2000000, unit m³
    expect(body).toContain(`2020;P2;Madeira;1000000;2000000;m³;volume;${CORRECAO_CSV}`);
    // count row: q*1e6, unit un
    expect(body).toContain(`2020;P3;Bovino;1000000;2000000;un;count;${CORRECAO_CSV}`);
    // missing-family row falls back to mass (mul 1e3) and q||0 → 0
    expect(body.some((l) => l.startsWith('2020;P9;Sem família;1000000;0;t;'))).toBe(true);
  });

  it('neutralizes spreadsheet formula injection in editable product names (CWE-1236)', () => {
    stubRegistry({
      products: [{ code: 'PX', name: '=HYPERLINK("http://evil","x")', family: 'mass' }],
      productTS: { PX: [{ y: 2020, v: 1.0, q: 2.0 }] },
    });
    window.exportActiveTableCSV({ view: 'product_profile', summary: {}, database: 'ibge_pevs' });
    // The name is apostrophe-prefixed (so Excel/LibreOffice won't execute it) and quoted
    // because it contains commas/quotes — never an unguarded leading '='.
    expect(lastCsv).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
    expect(lastCsv).not.toMatch(/;=HYPERLINK/);
  });

  it('product_profile shares the same per-product case', () => {
    stubRegistry(FILTERED);
    window.exportActiveTableCSV({ view: 'product_profile', summary: {}, database: 'ibge_pevs' });
    expect(lastCsv).toContain('series_por_produto'.slice(0, 0) || 'codigo'); // header present
    // O nome traz o ano do arquivo (a série por produto tem coluna `ano`), não "completo".
    expect(lastDownloadName).toBe('ibge_pevs_series_por_produto_2020.csv');
  });
});

// ── geo: single-year snapshot, partial-year + escopo columns ─────────────────
describe('exportActiveTableCSV — geo snapshot', () => {
  const baseUf = [
    { uf: 'PA', name: 'Pará', region: 'Norte', value: 5.0, q_mass: 1.0, q_vol: 2.0 },
    { uf: 'AM', name: 'Amazonas', region: 'Norte', value: 1.0, q_mass: 0, q_vol: 0 },
  ];

  it('flags a partial year + "todos os produtos" escopo and escapes commas/quotes', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: [
        { uf: 'SP', name: 'São Paulo, "Capital"', region: 'Sudeste', value: 5, q_mass: 1, q_vol: 2 },
      ],
      ufLatestYear: 2022,
      ufYearPartial: true,
      notFilteredByBasket: true,
    });
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('ano;uf;nome;regiao;valor_BRL;qtd_massa_t;qtd_volume_m3;escopo_produto;recorte_geografico;tabela_sidra;correcao_monetaria');
    // partial-year string contains a space but no delimiter → not quoted
    expect(lines[1]).toContain('2022 (parcial)');
    // a value containing a comma AND a double-quote must be CSV-escaped
    expect(lines[1]).toContain('"São Paulo, ""Capital"""');
    expect(lines[1]).toContain('todos os produtos');
  });

  it('non-partial year + cesta selecionada escopo', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: baseUf,
      ufLatestYear: 2021,
      ufYearPartial: false,
      notFilteredByBasket: false,
    });
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[1].startsWith('2021;PA;')).toBe(true);
    expect(lastCsv).toContain('cesta selecionada');
  });

  it('handles a null ufLatestYear (empty ano string)', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: baseUf,
      ufLatestYear: null,
      ufYearPartial: false,
      notFilteredByBasket: false,
    });
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    // empty ano → leading semicolon
    expect(lines[1].startsWith(';PA;')).toBe(true);
  });

  // CONF-4: the export must follow ViewGeography's OWN active Granularidade
  // (mirrored via window.geoExportScope/geoExportMunis), not always the per-UF
  // table — a researcher who narrowed to Região or Município on screen used to
  // download the per-UF table regardless.
  it('exports the região table when geoExportScope=region', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: baseUf,
      regionData: [
        { id: 'N', label: 'Norte', value: 6, q_mass: 1, q_vol: 2 },
        { id: 'S', label: 'Sul', value: 2, q_mass: 0.5, q_vol: 0 },
      ],
      ufLatestYear: 2021,
      ufYearPartial: false,
      notFilteredByBasket: false,
    });
    window.geoExportScope = 'region';
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('ano;regiao;valor_BRL;qtd_massa_t;qtd_volume_m3;escopo_produto;recorte_geografico;tabela_sidra;correcao_monetaria');
    expect(lines[1]).toBe(`2021;Norte;6000000;1000;2000000;cesta selecionada;sem recorte sub-UF;ambas as metades;${CORRECAO_CSV}`);
    expect(lines.length).toBe(3); // header + 2 regions, NOT the per-UF table
  });

  it('exports the município table (from geoExportMunis) when geoExportScope=municipio', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: baseUf,
      ufLatestYear: 2021,
      ufYearPartial: false,
      notFilteredByBasket: false,
    });
    window.geoExportScope = 'municipio';
    window.geoExportMunis = [
      { city: 'Belém', uf: 'PA', value: 4, q_mass: 1, q_vol: 0 },
      { city: 'Santos', uf: 'SP', value: 1, q_mass: 0, q_vol: 0.2 },
    ];
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('ano;municipio;uf;valor_BRL;qtd_massa_t;qtd_volume_m3;escopo_produto;recorte_geografico;tabela_sidra;correcao_monetaria');
    expect(lines[1]).toBe(`2021;Belém;PA;4000000;1000;0;cesta selecionada;sem recorte sub-UF;ambas as metades;${CORRECAO_CSV}`);
    expect(lines[2]).toBe(`2021;Santos;SP;1000000;0;200000;cesta selecionada;sem recorte sub-UF;ambas as metades;${CORRECAO_CSV}`);
  });

  it('falls back to the per-UF table when geoExportScope is absent (unchanged default)', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: baseUf,
      ufLatestYear: 2021,
      ufYearPartial: false,
      notFilteredByBasket: false,
    });
    // no window.geoExportScope set — export triggered before Geografia ever mounted.
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('ano;uf;nome;regiao;valor_BRL;qtd_massa_t;qtd_volume_m3;escopo_produto;recorte_geografico;tabela_sidra;correcao_monetaria');
    expect(lines[1].startsWith('2021;PA;')).toBe(true);
  });
});

// ── concentration: sorted by value desc ──────────────────────────────────────
describe('exportActiveTableCSV — concentration (sorted desc by value)', () => {
  it('orders UFs from highest to lowest value', () => {
    stubRegistry({
      products: PRODUCTS,
      ufData: [
        { uf: 'AM', name: 'Amazonas', region: 'Norte', value: 1.0 },
        { uf: 'PA', name: 'Pará', region: 'Norte', value: 9.0 },
      ],
      ufLatestYear: 2021,
      ufYearPartial: false,
      notFilteredByBasket: false,
    });
    window.exportActiveTableCSV({ view: 'concentration', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('ano;uf;nome;regiao;valor_BRL;escopo_produto;recorte_geografico;tabela_sidra;correcao_monetaria');
    // PA (9) must come before AM (1) after the descending sort
    expect(lines[1]).toContain(';PA;');
    expect(lines[2]).toContain(';AM;');
  });
});

// ── quality: flag share rendered as pt-BR percent ────────────────────────────
describe('exportActiveTableCSV — quality flags', () => {
  it('renders the share as a comma-decimal percentage', () => {
    stubRegistry({
      products: PRODUCTS,
      qualityFlags: [
        { id: 'OK', label: 'Sem ressalva', count: 1234, share: 0.9876 },
        { id: 'INCOMPLETE', label: 'Sem valor nem quantidade', count: 12, share: 0.0124 },
      ],
    });
    window.exportActiveTableCSV({ view: 'quality', summary: {}, database: 'ibge_pevs' });
    const lines = lastCsv.replace('﻿', '').split('\n');
    expect(lines[0]).toBe('marca;descricao;linhas;participacao');
    // 0.9876 * 100 = 98.76 → "98,76%" — the comma-decimal is CSV-escaped (quoted)
    // because the esc() regex /[",\n;]/ matches the comma.
    expect(lines[1]).toBe('OK;Sem ressalva;1234;"98,76%"');
    expect(lines[2]).toBe('INCOMPLETE;Sem valor nem quantidade;12;"1,24%"');
    expect(lastDownloadName).toBe('ibge_pevs_qualidade_completo.csv');
  });
});

// ── conventions fallback: ctx.conventions omitted → DEFAULT_CONVENTIONS ───────
describe('exportActiveTableCSV — conventions default', () => {
  it('uses window.DEFAULT_CONVENTIONS when ctx.conventions is absent', () => {
    stubRegistry({ products: PRODUCTS, ts: [{ y: 2020, v: 1, q_mass: 1, q_vol: 1 }] });
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs' });
    // header currency comes from DEFAULT_CONVENTIONS.currency = 'BRL'
    expect(lastCsv).toContain('valor_BRL');
  });

  it('honours an explicit ctx.conventions currency in the header', () => {
    stubRegistry({ products: PRODUCTS, ts: [{ y: 2020, v: 1, q_mass: 1, q_vol: 1 }] });
    window.exportActiveTableCSV({
      view: 'overview',
      summary: {},
      database: 'ibge_pevs',
      conventions: { currency: 'USD' },
    });
    expect(lastCsv).toContain('valor_USD');
  });
});

// ── correcao_monetaria: o que o número É viaja com o arquivo (v1.105.0) ──────────────
// `valor_BRL` saía igual para o nominal e o corrigido: o cabeçalho nomeava a moeda e calava a
// correção, e um CSV solto não tem a faixa de convenções ao lado. Um valor corrigido está a
// preços de UM mês, e o arquivo tem de dizer qual.
describe('exportActiveTableCSV — a correção monetária viaja com o arquivo', () => {
  const TS = [{ y: 2020, v: 1, q_mass: 1, q_vol: 1 }];
  const OUTUBRO = { column: 'val_real_ipca_brl', month: '2026-10', fxDate: null };
  // O valor da última coluna da primeira linha de dados, sem as aspas do CSV.
  const correcaoDoArquivo = (conventions) => {
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'ibge_pevs', conventions });
    const [cabecalho, primeira] = lastCsv.replace('﻿', '').split('\n');
    expect(cabecalho.split(';').at(-1)).toBe('correcao_monetaria');
    return primeira.slice(primeira.lastIndexOf(';') + 1).replace(/^"|"$/g, '');
  };
  afterEach(() => { delete window.dataStore; });

  it('nomeia o índice, a economia e o mês a cujos preços estão os valores', () => {
    stubRegistry({ products: PRODUCTS, ts: TS });
    window.dataStore = { get: () => ({ priceBase: OUTUBRO }) };
    expect(correcaoDoArquivo(CONV)).toBe('IPCA · Brasil, a preços de outubro de 2026');
  });

  it('sem mês conhecido, diz a verdade sem nomeá-lo', () => {
    stubRegistry({ products: PRODUCTS, ts: TS });
    expect(correcaoDoArquivo(CONV)).toBe(CORRECAO);
  });

  it('o nominal diz que não há correção — e uma convenção só com a moeda é o nominal', () => {
    stubRegistry({ products: PRODUCTS, ts: TS });
    const semCorrecao = 'Sem correção pela inflação (valores de cada ano)';
    expect(correcaoDoArquivo({ ...CONV, correction: 'Nominal' })).toBe(semCorrecao);
    expect(correcaoDoArquivo({ currency: 'USD' })).toBe(semCorrecao);
  });

  it('dois meses no mesmo arquivo: não nomeia nenhum, em vez de escolher um', () => {
    // O cubo de municípios (base analítica direta) voltou a preços de setembro e o snapshot
    // (tabelas pré-agregadas) a preços de outubro: um build entre as duas leituras.
    stubRegistry({ products: PRODUCTS, ts: TS, muniPriceBase: { column: null, month: '2026-09', fxDate: null } });
    window.dataStore = { get: () => ({ priceBase: OUTUBRO }) };
    expect(correcaoDoArquivo(CONV)).toBe(CORRECAO);
  });

  it('o mesmo mês dos dois lados continua nomeado', () => {
    stubRegistry({ products: PRODUCTS, ts: TS, muniPriceBase: { column: null, month: '2026-10', fxDate: null } });
    window.dataStore = { get: () => ({ priceBase: OUTUBRO }) };
    expect(correcaoDoArquivo(CONV)).toBe('IPCA · Brasil, a preços de outubro de 2026');
  });

  it('a coluna cruzada (índice brasileiro sob US$) também nomeia o dia do câmbio', () => {
    stubRegistry({ products: PRODUCTS, ts: TS });
    window.dataStore = {
      get: () => ({ priceBase: { column: 'val_real_ipca_usd', month: '2026-10', fxDate: '2026-11-14' } }),
    };
    expect(correcaoDoArquivo({ ...CONV, currency: 'USD' }))
      .toBe('IPCA · Brasil, a preços de outubro de 2026, ao câmbio de 14/11/2026');
  });

  it('a tabela sem coluna de valor (qualidade) não ganha a coluna', () => {
    stubRegistry({ products: PRODUCTS, qualityFlags: [{ id: 'OK', label: 'Sem ressalva', count: 1, share: 1 }] });
    window.exportActiveTableCSV({ view: 'quality', summary: {}, database: 'ibge_pevs' });
    expect(lastCsv).not.toContain('correcao_monetaria');
  });
});

// ---------------------------------------------------------------------------
// A sub-UF recorte narrows the rows WITHOUT removing a UF: a state's row carries a
// fraction of that state and the file used to say nothing. A CSV leaves the product
// for good — no chip, no permalink, no trail beside it — so the recorte has to ride
// along in the table, the way escopo_produto already does for the basket.
// ---------------------------------------------------------------------------
// A metade da pesquisa que o arquivo cobre. Um CSV sai do produto para sempre: sem
// chip nem permalink ao lado, um número que soma floresta nativa com plantada (5:1 a
// favor da plantada) tem de dizer isso na própria tabela.
describe('exportActiveTableCSV — a tabela SIDRA viaja junto com o arquivo', () => {
  const UF_ROW = [{ uf: 'SP', name: 'São Paulo', region: 'Sudeste', value: 5, q_mass: 1, q_vol: 2 }];
  // O registro REAL (filtersSchema.js, importado no topo). Dublá-lo com valores próprios
  // deixaria o CSV concordar com um vocabulário de tabelas que o produto não tem — foi
  // assim que este teste seguiu verde com 'extrativa'/'silvicultura' depois que o dado
  // passou a carregar o id da tabela.
  // RESTAURA em vez de apagar: `delete` removia o resolvedor que o próprio
  // `filtersSchema.js` registra, e os testes seguintes deste arquivo perdiam a coluna.
  const _real = window.tabelaOptionsFor;
  afterEach(() => { window.tabelaOptionsFor = _real; });

  const run = (summary) => {
    stubRegistry({ products: PRODUCTS, ufData: UF_ROW, ufLatestYear: 2024, notFilteredByBasket: true });
    window.exportActiveTableCSV({ view: 'geo', summary, database: 'ibge_pevs' });
    return lastCsv.replace('\ufeff', '').split('\n');
  };

  it('nomeia a metade escolhida', () => {
    const lines = run({ tabela: '291' });
    expect(lines[0]).toContain('tabela_sidra');
    expect(lines[1]).toContain('Silvicultura (plantada)');
  });

  it('diz "ambas as metades" por extenso quando não há recorte', () => {
    // Célula vazia seria ambígua, e aqui a ambiguidade é cara: o leitor não teria como
    // saber se o número é só nativa ou nativa + plantada.
    expect(run({}).slice(1)[0]).toContain('ambas as metades');
  });

  it('não acrescenta a coluna num banco sem a dimensão', () => {
    window.tabelaOptionsFor = () => null;
    expect(run({ tabela: '291' })[0]).not.toContain('tabela_sidra');
  });
});

describe('exportActiveTableCSV — o recorte sub-UF viaja junto com o arquivo', () => {
  const MESH = [
    { cityCode: '1', uf: 'PA', meso: { code: '1502', name: 'Marajó' },
      micro: { code: '15003', name: 'Arari' },
      intermediaria: { code: '1502', name: 'Breves' },
      imediata: { code: '150004', name: 'Breves' } },
  ];

  const UF_ROW = [{ uf: 'PA', name: 'Pará', region: 'Norte', value: 5, q_mass: 1, q_vol: 2 }];

  it('nomeia o recorte em cada linha quando há um', () => {
    stubRegistry({ products: PRODUCTS, ufData: UF_ROW, ufLatestYear: 2024, notFilteredByBasket: true });
    window.geoMesh = () => MESH;
    window.exportActiveTableCSV({ view: 'geo', summary: { mesos: ['1502'] }, database: 'ibge_pevs' });
    const lines = lastCsv.replace('\ufeff', '').split('\n');
    expect(lines[0]).toContain('recorte_geografico');
    expect(lines[1]).toContain('Marajó (PA)');
  });

  it('diz explicitamente que NÃO há recorte, em vez de deixar a coluna vazia', () => {
    // Uma célula vazia é ambígua: "sem recorte" ou "ninguém preencheu?". O leitor de
    // um CSV solto, sem chip nem permalink ao lado, não tem como desempatar.
    stubRegistry({ products: PRODUCTS, ufData: UF_ROW, ufLatestYear: 2024, notFilteredByBasket: true });
    window.geoMesh = () => MESH;
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_pevs' });
    expect(lastCsv.split('\n')[1]).toContain('sem recorte sub-UF');
  });
});

// ── Comparativo entre territórios (v1.94.0) ──────────────────────────────────
describe('exportActiveTableCSV — comparativo entre territórios', () => {
  // Norte = Pará + Amazonas. 2021 has no deflator (value null) but measured tonnes.
  const UF_ROWS = [
    { year: 2020, uf: 'PA', value: 2, q_mass: 3, q_vol: 0.5 },
    { year: 2020, uf: 'AM', value: 1, q_mass: 1, q_vol: 0 },
    { year: 2021, uf: 'PA', value: null, q_mass: 4, q_vol: 0 },
  ];
  const MESH = [{ cityCode: 1501402, cityName: 'Belém', uf: 'PA', region: 'N' }];
  const ctx = (items) => ({
    view: 'territory_compare', database: 'ibge_pevs', summary: {}, conventions: CONV,
    territoryCompare: { items },
  });

  beforeEach(() => {
    stubRegistry({ products: PRODUCTS, yearStart: 2020, yearEnd: 2021 });
    window.dataStore = { get: () => ({ ufYearly: UF_ROWS, products: PRODUCTS }) };
    window.geoLevelFor = () => 'municipio';
    window.geoMesh = () => MESH;
    // The cube's read STATE (v1.108.1): rows, its base, and whether it is loading or failed.
    window.municipioYearly = () => ({
      rows: [{ year: 2021, cityCode: '1501402', uf: 'PA', value: 0.5, q_mass: 1 }],
      priceBase: null, loading: false, loadError: null,
    });
  });
  afterEach(() => {
    for (const k of ['dataStore', 'geoLevelFor', 'geoMesh', 'municipioYearly']) delete window[k];
  });

  it('one row per year and território, every metric in its base unit', () => {
    window.exportActiveTableCSV(ctx([{ level: 'regiao', code: 'N' }, { level: 'municipio', code: '1501402' }]));
    const lines = lastCsv.replace('﻿', '').split('\n');
    // PEVS has two halves, so the file names which one it covers, like every PEVS export.
    expect(lines[0]).toBe('ano;territorio;nivel;codigo;valor_BRL;massa_t;volume_m3;tabela_sidra;correcao_monetaria');
    expect(lines.slice(1)).toEqual([
      `2020;Norte;região;N;3000000;4000;500000;ambas as metades;${CORRECAO_CSV}`,
      // The deflator gap leaves the value cell EMPTY, not 0; the tonnes were measured.
      `2021;Norte;região;N;;4000;0;ambas as metades;${CORRECAO_CSV}`,
      // No row for Belém in 2020: the cube is sparse, so that is a measured 0.
      `2020;Belém (PA);município;1501402;0;0;0;ambas as metades;${CORRECAO_CSV}`,
      `2021;Belém (PA);município;1501402;500000;1000;0;ambas as metades;${CORRECAO_CSV}`,
    ]);
    expect(lastDownloadName).toBe('ibge_pevs_comparativo_territorios_2020-2021.csv');
  });

  it('names what the file holds in the confirmation', () => {
    const p = window.prepareTableCSV(ctx([{ level: 'uf', code: 'PA' }]));
    expect(p.erro).toBe(false);
    expect(p.assunto).toBe('Série anual por território comparado');
  });

  it('refuses with its own reason when nothing is chosen', () => {
    // The generic "sem linhas" would tell the researcher to widen the geography, which
    // does nothing here: the places are chosen on the screen.
    const p = window.prepareTableCSV(ctx([]));
    expect(p).toMatchObject({ erro: true, motivo: 'sem-territorios' });
  });

  it('refuses while a território is still loading, instead of leaving it out', () => {
    window.municipioYearly = () => ({ rows: null, priceBase: null, loading: true, loadError: null });
    const p = window.prepareTableCSV(ctx([{ level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' }]));
    expect(p).toMatchObject({ erro: true, motivo: 'carregando' });
    expect(lastDownloadName).toBeUndefined();
  });

  it('refuses with the failure, not "carregando", when a território failed to load', () => {
    // Until v1.108.1 a failed read stayed "loading" for good, so this said "espere" forever.
    // Leaving the place out would be worse: the file would look complete.
    window.municipioYearly = () => ({ rows: null, priceBase: null, loading: false, loadError: 'HTTP 503' });
    const p = window.prepareTableCSV(ctx([{ level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' }]));
    expect(p).toMatchObject({ erro: true, motivo: 'falha-territorios' });
    expect(lastDownloadName).toBeUndefined();
  });

  it('a failed sub-UF narrowing elsewhere does not block it: the comparison ignores the geography filter', () => {
    stubRegistry({ products: PRODUCTS, yearStart: 2020, yearEnd: 2021, subUfLoadError: 'HTTP 503' });
    const p = window.prepareTableCSV(ctx([{ level: 'uf', code: 'PA' }]));
    expect(p.erro).toBe(false);
  });
});

// ── Um recorte sub-UF que não se resolveu não vira arquivo (v1.108.1) ────────────────────
// While the narrowing loads, or after it failed, applyFilters has no numbers for it: the
// series falls back to the national one. The file would carry that series beside its own
// recorte_geografico column naming the mesorregião — a wrong number with a right label.
describe('exportActiveTableCSV — a sub-UF narrowing still loading or failed refuses the file', () => {
  const UF_ROW = [{ uf: 'PA', name: 'Pará', region: 'N', value: 5, q_mass: 1, q_vol: 2, q_count: 3 }];
  const filtered = (extra) => ({
    products: PRODUCTS,
    ts: [{ y: 2021, v: 1, q_mass: 1, q_vol: 0, q_count: 0 }],
    ufData: UF_ROW, ufLatestYear: 2021, ufYearPartial: false, notFilteredByBasket: false,
    subUfLoading: false, subUfLoadError: null, ...extra,
  });
  const VIEWS = ['overview', 'value', 'geo', 'concentration'];

  it.each(VIEWS)('%s: a failed narrowing refuses with the failure', (view) => {
    stubRegistry(filtered({ subUfLoadError: 'HTTP 503' }));
    const p = window.prepareTableCSV({ view, summary: { mesos: ['1502'] }, database: 'ibge_pevs' });
    expect(p).toMatchObject({ erro: true, motivo: 'falha-recorte' });
  });

  it.each(VIEWS)('%s: a narrowing on its way refuses with "carregando"', (view) => {
    stubRegistry(filtered({ subUfLoading: true }));
    const p = window.prepareTableCSV({ view, summary: { mesos: ['1502'] }, database: 'ibge_pevs' });
    expect(p).toMatchObject({ erro: true, motivo: 'carregando-recorte' });
  });

  it.each(VIEWS)('%s: counter-proof — resolved, the same rows export', (view) => {
    stubRegistry(filtered());
    const p = window.prepareTableCSV({ view, summary: { mesos: ['1502'] }, database: 'ibge_pevs' });
    expect(p.erro).toBe(false);
  });

  it('Geografia at município level: its own read refuses while loading or failed, and only a measured empty list is "sem linhas"', () => {
    stubRegistry(filtered());
    window.geoExportScope = 'municipio';
    window.geoExportMunis = [];
    const ask = () => window.prepareTableCSV({ view: 'geo', summary: { states: ['PA'] }, database: 'ibge_pevs' });
    window.geoExportMuniRead = { loading: false, loadError: 'HTTP 503' };
    expect(ask()).toMatchObject({ erro: true, motivo: 'falha-recorte' });
    window.geoExportMuniRead = { loading: true, loadError: null };
    expect(ask()).toMatchObject({ erro: true, motivo: 'carregando-recorte' });
    window.geoExportMuniRead = { loading: false, loadError: null };
    expect(ask()).toMatchObject({ erro: true, motivo: 'sem-linhas' });
  });
});

// ── As séries por produto sob um recorte sub-UF, e o cruzamento cesta × UF (v1.108.2) ──
// The per-product series are NATIONAL: under a sub-UF recorte the file carried the whole
// country's numbers in rows its recorte_geografico column labelled with the mesorregião. No
// state of the recorte changes that, so the file is refused in all three — waiting would not
// help, and "carregando-recorte" would promise a file that never comes. The aggregate series,
// meanwhile, needs the basket's UF cube beside a UF subset, and had no reason of its own while
// that cube loaded or after it failed.
describe('exportActiveTableCSV — per-product series under a sub-UF recorte, and the basket × UF cross', () => {
  const filtered = (extra) => ({
    products: PRODUCTS,
    productTS: { P1: [{ y: 2020, v: 1.0, q: 2.0 }] },
    ts: [{ y: 2020, v: 1, q_mass: 1, q_vol: 0, q_count: 0 }],
    ufData: [], ufLatestYear: 2020, ufYearPartial: false, notFilteredByBasket: false,
    subUfLoading: false, subUfLoadError: null, geoComboPending: false, geoComboLoadError: null,
    ...extra,
  });
  const pedir = (view, summary = {}) => window.prepareTableCSV({ view, summary, database: 'ibge_ppm' });

  it.each(['product_profile', 'product_compare'])(
    '%s: a sub-UF recorte refuses in every state — the series exist only nationally', (view) => {
      for (const estado of [{ subUfLoading: true }, { subUfLoadError: 'HTTP 503' }, { subUfLoaded: true }]) {
        stubRegistry(filtered({ subUfRequested: true, ...estado }));
        expect(pedir(view, { munis: ['1505809'] }), JSON.stringify(estado))
          .toMatchObject({ erro: true, motivo: 'recorte-nao-se-aplica' });
      }
    });

  it.each(['product_profile', 'product_compare'])('%s: counter-proof — no recorte, the series export', (view) => {
    stubRegistry(filtered({ subUfRequested: false }));
    expect(pedir(view).erro).toBe(false);
  });

  it.each(['overview', 'value'])('%s: the basket × UF cross on its way, or failed, has its own reason', (view) => {
    stubRegistry(filtered({ geoComboPending: true }));
    expect(pedir(view, { basket: ['P1'], states: ['PA'] })).toMatchObject({ erro: true, motivo: 'carregando-cesta-uf' });
    stubRegistry(filtered({ geoComboLoadError: 'HTTP 503' }));
    expect(pedir(view, { basket: ['P1'], states: ['PA'] })).toMatchObject({ erro: true, motivo: 'falha-cesta-uf' });
    stubRegistry(filtered());
    expect(pedir(view, { basket: ['P1'], states: ['PA'] }).erro).toBe(false); // counter-proof
  });

  it('a sub-UF reason comes first: the recorte is what the file waits for', () => {
    stubRegistry(filtered({ subUfLoading: true, geoComboPending: true }));
    expect(pedir('overview', { mesos: ['1502'], basket: ['P1'] })).toMatchObject({ motivo: 'carregando-recorte' });
  });
});

// ── Counts (v1.108.0): one column per thing counted ──────────────────────────
// Until v1.108.0 every file had ONE qtd_contagem_un column, and for the PPM it carried the
// herd's heads plus a year's eggs: Mato Grosso 2025 would read 3.883.600.000 "unidades".
describe('exportActiveTableCSV — a count column per thing counted', () => {
  // PPM count products as the API serves them; the groups come from the REAL rule.
  const BOVINO = { code: '2670', name: 'Bovino', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
  const OVOS = { code: '2685', name: 'Ovos de galinha', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
  // No banco holds eggs and counted fruits together today; this one proves the refusal.
  const ABACAXI = { code: '40092', name: 'Abacaxi', family: 'count', unit_native: 'Mil frutos' };
  const withCounts = (products, rest = {}) => {
    const codes = products.map((p) => p.code);
    return { products, selectedProducts: codes, countGroups: window.countGroups(products, codes), ...rest };
  };
  // Mato Grosso 2025 as measured on prod, in mi un: 80,4 mi heads, 3,80 bi eggs.
  const MT = {
    uf: 'MT', name: 'Mato Grosso', region: 'Centro-Oeste', value: 900, q_mass: 0, q_vol: 0,
    q_count_stock: 80.4, q_count_flow: 3803.2,
  };
  const GEO = { ufData: [MT], ufLatestYear: 2025, ufYearPartial: false, notFilteredByBasket: false };
  const header = () => lastCsv.replace('﻿', '').split('\n')[0].split(';');
  const firstRow = () => lastCsv.replace('﻿', '').split('\n')[1].split(';');
  const cell = (col) => firstRow()[header().indexOf(col)];

  it('the aggregate series carries the herd and the eggs in two named columns, never their sum', () => {
    stubRegistry(withCounts([BOVINO, OVOS], {
      ts: [{ y: 2025, v: 1, q_mass: 0, q_vol: 0, q_count_stock: 80.4, q_count_flow: 3803.2 }],
    }));
    window.exportActiveTableCSV({ view: 'overview', summary: {}, database: 'ibge_ppm' });
    expect(header()).toEqual(['ano', 'valor_BRL', 'qtd_massa_t', 'qtd_volume_m3',
      'efetivo_cabecas', 'qtd_ovos', 'correcao_monetaria']);
    expect(cell('efetivo_cabecas')).toBe('80400000');     // heads
    expect(cell('qtd_ovos')).toBe('3803200000');          // eggs
    expect(lastCsv).not.toContain('3883600000');          // heads + eggs, the old column
  });

  it('every geography file carries the same two columns: UF, região and município', () => {
    stubRegistry(withCounts([BOVINO, OVOS], {
      ...GEO,
      regionData: [{ id: 'CO', label: 'Centro-Oeste', value: 900, q_mass: 0, q_vol: 0,
        q_count_stock: 80.4, q_count_flow: 3803.2 }],
    }));
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_ppm' });
    expect([cell('efetivo_cabecas'), cell('qtd_ovos')]).toEqual(['80400000', '3803200000']);

    window.geoExportScope = 'region';
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_ppm' });
    expect(header()[1]).toBe('regiao');
    expect([cell('efetivo_cabecas'), cell('qtd_ovos')]).toEqual(['80400000', '3803200000']);

    window.geoExportScope = 'municipio';
    window.geoExportMunis = [{ city: 'Cáceres', uf: 'MT', value: 1, q_mass: 0, q_vol: 0,
      q_count_stock: 1.1, q_count_flow: 2.5 }];
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_ppm' });
    expect(header()[1]).toBe('municipio');
    expect([cell('efetivo_cabecas'), cell('qtd_ovos')]).toEqual(['1100000', '2500000']);
  });

  it('the concentration file too', () => {
    stubRegistry(withCounts([BOVINO, OVOS], GEO));
    window.exportActiveTableCSV({ view: 'concentration', summary: {}, database: 'ibge_ppm' });
    expect([cell('efetivo_cabecas'), cell('qtd_ovos')]).toEqual(['80400000', '3803200000']);
  });

  it('a herd-only basket has the herd column alone', () => {
    stubRegistry(withCounts([BOVINO], GEO));
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_ppm' });
    expect(header().filter((h) => /^(efetivo|qtd)_/.test(h) && !/massa|volume/.test(h)))
      .toEqual(['efetivo_cabecas']);
  });

  it('products that count different things get no column, as they get no map', () => {
    stubRegistry(withCounts([OVOS, ABACAXI], GEO));
    window.exportActiveTableCSV({ view: 'geo', summary: {}, database: 'ibge_ppm' });
    expect(header().some((h) => /ovos|frutos|unidade/.test(h))).toBe(false);
  });

  it('the territory comparison builds one series per count group, each in its own column', () => {
    const ROWS = [
      { year: 2025, uf: 'MT', value: 900, q_mass: 0, q_vol: 0, q_count_stock: 80.4, q_count_flow: 3803.2 },
    ];
    stubRegistry(withCounts([BOVINO, OVOS], { yearStart: 2025, yearEnd: 2025 }));
    window.UF_DATA = [{ uf: 'MT', name: 'Mato Grosso', region: 'CO' }];
    window.dataStore = { get: () => ({ ufYearly: ROWS, products: [BOVINO, OVOS] }) };
    try {
      window.exportActiveTableCSV({
        view: 'territory_compare', database: 'ibge_ppm', summary: {}, conventions: CONV,
        territoryCompare: { items: [{ level: 'uf', code: 'MT' }] },
      });
      expect(header().slice(0, 9)).toEqual(['ano', 'territorio', 'nivel', 'codigo', 'valor_BRL',
        'massa_t', 'volume_m3', 'efetivo_cabecas', 'qtd_ovos']);
      expect([cell('efetivo_cabecas'), cell('qtd_ovos')]).toEqual(['80400000', '3803200000']);
    } finally {
      for (const k of ['UF_DATA', 'dataStore']) delete window[k];
    }
  });
});
