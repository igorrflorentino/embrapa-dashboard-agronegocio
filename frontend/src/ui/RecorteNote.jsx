// RecorteNote — states the active sub-UF recorte directly above the territorial cards.
//
// A meso/micro/intermediária/imediata narrowing restricts the data to a FRACTION of one
// state WITHOUT removing that state from the selection, so every UF row still carries
// the state's name while carrying only part of its production: "Pará · R$ 655 mi" for
// what is really the Marajó. The filter chip and the ABNT citation now name the recorte
// for the panel (v1.33.28), but those sit in the chrome — a reader looking at the map
// reads the map. This puts the same sentence where the numbers are.
//
// One component, three views, so the three cannot describe one recorte three ways.
// Renders nothing when nothing narrows.

function RecorteNote({ recorte }) {
  if (!recorte) return null;
  return (
    <div className="card subtle" style={{ marginBottom: 12 }}>
      <p className="caption" style={{ padding: '10px 12px' }}>
        Recorte territorial ativo: <strong>{recorte}</strong>. Os valores por UF abaixo
        somam <strong>apenas</strong> os municípios desse recorte — não a produção
        completa do estado.
      </p>
    </div>
  );
}

// The perspectives whose series exist only for the whole country or for whole states
// (Perfil do produto, Comparativo entre produtos, Rebanho, Produtividade) cannot apply a
// sub-UF recorte at all, and until v1.108.2 they drew national numbers under its chip
// without a word — while it loaded, after it failed and once it had loaded. This is the
// sentence each one shows instead, through the NotApplicableNote the product basket and the
// UF filter already use for a filter a screen cannot honour. The same in all three states of
// the recorte: none of these screens reads it, so its loading or failing changes nothing
// they draw. `porque` is the reason true for the screen, as a full sentence.
// Undefined when no sub-UF recorte is asked for, so NotApplicableNote renders nothing.
window.recorteNaoSeAplica = function recorteNaoSeAplica(filtered, porque) {
  if (!filtered || !filtered.subUfRequested) return undefined;
  return `O recorte territorial abaixo da UF não se aplica a esta perspectiva: ${porque} `
    + 'Os números abaixo não se limitam aos municípios escolhidos.';
};

// The per-product series of a UF subset (v1.108.3), in the state their read is in — what a
// per-product card says instead of its numbers, or beside them. One place for the wording,
// so the six screens that draw these series cannot describe one read six ways.
//   { estado: 'carregando', texto }      — held: the UFs' series are on their way;
//   { estado: 'falha', erro, texto }     — held: the read failed for good;
//   { estado: 'nacional', texto }        — the NATIONAL series stand, and this says so;
// null when nothing needs saying: no UF subset, or the UFs' own series are here. In the two
// held states applyFilters leaves the series EMPTY, so a card that drew them anyway would say
// "nenhum produto", which is not what happened: read this first.
// No text names a position ("abaixo", "acima"): the screens mount it above their numbers and
// Visão geral below its donut, so a direction would be false on one of them.
window.seriesPorUf = function seriesPorUf(filtered) {
  if (!filtered || !filtered.productUfRequested) return null;
  if (filtered.productUfLoadError) {
    return {
      estado: 'falha',
      erro: filtered.productUfLoadError,
      texto: 'Não foi possível carregar as séries por produto das UFs escolhidas (falha de rede '
        + 'ou do servidor). Recarregue a página para tentar de novo.',
    };
  }
  if (filtered.productUfLoading) {
    return { estado: 'carregando', texto: 'Carregando as séries por produto das UFs escolhidas…' };
  }
  if (filtered.productUfUnavailable) {
    return {
      estado: 'nacional',
      texto: 'As séries por produto deste banco existem só para o Brasil inteiro: os números '
        + 'por produto desta perspectiva não se limitam às UFs escolhidas.',
    };
  }
  return null;
};

// The card a per-product chart shows IN ITS PLACE while the UFs' series are held (loading,
// failed), or beside it when they are national. Renders nothing when nothing needs saying.
// A failure is an alert, like LoadErrorNote — whose generic sentence ("os valores exibidos
// podem estar incompletos") would be wrong here: nothing per product is shown at all.
function SeriesPorUfNote({ filtered }) {
  const porUf = window.seriesPorUf(filtered);
  if (!porUf) return null;
  const falhou = porUf.estado === 'falha';
  return (
    <div className="card subtle na-note" role={falhou ? 'alert' : undefined}
         style={falhou ? { borderLeft: '4px solid var(--err, #b71c1c)' } : undefined}>
      <p className="cs-note" style={{ margin: 0 }}>
        <window.Icon name={falhou ? 'warning' : 'info'} size={14} />
        <span>{porUf.texto}</span>
      </p>
    </div>
  );
}
window.SeriesPorUfNote = SeriesPorUfNote;

// Why a geo card under a product basket still shows ALL products (applyFilters'
// notFilteredByBasket): the basket's UF cube is on its way, or it failed. One clause for the
// three cards that say it (Visão geral, Geografia, Concentração), so they cannot disagree.
// Until v1.108.2 they gave a third reason in both states — "sem grão produto × UF nesta
// agregação" — written before the cube existed, and a failed cube was never told apart.
window.cestaPorUfMotivo = function cestaPorUfMotivo(filtered) {
  return filtered && filtered.basketGeoLoadError
    ? 'não foi possível carregar a distribuição por UF da cesta selecionada (falha de rede ou do servidor)'
    : 'a distribuição por UF da cesta selecionada ainda está carregando';
};

window.RecorteNote = RecorteNote;
export default RecorteNote;
