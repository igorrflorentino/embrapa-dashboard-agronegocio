// ViewOverview — a digest of the other three perspectives.
// All datasets pass through window.applyFilters(summary) so KPIs,
// charts and the donut only reflect the rows the researcher selected.

// The count notes: a group refused for counting different things, and the count a
// value-less map leaves to another reading (countUnits.js).
import './CountUnitNotes.jsx';
// window.cestaPorUfMotivo, and the recorte's own composition (window.recorteProducts).
import './RecorteNote.jsx';
import './recorteProducts.js';

function ViewOverview({ families, summary, database, conventions }) {
  const conv      = conventions || window.DEFAULT_CONVENTIONS;
  const monLabel  = window.conventionMonetaryLabel(conv);
  const valAxis   = window.valueAxisLabel(conv);
  // ufData is in the banco's OWN base currency (USD for COMEX/Comtrade), so scale
  // it with the base-aware factor — convFactor alone leaves a US$ magnitude under
  // R$ when a USD-native banco switches display to BRL. base=BRL → unchanged.
  const baseCcy   = window.canonCurrencyFor ? window.canonCurrencyFor(database) : 'BRL';
  const ufFactor  = window.convFactorFor(baseCcy, conv);

  const filtered = window.applyFilters(summary || {}, database);
  // Anos de reforma monetária que se aplicam à convenção ATIVA (vazio fora de R$
  // nominal — quem decide é o seam, que já resolveu a coluna). Ver seriesUtils.
  const eraBreaks = window.valueEraBreaksFor(database);

  // ts.v is in R$ bi; scale to absolute.
  const ts        = filtered.ts.map(d => ({ ...d, v: window.scalePresent(d.v, 1e9) }));

  // Partial-latest-year detection. A monthly banco (COMEX) publishes the current
  // year month-by-month, so its latest year covers only a few months; a raw YoY of
  // that partial year vs a full prior year looks like a crash. We do NOT hide it by
  // computing on an earlier "complete" year — that would show a value for a period
  // the researcher did not select. Per the product rule, the KPI/YoY ALWAYS reflect
  // the user's selected window (latest year included); when that year is partial we
  // only MARK it "(parcial)" and explain the comparison is not like-for-like.
  const meta        = (window.dataStore && window.dataStore.meta)
    ? window.dataStore.meta(database) : null;
  const latestMeta  = (meta && meta.latest) || null;
  const lastPoint   = ts[ts.length - 1] || { v: null, q_mass: 0, q_vol: 0, y: null };
  const partialLatest =
    !!latestMeta &&
    latestMeta.yearComplete === false &&
    lastPoint.y != null &&
    (latestMeta.completeYear == null || lastPoint.y > latestMeta.completeYear) &&
    ts.length >= 2;
  const partialYr = partialLatest ? lastPoint.y : null;
  // Compute over EXACTLY the selected window — latest year included, never dropped.
  const last      = ts[ts.length - 1] || { v: null, q_mass: 0, q_vol: 0, y: null };
  const prev      = ts[ts.length - 2] || last;
  const first     = ts[0] || last;
  // null (= '—' na tela) quando os extremos não são comparáveis; ver seriesUtils.
  // A acumulada é montada por window.deltaTitle direto de (first, last), que já
  // acrescenta o MOTIVO da recusa — por isso não há um deltaTotV aqui.
  const deltaV    = window.deltaPctIn(prev, last, eraBreaks);
  // The counted PRODUCTION of the basket (eggs, fruits) — the one count a headline can
  // carry: a year's flow, of ONE thing counted. The herd is a stock and stays out of the
  // strip (see the note under it); a group whose products count different things has no
  // headline at all (CountRefusedNote). countUnits.js.
  const countGroups = filtered.countGroups || [];
  const flowCount = countGroups.find(g => g.total === 'flow' && !g.mixed) || null;
  // A variação de cada família de quantidade, nomeada uma vez: o número no card e a
  // direção da seta têm de sair da MESMA conta. Comparar `last.q >= prev.q` colore a
  // seta a partir de outra grandeza, e as duas só divergem onde importa — na ausência,
  // onde `null >= null` é true e pintava de verde o próprio travessão.
  const dMass     = window.deltaPct(prev.q_mass, last.q_mass);
  const dVol      = window.deltaPct(prev.q_vol, last.q_vol);
  const dCount    = flowCount ? window.deltaPct(prev.q_count_flow, last.q_count_flow) : null;
  const spark12   = ts.slice(-12);
  // Year tag that marks the latest year "(parcial)" wherever it is shown.
  const yTag      = (y) => `${y ?? ''}${partialLatest && y === partialYr ? ' (parcial)' : ''}`;
  // basket × UF can't be combined until the product×UF cube loads (dataFilters.js):
  // the value would silently drop the basket, so hold it at a loading state instead.
  const comboPending = !!filtered.geoComboPending;
  // A sub-UF narrowing whose mesh or município cube FAILED (v1.108.1), or the basket's UF cube
  // failing beside a UF subset (v1.108.2). Not pending — nothing is coming — and no number
  // here can honour the selection: the un-narrowed ones would be data the filter excludes.
  // Held like the pending state, with a dash instead of an ellipsis, and the series card says
  // why. (Until then a failure read as pending, and the strip said "cruzando produto × UF…"
  // for good.)
  const recorteFalhou = filtered.subUfLoadError || null;
  const falha = recorteFalhou || filtered.geoComboLoadError || null;
  const segura = comboPending || !!falha;
  const kpiVal = (fmt) => (falha ? '—' : comboPending ? '…' : fmt);
  const kpiSub = (fmt) => (recorteFalhou
    ? 'recorte sub-UF não carregado'
    : falha ? 'produto × UF não carregado'
    : comboPending && filtered.subUfRequested ? 'carregando o recorte sub-UF…'
    : comboPending ? 'cruzando produto × UF…' : fmt);
  // Under a sub-UF recorte the composition is the RECORTE's (one year of the município
  // reader), never the national per-product series (v1.108.2). Null without a recorte.
  const recorteProds = window.recorteProducts
    ? window.recorteProducts(filtered, summary || {}, database, conv) : null;

  // Quality digest. Lê a lista COMPLETA, não a recortada pelas chips de flag: este card
  // se declara "acervo do banco" no próprio subtítulo, e um número do acervo não muda
  // porque o leitor desmarcou uma chip. Antes, desmarcar "Sem base para avaliar" fazia o card ler
  // "99,6%" com o subtítulo ainda dizendo "acervo do banco" — certo como aritmética,
  // respondendo outra pergunta. As chips seguem valendo na perspectiva Qualidade, que é
  // onde elas escolhem o que olhar.
  const qFlags    = filtered.qualityFlagsFull || filtered.qualityFlags;
  const okFlag    = qFlags.find(f => f.id === 'OK');
  const okShare   = okFlag ? okFlag.share : 0;
  const okCount   = okFlag ? okFlag.count : 0;
  // Desde a v1.49.0 'OK' significa EXAMINADA pelo detector de preço implícito e sem
  // ressalva — as linhas que ele não pôde escorar saíram para 'UNSCORED'. Isso derrubou
  // o número de 99,8% para 33,5% na PAM, e o rótulo antigo ("Linhas íntegras") passaria
  // a soar como se dois terços do acervo estivessem quebrados. Não estão: a maior parte
  // é célula vazia do cubo (município que não produz aquilo) e valor abaixo do piso de
  // materialidade. O card nomeia o que MEDE, e a linha de baixo diz o que é o resto.
  const naoAvaliada = qFlags.find(f => f.id === 'UNSCORED');
  const naoAvaliadaShare = naoAvaliada ? naoAvaliada.share : 0;
  // A MESMA fração pesada por dinheiro (v1.56.0). Sem ela o card conta só metade da
  // história: no PEVS, 81,6% das LINHAS não foram avaliadas e 0,7% do VALOR — porque o
  // que o detector pula são células vazias do cubo do IBGE e remessas abaixo do piso de
  // materialidade, numerosas e economicamente irrelevantes. "33,5%" sozinho diz ao
  // pesquisador que dois terços do acervo não foram examinados: verdade sobre as LINHAS,
  // falso sobre o ASSUNTO.
  // "Examinado" inclui o que o detector olhou E MARCOU (outlier, problemático): essas
  // linhas passaram pelo exame. Usar só o valueShare do OK subestimaria — no PEVS daria
  // 79% em vez de 99,3% — e poria um número sob um rótulo que nomeia outra coisa.
  //
  // Somamos as flags EXAMINADAS em vez de fazer `1 - UNSCORED`. O complemento parece a
  // mesma conta e não é: incompleto, valor/quantidade/peso ausente e área inconsistente
  // também nunca passaram pelo detector, e o complemento os contava como examinados. No
  // COMTRADE são 0,893% do valor (medido em produção 2026-09-08). `sumPresent`, não `+`:
  // num banco sem valor algum a fração é NULA, e somar null como zero afirmaria que
  // nenhum dinheiro passou pelo exame quando o certo é "não há base para a fração".
  const valorExaminado = window.sumPresent(
    qFlags
      .filter(f => window.EXAMINED_FLAGS.includes(f.id))
      .map(f => f.valueShare)
  );

  // "UFs cobertas" must count REAL Brazilian states only. For a trade banco
  // (COMEX) ufData includes non-state pseudo-origins (ND/EX/ZN/CB/RE/MC…) that
  // are not UFs, so counting every row with value>0 yielded a nonsensical 32/27.
  // The backend now flags each row `real` (true = Brazilian UF); we count those.
  // Fallback (older payloads / synthetic data lacking `real`): intersect with the
  // canonical 27-UF registry (window.UF_DATA) so pseudo-codes never inflate it.
  const isRealUf  = u => (u.real != null ? u.real : window.isCanonicalUf(u.uf));
  const realUfs   = filtered.ufData.filter(isRealUf);
  // A value-less basket (the livestock herd — a stock) has R$ 0 everywhere, so the geo
  // digest must read a COUNT instead; reading value would give an empty map + 0/27 UFs
  // covered. ONE count group, never their sum: the herd first, else the counted
  // production — and the other one is named under the map. A value-bearing basket is
  // unaffected (countGeo stays null).
  const anyValue  = realUfs.some(u => u.value > 0) || ts.some(d => d.v > 0);
  const countGeo  = (!anyValue && families.includes('count'))
    ? window.countGroupWithData(countGroups, realUfs) : null;
  const onCount   = !!countGeo;
  const geoVal    = u => (onCount ? (u[countGeo.key] || 0) : u.value);
  const ufCovered = realUfs.filter(u => geoVal(u) > 0).length;
  // Denominator = real UFs in the banco's full set, capped at the canonical 27.
  const ufTotalReal = Math.min(
    27,
    filtered.ufDataFull.filter(isRealUf).length || 27,
  );
  const top3      = realUfs.slice().sort((a, b) => geoVal(b) - geoVal(a)).slice(0, 3);
  const hasGeo    = filtered.ufDataFull.length > 0;
  // The tile map is scoped to the latest UF year IN the window, which can fall short
  // of yearEnd (future/partial endDate). Label it with the data's OWN year so the
  // caption never diverges from what's plotted (FINDING #1).
  const mapYear    = filtered.ufLatestYear != null ? filtered.ufLatestYear : filtered.yearEnd;
  // Mark "(parcial)" when EITHER the UF data lags the window end (ufYearPartial)
  // OR the map year is the calendar-partial latest year (FINDING #3 signal), so
  // the spatial snapshot is as honest as the time-series point.
  const mapPartial = filtered.ufYearPartial || (partialLatest && mapYear === partialYr);
  const mapYearTag = mapPartial ? `${mapYear} (parcial)` : `${mapYear}`;
  // The composition donut shows the latest year (yearEnd); mark it partial too when
  // that trailing year is incomplete, consistent with the map + series.
  const compYearTag = (partialLatest && filtered.yearEnd === partialYr)
    ? `${filtered.yearEnd} (parcial)`
    : `${filtered.yearEnd}`;

  const massFamily = families.includes('mass');
  const volFamily  = families.includes('volume');
  const countFamily = families.includes('count');  // PPM livestock head / eggs, PAM fruits
  // The herd never gets a headline: heads are not additive across species, so a total
  // over the basket's species is a blend. The strip points to the per-species Rebanho view
  // instead. Until v1.108.0 the count headline was the WHOLE family (herd + eggs), so it
  // was hidden whenever a herd was in the basket; it now reads only the counted production,
  // which a herd beside it no longer contaminates.
  const hasStock = countGroups.some(g => g.total === 'stock');

  return (
    <>
      <window.UnitFamilyBanner families={families} />
      <window.RecorteNote recorte={filtered.recorte} />

      {/* KPI strip */}
      <div className="kpi-row">
        <window.KpiCardSpark
          label={`Valor total · ${monLabel}`}
          value={kpiVal(window.formatValue(last.v, conv))}
          delta={segura ? null : window.fmtSigned(deltaV)}
          deltaPositive={window.deltaUp(deltaV)}
          sub={kpiSub(`${yTag(last.y)} vs. ${prev.y || ''}`)}
          spark={segura ? null : window.convertSeries(spark12, conv)}
          sparkKey="v"
          sparkColor="var(--viz-1)"
        />
        {massFamily && (
          <window.KpiCardSpark
            label={<>Quantidade · <window.UnitFamilyTag family="mass" conv={conv}/></>}
            value={kpiVal(window.formatMassQty(last.q_mass, conv))}
            delta={segura ? null : window.fmtSigned(dMass)}
            deltaPositive={window.deltaUp(dMass)}
            sub={kpiSub(`${yTag(last.y)} vs. ${prev.y || ''}`)}
            spark={segura ? null : spark12}
            sparkKey="q_mass"
            sparkColor="var(--viz-2)"
          />
        )}
        {volFamily && (
          <window.KpiCardSpark
            label={<>Quantidade · <window.UnitFamilyTag family="volume" conv={conv}/></>}
            value={kpiVal(window.formatVolumeQty(last.q_vol, conv))}
            delta={segura ? null : window.fmtSigned(dVol)}
            deltaPositive={window.deltaUp(dVol)}
            sub={kpiSub(`${yTag(last.y)} vs. ${prev.y || ''}`)}
            spark={segura ? null : spark12}
            sparkKey="q_vol"
            sparkColor="var(--viz-4)"
          />
        )}
        {countFamily && flowCount && (
          <window.KpiCardSpark
            label={<>Quantidade · <window.UnitFamilyTag family="count" conv={conv}
                                                         unit={window.countGroupUnit(flowCount, conv)}/></>}
            value={kpiVal(window.formatCountQty(last.q_count_flow, conv,
                                                window.countGroupUnit(flowCount, conv)))}
            delta={segura ? null : window.fmtSigned(dCount)}
            deltaPositive={window.deltaUp(dCount)}
            sub={kpiSub(`${yTag(last.y)} vs. ${prev.y || ''}`)}
            spark={segura ? null : spark12}
            sparkKey="q_count_flow"
            sparkColor="var(--viz-9)"
          />
        )}
        {/* Quality is a banco-wide (acervo) figure, and now literally so: it reads
            qualityFlagsFull, so NOTHING in the filter menu narrows it — not the
            basket/UF/period (the API has no per-basket quality) and not the flag
            chips either. The other KPIs in this strip ARE filtered, so the scope is
            marked in the sub-line rather than presenting an acervo % as if it were
            scoped to the active selection ("no invisible filtering"). */}
        <window.KpiCardSpark
          label="Linhas examinadas sem ressalva"
          value={window.fmtPct(okShare)}
          sub={okCount
            ? `${(okCount / 1e6).toFixed(1).replace('.', ',')} mi linhas · acervo do banco`
              // A cobertura em VALOR vem primeiro quando existe: é ela que diz se o
              // número acima é motivo de preocupação. `!= null` e não truthy — 0% é uma
              // fração medida e precisa aparecer.
              + (valorExaminado != null
                ? ` · ${window.fmtPct(valorExaminado)} do valor examinado`
                : '')
              + (naoAvaliadaShare > 0
                ? ` · ${window.fmtPct(naoAvaliadaShare)} das linhas sem base para avaliar`
                : '')
            : '“Sem ressalva” fora do filtro · acervo do banco'}
          spark={filtered.qualityTs.slice(-12)}
          sparkKey="ok"
          sparkColor="var(--ok)"
        />
      </div>

      {countFamily && hasStock && (
        <p className="caption" style={{ margin: '-4px 2px 8px' }}>
          ⓘ O <strong>efetivo dos rebanhos</strong> (cabeças) não entra como um KPI agregado aqui —
          cabeças não são somáveis entre espécies. Veja a perspectiva <strong>Rebanho</strong> para a
          composição e a evolução por espécie.
        </p>
      )}
      {countFamily && (
        <div style={{ margin: '-4px 2px 8px' }}>
          <window.CountRefusedNote groups={countGroups} database={database} marginTop={0} />
        </div>
      )}

      {/* Hero: timeseries + composition */}
      <div className="grid-2">
        <div className="card">
          {(() => {
            const series = window.convertSeries(ts, conv);
            const max = Math.max(...series.map(d => d.v), 0);
            const { data, label } = window.scaleSeries(series, max, conv, 'v', valAxis);
            return (
              <>
                <window.SectionHeader
                  overline={`Série histórica · ${filtered.yearStart}–${yTag(filtered.yearEnd)} · ${monLabel}`}
                  title={falha ? 'Variação acumulada: —'
                    : comboPending ? 'Variação acumulada: …' : window.deltaTitle('Variação acumulada', first, last, {
                    breaks: eraBreaks,
                    motivo: window.valueGapMotivo && window.valueGapMotivo(window.valueGapFor(database), conv),
                  })}
                />
                {falha ? (
                  <window.LoadErrorNote error={falha} />
                ) : comboPending ? (
                  <p className="caption" style={{ padding: '24px 4px', textAlign: 'center' }}>
                    {filtered.subUfRequested
                      ? <>Carregando o <strong>recorte territorial</strong>…</>
                      : <>Cruzando o filtro de <strong>produtos</strong> com o de <strong>UFs</strong>…</>}
                  </p>
                ) : (
                  <window.LineChart data={data} label={label} valueKey="v" color="var(--viz-1)" height={240} />
                )}
                {!segura && partialLatest && (
                  <p className="caption" style={{ padding: '8px 4px 0' }}>
                    <strong>{partialYr} (parcial):</strong> o ano mais recente cobre apenas
                    {' '}{latestMeta?.monthsInLatestYear ? `${latestMeta.monthsInLatestYear} ${latestMeta.monthsInLatestYear === 1 ? 'mês' : 'meses'}` : 'parte do ano'}.
                    Os valores e a variação anual acima refletem esse ano parcial, conforme o período que você
                    selecionou — a comparação com o ano anterior (completo) não é direta.
                  </p>
                )}
              </>
            );
          })()}
        </div>

        <div className="card">
          {(() => {
            const action = (
              <span className="caption">{filtered.selectedProducts.length} de {filtered.productsTotal} produtos</span>
            );
            const aviso = (texto) => (
              <p className="caption" style={{ padding: '24px 4px', textAlign: 'center' }}>{texto}</p>
            );
            // O Donut rotula cada fatia por `name`. Sem desambiguar, duas metades do
            // PEVS que dividem o nome viram duas fatias com o MESMO rótulo — "Madeira em
            // tora 57%" e "Madeira em tora 7%" — e o leitor não sabe qual é qual. Não
            // funde nada (a chave é o índice), mas informa igualmente mal.
            const donut = (fatias) => (
              <window.Donut data={window.labelProductRows(fatias, database)} size={180} valueKey="share" />
            );
            if (!recorteProds) {
              return (
                <>
                  <window.SectionHeader overline={`Composição · ${compYearTag}`}
                                        title="Participação por produto" action={action} />
                  {filtered.topProducts.length === 0
                    ? aviso('Nenhum produto selecionado nos filtros.')
                    : donut(filtered.topProducts)}
                </>
              );
            }
            // Under a sub-UF recorte: the recorte's own products in ONE year (the latest in
            // which its municípios have a row), never the national series (v1.108.2). The
            // herd is a stock with no value, so it is no slice of a value composition.
            const r = recorteProds;
            const fluxos = (r.products || []).filter((p) => p.measure_kind !== 'stock');
            const fatias = window.compositionSlices(fluxos.map((p) => ({
              code: p.code, name: p.name, tabela: p.tabela, value: p.value,
            })));
            return (
              <>
                <window.SectionHeader
                  overline={r.year != null
                    ? `Composição · ${r.year} · municípios do recorte`
                    : 'Composição · municípios do recorte'}
                  title="Participação por produto" action={action} />
                {/* The recorte's own failure is already announced on the series card; this
                    card names it in a line. A failure of THIS read gets the full note. */}
                {recorteFalhou ? aviso('Não foi possível carregar o recorte territorial.')
                  : r.loadError ? <window.LoadErrorNote error={r.loadError} />
                  : r.loading ? aviso('Carregando a composição dos municípios do recorte…')
                  : r.unavailable ? aviso('Este banco não tem a composição por produto abaixo da UF.')
                  : r.products.length === 0
                    ? aviso('Os municípios do recorte não registram nenhum produto da cesta no período.')
                  : fatias.length === 0
                    ? aviso(fluxos.length === 0
                      ? 'A cesta só tem efetivo de rebanho, que não tem valor monetário.'
                      : `Nenhum produto da cesta tem valor em ${r.year} na convenção escolhida.`)
                  : donut(fatias)}
              </>
            );
          })()}
        </div>
      </div>

      {/* Geo digest + quality digest */}
      <div className="grid-2">
        {hasGeo && (
        <div className="card">
          {(() => {
            // Only REAL UFs reach the tile map: a trade banco's ufData carries
            // non-state pseudo-origins (ND/EX/ZN…) with no tile col/row, which the
            // BrazilTileMap would position at `undefined * cell = NaN` (FINDING #4/#5).
            // Measure-aware: a value-less basket maps ONE count group (the herd's heads,
            // else the counted production) instead of an all-zero value. geoVal already
            // selects the right field; the unit names what is counted.
            const geoMul  = onCount ? window.countQtyMul(conv) : (1e6 * ufFactor);
            const geoUnit = onCount ? window.countGroupUnit(countGeo, conv) : valAxis;
            const geoWhat = !onCount ? 'Valor' : countGeo.total === 'stock' ? 'Efetivo' : 'Quantidade';
            const ufRows = realUfs.map(u => ({
              ...u,
              value: geoVal(u) * geoMul,
            }));
            // A sub-UF recorte on its way, or failed, has no grid to draw: the tiles came out
            // blank while it loaded and with an "R$ 0 – 0" legend after it failed, both of
            // which read as a measured empty map (v1.108.2). The map waits, or says it failed.
            const mapaEspera = !!filtered.subUfLoading;
            const mapaFalhou = !!filtered.subUfLoadError;
            if (mapaEspera || mapaFalhou) {
              return (
                <>
                  <window.SectionHeader overline="Distribuição geográfica"
                                        title={`${geoWhat} por UF · ${geoUnit}`}
                                        action={<span className="caption">{mapaFalhou ? '—' : '…'}</span>} />
                  <p className="caption" style={{ padding: '24px 4px', textAlign: 'center' }}>
                    {mapaFalhou
                      ? 'Não foi possível carregar o recorte territorial.'
                      : 'Carregando o recorte territorial…'}
                  </p>
                </>
              );
            }
            return (
              <>
                <window.SectionHeader
                  overline={`Distribuição geográfica · ${mapYearTag}`}
                  title={`${geoWhat} por UF · ${geoUnit}`}
                  action={
                    <span className="caption">
                      {top3.length ? '3 maiores: ' + top3.map(u => u.uf).join(' · ') : '—'}
                    </span>
                  }
                />
                {/* RAW values + base unit: the tile map formats each UF with its OWN compact
                    magnitude (per-tile), so the global auto-scale — which floored small UFs to
                    "0" when ON — is intentionally NOT applied to the map. */}
                {/* Clicking a UF filters the whole dashboard to it (click again to
                    clear) — the same gesture the Geografia map offers. Safe here
                    because this map reads applyFilters' state-filtered ufData, so it
                    actually reacts to the click. */}
                <window.BrazilTileMap
                  data={ufRows}
                  valueKey="value"
                  label={geoUnit}
                  onSelect={window.tileSelectHandler && window.tileSelectHandler(summary)}
                  selectedUf={window.selectedSingleUf && window.selectedSingleUf(summary)}
                />
                {filtered.ufYearPartial && (
                  <p className="caption" style={{ padding: '8px 4px 0' }}>
                    <strong>{mapYear} (parcial):</strong> o último ano com dados por UF fica antes do
                    fim do período ({filtered.yearEnd}); o mapa mostra {mapYear}.
                  </p>
                )}
                {onCount && (
                  <window.CountLeftOutNote groups={countGroups} shown={countGeo} database={database} />
                )}
                {filtered.notFilteredByBasket && (
                  <p className="caption" style={{ padding: '8px 4px 0' }}>
                    O mapa reflete <strong>todos os produtos</strong> —{' '}
                    {window.cestaPorUfMotivo(filtered)}.
                  </p>
                )}
              </>
            );
          })()}
        </div>
        )}

        <div className="card">
          <window.SectionHeader
            overline="Qualidade dos dados · agregado"
            title={hasGeo
              // kpiVal: an unresolved recorte has no grid to count, and its 0 would read
              // "covers no UF" (v1.108.1).
              ? ('Cobertura geográfica: ' + kpiVal(ufCovered) + ' / ' + ufTotalReal + ' UFs')
              : 'Distribuição das marcas de qualidade'}
            action={<span className="caption">{filtered.qualityFlags.length} de {window.QUALITY_FLAGS.length} flags</span>}
          />
          <div className="qa-summary">
            {filtered.qualityFlags.map(f => (
              <div key={f.id} className="qa-row">
                <span className="qa-dot" style={{ background: f.color }}></span>
                <span className="qa-label">{f.label}</span>
                <span className="qa-count tnum">{(f.count / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}k</span>
                <span className="qa-share tnum">{window.fmtPct(f.share)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

window.ViewOverview = ViewOverview;
