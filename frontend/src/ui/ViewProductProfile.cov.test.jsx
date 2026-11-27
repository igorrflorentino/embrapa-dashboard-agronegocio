// ViewProductProfile.cov.test.jsx — coverage smoke + branch tests for the
// single-commodity deep dive (ViewProductProfile.jsx). The component reads its
// data off window.applyFilters and a swarm of window.* formatting/widget helpers,
// so we stub every global it touches (no dependency on data.js) and drive the
// main branches:
//   - the no-product empty state (EmptyCard),
//   - a FLOW product (value/qty/price/share KPIs + the value/quantity/price/share
//     charts + the UF ranking card + ficha técnica),
//   - a value-less STOCK / herd (Efetivo + Pico KPIs, efetivo+participação charts,
//     headcount-based UF ranking, "estoque" caption),
//   - the no-geo banco (UF ranking card gated off),
//   - the UF-rank loading vs empty-rows states.
// /api/product-uf is fetched in an effect — we stub global.fetch so the effect
// resolves deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

// Stub the entire window.* surface ViewProductProfile consumes. Widgets render
// their distinctive props into readable DOM so KPI labels/values are assertable.
function stubGlobals(filtered) {
  window.applyFilters = () => filtered;
  window.DEFAULT_CONVENTIONS = { currency: 'BRL', correction: 'IPCA' };
  window.CURRENCY_FX = { BRL: { symbol: 'R$' }, USD: { symbol: 'US$' } };
  window.conventionMonetaryLabel = () => 'R$';
  window.convFactor = () => 1;
  window.bancoDim = () => ({ codeLabel: 'Código IBGE' });
  window.massAxisLabel = () => 't';
  window.volumeAxisLabel = () => 'm³';
  window.massQtyMul = () => 1;
  window.volumeQtyMul = () => 1;
  window.countQtyMul = () => 1;
  window.scaleSeries = (data, _max, _conv, _key, label) => ({ data, label });
  window.formatValue = (v) => `val:${v}`;
  window.formatCountQty = (v) => `count:${v}`;
  window.formatProductQty = (p, v) => `${p.family}:${v}`;
  window.fmtSigned = () => '+0%';
  window.fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
  window.UNIT_FAMILIES = {
    mass: { long: 'toneladas', label: 'Massa' },
    volume: { long: 'metros cúbicos', label: 'Volume' },
    count: { long: 'cabeças', label: 'Contagem' },
  };
  // Widgets → readable DOM.
  window.EmptyCard = ({ children }) => <div className="empty-card">{children}</div>;
  // NotApplicableNote with the real atom's rule (Atoms.jsx): one line per message, nothing
  // when every message is empty — a stub that renders an empty box hides a real "nothing".
  window.NotApplicableNote = ({ note }) => {
    const msgs = note ? Object.values(note).filter(Boolean) : [];
    return msgs.length ? <div className="na-note">{msgs.join(' ')}</div> : null;
  };
  window.KpiCardSpark = ({ label, value }) => (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
  window.SectionHeader = ({ title, overline }) => (
    <div className="sh">
      <span className="sh-overline">{overline}</span>
      <span className="sh-title">{title}</span>
    </div>
  );
  window.UnitFamilyTag = () => <span className="uf-tag" />;
  window.LineChart = (props) => <div className="line-chart" data-points={(props.data || []).length} />;
  window.BarChart = (props) => <div className="bar-chart" data-points={(props.data || []).length} />;
}

// Deterministic /api/product-uf stub: returns the given UF rows (or [] when none).
function stubFetch(ufRows) {
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ uf: ufRows }) })
  );
}

const CONV = { currency: 'BRL', correction: 'IPCA' };

let ViewProductProfile;

