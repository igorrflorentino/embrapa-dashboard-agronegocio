// ViewTerritoryProfile.cov.test.jsx — the raio-x of ONE território.
//
// The behaviours worth pinning are the honesty ones, because they are the ones that
// look fine while being wrong:
//   - share/rank are computed over the SELECTED WINDOW, not one latest year (the
//     chart beside them spans the window; two questions under one label is the bug);
//   - the national denominator deliberately ignores an active UF filter, else the
//     share of a filtered-to-one-state view would always read 100%;
//   - a banco with only UF grain SAYS so instead of silently offering no município;
//   - a município reading does not borrow the state's share/rank without saying so.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// O registro REAL de origem + `labelProductRows`. Dublá-lo deixaria o teste concordar com
// uma regra que o produto não tem — e a regra aqui é justamente qual rótulo cada barra leva.
import './filtersSchema.js';
// The REAL period/price-base helpers (periodoDaSoma, mesBase, PriceBaseSkewNote): the screen
// text under test is theirs, and a stub would agree with whatever the view passed it.
import './MonetaryNotes.jsx';
// Same reason for the two atoms the composition card states with. NotApplicableNote was
// stubbed with a `children` signature the real atom does not have (it reads a `note`
// OBJECT), so the screen passed its UF-only notice as children, the stub drew it, the
// test passed — and production drew nothing. stubGlobals below overrides the OTHER atoms
// of Atoms.jsx, never this one.
import './Atoms.jsx';
import './CollapsingNameList.jsx';

// The shell the real producers return (data/producers.js · productBreakdownOf).
const MEDIDO = (products) => ({ products, loading: false, unavailable: false, loadError: null });

function stubGlobals(filtered, opts = {}) {
  window.applyFilters = () => filtered;
  window.DEFAULT_CONVENTIONS = { currency: 'BRL', correction: 'IPCA' };
  window.CURRENCY_FX = { BRL: { symbol: 'R$' }, USD: { symbol: 'US$' } };
  window.conventionMonetaryLabel = () => 'R$';
  window.convFactor = () => 1;
  window.scaleSeries = (data, _max, _conv, _key, label) => ({ data, label });
  window.formatValue = (v) => `val:${Math.round(v)}`;
  window.fmtSigned = () => '+0%';
  // Mirrors the real data.js contract: takes a FRACTION, multiplies by 100.
  window.fmtPct = (x) => `${((x || 0) * 100).toFixed(1)}%`;
  window.geoLevelFor = () => opts.geoLevel || 'municipio';
  window.selectedSingleUf = (s) => (s && s.states && s.states.length === 1 ? s.states[0] : null);
  // The município loaders return their read's STATE (v1.107.3). `mesh: null` is the IBGE
  // mesh still on its way, `meshError` one that failed; omitted, it is an empty mesh.
  // `municipioYearly` gives the cube's rows (null = still on its way), `muniError` a cube
  // that failed, and `muniBase` its price base — from the same response, as in production.
  const meshList = 'mesh' in opts ? opts.mesh : [];
  window.geoMeshState = () => (opts.meshError
    ? { municipios: null, loading: false, loadError: opts.meshError }
    : { municipios: meshList, loading: meshList == null, loadError: null });
  window.geoMesh = () => window.geoMeshState().municipios;
  const rowsOf = opts.municipioYearly || (() => []);
  window.municipioYearly = (...args) => {
    if (opts.muniError) return { rows: null, priceBase: null, loading: false, loadError: opts.muniError };
    const rows = rowsOf(...args);
    return {
      rows, priceBase: rows && opts.muniBase ? opts.muniBase(...args) : null,
      loading: rows == null, loadError: null,
    };
  };
  window.productsByUf = opts.productsByUf || (() => MEDIDO([]));
  window.productsByMunicipio = opts.productsByMunicipio || (() => MEDIDO([]));

  window.Icon = () => null;   // the real NotApplicableNote draws one
  window.EmptyCard = ({ children }) => <div className="empty-card">{children}</div>;
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err" /> : null);
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi"><span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span><span className="kpi-sub">{sub}</span></div>
  );
  window.SectionHeader = ({ title, overline }) => (
    <div className="sh"><span className="sh-overline">{overline}</span>
      <span className="sh-title">{title}</span></div>
  );
  window.LineChart = (props) => <div className="line-chart" data-points={(props.data || []).length} />;
  window.BarChart = (props) => (
    <div className="bar-chart" data-points={(props.data || []).length}
         data-first={(props.data || [])[0] ? props.data[0].name : ''}
         // As CATEGORIAS que chegam ao gráfico: é o que o Plotly funde quando se repetem,
         // e era exatamente o que o defeito das barras borradas corrompia.
         data-cats={(props.data || []).map((d) => d.uf || d.name).join('|')} />
  );
}

