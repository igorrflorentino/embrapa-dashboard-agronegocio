// CollapsingNameList — uma nota que enumera nomes sem virar paredão.
//
// A regra do projeto proíbe filtragem invisível e, no mesmo espírito, proíbe uma
// ressalva que não diga SOBRE QUEM: quem procura um nome específico tem de conseguir
// achá-lo, e um "e mais 30" quebra exatamente isso. Mas a regra "enumere todos" foi
// escrita para listas de cinco ou seis nomes. Acima de LISTA_LONGA a enumeração vai para
// um <details> RECOLHIDO: a contagem e a regra ficam à vista, e a lista inteira está a um
// clique. Recolher não é omitir.
//
// Isto vivia DENTRO do MaterialityFloorNote, e por isso a nota de cobertura de preço
// (ViewPartners, v1.70.0) nasceu sem ele — enumerava 19 dos 30 parceiros exibidos num
// parágrafo corrido, medido no agrupamento madeira, com a nota que recolhe logo abaixo na
// MESMA tela. É o padrão de defeito mais frequente desta base: a regra certa existia num
// lugar e não se propagou. Um átomo compartilhado é o que impede a terceira repetição.
function CollapsingNameList({
  titulo,       // 'Fora do ranking por produção' · 'Preço apoiado em parte do comércio'
  itens,        // as linhas JÁ FORMATADAS: ['Guam (55%)', 'Fiji (81%)', …]
  substantivo,  // 'UFs' / 'parceiros' — o que a contagem conta quando a lista recolhe
  regra,        // o texto que enuncia POR QUE estes nomes estão aqui (JSX)
  marginTop = 10,
}) {
  if (!itens || !itens.length) return null;
  const lista = itens.join(', ');
  if (itens.length <= LISTA_LONGA) {
    return (
      <p className="caption" style={{ marginTop }}>
        {titulo}: <strong>{lista}</strong>. {regra}
      </p>
    );
  }
  return (
    <div className="caption" style={{ marginTop }}>
      <p style={{ margin: 0 }}>
        {titulo}: <strong>{itens.length}{substantivo ? ` ${substantivo}` : ''}</strong>. {regra}
      </p>
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer' }}>Ver quais</summary>
        <p style={{ margin: '4px 0 0' }}>{lista}</p>
      </details>
    </div>
  );
}

// Acima disto a enumeração recolhe. 10 cabe em duas linhas na largura de um card; 19 (a
// nota de cobertura em madeira) ocupa cinco, e 38 (o piso de preço no COMEX) ocupa oito.
const LISTA_LONGA = 10;

window.CollapsingNameList = CollapsingNameList;
export default CollapsingNameList;
