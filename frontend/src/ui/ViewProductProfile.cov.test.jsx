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
  window.countAxisLabel = () => 'cabeças';
  window.massQtyMul = () => 1;
  window.volumeQtyMul = () => 1;
  window.countQtyMul = () => 1;
  window.scaleSeries = (data, _max, _conv, _key, label) => ({ data, label });
  window.formatValue = (v) => `val:${v}`;
  window.formatCountQty = (v) => `count:${v}`;
  window.fmtSigned = () => '+0%';
  window.fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
  window.UNIT_FAMILIES = {
    mass: { long: 'toneladas', label: 'Massa' },
    volume: { long: 'metros cúbicos', label: 'Volume' },
    count: { long: 'cabeças', label: 'Contagem' },
  };
  // Widgets → readable DOM.
  window.EmptyCard = ({ children }) => <div className="empty-card">{children}</div>;
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
    { code: 'P1', name: 'Açaí', family: 'mass', unit: 't' },
    { code: 'P2', name: 'Castanha', family: 'mass', unit: 't' },
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
  ufDataFull: [{ uf: 'MT', value: 0, q_count: 75, real: true }],
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

    // The ficha técnica uses the banco's code label.
    expect(container.textContent).toContain('Código IBGE');
    expect(container.textContent).toContain('toneladas');
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
    // LATENTE, não vivo: medido em produção 2026-09-08, os 142 produtos dos quatro
    // bancos são todos massa/volume/contagem, e nenhum cai nessas famílias. O
    // serializer as antecipa explicitamente, então a guarda vale — mas não há defeito
    // na tela hoje, e este teste é o que impede que passe a haver.
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
