// DualAxisLineChart — Plotly line chart with up to 2 Y axes, one per distinct
// `unit`. Same name + props as the prototype's SVG DualAxisLineChart, so the
// reused cross-source view renders <window.DualAxisLineChart/> unchanged — but
// now with zoom/pan/hover (the point of the Plotly migration).
//   series: [{ label, color, unit, bancoShort, data: [{ y, v }] }]
//
// Grouping rule (from the prototype): the FIRST distinct unit maps to the LEFT
// axis, the SECOND to the RIGHT. Series sharing a unit share an axis. The view
// caps dual-axis mode at 2 distinct units, so we only ever wire two axes.

import { Plot, baseLayout, ptBrLinearAxis, resolveColor, seriesMax, vizPalette, yearAxis } from './_base';
import { withIsolatedPoints } from './isolatedPoints';

// `showLegend` defaults true (the Plotly-native legend). Set it false when the
// caller already renders its own legend for the same series (e.g. ViewSeasonality's
// pc-legend, ViewCrossSource's xs-legend) so the two don't duplicate.
function DualAxisLineChart({ series = [], height = 200, showLegend = true }) {
  // Discover the distinct units in encounter order (max 2 → left/right).
  const units = [];
  series.forEach((s) => {
    if (!units.includes(s.unit)) units.push(s.unit);
  });
  const leftUnit = units[0];
  const rightUnit = units[1];

  const palette = vizPalette();
  // A point with no present neighbour is a one-point run of its line, which Plotly draws
  // as nothing: it gets a marker of its own, on its series' axis, drawn last
  // (isolatedPoints.js), and the year axis keeps the lines' range around it. With Plotly's
  // legend shown, the series and its markers share a legend group, so hiding one hides both.
  const { lines, markers, legend: legendOrder, xaxis: xClip } = withIsolatedPoints(
    series.map((s, i) => {
      const onRight = rightUnit !== undefined && s.unit === rightUnit;
      const color = resolveColor(s.color, palette[i % palette.length]);
      const name = s.bancoShort ? `${s.label} (${s.bancoShort})` : s.label;
      return {
        x: (s.data || []).map((d) => d.y),
        y: (s.data || []).map((d) => d.v),
        type: 'scatter',
        mode: 'lines',
        line: { color, width: 2.25, shape: 'linear' },
        // Series sharing a unit share an axis; the second unit overlays on yaxis2.
        yaxis: onRight ? 'y2' : 'y',
        name,
        hovertemplate: `<b>%{x}</b>  %{y:,.2f}${s.unit ? ` ${s.unit}` : ''}<extra>${name}</extra>`,
      };
    }),
    { linkLegend: showLegend },
  );
  const traces = [...lines, ...markers];

  // pt-BR magnitude ticks ("15 bi" not the SI "15G"), consistent across cards
  // (FINDING #9). Each axis covers only its own unit's series (a ratio/share axis
  // and an absolute-value axis must not share a magnitude). Falls back to `~s` when
  // an axis has no usable positive max.
  const maxForUnit = (u) =>
    seriesMax(series.filter((s) => s.unit === u).flatMap((s) => s.data || []), (d) => d.v);
  const layout = baseLayout({
    margin: { l: 56, r: 60, t: 18, b: 30 },
    showlegend: showLegend,
    legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 11 }, ...legendOrder },
    xaxis: yearAxis(xClip),
    yaxis: {
      title: { text: leftUnit || '', font: { size: 11 }, standoff: 8 },
      ...ptBrLinearAxis(maxForUnit(leftUnit)),
    },
    // Only wire the right axis when a second unit exists; it overlays the left.
    ...(rightUnit !== undefined && {
      yaxis2: {
        title: { text: rightUnit || '', font: { size: 11 }, standoff: 8 },
        ...ptBrLinearAxis(maxForUnit(rightUnit)),
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        zeroline: false,
      },
    }),
  });

  return <Plot traces={traces} layout={layout} height={height} />;
}

window.DualAxisLineChart = DualAxisLineChart;
export default DualAxisLineChart;
