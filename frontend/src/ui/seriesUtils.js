// seriesUtils.js — shared series analytics + the categorical viz scale.
//
// Single source of truth for the comparison perspectives (ViewProductCompare,
// ViewCrossSource) and any chart that paints a categorical series. These
// helpers used to be COPY-PASTED verbatim across those views (growth /
// pearson / cagr / corrColor) and the 10-stop color array was duplicated in
// dataFilters.js and ViewValueVolume.jsx. Centralised here so a fix lands in
// one place. Loaded right after data.js (see src/main.jsx import order).

// ── Categorical color scale (the 10-stop --viz ramp) ───────────────────
// Token references only — never raw hex (see colors_and_type.css · --viz-*).
// Consumers that need overflow stops append their own grays.
window.VIZ_SCALE = [
  'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)',
  'var(--viz-6)', 'var(--viz-7)', 'var(--viz-8)', 'var(--viz-9)', 'var(--viz-10)',
];
// ── Ausência vs. zero ──────────────────────────────────────────────────
// Uma medida AUSENTE (o deflator ou a moeda escolhida não alcança aquele ano — IPCA
// começa em 1980 e a PAM em 1974; o euro só existe desde 1999) chega como `null` do
// serializer (_measure) e tem de CONTINUAR null até a tela. Coagir para 0 fazia o
// gráfico desenhar uma reta no zero por 6 a 25 anos e a "variação acumulada" dividir
// por esse zero e imprimir "+0%" — uma afirmação que o dado nunca fez.
//
// Estes três helpers são o único lugar onde essa distinção mora. Todo somatório e
// toda razão entre extremos passam por aqui; nenhum call site reimplementa a guarda.

// Acumulador que PRESERVA a ausência: soma o que existe e devolve `null` enquanto
// nada existir. Começa de `null` (não de 0), por isso um ano sem NENHUM produto
// presente termina ausente em vez de virar um zero afirmativo.
window.addPresent = (acc, v) => (Number.isFinite(v) ? (acc == null ? 0 : acc) + v : acc);

// A forma de array do acumulador acima. `null` só quando não havia NADA a somar —
// uma cesta em que só ALGUNS produtos existem naquele ano soma os presentes, que é a
// leitura correta (dado parcial), não ausência.
window.sumPresent = (values) => (values || []).reduce((acc, v) => window.addPresent(acc, v), null);

// Reescala uma medida PRESERVANDO a ausência. Existe porque em JS `null * 1e9 === 0`:
// toda view que convertia a série para a escala absoluta (`d.v * 1e9`) re-fabricava
// silenciosamente o zero que o serializer tinha acabado de eliminar. Aritmética direta
// sobre uma medida que pode faltar é sempre um bug; passe por aqui.
window.scalePresent = (v, factor) => (Number.isFinite(v) ? v * factor : null);

// Razão entre duas medidas (preço = valor/quantidade, participação = parte/total),
// preservando a ausência e recusando denominador não-positivo. Devolve null — que a
// tela mostra como '—' — em vez do 0 que os call sites usavam como fallback.
window.ratioPresent = (num, den) => {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
};

