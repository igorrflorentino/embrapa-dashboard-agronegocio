// ViewProductivity — agricultural AREA × YIELD perspective. Meaningful only
// for bancos that provide the 'yield' capability (IBGE PAM). Pick a crop and
// see its national yield/area trajectory plus the per-UF productivity geography.
//
// Self-data view: it reads its own data producer (window.productivityData),
// exactly like ViewFlows/ViewSeasonality. That producer is API-backed — it queries
// the real /api/productivity endpoint (rendimento = produção ÷ área colhida,
// computed server-side from the PAM Gold table) — so this is live, not synthetic.
// The beta caveat banner is rendered globally by MainScreen (window.MaturityBanner),
// so it is intentionally NOT repeated here.

const { useState: useProdState } = React;

function ViewProductivity({ summary, conventions, database }) {
  const [crop, setCrop] = useProdState(null);
  const data = window.productivityData(database, crop, summary);
  // The UF filter now reaches this reader, and yield is a RATIO — so the aggregate
  // becomes the SELECTED states' yield, not a smaller slice of a national one.
  // Labelling it "nacional" would then be a wrong number, so the scope word follows
  // the filter (the payload echoes `states` back from the seam).
  const scopeWord = window.geoScopeLabel ? window.geoScopeLabel(data && data.states) : 'nacional';

  if (!data) {
    return (
      <window.EmptyCard>
        Esta fonte não expõe rendimento agrícola. Selecione um banco com a dimensão de produtividade.
      </window.EmptyCard>
    );
  }

  const activeCrop = data.crop.code;
  const yUnit = data.yieldUnit;

  const fmtY    = (v) => window.numBR(Math.round(v), 0) + ' ' + yUnit;
  // Sub-1000 values get the bare unit — without this tier they'd divide by 1e3 and round,
  // so 500 ha rendered as "1 mil ha" and the empty/loading frame (0) as "0 mil ha".
  const fmtArea = (v) => v >= 1e6 ? window.numBR(v / 1e6, 1) + ' mi ha' : v >= 1e3 ? window.numBR(v / 1e3, 0) + ' mil ha' : window.numBR(Math.round(v), 0) + ' ha';
  const fmtProd = (v) => v >= 1e6 ? window.numBR(v / 1e6, 1) + ' mi t'  : v >= 1e3 ? window.numBR(v / 1e3, 0) + ' mil t'  : window.numBR(Math.round(v), 0) + ' t';

  const series = data.series;
  const last = series[series.length - 1] || { y: 0, yieldKgHa: 0, areaHa: 0, prodT: 0 };
  const prev = series[series.length - 2] || last;
  const first = series[0] || last; // guard the empty loading frame (series resolves async)
  // Mesma regra de toda variação no projeto (seriesUtils.deltaPct): base ausente ou
  // não-positiva ⇒ null ⇒ '—', nunca um "+0%" que se lê como "não mudou".
  const yDelta = window.deltaPct(prev.yieldKgHa, last.yieldKgHa);
  const aDelta = window.deltaPct(prev.areaHa, last.areaHa);

  // Piso de materialidade sobre a área colhida (window.materialityFloor). Sem ele, a UF
  // com MENOS lavoura ganhava o ranking de produtividade: medido na PAM 2024, a cana
  // tinha o DF no topo com 205 ha (0,002% da área nacional) e "85.000 kg/ha" redondo —
  // o arredondamento da fonte sobre uma base minúscula, não produtividade.
  const floor = window.materialityFloor(data.byUF, 'areaHa', window.AREA_FLOOR);
  const comparavel = new Set(floor.kept.map(u => u.uf));
  // As UFs de fora CONTINUAM no mapa — saem do gradiente, não do mapa. `null` cai no
  // índice -1 do quantil e a célula pinta neutra com '—'; zerar afirmaria rendimento
  // zero, que é uma medida que ninguém fez.
  const mapData = data.byUF.map(u => ({
    ...u,
    yieldKgHa: comparavel.has(u.uf) ? Math.round(u.yieldKgHa) : null,
  }));
  const byUFTop = floor.kept.slice()
    .sort((a, b) => b.yieldKgHa - a.yieldKgHa)
    .slice(0, 12)
    .map(u => ({ uf: u.uf, name: u.name, yieldKgHa: Math.round(u.yieldKgHa), areaHa: u.areaHa }));
  // O piso relativo convertido em hectares DESTA lavoura, para o leitor comparar com
  // as áreas listadas. Vira null quando a metade absoluta é a que está mordendo.
  const floorHa = Number.isFinite(floor.total) ? floor.total * window.AREA_FLOOR.minShare : null;

  return (
    <>
      {/* Honest note when the FilterMenu product basket is active: this view picks
          its own crop (selector below), so the basket cannot narrow it — the data
          layer withholds it and surfaces WHY here instead of ignoring it silently. */}
      <window.NotApplicableNote note={data.notApplicable} />
      {/* Distinct error state when /api/productivity FAILED (not "0% CAGR / sem histórico"). */}
      <window.LoadErrorNote error={data.loadError} />

      {/* Crop selector */}
      <div className="pp-selector">
        <span className="pp-selector-label">Lavoura em análise</span>
        <div className="pp-chips">
          {data.crops.map(c => (
            <button key={c.code}
                    className={'pp-chip ' + (c.code === activeCrop ? 'on' : '')}
                    onClick={() => setCrop(c.code)}>
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {/* KPI strip */}
      <div className="kpi-row">
        <window.KpiCardSpark
          label={<>Rendimento {scopeWord} · <window.UnitFamilyTag family="rendimento" conv={conventions}/></>}
          value={fmtY(last.yieldKgHa)}
          delta={window.fmtSigned(yDelta)}
          deltaPositive={window.deltaUp(yDelta)}
          sub={`${last.y} vs. ${prev.y}`}
          spark={series.slice(-12).map(d => ({ y: d.y, v: d.yieldKgHa }))}
          sparkKey="v"
          sparkColor="var(--viz-6)"
        />
        <window.KpiCardSpark
          label="Área colhida"
          value={fmtArea(last.areaHa)}
          delta={window.fmtSigned(aDelta)}
          deltaPositive={window.deltaUp(aDelta)}
          sub={`safra ${last.y}`}
          spark={series.slice(-12).map(d => ({ y: d.y, v: d.areaHa }))}
          sparkKey="v"
          sparkColor="var(--viz-10)"
        />
        {/* O sub-rótulo dizia "rendimento × área", uma conta que este card NÃO faz: o
            valor é a produção somada da fonte, e é dela que o rendimento é DERIVADO
            (rendimento = produção ÷ área), não o contrário. O rótulo descrevia a origem
            do número invertida; "safra" espelha o card de área colhida. */}
        <window.KpiCardSpark
          label="Produção"
          value={fmtProd(last.prodT)}
          sub={`safra ${last.y}`}
          spark={series.slice(-12).map(d => ({ y: d.y, v: d.prodT }))}
          sparkKey="v"
          sparkColor="var(--viz-2)"
        />
        <window.KpiCardSpark
          label="CAGR do rendimento"
          value={window.fmtSigned(data.national.yieldCagr)}
          sub={`ganho de produtividade · ${first.y}–${last.y}`}
          spark={series.slice(-12).map(d => ({ y: d.y, v: d.yieldKgHa }))}
          sparkKey="v"
          sparkColor="var(--viz-7)"
        />
      </div>

      {/* National yield + area trajectories */}
      <div className="grid-2">
        <div className="card">
          <window.SectionHeader
            overline={`Rendimento médio · ${yUnit}`}
            title={`${data.crop.name} · produtividade ${scopeWord}`}
          />
          <window.LineChart
            data={series.map(d => ({ y: d.y, v: Math.round(d.yieldKgHa) }))}
            label={yUnit} valueKey="v" color="var(--viz-6)" height={230} />
        </div>
        <div className="card">
          <window.SectionHeader
            overline={`Área colhida · ${data.areaUnit}`}
            title={`${data.crop.name} · área colhida`}
          />
          <window.LineChart
            data={series.map(d => ({ y: d.y, v: Math.round(d.areaHa) }))}
            label={data.areaUnit} valueKey="v" color="var(--viz-10)" height={230} />
        </div>
      </div>

      {/* Per-UF productivity geography */}
      <div className="grid-2">
        <div className="card">
          <window.SectionHeader
            overline={`Produtividade por UF · ${last.y}`}
            title={`Onde ${data.crop.name} rende mais`}
            action={<span className="caption">{yUnit}</span>}
          />
          <window.BrazilTileMap data={mapData} valueKey="yieldKgHa" label={yUnit} height={420} compact={false} />
          <window.MaterialityFloorNote
            dropped={floor.dropped} valueKey="areaHa" fmt={fmtArea}
            floor={window.AREA_FLOOR} floorRel={floorHa}
            titulo="Fora da comparação por área" substantivo="UFs"
            base="da área colhida do recorte"
            porque="base pequena demais para o rendimento médio representar a UF"
            segue="Seguem no mapa em cinza, sem cor de intensidade." />
        </div>
        <div className="card">
          <window.SectionHeader
            overline={`Ranking de rendimento · ${last.y}`}
            title="UFs mais produtivas"
            action={<span className="caption">Top 12 · {yUnit}</span>}
          />
          {/* compact=false: yield is a UNIT metric (kg/ha) — show the exact figure
              ("3.500"), not the misleading magnitude word ("3,5 mil"); matches the
              per-UF tile map above, which is also compact=false (audit CORR-1). */}
          {/* hoverKey: a área ao lado do rendimento, para o leitor julgar a base de cada
              barra sozinho em vez de confiar no piso no escuro. */}
          <window.BarChart data={byUFTop} valueKey="yieldKgHa" color="var(--viz-6)" height={360} compact={false}
                           hoverKey="areaHa" hoverLabel="área colhida (ha)" />
          <window.MaterialityFloorNote
            dropped={floor.dropped} valueKey="areaHa" fmt={fmtArea}
            floor={window.AREA_FLOOR} floorRel={floorHa}
            titulo="Fora da comparação por área" substantivo="UFs"
            base="da área colhida do recorte"
            porque="base pequena demais para o rendimento médio representar a UF"
            segue="Seguem no mapa em cinza, sem cor de intensidade." />
        </div>
      </div>
    </>
  );
}

window.ViewProductivity = ViewProductivity;
