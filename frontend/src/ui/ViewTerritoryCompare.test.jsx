// ViewTerritoryCompare.test.jsx — the screen of "Comparativo entre territórios".
//
// The data rules are pinned in territoryCompare.test.js; this file pins what the reader
// sees and does: choosing places at any level, the notes that keep a mixed comparison
// honest (scale, and one line containing another), the share of the country, and the
// banco that has no município grain saying so.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import './territoryCompare.js';

// Pará and Amazonas are Norte; São Paulo is Sudeste. Growth differs on purpose, so the
// index mode has something to show.
const UF_ROWS = [
  { year: 2019, uf: 'PA', value: 100, q_mass: 10 },
  { year: 2019, uf: 'AM', value: 20, q_mass: 2 },
  { year: 2019, uf: 'SP', value: 100, q_mass: 30 },
  { year: 2020, uf: 'PA', value: 200, q_mass: 20 },
  { year: 2020, uf: 'AM', value: 30, q_mass: 3 },
  { year: 2020, uf: 'SP', value: 150, q_mass: 35 },
  { year: 2021, uf: 'PA', value: 300, q_mass: 30 },
  { year: 2021, uf: 'AM', value: 40, q_mass: 4 },
  { year: 2021, uf: 'SP', value: 200, q_mass: 40 },
];
const MESH = [
  { cityCode: 1501402, cityName: 'Belém', uf: 'PA', region: 'N' },
  { cityCode: 2211001, cityName: 'Teresina', uf: 'PI', region: 'NE' },
];

let charts;
const BELEM_ROWS = [{ year: 2021, cityCode: '1501402', uf: 'PA', value: 30, q_mass: 3 }];

// The município loaders return their read's STATE (v1.107.3). `mesh`/`muniRows` null = still
// on its way; `meshError`/`muniError` = every retry failed.
function stub({ geoLevel = 'municipio', families = ['mass'], mesh = MESH, meshError = null,
  muniRows = BELEM_ROWS, muniError = null } = {}) {
  charts = [];
  const products = families.map((f, i) => ({ code: `p${i}`, family: f }));
  window.dataStore = { get: () => ({ ufYearly: UF_ROWS, products }) };
  window.applyFilters = () => ({ yearStart: 2019, yearEnd: 2021 });
  window.geoLevelFor = () => geoLevel;
  window.geoMeshState = () => (meshError
    ? { municipios: null, loading: false, loadError: meshError }
    : { municipios: mesh, loading: mesh == null, loadError: null });
  window.geoMesh = () => window.geoMeshState().municipios;
  window.municipioYearly = () => (muniError
    ? { rows: null, priceBase: null, loading: false, loadError: muniError }
    : { rows: muniRows, priceBase: null, loading: muniRows == null, loadError: null });
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err" role="alert">{String(error)}</div> : null);
  window.geoYearly = () => null;
  window.DEFAULT_CONVENTIONS = { currency: 'BRL', correction: 'Nominal' };
  window.CURRENCY_FX = { BRL: { symbol: 'R$' } };
  window.formatValue = (v) => (v == null ? '—' : `R$ ${v}`);
  window.formatMassQty = (v) => (v == null ? '—' : `${v} mil t`);
  window.formatVolumeQty = (v) => (v == null ? '—' : `${v} mi m³`);
  window.formatCountQty = (v) => (v == null ? '—' : `${v} mi un`);
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh"><span className="sh-overline">{overline}</span>
      <span className="sh-title">{title}</span>{action}</div>
  );
  window.MultiLineChart = ({ series, label }) => {
    charts.push({ series, label });
    return <div className="mlc" data-label={label} />;
  };
}

// The same controlled loop main.jsx runs: the view proposes, the parent keeps. What the
// view proposes is recorded in the setter (an event), never during render.
let lastState;
function Harness({ initial = {}, database = 'ibge_pevs', summary = {} }) {
  const [st, setSt] = React.useState(initial);
  const keep = (next) => { lastState = next; setSt(next); };
  return (
    <window.ViewTerritoryCompare territoryCompare={st} setTerritoryCompare={keep}
                                 database={database} summary={summary}
                                 conventions={{ currency: 'BRL', correction: 'Nominal' }} />
  );
}

