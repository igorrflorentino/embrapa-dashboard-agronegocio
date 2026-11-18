// MonetaryNotes — three honest-labelling atoms for monetary series (ValueGapNote,
// NominalSeriesNote and HighInflationNote, the last one at the end of this header).
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
// IPCA is the first index offered for R$; the panel opens on Nominal since v1.88.0);
// missing at the END, an index not ingested yet.
//
// NominalSeriesNote says what a nominal series over many years is good for. The
// Multi-fonte and curated views have no conventions strip (they compare sources, not
// currencies), so nothing on screen claimed a correction — but "US$" alone over three
// decades invites reading a 1997 dollar as a 2025 one.
//
// The price base (v1.105.0): a corrected value is not "in today's money" — it is at the
// prices of ONE month, the latest of its index when the analytical base was built, and that
// month moves with every build. window.precosDe / cambioDe write the phrase from the
// server's `priceBase`; PriceBaseSkewNote says so when two values on one screen came back at
// two different months (a build between two reads). Deflating changes the unit; it adds no
// interest, and nothing here may suggest otherwise.

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

// ── O mês-base de um valor corrigido (v1.105.0) ─────────────────────────────────────────────
// `pb` é o `priceBase` do servidor: { column, month: 'AAAA-MM', fxDate: 'AAAA-MM-DD' | null },
// ou null. Espelha webapi/price_base.py: as mesmas palavras dos dois lados, porque o rótulo
// do servidor e a frase desta tela aparecem juntos.
const _PRECOS_SEM_MES = 'a preços do mês mais recente do índice';

// "outubro de 2026", ou null sem mês conhecido.
window.mesBase = (pb) => {
  const m = pb && typeof pb.month === 'string' ? /^(\d{4})-(\d{2})/.exec(pb.month) : null;
  const nome = m ? _MESES[Number(m[2]) - 1] : null;
  return nome ? `${nome} de ${m[1]}` : null;
};

// "a preços de outubro de 2026". Sem mês conhecido a frase continua verdadeira — todo valor
// corrigido está a preços do mês mais recente do seu índice —, só não o nomeia.
window.precosDe = (pb) => {
  const mes = window.mesBase(pb);
  return mes ? `a preços de ${mes}` : _PRECOS_SEM_MES;
};

// "ao câmbio de 14/11/2026" — o dia de PTAX de uma coluna cruzada (índice brasileiro sob
// US$ ou €). Sem o dia, "ao câmbio mais recente".
window.cambioDe = (pb) => {
  const d = pb && typeof pb.fxDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(pb.fxDate) : null;
  return d ? `ao câmbio de ${d[3]}/${d[2]}/${d[1]}` : 'ao câmbio mais recente';
};

// "soma de 1997 a 2026" — os anos que um total de vários anos REALMENTE soma (`sumRange`, os
// anos com valor na convenção; os que ela não alcança a nota de lacuna já nomeia). null sem
// período conhecido: a tela cala em vez de inventar um.
window.periodoDaSoma = (range) => {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [a, b] = range.map((y) => (y == null ? NaN : Number(y)));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a === b ? `soma de ${a}` : `soma de ${a} a ${b}`;
};

const _DESTINO = { soma: 'da soma', somas: 'das somas', 'médias': 'das médias' };

// Why the convention has no value there — only what can be said from the facts at hand.
function _motivo({ inteiros, parciais, unit, correcao, valuedRange }) {
  const corrigida = correcao && correcao !== 'Nominal';
  const [primeiro, ultimo] = Array.isArray(valuedRange) ? valuedRange : [];
  if (!corrigida && unit === '€' && inteiros.length && inteiros.every((y) => y < 1999)) {
    return 'O euro só existe desde 1999, e a série sem correção não o converte para trás.';
  }
  if (!corrigida) return null;
  // NENHUM ano tem valor: não é uma série que começa tarde nem um mês que falta no fim —
  // é um índice que ainda não foi ingerido. Sem esta frase o aviso diz "sem valor em
  // 1974–2026" e cala o motivo, que é justamente o único acionável (um `embrapa ingest`).
  if (primeiro == null && ultimo == null) {
    return `A série do ${correcao} ainda não entrou na base — nenhum ano tem valor nesta convenção.`;
  }
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
  // Outra correção, na mesma moeda, que alcança esses anos — o servidor PERGUNTOU aos dados
  // (v1.81.0): PAM/PPM em IPCA não têm 1974–1979, o IGP-DI tem.
  const alternativa = Array.isArray(gap.coveredBy) && gap.coveredBy.length && inteiros.length
    ? `${_lista(gap.coveredBy)} ${gap.coveredBy.length > 1 ? 'alcançam' : 'alcança'} ${inteiros.length === 1 ? 'esse ano' : 'esses anos'}. `
    : '';
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
      {alternativa && ` ${alternativa.trim()}`}
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
    if (primeiro == null && ultimo == null) {
      return `a série do ${correcao} ainda não entrou na base`;
    }
    if (primeiro != null && y < primeiro) {
      const outras = Array.isArray(gap.coveredBy) && gap.coveredBy.length ? gap.coveredBy : null;
      return outras
        ? `a série do ${correcao} não alcança esse ano (${_lista(outras.map((c) => `o ${c}`))} ${outras.length > 1 ? 'alcançam' : 'alcança'})`
        : `a série do ${correcao} não alcança esse ano`;
    }
    if (parciais.includes(y) || (ultimo != null && y > ultimo)) {
      return `o ${correcao} desse período ainda não entrou na base`;
    }
    return null;
  };
};

