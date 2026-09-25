// FlagBars.test.jsx — 100%-stacked horizontal quality-flag bars. Two properties
// worth locking: (1) one horizontal, stack-grouped trace per flag mapped to the
// row fractions, and (2) the Plotly-native legend is opt-out via `showLegend`
// so ViewQuality (which draws its own qa-legend row) doesn't render two legends.
// We capture the traces + layout the chart hands Plotly; plotlyBundle is mocked.

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

import FlagBars from './FlagBars.jsx';

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

afterEach(() => { cleanup(); reactState.traces = null; reactState.layout = null; });

const FLAGS = [
  { id: 'OK', label: 'Sem ressalva', color: '#0a0' },
  { id: 'MISSING_VALUE', label: 'Sem valor', color: '#c90' },
];
const ROWS = [
  { name: 'Açaí (fruto)', OK: 0.9, MISSING_VALUE: 0.1 },
  { name: 'Castanha-do-pará', OK: 1, MISSING_VALUE: 0 },
];

describe('FlagBars', () => {
  it('renders no traces when there are no rows or no flags (never throws on flags[0])', () => {
    render(<FlagBars rows={[]} flags={FLAGS} />);
    expect(reactState.traces).toEqual([]);
    cleanup();
    render(<FlagBars rows={ROWS} flags={[]} />);
    expect(reactState.traces).toEqual([]);
  });

  it('builds one horizontal stacked trace per flag, mapped to the row fractions', () => {
    render(<FlagBars rows={ROWS} flags={FLAGS} labelKey="name" />);
    const t = reactState.traces;
    expect(t).toHaveLength(2);
    expect(t.every((tr) => tr.type === 'bar' && tr.orientation === 'h')).toBe(true);
    expect(reactState.layout.barmode).toBe('stack');
    expect(t[0].name).toBe('Sem ressalva');
    expect(t[0].y).toEqual(['Açaí (fruto)', 'Castanha-do-pará']);
    expect(t[0].x).toEqual([0.9, 1]);
    expect(t[1].x).toEqual([0.1, 0]);
  });

  it('shows the Plotly legend by default and hides it when showLegend=false', () => {
    render(<FlagBars rows={ROWS} flags={FLAGS} labelKey="name" />);
    expect(reactState.layout.showlegend).toBe(true);
    cleanup();
    // ViewQuality draws its own qa-legend row → opt out to avoid a duplicate legend.
    render(<FlagBars rows={ROWS} flags={FLAGS} labelKey="name" showLegend={false} />);
    expect(reactState.layout.showlegend).toBe(false);
  });
});
