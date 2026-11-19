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
