// SankeyChart — Plotly sankey for a two-sided origin→dest flow. Same name +
// props as the prototype's SVG SankeyChart, so the reused views render
// <window.SankeyChart/> unchanged — now with native Plotly hover/drag.
//   nodes : [{ id, label, side:'origin'|'dest', value }]   (id is a string e.g. "o0")
//   links : [{ source, target, value }]                    (source/target are node ids)

import { Plot, baseLayout, resolveColor, vizPalette } from './_base';

function SankeyChart({ nodes = [], links = [], unit = '', height = 420, formatValue = null }) {
  // Guard empty/degenerate input — never throw, just render an empty plot.
  if (!nodes.length || !links.length) {
    return <Plot traces={[]} layout={baseLayout({ xaxis: { visible: false }, yaxis: { visible: false } })} height={height} />;
  }

  // Map each node id (string) to its positional index — Plotly sankey links
  // reference source/target by index, not by id.
  const indexOf = {};
  nodes.forEach((n, i) => { indexOf[n.id] = i; });

  // Drop dangling links (a source/target id with no matching node): an undefined
  // index makes Plotly throw, which blanks the whole card via the error fallback.
  // Filtering here degrades a dangling link to a partial diagram instead.
  const safeLinks = links.filter((l) => indexOf[l.source] != null && indexOf[l.target] != null);

  // Color origins from the categorical viz palette; dests a neutral gray (matches
  // the prototype, which painted dest rects in --pres-gray-400).
  const palette = vizPalette();
  const destColor = resolveColor('var(--pres-gray-400)');
  let originSeen = 0;
  const nodeColors = nodes.map((n) =>
    n.side === 'origin' ? palette[originSeen++ % palette.length] : destColor,
  );

  // Ribbons inherit their origin node's color (the prototype tinted each flow by
  // its source side).
  const linkColors = safeLinks.map((l) => {
    const si = indexOf[l.source];
    return si == null ? destColor : nodeColors[si];
  });

  // Hover value formatter. Callers pass an autoScaleNum-based fmt so the hover
  // shows the right magnitude: the serializer pre-scales flow values to millions,
  // so a bare "%{value}" would read 2.07 instead of "2,07 mi US$". Default keeps a
  // simple "value + unit".
  const fmtVal = formatValue || ((v) => {
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n)
      ? `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`
      : 'sem dado';
  });

  const traces = [
    {
      type: 'sankey',
      orientation: 'h',
      node: {
        label: nodes.map((n) => n.label),
        customdata: nodes.map((n) => fmtVal(n.value)),
        color: nodeColors,
        pad: 12,
        thickness: 14,
        line: { width: 0 },
        hovertemplate: '<b>%{label}</b>  %{customdata}<extra></extra>',
      },
      link: {
        source: safeLinks.map((l) => indexOf[l.source]),
        target: safeLinks.map((l) => indexOf[l.target]),
        value: safeLinks.map((l) => l.value),
        customdata: safeLinks.map((l) => fmtVal(l.value)),
        color: linkColors,
        hovertemplate:
          '%{source.label} → %{target.label}  %{customdata}<extra></extra>',
      },
    },
  ];

  // Sankey draws its own nodes/ribbons — drop the cartesian axes/gridlines.
  const layout = baseLayout({
    margin: { l: 8, r: 8, t: 8, b: 8 },
    hovermode: 'closest',
    xaxis: { visible: false },
    yaxis: { visible: false },
  });

  return <Plot traces={traces} layout={layout} height={height} />;
}

window.SankeyChart = SankeyChart;
export default SankeyChart;
