// ViewCrossSource — the "Cruzamento entre fontes" perspective.
// Compares 2–4 annual series drawn from DIFFERENT bancos on a shared time
// axis. All data flows through window.crossSeries (src/data/producers.js); this
// component only orchestrates selection, the visualization toggle and the
// derived analytics. Controlled via { value, onChange } so the selection
// travels in the shared URL / citation (see src/main.jsx + AppShell).

// Default landing selection — the flagship cross-source question:
// IBGE annual production value × MDIC annual export value.
window.DEFAULT_CROSS_STATE = {
  series: [
    { b: 'ibge_pevs', m: 'prod_value' },
    { b: 'mdic_comex', m: 'exp_value' },
  ],
  mode: 'base100',   // 'base100' | 'dual' | 'panels'
  y0: null,          // null → use the common comparable window
  y1: null,
};

const CS_COLORS = ['var(--viz-1)', 'var(--viz-3)', 'var(--viz-9)', 'var(--viz-10)'];
const CS_MAX = 4;

function ViewCrossSource({ value, onChange }) {
  const cs = value || window.DEFAULT_CROSS_STATE;
  const set = (patch) => onChange && onChange({ ...cs, ...patch });

  // Per-UF scoping (ephemeral, local — the cross views have no global filter bar).
  // '' = Brasil (national). Only the UF-capable series (IBGE PEVS, MDIC COMEX)
  // honour it; a COMTRADE series stays national (noted near the chart).
  const [uf, setUf] = React.useState('');
  const ufStates = uf ? [uf] : undefined;

  const refs = cs.series || [];
  const refKey = (r) => r.b + ':' + r.m;
  const selectedKeys = refs.map(refKey);

  // Common comparable window (intersection of coverages) + union bounds.
  const common = window.crossCommonWindow(refs.map(r => ({ banco: r.b, metric: r.m })));
  const clamp = (y) => Math.min(common.y1, Math.max(common.y0, y));
  const effY0 = clamp(cs.y0 || common.y0);
  const effY1 = clamp(cs.y1 || common.y1);
  const yearOpts = [];
  for (let y = common.y0; y <= common.y1; y++) yearOpts.push(y);

  // Resolve each selected ref to an aligned series within the window.
  const seriesResults = refs
    .map((r, i) => {
      const s = window.crossSeries(r.b, r.m, { y0: effY0, y1: effY1, states: ufStates });
      if (!s) return null;
      return { ...s, color: CS_COLORS[i % CS_COLORS.length], bancoShort: s.bancoMeta.short };
    })
    .filter(Boolean);

  const units = [...new Set(seriesResults.map(s => s.unit))];
  const families = [...new Set(seriesResults.map(s => s.family))];
  // Any selected series whose /api/cross/series fetch FAILED (settled error) → surface it
  // instead of plotting an empty line as legitimate "sem sobreposição".
  const anyLoadError = seriesResults.some((s) => s.loadError);

  // ── Toggle a (banco, metric) ref in/out of the selection ──────────────
  const toggleRef = (b, m) => {
    const k = b + ':' + m;
    const exists = selectedKeys.includes(k);
    let next;
    if (exists) {
      if (refs.length <= 1) return;       // keep at least one series
      next = refs.filter(r => refKey(r) !== k);
    } else {
      if (refs.length >= CS_MAX) return;  // cap at 4
      next = [...refs, { b, m }];
    }
    // New selection ⇒ let the window recompute from the new overlap.
    set({ series: next, y0: null, y1: null });
  };

  // ── Per-series metrics (variação acumulada, CAGR) ─────────────────────
  const items = seriesResults.map(s => {
    const pts = s.points;
    const v0 = pts[0]?.v || 0, vT = pts[pts.length - 1]?.v || 0;
    return { ...s, v0, vT, cagr: window.cagrPct(v0, vT, window.spanYears(pts)), accum: window.accumPct(v0, vT) };
  });

  // ── Pairwise correlation on YoY growth, aligned BY YEAR (point.y), not array
  //    index — a series with an internal year gap would otherwise correlate
  //    misaligned years (shared helpers · seriesUtils.js). ─
  const corr = items.map(a => items.map(b => window.pearsonByYear(a.points, b.points)));
  const corrColor = window.corrColor;

  // ── Ratio panel: only when exactly 2 series share an identical unit ───
  const ratioEligible = items.length === 2 && items[0].unit === items[1].unit;
  // Pair the two series BY YEAR (not array index): align on the years both cover,
  // so an internal gap in either series cannot shift the ratio onto wrong years.
  const ratioSeries = ratioEligible
    ? (() => {
        const num = new Map(items[1].points.map(d => [d.y, d.v]));
        return items[0].points
          .filter(d => num.has(d.y))
          // `(num || 0) / (d.v || 1)` era pior que achatar: com denominador ausente
          // dividia por UM e fabricava um PICO do tamanho do numerador ×100 — um sinal
          // inventado, com cara de descoberta. ratioPresent recusa e vira lacuna.
          .map(d => ({ y: d.y, v: window.scalePresent(window.ratioPresent(num.get(d.y), d.v), 100) }));
      })()
    : null;
  // A média da razão ignora os anos sem razão definida (null): somá-los como 0 puxaria
  // a média para baixo com anos que ninguém mediu.
  const ratioMean = ratioSeries ? window.meanPresent(ratioSeries.map(d => d.v)) : null;

  // ── Chart series in the shape each chart expects ──────────────────────
  // Ano-base COMUM às séries exibidas (ver seriesUtils.commonBaseYear): indexar cada
  // uma pelo seu próprio primeiro ponto achatava tudo em zero quando esse ponto faltava.
  const csBaseYear = window.commonBaseYear(items.map(it => it.points));
  const base100 = items.map(it => ({
    name: `${it.label} · ${it.bancoShort}`,
    color: it.color,
    data: window.indexTo100(it.points, csBaseYear),
  }));
  const axisSeries = items.map(it => ({
    label: it.label, color: it.color, unit: it.unit, bancoShort: it.bancoShort, data: it.points,
  }));

  const MODES = [
    { id: 'base100', label: 'Base 100' },
    { id: 'dual', label: 'Eixo duplo' },
    { id: 'panels', label: 'Painéis' },
  ];
  const mode = cs.mode || 'base100';
  const dualTooManyUnits = mode === 'dual' && units.length > 2;

  const fmtV = (v, unit) => (v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 2 : v < 1000 ? 1 : 0 }) + ' ' + unit);

  return (
    <>
      <window.LoadErrorNote error={anyLoadError} />
      {/* KPI strip */}
      <div className="kpi-row">
        <window.KpiCardSpark label="Séries comparadas" value={`${items.length} / ${CS_MAX}`}
          sub={`de ${new Set(items.map(i => i.banco)).size} ${new Set(items.map(i => i.banco)).size === 1 ? 'banco' : 'bancos'}`} />
        <window.KpiCardSpark label="Janela comparável" value={`${effY0}–${effY1}`}
          sub={`fontes cobrem ${common.union[0]}–${common.union[1]}`} />
        <window.KpiCardSpark label="Famílias de unidade" value={families.length}
          sub={families.map(f => window.METRIC_FAMILIES[f]?.label || f).join(' · ')} />
        <window.KpiCardSpark label={ratioEligible ? 'Razão média (par)' : 'Correlação (par principal)'}
          value={ratioEligible ? window.pctBR(ratioMean, 1) : (items.length >= 2 ? corr[0][1].toFixed(2).replace('.', ',') : '—')}
          sub={ratioEligible ? `${items[1].label} ÷ ${items[0].label}` : 'variação interanual'} />
      </div>

      {/* Series picker */}
      <div className="card">
        <window.SectionHeader
          overline="Montagem do cruzamento"
          title="Selecione as séries a comparar"
          action={<span className="caption">{items.length} de {CS_MAX} · mín. 1</span>}
        />
        <div className="xs-picker">
          {/* Only bancos that can actually contribute a comparable series: a banco with
              NO metrics (e.g. PAM — not cross-wired) is hidden entirely; a banco with
              metrics but no data yet (e.g. SEFAZ, planejado) keeps its card but its chips
              are disabled — the user only picks what they can really compare. */}
          {(window.visibleBancos ? window.visibleBancos() : (window.BANCOS || []))
            .filter(b => (b.metrics || []).length)
            .map(b => {
            const bancoHasData = window.maturityMeta ? window.maturityMeta(b).hasData : b.status === 'live';
            return (
            <div key={b.id} className="xs-bank">
              <div className="xs-bank-head">
                <window.Icon name="database" size={14} />
                <span className="xs-bank-short">{b.short}</span>
                {!bancoHasData && <span className="xs-bank-tag">{window.bancoAvailability(b)}</span>}
              </div>
              <div className="xs-bank-metrics">
                {(b.metrics || []).map(m => {
                  const k = b.id + ':' + m.id;
                  const on = selectedKeys.includes(k);
                  const idx = selectedKeys.indexOf(k);
                  const atCap = !on && refs.length >= CS_MAX;
                  const blocked = !bancoHasData;        // no data yet → not pickable
                  const dis = atCap || blocked;
                  return (
                    <button key={k}
                      className={'xs-chip' + (on ? ' on' : '') + (dis ? ' disabled' : '')}
                      disabled={blocked}
                      onClick={() => !dis && toggleRef(b.id, m.id)}
                      style={on ? { background: CS_COLORS[idx % CS_COLORS.length], borderColor: CS_COLORS[idx % CS_COLORS.length], color: '#fff' } : null}
                      title={blocked
                        ? `${b.short} ainda não tem dados — disponível quando o banco for liberado.`
                        : `${m.agg} · ${window.METRIC_FAMILIES[m.family]?.label || m.family}`}>
                      <span className="xs-chip-label">{m.label}</span>
                      <span className="xs-chip-unit tnum">{blocked ? m.unit : (window.crossSeries(b.id, m.id, {})?.unit || m.unit)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {/* Overlay chart + controls */}
      <div className="card">
        <window.SectionHeader
          overline="Sobreposição no tempo"
          title="Evolução histórica comparada"
          action={
            <div className="xs-controls">
              <window.UfScopePicker value={uf} onChange={setUf} />
              <div className="xs-years">
                <select className="xs-select" value={effY0} aria-label="Ano inicial"
                  onChange={(e) => set({ y0: Math.min(Number(e.target.value), effY1) })}>
                  {yearOpts.filter(y => y <= effY1).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <span className="xs-years-sep">→</span>
                <select className="xs-select" value={effY1} aria-label="Ano final"
                  onChange={(e) => set({ y1: Math.max(Number(e.target.value), effY0) })}>
                  {yearOpts.filter(y => y >= effY0).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="seg xs-seg">
                {MODES.map(o => {
                  // 'Eixo duplo' can only render with ≤2 distinct unit families; disable it
                  // (with a reason) when the selection spans more, instead of offering a mode
                  // that would draw nothing.
                  const incompatible = o.id === 'dual' && units.length > 2;
                  return (
                    <button key={o.id}
                      className={'seg-opt ' + (mode === o.id ? 'on' : '') + (incompatible ? ' disabled' : '')}
                      disabled={incompatible}
                      title={incompatible ? 'Eixo duplo exige no máximo 2 famílias de unidade entre as séries selecionadas.' : undefined}
                      onClick={() => !incompatible && set({ mode: o.id })}>{o.label}</button>
                  );
                })}
              </div>
            </div>
          }
        />

        <div className="xs-mode-note">
          {mode === 'base100' && (csBaseYear
            ? <>Cada série reindexada a <strong>100 em {csBaseYear}</strong> — compara trajetórias independentemente da unidade ({units.join(' · ')}).</>
            : <>Não há ano em que <strong>todas</strong> as séries tenham medida, então não existe base 100 comparável entre elas.</>)}
          {mode === 'dual' && !dualTooManyUnits && <>Cada unidade no seu próprio eixo: <strong>{units[0]}</strong> à esquerda{units[1] ? <> · <strong>{units[1]}</strong> à direita</> : ''}. Escalas independentes — compare formato, não nível.</>}
          {mode === 'dual' && dualTooManyUnits && <>Eixo duplo comporta 2 unidades; a seleção tem {units.length} ({units.join(' · ')}). Use <strong>Base 100</strong> ou <strong>Painéis</strong> para ver todas com fidelidade.</>}
          {mode === 'panels' && <>Um painel por série, alinhados no eixo de tempo — leitura fiel das unidades nativas, sem forçar escala comum.</>}
        </div>

        {uf && refs.some(r => r.b === 'un_comtrade') && (
          <div className="xs-mode-note">
            <strong>Nota:</strong> séries do <strong>UN Comtrade</strong> são por país de origem — o
            recorte por UF não se aplica a elas, que permanecem nacionais ({uf} afeta só IBGE/MDIC).
          </div>
        )}

        {mode === 'base100' && <window.MultiLineChart series={base100} label={`índice (${csBaseYear ?? '—'}=100)`} valueKey="v" height={320} trend showLegend={false} />}
        {mode === 'dual' && <window.DualAxisLineChart series={axisSeries} height={320} showLegend={false} />}
        {mode === 'panels' && <window.StackedPanels series={axisSeries} />}

        <div className="xs-legend">
          {items.map(it => (
            <span key={it.key} className="xs-legend-item">
              <span className="xs-legend-dot" style={{ background: it.color }}></span>
              <strong>{it.label}</strong>
              <span className="xs-legend-src">{it.bancoShort} · {it.unit}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Comparative metrics */}
      <div className="card">
        <window.SectionHeader
          overline={`Métricas comparativas · ${effY0}–${effY1}`}
          title="Crescimento de cada série na janela"
        />
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th>Série</th>
                <th>Fonte</th>
                <th className="num">{effY0}</th>
                <th className="num">{effY1}</th>
                <th className="num">Variação acumulada</th>
                <th className="num">CAGR (a.a.)</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.key}>
                  <td><span className="pc-row-dot" style={{ background: it.color }}></span>{it.label}</td>
                  <td>{it.bancoShort}</td>
                  <td className="num tnum">{fmtV(it.v0, it.unit)}</td>
                  <td className="num tnum">{fmtV(it.vT, it.unit)}</td>
                  <td className="num tnum" style={{ color: it.accum >= 0 ? 'var(--ok)' : 'var(--err)' }}>{window.fmtSigned(it.accum, 0)}</td>
                  <td className="num tnum" style={{ color: it.cagr >= 0 ? 'var(--ok)' : 'var(--err)' }}>{window.fmtSigned(it.cagr, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Ratio / coefficient panel — same unit, exactly 2 series */}
      {ratioEligible && (
        <div className="card">
          <window.SectionHeader
            overline="Razão entre séries"
            title={`${items[1].label} como % de ${items[0].label}`}
            action={<span className="caption">média {ratioMean.toFixed(1).replace('.', ',')}%</span>}
          />
          <window.MultiLineChart
            series={[{ name: 'razão (%)', color: 'var(--embrapa-blue)', data: ratioSeries }]}
            label="%" valueKey="v" height={240} />
          <p className="caption xs-ratio-note">
            Ambas as séries estão em <strong>{items[0].unit}</strong>, então a razão é direta.
            Quando uma fonte é produção e a outra exportação, esta curva é o
            <strong> coeficiente de exportação</strong> — quanto do produzido seguiu para fora.
          </p>
        </div>
      )}

      {/* Correlation matrix — 2+ series */}
      {items.length >= 2 && (
        <div className="card">
          <window.SectionHeader
            overline="Correlação cruzada · variação interanual"
            title="Quão sincronizadas são as fontes"
            action={<span className="caption">Pearson · −1 a +1</span>}
          />
          <div className="pc-corr-wrap">
            <table className="pc-corr">
              <thead>
                <tr>
                  <th></th>
                  {items.map(it => (
                    <th key={it.key} title={`${it.label} · ${it.bancoShort}`}>
                      <span className="pc-corr-dot" style={{ background: it.color }}></span>{it.bancoShort}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((rowIt, i) => (
                  <tr key={rowIt.key}>
                    <th title={`${rowIt.label} · ${rowIt.bancoShort}`}>
                      <span className="pc-corr-dot" style={{ background: rowIt.color }}></span>{rowIt.label}
                    </th>
                    {items.map((colIt, j) => {
                      const r = corr[i][j];
                      return (
                        <td key={colIt.key} className="tnum"
                          style={{ background: i === j ? 'var(--bg-surface-2)' : corrColor(r), color: Number.isFinite(r) && Math.abs(r) > 0.6 ? '#fff' : 'var(--fg-1)' }}>
                          {/* `r` é null quando não há base para correlacionar (menos de dois
                              pares comparáveis, ou variância zero num dos lados). "0,00" ali
                              afirmava descorrelação perfeita sobre um único ponto. */}
                          {i === j || !Number.isFinite(r) ? '—' : r.toFixed(2).replace('.', ',')}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="caption pc-corr-note">
              Verde: fontes que sobem e descem juntas no mesmo ano. Vermelho: movimentos opostos.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

window.ViewCrossSource = ViewCrossSource;
