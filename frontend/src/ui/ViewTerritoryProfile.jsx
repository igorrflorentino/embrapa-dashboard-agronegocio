// ViewTerritoryProfile — the raio-x of ONE território.
//
// The TRANSPOSE of ViewProductProfile: that one fixes a produto and looks across
// places; this fixes a PLACE and looks across produtos. Same Gold, opposite question.
//
// Deliberately NOT folded into Geografia. Geografia answers "how is the activity
// spread ACROSS territories" — its unit of analysis is the distribution. This answers
// "what happens in THIS territory" — its unit is the place. One perspective serving
// both would mean two things at once.
//
// Entry is EXPLICIT (the pickers below, or Geografia's "Ver raio-x" action). The map
// click stays what it already is everywhere — a cheap, reversible filter toggle.
// Navigation and filtering must not share a gesture.
//
// HOW THIS RELATES TO THE GLOBAL GEOGRAPHY FILTER (they are NOT redundant, but they
// were until v1.29.1, and the overlap was a bug rather than clutter):
//
//     the filter  = the UNIVERSE of the analysis   ("I am studying AM and SP")
//     the picker  = the FOCUS inside that universe ("show me SP right now")
//
// The picker therefore offers ONLY territories the filter admits — the same rule
// ViewProductProfile already follows by limiting its product chips to the basket.
// Shipped the other way round, the picker listed all 27 UFs regardless, so a session
// filtered to AM+SP happily profiled Pará: a displayed value computed over a set the
// researcher had explicitly excluded.
//
// Combining territories is therefore done IN THE FILTER, and the picker exposes the
// combination as a first-class option ("Seleção atual"), which profiles the sum.

const { useState: useTPState, useMemo: useTPMemo } = React;

// Which grains this banco can actually answer for. COMEX is origin-UF only; COMTRADE
// has no national geography at all (and never reaches here — requires:['geo']).
// Stating this on the page is the point: silently offering only UF would read as
// "this place has no municípios", a different and false claim.
function tpGrains(database) {
  const level = window.geoLevelFor ? window.geoLevelFor(database) : 'municipio';
  return { municipio: level === 'municipio' };
}

// The composition splits into what the bar chart can draw and what it cannot — and the
// second group stays NAMED, never dropped in silence:
//   rebanho  — PPM's herd (`measure_kind = 'stock'`): a headcount, with no production value
//              by construction (the marts sum value over flows only). Asked by its own
//              flag, never by table id: a herd is what the row SAYS it is.
//   semValor — a flow with no value in this convention over the whole window (PAM and PPM
//              in IPCA before 1980). Absent, not zero: a zero-length bar would claim a
//              measurement that was never made.
// Names are disambiguated over everything the card SHOWS (bars + both lists), because
// labelProductRows adds the PEVS half only when a name repeats in the displayed set. The
// lists are alphabetical: they have no value to rank by, and ranking the herd by head
// count would compare species, which cabeças cannot do.
function tpComposition(products, database, limit = 12) {
  const todos = products || [];
  const rebanho = todos.filter((p) => p.measure_kind === 'stock');
  const fluxos = todos.filter((p) => p.measure_kind !== 'stock');
  const semValor = fluxos.filter((p) => p.value == null);
  const comValor = fluxos.filter((p) => p.value != null)
    .sort((a, b) => b.value - a.value).slice(0, limit);
  const rotulados = window.labelProductRows([...comValor, ...rebanho, ...semValor], database);
  const nomes = (rows) => rows.map((p) => p.name || p.code)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const corte = comValor.length + rebanho.length;
  return {
    barras: rotulados.slice(0, comValor.length),
    rebanho: nomes(rotulados.slice(comValor.length, corte)),
    semValor: nomes(rotulados.slice(corte)),
  };
}

