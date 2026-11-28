// ViewRebanho — the livestock HERD perspective (PPM 'herd' capability).
//
// The efetivo dos rebanhos is a STOCK in cabeças (head counted at year-end): it has
// NO monetary value and is NOT additive across species (a head of cattle and a head
// of poultry are not comparable). So this view is cabeças-only — composition, the
// 50-year per-species evolution, and a per-UF map of the focused species — with the
// value/price machinery of the production views deliberately absent. The herd is
// ~⅔ of PPM's Gold rows yet was invisible until the `q_count` quantity track landed;
// this is its home.

// window.recorteNaoSeAplica — imported for real, so the view's tests load it on their own.
import './RecorteNote.jsx';
// window.countGroups / countProductUnit / CountRefusedNote — the herd is named by what it
// counts (cabeças), never by the convention's bare 'un'.
import './countUnits.js';
import './CountUnitNotes.jsx';

const { useState: useRbState, useEffect: useRbEffect } = React;

function ViewRebanho({ summary, conventions, database }) {
  const conv     = conventions || window.DEFAULT_CONVENTIONS;
  const filtered = window.applyFilters(summary || {}, database);

  // Herd = STOCK products (measure_kind='stock', count family). Animal-product flows
  // (eggs, milk) share the count/volume families but belong to the value views — the
  // measure_kind discriminator is exactly what separates them.
  const herdCodes = filtered.products.filter(p => p.measure_kind === 'stock').map(p => p.code);
  // COM PONTO NA JANELA, não apenas presente no banco: o card "Espécies no efetivo"
  // traz o período no subtítulo, então contar espécies que não têm dado nele nomeia uma
  // coisa e conta outra. Medido na tela em 2026-09-08 com a janela em 1950–1960 (fora da
  // cobertura da PPM): "Espécies no efetivo = 8 · 1950–1960".
  const available = herdCodes.filter(
    c => (filtered.allProductTS[c] || []).some(
      d => d.y >= filtered.yearStart && d.y <= filtered.yearEnd),
  );

  const yearStart = filtered.yearStart, yearEnd = filtered.yearEnd;
  const qtyMul = window.countQtyMul(conv);
  const PALETTE = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)',
                   'var(--viz-5)', 'var(--viz-6)', 'var(--viz-7)', 'var(--viz-9)'];
  const hasGeo = filtered.ufDataFull.length > 0;

  // Focused species (drives the KPIs + the per-UF map) — default = largest by latest
  // headcount. Hooks sit ABOVE the early return so their order is stable (Rules of Hooks).
  const defaultCode = available
    // `?? null`: an absent headcount sorts as 0 here, and only decides which species opens.
    .map(c => ({ c, q: filtered.allProductTS[c].slice(-1)[0]?.q ?? null }))
    .sort((a, b) => b.q - a.q)[0]?.c || null;
  const [focus, setFocus] = useRbState(defaultCode);
  const activeFocus = (focus && available.includes(focus)) ? focus : defaultCode;

  // REAL per-UF headcount for the focused species (Gold product×UF via /api/product-uf,
  // which now carries q_count). A value-less stock would rank all-zero by `value`.
  // Stable primitive for the fetch effect's deps: the states ARRAY is a new
  // identity every render, so depending on it directly would refetch forever.
  // `null` (no UF filter) is kept distinct from '' (explicitly none selected) —
  // the same null-vs-empty contract the other producers honour.
  const ufScopeKey = summary?.states == null ? null : summary.states.join(',');
  const [ufRank, setUfRank] = useRbState({ rows: null, loading: true });
  useRbEffect(() => {
    if (!activeFocus || !hasGeo) return undefined;
    let alive = true;
    setUfRank({ rows: null, loading: true });
    const qs = new URLSearchParams({
      banco: database, code: activeFocus, currency: conv.currency, correction: conv.correction,
    });
    if (summary?.startDate) qs.set('startDate', summary.startDate);
    if (summary?.endDate) qs.set('endDate', summary.endDate);
    // The UF filter reaches this reader now. Without it the ranking/map showed all 27
    // states while the rest of the screen was narrowed to the researcher's selection.
    // Read from ufScopeKey (not summary.states) so the effect depends ONLY on the
    // stable primitive that is in its deps array.
    if (ufScopeKey != null) qs.set('states', ufScopeKey);
    fetch(`/api/product-uf?${qs}`)
      // Distinguish a LOAD FAILURE from a legitimately empty ranking (else "Sem dados por UF
      // para esta espécie" would read as a false claim when the fetch merely failed).
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (alive) setUfRank({ rows: (d && d.uf) || [], loading: false, error: false }); })
      .catch(() => { if (alive) setUfRank({ rows: null, loading: false, error: true }); });
    return () => { alive = false; };
    // `states` joined, not the array: a fresh array identity every render would
    // refetch on every render, while omitting it entirely would never refetch when
    // the researcher changes the UF filter — the map would keep the old scope.
  }, [database, activeFocus, hasGeo, conv.currency, conv.correction, summary?.startDate, summary?.endDate, ufScopeKey]);

  // The species series and the map go no finer than a whole UF: a sub-UF recorte cannot apply
  // here, and the screen says so in every state of it (v1.108.2).
  const recorteNota = window.recorteNaoSeAplica(filtered,
    'o efetivo de cada espécie existe aqui por UF inteira, não por município.');
  // Under a UF subset the species series are the selected UFs' (v1.108.3). While that read is
  // on its way, or after it failed, there is no herd to show — the national one would be
  // Brazil's under the UF chip — and the screen says which, never "nenhum rebanho".
  const porUf = window.seriesPorUf(filtered);
  if (porUf && porUf.estado !== 'nacional') {
    return (
      <>
        <window.NotApplicableNote note={{ recorte: recorteNota }} />
        <window.SeriesPorUfNote filtered={filtered} />
      </>
    );
  }
  // Whose herd the series are: the selected UFs' once their own series are here, Brazil's
  // otherwise. The title said "Rebanho brasileiro" whatever the filter.
  const escopoUf = (() => {
    if (!filtered.productUfRequested || filtered.productUfUnavailable) return null;
    const ufs = (summary && summary.states) || [];
    if (ufs.length !== 1) return `${ufs.length} UFs`;
    const uf = (window.UF_DATA || []).find((u) => u.uf === ufs[0]);
    return uf ? uf.name : ufs[0];
  })();

  if (!available.length) {
    return (
      <window.EmptyCard>
        Nenhum rebanho (estoque) na seleção atual. Ajuste os filtros para incluir
        espécies do efetivo dos rebanhos.
      </window.EmptyCard>
    );
  }

  // What the counts are named by (countUnits.js), never the convention's bare 'un' or 'cab'.
  // The composition and the evolution put every species on ONE unit, so they take the herd's
  // group: heads of different species are one unit, cabeças. A species whose unit is not
  // recognised would make that shared unit a claim about something it may not count, so the
  // group is refused and named instead (CountRefusedNote), as every other count total is.
  // The focused species' cards and map are its own, and name its own unit.
  const herdGroup = window.countGroups(filtered.products, available)
    .find(g => g.total === 'stock') || null;
  const herdUnit = herdGroup && !herdGroup.mixed ? window.countGroupUnit(herdGroup, conv) : null;

  // Latest-year composition: each species' headcount share. A cross-species comparison
  // shown ONLY as relative composition (the caveat note makes the non-additivity explicit).
  const latestByCode = {};
  available.forEach(c => {
    const s = filtered.allProductTS[c].filter(d => d.y <= yearEnd);
    latestByCode[c] = s.length ? s[s.length - 1] : null;
  });
  // Idem: rebanho todo zerado não é "0% de cada espécie", é ausência de composição.
  // scalePresent: a species with no headcount in the latest year adds nothing to the total and
  // has no share, rather than a counted zero.
  const totalLatest = window.sumPresent(
    available.map(c => window.scalePresent(latestByCode[c]?.q, qtyMul)));
  const compData = !totalLatest ? [] : available
    .map((c, i) => {
      const p = filtered.products.find(x => x.code === c);
      const q = window.scalePresent(latestByCode[c]?.q, qtyMul);
      return { name: p.name, color: PALETTE[i % PALETTE.length],
               share: window.ratioPresent(q, totalLatest), q };
    })
    .sort((a, b) => b.q - a.q);

  // 50-year evolution — one line per species (absolute cabeças). NOT stacked: heads of
  // different species are not additive. Plotly zoom/hover handles the scale disparity
  // (poultry in the billions vs caprinos in the millions).
  const evoSeries = available.map((c, i) => {
    const p = filtered.products.find(x => x.code === c);
    return {
      name: p.name,
      color: PALETTE[i % PALETTE.length],
      data: filtered.allProductTS[c]
        .filter(d => d.y >= yearStart && d.y <= yearEnd)
        // A year with no headcount is a gap in the line, never a herd of zero.
        .map(d => ({ y: d.y, v: window.scalePresent(d.q, qtyMul) })),
    };
  });

  // Focused-species KPIs (current efetivo, YoY, historical peak).
  const focusProd = filtered.products.find(p => p.code === activeFocus);
  const focusUnit = window.countProductUnit(focusProd, conv);
  const focusWin  = filtered.allProductTS[activeFocus].filter(d => d.y >= yearStart && d.y <= yearEnd);
  // `q: null`, não `q: 0`: uma janela sem ponto algum (período fora da cobertura da
  // pesquisa) não tem efetivo ZERO, tem efetivo desconhecido. Medido na tela com
  // 1950–1960: "Efetivo = 0 un" e "Pico histórico = 0 un em 1960" — duas afirmações
  // sobre um período que a PPM não cobre. formatCountQty já devolve '—' para null.
  const fLast = focusWin[focusWin.length - 1] || { y: yearEnd, q: null };
  const fPrev = focusWin[focusWin.length - 2] || fLast;
  const fDelta = window.deltaPct(fPrev.q, fLast.q);
  const fPeak = focusWin.reduce((m, d) => (d.q > m.q ? d : m), focusWin[0] || fLast);

  // Per-UF map of the focused species — decorate product-uf rows with tile col/row
  // from the UF registry (the BrazilTileMap positions tiles by col/row).
  const UF_POS = window.UF_DATA ? Object.fromEntries(window.UF_DATA.map(u => [u.uf, u])) : {};
  const ufMapRows = (ufRank.rows || [])
    .map(u => {
      const pos = UF_POS[u.uf];
      return pos ? { uf: u.uf, col: pos.col, row: pos.row, region: pos.region, value: (u.q_count || 0) * qtyMul } : null;
    })
    .filter(Boolean);
  // Only UFs where the species is raised: a herd of zero (or no figure) neither enters the
  // "3 maiores" nor becomes the "UF líder" (v1.108.22). The map still draws every UF.
  const ufTop = window.topPositive(ufMapRows, (u) => u.value, 3);

  return (
    <>
      <window.NotApplicableNote note={{ recorte: recorteNota }} />
      {/* A banco with no per-UF series draws the national ones under a UF subset: said here. */}
      <window.SeriesPorUfNote filtered={filtered} />

      {/* Intro + caveat */}
      <div className="card subtle">
        <window.SectionHeader
          overline="Pecuária · efetivo dos rebanhos (PPM)"
          title={escopoUf ? `Rebanho · ${escopoUf} · cabeças` : 'Rebanho brasileiro · cabeças'}
        />
        <p className="caption" style={{ margin: '2px 2px 0' }}>
          O efetivo é um <strong>estoque</strong> (nº de cabeças no fim do ano), não uma produção: não
          tem valor monetário, e <strong>não deve ser somado entre espécies</strong> — cabeças de bovino
          e de galináceo não são comparáveis. As séries abaixo são por espécie, em cabeças.
        </p>
      </div>

      {/* Focused-species selector */}
      <div className="pp-selector">
        <span className="pp-selector-label">Espécie em foco <small className="pc-cap">(indicadores + mapa)</small></span>
        <div className="pp-chips">
          {available.map(c => {
            const p = filtered.products.find(x => x.code === c);
            return (
              <button key={c}
                      className={'pp-chip ' + (c === activeFocus ? 'on' : '')}
                      onClick={() => setFocus(c)}>
                <span className="pp-chip-fam count"></span>
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* KPI strip — focused species */}
      <div className="kpi-row">
        <window.KpiCardSpark
          label={<>Efetivo · {focusProd.name}</>}
          value={window.formatCountQty(fLast.q, conv, focusUnit)}
          delta={window.fmtSigned(fDelta)}
          deltaPositive={window.deltaUp(fDelta)}
          sub={`${fLast.y} vs. ${fPrev.y}`}
          spark={focusWin.slice(-12).map(d => ({ y: d.y, q: d.q }))}
          sparkKey="q"
          sparkColor="var(--viz-9)"
        />
        <window.KpiCardSpark
          label="Pico histórico"
          value={window.formatCountQty(fPeak.q, conv, focusUnit)}
          sub={`em ${fPeak.y}`}
          spark={focusWin.slice(-12).map(d => ({ y: d.y, q: d.q }))}
          sparkKey="q"
          sparkColor="var(--viz-7)"
        />
        <window.KpiCardSpark
          label="Espécies no efetivo"
          value={String(available.length)}
          sub={`${yearStart}–${yearEnd}`}
        />
        {hasGeo && ufTop.length > 0 && (
          <window.KpiCardSpark
            label={<>UF líder · {focusProd.name}</>}
            value={ufTop[0].uf}
            sub={`${ufTop[0].value.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} ${focusUnit}`}
          />
        )}
      </div>

      {/* Composition + evolution: every species on one unit, or neither is drawn */}
      {herdUnit ? (
        <div className="grid-2">
          <div className="card">
            <window.SectionHeader
              overline={`Composição do efetivo · ${yearEnd}`}
              title="Participação por espécie (cabeças)"
              action={<span className="caption">{available.length} espécies</span>}
            />
            <window.Donut data={compData} size={180} valueKey="share" />
          </div>
          <div className="card">
            <window.SectionHeader
              overline={<>Evolução por espécie · {yearStart}–{yearEnd} · <window.UnitFamilyTag family="count" conv={conv} unit={herdUnit}/></>}
              title="Efetivo ao longo do tempo"
              action={<span className="caption">use o zoom para as espécies menores</span>}
            />
            <window.MultiLineChart series={evoSeries} label={herdUnit} valueKey="v" height={300} />
          </div>
        </div>
      ) : (
        <div className="card">
          <window.CountRefusedNote groups={[herdGroup].filter(Boolean)} database={database} marginTop={0} />
        </div>
      )}

      {/* Per-UF map of the focused species */}
      {hasGeo && (
        <div className="card">
          <window.SectionHeader
            overline={`Distribuição por UF · ${focusProd.name} · ${yearStart}–${yearEnd}`}
            title={`Onde ${focusProd.name} é criado`}
            action={
              // "…" while the per-UF read is on its way, as the card's body says; "—" when it
              // failed or no UF raises the species. Until v1.108.22 the caption read "—" beside
              // "Carregando distribuição por UF…".
              <span className="caption">
                {ufRank.loading ? '…'
                  : ufTop.length ? '3 maiores: ' + ufTop.map(u => u.uf).join(' · ')
                  : '—'}
              </span>
            }
          />
          {ufRank.loading ? (
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
              Carregando distribuição por UF…
            </p>
          ) : ufRank.error ? (
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center', color: 'var(--err, #b71c1c)' }}>
              Não foi possível carregar a distribuição por UF. Tente novamente.
            </p>
          ) : ufMapRows.length ? (
            <window.BrazilTileMap data={ufMapRows} valueKey="value" label={focusUnit} />
          ) : (
            <p className="caption" style={{ padding: '40px 4px', textAlign: 'center' }}>
              Sem dados por UF para esta espécie.
            </p>
          )}
        </div>
      )}
    </>
  );
}

window.ViewRebanho = ViewRebanho;
