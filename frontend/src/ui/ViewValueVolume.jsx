// ViewValueVolume — historic evolution of value and quantity,
// with quantity strictly segregated by unit family.
// All currency / correction / mass / volume formatting goes through
// the global metric conventions (props.conventions).

function ViewValueVolume({ families, conventions, summary, database }) {
  const conv      = conventions || window.DEFAULT_CONVENTIONS;
  const ccyLabel  = window.conventionMonetaryLabel(conv);
  const fx        = window.CURRENCY_FX[conv.currency];
  const ccyColor  = { BRL: 'var(--viz-1)', USD: 'var(--viz-2)', EUR: 'var(--viz-3)' }[conv.currency];
  const massMul   = window.massQtyMul(conv);
  const volMul    = window.volumeQtyMul(conv);
  const massAx    = window.massAxisLabel(conv);
  const volAx     = window.volumeAxisLabel(conv);

  // Scale internal units to absolute (no auto-rescale on display).
  //   ts.v       : R$ bi  → R$
  //   d.q_mass   : mil t  → t   (× massQtyMul handles t→kg too)
  //   d.q_vol    : mi m³  → m³  (× volumeQtyMul handles m³→L too)
  const filtered = window.applyFilters(summary || {}, database);
  const ts = filtered.ts.map(d => ({ ...d, v: window.scalePresent(d.v, 1e9) }));
  const valueSeries = window.convertSeries(ts, conv);
  // massMul / volMul map (mil t, mi m³) → (t/kg, m³/L). The COUNT family (herd cabeças /
  // eggs) is deliberately NOT aggregated here: heads are not additive across species, so a
  // national "total contagem" line would be a meaningless blend (see the Rebanho view,
  // which keeps each species separate). A herd basket is redirected there below.
  const massSeries  = ts.map(d => ({ y: d.y, q_mass: d.q_mass * massMul }));
  const volSeries   = ts.map(d => ({ y: d.y, q_vol:  d.q_vol  * volMul  }));

  // Per-product stacked series — split by family, scaled by current units
  const PRODS = filtered.products;
  const COLORS = [...window.VIZ_SCALE, 'var(--pres-gray-200)', 'var(--pres-gray-300)'];
  const productSeries = (family) => Object.entries(filtered.productTS)
    .map(([code, data], i) => ({
      code,
      name: PRODS.find(p => p.code === code)?.name || code,
      family: data[0]?.family,
      // PRODUCT_TS.q is in mil units (mil t / mi m³); scale to display unit.
      data: data.map(d => ({
        ...d,
        q: d.q * (family === 'mass' ? massMul : volMul),
      })),
      color: COLORS[i % COLORS.length],
    }))
    .filter(s => s.family === family);

  // Value-stacked applies currency + correction (base-aware).
  const cvf = window.convFactor(conv);
  // PRODUCT_TS.v is in base-currency mi internally; multiply 1e6 to absolute.
  const valueStacked = Object.entries(filtered.productTS)
    .map(([code, data], i) => ({
      code,
      name: PRODS.find(p => p.code === code)?.name || code,
      data: data.map(d => ({ ...d, v: window.scalePresent(d.v, 1e6 * cvf) })),
      color: COLORS[i % COLORS.length],
    }));

  // ---- Scale series for charts when auto-scale is enabled ----------
  const valueMax = Math.max(...valueSeries.map(d => d.v), 0);
  const valueScaled = window.scaleSeries(valueSeries, valueMax, conv, 'v', fx.symbol);

  const massMax = Math.max(...massSeries.map(d => d.q_mass), 0);
  const massScaled = window.scaleSeries(massSeries, massMax, conv, 'q_mass', massAx);

  const volMax = Math.max(...volSeries.map(d => d.q_vol), 0);
  const volScaled = window.scaleSeries(volSeries, volMax, conv, 'q_vol', volAx);

  // Stacked: scale each layer using the same factor (sum-based ref)
  const _scaleStack = (layers, key, unit) => {
    if (!layers.length || !layers[0].data.length) return { layers, label: unit };
    if (!conv.autoScale) return { layers, label: unit };
    // Aggregate the per-year stacked total BY YEAR, not by array index: product layers
    // are ragged (a product introduced later has a shorter series), so the old
    // index-aligned sum threw a TypeError on the short layer (blanking the view) or
    // silently dropped a longer layer's tail years. (shared helper · seriesUtils.js)
    const max = window.stackYearMax(layers, key);
    const { factor, suffix } = window.autoScaleNum(max);
    if (!suffix) return { layers, label: unit };
    const out = layers.map(l => ({
      ...l,
      data: l.data.map(d => ({ ...d, [key]: d[key] / factor })),
    }));
    return { layers: out, label: window.scaleLabel(unit, suffix) };  // shared grammar (DEDUP-9)
  };

  const valueStackScaled = _scaleStack(valueStacked, 'v', fx.symbol);
  const massStackScaled  = _scaleStack(productSeries('mass'),   'q', massAx);
  const volStackScaled   = _scaleStack(productSeries('volume'), 'q', volAx);

  // Série vazia → extremos AUSENTES (v: null), não um zero inventado: deltaTitle
  // recusa com motivo em vez de afirmar "+0%".
  const last       = valueSeries[valueSeries.length - 1] || { v: null };
  const first      = valueSeries[0] || { v: null };
  const yearStart  = filtered.yearStart;
  const yearEnd    = filtered.yearEnd;

  const massFamily = families.includes('mass');
  const volFamily  = families.includes('volume');
  const countFamily = families.includes('count');
  // Only a STOCK (herd head-count) is non-summable across species; count-family FLOWS
  // (ovos/mel) DO carry monetary value and ARE summable. Gate the "veja Rebanho" note on a
  // stock actually being in the selection (mirrors ViewOverview) — not on the count family
  // alone, which would falsely flag an egg/honey basket and point to an empty Rebanho view.
  const hasStock = (filtered.products || []).some(
    (p) => p.measure_kind === 'stock' && (filtered.selectedProducts || []).includes(p.code),
  );
  // A value-less basket (the livestock herd — a stock) has R$ 0 every year; show the
  // monetary cards only when there IS value, and explain the absence honestly.
  const hasValue = valueMax > 0;
  // Basket × UF transient: filtered.ts sums ALL products over the selected UFs (the
  // basket is silently dropped) until the product×UF cube lands. Hold the ts-derived
  // aggregate value/quantity/YoY series at an honest loading note rather than render a
  // number that disregards the basket (mirrors ViewOverview's comboPending guard). The
  // per-product composition charts below read productTS and stay basket-correct.
  const comboPending = !!filtered.geoComboPending;

  return (
    <>
      <window.UnitFamilyBanner families={families} />

      {comboPending && (
        <div className="card subtle" style={{ marginBottom: 12 }}>
          <p className="caption" style={{ padding: '10px 12px' }}>
            Cruzando <strong>produto × UF</strong>… os totais de valor e quantidade aparecem
            assim que o cubo territorial carrega. A composição por produto abaixo já reflete a
            cesta selecionada.
          </p>
        </div>
      )}

      {!hasValue && (
        <div className="card subtle" style={{ marginBottom: 12 }}>
          <p className="caption" style={{ padding: '10px 12px' }}>
            Esta cesta é um <strong>estoque sem valor monetário</strong> (efetivo dos rebanhos) — não
            há série de valor. Veja a quantidade em <strong>cabeças</strong> abaixo, ou a perspectiva
            <strong> Rebanho</strong> para a composição por espécie.
          </p>
        </div>
      )}

      {/* Value historic series — ts-derived; held during the basket×UF cube load. */}
      {hasValue && !comboPending && (
      <div className="card">
        <window.SectionHeader
          overline={`Série histórica · ${ccyLabel}`}
          title={`Valor total · ${valueScaled.label} · ${yearStart}–${yearEnd}`}
          action={
            <span className="caption">{window.deltaTitle('Variação acumulada', first, last, { breaks: window.valueEraBreaksFor(database) })}</span>
          }
        />
        <window.LineChart data={valueScaled.data} label={valueScaled.label} valueKey="v" color={ccyColor} height={260} />
      </div>
      )}

      {/* A herd STOCK may be in a value-bearing basket but is not summable across species,
          so it is not aggregated here — point to the Rebanho view. Count-family FLOWS
          (ovos/mel) are summable and value-bearing, so they don't trigger this note. */}
      {hasValue && countFamily && hasStock && (
        <div className="card subtle" style={{ marginBottom: 12 }}>
          <p className="caption" style={{ padding: '10px 12px' }}>
            O <strong>efetivo dos rebanhos</strong> (cabeças) está na seleção mas não é exibido aqui —
            cabeças não são somáveis entre espécies. Veja a perspectiva <strong>Rebanho</strong>.
          </p>
        </div>
      )}

      {/* Quantity historic series — one per family. ts-derived → held during cube load. */}
      <div className={'grid-' + (families.length === 2 ? '2' : '1')}>
        {massFamily && !comboPending && (
          <div className="card">
            <window.SectionHeader
              overline={<>Série histórica · <window.UnitFamilyTag family="mass" conv={conv}/></>}
              title={`Quantidade · ${massScaled.label}`}
            />
            <window.LineChart data={massScaled.data} label={massScaled.label} valueKey="q_mass" color="var(--viz-2)" height={220} />
          </div>
        )}
        {volFamily && !comboPending && (
          <div className="card">
            <window.SectionHeader
              overline={<>Série histórica · <window.UnitFamilyTag family="volume" conv={conv}/></>}
              title={`Quantidade · ${volScaled.label}`}
            />
            <window.LineChart data={volScaled.data} label={volScaled.label} valueKey="q_vol" color="var(--viz-4)" height={220} />
          </div>
        )}
      </div>

      {/* YoY variation — ts-derived; held during the basket×UF cube load. */}
      {hasValue && !comboPending && (
      <div className="card">
        <window.SectionHeader
          overline={`Variação interanual · valor (${ccyLabel})`}
          title={`Crescimento ano a ano · ${yearStart + 1}–${yearEnd}`}
        />
        <window.YoYBars data={valueSeries} valueKey="v" height={200} />
      </div>
      )}

      {/* Composition by product · value */}
      {hasValue && (
      <div className="card">
        <window.SectionHeader
          overline={`Composição histórica · valor (${valueStackScaled.label})`}
          title={`Empilhamento por produto · ${yearStart}–${yearEnd}`}
        />
        <window.StackedArea series={valueStackScaled.layers} valueKey="v" label={valueStackScaled.label} height={280} />
      </div>
      )}

      {/* Composition by quantity — per family */}
      <div className={'grid-' + (families.length === 2 ? '2' : '1')}>
        {massFamily && (
          <div className="card">
            <window.SectionHeader
              overline={<>Composição histórica · quantidade <window.UnitFamilyTag family="mass" conv={conv}/></>}
              title={`Produtos em massa · ${massStackScaled.label}`}
            />
            <window.StackedArea series={massStackScaled.layers} valueKey="q" label={massStackScaled.label} height={240} />
          </div>
        )}
        {volFamily && (
          <div className="card">
            <window.SectionHeader
              overline={<>Composição histórica · quantidade <window.UnitFamilyTag family="volume" conv={conv}/></>}
              title={`Produtos em volume · ${volStackScaled.label}`}
            />
            <window.StackedArea series={volStackScaled.layers} valueKey="q" label={volStackScaled.label} height={240} />
          </div>
        )}
      </div>
    </>
  );
}

window.ViewValueVolume = ViewValueVolume;