// PA dominates the window; SP is second. Deliberately NOT flat across years, so a
// latest-year shortcut would produce a DIFFERENT share than the window total.
const BASE = {
  yearStart: 2019,
  yearEnd: 2021,
  ufDataFull: [
    { uf: 'PA', name: 'Pará' },
    { uf: 'SP', name: 'São Paulo' },
  ],
  ufYearlySeries: [
    { year: 2019, uf: 'PA', value: 100 },
    { year: 2020, uf: 'PA', value: 200 },
    { year: 2021, uf: 'PA', value: 300 },   // PA window total = 600
    { year: 2019, uf: 'SP', value: 100 },
    { year: 2020, uf: 'SP', value: 100 },
    { year: 2021, uf: 'SP', value: 200 },   // SP window total = 400
  ],
};

const CONV = { currency: 'BRL', correction: 'IPCA' };
let View;

beforeEach(async () => {
  await import('./ViewTerritoryProfile.jsx');
  View = window.ViewTerritoryProfile;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.municipioYearly;
  delete window.productsByMunicipio;
  delete window.productsByUf;
  delete window.geoMesh;
  delete window.geoMeshState;
  delete window.dataStore;
});

const kpi = (c, label) => [...c.querySelectorAll('.kpi')]
  .find((k) => k.querySelector('.kpi-label').textContent.includes(label));

describe('ViewTerritoryProfile — share and rank over the SELECTED window', () => {
  it('computes share from the window total, not from one latest year', () => {
    stubGlobals(BASE);
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    // PA 600 of 1000 = 60,0%. A latest-year shortcut would say 300/500 = 60% by
    // coincidence here, so the fixture's 2020 (200/300 = 66,7%) is what separates them:
    // the assertion below is on the WINDOW figure.
    expect(kpi(container, 'Participação').querySelector('.kpi-value').textContent).toBe('60.0%');
    // And it must name the years it summed, so the number is checkable.
    expect(kpi(container, 'Participação').querySelector('.kpi-sub').textContent)
      .toContain('soma de 2019 a 2021');
  });

  it('ranks by the window total and reports the universe size', () => {
    stubGlobals(BASE);
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    // PA (600) outranks SP (400) → 1º of 2.
    expect(kpi(container, 'Posição').querySelector('.kpi-value').textContent).toBe('1º');
    expect(kpi(container, 'Posição').querySelector('.kpi-sub').textContent).toContain('de 2 UFs');
  });

  it('keeps the national denominator whole under an active UF filter', () => {
    // Filtering to PA must NOT make PA's share 100%: the denominator is every UF in
    // the grid on purpose, which is the only reading of "participação no país".
    stubGlobals(BASE);
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pevs" conventions={CONV} />,
    );
    expect(kpi(container, 'Participação').querySelector('.kpi-value').textContent).toBe('60.0%');
  });

  it('seeds the território from a single-UF filter (arriving from a map click)', () => {
    stubGlobals(BASE);
    const { container } = render(
      <View summary={{ states: ['SP'] }} database="ibge_pevs" conventions={CONV} />,
    );
    // SP, not the value-ranked default (PA).
    expect(container.querySelector('.sh-title').textContent).toContain('São Paulo');
    expect(kpi(container, 'Posição').querySelector('.kpi-value').textContent).toBe('2º');
  });
});

describe('ViewTerritoryProfile — declaring what the banco cannot answer', () => {
  it('says a UF-only banco has no município grain, and hides the level toggle', () => {
    stubGlobals(BASE, { geoLevel: 'uf' });
    const { container } = render(<View summary={{}} database="mdic_comex" conventions={CONV} />);
    expect(container.querySelector('.na-note').textContent).toContain('apenas por');
    // No município option at all — offering one that returns nothing would read as
    // "this state has no municípios producing", which is a different claim.
    expect(container.querySelector('[aria-label="Nível do território"]')).toBeNull();
  });

  it('offers the município level when the banco has that grain', () => {
    stubGlobals(BASE, { mesh: [{ cityCode: '1500107', cityName: 'Abaetetuba', uf: 'PA' }] });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(container.querySelector('[aria-label="Nível do território"]')).toBeTruthy();
    expect(container.querySelector('.na-note')).toBeNull();
  });
});

