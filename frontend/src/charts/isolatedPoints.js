// isolatedPoints.js — the marker a line chart owes the point it cannot draw.
//
// LineChart, MultiLineChart and DualAxisLineChart draw `mode: 'lines'` with Plotly's default
// `connectgaps: false`, so an absent year (null) breaks the line instead of reading as zero.
// Plotly draws each run of consecutive present points as ONE path, `'M' + pts.join('L')`
// (plotly.js src/traces/scatter/plot.js), and a run of a single point is a bare "move to":
// nothing is drawn. Its `tozeroy` fill closes over an area of zero. So a value with no present
// neighbour vanished from the chart while the hover still read it. Measured on 2026-11-27 in
// the Perfil do produto, UN Comtrade with every reporter, 440333: the quantity in m³ and the
// implied price exist only in 2001, and their cards drew the paths "M579,9.15" and "M579,8.65"
// and nothing else.
//
// `withIsolatedPoints` adds, for each line, a 'markers' trace holding ONLY those points. The
// line itself keeps its mode, fill, hover and trend, and a gap stays open: no marker sits on
// a point the line already joins, and nothing is drawn between two points it does not join.
//
// The axes. Plotly pads the range around markers (5% of the axis plus the marker radius) and
// not around a bare line, so a marker on the first or last year widened that end of the year
// axis by about 6% (measured: 440392, every reporter, quantity — 2000–2024 became
// 2000–2025.4, while the value card above it stayed 2000–2024). `xaxis` clips the autorange
// back to the lines' own years, the range Plotly gave them before, and the marker is drawn
// unclipped (`cliponaxis: false`) so it is not cut in half at the edge; Plotly still hides a
// marker whose year falls outside a zoomed range. The value axis keeps the marker's padding:
// when an isolated point is the series' extreme, that end of the axis moves by the marker's
// reserve, 3.75 px for a 6 px marker (measured on 440333: 9.15 → 12.9 px from the top), and
// its ticks stay put, since ptBrLinearAxis fixes them from the data.

/** Plotly's default marker diameter, in px — about three times the lines' 2 px stroke. */
export const ISOLATED_MARKER_SIZE = 6;

/** Whether Plotly plots this value: a finite number, or a non-blank numeric string (its
 *  `fast-isnumeric` test). null, undefined, NaN, ±Infinity and '' are gaps. Zero is a value. */
export function isPresent(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
}

/** Indices of the points Plotly draws no segment for: present, with no present neighbour.
 *
 *  Neighbour in the ARRAY, not in the calendar, because that is what Plotly joins: a year
 *  missing from the array (instead of null in it) is bridged by the line, so the two points
 *  around it are drawn and get no marker. A point at either end of the array has no
 *  neighbour on that side. A point needs both coordinates (Plotly breaks the line at a null
 *  x too), and Plotly reads only as far as the shorter of x and y. */
export function isolatedIndices(xs = [], ys = []) {
  const n = Math.min(xs.length, ys.length);
  const drawn = (i) => i >= 0 && i < n && isPresent(xs[i]) && isPresent(ys[i]);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (drawn(i) && !drawn(i - 1) && !drawn(i + 1)) out.push(i);
  }
  return out;
}

/** The chart's line traces plus a marker trace per line that has isolated points, in the
 *  line's colour and on its y axis. Returns `{ lines, markers, legend, xaxis }`; the chart
 *  draws `[...lines, <its other traces>, ...markers]`, so the markers sit on top and every
 *  other trace keeps its index, and it spreads `legend` into layout.legend and `xaxis` into
 *  layout.xaxis. With no isolated point, every line comes back as the same object and
 *  `markers`, `legend` and `xaxis` are empty: the chart is exactly the one it was.
 *
 *  The marker does not hover (`hoverinfo: 'skip'`): the line already answers the hover at
 *  that year, since a lines-only trace still hovers on its points, and a second answer would
 *  print the value twice in the unified box. It is not in the legend either.
 *
 *  `xaxis` clips the year axis's autorange to the lines' first and last years (see the
 *  header), when they differ; a single year keeps Plotly's own range around it.
 *
 *  `linkLegend` — pass it when the chart shows Plotly's legend. A line with isolated points
 *  then comes back as a copy that shares a `legendgroup` with its markers, so hiding the series
 *  in the legend hides its points too (Plotly's default groupclick, 'togglegroup'), and
 *  `legend` is `{ traceorder: 'normal' }`. Any legendgroup turns Plotly's default order to
 *  'grouped', which spaces the legend — and the unified hover box, which copies the legend's
 *  order — group by group. Without a legend there is nothing to click, and Plotly drops
 *  `layout.legend` altogether, so a group would regroup the hover box with no way to say
 *  'normal': there the lines come back as they were, and `legend` is `{}`. */
export function withIsolatedPoints(lines = [], { linkLegend = false } = {}) {
  const markers = [];
  const linked = lines.map((line, i) => {
    const idx = isolatedIndices(line.x, line.y);
    if (!idx.length) return line;
    const group = linkLegend ? line.legendgroup || `linha-${i}` : null;
    markers.push({
      x: idx.map((k) => line.x[k]),
      y: idx.map((k) => line.y[k]),
      type: 'scatter',
      mode: 'markers',
      marker: { color: line.line?.color, size: ISOLATED_MARKER_SIZE },
      cliponaxis: false,
      ...(line.yaxis && { yaxis: line.yaxis }),
      ...(group && { legendgroup: group }),
      name: line.name,
      showlegend: false,
      hoverinfo: 'skip',
    });
    return group ? { ...line, legendgroup: group } : line;
  });
  if (!markers.length) return { lines: linked, markers, legend: {}, xaxis: {} };

  const grouped = linked.some((line, i) => line !== lines[i]);
  const span = yearSpan(lines);
  return {
    lines: linked,
    markers,
    legend: grouped ? { traceorder: 'normal' } : {},
    xaxis: span ? { autorangeoptions: { clipmin: span[0], clipmax: span[1] } } : {},
  };
}

/** The lines' first and last year: the span Plotly gives a lines-only trace, which reads
 *  every x up to the shorter of x and y, with or without a value at that year
 *  (scatter/calc.js). null with fewer than two distinct years: Plotly then centres the axis
 *  on the one year, and a clip would have nothing to restore (it ignores clipmin ≥ clipmax). */
function yearSpan(lines) {
  let first = Infinity;
  let last = -Infinity;
  for (const { x = [], y = [] } of lines) {
    const n = Math.min(x.length, y.length);
    for (let k = 0; k < n; k++) {
      if (!isPresent(x[k])) continue;
      first = Math.min(first, Number(x[k]));
      last = Math.max(last, Number(x[k]));
    }
  }
  return first < last ? [first, last] : null;
}