const chips = (c) => [...c.querySelectorAll('.tc-sel-chip')].map((n) => n.firstChild.nextSibling.textContent.trim());
const overlines = (c) => [...c.querySelectorAll('.sh-overline')].map((n) => n.textContent);
const notes = (c) => [...c.querySelectorAll('.tc-note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
const button = (c, text) => [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const lastChart = () => charts[charts.length - 1];

beforeEach(async () => {
  await import('./ViewTerritoryCompare.jsx');
  stub();
  lastState = undefined;   // nothing proposed yet
});

afterEach(() => {
  cleanup();
  for (const k of ['dataStore', 'applyFilters', 'geoLevelFor', 'geoMesh', 'geoMeshState', 'municipioYearly',
    'geoYearly', 'SectionHeader', 'MultiLineChart', 'LoadErrorNote']) delete window[k];
});

describe('ViewTerritoryCompare — choosing the places', () => {
  it('opens on the three largest states, without writing a choice nobody made', () => {
    const { container } = render(<Harness />);
    expect(chips(container)).toEqual(['Pará', 'São Paulo', 'Amazonas']);
    expect(overlines(container)[0]).toBe('Territórios · 3 de 8');
    // Shown, not stored: the URL keeps no `tc` until the researcher changes something.
    expect(lastState).toBeUndefined();
  });

  it('adds a região beside the states, and the mixed comparison explains itself', () => {
    const { container } = render(<Harness />);
    fireEvent.click(button(container, 'Norte'));
    expect(lastState.items).toEqual([
      { level: 'uf', code: 'PA' }, { level: 'uf', code: 'SP' }, { level: 'uf', code: 'AM' },
      { level: 'regiao', code: 'N' },
    ]);
    const n = notes(container);
    expect(n.some((t) => t.includes('mistura níveis diferentes'))).toBe(true);
    // Pará's line is PART of Norte's, and the reader is told so.
    expect(n).toContain('Pará está dentro de Norte: a linha de Norte já inclui a de Pará.');
    expect(n).toContain('Amazonas está dentro de Norte: a linha de Norte já inclui a de Amazonas.');
  });

  it('adds a state from the list and a município from the search, accent-insensitive', () => {
    const { container } = render(<Harness initial={{ items: [] }} />);
    fireEvent.change(container.querySelector('#tc-uf'), { target: { value: 'SP' } });
    const input = container.querySelector('#tc-muni');
    fireEvent.change(input, { target: { value: 'belem' } });
    fireEvent.click(button(container, 'Belém (PA)'));
    expect(lastState.items).toEqual([{ level: 'uf', code: 'SP' }, { level: 'municipio', code: '1501402' }]);
    expect(input.value).toBe('');                  // the search clears after a pick
    expect(chips(container)).toEqual(['São Paulo', 'Belém (PA)']);
  });

  it('says so when no município matches, and waits for three letters before searching', () => {
    const { container } = render(<Harness initial={{ items: [] }} />);
    const input = container.querySelector('#tc-muni');
    fireEvent.change(input, { target: { value: 'be' } });
    expect(container.querySelector('.tc-matches')).toBeNull();
    fireEvent.change(input, { target: { value: 'xyzw' } });
    expect(container.textContent).toContain('Nenhum município com esse nome.');
  });

  it('removes one place, and clears all into an explicit empty choice', () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('[aria-label="Remover São Paulo"]'));
    expect(chips(container)).toEqual(['Pará', 'Amazonas']);
    fireEvent.click(button(container, 'Limpar'));
    expect(lastState.items).toEqual([]);           // emptied on purpose, not "no choice yet"
    expect(container.textContent).toContain('Nenhum território escolhido');
    expect(container.querySelector('.mlc')).toBeNull();
  });

  it('stops adding at the limit of eight', () => {
    const eight = ['PA', 'AM', 'SP', 'RJ', 'MG', 'BA', 'PR', 'RS'].map((code) => ({ level: 'uf', code }));
    const { container } = render(<Harness initial={{ items: eight }} />);
    expect(container.querySelector('#tc-uf').disabled).toBe(true);
    expect(container.querySelector('#tc-muni').disabled).toBe(true);
    fireEvent.click(button(container, 'Norte'));
    expect(lastState).toBeUndefined();               // a ninth is not even proposed
    expect(chips(container)).toHaveLength(8);
  });

  it('a banco without município grain says so instead of offering a search', () => {
    stub({ geoLevel: 'uf' });
    const { container } = render(<Harness initial={{ items: [{ level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' }] }} />);
    expect(container.querySelector('#tc-muni')).toBeNull();
    expect(container.textContent).toContain('Este banco não tem dados por município.');
    // A município arriving from an old link is named, not silently dropped or zeroed.
    expect(container.textContent).toContain('sem dado por município neste banco');
  });
});

describe('ViewTerritoryCompare — the numbers', () => {
  it('index mode rebases every line to 100 in the common first year', () => {
    const { container } = render(<Harness />);
    fireEvent.click(button(container, 'Índice (base 100)'));
    expect(lastState.mode).toBe('index');
    const chart = lastChart();
    expect(chart.series.map((s) => s.data[0].v)).toEqual([100, 100, 100]);
    expect(chart.series[0].data.map((p) => p.v)).toEqual([100, 200, 300]);   // Pará
    expect(overlines(container)).toContain('Índice · base 100 em 2019');
    // The scale note is about absolute values, so it leaves with them.
    fireEvent.click(button(container, 'Norte'));
    expect(notes(container).some((t) => t.includes('mistura níveis diferentes'))).toBe(false);
  });

  it('the table gives the latest year, the growth and the share of the whole country', () => {
    const { container } = render(<Harness initial={{ items: [{ level: 'uf', code: 'PA' }, { level: 'regiao', code: 'N' }] }} />);
    const head = [...container.querySelectorAll('.pc-table th')].map((t) => t.textContent);
    expect(head).toContain('Em 2021');
    const rows = [...container.querySelectorAll('.pc-table tbody tr')]
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    // Pará: 300 of the country's 540 in 2021. Norte: (300 + 40) of 540.
    expect(rows[0][0]).toBe('Pará');
    expect(rows[0][5]).toBe('55,6%');
    expect(rows[1][0]).toBe('Norte');
    expect(rows[1][5]).toBe('63%');
    expect(rows[0][2]).toBe('R$ 300000000');   // the cube's millions, scaled back to units
  });

  it('offers only the quantity families the basket carries, in the cube units', () => {
    const { container } = render(<Harness />);
    expect(button(container, 'Quantidade (massa)')).toBeTruthy();
    expect(button(container, 'Quantidade (volume)')).toBeUndefined();   // tonnes and m³ never sum
    fireEvent.click(button(container, 'Quantidade (massa)'));
    expect(lastState.metric).toBe('mass');
    expect(lastChart().label).toBe('mil t');
    expect(overlines(container)).toContain('Quantidade (massa) · mil t');
  });

  it('in nominal R$ across a currency reform, every base-year measure starts in the current currency', () => {
    // Measured on PEVS before this rule: "+3.265.734.304.470% desde 1986", a ratio
    // between cruzados and reais. The fixture puts a reform in 2020.
    window.dataStore = { get: () => ({ ufYearly: UF_ROWS, products: [{ code: 'p0', family: 'mass' }],
      valueEraBreaks: [2020] }) };
    const { container } = render(<Harness initial={{ items: [{ level: 'uf', code: 'PA' }], mode: 'index' }} />);
    expect(overlines(container)).toContain('Índice · base 100 em 2020');
    expect(lastChart().series[0].data).toEqual([{ y: 2020, v: 100 }, { y: 2021, v: 150 }]);
    expect([...container.querySelectorAll('.pc-table th')].map((t) => t.textContent))
      .toContain('Variação acumulada (desde 2020)');
    expect(notes(container).some((t) => t.includes('os anos antes de 2020 estão em outra moeda'))).toBe(true);

    // Tonnes have no currency: the same reform leaves the quantity untouched.
    fireEvent.click(button(container, 'Quantidade (massa)'));
    expect(overlines(container)).toContain('Índice · base 100 em 2019');
    expect(notes(container).some((t) => t.includes('outra moeda'))).toBe(false);
  });

  it('marks a partial latest year and says the comparison is not direct', () => {
    // A monthly banco in September: 2021 covers 8 months. The numbers keep the window
    // (the Overview's rule); the screen marks the year instead of hiding it.
    window.dataStore.meta = () => ({ latest: { yearComplete: false, completeYear: 2020, monthsInLatestYear: 8 } });
    const { container } = render(<Harness initial={{ items: [{ level: 'uf', code: 'PA' }] }} />);
    expect([...container.querySelectorAll('.pc-table th')].map((t) => t.textContent)).toContain('Em 2021 (parcial)');
    expect(notes(container).some((t) => t.startsWith('2021 (parcial): o ano mais recente cobre apenas 8 meses.'))).toBe(true);
  });

  it('a complete latest year carries no mark', () => {
    window.dataStore.meta = () => ({ latest: { yearComplete: true, completeYear: 2021 } });
    const { container } = render(<Harness initial={{ items: [{ level: 'uf', code: 'PA' }] }} />);
    expect([...container.querySelectorAll('.pc-table th')].map((t) => t.textContent)).toContain('Em 2021');
    expect(notes(container).some((t) => t.includes('(parcial)'))).toBe(false);
  });

  it('asks for two places before a correlation', () => {
    const { container } = render(<Harness initial={{ items: [{ level: 'uf', code: 'PA' }] }} />);
    expect(container.textContent).toContain('Escolha ao menos 2 territórios para calcular a correlação.');
  });
});

// ── Carregando, falhou ou vazio: três respostas diferentes (v1.107.3) ────────────────────
// Until v1.107.3 a failed município read came back null like a pending one: its legend
// said "carregando…" for good, and a failed mesh left the search silently empty.
describe('ViewTerritoryCompare — a município read loading, failed or empty', () => {
  const PA_BELEM = { items: [{ level: 'uf', code: 'PA' }, { level: 'municipio', code: '1501402' }] };
  const legend = (c) => c.querySelector('.pc-legend').textContent;

  it('a failed município is named as failed, left out of the chart, and the card says why', () => {
    stub({ muniError: 'HTTP 503' });
    const { container } = render(<Harness initial={PA_BELEM} />);
    expect(legend(container)).toContain('Belém (PA) · não foi possível carregar');
    expect(legend(container)).not.toContain('carregando');
    expect(container.querySelector('.load-err')).not.toBeNull();
    expect(lastChart().series.map((s) => s.name)).toEqual(['Pará']); // the place that loaded stays
  });

  it('a município on its way says "carregando…", with no failure note', () => {
    stub({ muniRows: null });
    const { container } = render(<Harness initial={PA_BELEM} />);
    expect(legend(container)).toContain('Belém (PA) · carregando…');
    expect(container.querySelector('.load-err')).toBeNull();
  });

  it('a município measured empty is drawn (at zero), neither loading nor failed', () => {
    stub({ muniRows: [] });
    const { container } = render(<Harness initial={PA_BELEM} />);
    expect(legend(container)).not.toMatch(/carregando|não foi possível/);
    expect(lastChart().series.map((s) => s.name)).toEqual(['Pará', 'Belém (PA)']);
  });

  it('a failed IBGE mesh disables the search and says why', () => {
    stub({ meshError: 'HTTP 503' });
    const { container } = render(<Harness initial={{ items: [] }} />);
    const input = container.querySelector('#tc-muni');
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe('Lista de municípios indisponível');
    expect(container.textContent).toContain('Não foi possível carregar a lista de municípios do IBGE');
    expect(container.textContent).not.toContain('Carregando a lista de municípios');
  });

  it('a mesh on its way answers a search with "carregando", never with "nenhum município"', () => {
    stub({ mesh: null });
    const { container } = render(<Harness initial={{ items: [] }} />);
    fireEvent.change(container.querySelector('#tc-muni'), { target: { value: 'belem' } });
    expect(container.textContent).toContain('Carregando a lista de municípios…');
    expect(container.textContent).not.toContain('Nenhum município com esse nome.');
  });
});
