// ViewConcentration — how concentrated production is, geographically
// and by product. Lorenz curve + Gini + HHI. Applies to any banco
// (requires no special capability). Honours active filters.
//
// Gini: 0 = perfectly even, 1 = all in one unit.
// HHI:  sum of squared percentage shares (0–10000). >2500 = highly
//       concentrated (US DoJ convention).

// A count fallback names what it leaves out (countUnits.js).
import './CountUnitNotes.jsx';
// window.cestaPorUfMotivo, and the recorte's own products (window.recorteProducts).
import './RecorteNote.jsx';
import './recorteProducts.js';

function ViewConcentration({ summary, conventions, database }) {
  const filtered = window.applyFilters(summary || {}, database);
  const hasGeo = filtered.ufDataFull.length > 0;
  const conv = conventions || window.DEFAULT_CONVENTIONS;

  // A sub-UF recorte on its way, or failed, leaves the UF grid EMPTY for want of data, not of
  // production: "sem dados", "n/d" and "de 0 UFs" read as measurements of an empty recorte
  // (until v1.108.2). The geographic half waits, or says it failed.
  const geoEspera = !!filtered.subUfLoading;
  const geoFalhou = filtered.subUfLoadError || null;
  // Under a sub-UF recorte the product cross-section is the recorte's own — one year of the
  // município reader (recorteProducts.js) — never the national per-product series, which
  // answered for the whole country beneath the recorte's chip. Null without a recorte.
  const recorteProds = window.recorteProducts
    ? window.recorteProducts(filtered, summary || {}, database, conv) : null;
  // Without a recorte, under a UF subset, the cross-section is the selected UFs' per-product
  // series (v1.108.3): held while that read is on its way or after it failed — the national
  // series would answer for Brazil beneath the UF chip — and national, said in a note, for a
  // banco with no per-UF series.
  const porUf = recorteProds ? null : window.seriesPorUf(filtered);
  const ufEspera = !!porUf && porUf.estado === 'carregando';
  const ufFalhou = (porUf && porUf.estado === 'falha') ? porUf.erro : null;
  const prodEspera = !!(recorteProds && recorteProds.loading) || ufEspera;
  const prodFalhou = (recorteProds && recorteProds.loadError) || ufFalhou || null;
  const prodIndisponivel = !!(recorteProds && recorteProds.unavailable);
  const prodSegura = prodEspera || !!prodFalhou || prodIndisponivel;
  // The point each product enters the cross-section with: { code, name, v, q }. Nationally,
  // its latest in-window point; under a recorte, the recorte's year (q there is the count —
  // the only quantity this view reads, for a value-less basket).
  const prodPoints = recorteProds
    ? (recorteProds.products || []).map((p) => ({ code: p.code, name: p.name, v: p.value, q: p.q_count }))
    : Object.entries(filtered.productTS).map(([code, s]) => {
        const last = s[s.length - 1];
        return {
          code,
          name: (filtered.products.find(p => p.code === code) || {}).name || code,
          v: last ? last.v : null,
          q: last ? last.q : null,
        };
      });

  // Concentration is a point-in-time cross-section. Label each panel with the year
  // it is ACTUALLY computed over (never a different year): the geo distribution uses
  // the latest UF year present in the window (filtered.ufLatestYear, which can lag the
  // requested yearEnd); the product distribution uses each product's latest in-window
  // value (≈ yearEnd). Mark "(parcial)" when that latest year is incomplete (a monthly
  // banco's current year) or when the UF data stops short of the window end.
  const meta = (window.dataStore && window.dataStore.meta) ? window.dataStore.meta(database) : null;
  const lm = (meta && meta.latest) || null;
  // Align with ViewOverview/ViewGeography: a null completeYear still counts as partial
  // (the backend never emits yearComplete=false with completeYear=null today, but keep
  // the three views robust to that) (DOC-8).
  const yearPartialCal = !!lm && lm.yearComplete === false
    && (lm.completeYear == null || filtered.yearEnd > lm.completeYear);
  // The product cross-section takes each product's LATEST in-window value; a product
  // discontinued before yearEnd contributes an EARLIER year, so — unlike the geo panel,
  // a true single-year snapshot — this can MIX terminal years. Only claim the exact year
  // when every product actually reaches yearEnd; otherwise label it honestly as the most
  // recent available per product (avoids over-claiming a synchronized yearEnd cross-section).
  const prodTerminalYears = Object.values(filtered.productTS)
    .map((s) => s[s.length - 1]?.y)
    .filter((y) => y != null);
  const prodRagged = prodTerminalYears.some((y) => y !== filtered.yearEnd);
  // Under a recorte the cross-section is ONE year, the recorte's, and the tag says whose.
  const prodYearTag = recorteProds
    ? (recorteProds.year != null ? `${recorteProds.year} · municípios do recorte` : 'municípios do recorte')
    : prodRagged
      ? `mais recente disponível · ≤ ${filtered.yearEnd}`
      : `${filtered.yearEnd}${yearPartialCal ? ' (parcial)' : ''}`;
  const geoYear = filtered.ufLatestYear;
  const geoPartial = filtered.ufYearPartial || (yearPartialCal && geoYear === filtered.yearEnd);
  const geoYearTag = `${geoYear}${geoPartial ? ' (parcial)' : ''}`;

  // ── Geographic distribution (by UF) ─────────────────────────────────
  // Count ONLY real Brazilian UFs. Trade bancos (COMEX) carry non-state pseudo-
  // origins (EX/ND/ZN/MN/RE…) flagged real:false; folding them in would inflate
  // the unit count and distort the geographic Gini/HHI/top-5/Lorenz. Mirrors the
  // isRealUf guard ViewOverview already applies; falls back to the canonical 27-UF
  // registry for older payloads lacking the `real` flag.
  const isRealUf = u => (u.real != null ? u.real : window.isCanonicalUf(u.uf));
  const realUf   = filtered.ufData.filter(isRealUf);

  // Concentration is computed on VALUE by default. A value-less basket (the livestock
  // herd — a stock with no money) falls back to a COUNT so the Gini/HHI/Lorenz are real
  // instead of all-zero. The metric formulas are measure-agnostic; we feed them ONE count
  // group (countUnits.js) — the herd's heads, else the counted production — and relabel
  // "valor" with what it counts. Never the whole family: heads plus eggs is not a measure.
  // `> 0` already answers false for an absent value (null > 0, undefined > 0): no `|| 0`.
  const anyValue = realUf.some(u => u.value > 0)
    || prodPoints.some(p => p.v > 0);
  const countGroups = filtered.countGroups || [];
  // Only ever compared with `> 0` below, which answers false for an absent quantity too.
  const lastQ = (code) => (prodPoints.find(p => p.code === code) || {}).q;
  const countGroup = anyValue ? null
    : (window.countGroupWithData(countGroups, realUf)
      || countGroups.find(g => !g.mixed && g.products.some(p => lastQ(p.code) > 0))
      || null);
  const onCount = !!countGroup;
  const inCountGroup = new Set(onCount ? countGroup.products.map(p => p.code) : []);
  // A basket of herds has no money BY NATURE; anything else in it has value, just not in
  // this convention (eggs in € before 1999). The note says which of the two it is.
  const selected = filtered.selectedProducts || [];
  const soRebanho = onCount && selected.length > 0 && selected.every(
    c => (filtered.products.find(p => p.code === c) || {}).measure_kind === 'stock');
  const measureLabel = onCount ? countGroup.plural : 'valor';
  const ufMeasure   = u => (onCount ? (u[countGroup.key] || 0) : u.value);
  // The quantity as it came: an absent one is dropped by the `> 0` filter below, exactly as the
  // value is, instead of standing in as a counted zero.
  const prodMeasure = pt => (onCount ? pt.q : pt.v);

  const ufValues = realUf.map(ufMeasure).filter(v => v > 0);
  // Override `value` with the active measure so every downstream consumer (bars,
  // topNShare, Lorenz) reads the same field regardless of the value-vs-headcount basis.
  const ufSorted = realUf.filter(u => ufMeasure(u) > 0)
    .map(u => ({ ...u, value: ufMeasure(u) }))
    .sort((a, b) => b.value - a.value);

  // ── Product distribution (latest year, by product) ──────────────────
  // On a count, only the group's own products enter (each by its own count): the rest of
  // the basket counts something else, and is named on screen (CountLeftOutNote).
  const prodValues = prodPoints
    .filter(p => !onCount || inCountGroup.has(p.code))
    .map(p => ({ code: p.code, name: p.name, value: prodMeasure(p) }))
    .filter(p => p.value > 0)
    .sort((a, b) => b.value - a.value);

  // ── Metrics ──────────────────────────────────────────────────────────
  const gini = (vals) => {
    const s = vals.slice().filter(v => v > 0).sort((a, b) => a - b);
    const n = s.length;
    if (n < 2) return 0;
    const total = s.reduce((a, b) => a + b, 0);
    if (!total) return 0;
    let cum = 0;
    s.forEach((v, i) => { cum += (i + 1) * v; });
    return (2 * cum) / (n * total) - (n + 1) / n;
  };
  // HHI devolve NULL sem unidades — não 0. Um 0 aqui era lido pela faixa como "baixa
  // concentração", em VERDE, para um conjunto vazio: um sinal de tudo-certo sobre nada.
  // O Gini ao lado já recusava com "n/d" (giniInfo, abaixo) e o comentário dele explica
  // por quê; a mesma regra faltava no gêmeo, no mesmo arquivo, 27 linhas depois.
  const hhi = (vals) => {
    const total = window.sumPresent(vals);
    if (!total || !vals.length) return null;
    return vals.reduce((s, v) => s + Math.pow((v / total) * 100, 2), 0);
  };
  // A MESMA regra do HHI acima, que faltava aqui: `total = ... || 1` devolvia 0/1 = 0
  // para um conjunto vazio, e "0% concentrado" se lê como "perfeitamente disperso" — a
  // afirmação oposta de "não há o que concentrar". `hasGeo` só exige LINHAS de UF, não
  // valores positivos, então um recorte cujos produtos não produzem nada em UF alguma
  // chega até aqui com a lista cheia e os valores zerados. null vira '—' no fmtPct.
  //
  // Uma UF só NÃO é recusa: 100% é a resposta certa, e o piso aqui é sobre a ausência
  // de base, não sobre base pequena.
  const topNShare = (sorted, n) => {
    const total = window.sumPresent(sorted.map(x => x.value));
    if (!total || total <= 0) return null;
    return sorted.slice(0, n).reduce((s, x) => s + x.value, 0) / total;
  };

  const ufGini = gini(ufValues);
  const ufHHI  = hhi(ufValues);
  const prodGini = gini(prodValues.map(p => p.value));
  const prodHHI  = hhi(prodValues.map(p => p.value));
  const top5UF = topNShare(ufSorted, 5);
  const top3Prod = topNShare(prodValues, 3);

  const hhiBand = (h) =>
    !Number.isFinite(h) ? { label: 'sem dados', color: 'var(--fg-4)' }
    : h > 2500 ? { label: 'alta concentração', color: 'var(--err)' }
    : h > 1500 ? { label: 'concentração moderada', color: 'var(--warn)' }
    : { label: 'baixa concentração', color: 'var(--ok)' };
  // O número do HHI na tela: 'n/d' quando não há conjunto para medir.
  const hhiValue = (h) => (Number.isFinite(h) ? Math.round(h).toLocaleString('pt-BR') : 'n/d');
  const giniBand = (g) =>
    g > 0.6 ? { label: 'muito desigual', color: 'var(--err)' }
    : g > 0.4 ? { label: 'desigual', color: 'var(--warn)' }
    : { label: 'relativamente uniforme', color: 'var(--ok)' };

  // Gini/Lorenz need ≥2 units to mean anything. With a single product/UF the
  // formula degenerates to 0 ("relativamente uniforme"), which contradicts the
  // HHI reading (max concentration). Surface "n/d" instead of a false reading.
  const giniInfo = (count, g) => count < 2
    ? { value: 'n/d', label: count === 1 ? 'unidade única' : 'sem dados', color: 'var(--fg-4)' }
    : { value: g.toFixed(2).replace('.', ','), ...giniBand(g) };
  const ufG   = giniInfo(ufValues.length, ufGini);
  const prodG = giniInfo(prodValues.length, prodGini);

  // What a held number shows — "…" on its way, "—" failed or unanswerable — and why. Same
  // marks as the Visão geral strip, so one recorte reads the same on every screen.
  const geoSegura = geoEspera || !!geoFalhou;
  const geoKpi = (val) => (geoFalhou ? '—' : geoEspera ? '…' : val);
  const geoSub = (txt) => (geoFalhou ? 'recorte sub-UF não carregado'
    : geoEspera ? 'carregando o recorte sub-UF…' : txt);
  const prodKpi = (val) => ((prodFalhou || prodIndisponivel) ? '—' : prodEspera ? '…' : val);
  const prodSub = (txt) => (geoFalhou ? 'recorte sub-UF não carregado'
    : ufFalhou ? 'séries das UFs não carregadas'
    : prodFalhou ? 'produtos do recorte não carregados'
    : prodIndisponivel ? 'sem composição por produto abaixo da UF'
    : ufEspera ? 'carregando as séries das UFs…'
    : prodEspera ? 'carregando os produtos do recorte…' : txt);
  const aviso = (texto) => (
    <p className="caption" style={{ padding: '24px 4px', textAlign: 'center' }}>{texto}</p>
  );
  const geoAviso = () => aviso(geoFalhou
    ? 'Não foi possível carregar o recorte territorial.'
    : 'Carregando o recorte territorial…');
  const prodAviso = () => aviso(geoFalhou ? 'Não foi possível carregar o recorte territorial.'
    : (ufEspera || ufFalhou) ? porUf.texto
    : prodFalhou ? 'Não foi possível carregar os produtos dos municípios do recorte.'
    : prodIndisponivel ? 'Este banco não tem a composição por produto abaixo da UF.'
    : 'Carregando os produtos dos municípios do recorte…');

  return (
    <>
      <window.RecorteNote recorte={filtered.recorte} />
      <window.LoadErrorNote error={geoFalhou || prodFalhou} />
      {/* The product half's loading and failure are said in its own card; a banco with no
          per-UF series draws the national ones, and that is said here. */}
      {porUf && porUf.estado === 'nacional' && <window.SeriesPorUfNote filtered={filtered} />}
      {onCount && (
        <div style={{ margin: '0 2px 4px' }}>
          <p className="caption" style={{ margin: 0 }}>
            {soRebanho
              ? <>ⓘ Esta cesta não tem valor monetário (efetivo dos rebanhos) — a concentração
                  é calculada sobre as <strong>cabeças</strong>.</>
              : <>ⓘ Esta cesta não tem valor nesta convenção — a concentração é calculada sobre
                  {countGroup.total === 'stock' ? ' o efetivo' : ' a quantidade'}, em{' '}
                  <strong>{countGroup.plural}</strong>.</>}
          </p>
          <window.CountLeftOutNote groups={countGroups} shown={countGroup} database={database}
                                   marginTop={4} />
        </div>
      )}

      {/* The per-UF concentration reads the all-products UF grid until the product×UF
          cube lands (or when it failed), so under a basket chip the geographic Gini/HHI
          reflect ALL products — surface that honestly instead of letting the number read
          as basket-specific (mirrors ViewGeography's notFilteredByBasket note). */}
      {filtered.notFilteredByBasket && (
        <div className="card subtle" style={{ marginBottom: 12 }}>
          <p className="caption" style={{ padding: '10px 12px' }}>
            A concentração <strong>geográfica (UF)</strong> reflete <strong>todos os produtos</strong>
            do banco — {window.cestaPorUfMotivo(filtered)}. A concentração <strong>por
            produto</strong> abaixo já considera a cesta.
          </p>
        </div>
      )}

      {/* KPI strip */}
      <div className="kpi-row">
        {hasGeo ? (
        <>
        <window.KpiCardSpark
          label="Gini · geográfico (UF)"
          value={geoKpi(ufG.value)}
          sub={geoSub(ufG.label)}
        />
        <window.KpiCardSpark
          label="HHI · geográfico (UF)"
          value={geoKpi(hhiValue(ufHHI))}
          sub={geoSub(hhiBand(ufHHI).label)}
        />
        <window.KpiCardSpark
          label="Concentração nas 5 maiores UFs"
          value={geoKpi(window.fmtPct(top5UF))}
          sub={geoSub(`de ${ufSorted.length} ${ufSorted.length === 1 ? 'UF' : 'UFs'} com produção`)}
        />
        <window.KpiCardSpark
          label="Concentração nos 3 maiores produtos"
          value={prodKpi(window.fmtPct(top3Prod))}
          sub={prodSub(`de ${prodValues.length} ${prodValues.length === 1 ? 'produto' : 'produtos'} ${recorteProds ? 'no recorte' : 'na cesta'}`)}
        />
        </>
        ) : (
        <>
        <window.KpiCardSpark
          label="Gini · por produto"
          value={prodG.value}
          sub={prodG.label}
        />
        <window.KpiCardSpark
          label="HHI · por produto"
          value={hhiValue(prodHHI)}
          sub={hhiBand(prodHHI).label}
        />
        <window.KpiCardSpark
          label="Concentração nos 3 maiores produtos"
          value={window.fmtPct(top3Prod)}
          sub={`de ${prodValues.length} ${prodValues.length === 1 ? 'produto' : 'produtos'} na cesta`}
        />
        </>
        )}
      </div>

      {/* Lorenz curves */}
      <div className="grid-2">
        {hasGeo && (
        <div className="card">
          <window.SectionHeader
            overline={geoSegura ? 'Curva de Lorenz · geográfica' : `Curva de Lorenz · geográfica · ${geoYearTag}`}
            title={`Desigualdade entre UFs · Gini ${geoKpi(ufG.value)}`}
            action={geoSegura ? null
              : <span className="caption" style={{ color: ufG.color }}>{ufG.label}</span>}
          />
          {geoSegura ? geoAviso()
            : <window.LorenzCurve values={ufValues} color="var(--viz-2)" xLabel="UFs" yLabel={measureLabel} height={300} />}
        </div>
        )}
        <div className="card">
          <window.SectionHeader
            overline={`Curva de Lorenz · por produto · ${prodYearTag}`}
            title={`Desigualdade entre produtos · Gini ${prodKpi(prodG.value)}`}
            action={prodSegura ? null
              : <span className="caption" style={{ color: prodG.color }}>{prodG.label}</span>}
          />
          {prodSegura ? prodAviso()
            : <window.LorenzCurve values={prodValues.map(p => p.value)} color="var(--viz-5)" xLabel="produtos" yLabel={measureLabel} height={300} />}
        </div>
      </div>

      {/* Top-5 UF concentration bars + HHI gauges */}
      <div className="grid-2">
        {hasGeo && (
        <div className="card">
          <window.SectionHeader
            overline={geoSegura ? 'Participação acumulada · UFs' : `Participação acumulada · UFs · ${geoYearTag}`}
            title="Quem concentra a produção"
          />
          {geoSegura ? geoAviso() : (
          <div className="conc-list">
            {(() => {
              const total = ufSorted.reduce((s, u) => s + u.value, 0) || 1;
              let acc = 0;
              return ufSorted.slice(0, 10).map((u, i) => {
                const share = u.value / total;
                acc += share;
                return (
                  <div key={u.uf} className="conc-row">
                    <span className="conc-rank tnum">#{i + 1}</span>
                    <span className="conc-name">{u.uf} · {u.name}</span>
                    <div className="conc-bar"><div style={{ width: (share * 100).toFixed(1) + '%', background: 'var(--viz-2)' }}></div></div>
                    <span className="conc-share tnum">{window.fmtPct(share)}</span>
                    <span className="conc-acc tnum">{window.fmtPct(acc)}</span>
                  </div>
                );
              });
            })()}
            <div className="conc-head-note">
              <span></span><span></span><span></span>
              <span className="caption">indiv.</span>
              <span className="caption">acum.</span>
            </div>
          </div>
          )}
        </div>
        )}

        <div className="card">
          <window.SectionHeader
            overline="Índice Herfindahl-Hirschman (HHI)"
            title="Leitura da concentração"
          />
          <div className="conc-hhi">
            {hasGeo && (
            <div className="conc-hhi-row">
              <span className="conc-hhi-label">Geográfico (UF)</span>
              <div className="conc-hhi-track">
                <div className="conc-hhi-fill" style={{ width: (geoSegura ? 0 : Math.min(100, ((ufHHI || 0) / 10000) * 100)) + '%', background: hhiBand(ufHHI).color }}></div>
                <span className="conc-hhi-mark" style={{ left: '15%' }} title="1500"></span>
                <span className="conc-hhi-mark" style={{ left: '25%' }} title="2500"></span>
              </div>
              <span className="conc-hhi-val tnum">{geoKpi(hhiValue(ufHHI))}</span>
            </div>
            )}
            <div className="conc-hhi-row">
              <span className="conc-hhi-label">Por produto</span>
              <div className="conc-hhi-track">
                <div className="conc-hhi-fill" style={{ width: (prodSegura ? 0 : Math.min(100, ((prodHHI || 0) / 10000) * 100)) + '%', background: hhiBand(prodHHI).color }}></div>
                <span className="conc-hhi-mark" style={{ left: '15%' }}></span>
                <span className="conc-hhi-mark" style={{ left: '25%' }}></span>
              </div>
              <span className="conc-hhi-val tnum">{prodKpi(hhiValue(prodHHI))}</span>
            </div>
            <dl className="conc-scale">
              <dt><span className="conc-dot" style={{ background: 'var(--ok)' }}></span>&lt; 1500</dt><dd>baixa concentração</dd>
              <dt><span className="conc-dot" style={{ background: 'var(--warn)' }}></span>1500–2500</dt><dd>concentração moderada</dd>
              <dt><span className="conc-dot" style={{ background: 'var(--err)' }}></span>&gt; 2500</dt><dd>alta concentração</dd>
            </dl>
            <p className="caption conc-note">
              HHI = soma dos quadrados das participações percentuais. As marcas no trilho indicam os limiares 1500 e 2500 (convenção US DoJ).
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

window.ViewConcentration = ViewConcentration;
