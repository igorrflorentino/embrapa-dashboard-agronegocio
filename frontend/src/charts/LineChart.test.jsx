// LineChart.test.jsx — the single annual line (+ area) of Visão geral, Perfil do produto,
// Valor × Volume, Produtividade, Qualidade, Perfil do território and the multi-source views.
// Locks the isolated point: a present value with no present neighbour is a one-point run of
// the line, which Plotly draws as nothing (a bare "move to", a fill of zero area), so the
// chart adds a marker for it — and ONLY for it: the line, its fill, its hover and the trend
// are the traces they were, and a gap stays open. We capture the traces handed to Plotly;
// plotlyBundle is mocked (jsdom cannot draw it), and the browser measurement is in the
// v1.108.12 CHANGELOG entry.

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

import LineChart from './LineChart.jsx';
import { baseLayout, yearAxis } from './_base';

// The year axis the chart always had: what it gets whenever no point is isolated.
const plainYearAxis = () => baseLayout({ xaxis: yearAxis() }).xaxis;

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => {
  cleanup();
  reactState.traces = null;
  reactState.layout = null;
  delete window.linearFit;
});

const RED = '#aa0000';
const markersOf = (traces) => traces.filter((t) => t.mode === 'markers');

describe('LineChart — the isolated point', () => {
  it('draws a value with no present neighbour as a marker (440333, every reporter: price only in 2001)', () => {
    render(<LineChart data={[{ y: 2000, v: null }, { y: 2001, v: 177.4 }]} color={RED} label="R$/m³" />);
    const [line, ...rest] = reactState.traces;
    // The line keeps its gap: the absent 2000 stays null, never zero, never bridged.
    expect(line.mode).toBe('lines');
    expect(line.y).toEqual([null, 177.4]);
    expect(line.connectgaps).toBeUndefined();
    expect(rest).toEqual([
      {
        x: [2001],
        y: [177.4],
        type: 'scatter',
        mode: 'markers',
        marker: { color: RED, size: 6 },
        cliponaxis: false,
        name: 'R$/m³',
        showlegend: false,
        hoverinfo: 'skip',
      },
    ]);
    // The year axis stays where the line put it, 2000–2001: Plotly's padding around the
    // marker is clipped back, and the marker is drawn whole at the edge.
    expect(reactState.layout.xaxis).toEqual({
      ...plainYearAxis(),
      autorangeoptions: { clipmin: 2000, clipmax: 2001 },
    });
  });

  it('draws the only point of a one-point series', () => {
    render(<LineChart data={[{ y: 2001, v: 5 }]} color={RED} />);
    expect(markersOf(reactState.traces)).toHaveLength(1);
    expect(markersOf(reactState.traces)[0].x).toEqual([2001]);
    // A single year: Plotly centres the axis on it, as it always did.
    expect(reactState.layout.xaxis).toEqual(plainYearAxis());
  });

  it('marks only the points without a present neighbour, and leaves every gap open', () => {
    const data = [
      { y: 2000, v: 4 }, // alone at the start
      { y: 2001, v: null },
      { y: 2002, v: 3 }, // alone between two gaps
      { y: 2003, v: null },
      { y: 2004, v: 5 }, // 2004–2005 are a drawn segment
      { y: 2005, v: 6 },
      { y: 2006, v: null },
      { y: 2007, v: 8 }, // alone at the end
    ];
    render(<LineChart data={data} color={RED} />);
    const [line] = reactState.traces;
    expect(line.y).toEqual([4, null, 3, null, 5, 6, null, 8]);
    const [m] = markersOf(reactState.traces);
    expect(m.x).toEqual([2000, 2002, 2007]);
    expect(m.y).toEqual([4, 3, 8]);
  });

  it('reads zero as a value: a lone zero is drawn, and a zero joins its neighbour', () => {
    render(<LineChart data={[{ y: 2000, v: null }, { y: 2001, v: 0 }, { y: 2002, v: null }]} color={RED} />);
    expect(markersOf(reactState.traces)[0].y).toEqual([0]);
    cleanup();
    render(<LineChart data={[{ y: 2000, v: 0 }, { y: 2001, v: 5 }]} color={RED} />);
    expect(markersOf(reactState.traces)).toEqual([]);
  });

  it('honours valueKey', () => {
    render(<LineChart data={[{ y: 2000, q: null }, { y: 2001, q: 171 }]} valueKey="q" color={RED} />);
    expect(markersOf(reactState.traces)[0].y).toEqual([171]);
  });

  it('renders exactly the trace and the axis it always rendered when every point has a neighbour', () => {
    // A gap that isolates nothing: 2002 still has 2003 beside it.
    render(<LineChart data={[{ y: 2001, v: null }, { y: 2002, v: 2 }, { y: 2003, v: 3 }]} color={RED} label="t" />);
    expect(reactState.traces).toEqual([
      {
        x: [2001, 2002, 2003],
        y: [null, 2, 3],
        type: 'scatter',
        mode: 'lines',
        line: { color: RED, width: 2, shape: 'linear' },
        fill: 'tozeroy',
        fillcolor: 'rgba(170, 0, 0, 0.1)',
        hovertemplate: '<b>%{x}</b>  %{y:,.2f}<extra></extra>',
        name: 't',
      },
    ]);
    expect(reactState.layout.xaxis).toEqual(plainYearAxis());
  });

  it('leaves the fill, the hover and the trend as they were, and draws the marker last', () => {
    // A stand-in fit: the chart only reads `line` from it.
    window.linearFit = () => ({ line: [{ y: 2000, v: 1 }, { y: 2004, v: 5 }] });
    const data = [{ y: 2000, v: 1 }, { y: 2001, v: 2 }, { y: 2002, v: null }, { y: 2003, v: 4 }, { y: 2004, v: null }];
    render(<LineChart data={data} color={RED} label="t" trend />);
    const [line, trend, marker] = reactState.traces;
    expect(reactState.traces).toHaveLength(3);
    expect(line).toMatchObject({
      mode: 'lines',
      fill: 'tozeroy',
      fillcolor: 'rgba(170, 0, 0, 0.1)',
      hovertemplate: '<b>%{x}</b>  %{y:,.2f}<extra></extra>',
    });
    expect(line.legendgroup).toBeUndefined();
    expect(trend).toEqual({
      x: [2000, 2004],
      y: [1, 5],
      type: 'scatter',
      mode: 'lines',
      line: { color: RED, width: 1.5, dash: 'dash' },
      opacity: 0.55,
      hoverinfo: 'skip',
      name: 'Tendência',
      showlegend: false,
    });
    // The marker neither fills nor hovers: the line already answers the hover at 2003.
    expect(marker).toMatchObject({ mode: 'markers', x: [2003], y: [4], hoverinfo: 'skip', cliponaxis: false });
    expect(marker.fill).toBeUndefined();
    expect(marker.legendgroup).toBeUndefined();
    // The clip is the line's own span, which holds the whole trend.
    expect(reactState.layout.xaxis.autorangeoptions).toEqual({ clipmin: 2000, clipmax: 2004 });
  });

  it('draws nothing extra for an empty series', () => {
    render(<LineChart data={[]} color={RED} />);
    expect(reactState.traces).toHaveLength(1);
  });
});
