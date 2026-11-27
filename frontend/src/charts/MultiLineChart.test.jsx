// MultiLineChart.test.jsx — one line per series on a shared axis (comparison
// views). Locks the per-series mapping (data → x/y), the configurable valueKey, and
// the palette colour fallback that keeps colour-less series visually distinct. We
// capture the traces the chart hands Plotly; plotlyBundle is mocked.

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

import MultiLineChart from './MultiLineChart.jsx';
import { baseLayout, yearAxis } from './_base';

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => {
  cleanup();
  reactState.traces = null;
  reactState.layout = null;
  delete window.linearFit;
});

describe('MultiLineChart', () => {
  it('renders no traces for empty series', () => {
    render(<MultiLineChart series={[]} />);
    expect(reactState.traces).toEqual([]);
  });

  it('emits one line trace per series, mapping data to x=year / y=value', () => {
    const series = [
      { name: 'PEVS', data: [{ y: 2020, v: 3 }, { y: 2021, v: 4 }] },
      { name: 'COMEX', data: [{ y: 2020, v: 9 }, { y: 2021, v: 8 }] },
    ];
    render(<MultiLineChart series={series} />);
    const t = reactState.traces;
    expect(t).toHaveLength(2);
    expect(t.map((tr) => tr.name)).toEqual(['PEVS', 'COMEX']);
    expect(t[0].x).toEqual([2020, 2021]);
    expect(t[1].y).toEqual([9, 8]);
    expect(t.every((tr) => tr.mode === 'lines')).toBe(true);
  });

  it('honours a custom valueKey', () => {
    const series = [{ name: 'Preço', data: [{ y: 2020, price: 1.5 }, { y: 2021, price: 2.0 }] }];
    render(<MultiLineChart series={series} valueKey="price" />);
    expect(reactState.traces[0].y).toEqual([1.5, 2.0]);
  });

  it('respects an explicit series colour and falls back to the palette otherwise', () => {
    // jsdom has no stylesheet, so CSS-var colours all resolve to the same fallback;
    // a LITERAL colour passes through resolveColor untouched. This pins the branch:
    // an explicit colour is used as-is, a colour-less series gets the (resolved)
    // palette default — so a series that sets its colour is never overridden.
    const series = [
      { name: 'A', color: '#aa0000', data: [{ y: 2020, v: 1 }] },
      { name: 'B', data: [{ y: 2020, v: 2 }] }, // no colour → palette fallback
    ];
    render(<MultiLineChart series={series} />);
    const [a, b] = reactState.traces;
    expect(a.line.color).toBe('#aa0000'); // explicit colour respected
    expect(b.line.color).toBeTruthy(); // fallback colour applied
    expect(b.line.color).not.toBe('#aa0000');
  });

  it('shows the Plotly legend by default and hides it when showLegend=false', () => {
    // Default keeps the native legend (e.g. ViewRebanho / the ratio card rely on it).
    render(<MultiLineChart series={[{ name: 'A', data: [{ y: 2020, v: 1 }] }]} />);
    expect(reactState.layout.showlegend).toBe(true);
    cleanup();
    // Comparison views with their own pc-legend/xs-legend opt out to avoid a duplicate.
    render(<MultiLineChart series={[{ name: 'A', data: [{ y: 2020, v: 1 }] }]} showLegend={false} />);
    expect(reactState.layout.showlegend).toBe(false);
  });
});

