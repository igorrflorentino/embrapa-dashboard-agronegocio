// LineChart — Plotly line+area for a single annual series. Same name + props as
// the prototype's SVG LineChart, so the reused views render <window.LineChart/>
// unchanged — but now with zoom/pan/hover (the point of the Plotly migration).
//   data: [{ y, [valueKey] }]

import { Plot, baseLayout, ptBrLinearAxis, resolveColor, seriesMax, withAlpha, yearAxis } from './_base';
import { withIsolatedPoints } from './isolatedPoints';

function LineChart({ data = [], height = 200, color = 'var(--viz-1)', label = '', valueKey = 'v', trend = false }) {
  const c = resolveColor(color);
  // A point with no present neighbour is a one-point run of the line, which Plotly draws as
  // nothing (no stroke, a fill of zero area): it gets a marker of its own, drawn last
  // (isolatedPoints.js), and the year axis keeps the lines' range around it. This chart has
  // no legend, so there is nothing to link it to.
  const { lines, markers, xaxis: xClip } = withIsolatedPoints([
    {
      x: data.map((d) => d.y),
      y: data.map((d) => d[valueKey]),
      type: 'scatter',
      mode: 'lines',
      line: { color: c, width: 2, shape: 'linear' },
      fill: 'tozeroy',
      fillcolor: withAlpha(c, 0.1),
      hovertemplate: '<b>%{x}</b>  %{y:,.2f}<extra></extra>',
      name: label,
    },
  ]);
  const traces = [...lines];
  // Optional linear (OLS) trend overlay — a thin dashed line of the fitted slope.
  const fit = trend && window.linearFit ? window.linearFit(data, valueKey) : null;
  if (fit) {
    traces.push({
      x: fit.line.map((d) => d.y),
      y: fit.line.map((d) => d[valueKey]),
      type: 'scatter',
      mode: 'lines',
      line: { color: c, width: 1.5, dash: 'dash' },
      opacity: 0.55,
      hoverinfo: 'skip',
      name: 'Tendência',
      showlegend: false,
    });
  }
  traces.push(...markers);
  // pt-BR magnitude ticks ("15 bi" not the SI "15G") so a value axis matches the
  // dashboard's "R$ bi/mi/mil" labels and is consistent across cards (FINDING #9).
  // Falls back to Plotly's SI `~s` when the data has no usable positive max.
  const yaxis = {
    title: { text: label, font: { size: 11 }, standoff: 8 },
    rangemode: 'tozero',
    ...ptBrLinearAxis(seriesMax(data, (d) => d[valueKey])),
  };
  const layout = baseLayout({
    margin: { l: 56, r: 12, t: 18, b: 28 },
    yaxis,
    xaxis: yearAxis(xClip),
  });
  return <Plot traces={traces} layout={layout} height={height} />;
}

window.LineChart = LineChart;
export default LineChart;
