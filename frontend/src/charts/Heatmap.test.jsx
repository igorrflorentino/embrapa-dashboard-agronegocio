// Heatmap.test.jsx — column alignment for RAGGED per-row series. The matrix x
// axis must be the UNION of every row's years (sorted), and each row's values
// indexed into that shared axis with null for gaps. Building x from rows[0] alone
// shifted a sparse row's cells onto the wrong year. plotlyBundle is mocked so we
// capture the (x, y, z) trace Heatmap hands to Plot.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { reactState } = vi.hoisted(() => ({
  reactState: { lastTraces: null, lastLayout: null, els: [] },
}));

vi.mock('./plotlyBundle', () => ({
  default: {
    // `el` is recorded too: an orientation flip MUST land on a fresh element (see the
    // remount test below), and the element identity is the only honest evidence of that.
    // The layout carries the margins and the unit's annotation on a short plot.
    react: (el, traces, layout) => {
      reactState.lastTraces = traces;
      reactState.lastLayout = layout;
      reactState.els.push(el);
    },
    purge: () => {},
    Plots: { resize: () => {} },
  },
}));

import Heatmap from './Heatmap.jsx';

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
  reactState.els = [];
});

const trace = () => reactState.lastTraces?.[0];
const layout = () => reactState.lastLayout;

describe('Heatmap ragged-row column alignment', () => {
  it('builds x from the UNION of years and indexes each row, gaps → null', () => {
    // Row B is missing 2019 → its 5 must land under 2020, NOT shift onto 2019.
    render(
      <Heatmap
        rows={[
          { id: 'PA', label: 'PA', values: [{ y: 2019, v: 1 }, { y: 2020, v: 2 }] },
          { id: 'SP', label: 'SP', values: [{ y: 2020, v: 5 }] },
        ]}
      />,
    );
    const t = trace();
    expect(t.x).toEqual([2019, 2020]);
    expect(t.y).toEqual(['PA', 'SP']);
    expect(t.z[0]).toEqual([1, 2]);
    expect(t.z[1]).toEqual([null, 5]); // 2019 gap → null; 5 stays under 2020
  });

  it('sorts the union axis chronologically regardless of row/value order', () => {
    render(
      <Heatmap
        rows={[
          { id: 'A', label: 'A', values: [{ y: 2021, v: 9 }, { y: 2019, v: 7 }] },
          { id: 'B', label: 'B', values: [{ y: 2020, v: 8 }] },
        ]}
      />,
    );
    const t = trace();
    expect(t.x).toEqual([2019, 2020, 2021]);
    expect(t.z[0]).toEqual([7, null, 9]); // A: 2019 & 2021 present, 2020 gap
    expect(t.z[1]).toEqual([null, 8, null]); // B: only 2020
  });

  it('renders an empty plot (no trace) when no row carries any year', () => {
    render(<Heatmap rows={[{ id: 'A', label: 'A', values: [] }]} />);
    expect(reactState.lastTraces).toEqual([]);
  });
});

// ── The colorbar has to fit the plot it lives in ─────────────────────────────
//
// The colorbar spans the PLOT's height. With one row the plot is ~68px, and a
// right-side unit title plus tick labels collided into an unreadable smudge — exactly
// what a single-UF selection produces, which is the most common narrowing there is.