function ViewTerritoryProfile({ summary, database, conventions }) {
  const conv = conventions || window.DEFAULT_CONVENTIONS;
  const fx = window.CURRENCY_FX[conv.currency];
  const cvf = window.convFactor(conv);
  const filtered = window.applyFilters(summary || {}, database);
  const grains = tpGrains(database);

  // ── Which território? ──────────────────────────────────────────────────────
  // Seeded from the global filter when it already names ONE place, so arriving from a
  // map click lands on what the researcher just picked instead of resetting on them.
  const seedUf = window.selectedSingleUf ? window.selectedSingleUf(summary) : null;
  const seedCity = (summary && Array.isArray(summary.munis) && summary.munis.length === 1)
    ? String(summary.munis[0]) : null;

  const [level, setLevel] = useTPState(seedCity && grains.municipio ? 'municipio' : 'uf');
  const activeLevel = (level === 'municipio' && grains.municipio) ? 'municipio' : 'uf';

  // The UF universe this banco reports (ufDataFull is the ALL-TIME universe — one row
  // per UF — NOT a total; totals are computed over the window below).
  const ufUniverseAll = filtered.ufDataFull || [];
  const ufYearly = filtered.ufYearlySeries || [];

  // What the FILTER admits. A state narrowing names its UFs directly; a sub-UF facet
  // (meso/micro/intermediária/imediata/município) resolves to a city set, whose UFs are
  // the admitted ones. Empty/absent ⇒ no narrowing ⇒ the whole universe.
  const scopedCities = filtered.scopedCityCodes || null;
  // The mesh as a STATE (v1.108.1): the city picker, the trajectory and the composition must
  // tell a mesh still on its way from one that failed — both leave `municipios` null.
  const meshState = window.geoMeshState
    ? window.geoMeshState()
    : { municipios: null, loading: false, loadError: null };
  const meshAll = meshState.municipios;
  const allowedUfs = useTPMemo(() => {
    const fromStates = (summary && Array.isArray(summary.states) && summary.states.length)
      ? new Set(summary.states) : null;
    if (!scopedCities || !Array.isArray(meshAll)) return fromStates;
    const byCode = new Map(meshAll.map((m) => [String(m.cityCode), m.uf]));
    const fromCities = new Set(
      scopedCities.map((c) => byCode.get(String(c))).filter(Boolean),
    );
    if (!fromStates) return fromCities;
    return new Set([...fromCities].filter((u) => fromStates.has(u)));
  }, [summary, scopedCities, meshAll]);

  const ufUniverse = useTPMemo(
    () => (allowedUfs ? ufUniverseAll.filter((u) => allowedUfs.has(u.uf)) : ufUniverseAll),
    [ufUniverseAll, allowedUfs],
  );
  const yearStart = filtered.yearStart;
  const yearEnd = filtered.yearEnd;

  // Per-UF totals over the SELECTED window. Computed here rather than read off
  // `ufData`, which is latest-year-only: a share/rank taken from one year while the
  // chart beside it spans the whole window would be two different questions wearing
  // one label.
  const ufTotals = useTPMemo(() => {
    const acc = new Map();
    for (const r of ufYearly) {
      if (r.year < yearStart || r.year > yearEnd) continue;
      acc.set(r.uf, (acc.get(r.uf) || 0) + (r.value || 0));
    }
    return acc;
  }, [ufYearly, yearStart, yearEnd]);

  const ufOptions = useTPMemo(() => {
    const named = new Map(ufUniverse.map((u) => [u.uf, u.name || u.uf]));
    const codes = [...new Set([...named.keys(), ...ufTotals.keys()])]
      .filter((code) => !allowedUfs || allowedUfs.has(code));
    return codes
      .map((code) => ({ uf: code, name: named.get(code) || code, total: ufTotals.get(code) || 0 }))
      .sort((a, b) => b.total - a.total);
  }, [ufUniverse, ufTotals, allowedUfs]);

  // Combining territories happens in the FILTER; this is where that combination becomes
  // a thing you can profile. Offered ONLY when the filter actually named a set: with no
  // geography filter at all, "Seleção atual" would mean the whole country, which is
  // Visão geral's job — a território profile of Brazil profiles nothing.
  const canCombine = !!allowedUfs && ufOptions.length > 1;
  const COMBINED = '__combinado__';

  const [ufPick, setUfPick] = useTPState(seedUf);
  const ufValid = (v) => v === COMBINED ? canCombine : ufOptions.some((u) => u.uf === v);
  // Default to the combination when the filter names several territories: the researcher
  // asked for that set, so the set is the honest first answer — drilling into one of them
  // is one click away, but guessing which one they meant is not ours to do.
  const ufDefault = canCombine && !seedUf ? COMBINED : (ufOptions[0] && ufOptions[0].uf) || null;
  const uf = ufValid(ufPick) ? ufPick : (ufValid(seedUf) ? seedUf : ufDefault);
  const combined = uf === COMBINED;
  // The UFs actually being profiled: all admitted ones when combined, else the one.
  const activeUfs = useTPMemo(
    () => (combined ? ufOptions.map((u) => u.uf) : (uf ? [uf] : [])),
    [combined, ufOptions, uf],
  );

  // Município universe — scoped the same way. A sub-UF facet already resolved to a city
  // set; offering a município outside it would profile a place the filter excluded.
  const mesh = meshAll;
  const cityOptions = useTPMemo(() => {
    if (!Array.isArray(mesh) || !activeUfs.length) return [];
    const allowedCities = scopedCities ? new Set(scopedCities.map(String)) : null;
    return mesh
      .filter((m) => activeUfs.includes(m.uf))
      .filter((m) => !allowedCities || allowedCities.has(String(m.cityCode)))
      .map((m) => ({ code: String(m.cityCode), name: m.cityName || String(m.cityCode), uf: m.uf }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [mesh, activeUfs, scopedCities]);

  const [cityPick, setCityPick] = useTPState(seedCity);
  // Same rule as the UF level: a combination is only meaningful when the FILTER named
  // the set. Without a sub-UF facet, "Seleção atual" would just be the whole state —
  // which is precisely what the UF level already shows.
  const cityCanCombine = !!scopedCities && cityOptions.length > 1;
  const cityValid = (v) => v === COMBINED ? cityCanCombine : cityOptions.some((c) => c.code === v);
  const cityDefault = cityCanCombine && !seedCity
    ? COMBINED : (cityOptions[0] && cityOptions[0].code) || null;
  const city = cityValid(cityPick) ? cityPick : (cityValid(seedCity) ? seedCity : cityDefault);
  const cityCombined = city === COMBINED;
  const activeCities = useTPMemo(
    () => (cityCombined ? cityOptions.map((c) => c.code) : (city ? [city] : [])),
    [cityCombined, cityOptions, city],
  );

  const cityName = (cityOptions.find((c) => c.code === city) || {}).name || city;
  const cityUf = (cityOptions.find((c) => c.code === city) || {}).uf;
  const ufName = combined
    ? `${ufOptions.length} UFs selecionadas`
    : ((ufOptions.find((u) => u.uf === uf) || {}).name || uf || '—');
  // No município resolved (the mesh on its way, failed or empty) is "—", like an unresolved UF
  // above — not "— ·", the separator dangling from a name that never came (v1.108.1).
  const placeLabel = activeLevel === 'municipio'
    ? (cityCombined ? `${cityOptions.length} municípios selecionados`
      : !cityName ? '—' : cityUf ? `${cityName} · ${cityUf}` : cityName)
    : ufName;
  // A combination is named in the plural ("2 municípios selecionados"), and a verb after it
  // agrees: "O que 2 municípios selecionados produz" until v1.108.2.
  const placePlural = activeLevel === 'municipio' ? cityCombined : combined;

  // ── The território's trajectory ───────────────────────────────────────────
  // A combination is SUMMED, which is legitimate here: these are production values in
  // one unit and one deflation basis, so the sum is the selection's own series.
  // null = not asked (no city resolved yet); else { rows, priceBase, loading, loadError }.
  const muniRead = (activeLevel === 'municipio' && activeCities.length && window.municipioYearly)
    ? window.municipioYearly(database, summary, activeCities, [yearStart, yearEnd])
    : null;
  const muniCube = muniRead ? muniRead.rows : null;
  // The month that cube's corrected values are at — same response as the rows (v1.105.0).
  const muniCubeBase = muniRead ? muniRead.priceBase : null;

  // Where the trajectory — and the two indicators read off it — stands. Only the last branch
  // is a measurement: until v1.108.1 "Sem série" and "sem dados" were printed while the cube
  // was on its way (1–3 s on every change of município), and for good when it failed.
  //   município — the IBGE mesh names the cities, then the município cube sums them;
  //   UF        — applyFilters' grid, which under a sub-UF facet is the rollup of that same
  //               cube, behind the same mesh.
  const gradeEstado = {
    loading: !!filtered.subUfLoading,
    loadError: filtered.subUfLoadError || null,
  };
  const leitura = activeLevel !== 'municipio'
    ? gradeEstado
    : meshState.loadError
      ? { loading: false, loadError: meshState.loadError }
      : !Array.isArray(meshAll)
        ? { loading: true, loadError: null }
        : muniRead
          ? { loading: muniRead.loading, loadError: muniRead.loadError }
          : { loading: false, loadError: null }; // no município in the selection: nothing asked

  const series = useTPMemo(() => {
    const rows = activeLevel === 'municipio'
      ? (muniCube || [])
      : ufYearly.filter((r) => activeUfs.includes(r.uf));
    // addPresent, não `(r.value || 0)`: um ano que a correção escolhida não alcança (PAM
    // de 1974 a 1979 em IPCA) tem TODAS as linhas sem valor, e a soma com `|| 0` desenhava
    // a trajetória descendo a zero nesses anos. Ausente, o ano vira lacuna.
    const byYear = new Map();
    for (const r of rows) {
      if (r.year < yearStart || r.year > yearEnd) continue;
      byYear.set(r.year, window.addPresent(byYear.has(r.year) ? byYear.get(r.year) : null,
        r.value == null ? NaN : r.value));
    }
    return [...byYear.entries()]
      // LineChart reads `d.y` for the x axis; the cubes carry `year`.
      .map(([y, v]) => ({ y, v: window.scalePresent(v, 1e6 * cvf) }))
      .sort((a, b) => a.y - b.y);
  }, [activeLevel, muniCube, ufYearly, activeUfs, yearStart, yearEnd, cvf]);

  // ── What the território produces ──────────────────────────────────────────
  // Both cubes GROUP BY place and sum the produtos away, so neither can name what is
  // behind the trajectory. Both readers take a SET, so a combination needs no special
  // case — it is one query over the selected territories.
  const ufBreakdown = (activeLevel === 'uf' && activeUfs.length && window.productsByUf)
    ? window.productsByUf(database, { ...(summary || {}), states: activeUfs }, conv)
    : null;
  const muniBreakdown = (activeLevel === 'municipio' && activeCities.length && window.productsByMunicipio)
    ? window.productsByMunicipio(database, summary, conv, activeCities)
    : null;
  // No reader called means no place resolved yet. At município level that is the IBGE mesh
  // still on its way (the city picker says "carregando municípios…" for the same reason):
  // nothing was asked, so the card says it is loading — never "sem produtos". A mesh that
  // FAILED is not on its way: the card says it failed (it said "carregando" forever until
  // v1.108.1).
  const muniMeshError = activeLevel === 'municipio' ? meshState.loadError : null;
  const breakdown = ufBreakdown || muniBreakdown || {
    products: [],
    loading: activeLevel === 'municipio' && !Array.isArray(mesh) && !muniMeshError,
    unavailable: false,
    loadError: muniMeshError,
  };

  // ── National weight + rank ────────────────────────────────────────────────
  // The denominator is every UF in the GRID on purpose — it deliberately ignores the
  // geography filter, because a share against only the selected states would always
  // read 100%. The KPI names both the numerator and the window so it stays checkable.
  const nationalTotal = useTPMemo(
    () => [...ufTotals.values()].reduce((s, v) => s + v, 0), [ufTotals],
  );
  const ufTotal = activeUfs.reduce((acc, code) => acc + (ufTotals.get(code) || 0), 0);

  // A sub-UF narrowing (meso/micro/intermediária/imediata/município) makes the per-UF
  // series a ROLLUP OF THE SELECTED CITIES ONLY, so summing it gives the selection's own
  // total — not the country's. Dividing by that would print ~100% and call it
  // "participação no país". There is no honest national denominator on this basis (the
  // unnarrowed grid is all-products, so it would mix bases), so the KPI says it cannot
  // be computed instead of showing a confident wrong number.
  const nationalAvailable = !filtered.subUfActive;
  const share = (nationalAvailable && nationalTotal) ? ufTotal / nationalTotal : null;
  // Rank is a position in the COUNTRY, not inside the current selection — "1º de 1 UF
  // na seleção" is honest and useless. It stays computable under a UF filter because
  // ufYearlySeries is narrowed only by SUB-UF facets, never by the state filter; under
  // a sub-UF narrowing there is no country-wide ordering to place anyone in.
  const rankable = !combined && !filtered.subUfActive;
  const countryOrder = useTPMemo(
    () => [...ufTotals.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code),
    [ufTotals],
  );
  const rank = rankable ? countryOrder.indexOf(uf) + 1 : 0;
  const rankUniverse = countryOrder.length;

  // The years each multi-year SUM on this screen actually adds (v1.105.0), read off the rows
  // it sums — the window's years with a value in the convention (window.faixaComValor), not
  // the window itself: IPCA has no value for PAM in 1974–1979, and a label claiming those
  // years would claim the sum covers them. Share and rank sum the whole UF grid. The
  // composition sums the same rows as the trajectory (same place, filter and base) — except
  // at UF level under a sub-UF narrowing, where the trajectory is the narrowed cities' rollup
  // and the composition the whole UF; there the requested window is all that can be said.
  const somaNacional = window.periodoDaSoma
    ? window.periodoDaSoma(window.faixaComValor(ufYearly, 'year', 'value', yearStart, yearEnd))
    : null;
  const somaLocal = window.periodoDaSoma
    ? window.periodoDaSoma(activeLevel === 'uf' && filtered.subUfActive
      ? [yearStart, yearEnd]
      : window.faixaComValor(series, 'y', 'v', yearStart, yearEnd))
    : null;

  const last = series[series.length - 1] || null;
  const prev = series[series.length - 2] || null;
  // deltaPctIn, not `(last.v - prev.v) / prev.v`: with the last year absent that gave
  // −100%, and across a currency reform it measured the change of currency. The reason
  // for a currency refusal goes in the sub line, as in Perfil do produto.
  const eraBreaks = window.valueEraBreaksFor ? window.valueEraBreaksFor(database) : [];
  const deltaV = last && prev ? window.deltaPctIn(prev, last, eraBreaks) : null;
  const deltaVMoeda = last && prev ? window.spanComparable(prev.y, last.y, eraBreaks) : null;
  // The peak among the years that HAVE a value; with none, there is no peak to name.
  const peak = series.reduce((m, d) => (Number.isFinite(d.v) && (!m || d.v > m.v) ? d : m), null);

  if (!uf || !activeUfs.length) {
    return (
      <window.EmptyCard>
        Nenhum território com dados na seleção atual. Ajuste os filtros para escolher um lugar.
      </window.EmptyCard>
    );
  }

  const scaled = window.scaleSeries(
    series, Math.max(...series.map((d) => d.v), 0), conv, 'v', fx.symbol,
  );
  // BarChart labels each row from `d.uf || d.name` — the product name is the category, e
  // categorias homônimas o Plotly funde numa posição só. Madeira, lenha e carvão existem
  // nas DUAS metades do PEVS com o mesmo nome: sem `labelProductRows` (dentro de
  // tpComposition) aparecia UMA barra com os DOIS rótulos impressos por cima um do outro.
  const comp = tpComposition(breakdown.products, database);
  // scalePresent, não `(p.value || 0) * …`: o `|| 0` refazia na tela o zero que o
  // serializer passou a recusar, e `null * fator === 0` faria o mesmo sozinho.
  const prodRows = comp.barras
    .map((p) => ({ name: p.name || p.code, value: window.scalePresent(p.value, 1e6 * cvf) }));
  const nivelTerritorio = activeLevel === 'municipio' ? 'município' : 'UF';
  const prodScaled = window.scaleSeries(
    prodRows, Math.max(...prodRows.map((p) => p.value), 0), conv, 'value', fx.symbol,
  );

  return (
    <>
      {/* Território picker — explicit, so the map click stays a filter toggle. */}
      <div className="card subtle"
           style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', padding: 12 }}>
        <span className="caption">Território em análise</span>
        {grains.municipio && (
          <div className="seg" role="group" aria-label="Nível do território">
            <button className={'seg-opt ' + (activeLevel === 'uf' ? 'on' : '')}
                    aria-pressed={activeLevel === 'uf'} onClick={() => setLevel('uf')}>UF</button>
            <button className={'seg-opt ' + (activeLevel === 'municipio' ? 'on' : '')}
                    aria-pressed={activeLevel === 'municipio'} onClick={() => setLevel('municipio')}>Município</button>
          </div>
        )}
        <label className="uf-scope">
          <span className="caption">UF</span>
          {/* `.scope-select`, não `.seg-opt`: aquela é transparente e sem borda porque vive
              DENTRO da caixa do `.seg`. Solta, virava texto com uma setinha. */}
          <select className="scope-select" value={uf}
                  aria-label="UF do território"
                  onChange={(e) => { setUfPick(e.target.value); setCityPick(null); }}>
            {canCombine && (
              <option value={COMBINED}>Seleção atual ({ufOptions.length} UFs somadas)</option>
            )}
            {ufOptions.map((u) => <option key={u.uf} value={u.uf}>{u.uf} · {u.name}</option>)}
          </select>
        </label>
        {activeLevel === 'municipio' && (
          <label className="uf-scope">
            <span className="caption">Município</span>
            <select className="scope-select"
                    value={city || ''} aria-label="Município do território"
                    onChange={(e) => setCityPick(e.target.value)} disabled={!cityOptions.length}>
              {cityCanCombine && (
                <option value={COMBINED}>
                  Seleção atual ({cityOptions.length} municípios somados)
                </option>
              )}
              {/* Three reasons for an empty list, and only one is "there is none". */}
              {cityOptions.length
                ? cityOptions.map((c) => (
                    <option key={c.code} value={c.code}>{c.name} · {c.uf}</option>
                  ))
                : meshState.loadError
                  ? <option value="">não foi possível carregar os municípios</option>
                  : !Array.isArray(mesh)
                    ? <option value="">carregando municípios…</option>
                    : <option value="">nenhum município na seleção</option>}
            </select>
          </label>
        )}
      </div>

      {/* What this banco can and cannot answer for a território — stated, not implied.
          NotApplicableNote takes its messages as a `note` OBJECT; passed as children (as
          it was until v1.107.0) it rendered nothing, and the COMEX screen never said why
          it had no município level. */}
      {!grains.municipio && (
        <window.NotApplicableNote note={{
          grao: (
            <>
              Este banco tem grão geográfico apenas por <strong>UF</strong>, então não há
              raio-x municipal aqui. O recorte por UF abaixo é completo.
            </>
          ),
        }} />
      )}

      {/* This perspective's OWN reads — the trajectory's município cube and the composition —
          against the snapshot's month (v1.105.0). The cubes applyFilters reads are already
          compared by MainScreen's note: they go in as `jaComparadas`, so the screen never
          says it twice. */}
      {window.PriceBaseSkewNote && (
        <window.PriceBaseSkewNote
          bases={[muniCubeBase, breakdown.priceBase]}
          jaComparadas={[filtered.muniPriceBase, filtered.geoPriceBase]}
          database={database}
          conventions={conv} />
      )}

      {/* Each indicator answers from the read it stands on: Valor and Pico from the
          trajectory (`leitura`), Participação and Posição from the UF grid (`gradeEstado`).
          While that read is on its way the card says so; when it failed, it says that —
          "sem dados" is kept for a read that came back empty. */}
      <div className="kpi-row">
        <window.KpiCardSpark
          label={<>Valor · {placeLabel}</>}
          value={leitura.loadError ? '—' : leitura.loading ? '…' : (last ? window.formatValue(last.v, conv) : '—')}
          delta={!leitura.loadError && !leitura.loading && deltaV != null ? window.fmtSigned(deltaV) : null}
          deltaPositive={window.deltaUp(deltaV)}
          sub={leitura.loadError
            ? 'não foi possível carregar a série'
            : leitura.loading
              ? 'carregando a série…'
              : last && prev
                ? `${last.y} vs. ${prev.y}${deltaVMoeda ? ` · ${deltaVMoeda}` : ''}`
                : (last ? String(last.y) : 'sem dados')}
          spark={leitura.loadError || leitura.loading ? null : series}
        />
        <window.KpiCardSpark
          label="Participação no país"
          value={gradeEstado.loadError ? '—' : gradeEstado.loading ? '…' : (share != null ? window.fmtPct(share) : '—')}
          sub={gradeEstado.loadError
            ? 'indisponível: o recorte sub-UF não carregou'
            : gradeEstado.loading
              ? 'carregando o recorte sub-UF…'
              : nationalAvailable
                ? `${ufName} sobre o total das UFs · ${somaNacional || `${yearStart}–${yearEnd}`}`
                : 'indisponível sob recorte sub-UF (não há denominador nacional nesta base)'}
        />
        <window.KpiCardSpark
          label="Posição no ranking"
          value={gradeEstado.loadError ? '—' : gradeEstado.loading ? '…' : (rank ? `${rank}º` : '—')}
          sub={gradeEstado.loadError
            ? 'indisponível: o recorte sub-UF não carregou'
            : gradeEstado.loading
              ? 'carregando o recorte sub-UF…'
              : rankable
                ? `de ${rankUniverse} UFs no banco · por valor · ${somaNacional || 'na janela'}`
                : (combined ? 'uma soma de territórios não tem posição' : 'indisponível sob recorte sub-UF')}
        />
        <window.KpiCardSpark
          label="Pico histórico"
          value={leitura.loadError ? '—' : leitura.loading ? '…' : (peak ? window.formatValue(peak.v, conv) : '—')}
          sub={leitura.loadError
            ? 'não foi possível carregar a série'
            : leitura.loading
              ? 'carregando a série…'
              : (peak ? `em ${peak.y}` : 'sem dados na janela')}
        />
      </div>

      {/* Share and rank are always UF-level: the país-wide denominator only exists per
          UF. Saying so beats letting a município reading borrow the state's number. */}
      {activeLevel === 'municipio' && (share != null || rank > 0) && (
        <p className="caption" style={{ margin: '4px 2px 12px' }}>
          Participação e posição referem-se a <strong>{ufName}</strong> — o denominador
          nacional existe por UF, não por município.
        </p>
      )}

      <div className="card">
        <window.SectionHeader
          overline={`Trajetória · ${window.conventionMonetaryLabel(conv)}`}
          title={`Evolução de ${placeLabel}`}
        />
        {leitura.loadError
          ? <window.LoadErrorNote error={leitura.loadError} />
          : leitura.loading
            ? (
              <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
                Carregando a série…
              </p>
            )
            : series.length
              ? <window.LineChart data={scaled.data} valueKey="v" label={scaled.label} />
              : <window.EmptyCard>Sem série para este território na janela selecionada.</window.EmptyCard>}
      </div>

      <div className="card">
        <window.SectionHeader
          overline={somaLocal ? `Composição · ${somaLocal}` : 'Composição'}
          title={`O que ${placeLabel} ${placePlural ? 'produzem' : 'produz'}`}
        />
        {/* Only the LAST branch is a measurement. Loading, a failed request and a banco
            with no reader at this level all used to fall through to "Sem produtos
            registrados" — an absence nobody had measured. The failure note lives here,
            in the card it concerns, rather than above the KPIs it does not touch. */}
        {breakdown.loadError
          ? <window.LoadErrorNote error={breakdown.loadError} />
          : breakdown.loading
            ? (
              <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
                Carregando a composição…
              </p>
            )
            : breakdown.unavailable
              ? (
                <window.NotApplicableNote note={{
                  leitor: `A composição por produto ainda não está disponível para este banco no nível ${nivelTerritorio}.`,
                }} />
              )
              : !prodRows.length && !comp.rebanho.length && !comp.semValor.length
                ? <window.EmptyCard>Sem produtos registrados para este território na seleção atual.</window.EmptyCard>
                : (
                  <>
                    {prodRows.length
                      ? <window.BarChart data={prodScaled.data} valueKey="value" label={prodScaled.label} />
                      : (
                        <p className="caption" style={{ padding: '20px 4px', textAlign: 'center' }}>
                          Nenhum produto deste território tem valor a mostrar na seleção atual — veja
                          abaixo por quê.
                        </p>
                      )}
                    <window.CollapsingNameList
                      titulo="Efetivo dos rebanhos"
                      itens={comp.rebanho}
                      substantivo="espécies"
                      regra={(
                        <>
                          É um <strong>estoque</strong> (nº de cabeças), não uma produção: não tem
                          valor monetário e por isso não entra na composição por valor. Veja a
                          perspectiva <strong>Rebanho</strong>.
                        </>
                      )}
                    />
                    <window.CollapsingNameList
                      titulo="Sem valor nesta convenção"
                      itens={comp.semValor}
                      substantivo="produtos"
                      regra="Nenhum ano da janela selecionada tem valor nesta convenção para eles, por isso não entram na composição por valor."
                    />
                  </>
                )}
      </div>
    </>
  );
}

window.ViewTerritoryProfile = ViewTerritoryProfile;
