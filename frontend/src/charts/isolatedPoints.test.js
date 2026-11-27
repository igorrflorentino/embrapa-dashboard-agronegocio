// isolatedPoints.test.js — which points a line chart cannot draw, and the marker trace that
// draws them. Plotly joins consecutive present entries of the ARRAY and draws a run of one
// point as nothing; these tests pin that reading (a null breaks the run, zero does not, a
// missing array entry is not a gap) and the shape of the marker trace the charts append.

import { describe, expect, it } from 'vitest';

import { ISOLATED_MARKER_SIZE, isPresent, isolatedIndices, withIsolatedPoints } from './isolatedPoints.js';

const line = (x, y, extra = {}) => ({
  x,
  y,
  type: 'scatter',
  mode: 'lines',
  line: { color: '#123456', width: 2 },
  name: 'Série',
  ...extra,
});

describe('isPresent — what Plotly plots', () => {
  it('reads a finite number as present, zero included', () => {
    expect(isPresent(177.4)).toBe(true);
    expect(isPresent(0)).toBe(true);
    expect(isPresent(-3)).toBe(true);
  });

  it('reads null, undefined, NaN, infinities and blanks as a gap', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, '', '   ', 'abc', {}, true]) {
      expect(isPresent(v), String(v)).toBe(false);
    }
  });

  it('reads a numeric string as present, as Plotly does', () => {
    expect(isPresent('12')).toBe(true);
    expect(isPresent('0')).toBe(true);
  });
});

describe('isolatedIndices — present, with no present neighbour in the array', () => {
  it('finds nothing in an empty series', () => {
    expect(isolatedIndices([], [])).toEqual([]);
    expect(isolatedIndices()).toEqual([]);
  });

  it('marks the only point of a one-point series', () => {
    expect(isolatedIndices([2001], [177.4])).toEqual([0]);
  });

  it('marks the point whose only neighbour is absent (440333: the price exists only in 2001)', () => {
    expect(isolatedIndices([2000, 2001], [null, 177.4])).toEqual([1]);
    expect(isolatedIndices([2000, 2001], [177.4, null])).toEqual([0]);
  });

  it('marks a point between two gaps and at either end, never one the line joins', () => {
    //                     0     1     2     3     4     5     6     7
    const ys = [4, null, 3, null, 5, 6, null, 8];
    const xs = [2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007];
    expect(isolatedIndices(xs, ys)).toEqual([0, 2, 7]);
  });

  it('treats zero as a value: a zero is marked when alone and joins its neighbour otherwise', () => {
    expect(isolatedIndices([1, 2, 3], [null, 0, null])).toEqual([1]);
    expect(isolatedIndices([1, 2], [0, 5])).toEqual([]);
  });

  it('follows the array, not the calendar: a year missing from the array is bridged', () => {
    // 2001 is not in the array at all, so Plotly draws 2000 → 2002 as one segment.
    expect(isolatedIndices([2000, 2002], [5, 7])).toEqual([]);
  });

  it('breaks the run at a null x as well', () => {
    expect(isolatedIndices([2000, null, 2002], [5, 6, 7])).toEqual([0, 2]);
  });

  it('reads only as far as the shorter of x and y, as Plotly does', () => {
    expect(isolatedIndices([2000, 2001, 2002], [5])).toEqual([0]);
    expect(isolatedIndices([2000], [5, 6, 7])).toEqual([0]);
  });
});

