// ViewPartners — trading-partner rankings (country or UF). Generic via
// the partnerData contract (real Gold data).
//
// The ranking dimension is switchable between Capital (valor US$), Volume (peso
// líquido) and Preço médio (US$/kg = valor ÷ peso). The metric is sent to the
// producer so the ranking is recomputed SERVER-SIDE (a niche high-unit-price
// buyer tops the price ranking but has a small total value — re-sorting a
// value-ranked page client-side would drop it). See serving/sql.trade_by_partner.
//
// Esse mesmo comentário descrevia o defeito e tirava a conclusão oposta: garantiu que o
// comprador de nicho SUBISSE, e o topo de "Preço médio" virou o Lesoto com 1 kg — US$
// 11,00 de comércio em toda a história. Um quilo não é um preço. Desde a v1.59.0 o
// serializer aplica um piso de materialidade ANTES do corte top-N (o SQL não tem LIMIT,
// o `head` do serializer É o corte), e manda em `belowFloor` quem ficou de fora, para a
// nota abaixo nomeá-los — o nicho REAL continua subindo: a Estônia, com 3.604 t a
// US$ 2,20/kg, é o topo agora.

const _PARTNER_METRICS = [
  { id: 'value',  label: 'Capital',     field: 'value',  additive: true },
  { id: 'weight', label: 'Volume',      field: 'weight', additive: true },
  { id: 'price',  label: 'Preço médio', field: 'price',  additive: false },
];

const _nf = (v, d = 0) =>
  Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

function ViewPartners({ summary, conventions, database }) {
  const [metric, setMetric] = window.React.useState('value');
  const banco = window.bancoById(database);
  const data  = window.partnerData(database, summary, metric);
  const spec  = _PARTNER_METRICS.find((m) => m.id === metric) || _PARTNER_METRICS[0];

  // How each metric formats a partner's measure for display.
  const fmtMoney = (v) =>
    data.unit + ' ' + (v >= 1000 ? _nf(v / 1000, 1) + ' bi' : _nf(v, v < 10 ? 2 : 0) + ' mi');
  const fmtMetric = (p) => {
    const v = p && p[spec.field];
    if (metric === 'value')  return fmtMoney(v || 0);
    if (metric === 'weight') return _nf((v || 0) * 1000) + ' t'; // mil t → t (pt-BR)
    return v == null ? '—' : 'US$ ' + _nf(v, 2) + '/kg';          // price (US$/kg)
  };

  const partners = data.partners || [];
  const valOf = (p) => (p && p[spec.field]) || 0; // price null → 0 (bar/scale only)
  const max = Math.max(...partners.map(valOf), spec.id === 'price' ? 0.0001 : 1);
  const top = partners[0];

  // top-3 concentration only makes sense for additive metrics (valor, peso); for
  // preço médio (a ratio) show the value range across the ranked partners instead.
  // ratioPresent, não `|| 1`: sem parceiro algum a concentração top-3 saía "0%",
  // que se lê como "perfeitamente disperso" — o oposto de "não há o que concentrar".
  const sumField = window.sumPresent(partners.map(valOf));
  const kpi3 = spec.additive
    ? {
        label: 'Concentração top-3',
        value: window.fmtPct(window.ratioPresent(
          partners.slice(0, 3).reduce((s, p) => s + valOf(p), 0), sumField)),
        sub: `do ${metric === 'value' ? 'fluxo' : 'volume'} total`,
      }
    : {
        label: 'Faixa de preço',
        value: partners.length
          ? `US$ ${_nf(Math.min(...partners.map(valOf).filter((v) => v > 0)), 2)}–${_nf(max, 2)}/kg`
          : '—',
        sub: 'menor – maior',
      };

  return (
    <>
      {/* Honest note when the origin-UF filter cannot apply (country-origin banco). */}
      <window.NotApplicableNote note={data.notApplicable} />
      {/* Distinct error state when the /api/partners fetch FAILED (not "0 parceiros"). */}
      <window.LoadErrorNote error={data.loadError} />

      <div className="kpi-row">
        <window.KpiCardSpark label={`Maior ${data.flowLabel}`} value={top?.name || '—'} sub={fmtMetric(top)} />
        <window.KpiCardSpark label="Parceiros mapeados" value={partners.length} sub={`por ${spec.label.toLowerCase()}`} />
        <window.KpiCardSpark label={kpi3.label} value={kpi3.value} sub={kpi3.sub} />
        <window.KpiCardSpark label="Abrangência geográfica" value={banco?.scope || '—'} sub={banco?.domain || ''} />
      </div>

      <div className="card">
        <window.SectionHeader
          overline={`Ranking · ${data.flowLabel}`}
          title={`Maiores parceiros comerciais · ${spec.label}`}
          action={
            <div className="seg">
              {_PARTNER_METRICS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={'seg-opt ' + (metric === m.id ? 'on' : '')}
                  onClick={() => setMetric(m.id)}
                >
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          }
        />
        <div className="ptn-list">
          {partners.map((p, i) => (
            <div key={p.name} className="ptn-row">
              <span className="ptn-rank tnum">#{i + 1}</span>
              <span className="ptn-name">{p.name}</span>
              <div className="ptn-bars">
                {metric === 'value' ? (
                  <>
                    <div className="ptn-bar exp" style={{ width: (p.exp / max * 100) + '%' }} title={'Exportação ' + fmtMoney(p.exp)}></div>
                    <div className="ptn-bar imp" style={{ width: (p.imp / max * 100) + '%' }} title={'Importação ' + fmtMoney(p.imp)}></div>
                  </>
                ) : (
                  <div className="ptn-bar exp" style={{ width: (valOf(p) / max * 100) + '%' }} title={fmtMetric(p)}></div>
                )}
              </div>
              <span className="ptn-val tnum">{fmtMetric(p)}</span>
            </div>
          ))}
        </div>
        {/* Quem o piso de materialidade tirou do ranking de PREÇO (só ele: valor e volume
            são aditivos, e um parceiro minúsculo afunda sozinho — já uma RAZÃO sobe ao
            topo com a base minúscula). Medido em produção: o topo era o Lesoto com 1 kg,
            US$ 11,00 de comércio em toda a história. O piso vem do servidor, porque o
            corte top-N acontece lá; `belowFloor` é o que permite nomeá-los aqui.
            A grandeza sai sempre em kg: por definição do piso tudo aqui está abaixo de
            100 t, e em toneladas os 1.522 kg de Mônaco viravam "2 t" — um arredondamento
            que apaga justamente a informação pela qual ele saiu do ranking. */}
        <window.MaterialityFloorNote
          dropped={data.belowFloor}
          valueKey="weight" labelKey="name"
          fmt={(v) => _nf(v * 1e6, 0) + ' kg'}
          floor={{ minShare: window.PARTNER_PRICE_FLOOR.minShare,
                   minAbs: window.PARTNER_PRICE_FLOOR.minAbs }}
          floorRel={null}
          titulo="Fora do ranking de preço"
          substantivo="parceiros" cada="Cada um"
          base="do peso do recorte"
          porque="comércio pequeno demais para o valor por quilo ser um preço de mercado"
          segue="Continuam nos rankings de Capital e Volume, onde o peso deles é o próprio dado." />
        {metric === 'value' && (
          <div className="ptn-legend">
            <span className="ptn-legend-item"><span className="ptn-legend-dot exp"></span>Exportação</span>
            <span className="ptn-legend-item"><span className="ptn-legend-dot imp"></span>Importação</span>
          </div>
        )}
      </div>
    </>
  );
}

window.ViewPartners = ViewPartners;
