// ViewHealth — institutional "Saúde do sistema" page.
//
// FOCUS: the OPERABILITY of the data banks — ALL of them, not one — answering
// "is each source in production responding, how much does it cover, and how fresh
// is it?". It is deliberately NOT a data-quality page: the data_quality_flag
// diagnostics (flag distribution, integridade over time, per-product/UF quality)
// live in the dedicated "Qualidade dos dados" perspective, per banco.
//
// Every fact here is read from the LIVE backend seam — window.dataStore.meta(id)
// (overlaid from /api/source-meta: coverage counters, year span, Gold refresh,
// maturity) and the per-banco Gold query result (window.dataStore.status/error).
// Where no backend source exists for an operational signal (pipeline-run history),
// the page honestly empty-states instead of inventing one.

const { useState: useHsState, useEffect: useHsEffect } = React;

function ViewHealth() {
  const bancos = window.visibleBancos ? window.visibleBancos() : (window.BANCOS || []);

  // ── Live provenance + Gold-query bootstrap ───────────────────────────────
  // Saúde is an info-page (reached via ?ip=health): it renders OUTSIDE the data
  // boundary, so no banco snapshot loads first. Proactively fetch /api/source-meta
  // for every banco AND fire the real Gold query for each in-production banco, then
  // subscribe so the page re-renders to the REAL metadata + query results once they
  // resolve — the per-banco "Operação" is a genuine query outcome, not a guess.
  const [, forceHs] = useHsState(0);
  useHsEffect(() => window.dataStore.subscribe(() => forceHs(n => n + 1)), []);
  useHsEffect(() => {
    if (!(window.dataStore && window.dataStore.loadMeta)) return;
    bancos.forEach(b => window.dataStore.loadMeta(b.id));
  }, []);
  const liveIds = bancos.filter(b => b.status === 'live').map(b => b.id);
  useHsEffect(() => {
    if (!(window.dataStore && window.dataStore.load)) return;
    liveIds.forEach(id => window.dataStore.load(id));
  }, [liveIds.join(',')]);

  // ── Per-banco OPERATIONAL facts — read from the LIVE provenance seam ──────
  // window.dataStore.meta(id) returns the registry declaration OVERLAID with the
  // real Gold metadata (/api/source-meta): last refresh, coverage counters, year
  // span, latest edition. Until a banco's meta resolves, coverage is null and the
  // page shows '—' (the honest pre-resolution value, never a fabricated one).
  const metaOf = (id) => (window.dataStore && window.dataStore.meta ? window.dataStore.meta(id) : {});
  const provFacts = (id) => {
    const m = metaOf(id);
    const cov = m.coverage || {};
    const prov = m.prov || {};
    return {
      lastRun: m.refresh || '—',
      goldRows: cov.totalRows ?? null,
      yearStart: cov.yearStart ?? null,
      yearEnd: cov.yearEnd ?? null,
      // The latest edition/period in the Gold (e.g. "PEVS 2024", "COMEX 2026 · M05"),
      // overlaid live from gold_source_metadata — NOT a frozen publication date.
      lastEdition: prov.lastCrop || '—',
      source: m.source || null,
    };
  };
  const STATE = {};
  bancos.forEach(b => { STATE[b.id] = provFacts(b.id); });

  // ── Operational HEALTH — DERIVED FROM THE REAL GOLD QUERY, not from maturity ──
  // Answers "is it operating RIGHT NOW?" from the actual pushdown query fired at each
  // live banco's Gold: 'ready' → ok, 'error' → Falha, in-flight → Verificando…. A
  // not-yet-in-production banco reads 'pending'/'planned' from its maturity. "Source
  // down" is HEALTH ("Falha"), never a maturity stage. No fabricated run-status.
  const operationalStatus = (b) => {
    const m = window.maturityMeta(b);
    if (!m.hasData) return b.maturity === 'planejado' ? 'planned' : 'pending'; // nothing operating yet
    const st = window.dataStore ? window.dataStore.status(b.id) : 'idle';
    if (st === 'error' || (window.dataStore && window.dataStore.error(b.id))) return 'fail'; // query failed
    if (st === 'ready') return 'ok';                                            // Gold query succeeded
    return 'checking';            // queried, snapshot still in flight — not yet verified
  };
  bancos.forEach(b => { STATE[b.id] = STATE[b.id] || {}; STATE[b.id].status = operationalStatus(b); });

  // ── Operational ALERTS — DERIVED FROM REAL SIGNALS ONLY ──────────────────
  // The only genuine operability signal this repo has is a live banco whose Gold
  // query FAILED (window.dataStore.error). No fabricated run-status, and NO
  // data-quality content — the integrity diagnostics live in the Qualidade dos dados
  // perspective. A healthy system shows the honest "all responding" empty-state.
  const buildAlerts = () => {
    const out = [];
    bancos.filter(b => b.status === 'live').forEach(b => {
      if (STATE[b.id]?.status !== 'fail') return;
      const err = window.dataStore ? window.dataStore.error(b.id) : null;
      const table = window.bancoTable(b.id);
      out.push({
        banco: b.id,
        title: `Falha de consulta · ${b.short}`,
        desc: err
          ? `A consulta à Gold (${table}) retornou erro: ${err}. O banco não está respondendo no momento.`
          : `A consulta à Gold (${table}) falhou. O banco não está respondendo no momento.`,
        since: STATE[b.id]?.lastRun && STATE[b.id].lastRun !== '—' ? STATE[b.id].lastRun : null,
      });
    });
    return out;
  };
  const ALERTS = buildAlerts();

  // Coverage lint: every visible banco should have a provenance seam (STATE).
  if (window.auditBancoCoverage) {
    window.auditBancoCoverage('saúde · execução por banco (ViewHealth.jsx)',
      (b) => STATE[b.id] && STATE[b.id].lastRun, { onlyLive: true });
  }

  // ── KPI aggregates (multi-bank rollups) ──────────────────────────────────
  const liveDefined   = bancos.filter(b => b.status === 'live');
  const liveOk        = liveDefined.filter(b => STATE[b.id]?.status === 'ok');       // queried & responded
  const checkingCount = liveDefined.filter(b => STATE[b.id]?.status === 'checking').length;
  const failCount     = liveDefined.filter(b => STATE[b.id]?.status === 'fail').length;
  const pendingCount  = bancos.filter(b => STATE[b.id]?.status === 'pending').length; // ingesting
  const plannedCount  = bancos.filter(b => STATE[b.id]?.status === 'planned').length; // roadmap-only
  // "Bancos operando" sub: only the non-operating segments that actually apply, so a
  // planejado banco (e.g. SEFAZ) is never mislabeled "aguardando ingestão" — matching
  // the per-row "Planejado" vs "Aguardando ingestão" distinction in the table below.
  const notLiveSub = [
    checkingCount ? `${checkingCount} verificando` : null,
    pendingCount ? `${pendingCount} aguardando ingestão` : null,
    plannedCount ? `${plannedCount} planejado` : null,
    `${bancos.length} no total`,
  ].filter(Boolean).join(' · ');

  // Total Gold rows across every in-production banco (real coverage.totalRows). Sums
  // only the bancos whose meta has already resolved; "—" until at least one does.
  const totalRows = liveDefined.reduce((s, b) => {
    const r = STATE[b.id]?.goldRows;
    return r != null ? s + r : s;
  }, 0);
  const anyRows = liveDefined.some(b => STATE[b.id]?.goldRows != null);

  // System-wide temporal amplitude across live bancos (earliest start → latest end).
  const startYears = liveDefined.map(b => STATE[b.id]?.yearStart).filter(y => y != null);
  const endYears   = liveDefined.map(b => STATE[b.id]?.yearEnd).filter(y => y != null);
  const spanStart  = startYears.length ? Math.min(...startYears) : null;
  const spanEnd    = endYears.length ? Math.max(...endYears) : null;

  // The running release actually serving the requests — a real operational fact,
  // hydrated onto window.APP_VERSION by the first /api/source-meta response.
  const appVersion = window.APP_VERSION || null;

  // Overall system status = worst of the live bancos' REAL query results. 'checking'
  // (snapshots still in flight) is reported honestly rather than as a premature OK.
  const liveStatuses = liveDefined.map(b => STATE[b.id]?.status).filter(Boolean);
  const overall = liveStatuses.includes('fail') ? 'fail'
    : liveStatuses.includes('checking') ? 'checking'
    : liveStatuses.length ? 'ok'
    : 'checking';
  const OVERALL = {
    ok:   { color: 'var(--ok)',   label: 'Operacional', note: `os ${liveOk.length} bancos em produção responderam às consultas` },
    fail: { color: 'var(--err)',  label: 'Falha',       note: `${failCount} banco(s) sem responder às consultas — veja os alertas` },
    checking: { color: 'var(--fg-3)', label: 'Verificando…', note: 'consultando as tabelas Gold em produção…' },
  }[overall];

  const STATUS_LABEL = {
    ok:      { label: 'Saudável',            color: 'var(--ok)'   },
    checking:{ label: 'Verificando…',        color: 'var(--fg-3)' },
    fail:    { label: 'Falha',               color: 'var(--err)'  },
    pending: { label: 'Aguardando ingestão', color: 'var(--fg-3)' },
    planned: { label: 'Planejado',           color: 'var(--pres-gray-400)' },
  };

  const fmtRows = window.fmtRows;  // shared compact mi/mil counter (data.js)

  return (
    <div className="ab-stack">
      {/* KPI strip — system-wide operability rollups */}
      <div className="kpi-row hs-kpi-row">
        <window.KpiCardSpark
          label="Status geral do sistema"
          value={
            <span className="hs-status-pill" style={{ '--st-color': OVERALL.color }}>
              <span className="hs-dot" style={{ background: OVERALL.color }}></span>
              {OVERALL.label}
            </span>
          }
          sub={OVERALL.note}
        />
        <window.KpiCardSpark
          label="Bancos operando"
          value={`${liveOk.length} / ${liveDefined.length}`}
          sub={notLiveSub}
        />
        <window.KpiCardSpark
          label="Volume total na Gold"
          value={anyRows ? fmtRows(totalRows) : '—'}
          sub={
            spanStart != null && spanEnd != null
              ? `linhas somadas · período ${spanStart}–${spanEnd} em ${liveDefined.length} fontes`
              : `linhas somadas nas ${liveDefined.length} fontes em produção`
          }
        />
        <window.KpiCardSpark
          label="Alertas operacionais"
          value={failCount.toString()}
          sub={failCount === 0 ? 'nenhuma falha de consulta' : `${failCount} banco(s) sem responder`}
        />
      </div>

      {/* Per-banco operational matrix — the centerpiece: one row per source, its
          maturity, the REAL Gold-query outcome, coverage span and volume. */}
      <div className="card">
        <window.SectionHeader
          overline="Operação por banco de dados"
          title="Estado atual de cada fonte"
          action={<span className="caption">{bancos.length} bancos · {liveDefined.length} em produção</span>}
        />
        <div className="hs-table-wrap">
          <table className="hs-table">
            <thead>
              <tr>
                <th>Banco</th>
                <th>Fonte</th>
                <th>Maturidade</th>
                <th>Operação</th>
                <th>Período coberto</th>
                <th className="num">Linhas Gold</th>
              </tr>
            </thead>
            <tbody>
              {bancos.map(b => {
                const s = STATE[b.id] || { status: 'pending' };
                const meta = STATUS_LABEL[s.status];
                const period = (s.yearStart != null && s.yearEnd != null)
                  ? `${s.yearStart}–${s.yearEnd}` : '—';
                return (
                  <tr key={b.id}>
                    <td>
                      <div className="hs-banco">
                        <span className="hs-banco-short">{b.short}</span>
                        <span className="hs-banco-table"><code>{window.bancoTable(b.id)}</code></span>
                      </div>
                    </td>
                    <td data-label="Fonte">{s.source || b.source || '—'}</td>
                    <td data-label="Maturidade">
                      <window.MaturityTag banco={b} size="sm" />
                    </td>
                    <td data-label="Operação">
                      <span className="hs-status-pill" style={{ '--st-color': meta.color }}>
                        <span className="hs-dot" style={{ background: meta.color }}></span>
                        {meta.label}
                      </span>
                    </td>
                    <td className="tnum" data-label="Período">{period}</td>
                    <td className="num tnum" data-label="Linhas Gold">
                      {s.goldRows != null ? fmtRows(s.goldRows) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Operational alerts — REAL query failures only (no data-quality content).
          Healthy system → the honest "all responding" empty-state. */}
      <div className="card">
        <window.SectionHeader
          overline="Alertas operacionais"
          title={ALERTS.length === 0 ? 'Nenhuma falha de operação' : `${ALERTS.length} falha(s) de consulta`}
          action={<span className="caption">falhas reais de consulta à Gold</span>}
        />
        <div className="hs-alerts">
          {ALERTS.length === 0 ? (
            <p className="caption" style={{ padding: '12px 4px' }}>
              Todos os bancos em produção responderam às consultas à Gold. Nenhuma falha operacional no momento.
            </p>
          ) : ALERTS.map((a, i) => {
            const meta = STATUS_LABEL.fail;
            return (
              <div key={i} className="hs-alert hs-alert-fail">
                <div className="hs-alert-head">
                  <span className="hs-status-pill" style={{ '--st-color': meta.color }}>
                    <span className="hs-dot" style={{ background: meta.color }}></span>
                    {meta.label}
                  </span>
                  <span className="hs-alert-title">{a.title}</span>
                  {a.since && <span className="hs-alert-since caption">desde {a.since}</span>}
                </div>
                <p className="hs-alert-desc">{a.desc}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sources freshness — per-source latest edition + Gold refresh, live from
          /api/source-meta (no fabricated publication date). Mobile-friendly stack. */}
      <div className="card">
        <window.SectionHeader
          overline="Frescor das fontes"
          title="Edição e atualização mais recentes por fonte"
          action={<span className="caption">{liveDefined.length} fonte(s) em produção</span>}
        />
        <div className="hs-sources">
          {bancos.map(b => {
            const s = STATE[b.id] || {};
            const isLive = b.status === 'live';
            const lastEd = isLive ? (s.lastEdition || '—') : '—';
            const refresh = isLive ? (s.lastRun || '—') : '—';
            return (
              <div key={b.id} className={'hs-source ' + (isLive ? 'live' : 'pending')}>
                <div className="hs-source-l">
                  <div className="hs-source-name">{b.short}</div>
                  <div className="hs-source-meta">
                    <code>{window.bancoTable(b.id) || '—'}</code>
                    {(s.source || b.source) ? <> · {s.source || b.source}</> : null}
                  </div>
                </div>
                <div className="hs-source-r">
                  <span className="meta-label">Edição mais recente</span>
                  <span className="meta-val tnum">{lastEd}</span>
                  <span className="meta-label" style={{ marginTop: 4 }}>Atualização da Gold</span>
                  <span className="meta-val tnum">{refresh}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Architecture / how-it-works — the stateless-pushdown model, the running
          release, the system-wide amplitude, an honest note on run telemetry, and a
          pointer to where data-QUALITY diagnostics live (a separate perspective). */}
      <div className="card">
        <window.SectionHeader
          overline="Arquitetura operacional · Cloud Run stateless"
          title="Como o dashboard consulta os dados"
        />
        <div className="hs-snap">
          <div className="hs-snap-row">
            <span className="meta-label">Versão em produção</span>
            <span className="meta-val tnum">{appVersion || '—'}</span>
          </div>
          <div className="hs-snap-row">
            <span className="meta-label">Amplitude temporal (todas as fontes)</span>
            <span className="meta-val tnum">
              {spanStart != null && spanEnd != null ? `${spanStart} – ${spanEnd}` : '—'}
            </span>
          </div>
          <div className="hs-snap-row">
            <span className="meta-label">Telemetria de execuções da pipeline</span>
            <span className="meta-val tnum">não monitorada</span>
          </div>
          <p className="caption hs-snap-note">
            No deploy, o Cloud Run é stateless: cada interação vira uma consulta SQL parametrizada
            empurrada ao BigQuery, e o <strong>flask-caching</strong> memoiza os resultados pequenos por
            parâmetro de consulta. A saúde por banco acima reflete o resultado <strong>real</strong> dessas
            consultas à Gold (<code>/api/source-meta</code> para a proveniência; a própria consulta para o
            estado de operação). O histórico diário de execuções da pipeline (sucesso/falha por dia) ainda
            não é coletado por este painel — não há telemetria de <em>runs</em> exposta ao frontend; quando
            existir, aparecerá aqui. Para o diagnóstico da <strong>qualidade</strong> dos dados (integridade,
            distribuição das marcas), use a perspectiva <em>Qualidade dos dados</em> de cada banco.
          </p>
        </div>
      </div>

      {/* Maturity legend — explains the "Maturidade" column above */}
      <div className="card">
        <window.SectionHeader
          overline="Maturidade"
          title="O que cada estágio de ciclo de vida significa"
          action={<span className="caption">coluna “Maturidade” da tabela acima</span>}
        />
        <window.MaturityLegend />
      </div>
    </div>
  );
}

window.ViewHealth = ViewHealth;