describe('withIsolatedPoints — the marker trace', () => {
  it('returns the very same lines and no marker when every point has a neighbour', () => {
    const a = line([2000, 2001], [1, 2]);
    const b = line([2000, 2001, 2002], [null, 2, 3]);
    const out = withIsolatedPoints([a, b], { linkLegend: true });
    expect(out.lines[0]).toBe(a);
    expect(out.lines[1]).toBe(b);
    expect(out.markers).toEqual([]);
    expect(out.legend).toEqual({});
    expect(out.xaxis).toEqual({});
  });

  it('draws only the isolated points, in the line colour, without hover or legend entry', () => {
    const a = line([2000, 2001, 2002, 2003], [4, null, 3, null]);
    const { lines, markers } = withIsolatedPoints([a]);
    expect(lines[0]).toBe(a); // the line itself is untouched
    expect(markers).toEqual([
      {
        x: [2000, 2002],
        y: [4, 3],
        type: 'scatter',
        mode: 'markers',
        marker: { color: '#123456', size: ISOLATED_MARKER_SIZE },
        cliponaxis: false,
        name: 'Série',
        showlegend: false,
        hoverinfo: 'skip',
      },
    ]);
  });

  it('puts the marker on its line’s y axis', () => {
    const { markers } = withIsolatedPoints([line([2001], [9], { yaxis: 'y2' })]);
    expect(markers[0].yaxis).toBe('y2');
  });

  it('without a legend, leaves the lines ungrouped and asks nothing of the legend', () => {
    const a = line([2001], [9]);
    const out = withIsolatedPoints([a]);
    expect(out.lines[0]).toBe(a);
    expect(out.lines[0].legendgroup).toBeUndefined();
    expect(out.markers[0].legendgroup).toBeUndefined();
    expect(out.legend).toEqual({});
  });

  it('with a legend, groups each line with its own markers and keeps the legend order normal', () => {
    const a = line([2000, 2001], [1, 2], { name: 'A' }); // nothing isolated
    const b = line([2001], [9], { name: 'B' });
    const c = line([2000, 2001, 2002], [7, null, 8], { name: 'C' });
    const out = withIsolatedPoints([a, b, c], { linkLegend: true });
    // A stays the same object, with no group; B and C come back as grouped COPIES.
    expect(out.lines[0]).toBe(a);
    expect(out.lines[0].legendgroup).toBeUndefined();
    expect(out.lines[1]).not.toBe(b);
    expect(b.legendgroup).toBeUndefined(); // the caller's object is not mutated
    expect(out.lines[1]).toEqual({ ...b, legendgroup: out.markers[0].legendgroup });
    expect(out.lines[2].legendgroup).toBe(out.markers[1].legendgroup);
    expect(out.markers[0].legendgroup).not.toBe(out.markers[1].legendgroup);
    expect(out.markers.map((m) => m.name)).toEqual(['B', 'C']);
    expect(out.legend).toEqual({ traceorder: 'normal' });
  });

  it('keeps a legend group the line already had', () => {
    const out = withIsolatedPoints([line([2001], [9], { legendgroup: 'g' })], { linkLegend: true });
    expect(out.lines[0].legendgroup).toBe('g');
    expect(out.markers[0].legendgroup).toBe('g');
  });

  it('handles no lines at all', () => {
    const none = { lines: [], markers: [], legend: {}, xaxis: {} };
    expect(withIsolatedPoints([])).toEqual(none);
    expect(withIsolatedPoints(undefined)).toEqual(none);
  });
});

// Plotly pads the autorange around markers and not around a bare line, so a marker on the
// first or last year would widen that end of the year axis; the clip restores the lines' span.
describe('withIsolatedPoints — the year axis keeps the lines’ range', () => {
  it('clips the autorange to the lines’ first and last year when it adds a marker', () => {
    // 440392, every reporter: the quantity's last point, 2024, has no neighbour.
    const out = withIsolatedPoints([line([2000, 2001, 2022, 2023, 2024], [1, 2, 3, null, 5])]);
    expect(out.markers[0].x).toEqual([2024]);
    expect(out.xaxis).toEqual({ autorangeoptions: { clipmin: 2000, clipmax: 2024 } });
  });

  it('counts a year the line spans without a value, as Plotly does', () => {
    // 440333: 2000 has no value, and the axis already started there.
    expect(withIsolatedPoints([line([2000, 2001], [null, 177.4])]).xaxis).toEqual({
      autorangeoptions: { clipmin: 2000, clipmax: 2001 },
    });
  });

  it('spans every line, not only the one with the marker', () => {
    const out = withIsolatedPoints([line([1995, 1996], [1, 2]), line([2000, 2001, 2002], [3, null, 4])]);
    expect(out.xaxis).toEqual({ autorangeoptions: { clipmin: 1995, clipmax: 2002 } });
  });

  it('skips a null year and reads only as far as the shorter of x and y', () => {
    // x[0] is no year, and 2004 lies beyond the end of y: the span is 2001–2003.
    const out = withIsolatedPoints([line([null, 2001, 2002, 2003, 2004], [1, 2, null, 4])]);
    expect(out.markers[0].x).toEqual([2001, 2003]);
    expect(out.xaxis).toEqual({ autorangeoptions: { clipmin: 2001, clipmax: 2003 } });
  });

  it('leaves a single year to Plotly, which centres the axis on it', () => {
    expect(withIsolatedPoints([line([2001], [9])]).xaxis).toEqual({});
  });

  it('draws the marker unclipped, so a point on the edge of the axis is drawn whole', () => {
    expect(withIsolatedPoints([line([2000, 2001], [null, 9])]).markers[0].cliponaxis).toBe(false);
  });
});