// Piso de materialidade sobre uma razão. Uma razão (rendimento = t/ha, preço =
// valor/quantidade) mede INTENSIDADE, e intensidade medida sobre uma base minúscula
// não é uma medida — é o arredondamento da fonte. Medido na PAM 2024: o DF aparecia
// como a UF mais produtiva em cana-de-açúcar com 205 ha, 0,002% da área nacional, e
// "85.000 kg/ha" redondo; o abacaxi tinha o mesmo DF no topo com 6 ha.
//
// DUAS provas, e passar em UMA basta — porque há duas razões diferentes para uma UF
// merecer entrar num ranking nacional, e exigir as duas exclui quem tem direito:
//   · minShare — ela PESA na lavoura (fração do recorte). Um piso só absoluto seria
//     cego à escala: 1.000 ha é muita castanha de caju e nada de soja.
//   · minAbs  — a base é grande o bastante para a medida se sustentar SOZINHA, ainda
//     que a UF seja coadjuvante nacional. Um piso só relativo derrubava Sergipe com
//     50 mil ha de cana (0,49% de uma lavoura de 10,1 mi ha) e o Tocantins com 36
//     mil — rendimentos perfeitamente medidos, e o TO é o líder REAL da lavoura.
//
// A calibração de minAbs não é chute: varrendo as 11 lavouras da PAM 2024, um
// rendimento múltiplo EXATO de 1.000 kg/ha — assinatura do arredondamento da fonte —
// aparece em 20% das UFs abaixo de 100 ha, 6,7% entre 100 e 300 ha e em ZERO acima
// de 300 ha. 1.000 ha fica com folga do outro lado dessa fronteira.
//
// Devolve { kept, dropped, total, shareOf } — nunca esconde: quem chama é obrigado a
// receber os descartados para poder NOMEÁ-LOS na tela (regra do projeto: filtragem
// invisível é proibida). Base ausente ou não-positiva ⇒ o piso não discrimina e tudo
// passa; se o piso derrubasse TODO mundo ele também não discrimina, e devolver tudo
// é melhor que um gráfico vazio.
window.materialityFloor = (rows, key, { minShare = 0, minAbs = 0 } = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const total = window.sumPresent(list.map((r) => Number(r && r[key])));
  const shareOf = (r) => window.ratioPresent(Number(r && r[key]), total);
  if (!Number.isFinite(total) || total <= 0) return { kept: list, dropped: [], total: null, shareOf };
  // Um piso não configurado é uma prova INEXISTENTE, não uma prova que todo mundo
  // passa: com `minAbs = 0`, `area >= 0` é verdade sempre e a metade relativa morreria
  // em silêncio — um piso ligado que não filtra nada é pior que piso nenhum.
  const provas = [];
  if (minShare > 0) provas.push((r) => { const sh = shareOf(r); return sh != null && sh >= minShare; });
  if (minAbs > 0) provas.push((r) => { const v = Number(r && r[key]); return Number.isFinite(v) && v >= minAbs; });
  if (!provas.length) return { kept: list, dropped: [], total, shareOf };
  const kept = [], dropped = [];
  list.forEach((r) => { (provas.some((f) => f(r)) ? kept : dropped).push(r); });
  if (!kept.length) return { kept: list, dropped: [], total, shareOf };
  return { kept, dropped, total, shareOf };
};

// A calibração do piso para ÁREA COLHIDA, ao lado da regra que o aplica em vez de
// escondida no cálculo. Medido nas 11 lavouras da PAM 2024: nenhuma UF excluída
// chega a 1.000 ha (a maior tem 972), nenhum ranking de 12 fica vazio, e o topo muda
// em 3 das 11 — sempre tirando de lá uma UF de área desprezível.
window.AREA_FLOOR = { minShare: 0.005, minAbs: 1000 };

// A calibração do piso para PRODUÇÃO — e ela tem SÓ a prova relativa, de propósito.
//
// A pergunta aqui é outra que a do rendimento. "Qual UF mais exporta o que produz" só
// faz sentido para quem PRODUZ aquilo, e isso é inerentemente relativo à lavoura; já o
// rendimento é uma medida física, cuja validade depende do tamanho ABSOLUTO da amostra
// (daí o minAbs de 1.000 ha em AREA_FLOOR). Um piso absoluto aqui não teria valor
// possível: os agrupamentos vão de 910 mil t (castanha-do-pará) a 2,17 bilhões de mil t
// (soja) — quatro ordens de grandeza. Pernambuco tem 1.000 t de soja, o que passaria
// folgado em qualquer absoluto razoável, e é 0,00005% da soja do país.
//
// 0,01% medido em produção 2026-09-07 sobre os 10 agrupamentos calculáveis: coeficientes
// acima de 100% se concentram abaixo de 0,001% de participação (7 de 11 linhas, mediana
// 747%), somem a partir de 0,01% (zero em 63 linhas entre 0,01% e 0,5%) e a única
// exceção acima do piso é São Paulo na soja — 127,9% com 2,9% da produção nacional, que
// é o porto de Santos reexportando, exatamente o caso legítimo que o aviso do card
// descreve. O piso separa o artefato do fenômeno, e não os dois do resto.
window.PRODUCAO_FLOOR = { minShare: 0.0001 };

// A calibração do piso do PREÇO MÉDIO por parceiro, em mil t (a unidade que o serializer
// entrega). Espelha `_PARTNER_PRICE_FLOOR` no serializers.py, que é quem APLICA o corte
// — o SQL não tem LIMIT e o `head` do serializer é o top-N, então um piso a jusante
// receberia uma página já feita só de artefatos. Aqui os números existem para a nota
// poder enunciar a regra que o servidor aplicou, e o teste de paridade prende os dois.
window.PARTNER_PRICE_FLOOR = { minShare: 0.00001, minAbs: 0.1 };

// Diferença entre duas medidas, preservando a ausência. Para grandezas que já são
// percentuais (uma participação de mercado, por exemplo), onde a variação se declara em
// PONTOS PERCENTUAIS e não em variação relativa — deltaPct responderia outra pergunta.
window.diffPresent = (a, b) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a - b;
};

