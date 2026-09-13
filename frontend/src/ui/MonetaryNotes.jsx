// MonetaryNotes — two honest-labelling atoms for monetary series.
//
// ValueGapNote names the part of the window the chosen currency × correction cannot
// value. A SUM skips a NULL in silence: € sem correção only exists from 1999, COMEX
// starts in 1997, and a "1997–2026" total in euros was quietly a 1999–2026 total
// (v1.78.0). The server reports WHERE (`gap.years`), which of those years are missing
// only IN PART (`gap.partial` — the latest COMEX month, before its deflator index is
// ingested: measured 2026-09-13, every August 2026 row had no IPCA value), which MONTHS
// those are when it knows (`gap.months`, COMEX's month-level list — v1.79.0), the first
// and last year WITH value (`gap.valuedRange`, so the note can say WHY — v1.80.0), and how
// much trade that leaves out, measured in the declared US$ that never goes missing
// (`gap.share`, only where the reader can measure the selection). A value computed over a
// subset must say which — and must not call a missing month a missing year.
//
// The WHY, from what the note knows (and only then): € sem correção before 1999 is the
// euro's own birth; a corrected convention missing at the START of the history is an
// index series that does not reach that far (PAM/PPM have no IPCA in 1974–1979 — and
// R$ · IPCA is the dashboard's default); missing at the END, an index not ingested yet.
//
// NominalSeriesNote says what a nominal series over many years is good for. The
// Multi-fonte and curated views have no conventions strip (they compare sources, not
// currencies), so nothing on screen claimed a correction — but "US$" alone over three
// decades invites reading a 1997 dollar as a 2025 one.

const _MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

// "a, b e c" — the pt-BR list.
function _lista(itens) {
  if (itens.length <= 1) return itens.join('');
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

// "1997–1998" for a run of years; "1997, 1999 e 2003" otherwise.
function _anos(years) {
  const ys = [...new Set(years)].sort((a, b) => a - b);
  if (ys.length === 1) return String(ys[0]);
  const seguidos = ys.every((y, i) => i === 0 || y === ys[i - 1] + 1);
  if (seguidos) return `${ys[0]}–${ys[ys.length - 1]}`;
  return _lista(ys.map(String));
}

// A partial year, with its missing months when the server named them: "2026 (agosto)".
function _anoParcial(y, months) {
  const ms = months && months[String(y)];
  if (!Array.isArray(ms) || !ms.length) return String(y);
  return `${y} (${_lista(ms.map((m) => _MESES[m - 1]).filter(Boolean))})`;
}

const _DESTINO = { soma: 'da soma', somas: 'das somas', 'médias': 'das médias' };

// Why the convention has no value there — only what can be said from the facts at hand.
function _motivo({ inteiros, parciais, unit, correcao, valuedRange }) {
  const corrigida = correcao && correcao !== 'Nominal';
  const [primeiro, ultimo] = Array.isArray(valuedRange) ? valuedRange : [];
  if (!corrigida && unit === '€' && inteiros.length && inteiros.every((y) => y < 1999)) {
    return 'O euro só existe desde 1999, e a série sem correção não o converte para trás.';
  }
  if (!corrigida) return null;
  const antes = inteiros.filter((y) => primeiro != null && y < primeiro);
  const depois = parciais.length || inteiros.some((y) => ultimo != null && y > ultimo);
  if (antes.length && antes.length === inteiros.length && !parciais.length) {
    return `A série do ${correcao} não alcança ${antes.length === 1 ? 'esse ano' : 'esses anos'}.`;
  }
  if (depois && !antes.length) return `O ${correcao} desse período ainda não entrou na base.`;
  return null;
}

function ValueGapNote({ gap, unit, correcao, alvo = 'soma' }) {
  if (!gap || !Array.isArray(gap.years) || !gap.years.length) return null;
  const parciais = (gap.partial || []).filter((y) => gap.years.includes(y));
  const inteiros = gap.years.filter((y) => !parciais.includes(y));
  const motivo = _motivo({ inteiros, parciais, unit, correcao, valuedRange: gap.valuedRange });
  const destino = _DESTINO[alvo] || _DESTINO.soma;
  // Uma fração pequena com zero casas vira "0%", que se lê como "não ficou nada de fora".
  const parte = typeof gap.share === 'number'
    ? ` — ${window.fmtPct(gap.share, gap.share < 0.1 ? 1 : 0)} do comércio do recorte, medido no US$ declarado`
    : '';
  // Quem fica de fora: anos inteiros, ou só uma parte de um ano — nunca "o ano" quando
  // faltou um mês.
  const sujeito = parciais.length
    ? 'Isso fica'
    : inteiros.length === 1 ? 'Esse ano fica' : 'Esses anos ficam';
  const parcialTexto = parciais.length > 1 && !gap.months
    ? _anos(parciais)
    : _lista(parciais.map((y) => _anoParcial(y, gap.months)));
  return (
    <p className="caption value-gap-note" style={{ marginTop: 8 }}>
      <strong>
        {inteiros.length > 0 && `Sem valor nesta convenção em ${_anos(inteiros)}.`}
        {inteiros.length > 0 && parciais.length > 0 && ' '}
        {parciais.length > 0 &&
          `${inteiros.length ? 'E parte' : 'Parte'} do comércio de ${parcialTexto} não tem valor nesta convenção.`}
      </strong>{' '}
      {motivo && `${motivo} `}
      {sujeito} fora {destino}{parte}.
    </p>
  );
}

// The snapshot's gap is the WHOLE history; a screen shows a period. Keeps only the years
// inside [start, end] (dates or years — only the leading 4 digits are read), so a note
// never names a hole the screen is not showing. null when nothing is left.
window.windowValueGap = (gap, start, end) => {
  if (!gap || !Array.isArray(gap.years)) return null;
  const ano = (v) => (v == null || v === '' ? null : Number(String(v).slice(0, 4)));
  const y0 = ano(start);
  const y1 = ano(end);
  const dentro = (y) => (y0 == null || y >= y0) && (y1 == null || y <= y1);
  const years = gap.years.filter(dentro);
  if (!years.length) return null;
  return { ...gap, years, partial: (gap.partial || []).filter(dentro) };
};

// The same WHY, per year, for the "Variação acumulada" refusal (window.deltaTitle's
// `motivo`): (year) → a lowercase phrase, or null when the gap does not name that year or
// the facts do not settle the cause. `conv` is the active {currency, correction}.
window.valueGapMotivo = (gap, conv) => {
  if (!gap || !Array.isArray(gap.years) || !gap.years.length) return null;
  const correcao = conv && conv.correction;
  const corrigida = correcao && correcao !== 'Nominal';
  const [primeiro, ultimo] = Array.isArray(gap.valuedRange) ? gap.valuedRange : [];
  const parciais = gap.partial || [];
  return (y) => {
    if (!gap.years.includes(y)) return null;
    if (!corrigida) {
      return conv && conv.currency === 'EUR' && y < 1999 ? 'o euro só existe desde 1999' : null;
    }
    if (primeiro != null && y < primeiro) return `a série do ${correcao} não alcança esse ano`;
    if (parciais.includes(y) || (ultimo != null && y > ultimo)) {
      return `o ${correcao} desse período ainda não entrou na base`;
    }
    return null;
  };
};

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
