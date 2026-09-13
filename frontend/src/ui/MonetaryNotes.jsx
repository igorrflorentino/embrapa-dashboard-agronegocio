// MonetaryNotes — two honest-labelling atoms for monetary series.
//
// ValueGapNote names the part of the window the chosen currency × correction cannot
// value. A SUM skips a NULL in silence: € sem correção only exists from 1999, COMEX
// starts in 1997, and a "1997–2026" total in euros was quietly a 1999–2026 total
// (v1.78.0). The server reports WHERE (`gap.years`), which of those years are missing
// only IN PART (`gap.partial` — the latest COMEX month, before its IPCA is ingested:
// measured 2026-09-13, every August 2026 row had no corrected value), and how much trade
// that leaves out, measured in the declared US$ that never goes missing (`gap.share`).
// A value computed over a subset must say which — and must not call a missing month a
// missing year.
//
// NominalSeriesNote says what a nominal series over many years is good for. The
// Multi-fonte and curated views have no conventions strip (they compare sources, not
// currencies), so nothing on screen claimed a correction — but "US$" alone over three
// decades invites reading a 1997 dollar as a 2025 one.

// "1997–1998" for a run of years; "1997, 1999 e 2003" otherwise.
function _anos(years) {
  const ys = [...new Set(years)].sort((a, b) => a - b);
  if (ys.length === 1) return String(ys[0]);
  const seguidos = ys.every((y, i) => i === 0 || y === ys[i - 1] + 1);
  if (seguidos) return `${ys[0]}–${ys[ys.length - 1]}`;
  return `${ys.slice(0, -1).join(', ')} e ${ys[ys.length - 1]}`;
}

function ValueGapNote({ gap, unit, alvo = 'soma' }) {
  if (!gap || !Array.isArray(gap.years) || !gap.years.length) return null;
  const parciais = (gap.partial || []).filter((y) => gap.years.includes(y));
  const inteiros = gap.years.filter((y) => !parciais.includes(y));
  const euro = unit === '€' && inteiros.length > 0 && inteiros.every((y) => y < 1999);
  const destino = alvo === 'médias' ? 'das médias' : 'da soma';
  // Uma fração pequena com zero casas vira "0%", que se lê como "não ficou nada de fora".
  const parte = typeof gap.share === 'number'
    ? ` — ${window.fmtPct(gap.share, gap.share < 0.1 ? 1 : 0)} do comércio do recorte, medido no US$ declarado`
    : '';
  // Quem fica de fora: anos inteiros, ou só uma parte de um ano — nunca "o ano" quando
  // faltou um mês.
  const sujeito = parciais.length
    ? 'Isso fica'
    : inteiros.length === 1 ? 'Esse ano fica' : 'Esses anos ficam';
  return (
    <p className="caption value-gap-note" style={{ marginTop: 8 }}>
      <strong>
        {inteiros.length > 0 && `Sem valor nesta convenção em ${_anos(inteiros)}.`}
        {inteiros.length > 0 && parciais.length > 0 && ' '}
        {parciais.length > 0 &&
          `${inteiros.length ? 'E parte' : 'Parte'} do comércio de ${_anos(parciais)} não tem valor nesta convenção.`}
      </strong>{' '}
      {euro && 'O euro só existe desde 1999, e a série sem correção não o converte para trás. '}
      {sujeito} fora {destino}{parte}.
    </p>
  );
}

function NominalSeriesNote() {
  return (
    <p className="caption nominal-series-note" style={{ padding: '10px 2px 2px' }}>
      Valores <strong>nominais</strong>, em dólar de cada ano: servem para comparar as séries
      entre si no mesmo ano, não para comparar anos distantes — um dólar de 1997 não vale
      um de hoje.
    </p>
  );
}

window.ValueGapNote = ValueGapNote;
window.NominalSeriesNote = NominalSeriesNote;
