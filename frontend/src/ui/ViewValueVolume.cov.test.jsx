// ViewValueVolume.cov.test.jsx — render coverage for the value-vs-quantity dual-axis
// view (historic value series, per-family quantity series, YoY bars, per-product
// stacked composition). The view composes a wide set of window.* metric/series helpers
// + chart widgets and branches on: the present families (mass / volume / count), a
// value-bearing vs value-less (herd stock) basket, the basket×UF combo-pending hold,
// and the count-family Rebanho redirect. Following the ViewGeography .cov pattern we
// stub every window.* dependency so each branch is exercised deterministically, then
// assert the view renders and the relevant content surfaces.
//
// ViewValueVolume is a plain function component (no React hooks), but it reads window.*
// at render time; we set globalThis.React / window.React before importing for parity
// with the other view tests and the app's prototype convention.

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let lineChartCalls, yoyProps, stackedCalls;

function stubGlobals(filtered, opts = {}) {
  const { autoScale = false, currency = 'BRL' } = opts;
  window.applyFilters = () => filtered;
  window.DEFAULT_CONVENTIONS = { currency, correction: 'IPCA', autoScale };
  window.CURRENCY_FX = {
    BRL: { symbol: 'R$' },
    USD: { symbol: 'US$' },
    EUR: { symbol: '€' },
  };
  window.VIZ_SCALE = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)'];

  // Metric-convention helpers — identity-ish so the math stays predictable.
  window.conventionMonetaryLabel = () => 'R$ correntes';
  window.massQtyMul = () => 1;
  window.volumeQtyMul = () => 1;
  window.massAxisLabel = () => 't';
  window.volumeAxisLabel = () => 'm³';
  window.convFactor = () => 1;
  window.convertSeries = (s) => s;
  window.scaleSeries = (data, _max, _conv, _key, label) => ({ data: data || [], label });
  window.stackYearMax = (layers, key) =>
    Math.max(0, ...layers.flatMap((l) => l.data.map((d) => d[key] || 0)));
  window.autoScaleNum = (v) => {
    const a = Math.abs(v || 0);
    if (a >= 1e9) return { factor: 1e9, suffix: 'bi' };
    if (a >= 1e6) return { factor: 1e6, suffix: 'mi' };
    return { factor: 1, suffix: '' };
  };
  window.scaleLabel = (unit, suffix) => (suffix ? `${unit} (${suffix})` : unit);
  window.fmtSigned = (x, d) => (x >= 0 ? '+' : '') + (x || 0).toFixed(d ?? 0) + '%';

  // Composed widgets — capture props / render markers.
  window.UnitFamilyBanner = () => <div className="ufb" />;
  window.UnitFamilyTag = ({ family }) => <span className="uft">{family}</span>;
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh">
      <span className="sh-ov">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.LineChart = (props) => {
    lineChartCalls.push(props);
    return <div className="lc" />;
  };
  window.YoYBars = (props) => {
    yoyProps = props;
    return <div className="yoy" />;
  };
  window.StackedArea = (props) => {
    stackedCalls.push(props);
    return <div className="stacked" />;
  };
}

let ViewValueVolume;

