// SankeyChart.test.jsx — a dangling link (a source/target id with no node) used
// to map to an `undefined` index, which makes Plotly throw and blanks the whole
// card via the error fallback. The fix filters links so BOTH endpoints resolve
// before building the trace arrays, degrading to a partial diagram instead.
// plotlyBundle is mocked so we capture the trace the chart hands to Plot.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { reactState } = vi.hoisted(() => ({ reactState: { lastTraces: null } }));

vi.mock('./plotlyBundle', () => ({
  default: {
    react: (_el, traces) => { reactState.lastTraces = traces; },
    purge: () => {},
    Plots: { resize: () => {} },
  },
}));

import SankeyChart from './SankeyChart.jsx';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => { cleanup(); reactState.lastTraces = null; });

const sankey = () => reactState.lastTraces?.[0];

const NODES = [
  { id: 'o0', label: 'PA', side: 'origin', value: 10 },
  { id: 'o1', label: 'SP', side: 'origin', value: 5 },
  { id: 'd0', label: 'China', side: 'dest', value: 15 },
];

describe('SankeyChart — dangling links degrade, never throw', () => {
  it('drops a link whose source/target id has no node (no undefined index)', () => {
    const links = [
      { source: 'o0', target: 'd0', value: 10 }, // valid
      { source: 'o1', target: 'd0', value: 5 }, // valid
      { source: 'o9', target: 'd0', value: 99 }, // dangling SOURCE
      { source: 'o0', target: 'd9', value: 77 }, // dangling TARGET
    ];
    render(<SankeyChart nodes={NODES} links={links} unit="US$" />);
    const t = sankey();
    // Only the two valid links survive — no `undefined` slot makes Plotly throw.
    expect(t.link.source).toEqual([0, 1]);
    expect(t.link.target).toEqual([2, 2]);
    expect(t.link.value).toEqual([10, 5]);
    expect(t.link.source).not.toContain(undefined);
    expect(t.link.target).not.toContain(undefined);
    // Color array length tracks the filtered links.
    expect(t.link.color.length).toBe(2);
  });

  it('renders an empty plot (no link trace) when EVERY link is dangling', () => {
    const links = [{ source: 'oX', target: 'dX', value: 1 }];
    render(<SankeyChart nodes={NODES} links={links} unit="US$" />);
    const t = sankey();
    // nodes/links are non-empty so we build a trace, but all links filtered out →
    // empty source/target arrays (a partial/empty diagram, not an error fallback).
    expect(t.link.source).toEqual([]);
    expect(t.link.target).toEqual([]);
  });

  it('passes all links through untouched when none dangle', () => {
    const links = [
      { source: 'o0', target: 'd0', value: 10 },
      { source: 'o1', target: 'd0', value: 5 },
    ];
    render(<SankeyChart nodes={NODES} links={links} unit="US$" />);
    const t = sankey();
    expect(t.link.source).toEqual([0, 1]);
    expect(t.link.value).toEqual([10, 5]);
  });
});

describe('SankeyChart — o hover padrão não inventa zero (v1.93.3)', () => {
  it('um nó sem valor diz "sem dado"; um zero medido continua zero', () => {
    const nodes = [
      { id: 'o0', label: 'PA', side: 'origin', value: null },
      { id: 'o1', label: 'SP', side: 'origin', value: 0 },
      { id: 'd0', label: 'China', side: 'dest', value: 15 },
    ];
    render(<SankeyChart nodes={nodes} links={[{ source: 'o1', target: 'd0', value: 15 }]} unit="US$" />);
    // `(Number(v) || 0)` printed "0 US$" for PA, a flow nobody measured.
    expect(sankey().node.customdata).toEqual(['sem dado', '0 US$', '15 US$']);
  });
});
