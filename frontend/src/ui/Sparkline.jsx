// Sparkline + KpiCardSpark — small KPI primitives shared by the data views.
// Extracted from the original MainScreen so all <ViewX> files can use them.

function Sparkline({ data, color = 'var(--viz-1)', valueKey = 'v', width = 120, height = 32 }) {
  const ys = data.map(d => d[valueKey]);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const x = i => (i / (data.length - 1)) * (width - 2) + 1;
  const y = v => height - 2 - ((v - min) / span) * (height - 4);
  const pts = data.map((d, i) => `${x(i)},${y(d[valueKey])}`).join(' ');
  const area = `1,${height - 1} ${pts} ${width - 1},${height - 1}`;
  const last = data[data.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: 'block' }}>
      <polygon points={area} fill={color} opacity="0.10" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={x(data.length - 1)} cy={y(last[valueKey])} r="2.2" fill={color} />
    </svg>
  );
}

function KpiCardSpark({ label, value, sub, delta, deltaPositive, spark, sparkColor, sparkKey = 'v' }) {
  return (
    <div className="kpi-card spark">
      <div className="kpi-top">
        <div className="kpi-ov">{label}</div>
        {spark && spark.length > 1 && <Sparkline data={spark} color={sparkColor} valueKey={sparkKey} />}
      </div>
      <div className="kpi-val tnum">{value}</div>
      <div className="kpi-sub">
        {delta != null && (
          // TRÊS estados, não dois. `fmtSigned(null)` devolve '—' — uma STRING, não
          // null — então a seta renderiza; e `null >= 0` é true em JS, então a
          // variação que não existe vinha pintada de verde com seta para cima, ao
          // lado do próprio travessão que a declara ausente. Um `deltaPositive`
          // nulo agora é neutro e sem seta: a ausência não afirma direção.
          <span className={'kpi-delta ' + (deltaPositive == null ? 'none' : deltaPositive ? 'up' : 'down')}>
            {deltaPositive != null && (
              <window.Icon name={deltaPositive ? 'arrow_upward' : 'arrow_downward'} size={12} />
            )}
            {delta}
          </span>
        )}
        <span>{sub}</span>
      </div>
    </div>
  );
}

Object.assign(window, { Sparkline, KpiCardSpark });
