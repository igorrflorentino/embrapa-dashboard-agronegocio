// MonthYearHeatmap.test.jsx — the month × year heatmap of "Sazonalidade e tendências".
// Its colour bar is ALWAYS vertical, so it carried the defect the v1.108.6 notes reported
// on the Geografia heatmap: the unit, as the bar's title, ran into the top tick label
// ("US$" on "10 bi"; measured 2026-11-27, 1.8 px down and 5.5 px across at 1:1 pixels).
// plotlyBundle is mocked so we capture the trace and the layout handed to Plot; the
// arithmetic that keeps the unit clear is tested in _base.colorbar.test.js.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { reactState } = vi.hoisted(() => ({
  reactState: { lastTraces: null, lastLayout: null },
}));

vi.mock('./plotlyBundle', () => ({
  default: {
    react: (el, traces, layout) => {
      reactState.lastTraces = traces;
      reactState.lastLayout = layout;
    },
    purge: () => {},
    Plots: { resize: () => {} },
  },
}));

import MonthYearHeatmap from './MonthYearHeatmap.jsx';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  reactState.lastTraces = null;
  reactState.lastLayout = null;
});

const trace = () => reactState.lastTraces?.[0];
const layout = () => reactState.lastLayout;
// The wrapper div <Plot> sizes; Plotly reads its height from it.
const plotHeight = (container) => parseFloat(container.firstChild.style.height);

// Two years of monthly values, in the serializer's pre-scaled unit, one month absent.
const matrix = {
  2024: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  2025: [2, 4, 6, 8, null, 12, 14, 16, 18, 20, 22, 24],
};
const years = [2024, 2025];

describe('MonthYearHeatmap — the unit above the vertical bar', () => {
  it("is never the bar's title: that box ran into the top tick label", () => {
    render(<MonthYearHeatmap matrix={matrix} years={years} unit="US$" />);
    expect(trace().colorbar.title).toEqual({ text: '', side: 'top', font: { size: 11 } });
  });

  it("is ONE annotation over the bar's column, its box exactly the text's", () => {
    render(<MonthYearHeatmap matrix={matrix} years={years} unit="US$" />);
    expect(layout().annotations).toEqual([{
      text: 'US$',
      xref: 'paper', x: 1.02, xanchor: 'left', xshift: 10,
      yref: 'paper', y: 1, yanchor: 'top', yshift: 2,
      borderpad: 0, borderwidth: 0,
      showarrow: false,
      font: { size: 11 },
    }]);
  });

  it("insets the bar's ends by 20 px, on the column the unit starts on", () => {
    render(<MonthYearHeatmap matrix={matrix} years={years} unit="US$" />);
    const cb = trace().colorbar;
    expect(`x ${cb.x} xpad ${cb.xpad} ypad ${cb.ypad}`).toBe('x 1.02 xpad 10 ypad 20');
  });

  it('declares the 32 px top margin the month labels already took, so the plot keeps 180 px', () => {
    // It said 30, and Plotly's automargin, making room for the month labels on top, drew
    // it at 32: measured, the plot was 180 px tall before this change and is after it.
    const { container } = render(<MonthYearHeatmap matrix={matrix} years={years} unit="US$" />);
    const m = layout().margin;
    expect(`margin ${m.t}/${m.b} plot ${plotHeight(container) - m.t - m.b}`)
      .toBe('margin 32/28 plot 180');
  });

  it('with no unit, no annotation and still no title', () => {
    render(<MonthYearHeatmap matrix={matrix} years={years} unit="" />);
    expect(trace().colorbar.title.text).toBe('');
    expect(layout().annotations ?? []).toEqual([]);
  });
});

describe('MonthYearHeatmap — what moving the unit must not change', () => {
  it('anchors the legend at the low end, the midpoint and the high end', () => {
    render(<MonthYearHeatmap matrix={matrix} years={years} unit="US$" />);
    const t = trace();
    expect([t.zmin, t.zmax]).toEqual([1, 24]);
    expect(t.colorbar.tickvals).toEqual([1, 12.5, 24]);
  });

  it('puts the most recent year on top, and an absent month is "sem dado", not 0', () => {
    render(<MonthYearHeatmap matrix={matrix} years={years} unit="US$" />);
    const t = trace();
    expect(t.y).toEqual([2025, 2024]);
    expect(t.customdata[0][0]).toBe('2 US$');
    expect(t.customdata[0][4]).toBe('sem dado');
  });

  it('renders an empty plot, at the default height, when there is no year', () => {
    const { container } = render(<MonthYearHeatmap matrix={{}} years={[]} unit="US$" />);
    expect(reactState.lastTraces).toEqual([]);
    expect(plotHeight(container)).toBe(240);
  });
});
