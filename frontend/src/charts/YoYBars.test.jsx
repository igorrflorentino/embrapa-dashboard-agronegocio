// YoYBars.test.jsx — the year-over-year % math. A variation that has no answer draws NO
// bar (null), never a made-up one: this file used to pin "missing prev → 0%" and "prev 0
// → 0%" as the contract, which read as "did not change", and an absent CURRENT year came
// out as (null − prev) / prev = −100%, a red bar of total collapse nobody measured.
// The rule is the app's one rule, window.deltaPctIn: absence, a non-positive base, and
// (in nominal R$) a pair across a currency reform all refuse. plotlyBundle is mocked so
// we capture the traces YoYBars hands to Plot and read the computed pct off trace.y.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Capture the last traces passed to Plotly.react (arg index 1).
const { reactState } = vi.hoisted(() => ({ reactState: { lastTraces: null } }));

vi.mock('./plotlyBundle', () => ({
  default: {
    react: (_el, traces) => { reactState.lastTraces = traces; },
    purge: () => {},
    Plots: { resize: () => {} },
  },
}));

import YoYBars from './YoYBars.jsx';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => { cleanup(); reactState.lastTraces = null; });

// The chart slices off the first point (no prior year), so trace.y[k] is the
// YoY for input row k+1.
const pcts = () => reactState.lastTraces?.[0]?.y ?? [];
const colors = () => reactState.lastTraces?.[0]?.marker?.color ?? [];

describe('YoYBars year-over-year math', () => {
  it('computes a real % for a normal increase/decrease', () => {
    render(<YoYBars data={[{ y: 2020, v: 100 }, { y: 2021, v: 50 }, { y: 2022, v: 75 }]} />);
    // 100→50 = -50%, 50→75 = +50%.
    expect(pcts()).toEqual([-50, 50]);
  });

  it('draws no bar over a zero base: the change is undefined, not 0%', () => {
    render(<YoYBars data={[{ y: 2020, v: 0 }, { y: 2021, v: 10 }]} />);
    expect(pcts()).toEqual([null]);
  });

  it('draws no bar when the prior year is absent, instead of "did not change"', () => {
    render(<YoYBars data={[{ y: 2020 }, { y: 2021, v: 10 }]} />);
    expect(pcts()).toEqual([null]);
  });

  it('draws no bar when the CURRENT year is absent, instead of −100%', () => {
    // The deflator gap: the chosen correction does not reach 2021.
    render(<YoYBars data={[{ y: 2020, v: 10 }, { y: 2021, v: null }, { y: 2022, v: 12 }]} />);
    expect(pcts()).toEqual([null, null]);
  });

  it('refuses a negative base, like deltaPct everywhere else in the app', () => {
    render(<YoYBars data={[{ y: 2020, v: -20 }, { y: 2021, v: -10 }]} />);
    expect(pcts()).toEqual([null]);
  });

  it('draws no bar between years that are not consecutive (a two-year change is not annual)', () => {
    render(<YoYBars data={[{ y: 2018, v: 100 }, { y: 2020, v: 150 }, { y: 2021, v: 300 }]} />);
    expect(pcts()).toEqual([null, 100]);
  });

  it('in nominal R$, draws no bar for the pair that crosses a currency reform', () => {
    // 1993→1994 changes currency; 1994→1995 is inside the real.
    render(<YoYBars breaks={[1994]}
                    data={[{ y: 1993, v: 5e6 }, { y: 1994, v: 2 }, { y: 1995, v: 3 }]} />);
    expect(pcts()).toEqual([null, 50]);
  });

  it('colours every bar through deltaColor, so an absent one is neutral, never green', () => {
    // `pct >= 0 ? ok : err` painted the absent bar green (null >= 0 is true). jsdom has no
    // CSS variables to resolve, so the proof is the call itself: each bar asks deltaColor.
    const spy = vi.spyOn(window, 'deltaColor');
    render(<YoYBars data={[{ y: 2020, v: 10 }, { y: 2021, v: null }, { y: 2022, v: 5 }, { y: 2023, v: 10 }]} />);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([null, null, 100]);
    expect(window.deltaColor(null)).toBe('var(--fg-4)');
    expect(colors()).toHaveLength(3);
    spy.mockRestore();
  });

  it('uses a sign-flag-free number format so Plotly actually rounds the % (audit HOVER-2)', () => {
    render(<YoYBars data={[{ y: 2020, v: 100 }, { y: 2021, v: 50 }]} />);
    const tmpl = reactState.lastTraces?.[0]?.hovertemplate || '';
    // Plotly's hovertemplate parser silently fails on the d3 `+` sign flag and dumps
    // the RAW unrounded value; the format MUST stay sign-flag-free (`,.2f`, not `+,.2f`).
    expect(tmpl).not.toContain(':+');
    expect(tmpl).toContain('%{y:,.2f}');
  });
});