beforeEach(async () => {
  await import('./ViewProductProfile.jsx'); // registers window.ViewProductProfile
  ViewProductProfile = window.ViewProductProfile;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── a FLOW product (PEVS-style): value > 0, has geography ────────────────────
const FLOW_FIXTURE = {
  selectedProducts: ['P1', 'P2'],
  allProductTS: {
    P1: [
      { y: 2019, v: 5, q: 100 },
      { y: 2020, v: 8, q: 160 },
    ],
    P2: [
      { y: 2019, v: 2, q: 50 },
      { y: 2020, v: 3, q: 70 },
    ],
  },
  productTS: {
    P1: [
      { y: 2019, v: 5, q: 100 },
      { y: 2020, v: 8, q: 160 },
    ],
    P2: [
      { y: 2019, v: 2, q: 50 },
      { y: 2020, v: 3, q: 70 },
    ],
  },
  products: [
    { code: 'P1', name: 'Açaí', family: 'mass', unit: 't', unit_native: 'Toneladas' },
    { code: 'P2', name: 'Castanha', family: 'mass', unit: 't', unit_native: 'Toneladas' },
  ],
  ufDataFull: [{ uf: 'PA', value: 5, real: true }],
  qualityByProduct: [{ code: 'P1', OK: 0.97, MISSING_VALUE: 0.01 }],
  yearStart: 2019,
  yearEnd: 2020,
};

// ── a value-less STOCK (PPM herd): v = 0 always, measure_kind 'stock' ────────
const STOCK_FIXTURE = {
  selectedProducts: ['H1', 'H2'],
  allProductTS: {
    H1: [
      { y: 2019, v: 0, q: 1000 },
      { y: 2020, v: 0, q: 1200 },
    ],
    H2: [
      { y: 2019, v: 0, q: 400 },
      { y: 2020, v: 0, q: 500 },
    ],
  },
  productTS: {
    H1: [
      { y: 2019, v: 0, q: 1000 },
      { y: 2020, v: 0, q: 1200 },
    ],
    H2: [
      { y: 2019, v: 0, q: 400 },
      { y: 2020, v: 0, q: 500 },
    ],
  },
  products: [
    { code: 'H1', name: 'Bovino', family: 'count', unit: 'cabeças', measure_kind: 'stock' },
    { code: 'H2', name: 'Suíno', family: 'count', unit: 'cabeças', measure_kind: 'stock' },
  ],
  ufDataFull: [{ uf: 'MT', value: 0, q_count_stock: 75, real: true }],
  qualityByProduct: [{ code: 'H1', OK: 0.95, MISSING_QUANTITY: 0.02 }],
  yearStart: 2019,
  yearEnd: 2020,
};

describe('ViewProductProfile — empty state', () => {
  it('renders the EmptyCard when no product is available in the basket', () => {
    stubGlobals({
      selectedProducts: [],
      allProductTS: {},
      productTS: {},
      products: [],
      ufDataFull: [],
      qualityByProduct: [],
      yearStart: 2019,
      yearEnd: 2020,
    });
    stubFetch([]);
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="ibge_pevs" conventions={CONV} />
    );
    expect(container.querySelector('.empty-card')).toBeTruthy();
    expect(container.textContent).toContain('Nenhum produto disponível');
  });

  it('also renders the EmptyCard when selectedProducts have no resolved series', () => {
    // selectedProducts present but none has a matching allProductTS entry →
    // `available` is empty → no default code → empty state.
    stubGlobals({
      selectedProducts: ['P1'],
      allProductTS: {},
      productTS: {},
      products: [{ code: 'P1', name: 'Açaí', family: 'mass', unit: 't' }],
      ufDataFull: [],
      qualityByProduct: [],
      yearStart: 2019,
      yearEnd: 2020,
    });
    stubFetch([]);
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="ibge_pevs" conventions={CONV} />
    );
    expect(container.querySelector('.empty-card')).toBeTruthy();
  });
});

