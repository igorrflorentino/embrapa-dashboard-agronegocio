// italico.jsx — foreign terms in italics, for text that lives in DATA.
//
// Editorial rule (CLAUDE.md § Code Style → Language, "Editorial control"): a foreign
// concept kept for lack of a native word — drawback, commodity, the layer names Silver /
// Gold / Serving — is set in italics in long text; labels and buttons are not. JSX prose
// writes <em> directly. Text that lives in a registry (glossary entries, view and layer
// descriptions) marks the term as *termo*, and window.comItalico turns the mark into <em>
// where the text is rendered.
//
// A sink that only takes plain text — a native `title` tooltip, which the BROWSER draws,
// or a search index — goes through window.textoSimples, which drops the mark. Italics
// cannot be shown there at all; what matters is that no stray asterisk reaches the screen.
// editorialGuard.test.js keeps the mark confined to the registries rendered through here.

// An opener must START a word and a closer must END one, so the asterisks inside a column
// family such as val_real_*_brl or val_yearfx_* are never read as marks.
const MARCA = /(^|[\s(“"'‘—–-])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s.,;:!?)”"'’—–-])/g;

function textoSimples(texto) {
  return typeof texto === 'string' ? texto.replace(MARCA, '$1$2') : texto;
}

function comItalico(texto) {
  if (typeof texto !== 'string' || !texto.includes('*')) return texto;
  const partes = [];
  let fim = 0;
  for (const m of texto.matchAll(MARCA)) {
    const ini = m.index + m[1].length;
    if (ini > fim) partes.push(texto.slice(fim, ini));
    partes.push(<em key={partes.length}>{m[2]}</em>);
    fim = m.index + m[0].length;
  }
  if (!fim) return texto;
  if (fim < texto.length) partes.push(texto.slice(fim));
  return partes;
}

window.textoSimples = textoSimples;
window.comItalico = comItalico;
