// BarChart — Plotly horizontal bars, one per row. Same name + props as the
// prototype's SVG BarChart, so the reused views render <window.BarChart/>
// unchanged — but now with zoom/pan/hover (the point of the Plotly migration).
//   data: [{ uf|name, [valueKey] }]  ·  labeled by d.uf||d.name, value at bar tip.

import { Plot, baseLayout, ptBrLinearAxis, ptBrMagnitude, resolveColor, seriesMax } from './_base';

function BarChart({ data = [], height = 200, color = 'var(--viz-2)', label = '', valueKey = 'value', compact = true, hoverKey = null, hoverLabel = '' }) {
  const c = resolveColor(color);
  // Category label per row (uf preferred, name fallback) and its value.
  const cats = data.map((d) => d.uf || d.name);
  const vals = data.map((d) => d[valueKey]);

  const traces = [
    {
      x: vals,
      y: cats,
      type: 'bar',
      orientation: 'h',
      marker: { color: c },
      // COMPACT magnitude label at the bar tip ("2,9 bi", "384 mi") — the raw pt-BR
      // number ("2.900.918.362,00") overflowed the card and was clipped at the edge
      // on the longest bar (audit LABEL-1). Compact matches the x-axis magnitude
      // ticks; the hover still shows the exact value. `compact=false` keeps the full
      // integer for UNIT metrics where the exact figure matters and the magnitude
      // word misleads — e.g. kg/ha yield ("3.500", not "3,5 mil"); mirrors
      // BrazilTileMap's compact flag so a view's map + ranking read the same (audit CORR-1).
      text: vals.map((v) => (v == null ? '' : compact ? ptBrMagnitude(v) : v.toLocaleString('pt-BR'))),
      textposition: 'outside',
      cliponaxis: false,
      // Segunda grandeza opcional no hover (a BASE por trás da razão que a barra
      // desenha — p.ex. a área colhida sob o rendimento). Sem `hoverKey` o template é
      // o de antes, byte a byte, para os demais chamadores.
      customdata: hoverKey ? data.map((d) => d[hoverKey]) : undefined,
      hovertemplate: hoverKey
        ? `<b>%{y}</b>  %{x:,.2f}<br>${hoverLabel}: %{customdata:,.0f}<extra></extra>`
        : '<b>%{y}</b>  %{x:,.2f}<extra></extra>',
      name: label,
    },
  ];

  const layout = baseLayout({
    hovermode: 'closest',
    // Right margin holds the longest bar's outside label (the compact "2,9 bi"),
    // so it never clips at the card edge.
    margin: { l: 60, r: 52, t: 14, b: 26 },
    xaxis: {
      title: { text: label, font: { size: 11 }, standoff: 8 },
      rangemode: 'tozero',
      // pt-BR magnitude ticks ("15 bi" not the SI "15G"), consistent across cards
      // (FINDING #9). Falls back to `~s` when there is no usable positive max.
      ...ptBrLinearAxis(seriesMax(vals)),
    },
    // Keep the rows in the order given (first row on top, like the SVG).
    yaxis: { autorange: 'reversed', automargin: true },
  });

  return <Plot traces={traces} layout={layout} height={height} />;
}

window.BarChart = BarChart;
export default BarChart;