describe('ViewTerritoryProfile — the município reading', () => {
  const MESH = [
    { cityCode: '1500107', cityName: 'Abaetetuba', uf: 'PA' },
    { cityCode: '1500206', cityName: 'Acará', uf: 'PA' },
    { cityCode: '3550308', cityName: 'São Paulo', uf: 'SP' },
  ];

  it('draws the city trajectory from the city-scoped cube and names its produtos', () => {
    const municipioYearly = vi.fn(() => [
      { year: 2020, cityCode: '1500107', uf: 'PA', value: 7 },
      { year: 2021, cityCode: '1500107', uf: 'PA', value: 9 },
    ]);
    const productsByMunicipio = vi.fn(() => ({
      products: [{ code: '4403', name: 'Madeira em tora', value: 6 },
                 { code: '0801', name: 'Castanha', value: 3 }],
      loadError: null,
    }));
    stubGlobals(BASE, { mesh: MESH, municipioYearly, productsByMunicipio });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);

    fireEvent.click([...container.querySelectorAll('.seg-opt')]
      .find((b) => b.textContent === 'Município'));

    // The cube must be asked for ONE city and the window — the city scope IS the cost
    // control on a direct Gold read, so a call without it would be the expensive bug.
    const [, , cityCodes, years] = municipioYearly.mock.calls.at(-1);
    expect(cityCodes).toEqual(['1500107']);
    expect(years).toEqual([2019, 2021]);
    // The produtos behind the trajectory: the cube alone cannot name them.
    expect(container.querySelector('.bar-chart').getAttribute('data-first')).toBe('Madeira em tora');
    expect(container.querySelector('.line-chart').getAttribute('data-points')).toBe('2');
  });

  it('says share and rank are the UF\'s, so a município never borrows them silently', () => {
    stubGlobals(BASE, { mesh: MESH });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    fireEvent.click([...container.querySelectorAll('.seg-opt')]
      .find((b) => b.textContent === 'Município'));
    expect(container.textContent).toContain('o denominador');
    expect(container.textContent).toContain('não por município');
  });

  it('surfaces a breakdown load failure instead of an empty-looking place', () => {
    stubGlobals(BASE, {
      mesh: MESH,
      productsByUf: () => ({ products: [], loadError: new Error('500') }),
    });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(container.querySelector('.load-err')).toBeTruthy();
  });
});

describe('ViewTerritoryProfile — empty state', () => {
  it('asks for a different filter when no território has data', () => {
    stubGlobals({ yearStart: 2019, yearEnd: 2021, ufDataFull: [], ufYearlySeries: [] });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(container.querySelector('.empty-card').textContent).toContain('Nenhum território');
  });
});

