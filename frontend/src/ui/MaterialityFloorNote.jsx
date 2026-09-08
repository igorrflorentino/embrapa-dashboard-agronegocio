import './CollapsingNameList.jsx';

// MaterialityFloorNote — nomeia quem um piso de materialidade tirou da comparação.
//
// A regra do projeto proíbe filtragem invisível: se um número deixou de ser mostrado,
// a tela diz QUAIS e POR QUÊ. Um componente só, para as views que aplicam
// `window.materialityFloor` não descreverem a mesma recusa de formas diferentes — foi
// assim que "a regra certa existia num lugar e não se propagou" virou o padrão de
// defeito mais frequente desta base.
//
// A ESTRUTURA é o que precisa ser comum e está aqui: enumerar TODAS as linhas (nunca
// um "e mais N" — quem procura um nome específico tem de conseguir achá-lo), mostrar a
// grandeza concreta de cada uma para o leitor julgar sozinho, e enunciar a REGRA (as
// provas reprovadas), não uma causa que só valeria para parte da lista. Os fragmentos
// de texto em pt-BR ficam com quem chama, porque a medida muda de gênero e de unidade.
//
// O RECOLHIMENTO de uma lista longa mora em CollapsingNameList.jsx, partilhado com a
// nota de cobertura de preço do ViewPartners.
function MaterialityFloorNote({
  dropped,          // as linhas descartadas (window.materialityFloor().dropped)
  valueKey,         // a grandeza que o piso mediu ('areaHa', 'production', …)
  labelKey = 'uf',  // como cada linha se chama ('uf' nas views territoriais, 'name'
                    // no ranking de parceiros, onde as linhas são países)
  fmt,              // formatador dessa grandeza (v => '205 ha')
  floor,            // { minShare, minAbs } — a calibração aplicada
  floorRel,         // o piso relativo já convertido na unidade, ou null
  titulo,           // 'Fora da comparação por área'
  base,             // 'da área colhida do recorte'
  substantivo,      // 'UFs' / 'parceiros' — o que a contagem conta, quando a lista
                    // longa recolhe e o número aparece sozinho
  cada = 'Cada uma', // concordância: 'Cada uma' (UFs) · 'Cada um' (parceiros)
  porque,           // 'base pequena demais para o rendimento médio representar a UF'
  segue,            // 'Seguem no mapa em cinza, sem cor de intensidade.'
}) {
  if (!dropped || !dropped.length) return null;
  const ordenadas = dropped.slice()
    .sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0));
  const itens = ordenadas.map(u => `${u[labelKey] ?? u.uf} (${fmt(u[valueKey] || 0)})`);
  // A frase enuncia SÓ as provas que o piso realmente aplica. materialityFloor aceita
  // uma ou duas (o piso de produção usa só a relativa, porque "é produtor de verdade
  // desta lavoura" é uma pergunta relativa; o de área usa as duas, porque a validade de
  // uma medida física também depende do tamanho absoluto da amostra). Anunciar uma prova
  // inexistente rendia "e de — mil t no total", um limiar que ninguém aplicou.
  const provas = [];
  if (floor.minShare > 0) {
    // Casas decimais suficientes para o limiar não sumir, QUALQUER que ele seja: um
    // número fixo de casas some com o piso pequeno (0,01% vira "0,0%" com uma casa,
    // 0,001% vira "0,00%" com duas), e "abaixo de zero" se lê como regra que não
    // exclui ninguém — ao lado de uma lista de excluídos. Uma casa por ordem de
    // grandeza abaixo de 1 garante ao menos um dígito significativo.
    const pct = floor.minShare * 100;
    const casas = pct > 0 ? Math.max(0, Math.ceil(-Math.log10(pct))) : 1;
    provas.push(
      `${window.numBR(pct, casas)}% ${base}${floorRel != null ? ` (${fmt(floorRel)})` : ''}`,
    );
  }
  if (floor.minAbs > 0) provas.push(`${fmt(floor.minAbs)} no total`);
  const regra = (
    <>
      {cada} fica abaixo de{' '}
      {provas.length > 1 ? <>{provas[0]} <em>e</em> de {provas[1]}</> : provas[0]} — {porque}. {segue}
    </>
  );
  return (
    <window.CollapsingNameList
      titulo={titulo} itens={itens} substantivo={substantivo} regra={regra} />
  );
}

window.MaterialityFloorNote = MaterialityFloorNote;
export default MaterialityFloorNote;
