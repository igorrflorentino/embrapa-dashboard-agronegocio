// ViewFlows — territorial flows (origin → destination). Generic across
// MDIC / SEFAZ / UN Comtrade via the flowData contract (real Gold data).

function ViewFlows({ summary, conventions, database }) {
  const banco = window.bancoById(database);
  const data  = window.flowData(database, summary);
  const totalOut = data.nodes.filter(n => n.side === 'origin').reduce((s, n) => s + n.value, 0);
  const topOrigin = data.nodes.filter(n => n.side === 'origin').sort((a, b) => b.value - a.value)[0];
  const topDest   = data.nodes.filter(n => n.side === 'dest').sort((a, b) => b.value - a.value)[0];

  // Magnitude + pt-BR suffix come from the shared autoScaleNum helper (the same
  // one the migrated charts/views use) keyed off the REAL value. The contract
  // (serialize_flow) ships link/node values in MILLIONS of `data.unit`, so the value is
  // converted back before scaling. The earlier fix (M9) scaled the millions figure
  // itself: US$ 77,6 mi (Acre → Peru) rendered "US$ 77,6", and its fixtures were raw
  // US$, which is why it passed. The unit prefix is the contract's display unit; the
  // suffix (bi/mi/mil) stays pt-BR.
  const fmt = (v) => {
    const n = (Number(v) || 0) * 1e6; // contract unit: mi → raw
    const { factor, suffix } = window.autoScaleNum(n);
    const scaled = n / factor;
    const txt = scaled.toLocaleString('pt-BR', {
      maximumFractionDigits: scaled < 10 ? 2 : scaled < 100 ? 1 : 0,
    });
    return [data.unit, txt, suffix].filter(Boolean).join(' ');
  };

  return (
    <>
      {/* Honest note when a filter the flow grain cannot honour is active (e.g. the
          origin-UF filter on a country-origin banco like Comtrade). The data layer
          already withholds the param; this surfaces WHY the charts are unchanged. */}
      <window.NotApplicableNote note={data.notApplicable} />
      <window.LoadErrorNote error={data.loadError} />

      <div className="kpi-row">
        <window.KpiCardSpark label="Fluxo total" value={fmt(totalOut)} sub={`${data.links.length} rotas mapeadas`} />
        <window.KpiCardSpark label={`Maior origem · ${data.originLabel}`} value={topOrigin?.label || '—'} sub={fmt(topOrigin?.value || 0)} />
        <window.KpiCardSpark label={`Maior destino · ${data.destLabel}`} value={topDest?.label || '—'} sub={fmt(topDest?.value || 0)} />
        <window.KpiCardSpark label="Abrangência geográfica" value={banco?.scope || '—'} sub={banco?.domain || ''} />
      </div>

      <div className="card">
        {/* A convenção que o número REALMENTE carrega, dita pelo servidor. Até a v1.77.0
            este canto dizia só "US$" e a soma era nominal sob qualquer escolha da faixa
            de convenções. */}
        <window.SectionHeader
          overline={`Diagrama de fluxo · ${data.originLabel} → ${data.destLabel}`}
          title="Para onde a produção vai"
          action={<span className="caption flow-valuation">{data.valueLabel || data.unit}</span>}
        />
        <window.SankeyChart nodes={data.nodes} links={data.links} unit={data.unit} formatValue={fmt} height={380} />
      </div>

      <div className="card">
        <window.SectionHeader
          overline="Rotas principais"
          title={`Maiores fluxos ${data.originLabel} → ${data.destLabel}`}
        />
        <div className="flow-routes">
          {data.links.slice().sort((a, b) => b.value - a.value).slice(0, 8).map((l, i) => {
            const o = data.nodes.find(n => n.id === l.source);
            const d = data.nodes.find(n => n.id === l.target);
            const max = Math.max(...data.links.map(x => x.value));
            return (
              <div key={i} className="flow-route">
                <span className="flow-route-od">{o?.label} <span className="flow-arrow">→</span> {d?.label}</span>
                <div className="flow-route-bar"><div style={{ width: (l.value / max * 100) + '%' }}></div></div>
                <span className="flow-route-val tnum">{fmt(l.value)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

window.ViewFlows = ViewFlows;
