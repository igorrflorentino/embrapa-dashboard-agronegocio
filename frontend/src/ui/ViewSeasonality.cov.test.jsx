// ViewSeasonality.cov.test.jsx — render coverage for the month × year seasonality
// perspective (COMEX monthly granularity). ViewSeasonality reads the monthlyData
// contract and branches on: the honest empty state (no monthly series), the
// weight-aware dual-axis profile (volume + capital), and the value-only bar
// profile. Following the ViewFlows/ViewGeography pattern, we stub every window.*
// dependency so each branch is exercised deterministically, then assert the view
// renders and the relevant content surfaces.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// The ui-side shared magnitude helper the migrated views use.
function autoScaleNum(v) {
  const a = Math.abs(v || 0);
  if (a >= 1e9) return { factor: 1e9, suffix: 'bi' };
  if (a >= 1e6) return { factor: 1e6, suffix: 'mi' };
  if (a >= 1e3) return { factor: 1e3, suffix: 'mil' };
  return { factor: 1, suffix: '' };
}

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

// Captured props from the stubbed chart widgets so we can assert what each branch fed.
let heatmapProps, dualAxisProps, barChartProps;

function stubGlobals(data) {
  window.monthlyData = () => data;
  window.autoScaleNum = autoScaleNum;
  window.MONTH_LABELS = MONTH_LABELS;
  window.NotApplicableNote = ({ note }) => (note ? <div className="na">{note}</div> : null);
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{error}</div> : null);
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh">
      <span className="sh-ov">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.MonthYearHeatmap = (props) => { heatmapProps = props; return <div className="heatmap" />; };
  window.DualAxisLineChart = (props) => { dualAxisProps = props; return <div className="dual" />; };
  window.BarChart = (props) => { barChartProps = props; return <div className="barchart" />; };
}

let ViewSeasonality;

beforeEach(async () => {
  heatmapProps = dualAxisProps = barChartProps = undefined;
  await import('./ViewSeasonality.jsx'); // registers window.ViewSeasonality
  ViewSeasonality = window.ViewSeasonality;
});

afterEach(() => cleanup());

// A representative seasonal frame: 12 months of average capital, a March peak and a
// September trough, with the volume (weight) profile present → the dual-axis branch.
const FULL_FIXTURE = {
  unit: 'US$',
  weightUnit: 'mil t',
  monthlyAvg:       [10, 12, 30, 18, 14, 11, 5, 8, 4, 9, 13, 16],
  weightMonthlyAvg: [1, 1.2, 3, 1.8, 1.4, 1.1, 0.5, 0.8, 0.4, 0.9, 1.3, 1.6],
  years: [2018, 2019, 2020],
  matrix: [[10, 12, 30, 18, 14, 11, 5, 8, 4, 9, 13, 16]],
  notApplicable: 'A sazonalidade colapsa a UF de origem.',
};

