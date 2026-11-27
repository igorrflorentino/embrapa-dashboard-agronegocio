// DualAxisLineChart.test.jsx — up to two Y axes, one per distinct `unit` (first
// unit → left/y, second → right/y2). Locks the axis-assignment rule and the
// opt-out Plotly legend (`showLegend`) so ViewCrossSource / ViewSeasonality —
// which draw their own xs-legend / pc-legend — don't render two legends. We
// capture the traces + layout handed to Plotly; plotlyBundle is mocked.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { reactState } = vi.hoisted(() => ({ reactState: { traces: null, layout: null } }));

vi.mock('./plotlyBundle', () => ({
  default: {
    react: (_el, traces, layout) => { reactState.traces = traces; reactState.layout = layout; },
    purge: () => {},
    Plots: { resize: () => {} },
  },
}));

import DualAxisLineChart from './DualAxisLineChart.jsx';
import { baseLayout, yearAxis } from './_base';

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => { cleanup(); reactState.traces = null; reactState.layout = null; });

const SERIES = [
  { label: 'Volume', unit: 'mil t', data: [{ y: 2020, v: 3 }, { y: 2021, v: 4 }] },
  { label: 'Capital', unit: 'US$', data: [{ y: 2020, v: 30 }, { y: 2021, v: 40 }] },
];

describe('DualAxisLineChart', () => {
  it('renders no traces for empty series', () => {
    render(<DualAxisLineChart series={[]} />);
    expect(reactState.traces).toEqual([]);
  });

  it('puts the first unit on the left axis (y) and the second on the right (y2)', () => {
    render(<DualAxisLineChart series={SERIES} />);
    const t = reactState.traces;
    expect(t).toHaveLength(2);
    expect(t[0].yaxis).toBe('y');   // first distinct unit → left
    expect(t[1].yaxis).toBe('y2');  // second distinct unit → right
    expect(reactState.layout.yaxis2).toBeTruthy();
    expect(reactState.layout.yaxis2.side).toBe('right');
  });

  it('appends bancoShort to the trace name when present', () => {
    render(<DualAxisLineChart series={[{ label: 'Preço', unit: 'US$', bancoShort: 'COMEX', data: [{ y: 2020, v: 1 }] }]} />);
    expect(reactState.traces[0].name).toBe('Preço (COMEX)');
  });

  it('shows the Plotly legend by default and hides it when showLegend=false', () => {
    render(<DualAxisLineChart series={SERIES} />);
    expect(reactState.layout.showlegend).toBe(true);
    cleanup();
    // ViewCrossSource (xs-legend) / ViewSeasonality (pc-legend) opt out.
    render(<DualAxisLineChart series={SERIES} showLegend={false} />);
    expect(reactState.layout.showlegend).toBe(false);
  });
});

// A present value with no present neighbour is a one-point run of its line, which Plotly
// draws as nothing; the chart adds a marker for it (isolatedPoints.js), on its series' axis.
describe('DualAxisLineChart — the isolated point', () => {
  const LONE = [
    { label: 'Volume', unit: 'mil t', color: '#aa0000', data: [{ y: 2020, v: 3 }, { y: 2021, v: 4 }] },
    { label: 'Preço', unit: 'US$/t', color: '#0000aa', data: [{ y: 2020, v: null }, { y: 2021, v: 40 }] },
  ];

  it('draws the lone point of the right-axis series on the right axis, after the lines', () => {
    render(<DualAxisLineChart series={LONE} showLegend={false} />);
    const t = reactState.traces;
    expect(t).toHaveLength(3);
    expect(t[1].y).toEqual([null, 40]); // the line keeps its gap
    expect(t[2]).toEqual({
      x: [2021],
      y: [40],
      type: 'scatter',
      mode: 'markers',
      marker: { color: '#0000aa', size: 6 },
      cliponaxis: false,
      yaxis: 'y2',
      name: 'Preço',
      showlegend: false,
      hoverinfo: 'skip',
    });
    // The year axis is clipped back to the lines' span, 2020–2021.
    expect(reactState.layout.xaxis.autorangeoptions).toEqual({ clipmin: 2020, clipmax: 2021 });
  });

  it('with the Plotly legend shown, links the series to its marker and keeps the legend order normal', () => {
    render(<DualAxisLineChart series={LONE} />);
    const [volume, preco, marker] = reactState.traces;
    expect(volume.legendgroup).toBeUndefined();
    expect(preco.legendgroup).toBeTruthy();
    expect(marker.legendgroup).toBe(preco.legendgroup);
    expect(reactState.layout.legend.traceorder).toBe('normal');
  });

  it('adds nothing, to the traces, the legend or the year axis, when every point has a neighbour', () => {
    render(<DualAxisLineChart series={SERIES} />);
    expect(reactState.traces).toHaveLength(2);
    expect(reactState.layout.legend).toEqual({ orientation: 'h', x: 0, y: 1.08, font: { size: 11 } });
    expect(reactState.layout.xaxis).toEqual(baseLayout({ xaxis: yearAxis() }).xaxis);
  });
});
