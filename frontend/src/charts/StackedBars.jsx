// StackedBars — barras horizontais empilhadas em valor ABSOLUTO (uma barra por
// categoria, uma faixa por série). Irmã de FlagBars, que empilha a 100%
// (`barnorm: 'fraction'`): lá a pergunta é a COMPOSIÇÃO e todas as barras têm o
// mesmo comprimento; aqui a composição E a magnitude importam juntas, e normalizar
// apagaria metade da resposta — o Pará com 11.218 mil t de açaí e o Rio com 8 t
// virariam duas barras idênticas.
//   rows:   [{ [labelKey], name, <serieId>: número }]
//   series: [{ id, label, color }]
//
// O total de cada barra é a soma das faixas, então o eixo x é o mesmo do valor que
// a tela mostra ao lado — nunca uma fração.

import { Plot, baseLayout, ptBrLinearAxis, resolveColor } from './_base';

function StackedBars({
  rows = [],
  series = [],
  labelKey = 'uf',
  label = '',
  height,
  showLegend = true,
}) {
  const cats = rows.map((r) => r[labelKey] ?? r.uf ?? r.code ?? r.name ?? '');
  const H = height || Math.max(140, 20 + rows.length * 26 + 40);

  if (rows.length === 0 || series.length === 0) {
    return <Plot traces={[]} layout={baseLayout()} height={H} />;
  }

  // O máximo é o do TOTAL de cada barra (soma das faixas), não o da maior faixa —
  // um eixo dimensionado pela faixa deixaria a barra empilhada estourar a área.
  const totalMax = Math.max(
    0,
    ...rows.map((r) => series.reduce((s, f) => s + (Number(r[f.id]) || 0), 0)),
  );

  const traces = series.map((f) => ({
    type: 'bar',
    orientation: 'h',
    name: f.label,
    y: cats,
    // `|| 0` aqui é a ausência de uma FAIXA numa barra cuja outra faixa existe: um
    // estado que só extrai tem lavoura zero MEDIDA, não desconhecida. A recusa vive
    // uma camada acima — quem não tem produção nenhuma não vira linha.
    x: rows.map((r) => Number(r[f.id]) || 0),
    marker: { color: resolveColor(f.color) },
    hovertemplate: `<b>%{y}</b> · ${f.label}: %{x:,.2f}<extra></extra>`,
  }));

  const layout = baseLayout({
    barmode: 'stack',
    hovermode: 'closest',
    showlegend: showLegend,
    legend: { orientation: 'h', y: -0.16, x: 0, font: { size: 11 } },
    margin: { l: 60, r: 20, t: 8, b: 44 },
    xaxis: {
      title: { text: label, font: { size: 11 }, standoff: 8 },
      rangemode: 'tozero',
      ...ptBrLinearAxis(totalMax),
    },
    yaxis: { autorange: 'reversed', automargin: true, tickfont: { size: 11 } },
  });

  return <Plot traces={traces} layout={layout} height={H} />;
}

window.StackedBars = StackedBars;
export default StackedBars;