// ── Anos de inflação muito alta ─────────────────────────────────────────────────────────────
// O valor anual de cada produto é corrigido pela MÉDIA do índice do ano (v1.103.0; antes era o
// índice de dezembro, que subestimava os anos até 1994 em 1,1× a 3,5×). A média é o estimador
// certo para um fluxo de volume uniforme ao longo do ano, mas o IBGE só publica o valor do ano:
// não se sabe como ele se distribuiu entre os meses, e com inflação de dois dígitos por mês isso
// pesa. Medido em produção 2026-10-21: de 1987 a 1994, em CADA ano, houve pelo menos seis
// meses acima de 10% no IGP-DI (de 1995 a 2026: nenhum, o máximo mensal é 5,8%). Por isso os
// valores corrigidos dos anos até 1994 são indicativos — e a nota existe para que ninguém leia a
// série corrigida desses anos como uma trajetória real
// (docs/audits/deflacao_indice_medio_2026-10-21.md).
//
// Só vale para R$ corrigido por índice brasileiro: o nominal tem a sua própria regra (as
// reformas monetárias), e US$/€ só começam em 1994/1999. `start` é o primeiro ano que a tela
// mostra, e quem o calcula é o MainScreen, a partir da série filtrada: um `startDate` vazio quer
// dizer a cobertura inteira, não "não se sabe" (v1.104.2; até então a nota sumia na tela padrão).
// Sem início nenhum, não se afirma nada.
const _CORRECOES_DO_REAL = ['IPCA', 'IGP-M', 'IGP-DI'];
const _ULTIMO_ANO_INFLACAO_ALTA = 1994;

window.inflacaoAltaNoPeriodo = (conv, start) => {
  if (!conv || conv.currency !== 'BRL' || !_CORRECOES_DO_REAL.includes(conv.correction)) return false;
  if (start == null || start === '') return false;
  const ano = Number(String(start).slice(0, 4));
  return Number.isFinite(ano) && ano <= _ULTIMO_ANO_INFLACAO_ALTA;
};

function HighInflationNote({ conventions, start }) {
  if (!window.inflacaoAltaNoPeriodo(conventions, start)) return null;
  return (
    <p className="caption high-inflation-note" style={{ marginTop: 8 }}>
      <strong>Valores corrigidos de anos até {_ULTIMO_ANO_INFLACAO_ALTA} são indicativos.</strong>{' '}
      A inflação era muito alta (de 1987 a 1994, mais de 10% ao mês em pelo menos seis meses de
      cada ano), e o valor anual é corrigido pela média do índice do ano, sem saber como ele se
      distribuiu entre os meses. Comparar esses anos com 1995 em diante pode distorcer.
    </p>
  );
}

// ── Dois meses-base numa tela só ────────────────────────────────────────────────────────────
// Toda leitura de uma tela vem do mesmo build, mas o servidor guarda cada uma por 10 minutos:
// uma feita antes de um build e outra feita depois chegam a preços de meses diferentes — o
// snapshot, os cubos (por UF e por município) e as leituras próprias de uma perspectiva. A nota
// não escolhe um dos meses — diz que diferem, e que a próxima leitura os iguala. `bases` são
// `priceBase`s (null ignorado); `database`/`conventions`, quando vierem, juntam a base do
// snapshot à comparação.
//
// `jaComparadas`: bases que OUTRO aviso desta mesma tela já confronta com o snapshot — o da
// MainScreen, com os cubos de applyFilters. Se elas já divergem, aquele aviso está na tela e
// este não o repete; se não, entram na conta junto com as desta perspectiva.
function _mesesNaTela(bases, database, conventions) {
  const doSnapshot = database && window.priceBaseFor ? window.priceBaseFor(database, conventions) : null;
  const meses = new Set();
  for (const pb of [doSnapshot, ...(bases || [])]) {
    if (window.mesBase(pb)) meses.add(pb.month.slice(0, 7));
  }
  // 'AAAA-MM' ordena como data: o aviso lista os meses em ordem, não na ordem das leituras.
  return [...meses].sort().map((m) => window.mesBase({ month: m }));
}

function PriceBaseSkewNote({ bases, jaComparadas, database, conventions }) {
  if (jaComparadas && _mesesNaTela(jaComparadas, database, conventions).length >= 2) return null;
  const meses = _mesesNaTela([...(jaComparadas || []), ...(bases || [])], database, conventions);
  if (meses.length < 2) return null;
  return (
    <p className="caption price-base-skew-note" style={{ marginTop: 8 }}>
      <strong>Valores desta tela a preços de meses diferentes: {_lista(meses)}.</strong>{' '}
      A base analítica foi atualizada entre duas leituras. Recarregue a página em alguns minutos
      para ler tudo no mesmo mês.
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

// The year list in pt-BR, shared so no screen writes its own ("1986, 1989 e 1994").
window.listaAnosBR = _anos;
window.ValueGapNote = ValueGapNote;
window.NominalSeriesNote = NominalSeriesNote;
window.HighInflationNote = HighInflationNote;
window.PriceBaseSkewNote = PriceBaseSkewNote;
