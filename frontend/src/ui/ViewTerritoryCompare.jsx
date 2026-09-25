// ViewTerritoryCompare — put up to 8 territórios side by side, at any mix of levels
// (região, estado, município). The data layer is territoryCompare.js; this file is the
// screen: the pickers, the chart, the table and the correlation matrix.
//
// The places are chosen HERE, not in the geography filter (see territoryCompare.js for
// why). The selection lives in main.jsx's state and travels in the URL (`tc`, `tm`, `tx`),
// so a reload or a shared link reopens the same comparison.

const { useState: useTCState, useMemo: useTCMemo } = React;

const TC_COLORS = [
  'var(--viz-1)', 'var(--viz-3)', 'var(--viz-5)', 'var(--viz-7)',
  'var(--viz-2)', 'var(--viz-4)', 'var(--viz-6)', 'var(--viz-8)',
];

// The chart's unit for each metric, in the cube's own units (see territoryCompare.FIELD).
const tcUnit = (metric, conv) => {
  if (metric === 'mass') return 'mil t';
  if (metric === 'volume') return 'mi m³';
  if (metric === 'count') return 'mi un';
  const sym = ((window.CURRENCY_FX || {})[conv.currency] || {}).symbol || conv.currency;
  return `${sym} milhões`;
};

// One formatter per metric for the table, reusing the app's own (they render absence as '—').
const tcFormat = (metric, v, conv) => {
  if (metric === 'mass') return window.formatMassQty(v, conv);
  if (metric === 'volume') return window.formatVolumeQty(v, conv);
  if (metric === 'count') return window.formatCountQty(v, conv);
  return window.formatValue(window.scalePresent(v, 1e6), conv);
};

const TC_METRIC_LABEL = { value: 'Valor', mass: 'Quantidade (massa)', volume: 'Quantidade (volume)', count: 'Contagem' };