describe('Heatmap — the colorbar adapts to a short plot', () => {
  const oneRow = [{ id: 'PA', label: 'PA · Pará', values: [{ y: 2019, v: 1 }, { y: 2020, v: 2 }] }];
  const manyRows = Array.from({ length: 8 }, (_, i) => ({
    id: `U${i}`, label: `U${i}`, values: [{ y: 2019, v: i + 1 }],
  }));

  it('goes HORIZONTAL when there are few rows — width is what a short plot has', () => {
    render(<Heatmap rows={oneRow} valueKey="v" valueLabel="R$" />);
    const cb = trace().colorbar;
    expect(cb.orientation).toBe('h');
    // Pinned to the CONTAINER's bottom, not to the plotting area: on a one-row heatmap
    // that area is ~16px tall, so a paper-relative offset moved the bar a few pixels and
    // dropped the unit onto the year labels.
    expect(cb.yref).toBe('container');
    expect(cb.yanchor).toBe('bottom');
  });

  it('stays vertical once the plot is tall enough to hold it', () => {
    render(<Heatmap rows={manyRows} valueKey="v" valueLabel="R$" />);
    // Declared EXPLICITLY, not left to Plotly's default: react() keeps an omitted
    // nested attribute at its previous value, so a key set in one branch and missing
    // from the other survives an orientation flip and places the bar half-stale.
    expect(trace().colorbar.orientation).toBe('v');
  });

  it('declares the same key set in both orientations', () => {
    render(<Heatmap rows={manyRows} valueKey="v" valueLabel="R$" />);
    const tall = Object.keys(trace().colorbar).sort();
    cleanup();
    render(<Heatmap rows={oneRow} valueKey="v" valueLabel="R$" />);
    expect(Object.keys(trace().colorbar).sort()).toEqual(tall);
  });

  it('spans the full extent in whichever direction has room', () => {
    render(<Heatmap rows={oneRow} valueKey="v" valueLabel="R$" />);
    expect(trace().colorbar.len).toBe(1);          // full plot WIDTH when horizontal
    cleanup();
    render(<Heatmap rows={manyRows} valueKey="v" valueLabel="R$" />);
    expect(trace().colorbar.len).toBe(1);          // full plot HEIGHT when vertical
  });

  it('keeps the pt-BR tick ladder in BOTH orientations', () => {
    // The whole point of the custom ticks is avoiding Plotly's English "14B" next to
    // the app's "14 bi"; an orientation switch must not quietly drop them.
    render(<Heatmap rows={oneRow} valueKey="v" valueLabel="R$" />);
    const short = trace().colorbar;
    cleanup();
    render(<Heatmap rows={manyRows} valueKey="v" valueLabel="R$" />);
    const tall = trace().colorbar;
    expect(short.tickmode).toBe(tall.tickmode);
  });

  it('does not touch the layout when the caller fixes the height itself', () => {
    // An explicit height means the caller sized the plot on purpose; second-guessing it
    // would move someone else's chart.
    render(<Heatmap rows={oneRow} valueKey="v" valueLabel="R$" height={400} />);
    expect(trace().colorbar.orientation).toBe('v');
  });
});

// ── Crossing the orientation threshold must REMOUNT the plot ─────────────────
//
// Plotly.react reuses the existing `.colorbar` SVG group across an orientation change.
// gd.data AND gd._fullData both end up correct (orientation 'v', x 1.02, len 1) while
// the DRAWN group keeps the horizontal geometry — measured live at x=309 w=297 inside a
// 937px plot, a bar stranded across the middle of the heatmap. Selecting a UF and then
// deselecting it walked into exactly that, which is how it was reported.
//
// The fix is a React `key` on <Plot>, so the flip gives Plotly a clean element. The
// element identity is the only honest evidence, so that is what this asserts.