describe('ViewSeasonality — smoke + main branches', () => {
  it('renders the dual-axis profile + KPIs when the weight profile is present', () => {
    stubGlobals(FULL_FIXTURE);
    const { container } = render(
      <ViewSeasonality summary={{}} conventions={{}} database="mdic_comex" />
    );
    // Heatmap fed the real month × year matrix.
    expect(heatmapProps).toBeTruthy();
    expect(heatmapProps.years).toEqual([2018, 2019, 2020]);
    // hasWeight → dual-axis (Volume + Capital), not the single bar chart.
    expect(dualAxisProps).toBeTruthy();
    expect(barChartProps).toBeUndefined();
    expect(dualAxisProps.series.map((s) => s.label)).toEqual(['Volume', 'Capital']);
    // Peak month = March (index 2, value 30), trough = September (index 8, value 4).
    const peak = container.querySelector('.kpi[data-label="Mês de pico"] .kpi-value');
    const low = container.querySelector('.kpi[data-label="Mês de vale"] .kpi-value');
    expect(peak.textContent).toBe('Mar');
    expect(low.textContent).toBe('Set');
    // Amplitude = peak ÷ trough = 30 / 4 = 7,50 (pt-BR comma).
    const amp = container.querySelector('.kpi[data-label="Amplitude sazonal"] .kpi-value');
    expect(amp.textContent).toBe('×7,50');
    // Coverage = 3 years, span 2018–2020.
    const cov = container.querySelector('.kpi[data-label="Cobertura"] .kpi-value');
    expect(cov.textContent).toBe('3 anos');
    // The honest collapse-UF note surfaces.
    expect(container.textContent).toContain('colapsa a UF de origem');
  });

  it('renders the single bar-chart profile when no weight profile is present', () => {
    stubGlobals({ ...FULL_FIXTURE, weightMonthlyAvg: Array(12).fill(0), notApplicable: null });
    render(<ViewSeasonality summary={{}} conventions={{}} database="mdic_comex" />);
    // hasWeight false → BarChart, no dual-axis.
    expect(barChartProps).toBeTruthy();
    expect(dualAxisProps).toBeUndefined();
    expect(barChartProps.data).toHaveLength(12);
    // O contrato manda milhões (30 = 30 mi); o gráfico recebe o valor cru, que é o que a
    // régua de magnitude dele sabe ler.
    expect(barChartProps.data[2]).toEqual({ name: 'Mar', value: 30e6 });
  });

  it('renders the honest empty state when the monthly series is all-zero', () => {
    stubGlobals({
      unit: 'US$',
      monthlyAvg: Array(12).fill(0),
      weightMonthlyAvg: Array(12).fill(0),
      years: [],
      matrix: [],
      notApplicable: null,
    });
    const { container } = render(
      <ViewSeasonality summary={{}} conventions={{}} database="ibge_pevs" />
    );
    expect(container.textContent).toContain('Sem dados sazonais para esta seleção');
    expect(container.textContent).toContain('Não há série mensal disponível');
    // No charts rendered in the empty branch.
    expect(heatmapProps).toBeUndefined();
    expect(dualAxisProps).toBeUndefined();
    expect(barChartProps).toBeUndefined();
  });

  it('pads a ragged monthlyAvg (fewer than 12 entries) to 12 without crashing', () => {
    // A real empty/partial /api/monthly frame can ship fewer than 12 values; the
    // defensive guard pads to 12 zeros and clamps the indices.
    stubGlobals({
      unit: 'US$',
      monthlyAvg: [0, 0, 5], // ragged (3 of 12) — only March nonzero
      weightMonthlyAvg: [],
      years: [2021],
      matrix: [[0, 0, 5]],
      notApplicable: null,
    });
    const { container } = render(
      <ViewSeasonality summary={{}} conventions={{}} database="ibge_ppm" />
    );
    // hasData true (a nonzero exists) → the profile renders, padded to 12 bars.
    expect(barChartProps).toBeTruthy();
    expect(barChartProps.data).toHaveLength(12);
    // Single-year coverage span renders the year alone (no en-dash range collapse).
    const cov = container.querySelector('.kpi[data-label="Cobertura"] .kpi-value');
    expect(cov.textContent).toBe('1 anos');
  });
});

describe('ViewSeasonality — escala e convenção', () => {
  it('lê o contrato em milhões: o cartão diz "mi", não um número solto', () => {
    // O contrato manda 3,09 para US$ 3,09 mi. Até a v1.77.0 a tela mostrava "US$ 3,09".
    stubGlobals({
      ...FULL_FIXTURE,
      monthlyAvg: [3.09, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      notApplicable: null,
    });
    const { container } = render(
      <ViewSeasonality summary={{}} conventions={{}} database="mdic_comex" />
    );
    const pico = container.querySelector('.kpi[data-label="Mês de pico"] .kpi-sub');
    expect(pico.textContent).toBe('US$ 3,09 mi (média)');
    // O eixo de Capital recebe o valor cru, e a régua pt-BR dele escreve "mi".
    expect(dualAxisProps.series[1].data[0].v).toBeCloseTo(3.09e6);
  });

  it('mostra a convenção que o número carrega, na moeda do servidor', () => {
    stubGlobals({ ...FULL_FIXTURE, unit: 'R$', valueLabel: 'Valor real (IPCA) — R$ · FOB' });
    const { container } = render(
      <ViewSeasonality summary={{}} conventions={{}} database="mdic_comex" />
    );
    expect(container.querySelector('.season-valuation').textContent)
      .toBe('Valor real (IPCA) — R$ · FOB');
    const pico = container.querySelector('.kpi[data-label="Mês de pico"] .kpi-sub');
    expect(pico.textContent).toBe('R$ 30 mi (média)');
  });
});
