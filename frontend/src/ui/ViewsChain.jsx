// ViewsChain.jsx — the two EXTENDED multi-source perspectives:
//   · ViewChainBalance — supply balance across PEVS→SEFAZ→MDIC→Comtrade
//                        (reconciled mass split + world-market slice).
//   · ViewHarvestLag   — harvest (PEVS, modeled monthly) vs shipments
//                        (MDIC monthly): how many months exports lag the crop.
// Both read their producers from src/data/producers.js (window.chainBalance /
// window.harvestShipmentLag — currently data-blocked preview shells) and reuse
// existing charts.

const { useState: useChState } = React;

const chNum = window.numBR, chPct = window.pctBR;

// ── (5) Chain balance ──────────────────────────────────────────────────
function ViewChainBalance({ view }) {
  const [product, setProduct] = useChState(null);
  const [year, setYear] = useChState(2024);
  const data = window.chainBalance(product, year);
  const banco = window.crossPreviewBanco(view);
  const years = [];
  for (let y = 2024; y >= 1997; y--) years.push(y);

  return (
    <>
      {data.preview && <window.PreviewBanner banco={banco}
        capabilityNote="Todo o balanço é demonstração: a divisão entre interno (SEFAZ), exportado (MDIC) e o mercado mundial (Comtrade) precisa dessas fontes ligadas, e a produção de referência só entra como número real quando o fluxo inter-UF (SEFAZ) existir para fechar a conservação física. Os valores exibidos são ilustrativos." />}

      <div className="ch-toolbar">
        <window.CrossProductPicker value={product} onChange={setProduct} />
        <div className="ch-year">
          <span className="pp-selector-label">Ano</span>
          <select className="xs-select" value={year} aria-label="Ano" onChange={(e) => setYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="kpi-row">
        <window.KpiCardSpark label="Produção" value={chNum(data.produced) + ' mil t'} sub={`${year} · base do balanço`} />
        <window.KpiCardSpark label="Exportado" value={chPct(window.scalePresent(data.expFrac, 100))} sub={`${chNum(data.exported)} mil t p/ fora`} />
        <window.KpiCardSpark label="Comércio interno" value={chPct(window.scalePresent(data.intFrac, 100))} sub={`${chNum(data.internal)} mil t entre UFs`} />
        <window.KpiCardSpark label="Fatia no mundo" value={chPct(data.worldShare)} sub={`exportação ÷ mercado mundial`} />
      </div>

      <div className="card">
        <window.SectionHeader overline="Balanço de oferta · massa conservada" title="Para onde vai o que se produz"
          action={<span className="caption">mil t · IBGE → SEFAZ · MDIC</span>} />
        <window.SankeyChart nodes={data.sankey.nodes} links={data.sankey.links} unit="mil t" height={300} />
        <p className="caption" style={{ padding: '8px 4px 0' }}>
          Conservação física: <strong>produção = comércio interno + exportação + consumo/estoque</strong>.
          O resíduo (consumo doméstico e estoque) é o que sobra do balanço — algo que nenhuma fonte isolada calcula.
        </p>
      </div>

      <div className="card">
        <window.SectionHeader overline="Da exportação ao mercado mundial" title="O quanto o Brasil representa lá fora"
          action={<span className="caption">base valor · MDIC ÷ Comtrade</span>} />
        <div className="ch-world">
          <div className="ch-world-bar">
            <div className="ch-world-fill" style={{ width: Math.max(2, Math.min(100, data.worldShare)) + '%' }}>
              <span>Brasil · {chPct(data.worldShare)}</span>
            </div>
            <span className="ch-world-rest">resto do mundo</span>
          </div>
          <div className="ch-world-meta">
            <div><span className="meta-label">Exportação BR</span><strong>US$ {chNum(data.exportUsd, 1)} bi</strong></div>
            <div><span className="meta-label">Mercado mundial</span><strong>US$ {chNum(data.worldTotal)} bi</strong></div>
          </div>
        </div>
      </div>
    </>
  );
}

// ── (6) Harvest → shipment lag ──────────────────────────────────────
function ViewHarvestLag({ view }) {
  const [product, setProduct] = useChState(null);
  const data = window.harvestShipmentLag(product);
  const banco = window.crossPreviewBanco(view);
  const series = [
    { name: 'Safra (produção)', color: 'var(--viz-2)', data: data.production },
    { name: 'Embarques (exportação)', color: 'var(--viz-3)', data: data.shipments },
  ];
  const markers = [
    { month: data.peakHarvest, color: 'var(--viz-2)' },
    { month: data.peakShip, color: 'var(--viz-3)' },
  ];

  return (
    <>
      {data.preview && <window.PreviewBanner banco={banco}
        capabilityNote="Os embarques mensais entram como demonstração até o MDIC ser ligado; o perfil mensal da safra é modelado a partir do total anual do IBGE (que não publica produção mensal)." />}
      <window.CrossProductPicker value={product} onChange={setProduct} />

      <div className="kpi-row">
        <window.KpiCardSpark label="Defasagem" value={data.lagMonths == null
            ? '—'
            : `${data.lagMonths >= 0 ? '+' : ''}${data.lagMonths} ${Math.abs(data.lagMonths) === 1 ? 'mês' : 'meses'}`} sub="embarques após a safra" />
        <window.KpiCardSpark label="Correlação no lag" value={chNum(data.corrAtLag, 2)} sub="alinhamento safra × embarque" />
        <window.KpiCardSpark label="Pico da safra" value={data.months[data.peakHarvest] ?? '—'} sub="mês de maior produção" />
        <window.KpiCardSpark label="Pico de embarque" value={data.months[data.peakShip] ?? '—'} sub="mês de maior exportação" />
      </div>

      <div className="card">
        <window.SectionHeader overline="Perfil mensal · safra vs. embarque" title="Quando se colhe e quando se embarca"
          action={<span className="caption">índice (pico = 100) · IBGE × MDIC</span>} />
        <window.MonthlyOverlay series={series} months={data.months} markers={markers} />
        <div className="pc-legend">
          {series.map(s => (
            <span key={s.name} className="pc-legend-item"><span className="pc-legend-dot" style={{ background: s.color }}></span>{s.name}</span>
          ))}
        </div>
      </div>

      <div className="card">
        <window.SectionHeader overline="Correlação por defasagem" title="Em que defasagem os dois se alinham"
          action={<span className="caption">r · embarques deslocados ±6 meses</span>} />
        <window.LagBars profile={data.lagProfile} best={{ lag: data.lagMonths, corr: data.corrAtLag }} />
        <p className="caption" style={{ padding: '8px 4px 0' }}>
          A barra verde marca a defasagem de maior correlação: os embarques seguem o pico da safra em
          <strong> {data.lagMonths >= 0 ? data.lagMonths : 0} {Math.abs(data.lagMonths) === 1 ? 'mês' : 'meses'}</strong>.
          Só visível com granularidade mensal — invisível em dado anual.
        </p>
      </div>
    </>
  );
}

Object.assign(window, { ViewChainBalance, ViewHarvestLag });
