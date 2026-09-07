// produto.js — O NOME DO PRODUTO, NUM LUGAR SÓ.
//
// Para renomear o dashboard, altere `ESCOPO` (e `ESCOPO_TITULO`, a variante em caixa
// alta usada no título da aba). Tudo o mais é derivado: o nome no cabeçalho, o título
// da obra na citação ABNT, o título da página Sobre e a prosa que descreve o acervo.
//
// Por que existe: até a v1.50.0 o nome era literal em cinco lugares — e eles já tinham
// DIVERGIDO. O cabeçalho dizia "Análise histórica de produtos agrícolas", a página Sobre
// dizia "dos produtos agrícolas brasileiros", e a citação carregava uma terceira forma.
// O comentário em AppShell.jsx registra que os três níveis da citação já haviam divergido
// entre si uma vez e tiveram de ser reconciliados; a lição não tinha chegado ao nome.
//
// Por que o nome MUDOU (v1.50.0): "produtos agrícolas" descrevia menos de um terço do
// acervo. Medido em produção 2026-09-07, as bases de produção trazem 35 produtos, dos
// quais só 11 são lavouras — os outros 24 são pecuária e produtos de origem animal
// (bovino, suíno, leite, ovos, mel, LÃ, CASULOS DO BICHO-DA-SEDA), extração vegetal de
// floresta nativa (castanha-do-pará, açaí, madeira em tora, lenha, CARVÃO VEGETAL) e
// silvicultura de floresta plantada. Sericicultura e carvoaria não são agricultura por
// nenhuma leitura, e a própria citação se contradizia: a linha de autoria já dizia
// "EMPRESA BRASILEIRA DE PESQUISA AGROPECUÁRIA" sobre um título que dizia "agrícolas".
//
// UM nome, não dois. Uma variante curta para o cabeçalho e outra longa para a citação
// recriaria exatamente o defeito que este arquivo elimina.

// O recorte temático do acervo — a ÚNICA linha a mudar num renome futuro.
const ESCOPO = 'produtos agropecuários e florestais';

// A mesma coisa em caixa de título, para o <title> da aba (que é o único lugar onde o
// recorte aparece capitalizado). Muda JUNTO com ESCOPO — a capitalização de "e" e dos
// acentos não é derivável com segurança por código.
const ESCOPO_TITULO = 'Produtos Agropecuários e Florestais';

window.PRODUTO = {
  escopo: ESCOPO,
  escopoTitulo: ESCOPO_TITULO,
  // O nome da obra, em caixa de sentença (a forma da ABNT NBR 6023:2025).
  nome: `Análise histórica de ${ESCOPO}`,
  // O título na referência ABNT: o mesmo nome, precedido do tipo da obra.
  tituloCitacao: `Dashboard de análise histórica de ${ESCOPO}`,
  // O <title> da aba do navegador. Duplicado ESTATICAMENTE em index.html (o HTML é
  // servido antes do JS rodar, e uma aba sem nome até a hidratação seria pior), e essa
  // duplicação é fixada pelo teste produto.test.js — ela não pode divergir em silêncio.
  tituloAba: `Embrapa · Inteligência de Mercado · ${ESCOPO_TITULO}`,
};

// Reescreve o <title> a partir da constante, para que um renome futuro alcance a aba
// mesmo se alguém esquecer o index.html (o teste cobra, mas a tela não fica errada).
if (typeof document !== 'undefined') document.title = window.PRODUTO.tituloAba;
