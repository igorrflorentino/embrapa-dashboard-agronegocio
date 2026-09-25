// YoYBars — Plotly signed bars for year-over-year % variation. Same name + props
// as the prototype's SVG YoYBars, so the reused views render <window.YoYBars/>
// unchanged — but now with zoom/pan/hover (the point of the Plotly migration).
//   data: [{ y, [valueKey] }]

import { Plot, baseLayout, resolveColor, cssVar, yearAxis } from './_base';

// `breaks`: the currency-reform years of the active convention (window.valueEraBreaksFor),
// empty for a deflated or foreign-currency value.
function YoYBars({ data = [], valueKey = 'v', height = 200, breaks = [] }) {
  // Empty/degenerate input → empty plot, never throw.
  if (!data || data.length === 0) {
    return <Plot traces={[]} layout={baseLayout()} height={height} />;
  }

  // YoY % change, or null (no bar) when the question has no answer: the previous year
  // is absent or non-positive, the two points are not consecutive years (a two-year
  // change is not annual), or, in nominal R$, the pair crosses a currency reform
  // (window.deltaPctIn). This used to answer 0% for an absent base ("did not change")
  // and (null − prev) / prev = −100% for an absent year, a fall nobody measured.
  const yoy = data.map((d, i) => {
    const p = i === 0 ? null : data[i - 1];
    if (!p || d.y - p.y !== 1) return { y: d.y, pct: null };
    return {
      y: d.y,
      pct: window.deltaPctIn({ y: p.y, v: p[valueKey] }, { y: d.y, v: d[valueKey] }, breaks),
    };
  });

  // Skip the first point (no prior year to compare against), matching the design system.
  const bars = yoy.slice(1);

  // deltaColor, not `pct >= 0 ? ok : err`: `null >= 0` is true, so an absent change came
  // out green. A null bar draws nothing, but the colour rule is the same everywhere.
  const traces = [
    {
      x: bars.map((d) => d.y),
      y: bars.map((d) => d.pct),
      type: 'bar',
      marker: { color: bars.map((d) => resolveColor(window.deltaColor(d.pct))), opacity: 0.85 },
      // NB: no `+` sign flag — Plotly's hovertemplate number parser silently fails
      // on `%{y:+,.2f}` (it can't handle the d3 sign flag here) and dumps the RAW
      // unrounded value ("36.42796761118921%"). `,.2f` rounds correctly; the bar
      // colour (green/red) already conveys the +/- direction (audit HOVER-2).
      hovertemplate: '<b>%{x}</b>  %{y:,.2f}%<extra></extra>',
      name: 'Variação anual',
    },
  ];

  const layout = baseLayout({
    margin: { l: 56, r: 12, t: 18, b: 28 },
    yaxis: {
      title: { text: 'Variação anual (%)', font: { size: 11 }, standoff: 8 },
      ticksuffix: '%',
      zeroline: true,
      zerolinecolor: cssVar('--pres-gray-200', '#ECECEC'),
    },
    xaxis: yearAxis(),
  });

  return <Plot traces={traces} layout={layout} height={height} />;
}

window.YoYBars = YoYBars;
export default YoYBars;