// Variação entre dois extremos, em PERCENTUAL — ou `null` quando a pergunta não tem
// resposta. Não tem resposta quando falta um dos extremos, ou quando a base não é
// positiva: nesses casos a razão é indefinida, e o `: 0` que estava aqui antes a
// respondia com "não variou". Os formatadores (fmtSigned/numBR/pctBR) já renderizam
// null como '—', então devolver null é o que faz a tela dizer a verdade.
//
// A INCOMENSURABILIDADE entre moedas (nominal cruzando uma reforma monetária) NÃO é
// tratada aqui de propósito: ela não é ausência, e o usuário precisa do MOTIVO, não
// só de um traço. Quem decide isso é window.spanComparable, com a fronteira vinda do
// seed historical_currency_factors via /api (nunca um 1994 chumbado no código).
window.deltaPct = (v0, vT) => {
  if (!Number.isFinite(v0) || !Number.isFinite(vT) || v0 <= 0) return null;
  return ((vT - v0) / v0) * 100;
};

// A segunda razão para uma variação não ter resposta: os extremos EXISTEM mas estão em
// MOEDAS DIFERENTES. Em valores nominais, 1974 está em mil cruzeiros e 2024 em reais;
// a razão entre eles é aritmeticamente exata e semanticamente lixo (+5.237.412.820.780.295%
// para o abacaxi, medido em produção). `breaks` são os anos de reforma que o backend
// manda em snapshot.valueEraBreaks — VAZIO em toda convenção deflacionada ou em moeda
// estrangeira, então esta checagem só morde onde deve.
window.spanComparable = (y0, yT, breaks) => {
  const cortes = (breaks || []).filter((b) => Number.isFinite(y0) && Number.isFinite(yT) && y0 < b && b <= yT);
  if (!cortes.length) return null;
  const de = Math.min(...cortes), ate = Math.max(...cortes);
  return de === ate
    ? `moeda mudou em ${de} — valores nominais não são comparáveis`
    : `moeda mudou ${cortes.length}× (${de}–${ate}) — valores nominais não são comparáveis`;
};

// Os cortes de moeda do banco ativo, lidos do snapshot já carregado. Um banco ainda
// sem snapshot devolve [] — sem checagem é o comportamento antigo (permissivo), nunca
// um KPI em branco por causa de um dado auxiliar que não chegou.
window.valueEraBreaksFor = (bancoId) => {
  const snap = window.dataStore && window.dataStore.get ? window.dataStore.get(bancoId) : null;
  return (snap && snap.valueEraBreaks) || [];
};

// A variação entre dois PONTOS, ciente das duas razões de recusa (ausência e moeda).
// É o que as views chamam; window.deltaPct continua sendo o primitivo numérico puro.
window.deltaPctIn = (p0, pT, breaks) => {
  if (!p0 || !pT) return null;
  if (window.spanComparable(p0.y, pT.y, breaks)) return null;
  return window.deltaPct(p0.v, pT.v);
};

// POR QUE a variação entre dois extremos não pôde ser calculada — em pt-BR, pronto
// para concatenar no título. Devolve null quando ela PÔDE ser calculada, então o call
// site não precisa de condicional. Um traço sozinho ("Variação acumulada: —") deixa o
// pesquisador sem saber se o dado falta, se a base é zero ou se a tela quebrou; o
// motivo é a diferença entre uma recusa honesta e um silêncio.
window.deltaWhyNot = (p0, pT, breaks) => {
  if (!p0 || !pT) return 'série sem extremos';
  // A moeda vem ANTES da ausência: quando os dois extremos existem mas em moedas
  // diferentes, o motivo verdadeiro é a reforma, não a falta de dado.
  const moeda = window.spanComparable(p0.y, pT.y, breaks);
  if (moeda) return moeda;
  if (window.deltaPct(p0.v, pT.v) != null) return null;
  if (!Number.isFinite(p0.v)) return `sem valor em ${p0.y} nesta convenção`;
  if (p0.v <= 0) return `valor nulo em ${p0.y}`;
  if (!Number.isFinite(pT.v)) return `sem valor em ${pT.y} nesta convenção`;
  return 'extremos não comparáveis';
};

// O título completo de uma métrica de variação: o número quando existe, o traço MAIS o
// motivo quando não existe. Centralizado para que as quatro perspectivas que mostram
// "Variação acumulada" não divirjam na forma de recusar.
window.deltaTitle = (rotulo, p0, pT, opts = {}) => {
  const { digits = 0, breaks = null } = opts;
  const why = window.deltaWhyNot(p0, pT, breaks);
  const valor = window.fmtSigned(window.deltaPctIn(p0, pT, breaks), digits);
  return why ? `${rotulo}: ${valor} · ${why}` : `${rotulo}: ${valor}`;
};