// A present value with no present neighbour is a one-point run of its line, which Plotly
// draws as nothing; the chart adds a marker for it (isolatedPoints.js) and for nothing else.
describe('MultiLineChart — the isolated point', () => {
  const SERIES = [
    { name: 'A', color: '#aa0000', data: [{ y: 2000, v: null }, { y: 2001, v: 5 }] }, // 2001 alone
    { name: 'B', color: '#00aa00', data: [{ y: 2000, v: 1 }, { y: 2001, v: 2 }] }, // a drawn segment
    { name: 'C', color: '#0000aa', data: [{ y: 2000, v: 3 }, { y: 2001, v: null }, { y: 2002, v: 4 }] }, // both alone
  ];
  const markersOf = (traces) => traces.filter((t) => t.mode === 'markers');

  it('gives each lone point a marker in its series’ colour, after the lines, without hover', () => {
    render(<MultiLineChart series={SERIES} showLegend={false} />);
    const t = reactState.traces;
    expect(t.slice(0, 3).map((tr) => [tr.name, tr.mode])).toEqual([['A', 'lines'], ['B', 'lines'], ['C', 'lines']]);
    // The lines keep their gaps.
    expect(t[0].y).toEqual([null, 5]);
    expect(t[2].y).toEqual([3, null, 4]);
    const markers = markersOf(t);
    expect(t.slice(3)).toEqual(markers);
    expect(markers.map((m) => [m.name, m.marker.color, m.x, m.y])).toEqual([
      ['A', '#aa0000', [2001], [5]],
      ['C', '#0000aa', [2000, 2002], [3, 4]],
    ]);
    expect(markers.every((m) => m.hoverinfo === 'skip' && m.showlegend === false)).toBe(true);
    // Drawn whole at the edge, on a year axis clipped back to the lines' span, 2000–2002.
    expect(markers.every((m) => m.cliponaxis === false)).toBe(true);
    expect(reactState.layout.xaxis.autorangeoptions).toEqual({ clipmin: 2000, clipmax: 2002 });
  });

  it('with the Plotly legend shown, a series and its markers hide together, and the legend order stays normal', () => {
    render(<MultiLineChart series={SERIES} />);
    const [a, b, c, ...markers] = reactState.traces;
    expect(a.legendgroup).toBeTruthy();
    expect(markers[0].legendgroup).toBe(a.legendgroup);
    expect(c.legendgroup).toBeTruthy();
    expect(markers[1].legendgroup).toBe(c.legendgroup);
    expect(a.legendgroup).not.toBe(c.legendgroup);
    expect(b.legendgroup).toBeUndefined(); // nothing to link
    // A legendgroup would turn Plotly's default order to 'grouped', spacing the legend and
    // the unified hover box group by group; 'normal' keeps both as they were.
    expect(reactState.layout.legend).toEqual({ orientation: 'h', y: 1.12, x: 0, font: { size: 11 }, traceorder: 'normal' });
  });

  it('without the Plotly legend, groups nothing (the hover box would copy a grouped order)', () => {
    render(<MultiLineChart series={SERIES} showLegend={false} />);
    expect(reactState.traces.every((tr) => tr.legendgroup === undefined)).toBe(true);
    expect(reactState.layout.legend.traceorder).toBeUndefined();
  });

  it('adds nothing, to the traces, the legend or the year axis, when every point has a neighbour', () => {
    render(<MultiLineChart series={[SERIES[1]]} />);
    expect(reactState.traces).toHaveLength(1);
    expect(reactState.traces[0].legendgroup).toBeUndefined();
    expect(reactState.layout.legend).toEqual({ orientation: 'h', y: 1.12, x: 0, font: { size: 11 } });
    expect(reactState.layout.xaxis).toEqual(baseLayout({ xaxis: yearAxis() }).xaxis);
  });

  it('keeps the trend lines in their place and draws the markers last', () => {
    window.linearFit = () => ({ line: [{ y: 2000, v: 1 }, { y: 2002, v: 3 }] });
    render(<MultiLineChart series={SERIES} trend showLegend={false} />);
    const t = reactState.traces;
    expect(t.map((tr) => (tr.mode === 'markers' ? 'marker' : tr.line.dash ? 'trend' : 'line'))).toEqual([
      'line', 'line', 'line', 'trend', 'trend', 'trend', 'marker', 'marker',
    ]);
  });
});
