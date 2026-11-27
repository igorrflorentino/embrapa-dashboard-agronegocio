// MultiLineChart — Plotly multi-series lines on one shared axis (comparison
// views). Same name + props as the prototype's SVG MultiLineChart, so the
// reused views render <window.MultiLineChart/> unchanged — now with zoom/pan/
// hover and a per-series legend (the point of the Plotly migration).
//   series: [{ name, color, data: [{ y, [valueKey] }] }]
// `showLegend` defaults true (the Plotly-native legend). Set it false when the
// caller already renders its own legend for the same series (e.g. the pc-legend /
// xs-legend rows in the comparison views) so the two don't duplicate.

import { Plot, baseLayout, ptBrLinearAxis, resolveColor, seriesMax, vizPalette, yearAxis } from './_base';
import { withIsolatedPoints } from './isolatedPoints';

function MultiLineChart({ series = [], valueKey = 'v', label = '', height = 200, trend = false, showLegend = true }) {
  const palette = vizPalette();
  // One scatter line per series; fall back to the categorical palette when a
  // series omits its color so concurrent lines stay visually distinct.
  // A point with no present neighbour is a one-point run of its line, which Plotly draws
  // as nothing: it gets a marker of its own, drawn last (isolatedPoints.js), and the year
  // axis keeps the lines' range around it. With Plotly's legend shown, the series and its
  // markers share a legend group, so hiding one hides both.
  const { lines, markers, legend: legendOrder, xaxis: xClip } = withIsolatedPoints(
    series.map((s, i) => ({
      x: (s.data || []).map((d) => d.y),
      y: (s.data || []).map((d) => d[valueKey]),
      type: 'scatter',
      mode: 'lines',
      line: { color: resolveColor(s.color, palette[i % palette.length]), width: 2, shape: 'linear' },
      name: s.name,
      hovertemplate: '<b>%{x}</b>  %{y:,.2f}<extra>%{fullData.name}</extra>',
    })),
    { linkLegend: showLegend },
  );
  const traces = [...lines];
  // Optional per-series linear (OLS) trend overlay — a thin dashed line matching
  // each series' colour, so divergence/convergence of the fitted slopes is visible.
  if (trend && window.linearFit) {
    series.forEach((s, i) => {
      const fit = window.linearFit(s.data || [], valueKey);
      if (!fit) return;
      traces.push({
        x: fit.line.map((d) => d.y),
        y: fit.line.map((d) => d[valueKey]),
        type: 'scatter',
        mode: 'lines',
        line: { color: resolveColor(s.color, palette[i % palette.length]), width: 1.5, dash: 'dash' },
        opacity: 0.5,
        hoverinfo: 'skip',
        showlegend: false,
      });
    });
  }
  traces.push(...markers);

  // pt-BR magnitude ticks ("15 bi" not the SI "15G") so every value axis matches the
  // dashboard's labels and is consistent across cards (FINDING #9) — max over all
  // series. Falls back to `~s` when there is no usable positive max.
  const ymax = seriesMax(series.flatMap((s) => s.data || []), (d) => d[valueKey]);
  const layout = baseLayout({
    margin: { l: 56, r: 12, t: 18, b: 28 },
    showlegend: showLegend,
    legend: { orientation: 'h', y: 1.12, x: 0, font: { size: 11 }, ...legendOrder },
    yaxis: {
      title: { text: label, font: { size: 11 }, standoff: 8 },
      ...ptBrLinearAxis(ymax),
    },
    xaxis: yearAxis(xClip),
  });

  return <Plot traces={traces} layout={layout} height={height} />;
}

window.MultiLineChart = MultiLineChart;
export default MultiLineChart;
