// ViewSeasonality — month × year patterns. Generic via the monthlyData
// contract (real Gold data).

// The contract (serialize_monthly) ships VALUES in MILLIONS of `data.unit`. Every card and
// chart here formats with the shared pt-BR magnitude ladder (bi/mi/mil), which reads a
// number as RAW units — so the values are converted back ONCE, here, before anything reads
// them. Until v1.77.0 they were not: US$ 3,09 mi rendered "US$ 3,09" on the cards, the
// heatmap and the Capital axis alike (the same defect ViewFlows had). Weight stays in the
// contract's `mil t`: its unit label already carries the magnitude.
//
// A `null` cell is a month the chosen convention cannot value (€ sem correção before
// 1999): it stays null — a gap in the heatmap, out of the averages server-side — because
// `Number(null) * 1e6` would draw it as a measured zero (v1.78.0).
const _MI = 1e6;
const _toRaw = (v) => (v == null ? null : (Number(v) || 0) * _MI);

function ViewSeasonality({ summary, conventions, database }) {
  const data  = window.monthlyData(database, summary);

  // Defensive guards: a real /api/monthly empty frame can ship monthlyAvg: []
  // (or fewer than 12 values). Math.max(...[]) is -Infinity and [].indexOf(...) is
  // -1, so monthlyAvg[-1] = undefined and fmt(undefined).toLocaleString throws —
  // sending the whole perspective to the error boundary instead of an honest
  // empty state. Pad to 12 zeros and clamp the indices so the math always survives.
  const avg = (Array.isArray(data.monthlyAvg) && data.monthlyAvg.length === 12
    ? data.monthlyAvg
    : Array.from({ length: 12 }, (_, m) => (data.monthlyAvg && data.monthlyAvg[m]) || 0)
  ).map((v) => _toRaw(v) || 0);
  const matrix = Object.fromEntries(
    Object.entries(data.matrix || {}).map(([y, row]) => [y, (row || []).map(_toRaw)]));
  // Volume (net weight) profile — the second seasonal metric, same 12-month shape.
  const wavg = Array.isArray(data.weightMonthlyAvg) && data.weightMonthlyAvg.length === 12
    ? data.weightMonthlyAvg
    : Array.from({ length: 12 }, (_, m) => (data.weightMonthlyAvg && data.weightMonthlyAvg[m]) || 0);
  const hasWeight = wavg.some(v => v > 0);
  const years = Array.isArray(data.years) ? data.years : [];
  const hasData = avg.some(v => v > 0);

  const peakIdx = Math.max(0, avg.indexOf(Math.max(...avg)));
  const lowIdx  = Math.max(0, avg.indexOf(Math.min(...avg)));
  // `avg[lowIdx] || 1` não protegia nada: com vale ZERO a razão virava "pico ÷ 1",
  // um múltiplo inventado do tamanho do próprio pico. Sem vale positivo não há
  // amplitude — ratioPresent devolve null e o card mostra '—'.
  const amplitude = window.ratioPresent(avg[peakIdx], avg[lowIdx]);
  const fmt = (v) => {
    if (v == null) return 'sem valor nesta convenção';
    const n = Number(v) || 0;
    const { factor, suffix } = window.autoScaleNum(n);
    const scaled = n / factor;
    return [data.unit, scaled.toLocaleString('pt-BR', { maximumFractionDigits: scaled < 10 ? 2 : scaled < 100 ? 1 : 0 }), suffix]
      .filter(Boolean).join(' ');
  };
  const yearSpan = years.length ? `${years[0]}–${years[years.length - 1]}` : '—';

  if (!hasData) {
    return (
      <>
        <window.NotApplicableNote note={data.notApplicable} />
        {/* A failed fetch also lands here (empty data) — show the honest error instead of
            claiming "sem dados sazonais", which would be a false analytical statement. */}
        <window.LoadErrorNote error={data.loadError} />
        {!data.loadError && (
          <div className="card subtle">
            <window.SectionHeader overline="Mapa de calor · mês × ano" title="Sem dados sazonais para esta seleção" />
            <p className="caption" style={{ padding: '16px 4px' }}>
              Não há série mensal disponível para o banco e os filtros atuais. Ajuste o período ou a
              cesta de produtos, ou selecione um banco com granularidade mensal.
            </p>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {/* The seasonality mart collapses the UF away, so an origin-UF filter cannot
          narrow it on any banco — say so honestly above the (unfiltered) charts. */}
      <window.NotApplicableNote note={data.notApplicable} />

      <div className="kpi-row">
        <window.KpiCardSpark label="Mês de pico" value={window.MONTH_LABELS[peakIdx]} sub={fmt(avg[peakIdx]) + ' (média)'} />
        <window.KpiCardSpark label="Mês de vale" value={window.MONTH_LABELS[lowIdx]} sub={fmt(avg[lowIdx]) + ' (média)'} />
        <window.KpiCardSpark label="Amplitude sazonal" value={amplitude == null ? '—' : '×' + window.numBR(amplitude, 2)} sub="pico ÷ vale" />
        <window.KpiCardSpark label="Cobertura" value={years.length + ' anos'} sub={yearSpan} />
      </div>

      <div className="card">
        {/* A convenção que o número REALMENTE carrega, dita pelo servidor — inclusive
            quando a base mensal ainda não tem a correção escolhida e o servidor serve o
            nominal: o rótulo diz isso, em vez de a tela afirmar uma correção que não houve. */}
        <window.SectionHeader
          overline="Mapa de calor · mês × ano"
          title="Padrão sazonal ao longo dos anos"
          action={<span className="caption season-valuation">{data.valueLabel || data.unit}</span>}
        />
        <window.ValueGapNote gap={data.valueGap} unit={data.unit} alvo="médias" />
        <window.MonthYearHeatmap matrix={matrix} years={years} unit={data.unit} formatValue={fmt} />
      </div>

      <div className="card">
        <window.SectionHeader
          overline="Perfil sazonal médio"
          title="Média de cada mês no período"
          action={<span className="caption">{hasWeight ? `Volume (${data.weightUnit || 'mil t'}) · Capital (${data.unit})` : data.unit}</span>}
        />
        {hasWeight ? (
          <>
            {/* Dual metric: Volume (peso) on the left axis, Capital on the right — the
                two move together but on very different scales. */}
            <window.DualAxisLineChart
              height={300}
              showLegend={false}
              series={[
                { label: 'Volume', color: 'var(--viz-3)', unit: data.weightUnit || 'mil t',
                  data: wavg.map((v, m) => ({ y: window.MONTH_LABELS[m], v })) },
                { label: 'Capital', color: 'var(--viz-2)', unit: data.unit || 'US$',
                  data: avg.map((v, m) => ({ y: window.MONTH_LABELS[m], v })) },
              ]}
            />
            <div className="pc-legend">
              <span className="pc-legend-item"><span className="pc-legend-dot" style={{ background: 'var(--viz-3)' }}></span>Volume ({data.weightUnit || 'mil t'})</span>
              <span className="pc-legend-item"><span className="pc-legend-dot" style={{ background: 'var(--viz-2)' }}></span>Capital ({data.unit})</span>
            </div>
          </>
        ) : (
          <window.BarChart
            data={avg.map((v, m) => ({ name: window.MONTH_LABELS[m], value: v }))}
            valueKey="value" color="var(--viz-3)" height={300} />
        )}
      </div>
    </>
  );
}

window.ViewSeasonality = ViewSeasonality;