describe('Heatmap — an orientation flip gets a fresh plot element', () => {
  const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({
    id: `U${i}`, label: `U${i}`, values: [{ y: 2019, v: i + 1 }, { y: 2020, v: i + 2 }],
  }));

  it('remounts when going from many rows to one, and back', () => {
    const { rerender } = render(<Heatmap rows={rowsFor(8)} valueKey="v" valueLabel="R$" />);
    const tall = reactState.els.at(-1);

    rerender(<Heatmap rows={rowsFor(1)} valueKey="v" valueLabel="R$" />);
    const short = reactState.els.at(-1);
    expect(short).not.toBe(tall);          // horizontal bar drawn on a clean element

    rerender(<Heatmap rows={rowsFor(8)} valueKey="v" valueLabel="R$" />);
    const backToTall = reactState.els.at(-1);
    // The return trip is the one that was broken: without a remount the vertical bar
    // inherited the horizontal geometry and landed mid-plot.
    expect(backToTall).not.toBe(short);
  });

  it('ALSO remounts when the row count changes the height, same orientation or not', () => {
    // This assertion used to be the opposite — "does NOT remount for a row change that
    // stays on the same side of the threshold" — and that is precisely the bug it went
    // on to bless: going from 5 regions to 1 keeps the horizontal orientation, so the
    // orientation key never changed, and the plot kept the FIVE-row geometry (a 105px
    // band inside a 132px plot, colorbar stranded at y=-76, above the card).
    // Plotly.react does not re-lay-out for a changed container height.
    const { rerender } = render(<Heatmap rows={rowsFor(5)} valueKey="v" valueLabel="R$" />);
    const five = reactState.els.at(-1);
    rerender(<Heatmap rows={rowsFor(1)} valueKey="v" valueLabel="R$" />);
    expect(reactState.els.at(-1)).not.toBe(five);
  });

  it('does NOT remount when the geometry is unchanged', () => {
    // The guarantee that keeps the key from becoming a re-plot on every render: same
    // row count and same height ⇒ same element, however often the data itself changes.
    const rows = rowsFor(8);
    const { rerender } = render(<Heatmap rows={rows} valueKey="v" valueLabel="R$" />);
    const first = reactState.els.at(-1);
    rerender(<Heatmap rows={rows.map((r) => ({ ...r, values: [{ y: 2019, v: 99 }] }))}
                      valueKey="v" valueLabel="R$" />);
    expect(reactState.els.at(-1)).toBe(first);
  });
});

// ── The legend must answer "what does the darkest colour mean?" ──────────────
//
// The old ticks were nice ROUND values over the data range, which is right for an axis
// and wrong for a legend: on a scale ending at ~134 mi they emitted 0 / 50 mi / 100 mi,
// landing at 0%, 37% and 75% of the bar with NOTHING marking the top — the one value a
// reader most wants from a gradient.

describe('Heatmap — colorbar anchors', () => {
  const rows = [{
    id: 'PA', label: 'PA',
    values: [{ y: 2019, v: 20e6 }, { y: 2020, v: 134e6 }, { y: 2021, v: 60e6 }],
  }];

  it('anchors at the low end, the midpoint and the high end — always those three', () => {
    render(<Heatmap rows={rows} valueKey="v" valueLabel="R$" />);
    const cb = trace().colorbar;
    expect(cb.tickvals).toEqual([20e6, 77e6, 134e6]);
    // Labels stay on the pt-BR ladder, so the legend and the KPI cards read alike.
    expect(cb.ticktext).toEqual(['20 mi', '77 mi', '134 mi']);
  });

  it('pins zmin/zmax so the bar ENDS and its labels describe the same numbers', () => {
    render(<Heatmap rows={rows} valueKey="v" valueLabel="R$" />);
    const t = trace();
    expect(t.zmin).toBe(20e6);
    expect(t.zmax).toBe(134e6);
    expect(t.colorbar.tickvals[0]).toBe(t.zmin);
    expect(t.colorbar.tickvals.at(-1)).toBe(t.zmax);
  });

  it('places the unit ABOVE the bar in both orientations, where it cannot be read as a value', () => {
    // Vertical: an annotation over the bar's column, at the plot's top edge. Beside the bar,
    // Plotly rotates a title 90° and "R$" landed sideways in the gradient, between two tick
    // labels, looking like one of them; as the bar's title on top, its box ran into the top
    // label's (the "clears its top tick label" block below).
    const tall = Array.from({ length: 8 }, (_, i) => ({
      id: `U${i}`, label: `U${i}`, values: [{ y: 2019, v: i + 1 }],
    }));
    render(<Heatmap rows={tall} valueKey="v" valueLabel="R$" />);
    expect(trace().colorbar.title).toEqual({ text: '', side: 'top', font: { size: 11 } });
    expect(layout().annotations.map((a) => [a.text, a.xref, a.x, a.yref, a.y, a.yanchor]))
      .toEqual([['R$', 'paper', 1.02, 'paper', 1, 'top']]);
    cleanup();
    // Horizontal: an annotation just above the bar, and NEVER the bar's own title. A title
    // on this container-anchored bar is what drove the plot's height negative — the
    // measurement is in the "draws at every row count" block below.
    render(<Heatmap rows={rows} valueKey="v" valueLabel="R$" />);
    expect(trace().colorbar.title.text).toBe('');
    expect(layout().annotations.map((a) => a.text)).toEqual(['R$']);
  });

  it('falls back to Plotly ticks on a degenerate (single-value) scale', () => {
    // Every cell equal ⇒ there is no range to anchor; inventing three identical labels
    // would dress a non-existent gradient up as a scale.
    render(<Heatmap rows={[{ id: 'X', label: 'X', values: [{ y: 2019, v: 5 }, { y: 2020, v: 5 }] }]}
                    valueKey="v" valueLabel="R$" />);
    expect(trace().colorbar.tickvals).toBeUndefined();
  });
});