// Média que IGNORA os ausentes (não os conta como zero no numerador nem no
// denominador). null quando nada existe — 'sem média', não 'média zero'.
window.meanPresent = (values) => {
  const presentes = (values || []).filter((v) => Number.isFinite(v));
  return presentes.length ? presentes.reduce((s, v) => s + v, 0) / presentes.length : null;
};

// A DIREÇÃO de uma variação para o KPI: true (subiu), false (caiu) ou `null` — que
// não é "caiu", é "não há variação a apontar". Irmão de deltaColor: mesma pergunta,
// saída para a seta em vez de para a cor.
//
// Existe porque cada call site respondia isso à mão, de três formas diferentes e
// todas erradas na ausência: `d >= 0` (null vira VERDE), `d != null && d >= 0` (null
// vira FALSE, e o átomo lê false como vermelho) e — pior — comparando as MEDIDAS
// CRUAS em vez da variação (`last.q >= prev.q`), que colore a seta a partir de uma
// grandeza diferente da que o número mostra. As três só divergem onde importa.
window.deltaUp = (d) => (Number.isFinite(d) ? d >= 0 : null);

// A cor de uma variação: verde/vermelho quando ela EXISTE, neutra quando não. Existe
// porque `null >= 0` é true em JS — a comparação ingênua pintava o travessão de uma
// métrica indisponível com a cor de crescimento positivo.
window.deltaColor = (v) =>
  (!Number.isFinite(v) ? 'var(--fg-4)' : v >= 0 ? 'var(--ok)' : 'var(--err)');

// ── Índice base 100 ────────────────────────────────────────────────────
// O ano-base de um gráfico "base 100" tem de ser um ano em que TODAS as séries
// exibidas têm medida. Antes, cada série era indexada pelo seu próprio primeiro ponto
// da janela e, quando esse ponto faltava, o `: 0` fazia a série INTEIRA virar uma reta
// no zero — sem número suspeito na tela, só uma linha plausível e falsa. Comparar duas
// séries indexadas a anos-base DIFERENTES também não compara nada, então a base é uma
// só, comum, e o rótulo do gráfico diz qual é.
window.commonBaseYear = (seriesList, key = 'v') => {
  const listas = (seriesList || []).map((pts) =>
    new Set((pts || []).filter((d) => Number.isFinite(d && d[key]) && d[key] > 0).map((d) => d.y)));
  if (!listas.length || listas.some((s) => s.size === 0)) return null;
  const [primeira, ...resto] = listas;
  const comuns = [...primeira].filter((y) => resto.every((s) => s.has(y)));
  return comuns.length ? Math.min(...comuns) : null;
};

// Indexa uma série a 100 no ano-base, PRESERVANDO a ausência (ano sem medida continua
// sem ponto, virando lacuna). Base ausente ⇒ a série inteira é ausente — o que a tela
// mostra como "sem linha", nunca como uma linha no zero.
window.indexTo100 = (pts, baseYear, key = 'v') => {
  const base = (pts || []).find((d) => d.y === baseYear);
  const b = base && base[key];
  return (pts || []).map((d) => ({
    y: d.y,
    v: window.scalePresent(window.ratioPresent(d[key], b), 100),
  }));
};

// ── Series statistics ──────────────────────────────────────────────────
// Pearson correlation between two equal-intent arrays (truncated to the
// shorter length). Returns 0 when undefined (n < 2 or zero variance).
window.pearson = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const xa = a[i] - ma, xb = b[i] - mb; num += xa * xb; da += xa * xa; db += xb * xb; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
};

// Year-aware Pearson on YoY growth: aligns the two point series by their YEAR
// (point.y), NOT by array index, then correlates growth over the common,
// calendar-adjacent year pairs. (O pareamento por ÍNDICE que existia antes desalinhava
// assim que uma série tinha lacuna interna de ano; foi removido na v1.51.0 junto com o
// helper morto que o alimentava.) Para séries sem lacuna e nos mesmos anos, o resultado
// é idêntico ao daquele caminho.
window.pearsonByYear = (ptsA, ptsB, key = 'v') => {
  const ma = new Map((ptsA || []).map(d => [d.y, d[key]]));
  const mb = new Map((ptsB || []).map(d => [d.y, d[key]]));
  const years = [...ma.keys()].filter(y => mb.has(y)).sort((x, y) => x - y);
  const ga = [], gb = [];
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] !== 1) continue;  // growth only across adjacent years
    const a0 = ma.get(years[i - 1]), a1 = ma.get(years[i]);
    const b0 = mb.get(years[i - 1]), b1 = mb.get(years[i]);
    // Um par sem crescimento DEFINIDO (extremo ausente ou base não-positiva) é
    // DESCARTADO, não empurrado como 0. Injetar zeros inventava pares "sem
    // variação" e puxava a correlação para dentro — a série de 1974-79 sem
    // deflator viraria seis anos de "cresceu 0%" correlacionando com qualquer coisa.
    const gaV = window.deltaPct(a0, a1), gbV = window.deltaPct(b0, b1);
    if (gaV == null || gbV == null) continue;
    ga.push(gaV / 100);
    gb.push(gbV / 100);
  }
  return window.pearson(ga, gb);
};

