// ViewProductProfile — deep dive into a SINGLE commodity.
// Only meaningful for bancos that provide the 'product' capability.
// Honours active filters: the product selector is limited to the
// basket (filtered.selectedProducts); value/qty respect conventions.

// window.recorteNaoSeAplica — a real dependency, not one main.jsx's import order happens
// to satisfy: the view's tests load it on its own.
import './RecorteNote.jsx';
// window.countProductUnit — what a count product counts, named on every label below.
import './countUnits.js';
// window.CollapsingNameList — names the years whose price rests on part of the value.
import './CollapsingNameList.jsx';
// window.valueGapMotivo — WHY a year has no value in the chosen convention.
import './MonetaryNotes.jsx';

const { useState: usePPState } = React;

function ViewProductProfile({ families, summary, database, conventions }) {
  const conv     = conventions || window.DEFAULT_CONVENTIONS;
  const monLabel = window.conventionMonetaryLabel(conv);
  const fx       = window.CURRENCY_FX[conv.currency];
  const cvf      = window.convFactor(conv);   // base-aware value factor (corr × rate ÷ baseRate)

  const filtered = window.applyFilters(summary || {}, database);
  const available = filtered.selectedProducts.filter(c => filtered.allProductTS[c]);
  const hasGeo = filtered.ufDataFull.length > 0;
  // Code scheme label — declared per banco in bancos.js (dimensions.product),
  // not branched on bancoId here.
  const codeLabel = window.bancoDim(database, 'product').codeLabel || 'Código';

  // Selected product (default = largest by latest value within basket)
  const defaultCode = (() => {
    if (!available.length) return null;
    return available
      .map(c => ({ c, v: filtered.allProductTS[c].slice(-1)[0]?.v || 0 }))
      .sort((a, b) => b.v - a.v)[0].c;
  })();
  const [code, setCode] = usePPState(defaultCode);
  const activeCode = (code && available.includes(code)) ? code : defaultCode;

  // Real per-UF ranking for the active product. The "Onde X é produzido" chart
  // previously FABRICATED the per-UF split (a sine jitter over a synthetic
  // affinity table). Fetch the true per-product × UF breakdown from
  // /api/product-uf (Gold grouped by product × UF, already in the active currency,
  // honouring the year filter). Hooks sit ABOVE the early-return so hook order is
  // stable across renders (Rules of Hooks).
  // Stable primitive for the fetch effect's deps: the states ARRAY is a new
  // identity every render, so depending on it directly would refetch forever.
  // `null` (no UF filter) is kept distinct from '' (explicitly none selected) —
  // the same null-vs-empty contract the other producers honour.
  const ufScopeKey = summary?.states == null ? null : summary.states.join(',');
  const [ufRank, setUfRank] = usePPState({ rows: null, loading: true });
  React.useEffect(() => {
    // Only fetch when the UF card will actually render (hasGeo) — skip the needless
    // request for non-geo bancos (e.g. COMTRADE) where the card is gated off.
    if (!activeCode || !hasGeo) return undefined;
    let alive = true;
    setUfRank({ rows: null, loading: true });
    const qs = new URLSearchParams({
      banco: database,
      code: activeCode,
      currency: conv.currency,
      correction: conv.correction,
    });
    if (summary?.startDate) qs.set('startDate', summary.startDate);
    if (summary?.endDate) qs.set('endDate', summary.endDate);
    // The UF filter reaches this reader now. Without it the ranking/map showed all 27
    // states while the rest of the screen was narrowed to the researcher's selection.
    // Read from ufScopeKey (not summary.states) so the effect depends ONLY on the
    // stable primitive that is in its deps array.
    if (ufScopeKey != null) qs.set('states', ufScopeKey);
    fetch(`/api/product-uf?${qs}`)
      // Distinguish a LOAD FAILURE (network/500/IAP-expired) from a legitimately empty
      // ranking: throwing on non-ok routes both into the error state, so the view shows an
      // explicit "falha ao carregar" instead of the "Sem dados por UF" no-data message —
      // which would read as a false analytical claim (the product has no UF breakdown).
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => {
        if (alive) setUfRank({ rows: (d && d.uf) || [], loading: false, error: false });
      })
      .catch(() => {
        if (alive) setUfRank({ rows: null, loading: false, error: true });
      });
    return () => {
      alive = false;
    };
    // `states` joined, not the array: a fresh array identity every render would
    // refetch on every render, while omitting it entirely would never refetch when
    // the researcher changes the UF filter — the ranking would keep the old scope.
  }, [database, activeCode, hasGeo, conv.currency, conv.correction, summary?.startDate, summary?.endDate, ufScopeKey, setUfRank]);

  // Neither the product's series nor its distribution goes below a whole UF: a sub-UF recorte
  // cannot apply here, and the screen says so in every state of it (v1.108.2).
  const recorteNota = window.recorteNaoSeAplica(filtered,
    'a série de cada produto e a sua distribuição existem por UF inteira, não por município.');
  // Under a UF subset the series are the selected UFs' (v1.108.3). While that read is on its
  // way, or after it failed, there is no series to profile — the national one would be Brazil's
  // under the UF chip — and the screen says which, never "nenhum produto disponível".
  const porUf = window.seriesPorUf(filtered);
  if (porUf && porUf.estado !== 'nacional') {
    return (
      <>
        <window.NotApplicableNote note={{ recorte: recorteNota }} />
        <window.SeriesPorUfNote filtered={filtered} />
      </>
    );
  }

  if (!activeCode) {
    return (
      <window.EmptyCard>
        Nenhum produto disponível na seleção atual. Ajuste os filtros para escolher um produto.
      </window.EmptyCard>
    );
  }

  const prod   = filtered.products.find(p => p.code === activeCode);
  const family = prod.family;
  // Family-aware axis + multiplier + formatter (mass→t, volume→m³, count→what the product
  // counts). The old binary "mass ? … : volume" would label a livestock headcount in m³, and
  // until v1.108.7 a count read the convention's bare unit: "un" beside a herd, the eggs and
  // the pineapples alike. countProductUnit names the thing ("cabeças", "ovos", "frutos").
  const countUnit = (c, opts) => window.countProductUnit(prod, c, opts);
  const AXIS_FN = { mass: window.massAxisLabel, volume: window.volumeAxisLabel, count: (c) => countUnit(c) };
  const QMUL_FN = { mass: window.massQtyMul,    volume: window.volumeQtyMul,    count: window.countQtyMul };
  const FAM_COLOR = { mass: 'var(--viz-2)', volume: 'var(--viz-4)', count: 'var(--viz-9)' };
  const unitAx = (AXIS_FN[family] || window.massAxisLabel)(conv);
  const qtyMul = (QMUL_FN[family] || window.massQtyMul)(conv);
  const qColor = FAM_COLOR[family] || 'var(--viz-2)';
  // A quantity written out, in the unit the axis names. The stock cards below called
  // formatCountQty whatever the family, so a crop that reached them (a window with no value,
  // see isStock) was multiplied as a count and labelled "un".
  const fmtQty = (q) => window.formatProductQty(prod, q, conv);
  // A sparkline draws an absent point as a zero (Sparkline.jsx reads `Math.min(null, …)` as
  // 0), so each card gets only the points that exist; with fewer than two, no line at all.
  const presentes = (serie, chave) => serie.filter(d => Number.isFinite(d[chave]));
  // The price's denominator: ONE of the unit the quantity is shown in — "R$ por ovo", "R$/kg".
  // It was the family's base unit (prod.unit), so every count read "/un", and with kg chosen
  // in the conventions a price computed per kg read "/t".
  const perUnit = family === 'count' ? countUnit(conv, { singular: true }) : unitAx;
  // The family tag beside a quantity names a count by what it counts ("Contagem · ovos");
  // mass and volume keep the convention's unit, which the tag reads on its own.
  const famUnit = family === 'count' ? unitAx : undefined;
  // The unit as the source publishes it. prod.unit is the family's base, 'un' for every
  // count; a count reads unit_native instead ("Mil dúzias", "Cabeças", "Mil frutos"), and one
  // whose unit is not recognised says so rather than show a label nobody checked.
  const unidadeNativa = family === 'count'
    ? (window.countNounOf(prod) ? prod.unit_native : window.COUNT_UNKNOWN)
    : `${prod.unit} (${window.UNIT_FAMILIES[family].long})`;

  // Per-product series (PRODUCT_TS.v in base-currency mi, .q in family display unit)
  const raw = filtered.allProductTS[activeCode];
  const yearStart = filtered.yearStart, yearEnd = filtered.yearEnd;
  const win = raw.filter(d => d.y >= yearStart && d.y <= yearEnd);

  // A herd headcount (PPM measure_kind='stock') is a STOCK with NO monetary value —
  // value / implicit price / market-share-by-value are meaningless for it. What a measure IS
  // comes from the data, never from a missing value: only PPM sends measure_kind, and only
  // its herd is a 'stock'. Until v1.108.12 a product with no measure_kind fell back to "no
  // positive value in the window", so soybean in 1974–1979 under IPCA (the index starts in
  // 1980) was laid out as a herd: "Efetivo", "Pico histórico", "Onde Soja é criado", and a
  // zero for every UF. A crop with no value in the window is still a crop; what it lacks is
  // the value, and the cards below say why.
  const isStock = prod.measure_kind === 'stock';

  // Basket totals per year: VALUE (flow share) and same-family QUANTITY (stock share).
  // The efetivo share of a STOCK is among OTHER STOCKS only — egg/milk count-FLOWS are
  // not part of the efetivo, so they must not inflate the headcount denominator.
  const totalByYear = {}, totalQByYear = {};
  Object.entries(filtered.productTS).forEach(([code, series]) => {
    const p = filtered.products.find(x => x.code === code);
    const inQtyDenom = p && p.family === family
      && (!isStock || p.measure_kind === 'stock');
    series.forEach(d => {
      // O denominador da participação soma só o que EXISTE: um ano sem valor para a
      // convenção escolhida fica ausente, e a participação daquele ano é recusada.
      totalByYear[d.y] = window.addPresent(totalByYear[d.y] ?? null, d.v);
      if (inQtyDenom && d.q != null) totalQByYear[d.y] = (totalQByYear[d.y] || 0) + d.q;
    });
  });

  // Implicit price = value ÷ quantity, both in their displayed unit. The quantity
  // series uses the family-aware qtyMul, so the price divides by the SAME d.q * qtyMul
  // (avoids the 1000× m³ inflation the old hardcoded ×1e3 caused for volume products).
  // Toda conversão de escala passa por scalePresent e toda razão por ratioPresent: o
  // ano que a convenção não cobre segue AUSENTE até a tela ('—' / lacuna) em vez de
  // reaparecer como zero — `null * 1e6 === 0` em JS.
  const valueSeries = win.map(d => ({ y: d.y, v: window.scalePresent(d.v, 1e6 * cvf) }));  // absolute currency
  const qtySeries   = win.map(d => ({ y: d.y, q: window.scalePresent(d.q, qtyMul) }));     // display unit (×mul)
  // The two halves of the price cover the SAME rows (v1.108.10): the value and the quantity of
  // the rows that carry both measures in the product's unit (vPriced, qPriced). `d.v ÷ d.q`
  // divided every row's value by the quantity of only the rows in that unit; in UN Comtrade,
  // 200919 in 2002 with Brazil as reporter read US$ 69,906/t where the priced rows give
  // US$ 5,649/t, with 8.08% of the year's value behind it.
  const preco = (d) => window.ratioPresent(window.scalePresent(d.vPriced, 1e6 * cvf),
                                           window.scalePresent(d.qPriced, qtyMul));
  const priceSeries = win.map(d => ({ y: d.y, v: preco(d) }));                             // moeda/unidade
  // How much of the year's value stands behind its price, and the years where that is too
  // little to go unsaid (window.PRICED_SHARE_MIN, shared with Parceiros).
  const parcelaDoPreco = (d) => window.ratioPresent(d.vPriced, d.v);
  const precoParcial = win.filter(d => preco(d) != null && window.pricedShareLow(parcelaDoPreco(d)));
  // Share: by VALUE for a flow; by same-family QUANTITY for a value-less stock.
  const parte = (d) => window.scalePresent(
    isStock ? window.ratioPresent(d.q, totalQByYear[d.y]) : window.ratioPresent(d.v, totalByYear[d.y]),
    100);
  const shareSeries = win.map(d => ({ y: d.y, v: parte(d) }));

  const last = win[win.length - 1] || { v: null, q: null };
  const prev = win[win.length - 2] || last;
  const lastValAbs = window.scalePresent(last.v, 1e6 * cvf);
  const prevValAbs = window.scalePresent(prev.v, 1e6 * cvf);
  // A janela que termina num ano de reforma (1994, por exemplo) compararia duas moedas no
  // último par: a mesma recusa do Visão geral (deltaPctIn), com o motivo no subtítulo.
  const eraBreaks = window.valueEraBreaksFor ? window.valueEraBreaksFor(database) : [];
  const deltaV = window.deltaPctIn({ y: prev.y, v: prevValAbs }, { y: last.y, v: lastValAbs }, eraBreaks);
  // WHY the value card has no number, or no variation. The snapshot knows which years the
  // convention does not reach and which other correction does (valueGap.coveredBy), and the
  // card says it in the words of the "Variação acumulada" refusal (deltaWhyNot): "sem valor em
  // 1979 nesta convenção — a série do IPCA não alcança esse ano (o IGP-DI alcança)". With no
  // value in the last year the reason is that year's — deltaWhyNot asked about the year alone,
  // so the wording stays in one place; with a value, it is the variation's (a currency reform
  // between the two years, or no value in the year before), and null when the variation stands.
  const motivo = window.valueGapMotivo(window.valueGapFor(database), conv);
  // No value in the last year, no variation to show: the card drops its '—' badge and the
  // subtitle carries the reason.
  const semValorNoUltimo = lastValAbs == null;
  const porQueV = semValorNoUltimo
    ? window.deltaWhyNot({ y: last.y, v: null }, { y: last.y, v: null }, null, motivo)
    : window.deltaWhyNot({ y: prev.y, v: prevValAbs }, { y: last.y, v: lastValAbs }, eraBreaks, motivo);
  const subValor = semValorNoUltimo ? porQueV
    : porQueV ? `${last.y} vs. ${prev.y} · ${porQueV}` : `${last.y} vs. ${prev.y}`;
  const deltaQ = window.deltaPct(prev.q, last.q);
  // scalePresent, não `last.q * qtyMul`: em JS `null * fator === 0`, e a quantidade
  // AUSENTE (janela sem ponto algum — `last` cai no fallback `{v: null, q: null}`)
  // aparecia como "0 t", afirmando que o produto não rendeu nada. É o defeito da
  // v1.49.0 numa forma que a varredura não cobre: multiplicação não é divisão.
  const lastQtyScaled = window.scalePresent(last.q, qtyMul);
  const lastPrice = preco(last);
  const lastParcela = lastPrice == null ? null : parcelaDoPreco(last);
  const lastShare = parte(last);
  // Historical peak headcount (drives the stock KPI that replaces "Valor")
  const peak = win.reduce((m, d) => (d.q > m.q ? d : m), win[0] || { y: last.y, q: 0 });

  // Top-10 producing/raising UFs from the REAL per-UF ranking. A value-less stock ranks
  // by headcount (q_count) instead of an all-zero value; the bar measure (_m) is value
  // for a flow, or the family-scaled quantity for a stock.
  // Only a UF WITH the measure is a bar: one with no value in this convention is not a bar of
  // length zero. The serializer keeps a missing value null (`_measure`, not `_num`), and the
  // `|| 0` that stood here turned it back into a zero; the UFs left out are named under the chart.
  const ufMedida = (u) => (isStock ? u.q_count : u.value);
  const ufLidas = ufRank.rows || [];
  const ufSemValor = ufLidas.filter(u => !Number.isFinite(ufMedida(u)));
  const ufRows = ufLidas.filter(u => Number.isFinite(ufMedida(u)))
    .sort((a, b) => ufMedida(b) - ufMedida(a)).slice(0, 10)
    .map(u => ({ ...u, _m: isStock ? u.q_count * qtyMul : u.value }));
  const periodo = yearStart === yearEnd ? String(yearStart) : `${yearStart}–${yearEnd}`;
  // A flow with no value in ANY year of the window: the value, price and share charts would be
  // empty plots with an axis that measures nothing ("0 a 4 R$"). Each card says so instead.
  const semValorNaJanela = !isStock && !win.some(d => Number.isFinite(d.v));
  const graficoSemValor = (
    <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
      Nenhum ano de {periodo} tem valor nesta convenção.
    </p>
  );
  const ufScaled = window.scaleSeries(
    ufRows, Math.max(...ufRows.map(u => u._m), 0), conv, '_m', isStock ? unitAx : fx.symbol,
  );

  // Quality for this product (may be absent from the curated subset)
  const qaRow = filtered.qualityByProduct.find(r => r.code === activeCode);

  // Auto-scale value/qty/price series for charts
  const valScaled = window.scaleSeries(valueSeries, Math.max(...valueSeries.map(d => d.v), 0), conv, 'v', fx.symbol);
  const qtyScaled = window.scaleSeries(qtySeries,  Math.max(...qtySeries.map(d => d.q), 0),  conv, 'q', unitAx);

  return (
    <>
      <window.NotApplicableNote note={{ recorte: recorteNota }} />
      {/* A banco with no per-UF series draws the national ones under a UF subset: said here. */}
      <window.SeriesPorUfNote filtered={filtered} />

      {/* Product selector */}
      <div className="pp-selector">
        <span className="pp-selector-label">Produto em análise</span>
        <div className="pp-chips">
          {available.map(c => {
            const p = filtered.products.find(x => x.code === c);
            return (
              <button key={c}
                      className={'pp-chip ' + (c === activeCode ? 'on' : '')}
                      onClick={() => setCode(c)}>
                <span className={'pp-chip-fam ' + p.family}></span>
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* KPI strip — for a value-less stock (herd) the Valor/Preço cards are replaced
          by Efetivo + Pico histórico, since a headcount has no money. */}
      <div className="kpi-row">
        {isStock ? (
          <window.KpiCardSpark
            label={<>Efetivo · <window.UnitFamilyTag family={family} conv={conv} unit={famUnit}/></>}
            value={fmtQty(last.q)}
            delta={window.fmtSigned(deltaQ)}
            deltaPositive={window.deltaUp(deltaQ)}
            sub={`${last.y} vs. ${prev.y}`}
            spark={presentes(win.slice(-12).map(d => ({ y: d.y, q: d.q })), 'q')}
            sparkKey="q"
            sparkColor={qColor}
          />
        ) : (
          <window.KpiCardSpark
            label={`Valor · ${monLabel}`}
            value={window.formatValue(window.scalePresent(last.v, 1e6), conv)}
            delta={semValorNoUltimo ? null : window.fmtSigned(deltaV)}
            deltaPositive={window.deltaUp(deltaV)}
            sub={subValor}
            spark={presentes(win.slice(-12).map(d => ({ y: d.y, v: d.v })), 'v')}
            sparkKey="v"
            sparkColor="var(--viz-1)"
          />
        )}
        {isStock ? (
          <window.KpiCardSpark
            label="Pico histórico"
            value={fmtQty(peak.q)}
            sub={`em ${peak.y}`}
            spark={presentes(win.slice(-12).map(d => ({ y: d.y, q: d.q })), 'q')}
            sparkKey="q"
            sparkColor="var(--viz-7)"
          />
        ) : (
          <window.KpiCardSpark
            label={<>Quantidade · <window.UnitFamilyTag family={family} conv={conv} unit={famUnit}/></>}
            value={lastQtyScaled == null
              ? '—'
              : lastQtyScaled.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' ' + unitAx}
            delta={window.fmtSigned(deltaQ)}
            deltaPositive={window.deltaUp(deltaQ)}
            sub={`${last.y} vs. ${prev.y}`}
            spark={presentes(win.slice(-12).map(d => ({ y: d.y, q: d.q })), 'q')}
            sparkKey="q"
            sparkColor={qColor}
          />
        )}
        {!isStock && (
          <window.KpiCardSpark
            label="Preço médio implícito"
            value={lastPrice == null
              ? '—'
              : fx.symbol + ' ' + lastPrice.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' /' + perUnit}
            sub={window.pricedShareLow(lastParcela)
              ? `valor ÷ quantidade · apoiado em ${window.fmtPctSig(lastParcela)} do valor`
              : 'valor ÷ quantidade'}
            spark={presentes(priceSeries.slice(-12), 'v')}
            sparkKey="v"
            sparkColor="var(--viz-7)"
          />
        )}
        <window.KpiCardSpark
          label={isStock ? 'Participação no efetivo' : 'Participação na cesta'}
          value={window.fmtPct(window.scalePresent(lastShare, 0.01))}
          sub={`${filtered.selectedProducts.length} ${filtered.selectedProducts.length === 1 ? 'produto' : 'produtos'} na cesta`}
          spark={presentes(shareSeries.slice(-12), 'v')}
          sparkKey="v"
          sparkColor="var(--viz-5)"
        />
      </div>

      {isStock ? (
        <>
          {/* Stock (herd): efetivo + participação, no value/price (a headcount has no money) */}
          <div className="grid-2">
            <div className="card">
              <window.SectionHeader
                overline={<>Série do efetivo · <window.UnitFamilyTag family={family} conv={conv} unit={famUnit}/></>}
                title={`${prod.name} · efetivo (${qtyScaled.label})`}
              />
              <window.LineChart data={qtyScaled.data} label={qtyScaled.label} valueKey="q" color={qColor} height={230} trend />
            </div>
            <div className="card">
              <window.SectionHeader
                overline="Participação no efetivo · % do total da cesta"
                title={`Participação de ${prod.name} no efetivo`}
              />
              <window.LineChart data={shareSeries} label="% do efetivo" valueKey="v" color="var(--viz-5)" height={230} />
            </div>
          </div>
          <p className="caption" style={{ margin: '4px 2px 0' }}>
            ⓘ O efetivo dos rebanhos é um <strong>estoque</strong> (nº de cabeças), não uma produção: não tem
            valor monetário nem preço, e <strong>não deve ser somado entre espécies</strong>.
          </p>
        </>
      ) : (
        <>
          {/* Value + quantity series */}
          <div className="grid-2">
            <div className="card">
              <window.SectionHeader
                overline={`Série de valor · ${monLabel}`}
                title={`${prod.name} · valor (${valScaled.label})`}
              />
              {semValorNaJanela ? graficoSemValor
                : <window.LineChart data={valScaled.data} label={valScaled.label} valueKey="v" color="var(--viz-1)" height={230} />}
            </div>
            <div className="card">
              <window.SectionHeader
                overline={<>Série de quantidade · <window.UnitFamilyTag family={family} conv={conv} unit={famUnit}/></>}
                title={`${prod.name} · quantidade (${qtyScaled.label})`}
              />
              <window.LineChart data={qtyScaled.data} label={qtyScaled.label} valueKey="q" color={qColor} height={230} />
            </div>
          </div>

          {/* Implicit price + market share */}
          <div className="grid-2">
            <div className="card">
              <window.SectionHeader
                overline="Preço médio implícito · valor ÷ quantidade"
                title={`${fx.symbol} por ${perUnit} · ${yearStart}–${yearEnd}`}
              />
              {semValorNaJanela ? graficoSemValor
                : <window.LineChart data={priceSeries} label={fx.symbol + '/' + perUnit} valueKey="v" color="var(--viz-7)" height={220} trend />}
              {/* The price stands on the rows with both measures; a year where they hold too
                  little of the value says so, by name, as Parceiros does for a partner. */}
              <window.CollapsingNameList
                titulo="Preço apoiado em parte do valor"
                itens={precoParcial.map(d => `${d.y} (${window.fmtPctSig(parcelaDoPreco(d))})`)}
                substantivo="anos"
                regra={
                  <>
                    Nesses anos, parte do valor está em registros sem quantidade na unidade do
                    produto: em outra unidade, ou sem quantidade alguma. Um preço só pode ser
                    calculado onde valor e quantidade existem juntos, e a porcentagem é quanto do
                    valor do ano sustenta o preço exibido. A série de valor soma o ano inteiro.
                  </>
                } />
            </div>
            <div className="card">
              <window.SectionHeader
                overline="Participação na cesta · % do valor total"
                title={`Participação de ${prod.name} na cesta`}
              />
              {semValorNaJanela ? graficoSemValor
                : <window.LineChart data={shareSeries} label="% da cesta" valueKey="v" color="var(--viz-5)" height={220} />}
            </div>
          </div>
        </>
      )}

      {/* UF ranking + ficha técnica */}
      <div className="grid-2">
        {hasGeo && (
        <div className="card">
          <window.SectionHeader
            overline={`Ranking de UFs ${isStock ? 'criadoras' : 'produtoras'} · ${yearStart}–${yearEnd}`}
            title={`Onde ${prod.name} ${isStock ? 'é criado' : 'é produzido'}`}
            action={<span className="caption">10 maiores · {ufScaled.label}</span>}
          />
          {ufRank.loading ? (
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
              Carregando distribuição por UF…
            </p>
          ) : ufRank.error ? (
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center', color: 'var(--err, #b71c1c)' }}>
              Não foi possível carregar a distribuição por UF. Tente novamente.
            </p>
          ) : ufRows.length ? (
            <>
              <window.BarChart data={ufScaled.data} valueKey="_m" color={isStock ? qColor : 'var(--viz-2)'} height={320} />
              <window.CollapsingNameList
                titulo="Sem valor nesta convenção"
                itens={ufSemValor.map(u => u.uf)}
                substantivo="UFs"
                regra={`Não têm valor nesta convenção em ${periodo}, por isso não entram no ranking por valor.`} />
            </>
          ) : ufSemValor.length ? (
            // Rows came back, none with a value: the data exists, the convention does not reach
            // it. "Sem dados por UF" would say the product has no distribution at all.
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
              Nenhuma UF tem valor nesta convenção em {periodo}, e o ranking é pelo valor.
            </p>
          ) : (
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
              Sem dados por UF para este produto.
            </p>
          )}
        </div>
        )}
        <div className="card">
          <window.SectionHeader
            overline="Ficha técnica"
            title={prod.name}
          />
          <dl className="pp-spec">
            <dt>{codeLabel}</dt><dd className="tnum">{prod.code}</dd>
            <dt>Unidade nativa</dt><dd>{unidadeNativa}</dd>
            <dt>Família de unidade</dt><dd>{window.UNIT_FAMILIES[family].label}</dd>
            {isStock && <><dt>Tipo de medida</dt><dd>Estoque (efetivo)</dd></>}
            <dt>Cobertura temporal</dt><dd className="tnum">{yearStart}–{yearEnd}</dd>
            {isStock
              ? <><dt>Efetivo ({last.y})</dt><dd>{fmtQty(last.q)}</dd></>
              : <><dt>Valor ({last.y})</dt><dd>{window.formatValue(window.scalePresent(last.v, 1e6), conv)}</dd></>}
            <dt>{isStock ? 'Participação no efetivo' : 'Participação na cesta'}</dt><dd>{window.fmtPct(window.scalePresent(lastShare, 0.01))}</dd>
            {/* Since v1.49.0 'OK' means EXAMINED by the implied-price detector and cleared —
                the rows it could not score left for 'UNSCORED'. This spec sheet was the last
                screen still calling that share "Linhas íntegras", a label the rest of the
                product retired: on a PEVS produto it reads 18,2% and the researcher concludes
                four fifths of the acervo is broken. It is not — most of the remainder is an
                exact measured zero or a row under the materiality floor. The card now names
                what it MEASURES, and the line below it says what the rest is, so the missing
                share is never left unexplained (the same pairing ViewOverview's KPI uses). */}
            {qaRow && <><dt>Linhas examinadas sem ressalva</dt><dd>{window.fmtPct(qaRow.OK)}</dd></>}
            {qaRow && <><dt>Sem base para avaliar</dt><dd>{window.fmtPct(qaRow.UNSCORED)}</dd></>}
            {qaRow && !isStock && <><dt>Valor ausente</dt><dd>{window.fmtPct(qaRow.MISSING_VALUE)}</dd></>}
            {qaRow && isStock && qaRow.MISSING_QUANTITY != null && <><dt>Sem quantidade</dt><dd>{window.fmtPct(qaRow.MISSING_QUANTITY)}</dd></>}
          </dl>
        </div>
      </div>
    </>
  );
}

window.ViewProductProfile = ViewProductProfile;