describe('ViewProductProfile — flow product render', () => {
  it('renders the selector, value/qty/price/share KPIs, the four charts and the ficha técnica', async () => {
    stubGlobals(FLOW_FIXTURE);
    stubFetch([{ uf: 'PA', value: 8, q_count: 0 }]);
    const { container } = render(
      <ViewProductProfile
        families={['mass']}
        summary={{ startDate: '2019-01-01', endDate: '2020-12-31' }}
        database="ibge_pevs"
        conventions={{ currency: 'BRL', correction: 'IPCA' }}
      />
    );

    // Default code = largest by latest value (P1, v=8). Selector renders both chips.
    expect(container.textContent).toContain('Produto em análise');
    const chips = [...container.querySelectorAll('.pp-chip')].map((e) => e.textContent.trim());
    expect(chips.some((t) => t.includes('Açaí'))).toBe(true);
    expect(chips.some((t) => t.includes('Castanha'))).toBe(true);

    // Flow KPI strip: Valor + Quantidade + Preço médio implícito + Participação.
    const kpiLabels = [...container.querySelectorAll('.kpi-label')].map((e) => e.textContent);
    expect(kpiLabels.some((l) => l.includes('Valor'))).toBe(true);
    expect(kpiLabels.some((l) => l.includes('Preço médio implícito'))).toBe(true);
    expect(kpiLabels.some((l) => l.includes('Participação na cesta'))).toBe(true);

    // The ficha técnica uses the banco's code label, and names the unit as the source
    // publishes it (v1.108.12), not the family's base "t (toneladas)".
    expect(container.textContent).toContain('Código IBGE');
    const nativa = [...container.querySelectorAll('.pp-spec dt')]
      .find((d) => d.textContent === 'Unidade nativa');
    expect(nativa.nextElementSibling.textContent).toBe('Toneladas');
    // qaRow present → the quality pair is rendered. NOT "Linhas íntegras": since
    // v1.49.0 'OK' means EXAMINED by the implied-price detector and cleared, and on a
    // PEVS produto that share is ~18% — the old label read as "82% of this produto is
    // broken". The share the card omits is named on the line below it, never left blank.
    expect(container.textContent).toContain('Linhas examinadas sem ressalva');
    expect(container.textContent).toContain('Sem base para avaliar');
    expect(container.textContent).not.toContain('Linhas íntegras');

    // Charts render (value/quantity/price/share line charts present).
    expect(container.querySelectorAll('.line-chart').length).toBeGreaterThanOrEqual(4);

    // The UF-ranking effect resolves to a bar chart (hasGeo + rows).
    await waitFor(() => {
      expect(container.querySelector('.bar-chart')).toBeTruthy();
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  it('quantidade AUSENTE não vira "0" na tela', () => {
    // `_product_ts` no serializer devolve `q: None` para as famílias energia/area/
    // desconhecida ("no display scale") — e o ramo de FLUXO só exige valor positivo,
    // então um produto assim chega aqui com valor e sem quantidade. O card fazia
    // `(last.q * qtyMul).toLocaleString(...)`, e `null * fator === 0` em JS: a tela
    // afirmaria "0" para uma quantidade que ninguém sabe exprimir.
    //
    // Measured on prod 2026-09-08, none of the 142 products of the four bancos then fell in
    // those families. On 2026-11-27 one did: UN Comtrade serves 440335 as 'desconhecida' (its
    // rows publish no unit), and the profile threw on the family before reaching this card.
    // ViewProductProfile.test.jsx draws that product with the real registry; this test keeps
    // the card's own guard.
    stubGlobals({
      ...FLOW_FIXTURE,
      allProductTS: { P1: [{ y: 2019, v: 5, q: null }, { y: 2020, v: 8, q: null }] },
      productTS: { P1: [{ y: 2019, v: 5, q: null }, { y: 2020, v: 8, q: null }] },
      selectedProducts: ['P1'],
    });
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="ibge_pevs" conventions={CONV} />
    );
    const card = [...container.querySelectorAll('.kpi')]
      .find((e) => /Quantidade/.test(e.querySelector('.kpi-label')?.textContent || ''));
    expect(card, 'card de quantidade não encontrado').toBeTruthy();
    const valor = card.querySelector('.kpi-value').textContent;
    expect(valor).toContain('—');
    expect(valor, `afirmou zero: ${valor}`).not.toMatch(/^0\b/);
  });

  it('shows the "sem dados por UF" empty-rows state when the per-UF fetch returns []', async () => {
    stubGlobals(FLOW_FIXTURE);
    stubFetch([]); // no UF rows
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="ibge_pevs" conventions={CONV} />
    );
    await waitFor(() => {
      expect(container.textContent).toContain('Sem dados por UF para este produto.');
    });
  });
});

describe('ViewProductProfile — value-less stock (herd) render', () => {
  it('replaces value/price with Efetivo + Pico, shows the estoque caption and headcount ranking', async () => {
    stubGlobals(STOCK_FIXTURE);
    stubFetch([{ uf: 'MT', value: 0, q_count: 1200 }]);
    const { container } = render(
      <ViewProductProfile families={['count']} summary={{}} database="ibge_ppm" conventions={CONV} />
    );

    const kpiLabels = [...container.querySelectorAll('.kpi-label')].map((e) => e.textContent);
    // Stock branch: "Efetivo", "Pico histórico", "Participação no efetivo" — NOT "Preço".
    expect(container.textContent).toContain('Efetivo');
    expect(kpiLabels.some((l) => l.includes('Pico histórico'))).toBe(true);
    expect(container.textContent).toContain('Participação no efetivo');
    expect(kpiLabels.some((l) => (typeof l === 'string') && l.includes('Preço'))).toBe(false);

    // The stock-only caption explaining a headcount has no money.
    expect(container.textContent).toContain('estoque');
    expect(container.textContent).toContain('não deve ser somado entre espécies');

    // Ficha técnica gains the "Tipo de medida" / Estoque row.
    expect(container.textContent).toContain('Estoque (efetivo)');

    // Headcount-based UF ranking resolves to a bar chart.
    await waitFor(() => {
      expect(container.querySelector('.bar-chart')).toBeTruthy();
    });
  });
});

describe('ViewProductProfile — no-geo banco', () => {
  it('gates off the UF ranking card and never fetches /api/product-uf', () => {
    // ufDataFull empty → hasGeo false → no UF card, the effect early-returns.
    stubGlobals({ ...FLOW_FIXTURE, ufDataFull: [] });
    stubFetch([]);
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="comtrade" conventions={CONV} />
    );
    // Ficha técnica still renders (it is not geo-gated).
    expect(container.textContent).toContain('Código IBGE');
    // No UF ranking overline.
    expect(container.textContent).not.toContain('Ranking de UFs');
    // The geo-gated effect short-circuits → no fetch.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── A variação anual do valor não atravessa uma reforma monetária ─────────────────────
// Com a janela terminando no ano da reforma, o último par compara duas moedas. A mesma
// recusa do Visão geral (deltaPctIn), com o MOTIVO no subtítulo: um traço sozinho não
// diria se falta dado ou se a moeda mudou.
describe('ViewProductProfile — variação anual e a era da moeda', () => {
  afterEach(() => { delete window.dataStore; });

  const renderWithBreaks = (anos) => {
    stubGlobals(FLOW_FIXTURE);
    stubFetch([{ uf: 'PA', value: 8, q_count: 0 }]);
    window.fmtSigned = (x) => (x == null ? '—' : `${Math.round(x)}%`);
    window.KpiCardSpark = ({ label, delta, sub }) => (
      <div className="kpi">
        <span className="kpi-label">{label}</span>
        <span className="kpi-delta">{delta}</span>
        <span className="kpi-sub">{sub}</span>
      </div>
    );
    window.dataStore = { get: () => ({ valueEraBreaks: anos }) };
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{ startDate: '2019-01-01', endDate: '2020-12-31' }}
                          database="ibge_pevs" conventions={{ currency: 'BRL', correction: 'Nominal' }} />);
    return [...container.querySelectorAll('.kpi')]
      .find((k) => k.querySelector('.kpi-label').textContent.startsWith('Valor'));
  };

  it('recusa quando o par atravessa a reforma, e diz por quê', () => {
    const kpi = renderWithBreaks([2020]);
    expect(kpi.querySelector('.kpi-delta').textContent).toBe('—');
    expect(kpi.querySelector('.kpi-sub').textContent)
      .toBe('2020 vs. 2019 · moeda mudou em 2020 — valores nominais não são comparáveis');
  });

  it('dentro da mesma moeda a variação sai normalmente', () => {
    const kpi = renderWithBreaks([2019]);    // 2019 já é a moeda nova: o par não atravessa
    expect(kpi.querySelector('.kpi-delta').textContent).toBe('60%');   // 5 → 8
    expect(kpi.querySelector('.kpi-sub').textContent).toBe('2020 vs. 2019');
  });
});

// ── Um recorte sub-UF não se aplica aqui — e a tela diz, em todo estado (v1.108.2) ──────
// This perspective's series exist only for the whole country (or whole UFs): it can apply a
// sub-UF recorte in no state of it. Until v1.108.2 it showed those numbers under the
// recorte's chip without a word — while the recorte loaded, after it failed, and once it had
// loaded alike.
describe('ViewProductProfile — a sub-UF recorte does not apply, and the screen says so', () => {
  const ESTADOS = [
    ['on its way', { subUfLoading: true }],
    ['failed', { subUfLoadError: 'HTTP 503' }],
    ['resolved', { subUfLoaded: true }],
  ];
  it.each(ESTADOS)('recorte %s → the note', (_estado, extra) => {
    stubGlobals({ ...FLOW_FIXTURE, subUfRequested: true, ...extra });
    stubFetch([{ uf: 'PA', value: 8, q_count: 0 }]);
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="ibge_pevs" conventions={CONV} />,
    );
    const nota = container.querySelector('.na-note').textContent;
    expect(nota).toContain('O recorte territorial abaixo da UF não se aplica a esta perspectiva: a série de cada produto e a sua distribuição existem por UF inteira, não por município.');
    expect(nota).toContain('Os números abaixo não se limitam aos municípios escolhidos.');
  });

  it('no recorte → no note', () => {
    stubGlobals(FLOW_FIXTURE);
    stubFetch([{ uf: 'PA', value: 8, q_count: 0 }]);
    const { container } = render(
      <ViewProductProfile families={['mass']} summary={{}} database="ibge_pevs" conventions={CONV} />,
    );
    expect(container.querySelector('.na-note')).toBeNull();
  });
});

// ── Sob um subconjunto de UFs, o perfil é o das UFs (v1.108.3) ────────────────────────────
// applyFilters hands the UFs' own series under a UF subset. While they are on its way, or after
// the read failed, it hands none: the profile is withheld and the screen says which — never
// "Nenhum produto disponível", which would blame the filters for a read that has not arrived.
describe('ViewProductProfile — under a UF subset the series are the UFs’ own', () => {
  const UF = { productUfRequested: true, productUfLoading: false, productUfLoadError: null, productUfUnavailable: false };
  const renderWith = (extra) => {
    stubGlobals({ ...FLOW_FIXTURE, ...UF, ...extra });
    stubFetch([{ uf: 'PA', value: 8, q_count: 0 }]);
    window.Icon = () => null;
    return render(
      <ViewProductProfile families={['mass']} summary={{ states: ['PA'] }} database="ibge_pevs" conventions={CONV} />,
    ).container;
  };
  afterEach(() => { delete window.Icon; });

  it('resolved: the profile is drawn, with no note', () => {
    const c = renderWith({});
    expect(c.querySelector('.kpi')).not.toBeNull();
    expect(c.querySelector('.na-note')).toBeNull();
  });

  it.each([
    ['on its way', { productUfLoading: true }, 'Carregando as séries por produto das UFs escolhidas…'],
    ['failed', { productUfLoadError: 'HTTP 503' }, 'Não foi possível carregar as séries por produto das UFs escolhidas'],
  ])('%s: no profile at all — the note, never "nenhum produto disponível"', (_estado, extra, texto) => {
    const c = renderWith({ ...extra, allProductTS: {}, productTS: {} });
    expect(c.querySelector('.kpi')).toBeNull();
    expect(c.querySelector('.line-chart')).toBeNull();
    expect(c.querySelector('.empty-card')).toBeNull();
    expect(c.querySelector('.na-note').textContent).toContain(texto);
    expect(global.fetch).not.toHaveBeenCalled(); // no product, so no UF ranking asked for
  });

  it('a banco without series by UF: the national profile, and a note saying so', () => {
    const c = renderWith({ productUfUnavailable: true });
    expect(c.querySelector('.kpi')).not.toBeNull();
    expect(c.querySelector('.na-note').textContent)
      .toContain('As séries por produto deste banco existem só para o Brasil inteiro');
  });

  it('a sub-UF recorte beside a held read: both say what they are', () => {
    const c = renderWith({ subUfRequested: true, subUfLoading: true, productUfLoading: true, allProductTS: {}, productTS: {} });
    const notas = [...c.querySelectorAll('.na-note')].map((n) => n.textContent).join(' ');
    expect(notas).toContain('O recorte territorial abaixo da UF não se aplica a esta perspectiva');
    expect(notas).toContain('Carregando as séries por produto das UFs escolhidas…');
  });
});