// Compound annual growth rate, in PERCENT, over `periods` intervals. `periods` MUST be
// the calendar-YEAR span (last.y - first.y), NOT the array length: per-product series are
// ragged (the backend emits only existing (code, year) rows, no padding to a common axis),
// so an internal year gap makes the element count smaller than the true span and would
// overstate the annualized rate. Derive it via window.spanYears(pts).
window.cagrPct = (v0, vT, periods) => {
  const p = periods > 0 ? periods : 1;
  // Mesma guarda de deltaPct: sem os dois extremos, ou com base não-positiva, a taxa
  // é indefinida — devolve null ('—' na tela), nunca 0 ("cresceu 0% ao ano").
  if (!Number.isFinite(v0) || !Number.isFinite(vT) || v0 <= 0) return null;
  return (Math.pow(vT / v0, 1 / p) - 1) * 100;
};
// Accumulated change from v0 to vT, in PERCENT — null when the pair is not comparable.
window.accumPct = (v0, vT) => window.deltaPct(v0, vT);
// Calendar-year span of a year-sorted points array (last.y - first.y) — the correct
// `periods` argument for cagrPct. Falls back to 1 for a single/empty series (avoids a
// degenerate 1/0 exponent). Centralizes the expression so ViewProductCompare and
// ViewCrossSource cannot drift apart.
window.spanYears = (pts) => {
  const a = pts || [];
  return (a.length ? a[a.length - 1]?.y - a[0]?.y : 0) || 1;
};
// Per-year stacked total max across ragged layers, aligned BY YEAR (.y) not by array
// index. Layers can differ in length (a product introduced later has a shorter series),
// so index-summing either throws on the short layer (`l.data[i]` undefined) or silently
// drops the longer layer's tail years. Mirrors the StackedArea axis-max computation.
window.stackYearMax = (layers, key = 'v') => {
  const totals = {};
  (layers || []).forEach((l) => (l.data || []).forEach((d) => {
    const v = Number(d[key]);
    if (Number.isFinite(v)) totals[d.y] = (totals[d.y] || 0) + v;
  }));
  return Math.max(0, ...Object.values(totals));
};

// Ordinary-least-squares linear trend over points keyed by `.y` (x = year) and a
// value key. Returns { slope, intercept, predict(x), line } where `line` is the
// two endpoints [{y:xmin,…},{y:xmax,…}] ready to plot as a straight dashed trace
// (the "linha de tendência" overlay). Returns null when fewer than 2 finite points
// or zero x-variance — the caller then simply draws no trend line.
window.linearFit = (pts, key = 'v') => {
  const xs = [], ys = [];
  (pts || []).forEach((d) => {
    // `Number(null) === 0` e `Number.isFinite(0)` é true: o par (ano, null) passava
    // por esta peneira COMO ZERO e puxava a reta para baixo — a tendência da PAM em
    // BRL/IPCA era ajustada sobre seis anos de zero que ninguém mediu. Descartar a
    // ausência ANTES de converter é o que separa "não medido" de "medido zero".
    if (d == null || d[key] == null) return;
    const x = Number(d.y), y = Number(d[key]);
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  });
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; num += dx * (ys[i] - my); den += dx * dx; }
  if (!den) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  const predict = (x) => slope * x + intercept;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  return { slope, intercept, predict, line: [{ y: x0, [key]: predict(x0) }, { y: x1, [key]: predict(x1) }] };
};

// Correlation-cell tint. Positive → institutional green, negative → terracotta
// error token, alpha scaled by |r| (0.12 floor → 0.72 at |r|=1). Token-driven
// via color-mix so it tracks the palette — never a raw rgba() literal.
window.corrColor = (r) => {
  const token = r >= 0 ? 'var(--ok)' : 'var(--err)';
  const pct = Math.round((0.12 + Math.abs(r) * 0.6) * 100);
  return `color-mix(in srgb, ${token} ${pct}%, transparent)`;
};
