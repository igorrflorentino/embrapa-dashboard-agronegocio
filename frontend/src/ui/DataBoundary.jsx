// DataBoundary.jsx — React glue for the pushdown query boundary:
//   • useBancoData(bancoId)  — query lifecycle + freshness polling
//   • FreshnessBanner        — "dados atualizados disponíveis · Recarregar"
//   • DataLoading            — skeleton shown while the pushdown query runs

const { useState: useDBState, useEffect: useDBEffect } = React;

function useBancoData(bancoId) {
  const [, force] = useDBState(0);

  useDBEffect(() => {
    const unsub = window.dataStore.subscribe(() => force(n => n + 1));
    window.dataStore.load(bancoId);
    return unsub;
  }, [bancoId]);

  // NOTE: no periodic freshness poll. dataStore.isStale() is intentionally always
  // false (there is no live Gold-version signal yet — see dataStore.js), so the
  // FreshnessBanner can never fire; a setInterval(force) here only re-ran
  // applyFilters + every chart trace build on a fixed cadence for nothing. The
  // subscribe() above already re-renders on real store changes. Re-introduce a
  // poll here ONLY alongside a real version check (poll /api/source-meta and
  // compare lastRefresh to the load time), so the re-render does actual work.

  return {
    status:   window.dataStore.status(bancoId),
    stale:    window.dataStore.isStale(bancoId),
    error:    window.dataStore.error(bancoId),
    loadedAt: window.dataStore.loadedAt(bancoId),
    version:  window.dataStore.version(bancoId),
    latestAt: window.dataStore.latestAt(bancoId),
    reload:   () => window.dataStore.load(bancoId),
  };
}

function FreshnessBanner({ banco, latestAt, onReload }) {
  const [reloading, setReloading] = useDBState(false);
  // Guard the post-await setState: the banner can unmount (banco switch) while the
  // reload promise is in flight, and a setState on an unmounted component leaks.
  const mounted = React.useRef(true);
  useDBEffect(() => () => { mounted.current = false; }, []);
  const handle = () => {
    setReloading(true);
    Promise.resolve(onReload()).then(() => { if (mounted.current) setReloading(false); });
  };
  return (
    <div className="fresh-banner">
      <span className="fresh-dot"></span>
      <span className="fresh-text">
        Nova versão da base analítica publicada{latestAt && latestAt !== '—' ? ` · ${latestAt}` : ''}.
        Os dados já carregados estão desatualizados.
      </span>
      <button className="fresh-btn" onClick={handle} disabled={reloading}>
        <window.Icon name="refresh" size={14} />
        {reloading ? 'Recarregando…' : 'Recarregar dados'}
      </button>
    </div>
  );
}

function DataLoading({ banco }) {
  return (
    <div className="dl-wrap">
      <div className="dl-head">
        <span className="dl-spinner"></span>
        <div>
          <div className="dl-title">Consultando {banco ? banco.short : 'dados'}…</div>
          <div className="dl-sub">Consultando os dados no BigQuery (tabelas pré-agregadas)</div>
        </div>
      </div>
      <div className="dl-skel-row">
        <div className="dl-skel kpi"></div><div className="dl-skel kpi"></div>
        <div className="dl-skel kpi"></div><div className="dl-skel kpi"></div>
      </div>
      <div className="dl-skel-row">
        <div className="dl-skel card"></div><div className="dl-skel card"></div>
      </div>
    </div>
  );
}

function DataError({ banco, message, onRetry }) {
  const [retrying, setRetrying] = useDBState(false);
  // Same unmount guard as FreshnessBanner: the error card can unmount mid-retry.
  const mounted = React.useRef(true);
  useDBEffect(() => () => { mounted.current = false; }, []);
  const handle = () => {
    setRetrying(true);
    Promise.resolve(onRetry()).then(() => { if (mounted.current) setRetrying(false); });
  };
  return (
    <div className="derr-wrap">
      <div className="derr-card">
        <div className="derr-icon">
          <window.Icon name="warning" size={28} />
        </div>
        <h2 className="derr-title">Não foi possível carregar {banco ? banco.short : 'os dados'}</h2>
        <p className="derr-msg">{message || 'Ocorreu um erro ao consultar a base analítica no BigQuery.'}</p>
        <p className="derr-hint">
          As consultas são enviadas ao BigQuery sob demanda. Se a falha persistir,
          verifique a disponibilidade da base analítica e tente novamente.
        </p>
        <button className="derr-btn" onClick={handle} disabled={retrying}>
          <window.Icon name="refresh" size={14} />
          {retrying ? 'Tentando novamente…' : 'Tentar novamente'}
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { useBancoData, FreshnessBanner, DataLoading, DataError });