// ── Geometry invariants across the whole row-count space ─────────────────────
//
// Why this block exists, in one paragraph. The colorbar took FIVE fixes in a single day
// (v1.29.3 adaptive bar, v1.29.5 remount on orientation, v1.30.0 anchors/span/title,
// v1.30.1 threshold, v1.31.3 remount on height). Every one was correct and incomplete,
// because each was verified against the two or three row counts that happened to be on
// screen. Worse, the per-case tests written alongside them encoded the behaviour that
// was ASSUMED — one of them ("does not remount for a row change on the same side of the
// threshold") stated precisely the rule that produced the v1.31.3 bug.
//
// So these are not more cases. They are the properties that must hold for EVERY row
// count, checked by sweeping the space instead of sampling it.

describe('Heatmap — geometry invariants over 1..15 rows', () => {
  const SPAN = Array.from({ length: 15 }, (_, i) => i + 1);
  const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({
    id: `U${i}`, label: `U${i}`, values: [{ y: 2019, v: i + 1 }, { y: 2020, v: (i + 1) * 3 }],
  }));

  it('orientation follows the threshold with no exceptions', () => {
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const expected = n <= 5 ? 'h' : 'v';
      expect(`${n}:${trace().colorbar.orientation}`).toBe(`${n}:${expected}`);
      cleanup();
    }
  });

  it('declares one colorbar key set, whatever the row count', () => {
    // A key present in one branch and absent from the other survives a flip, because
    // Plotly.react leaves an omitted nested attribute at its previous value.
    let shape = null;
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const keys = Object.keys(trace().colorbar).sort().join(',');
      if (shape === null) shape = keys;
      expect(`${n}:${keys}`).toBe(`${n}:${shape}`);
      cleanup();
    }
  });

  it('always anchors on exactly the low end, the midpoint and the high end', () => {
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const t = trace();
      expect(t.colorbar.tickvals).toHaveLength(3);
      expect(t.colorbar.tickvals[0]).toBe(t.zmin);
      expect(t.colorbar.tickvals[2]).toBe(t.zmax);
      expect(t.colorbar.tickvals[1]).toBe((t.zmin + t.zmax) / 2);
      cleanup();
    }
  });

  it('spans the full extent in every case', () => {
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      expect(`${n}:${trace().colorbar.len}`).toBe(`${n}:1`);
      cleanup();
    }
  });

  // THE invariant the v1.31.3 bug violated. Plotly.react does not re-lay-out for a
  // changed container height, so a geometry change MUST reach a fresh element — whether
  // or not the orientation happens to flip with it.
  it('every step in row count lands on a new plot element', () => {
    const { rerender } = render(<Heatmap rows={rowsFor(1)} valueKey="v" valueLabel="R$" />);
    let prev = reactState.els.at(-1);
    for (const n of SPAN.slice(1)) {
      rerender(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const now = reactState.els.at(-1);
      expect(`${n - 1}->${n}: ${now === prev ? 'REUSED' : 'fresh'}`).toBe(`${n - 1}->${n}: fresh`);
      prev = now;
    }
  });

  it('and shrinking back down does too — the reported direction', () => {
    // 5 regiões → 1 região keeps the horizontal orientation, which is exactly why the
    // orientation-only key missed it and the plot kept the five-row geometry.
    const { rerender } = render(<Heatmap rows={rowsFor(5)} valueKey="v" valueLabel="R$" />);
    const five = reactState.els.at(-1);
    rerender(<Heatmap rows={rowsFor(1)} valueKey="v" valueLabel="R$" />);
    expect(reactState.els.at(-1)).not.toBe(five);
  });

  it('but a pure data change never remounts, at any row count', () => {
    // The other half: the key must not turn into a re-plot on every render.
    for (const n of [1, 5, 6, 12]) {
      const { rerender, unmount } = render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const first = reactState.els.at(-1);
      rerender(<Heatmap rows={rowsFor(n).map((r) => ({ ...r, values: [{ y: 2019, v: 42 }] }))}
                        valueKey="v" valueLabel="R$" />);
      expect(`${n}:${reactState.els.at(-1) === first ? 'same' : 'REMOUNTED'}`).toBe(`${n}:same`);
      unmount();
    }
  });

  it('an explicit height keeps the vertical bar at every row count', () => {
    // A caller that sizes the plot has taken responsibility for it; second-guessing
    // would move someone else's chart.
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" height={400} />);
      expect(`${n}:${trace().colorbar.orientation}`).toBe(`${n}:v`);
      cleanup();
    }
  });

  // The rule the "draws at every row count" block below measured, stated for any row
  // count: on a bar anchored to the container, a title is what sends the plot's height
  // negative.
  it('never titles a horizontal bar anchored to the container', () => {
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const cb = trace().colorbar;
      const titled = cb.orientation === 'h' && cb.yref === 'container' && cb.title.text !== '';
      expect(`${n}:${titled ? 'TITLED' : 'ok'}`).toBe(`${n}:ok`);
      cleanup();
    }
  });

  // And on the vertical bar, the title is what ran into the top tick label (v1.108.16): no
  // orientation is titled any more, and the unit is an annotation in both.
  it('never titles the bar, in either orientation', () => {
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const cb = trace().colorbar;
      expect(`${n}:${cb.orientation} title '${cb.title.text}'`)
        .toBe(`${n}:${n <= 5 ? 'h' : 'v'} title ''`);
      cleanup();
    }
  });

  it('shows the unit exactly once, at every row count', () => {
    // Moving the unit out of either bar must neither lose it nor print it twice. The title
    // is still counted, so a unit put back on the bar AND left in an annotation fails here.
    for (const n of SPAN) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const shown = (trace().colorbar.title.text === 'R$' ? 1 : 0)
        + (layout().annotations ?? []).filter((a) => a.text === 'R$').length;
      expect(`${n}:${shown}`).toBe(`${n}:1`);
      cleanup();
    }
  });
});