beforeEach(async () => {
  lineChartCalls = [];
  yoyProps = undefined;
  stackedCalls = [];
  globalThis.React = React;
  window.React = React;
  await import('./ViewValueVolume.jsx'); // registers window.ViewValueVolume
  ViewValueVolume = window.ViewValueVolume;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// A value-bearing basket: a global ts series (value + mass + volume) plus two products
// in productTS (one mass, one volume) so the composition stacks render for both families.
function valueFixture(overrides = {}) {
  return {
    ts: [
      { y: 2018, v: 1, q_mass: 100, q_vol: 10 },
      { y: 2019, v: 2, q_mass: 150, q_vol: 15 },
      { y: 2020, v: 3, q_mass: 200, q_vol: 20 },
    ],
    products: [
      { code: 'P1', name: 'Açaí' },
      { code: 'P2', name: 'Madeira' },
    ],
    productTS: {
      P1: [
        { y: 2018, v: 0.6, q: 60, family: 'mass' },
        { y: 2020, v: 1.8, q: 120, family: 'mass' },
      ],
      P2: [
        { y: 2018, v: 0.4, q: 4, family: 'volume' },
        { y: 2020, v: 1.2, q: 8, family: 'volume' },
      ],
    },
    yearStart: 2018,
    yearEnd: 2020,
    geoComboPending: false,
    ...overrides,
  };
}

describe('ViewValueVolume — value-bearing basket (mass + volume)', () => {
  it('renders the value series, both quantity series, YoY bars and the stacked compositions', () => {
    stubGlobals(valueFixture());
    const { container } = render(
      <ViewValueVolume
        families={['mass', 'volume']}
        summary={{}}
        database="ibge_pevs"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: false }}
      />
    );
    // hasValue → the value LineChart + mass + volume quantity LineCharts → ≥3 line charts.
    expect(lineChartCalls.length).toBeGreaterThanOrEqual(3);
    // YoY bars fed the value series.
    expect(yoyProps).toBeTruthy();
    expect(yoyProps.data.length).toBe(3);
    // Composition stacks: value + mass + volume → ≥3 StackedArea.
    expect(stackedCalls.length).toBeGreaterThanOrEqual(3);
    // Accumulated-variation caption present (totalDelta).
    expect(container.textContent).toContain('Variação acumulada');
    expect(container.textContent).toContain('Valor total');
  });

  it('omits the volume series + stack when only the mass family is present', () => {
    stubGlobals(valueFixture());
    const { container } = render(
      <ViewValueVolume
        families={['mass']}
        summary={{}}
        database="ibge_pevs"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: false }}
      />
    );
    // Only the mass quantity title surfaces; the volume "Produtos em volume" stack is gone.
    expect(container.textContent).toContain('Produtos em massa');
    expect(container.textContent).not.toContain('Produtos em volume');
  });

  it('o empilhado NÃO recria o zero ao reescalar um valor ausente', () => {
    // A camada passa por scalePresent (preserva null) e depois pelo _scaleStack, que
    // dividia direto: `null / factor === 0` em JS. O ano que a moeda não alcança
    // voltava como uma faixa colada no zero, dentro da área empilhada — desfazendo o
    // que o serializer e o scalePresent tinham acabado de preservar.
    // Só o ponto muda: o resto é o fixture que o teste vizinho já usa com autoScale.
    const base = valueFixture();
    base.productTS.P1 = [
      { y: 2018, v: null, q: 60, family: 'mass' },   // a moeda não alcança este ano
      { y: 2020, v: 3.0, q: 120, family: 'mass' },
    ];
    stubGlobals(base, { autoScale: true });
    render(
      <ViewValueVolume
        families={['mass']}
        summary={{}}
        database="ibge_pevs"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: true }}
      />
    );
    const pilha = stackedCalls.find((p) => /\(mi\)|\(bi\)/.test(p.label));
    expect(pilha, 'a pilha de valor não foi reescalada').toBeTruthy();
    const camada = pilha.series.find((l) => l.code === 'P1');
    expect(camada, 'a camada do produto não chegou ao gráfico').toBeTruthy();
    const ponto = camada.data.find((d) => d.y === 2018);
    expect(ponto.v, 'o ausente virou zero ao reescalar').toBeNull();
    // E o ano presente segue reescalado de verdade.
    expect(camada.data.find((d) => d.y === 2020).v).toBeGreaterThan(0);
  });

  it('applies autoScale to the stacked composition labels (bi suffix)', () => {
    // value layer totals ~3e6 absolute → autoScaleNum returns mi; assert a scaled label.
    stubGlobals(valueFixture(), { autoScale: true });
    render(
      <ViewValueVolume
        families={['mass']}
        summary={{}}
        database="ibge_pevs"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: true }}
      />
    );
    // The value stack ran through _scaleStack with autoScale on → some label carries a suffix.
    const valueStack = stackedCalls.find((p) => /\(mi\)|\(bi\)/.test(p.label));
    expect(valueStack).toBeTruthy();
  });
});

