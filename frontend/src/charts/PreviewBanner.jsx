// PreviewBanner — the "dados sintéticos de demonstração" banner the preview /
// cross / chain views render when a producer returns preview:true (data-blocked
// or not-yet-connected sources). Not a chart — a faithful HTML port of the
// prototype's original PreviewBanner, kept here so the reused views find
// window.PreviewBanner.

function PreviewBanner({ banco, capabilityNote }) {
  const pending = banco && banco.status !== 'live';
  const date = pending && window.bancoMeta ? window.bancoMeta(banco.id).maturityDate || null : null;
  return (
    <div className="pv-banner">
      <span className="pv-badge">Pré-visualização</span>
      <span className="pv-text">
        Dados <strong>sintéticos de demonstração</strong>. {capabilityNote || ''}{' '}
        {pending ? (
          <>
            Esta perspectiva já está construída; quando <strong>{banco.short}</strong> for
            liberado{date ? ` (${date})` : ''}, os mesmos gráficos passam a refletir dados reais —
            sem mudança de leiaute.
          </>
        ) : (
          <>
            Os mesmos gráficos passam a refletir dados reais assim que o cruzamento ler a base analítica real —
            sem mudança de leiaute.
          </>
        )}
      </span>
    </div>
  );
}

window.PreviewBanner = PreviewBanner;
export default PreviewBanner;