// ── A short heatmap has to DRAW, at every row count ──────────────────────────
//
// Reported in the v1.108.1 notes: Geografia with 2 municípios over 40 years showed "Não
// foi possível renderizar este gráfico", and Plotly logged "Something went wrong with axis
// scaling" — a negative plot height. Measured in the browser (2026-11-23, Plotly 4.3.0, the
// 659 px Geografia card), with the unit as the TITLE of the horizontal bar anchored to the
// container:
//
//   rows  height  margin the bar reserved  plot height
//    1     132       50.7 (absorbed)          16      drew
//    2     156      171.1                    -23.1    threw
//    3     180      307.4                   -165.3    threw
//    4     204       98.8                     67.4    drew; band squashed, unit under the labels
//    5     228       83.4                    106.7    drew; unit under the labels
//
// Plotly places such a title `height × (thickness + ypad) / plotHeight` px down, the margin
// the bar reserves follows the title, and the smaller plot pushes the title further: on a
// short plot the loop runs away. With no title the reservation is a constant 50.7 px, the
// 108 px bottom margin absorbs it, and the plot is exactly 24 × rows − 8 px at every count.
//
// jsdom lays nothing out, so these tests cannot watch Plotly fail. They pin the
// configuration the measurement found to be the trigger, and the geometry that replaced it.