describe('ViewValueVolume — value-less herd + combo-pending branches', () => {
  it('shows the value-less herd note (no value series) and the cabeças quantity', () => {
    const fx = valueFixture({
      ts: [
        { y: 2018, v: 0, q_mass: 0, q_vol: 0 },
        { y: 2020, v: 0, q_mass: 0, q_vol: 0 },
      ],
      // O rebanho tem measure_kind 'stock', e é ELE que autoriza a nota do rebanho —
      // não a mera ausência de valor, que uma lacuna de moeda também produz.
      products: [{ code: 'B1', name: 'Bovino', measure_kind: 'stock' }],
      selectedProducts: ['B1'],
      productTS: {},
    });
    stubGlobals(fx);
    const { container } = render(
      <ViewValueVolume
        families={['count']}
        summary={{}}
        database="ibge_ppm"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: false }}
      />
    );
    // valueMax 0 → hasValue false → the estoque-sem-valor note, no YoY bars.
    expect(container.textContent).toContain('estoque sem valor monetário');
    expect(yoyProps).toBeUndefined();
  });

  it('sem valor por LACUNA DE MOEDA não é "estoque sem valor monetário"', () => {
    // Medido na tela em 2026-09-08: PEVS (madeira, carvão, lenha) em euro pré-1999
    // recebia a nota do REBANHO — mandando o pesquisador ver "cabeças" e a perspectiva
    // Rebanho, para produtos florestais. Toda cláusula era falsa. `valueMax > 0` é
    // falso nos DOIS casos, e só `measure_kind` distingue.
    stubGlobals(valueFixture({
      ts: [
        { y: 1990, v: null, q_mass: 100, q_vol: 10 },
        { y: 1995, v: null, q_mass: 150, q_vol: 15 },
      ],
      products: [{ code: 'P2', name: 'Madeira' }],  // sem measure_kind: NÃO é estoque
      selectedProducts: ['P2'],
      productTS: {},
    }));
    const { container } = render(
      <ViewValueVolume
        families={['mass', 'volume']}
        summary={{}}
        database="ibge_pevs"
        conventions={{ currency: 'EUR', correction: 'Nominal', autoScale: false }}
      />
    );
    expect(container.textContent).not.toContain('estoque sem valor monetário');
    expect(container.textContent).not.toContain('cabeças');
    // E diz o motivo verdadeiro, sem afirmar produção zero.
    expect(container.textContent).toContain('não alcançam esta janela');
    expect(container.textContent).toContain('quantidades abaixo');
  });

  it('redirects to Rebanho only when a herd STOCK is in a value-bearing count basket', () => {
    // A value-bearing basket whose count family includes a STOCK (herd head-count) → the
    // cross-species "veja Rebanho" note (heads are not summable across species).
    stubGlobals(
      valueFixture({
        products: [{ code: 'H1', name: 'Bovino', measure_kind: 'stock' }],
        selectedProducts: ['H1'],
      }),
    );
    const { container } = render(
      <ViewValueVolume
        families={['count']}
        summary={{}}
        database="ibge_ppm"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: false }}
      />
    );
    expect(container.textContent).toContain('efetivo dos rebanhos');
    expect(container.textContent).toContain('Rebanho');
  });

  it('does NOT show the herd note for a value-bearing count FLOW (ovos/mel, no stock)', () => {
    // Count family WITHOUT a stock (e.g. eggs/honey are flows that DO carry value and ARE
    // summable) → the misleading "efetivo dos rebanhos / veja Rebanho" note must not appear.
    stubGlobals(
      valueFixture({
        products: [{ code: 'E1', name: 'Ovos', measure_kind: 'flow' }],
        selectedProducts: ['E1'],
      }),
    );
    const { container } = render(
      <ViewValueVolume
        families={['count']}
        summary={{}}
        database="ibge_ppm"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: false }}
      />
    );
    expect(container.textContent).not.toContain('efetivo dos rebanhos');
  });

  it('holds the ts-derived series behind the basket×UF combo-pending note', () => {
    stubGlobals(valueFixture({ geoComboPending: true }));
    const { container } = render(
      <ViewValueVolume
        families={['mass', 'volume']}
        summary={{}}
        database="ibge_pevs"
        conventions={{ currency: 'BRL', correction: 'IPCA', autoScale: false }}
      />
    );
    // comboPending → the "Cruzando produto × UF" hold note, and the ts-derived value
    // LineChart + YoY bars are suppressed (held). The per-product stacks still render.
    expect(container.textContent).toContain('Cruzando');
    expect(yoyProps).toBeUndefined();
    // Per-product composition stacks (productTS-derived) stay → still rendered.
    expect(stackedCalls.length).toBeGreaterThanOrEqual(1);
  });
});
