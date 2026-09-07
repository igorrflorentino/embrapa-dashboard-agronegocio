// MaterialityFloorNote — nomeia quem um piso de materialidade tirou da comparação.
//
// A regra do projeto proíbe filtragem invisível: se um número deixou de ser mostrado,
// a tela diz QUAIS e POR QUÊ. Um componente só, para as views que aplicam
// `window.materialityFloor` não descreverem a mesma recusa de formas diferentes — foi
// assim que "a regra certa existia num lugar e não se propagou" virou o padrão de
// defeito mais frequente desta base.
//
// A ESTRUTURA é o que precisa ser comum e está aqui: enumerar TODAS as linhas (nunca
// um "e mais N" — a lista curta é justamente a informação), mostrar a grandeza concreta
// de cada uma para o leitor julgar sozinho, e enunciar a REGRA (as duas provas
// reprovadas), não uma causa que só valeria para parte da lista. Os fragmentos de
// texto em pt-BR ficam com quem chama, porque a medida muda de gênero e de unidade.
function MaterialityFloorNote({
  dropped,          // as linhas descartadas (window.materialityFloor().dropped)
  valueKey,         // a grandeza que o piso mediu ('areaHa', 'production', …)
  fmt,              // formatador dessa grandeza (v => '205 ha')
  floor,            // { minShare, minAbs } — a calibração aplicada
  floorRel,         // o piso relativo já convertido na unidade, ou null
  titulo,           // 'Fora da comparação por área'
  base,             // 'da área colhida do recorte'
  porque,           // 'base pequena demais para o rendimento médio representar a UF'
  segue,            // 'Seguem no mapa em cinza, sem cor de intensidade.'
}) {
  if (!dropped || !dropped.length) return null;
  const lista = dropped.slice()
    .sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0))
    .map(u => `${u.uf} (${fmt(u[valueKey] || 0)})`)
    .join(', ');
  // A frase enuncia SÓ as provas que o piso realmente aplica. materialityFloor aceita
  // uma ou duas (o piso de produção usa só a relativa, porque "é produtor de verdade
  // desta lavoura" é uma pergunta relativa; o de área usa as duas, porque a validade de
  // uma medida física também depende do tamanho absoluto da amostra). Anunciar uma prova
  // inexistente rendia "e de — mil t no total", um limiar que ninguém aplicou.
  const provas = [];
  if (floor.minShare > 0) {
    // Casas decimais suficientes para o limiar não sumir: 0,01% arredondado a uma casa
    // vira "0,0%", que se lê como "abaixo de zero" — uma regra que não exclui ninguém.
    const pct = floor.minShare * 100;
    provas.push(
      `${window.numBR(pct, pct < 0.1 ? 2 : 1)}% ${base}${floorRel != null ? ` (${fmt(floorRel)})` : ''}`,
    );
  }
  if (floor.minAbs > 0) provas.push(`${fmt(floor.minAbs)} no total`);
  return (
    <p className="caption" style={{ marginTop: 10 }}>
      {titulo}: <strong>{lista}</strong>. Cada uma fica abaixo de{' '}
      {provas.length > 1 ? <>{provas[0]} <em>e</em> de {provas[1]}</> : provas[0]} — {porque}. {segue}
    </p>
  );
}

window.MaterialityFloorNote = MaterialityFloorNote;
export default MaterialityFloorNote;