describe('Heatmap — a short heatmap draws at every row count (1..6)', () => {
  const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({
    id: `M${i}`, label: `Município ${i} · PA`,
    values: Array.from({ length: 40 }, (_, k) => ({ y: 1985 + k, v: (i + 1) * 1e6 * (1 + k / 7) })),
  }));
  // The wrapper div <Plot> sizes; Plotly reads its height from it.
  const plotHeight = (container) => parseFloat(container.firstChild.style.height);

  it('never titles the horizontal bar anchored to the container: the measured trigger', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const cb = trace().colorbar;
      expect(`${n}: ${cb.orientation}/${cb.yref} title '${cb.title.text}'`)
        .toBe(`${n}: h/container title ''`);
      cleanup();
    }
  });

  it('draws the unit as ONE annotation, 61 px under the plot at every row count', () => {
    // y = 0 is the plot's bottom edge and yshift is in pixels, so the distance between the
    // unit and the bar is the same at 1 row and at 5. Measured under the plot: the year
    // labels end at 22 px, the unit's text sits at 46–59 px, the bar's top is at 67 px.
    for (const n of [1, 2, 3, 4, 5]) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      expect(layout().annotations).toEqual([{
        text: 'R$',
        xref: 'paper', x: 0.5, xanchor: 'center',
        yref: 'paper', y: 0, yanchor: 'bottom',
        yshift: -61,
        showarrow: false,
        font: { size: 11 },
      }]);
      cleanup();
    }
  });

  it('keeps the plot at 24 × rows − 8 px, under a 108 px strip for years, unit and bar', () => {
    // No height changed: the existing arithmetic was enough once the title stopped eating
    // the plot. 8 px on top; 108 px below for the year labels (22), the unit and the bar
    // with its labels (41 px from the card's bottom edge to the bar's top).
    for (const n of [1, 2, 3, 4, 5]) {
      const { container } = render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$" />);
      const m = layout().margin;
      expect(`${n}: margin ${m.t}/${m.b} plot ${plotHeight(container) - m.t - m.b}`)
        .toBe(`${n}: margin 8/108 plot ${24 * n - 8}`);
      cleanup();
    }
  });

  it('from 6 rows on, the bar is vertical and the unit an annotation above it', () => {
    const { container } = render(<Heatmap rows={rowsFor(6)} valueKey="v" valueLabel="R$" />);
    const cb = trace().colorbar;
    expect(cb.orientation).toBe('v');
    expect(cb.yref).toBe('paper');
    expect(cb.title.text).toBe('');
    expect(layout().annotations.map((a) => a.text)).toEqual(['R$']);
    const m = layout().margin;
    expect(plotHeight(container) - m.t - m.b).toBe(130); // 24 × 6 − 14, as before v1.108.16
  });

  it('with no unit, there is nothing to annotate and still no title', () => {
    for (const n of [1, 5]) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="" />);
      expect(trace().colorbar.title.text).toBe('');
      expect(layout().annotations ?? []).toEqual([]);
      cleanup();
    }
  });
});