function ViewTerritoryCompare({ summary, conventions, database, territoryCompare, setTerritoryCompare }) {
  const conv = conventions || window.DEFAULT_CONVENTIONS;
  const tc = window.territoryCompare;
  const MAX = window.TERRITORY_COMPARE_MAX || 8;
  const state = territoryCompare || {};
  const setState = (patch) => setTerritoryCompare && setTerritoryCompare({ ...state, ...patch });

  // Metric options: value always, plus the quantity families the basket actually carries
  // (summing tonnes with cubic metres is refused everywhere else in the app, and here too).
  const families = (window.familiesInBasket ? window.familiesInBasket(summary && summary.basket, database) : []) || [];
  const metricOptions = ['value', ...['mass', 'volume', 'count'].filter((m) => families.includes(m))];
  const metric = metricOptions.includes(state.metric) ? state.metric : 'value';
  const mode = state.mode === 'index' ? 'index' : 'abs';

  // Default selection: the three largest states by the latest value, shown but NOT written
  // to the state until the researcher changes something — the same courtesy the product
  // comparison gives. `items: []` (cleared on purpose) is respected as empty.
  // (territoryCompare.selectionOf; the default is only computed while no choice exists.)
  const selection = tc.selectionOf(state, database, summary);
  const setSelection = (items) => setState({ items });
  const has = (t) => selection.some((s) => s.level === t.level && String(s.code) === String(t.code));
  const add = (t) => { if (!has(t) && selection.length < MAX) setSelection([...selection, t]); };
  const remove = (t) => setSelection(selection.filter((s) => !(s.level === t.level && String(s.code) === String(t.code))));

  const data = tc.build({ database, summary, selection, metric });
  const items = data.items.map((it, i) => ({ ...it, color: TC_COLORS[i % TC_COLORS.length] }));
  const ready = items.filter((it) => !it.loading && !it.unavailable);

  // ── Series, index base and metrics (same primitives as the product comparison) ──────
  const firstYear = data.years.length ? data.years[0] : null;
  const lastYear = data.years.length ? data.years[data.years.length - 1] : null;
  // Nominal R$ across a currency reform compares two currencies: 1986 is in cruzados,
  // 2024 in reais, and the ratio between them came out as +3.265.734.304.470% on PEVS.
  // Everything that needs a base year (index, accumulated change, growth, correlation)
  // starts in the current currency instead, and the screen says so. Quantities have no
  // currency, and a deflated or foreign-currency convention sends no breaks.
  const breaks = metric === 'value' && window.valueEraBreaksFor ? window.valueEraBreaksFor(database) : [];
  const eraStart = window.currentEraStart(firstYear, lastYear, breaks);
  const inEra = (pts) => (eraStart == null ? pts : pts.filter((d) => d.y >= eraStart));
  const baseYear = window.commonBaseYear(ready.map((it) => inEra(it.points)));
  const series = ready.map((it) => ({
    name: it.label,
    color: it.color,
    data: mode === 'index' ? window.indexTo100(inEra(it.points), baseYear) : it.points,
  }));
  const brasilLast = (data.brasil.find((d) => d.y === lastYear) || {}).v;
  // A monthly banco's current year is incomplete (COMEX in September covers 8 months).
  // Same rule as the Overview (window.anoParcial): the numbers keep the selected window,
  // latest year included, and the screen MARKS that year and says the comparison is not
  // direct. The share is unaffected: every território covers the same months.
  const parcial = window.anoParcial(database, lastYear);
  const partialLatest = !!parcial;
  const monthsLatest = parcial ? parcial.meses : null;
  ready.forEach((it) => {
    const pT = it.points.find((d) => d.y === lastYear) || null;
    const p0 = baseYear != null ? it.points.find((d) => d.y === baseYear) || null : null;
    it.vT = pT ? pT.v : null;
    it.accum = window.accumPct(p0 ? p0.v : null, it.vT);
    it.cagr = window.cagrPct(p0 ? p0.v : null, it.vT, pT && p0 ? (pT.y - p0.y) || 1 : 1);
    it.share = window.scalePresent(window.ratioPresent(it.vT, brasilLast), 100);
  });
  const corr = ready.map((a) => ready.map((b) => window.pearsonByYear(inEra(a.points), inEra(b.points), 'v')));

  const levels = new Set(items.map((it) => it.level));
  const mixedLevels = levels.size > 1;
  const inside = tc.containments(selection);

  // ── Pickers ─────────────────────────────────────────────────────────────────────────
  const [muniQuery, setMuniQuery] = useTCState('');
  const mesh = data.muniCapable && window.geoMesh ? window.geoMesh() : null;
  const muniMatches = useTCMemo(() => {
    const q = muniQuery.trim().toLowerCase();
    if (!mesh || q.length < 3) return [];
    const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const nq = norm(q);
    return mesh.filter((m) => norm(m.cityName).includes(nq)).slice(0, 12);
  }, [muniQuery, mesh]);
  const atCap = selection.length >= MAX;
  const ufsSorted = (window.UF_DATA || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const chipStyle = (t) => {
    const i = selection.findIndex((s) => s.level === t.level && String(s.code) === String(t.code));
    const c = TC_COLORS[i % TC_COLORS.length];
    return i >= 0 ? { background: c, borderColor: c, color: '#fff' } : null;
  };

  return (
    <>
      <div className="card subtle" style={{ marginBottom: 12 }}>
        <p className="caption" style={{ margin: 0 }}>
          Escolha até {MAX} territórios de qualquer nível, como uma região, um estado ou um
          município, e compare a evolução deles lado a lado. Os filtros de produto, período,
          moeda e correção valem aqui. O filtro de geografia do painel não vale, porque os
          lugares comparados são escolhidos nesta tela.
        </p>
      </div>

      <div className="card tc-picker">
        <window.SectionHeader
          overline={`Territórios · ${selection.length} de ${MAX}`}
          title="O que comparar"
          action={selection.length ? (
            <button type="button" className="btn-ghost" onClick={() => setSelection([])}>Limpar</button>
          ) : null}
        />
        <div className="tc-selected">
          {selection.length === 0 && (
            <span className="caption">Nenhum território escolhido. Adicione abaixo.</span>
          )}
          {items.map((it) => (
            <span key={it.key} className="tc-sel-chip" style={{ borderColor: it.color }}>
              <span className="pc-legend-dot" style={{ background: it.color }}></span>
              {it.label} <small className="tc-level">· {it.levelLabel}</small>
              <button type="button" className="tc-sel-remove" aria-label={`Remover ${it.label}`}
                      onClick={() => remove(it)}>×</button>
            </span>
          ))}
        </div>

        <div className="tc-add">
          <div className="tc-add-group">
            <span className="pp-selector-label">Regiões</span>
            <div className="pp-chips">
              {(window.REGIONS || []).map((r) => {
                const t = { level: 'regiao', code: r.id };
                const on = has(t);
                return (
                  <button key={r.id} type="button"
                          className={'pp-chip ' + (on ? 'on' : '') + (!on && atCap ? ' disabled' : '')}
                          style={chipStyle(t)}
                          onClick={() => (on ? remove(t) : add(t))}>
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="tc-add-group">
            <label className="pp-selector-label" htmlFor="tc-uf">Estados</label>
            <select id="tc-uf" className="tc-select" value="" disabled={atCap}
                    onChange={(e) => { if (e.target.value) add({ level: 'uf', code: e.target.value }); }}>
              <option value="">{atCap ? `Máximo de ${MAX}` : 'Adicionar estado…'}</option>
              {ufsSorted.map((u) => (
                <option key={u.uf} value={u.uf} disabled={has({ level: 'uf', code: u.uf })}>
                  {u.name} ({u.uf})
                </option>
              ))}
            </select>
          </div>
          <div className="tc-add-group tc-add-muni">
            <label className="pp-selector-label" htmlFor="tc-muni">Municípios</label>
            {data.muniCapable ? (
              <>
                <input id="tc-muni" className="tc-input" type="search" value={muniQuery}
                       placeholder={atCap ? `Máximo de ${MAX}` : 'Buscar município (3 letras ou mais)…'}
                       disabled={atCap} onChange={(e) => setMuniQuery(e.target.value)} />
                {muniMatches.length > 0 && (
                  <div className="tc-matches">
                    {muniMatches.map((m) => {
                      const t = { level: 'municipio', code: String(m.cityCode) };
                      return (
                        <button key={m.cityCode} type="button" className="pp-chip"
                                disabled={has(t)}
                                onClick={() => { add(t); setMuniQuery(''); }}>
                          {m.cityName} ({m.uf})
                        </button>
                      );
                    })}
                  </div>
                )}
                {muniQuery.trim().length >= 3 && mesh && muniMatches.length === 0 && (
                  <span className="caption">Nenhum município com esse nome.</span>
                )}
              </>
            ) : (
              <span className="caption">Este banco não tem dados por município.</span>
            )}
          </div>
        </div>
      </div>

      {selection.length > 0 && (
        <>
          <div className="card">
            <window.SectionHeader
              overline={mode === 'index'
                ? (baseYear ? `Índice · base 100 em ${baseYear}` : 'Índice · sem ano-base comum')
                : `${TC_METRIC_LABEL[metric]} · ${tcUnit(metric, conv)}`}
              title="Evolução lado a lado"
              action={(
                <div className="tc-controls">
                  <div className="seg" role="group" aria-label="Métrica">
                    {metricOptions.map((m) => (
                      <button key={m} type="button" className={'seg-opt ' + (m === metric ? 'on' : '')}
                              onClick={() => setState({ metric: m })}>{TC_METRIC_LABEL[m]}</button>
                    ))}
                  </div>
                  <div className="seg" role="group" aria-label="Escala">
                    <button type="button" className={'seg-opt ' + (mode === 'abs' ? 'on' : '')}
                            onClick={() => setState({ mode: 'abs' })}>Valores</button>
                    <button type="button" className={'seg-opt ' + (mode === 'index' ? 'on' : '')}
                            onClick={() => setState({ mode: 'index' })}>Índice (base 100)</button>
                  </div>
                </div>
              )}
            />
            {ready.length > 0 && (
              <window.MultiLineChart series={series} valueKey="v" height={320} showLegend={false}
                                     label={mode === 'index' ? `índice (${baseYear ?? '—'}=100)` : tcUnit(metric, conv)} />
            )}
            <div className="pc-legend">
              {items.map((it) => (
                <span key={it.key} className="pc-legend-item">
                  <span className="pc-legend-dot" style={{ background: it.color }}></span>
                  {it.label}
                  {it.loading && <small className="caption"> · carregando…</small>}
                  {it.unavailable && <small className="caption"> · sem dado por município neste banco</small>}
                </span>
              ))}
            </div>
            {mixedLevels && mode === 'abs' && (
              <p className="caption tc-note">
                A comparação mistura níveis diferentes, e uma região é naturalmente muito maior
                que um município. Para comparar o ritmo de crescimento, use o índice (base 100).
              </p>
            )}
            {eraStart != null && (
              <p className="caption tc-note">
                Sem correção pela inflação, os anos antes de {eraStart} estão em outra moeda e não
                se comparam com os de hoje. Por isso o índice, a variação acumulada, o crescimento
                médio e a correlação partem de {eraStart}, o primeiro ano na moeda atual. Para
                medir o período inteiro, escolha uma correção em Convenções métricas.
              </p>
            )}
            {inside.map(({ inner, outer }) => (
              <p key={`${tc.keyOf(inner)}>${tc.keyOf(outer)}`} className="caption tc-note">
                {tc.labelOf(inner)} está dentro de {tc.labelOf(outer)}: a linha de{' '}
                {tc.labelOf(outer)} já inclui a de {tc.labelOf(inner)}.
              </p>
            ))}
          </div>

          <div className="card">
            <window.SectionHeader
              overline={`Métricas comparativas · ${TC_METRIC_LABEL[metric]}`}
              title="Tamanho, crescimento e peso no país"
            />
            <div className="pc-table-wrap">
              <table className="pc-table">
                <thead>
                  <tr>
                    <th>Território</th>
                    <th>Nível</th>
                    <th className="num">Em {lastYear ?? '—'}{partialLatest ? ' (parcial)' : ''}</th>
                    <th className="num">Variação acumulada{baseYear ? ` (desde ${baseYear})` : ''}</th>
                    <th className="num">Crescimento médio ao ano</th>
                    <th className="num">Participação no Brasil</th>
                  </tr>
                </thead>
                <tbody>
                  {ready.map((it) => (
                    <tr key={it.key}>
                      <td><span className="pc-row-dot" style={{ background: it.color }}></span>{it.label}</td>
                      <td>{it.levelLabel}</td>
                      <td className="num tnum">{tcFormat(metric, it.vT, conv)}</td>
                      <td className="num tnum" style={{ color: window.deltaColor(it.accum) }}>{window.fmtSigned(it.accum, 0)}</td>
                      <td className="num tnum" style={{ color: window.deltaColor(it.cagr) }}>{window.fmtSigned(it.cagr, 1)}</td>
                      <td className="num tnum">{it.share == null ? '—' : `${it.share.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {partialLatest && (
              <p className="caption tc-note">
                <strong>{lastYear} (parcial):</strong> o ano mais recente cobre apenas{' '}
                {monthsLatest ? `${monthsLatest} ${monthsLatest === 1 ? 'mês' : 'meses'}` : 'parte do ano'}.
                O valor desse ano, a variação acumulada e o crescimento médio refletem esse ano
                parcial, conforme o período que você selecionou, então a comparação com os anos
                completos não é direta. A participação no Brasil não é afetada, porque todos os
                territórios cobrem os mesmos meses.
              </p>
            )}
          </div>

          <div className="card">
            <window.SectionHeader
              overline="Correlação · variação de um ano para o outro"
              title="Quão juntos esses territórios sobem e descem"
              action={<span className="caption">Pearson · −1 a +1</span>}
            />
            {ready.length < 2 ? (
              <p className="caption" style={{ padding: '20px 4px', textAlign: 'center' }}>
                Escolha ao menos 2 territórios para calcular a correlação.
              </p>
            ) : (
              <div className="pc-corr-wrap">
                <table className="pc-corr">
                  <thead>
                    <tr>
                      <th></th>
                      {ready.map((it) => (
                        <th key={it.key} title={it.label}>
                          <span className="pc-corr-dot" style={{ background: it.color }}></span>
                          {it.level === 'municipio' ? it.label.split(' (')[0] : it.code}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ready.map((row, i) => (
                      <tr key={row.key}>
                        <th title={row.label}>
                          <span className="pc-corr-dot" style={{ background: row.color }}></span>
                          {row.label}
                        </th>
                        {ready.map((col, j) => {
                          const r = corr[i][j];
                          return (
                            <td key={col.key} className="tnum"
                                style={{ background: i === j ? 'var(--bg-surface-2)' : window.corrColor(r),
                                         color: Number.isFinite(r) && Math.abs(r) > 0.6 ? '#fff' : 'var(--fg-1)' }}>
                              {i === j || !Number.isFinite(r) ? '—' : r.toFixed(2).replace('.', ',')}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="caption pc-corr-note">
                  Verde: territórios que sobem e descem juntos. Vermelho: movimentos opostos.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

window.ViewTerritoryCompare = ViewTerritoryCompare;