// ── A composição só diz "sem produtos" quando MEDIU ─────────────────────────────────
// Até a v1.107.0 o card de composição dizia "Sem produtos registrados para este território
// na seleção atual." em três situações em que nada tinha sido medido: com o pedido ainda a
// caminho, com o pedido falhado e — no PAM e no PPM por UF — sem leitor nenhum no servidor.
describe('ViewTerritoryProfile — a composição só afirma o que mediu', () => {
  const SEM_PRODUTOS = 'Sem produtos registrados';
  const composicao = (c) => [...c.querySelectorAll('.sh')]
    .find((h) => h.textContent.includes('Composição')).parentElement;
  const naoMedido = (c) => {
    expect(composicao(c).textContent).not.toContain(SEM_PRODUTOS);
    expect(composicao(c).querySelector('.bar-chart')).toBeNull();
  };

  it('com o pedido a caminho, diz que está carregando', () => {
    stubGlobals(BASE, {
      productsByUf: () => ({ products: [], loading: true, unavailable: false, loadError: null }),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pam" conventions={CONV} />,
    );
    expect(composicao(container).textContent).toContain('Carregando a composição');
    naoMedido(container);
  });

  it('no nível município, com a malha do IBGE a caminho, também está carregando', () => {
    // Sem a malha não há lista de cidades a perguntar; o produtor nem é chamado. Antes,
    // esse "não perguntei" caía no mesmo "Sem produtos registrados".
    const productsByMunicipio = vi.fn(() => MEDIDO([]));
    stubGlobals(BASE, { mesh: null, productsByMunicipio });
    const { container } = render(<View summary={{}} database="ibge_ppm" conventions={CONV} />);
    fireEvent.click([...container.querySelectorAll('.seg-opt')]
      .find((b) => b.textContent === 'Município'));
    expect(productsByMunicipio).not.toHaveBeenCalled();
    expect(composicao(container).textContent).toContain('Carregando a composição');
    naoMedido(container);
  });

  it('com o pedido falhado, mostra a falha dentro do card', () => {
    stubGlobals(BASE, {
      productsByUf: () => ({ products: [], loading: false, unavailable: false, loadError: 'HTTP 500' }),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_ppm" conventions={CONV} />,
    );
    expect(composicao(container).querySelector('.load-err')).toBeTruthy();
    naoMedido(container);
  });

  it('sem leitor para o banco nesse nível, diz que ainda não está disponível', () => {
    stubGlobals(BASE, {
      productsByUf: () => ({ products: [], loading: false, unavailable: true, loadError: null }),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pam" conventions={CONV} />,
    );
    expect(composicao(container).querySelector('.na-note').textContent)
      .toContain('ainda não está disponível para este banco no nível UF');
    naoMedido(container);
  });

  it('só com a resposta medida e vazia diz "sem produtos"', () => {
    stubGlobals(BASE, { productsByUf: () => MEDIDO([]) });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pam" conventions={CONV} />,
    );
    expect(composicao(container).textContent).toContain(SEM_PRODUTOS);
  });

  it('o rebanho do PPM fica fora das barras, nomeado e com o motivo', () => {
    // measure_kind = 'stock': cabeças, sem valor de produção por construção. Uma barra de
    // tamanho zero afirmaria uma medição que nunca houve; sumir com ele seria filtrar em
    // silêncio. Nomear é o que resta.
    stubGlobals(BASE, {
      productsByUf: () => MEDIDO([
        { code: '2670', name: 'Bovino', tabela: '3939', measure_kind: 'stock', value: null, q_count: 21 },
        { code: '2682', name: 'Leite', tabela: '74', measure_kind: 'flow', value: 9 },
        { code: '2685', name: 'Ovos de galinha', tabela: '74', measure_kind: 'flow', value: 4 },
      ]),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_ppm" conventions={CONV} />,
    );
    const card = composicao(container);
    expect(card.querySelector('.bar-chart').getAttribute('data-cats')).toBe('Leite|Ovos de galinha');
    expect(card.textContent).toContain('Efetivo dos rebanhos: Bovino.');
    expect(card.textContent).toContain('perspectiva Rebanho');
    expect(card.textContent).not.toContain(SEM_PRODUTOS);
  });

  it('um produto sem valor nesta convenção é nomeado, não vira barra de zero', () => {
    // PAM em IPCA antes de 1980: a soma da janela é NULL — ausência, não zero.
    stubGlobals(BASE, {
      productsByUf: () => MEDIDO([
        { code: '40124', name: 'Soja (em grão)', tabela: '5457', value: null },
        { code: '40122', name: 'Milho (em grão)', tabela: '5457', value: 7 },
      ]),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pam" conventions={CONV} />,
    );
    const card = composicao(container);
    expect(card.querySelector('.bar-chart').getAttribute('data-cats')).toBe('Milho (em grão)');
    expect(card.textContent).toContain('Sem valor nesta convenção: Soja (em grão).');
  });

  it('com só o rebanho na seleção, não desenha gráfico vazio nem diz "sem produtos"', () => {
    // Fora de ordem de propósito: o servidor ordena por valor, e o rebanho não tem valor —
    // a lista chega em ordem arbitrária e a tela a põe em ordem alfabética.
    stubGlobals(BASE, {
      productsByUf: () => MEDIDO([
        { code: '2675', name: 'Suíno', tabela: '3939', measure_kind: 'stock', value: null },
        { code: '2670', name: 'Bovino', tabela: '3939', measure_kind: 'stock', value: null },
      ]),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_ppm" conventions={CONV} />,
    );
    const card = composicao(container);
    expect(card.querySelector('.bar-chart')).toBeNull();
    expect(card.textContent).toContain('Nenhum produto deste território tem valor a mostrar');
    expect(card.textContent).toContain('Efetivo dos rebanhos: Bovino, Suíno.');
    expect(card.textContent).not.toContain(SEM_PRODUTOS);
  });
});

// ── The filter is the UNIVERSE; the picker is the FOCUS inside it ────────────
//
// Shipped the other way round in v1.29.0: the picker listed all 27 UFs regardless of
// the geography filter, so a session filtered to AM+SP cheerfully profiled Pará —
// a displayed value computed over a set the researcher had explicitly excluded.

describe('ViewTerritoryProfile — the picker never leaves the filter', () => {
  it('offers only the UFs the state filter admits', () => {
    stubGlobals(BASE);
    const { container } = render(
      <View summary={{ states: ['SP'] }} database="ibge_pevs" conventions={CONV} />,
    );
    const opts = [...container.querySelector('select[aria-label="UF do território"]').options]
      .map((o) => o.value);
    expect(opts).toEqual(['SP']);          // PA is filtered out and must not be offered
    expect(container.textContent).toContain('São Paulo');
    expect(container.textContent).not.toContain('Pará');
  });

  it('offers the UFs a sub-UF narrowing resolves to, not every UF', () => {
    // A mesorregião/município facet resolves to a city set; the UFs those cities live
    // in are the admitted ones. Without this the picker would jump outside the facet.
    stubGlobals(
      { ...BASE, scopedCityCodes: ['3550308'], subUfActive: true },
      { mesh: [
        { cityCode: '1500107', cityName: 'Abaetetuba', uf: 'PA' },
        { cityCode: '3550308', cityName: 'São Paulo', uf: 'SP' },
      ] },
    );
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    const opts = [...container.querySelector('select[aria-label="UF do território"]').options]
      .map((o) => o.value);
    expect(opts).toEqual(['SP']);
  });

  it('refuses to invent a share when a sub-UF narrowing removes the denominator', () => {
    // ufYearlySeries is a ROLLUP OF THE SELECTED CITIES under a sub-UF facet, so summing
    // it yields the selection's own total. Dividing by that prints ~100% and calls it
    // "participação no país" — a confident wrong number, worse than an honest dash.
    stubGlobals(
      { ...BASE, scopedCityCodes: ['3550308'], subUfActive: true },
      { mesh: [{ cityCode: '3550308', cityName: 'São Paulo', uf: 'SP' }] },
    );
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(kpi(container, 'Participação').querySelector('.kpi-value').textContent).toBe('—');
    expect(kpi(container, 'Participação').querySelector('.kpi-sub').textContent)
      .toContain('indisponível');
    expect(kpi(container, 'Posição').querySelector('.kpi-value').textContent).toBe('—');
  });

  it('ranks within the COUNTRY, not within the filtered subset', () => {
    // "1º de 1 UF na seleção" is honest and useless. The state filter does not narrow
    // ufYearlySeries, so the country-wide ordering stays computable — use it.
    stubGlobals(BASE);
    const { container } = render(
      <View summary={{ states: ['SP'] }} database="ibge_pevs" conventions={CONV} />,
    );
    expect(kpi(container, 'Posição').querySelector('.kpi-value').textContent).toBe('2º');
    expect(kpi(container, 'Posição').querySelector('.kpi-sub').textContent).toContain('de 2 UFs');
  });
});

describe('ViewTerritoryProfile — combining territories', () => {
  it('offers the filter selection as one profileable território, and defaults to it', () => {
    // The researcher asked for that SET, so the set is the honest first answer;
    // drilling into one member is one click away.
    stubGlobals(BASE);
    const { container } = render(
      <View summary={{ states: ['PA', 'SP'] }} database="ibge_pevs" conventions={CONV} />,
    );
    const sel = container.querySelector('select[aria-label="UF do território"]');
    expect([...sel.options].map((o) => o.textContent)).toContain('Seleção atual (2 UFs somadas)');
    expect(sel.value).toBe('__combinado__');
    // The trajectory is the SUM: 200 (2019) + 300 (2020) + 500 (2021) = 3 points.
    expect(container.querySelector('.line-chart').getAttribute('data-points')).toBe('3');
    // A sum of territories has no position in a ranking, and says so.
    expect(kpi(container, 'Posição').querySelector('.kpi-value').textContent).toBe('—');
    expect(kpi(container, 'Posição').querySelector('.kpi-sub').textContent).toContain('não tem posição');
  });

  it('asks the breakdown reader for every UF in the combination at once', () => {
    const productsByUf = vi.fn(() => ({ products: [], loadError: null }));
    stubGlobals(BASE, { productsByUf });
    render(<View summary={{ states: ['PA', 'SP'] }} database="ibge_pevs" conventions={CONV} />);
    // One query over the set — the reader takes an array, so a combination needs no
    // special case and cannot drift from the single-território path.
    expect(productsByUf.mock.calls.at(-1)[1].states).toEqual(['PA', 'SP']);
  });

  it('as duas metades do PEVS viram barras SEPARADAS, não uma barra borrada', () => {
    // O defeito: madeira, lenha e carvão existem nas duas metades com o MESMO nome, o
    // BarChart usa o nome como categoria e o Plotly funde homônimas numa posição só —
    // uma barra (a maior) com os dois rótulos impressos por cima um do outro.
    //
    // A asserção é sobre as CATEGORIAS que chegam ao gráfico, não sobre o texto do sufixo:
    // é a unicidade que o Plotly exige, e é ela que estava quebrada.
    stubGlobals(BASE, {
      productsByUf: () => ({
        loadError: null,
        products: [
          { code: '3455', name: 'Carvão vegetal', tabela: '291', value: 114564 },
          { code: '3433', name: 'Carvão vegetal', tabela: '289', value: 13745 },
          { code: '3403', name: 'Açaí (fruto)', tabela: '289', value: 1 },
        ],
      }),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pevs" conventions={CONV} />,
    );
    const cats = container.querySelector('.bar-chart').getAttribute('data-cats').split('|');
    expect(new Set(cats).size, `categorias homônimas fundem no gráfico: ${cats}`).toBe(cats.length);
    expect(cats).toEqual([
      'Carvão vegetal · silvicultura',
      'Carvão vegetal · extração',
      'Açaí (fruto)',   // nome único → sem sufixo
    ]);
  });

  it('does NOT offer a combination when nothing narrows — that would just be Brasil', () => {
    // "Seleção atual (27 UFs)" is the country, which is Visão geral's job. A território
    // profile of the whole country profiles nothing.
    stubGlobals(BASE);
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    const sel = container.querySelector('select[aria-label="UF do território"]');
    expect([...sel.options].map((o) => o.value)).toEqual(['PA', 'SP']);
    expect(sel.value).toBe('PA'); // the value-ranked default, not a combination
  });
});

// ── A trajetória não desce a zero onde a correção não alcança ───────────────────────
// `(r.value || 0)` somava um ano sem NENHUM valor como zero, e a linha do lugar descia a
// zero nos anos que a correção escolhida não cobre. E a variação do último ano, com ele
// ausente, saía (null − prev) / prev = −100%.
describe('ViewTerritoryProfile — ausência na trajetória e na variação', () => {
  const GAP = {
    ...BASE,
    ufYearlySeries: [
      { year: 2019, uf: 'PA', value: 100 },
      { year: 2020, uf: 'PA', value: 200 },
      { year: 2021, uf: 'PA', value: null },   // a correção não alcança 2021
      { year: 2019, uf: 'SP', value: 100 },
      { year: 2020, uf: 'SP', value: 100 },
      { year: 2021, uf: 'SP', value: null },
    ],
  };

  it('um ano sem valor vira lacuna na linha, não zero', () => {
    stubGlobals(GAP);
    let linha;
    window.LineChart = (props) => { linha = props.data; return <div className="line-chart" />; };
    render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(linha.map((d) => [d.y, d.v])).toEqual([[2019, 100e6], [2020, 200e6], [2021, null]]);
  });

  it('o último ano ausente não vira −100%: a variação não tem resposta', () => {
    stubGlobals(GAP);
    window.fmtSigned = (x) => (x == null ? '—' : `${Math.round(x)}%`);
    window.KpiCardSpark = ({ label, value, delta, sub }) => (
      <div className="kpi"><span className="kpi-label">{label}</span>
        <span className="kpi-value">{value}</span><span className="kpi-delta">{delta}</span>
        <span className="kpi-sub">{sub}</span></div>
    );
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    const valor = kpi(container, 'Valor');
    // 2020 tem valor e 2021 não: a versão anterior publicava −100% aqui.
    expect(valor.querySelector('.kpi-delta').textContent).toBe('');   // sem variação a mostrar
  });
});

// ── Os anos de cada soma e o mês de cada leitura (v1.105.0) ─────────────────────────────────
// Participação, posição e composição são somas de vários anos, e a tela não dizia de quais. O
// período sai das linhas somadas — os anos da janela COM valor na convenção: um ano que a
// correção não alcança fica fora da soma, e um rótulo que o incluísse diria que ela o cobre.
describe('ViewTerritoryProfile — os anos de cada soma e o mês de cada leitura (v1.105.0)', () => {
  const MESH = [
    { cityCode: '1500107', cityName: 'Abaetetuba', uf: 'PA' },
    { cityCode: '3550308', cityName: 'São Paulo', uf: 'SP' },
  ];
  // 2018 está na janela, mas a correção não o alcança: nenhuma UF tem valor ali.
  const COM_LACUNA = {
    ...BASE,
    yearStart: 2018,
    ufYearlySeries: [
      { year: 2018, uf: 'PA', value: null },
      { year: 2018, uf: 'SP', value: null },
      ...BASE.ufYearlySeries,
    ],
  };
  const OUTUBRO = { column: 'val_real_ipca_brl', month: '2026-10', fxDate: null };
  const sub = (c, label) => kpi(c, label).querySelector('.kpi-sub').textContent;
  const composicao = (c) => [...c.querySelectorAll('.sh-overline')]
    .map((o) => o.textContent).find((t) => t.startsWith('Composição'));
  const municipio = (c) => fireEvent.click([...c.querySelectorAll('.seg-opt')]
    .find((b) => b.textContent === 'Município'));
  const snapshotEm = (pb) => {
    window.dataStore = { get: () => ({ priceBase: pb }), conv: () => CONV };
  };

  it('participação e posição dizem os anos com valor, não a janela pedida', () => {
    stubGlobals(COM_LACUNA);
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(sub(container, 'Participação')).toBe('Pará sobre o total das UFs · soma de 2019 a 2021');
    expect(sub(container, 'Posição')).toBe('de 2 UFs no banco · por valor · soma de 2019 a 2021');
  });

  it('a composição diz os anos da trajetória do lugar, não os do país', () => {
    // A grade nacional tem valor desde 2019 (SP); o Pará, só desde 2020.
    stubGlobals({
      ...BASE,
      ufYearlySeries: BASE.ufYearlySeries.filter((r) => !(r.uf === 'PA' && r.year === 2019)),
    });
    const { container } = render(
      <View summary={{ states: ['PA'] }} database="ibge_pevs" conventions={CONV} />,
    );
    expect(sub(container, 'Posição')).toContain('soma de 2019 a 2021');
    expect(composicao(container)).toBe('Composição · soma de 2020 a 2021');
  });

  it('no nível UF sob recorte sub-UF, a composição (a UF inteira) diz a janela pedida', () => {
    // A trajetória é a soma dos municípios recortados; a composição, a UF inteira. Os anos
    // com valor de uma não são os da outra, então vale só o que foi pedido.
    stubGlobals({ ...COM_LACUNA, subUfActive: true });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    expect(composicao(container)).toBe('Composição · soma de 2018 a 2021');
  });

  it('no nível município, a composição diz os anos do cubo do lugar', () => {
    stubGlobals(BASE, {
      mesh: MESH,
      municipioYearly: () => [
        { year: 2020, cityCode: '1500107', uf: 'PA', value: 7 },
        { year: 2021, cityCode: '1500107', uf: 'PA', value: 9 },
      ],
    });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    municipio(container);
    expect(composicao(container)).toBe('Composição · soma de 2020 a 2021');
  });

  it('sem nenhum ano com valor, não afirma período', () => {
    stubGlobals(BASE, { mesh: MESH, municipioYearly: () => [] });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    municipio(container);
    expect(composicao(container)).toBe('Composição');
  });

  it('avisa quando as leituras desta perspectiva chegam a meses diferentes', () => {
    snapshotEm(OUTUBRO);
    stubGlobals(BASE, {
      mesh: MESH,
      muniBase: () => ({ column: null, month: '2026-11', fxDate: null }),
      productsByMunicipio: () => ({
        products: [{ code: '4403', name: 'Madeira em tora', value: 6 }],
        loadError: null,
        priceBase: { column: null, month: '2026-10', fxDate: null },
      }),
    });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    municipio(container);
    expect(container.querySelector('.price-base-skew-note').textContent)
      .toContain('a preços de meses diferentes: outubro de 2026 e novembro de 2026.');
  });

  it('com tudo no mesmo mês, nenhum aviso', () => {
    snapshotEm(OUTUBRO);
    stubGlobals(BASE, {
      mesh: MESH,
      muniBase: () => ({ column: null, month: '2026-10', fxDate: null }),
    });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    municipio(container);
    expect(container.querySelector('.price-base-skew-note')).toBeNull();
  });

  it('não repete o aviso que a tela principal já mostra', () => {
    // O cubo do recorte (applyFilters) já diverge do snapshot: a MainScreen avisa. Esta
    // perspectiva, com uma leitura própria num terceiro mês, não avisa de novo.
    snapshotEm(OUTUBRO);
    stubGlobals({ ...BASE, muniPriceBase: { column: null, month: '2026-09', fxDate: null } }, {
      mesh: MESH,
      muniBase: () => ({ column: null, month: '2026-11', fxDate: null }),
    });
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    municipio(container);
    expect(container.querySelector('.price-base-skew-note')).toBeNull();
  });
});

// ── Carregando, falhou ou vazio: três respostas diferentes (v1.107.3) ────────────────────
// Until v1.107.3 the município cube and the IBGE mesh came back null both in flight and
// after a failure: the trajectory said "Sem série" and the indicators "sem dados" for the
// 1–3 s the cube takes on every change of município, and for good when it failed.
describe('ViewTerritoryProfile — the município read loading, failed or empty', () => {
  const MESH = [
    { cityCode: '1500107', cityName: 'Abaetetuba', uf: 'PA' },
    { cityCode: '1500206', cityName: 'Acará', uf: 'PA' },
  ];
  const open = (opts) => {
    stubGlobals(BASE, opts);
    const { container } = render(<View summary={{}} database="ibge_pevs" conventions={CONV} />);
    fireEvent.click([...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Município'));
    return container;
  };
  const val = (c, label) => kpi(c, label).querySelector('.kpi-value').textContent;
  const sub = (c, label) => kpi(c, label).querySelector('.kpi-sub').textContent;
  const picker = (c) => c.querySelector('select[aria-label="Município do território"]');

  it('while the cube is on its way, the trajectory and its two indicators say "carregando"', () => {
    const c = open({ mesh: MESH, municipioYearly: () => null });
    expect(c.textContent).toContain('Carregando a série…');
    expect(val(c, 'Valor')).toBe('…');
    expect(sub(c, 'Valor')).toBe('carregando a série…');
    expect(sub(c, 'Pico')).toBe('carregando a série…');
    expect(c.textContent).not.toMatch(/Sem série|sem dados/);
    expect(c.querySelector('.load-err')).toBeNull();
  });

  it('a failed cube is named as failed — never "Sem série", never "carregando" for good', () => {
    const c = open({ mesh: MESH, muniError: 'HTTP 503' });
    expect(c.querySelector('.load-err')).not.toBeNull();
    expect(c.querySelector('.line-chart')).toBeNull();
    expect(val(c, 'Valor')).toBe('—');
    expect(sub(c, 'Valor')).toBe('não foi possível carregar a série');
    expect(sub(c, 'Pico')).toBe('não foi possível carregar a série');
    expect(c.textContent).not.toMatch(/Sem série|sem dados|Carregando a série/);
  });

  it('only a cube that answered empty says there is no series', () => {
    const c = open({ mesh: MESH, municipioYearly: () => [] });
    expect(c.textContent).toContain('Sem série para este território na janela selecionada.');
    expect(sub(c, 'Pico')).toBe('sem dados na janela');
    expect(c.textContent).not.toMatch(/Carregando a série|não foi possível/);
  });

  it('a failed IBGE mesh: the picker and the trajectory say it failed', () => {
    const c = open({ meshError: 'HTTP 503' });
    expect(picker(c).textContent).toContain('não foi possível carregar os municípios');
    expect(c.querySelector('.load-err')).not.toBeNull();
    expect(sub(c, 'Valor')).toBe('não foi possível carregar a série');
    expect(c.textContent).not.toMatch(/carregando municípios|Carregando a série/);
    // No município resolved: the place is "—", not "— ·" dangling from a name that never came.
    expect(c.textContent).toContain('Evolução de —');
    expect(c.textContent).not.toContain('— ·');
  });

  it('a mesh on its way: the picker and the trajectory say "carregando"', () => {
    const c = open({ mesh: null });
    expect(picker(c).textContent).toContain('carregando municípios…');
    expect(c.textContent).toContain('Carregando a série…');
    expect(c.querySelector('.load-err')).toBeNull();
    expect(c.textContent).not.toContain('— ·');
  });

  it('counter-proof: a resolved município keeps its "nome · UF" label', () => {
    const c = open({ mesh: MESH, municipioYearly: () => [] });
    expect(c.textContent).toContain('Evolução de Abaetetuba · PA');
  });

  it('a measured empty selection: the picker says there is none', () => {
    const c = open({ mesh: [] });
    expect(picker(c).textContent).toContain('nenhum município na seleção');
    expect(c.textContent).not.toMatch(/carregando municípios|não foi possível carregar os municípios/);
  });
});

describe('ViewTerritoryProfile — at UF level under a sub-UF narrowing', () => {
  const val = (c, label) => kpi(c, label).querySelector('.kpi-value').textContent;
  const sub = (c, label) => kpi(c, label).querySelector('.kpi-sub').textContent;
  const open = (filtered) => {
    stubGlobals(filtered);
    return render(<View summary={{}} database="ibge_pevs" conventions={CONV} />).container;
  };

  it('a narrowing on its way holds every indicator as loading', () => {
    const c = open({ ...BASE, subUfLoading: true, subUfLoadError: null });
    expect(val(c, 'Participação')).toBe('…');
    expect(sub(c, 'Participação')).toBe('carregando o recorte sub-UF…');
    expect(sub(c, 'Posição')).toBe('carregando o recorte sub-UF…');
    expect(sub(c, 'Valor')).toBe('carregando a série…');
    expect(c.textContent).toContain('Carregando a série…');
  });

  it('a failed narrowing says so in every indicator and in the trajectory', () => {
    const c = open({ ...BASE, subUfLoading: false, subUfLoadError: 'HTTP 503' });
    expect(val(c, 'Participação')).toBe('—');
    expect(sub(c, 'Participação')).toBe('indisponível: o recorte sub-UF não carregou');
    expect(sub(c, 'Posição')).toBe('indisponível: o recorte sub-UF não carregou');
    expect(sub(c, 'Valor')).toBe('não foi possível carregar a série');
    expect(c.querySelector('.load-err')).not.toBeNull();
    expect(c.textContent).not.toMatch(/[Cc]arregando/);
  });
});