// ── The vertical bar's unit has to clear its top tick label ──────────────────
//
// Reported in the v1.108.6 notes. Measured 2026-11-27 (Plotly 4.3.0, after
// document.fonts.ready, the Geografia card at 1280 px), with the unit as the TITLE of the
// vertical bar, side 'top': its box ran down into the top tick label's (1.8 px at 1:1
// pixels, 2.1 px in the app's browser pane at 1.5), and across by as much as the unit
// reaches over the label column. A wide unit sat glued onto the label:
//
//   unit over label      across  (1:1 pixels)
//   "R$ mi" over "543"   14.3 px  PEVS extração, 7 UFs
//   "US$ mi" over "271"  17.7 px  the same in US$
//   "R$ bi" over "150"    9.2 px  PAM, 6 UFs
//
// Plotly lowers the bar's top end by the title's height plus a fixed 5 px and centres the
// label on that end; ypad, len and y move the title and the bar together, so no attribute
// parts them (_base.jsx walks through colorbar/draw.js). The unit is now an annotation and
// the bar's ends are inset by ypad: 3.5 px between unit and label, measured in all three.
// The arithmetic that keeps them apart is tested in _base.colorbar.test.js; these tests pin
// that the heatmap uses it at every vertical row count, and that the rows did not pay for
// it.

describe("Heatmap — the vertical bar's unit clears its top tick label (6..15 rows)", () => {
  const TALL = Array.from({ length: 10 }, (_, i) => i + 6);
  const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({
    id: `U${i}`, label: `U${i}`, values: [{ y: 2019, v: i + 1 }, { y: 2020, v: (i + 1) * 3 }],
  }));
  const plotHeight = (container) => parseFloat(container.firstChild.style.height);

  it('draws the unit as ONE annotation over the bar, at every row count', () => {
    for (const n of TALL) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$ mi" />);
      expect(layout().annotations).toEqual([{
        text: 'R$ mi',
        xref: 'paper', x: 1.02, xanchor: 'left', xshift: 10,
        yref: 'paper', y: 1, yanchor: 'top', yshift: 2,
        borderpad: 0, borderwidth: 0,
        showarrow: false,
        font: { size: 11 },
      }]);
      cleanup();
    }
  });

  it("insets the bar's ends by 20 px, on the column the unit starts on", () => {
    for (const n of TALL) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$ mi" />);
      const cb = trace().colorbar;
      expect(`${n}: x ${cb.x} xpad ${cb.xpad} ypad ${cb.ypad}`)
        .toBe(`${n}: x 1.02 xpad 10 ypad 20`);
      cleanup();
    }
  });

  it('keeps the plot at 24 × rows − 14 px under the 32 px top margin', () => {
    // The figure grows by the 10 px the top margin took past its former 22, so every row
    // keeps its 24 px. The bar is 2 px shorter (measured 116 → 114 px at 7 rows).
    for (const n of TALL) {
      const { container } = render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="R$ mi" />);
      const m = layout().margin;
      const fig = plotHeight(container);
      expect(`${n}: margin ${m.t}/${m.b} figure ${fig} plot ${fig - m.t - m.b}`)
        .toBe(`${n}: margin 32/36 figure ${54 + 24 * n} plot ${24 * n - 14}`);
      cleanup();
    }
  });

  it('with no unit, no annotation and still no title', () => {
    for (const n of [6, 12]) {
      render(<Heatmap rows={rowsFor(n)} valueKey="v" valueLabel="" />);
      expect(trace().colorbar.title.text).toBe('');
      expect(layout().annotations ?? []).toEqual([]);
      cleanup();
    }
  });

  it('a caller-fixed height gets the same unit, above the same inset bar', () => {
    render(<Heatmap rows={rowsFor(3)} valueKey="v" valueLabel="R$" height={400} />);
    const cb = trace().colorbar;
    expect(`${cb.orientation} title '${cb.title.text}' ypad ${cb.ypad}`).toBe("v title '' ypad 20");
    expect(layout().annotations.map((a) => a.text)).toEqual(['R$']);
    expect(layout().margin.t).toBe(32);
  });
});
