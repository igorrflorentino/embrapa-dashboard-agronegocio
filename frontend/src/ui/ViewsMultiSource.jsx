// ViewsMultiSource.jsx — the four analytical multi-source perspectives.
// All read their cross-analytics producers from src/data/producers.js
// (window.tradeMirror / priceSpread / marketShare / exportCoefficient); all are
// self-contained
// (own commodity selector), since unlike "Cruzamento entre fontes" they
// don't need a lifted multi-series selection. Charts are reused as-is.

const { useState: useMSState } = React;

// Shared commodity selector (single-select; null = whole basket).
// Options come from the CROSSWALK catalog (/api/catalog) — each chip's `code` is
// the agrupamento_id SLUG the cross/* endpoints expect, NOT a PEVS product code.
// (Sourcing from window.PRODUCTS shipped PEVS codes, which the backend can't
// crosswalk, so every specific-commodity analysis came back empty.)
// `families` (optional) restricts the offered commodities to those PEVS unit
// families — the export-coefficient and price-spread views pass ['mass'], because
// only a pure-mass commodity is interpretable there. When set, the mixed "Todos os
// agrupamentos" option is dropped too (it spans families, so it is incompatible).
function CrossProductPicker({ value, onChange, families }) {
  const all = window.agrupamentoCatalog();
  const prods = families && families.length ? all.filter(p => families.includes(p.family)) : all;
  const allowBasket = !(families && families.length);
  return (
    <div className="pp-selector">
      <span className="pp-selector-label">Agrupamento</span>
      <div className="pp-chips">
        {allowBasket && (
          <button className={'pp-chip ' + (!value ? 'on' : '')}
            onClick={() => onChange(null)}
            style={!value ? { background: 'var(--embrapa-green)', borderColor: 'var(--embrapa-green)', color: '#fff' } : null}>
            Todos os agrupamentos
          </button>
        )}
        {prods.map(p => {
          const on = value === p.code;
          return (
            <button key={p.code}
              className={'pp-chip ' + (on ? 'on' : '')}
              onClick={() => onChange(p.code)}
              style={on ? { background: 'var(--embrapa-green)', borderColor: 'var(--embrapa-green)', color: '#fff' } : null}
              title={p.name}>
              {p.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const msNum = window.numBR, msPct = window.pctBR;
// Número COM unidade, mas só quando o número existe: um valor ausente vira o travessão
// puro, sem prefixo nem sufixo. Sem isto, `'US$ ' + msNum(null)` daria "US$ —/kg".
const msUnit = (v, pre = '', suf = '', d = 1) =>
  (Number.isFinite(v) ? pre + msNum(v, d) + suf : '—');

// ── (1) Export coefficient ──────────────────────────────────────────────────
function ViewExportCoef() {
  const [product, setProduct] = useMSState(null);
  // This view compares PEVS MASS to COMEX weight, so only a pure-mass commodity works.
  // Offer just those and default to the first (the mixed "Todos os agrupamentos" is always
  // incompatible here) — the user lands on a working indicator, not a fallback note.
  const massProds = window.agrupamentoCatalog().filter(p => p.family === 'mass');
  // O padrão é o primeiro agrupamento CALCULÁVEL, não o primeiro da ordem alfabética:
  // abrir no Abacaxi, que não tem NCM, dava as boas-vindas com uma recusa. Os sem lado
  // aduaneiro seguem na lista, escolhíveis, e explicam-se quando escolhidos.
  const primeiro = massProds.find(p => p.hasCustoms) || massProds[0];
  const effProduct = product || (primeiro && primeiro.code) || null;
  // Per-UF scoping ('' = Brasil), the same in-view control ViewPriceSpread uses.
  // NOT the global state filter: the cross-banco perspectives deliberately hide the
  // filter bar (they have no single-banco filter surface), so honouring it here would
  // narrow the map for a reason invisible on this screen. Both sides of the ratio —
  // PEVS production and COMEX exports — are scoped together server-side; narrowing
  // only production would divide a state's output by the whole country's exports.
  const [uf, setUf] = useMSState('');
  const data = window.exportCoefficient(effProduct, uf ? [uf] : undefined);
  const comProducao = data.byUf.filter(u => u.production > 0);
  // Piso de materialidade sobre a produção (window.materialityFloor, mesma regra do
  // ranking de produtividade — a calibração é que difere, e o porquê está em
  // PRODUCAO_FLOOR). "UF mais exportadora" pergunta quanto do que o estado produz sai
  // do país, e sobre 5 t de produção essa fração não é uma medida: Minas aparecia no
  // topo da castanha-do-pará com 786,0% e 5 t, à frente do Pará com 52,0% e 208 mil t.
  const floor = window.materialityFloor(comProducao, 'production', window.PRODUCAO_FLOOR);
  const ranked = floor.kept.slice().sort((a, b) => b.coefPct - a.coefPct);
  const comparavel = new Set(floor.kept.map(u => u.uf));
  const top = ranked[0], bottom = ranked[ranked.length - 1];
  const nat = data.national || {};
  const composicao = [
    { id: 'productionExtractive', label: 'Extração nativa (PEVS)', color: 'var(--viz-2)' },
    { id: 'productionCrop', label: 'Lavoura plantada (PAM)', color: 'var(--viz-6)' },
  ];
  // As 12 maiores produtoras, para a barra empilhada caber e ainda contar a história.
  const composicaoRows = comProducao.slice()
    .sort((a, b) => b.production - a.production)
    .slice(0, 12);
  const temLavoura = (nat.productionCrop || 0) > 0;
  // Real coverage window from the series itself — never the hardcoded "1997–2024".
  const coefYears = (data.timeseries || []).map(d => d.y);
  const coefWindow = coefYears.length ? `${coefYears[0]}–${coefYears[coefYears.length - 1]}` : '—';

  // O seam recusa com incompatible:true por DOIS motivos distintos, e o pesquisador
  // precisa saber qual: 'familia' (kg ÷ m³ não é fração) e 'sem-ncm' (o agrupamento não
  // tem correspondência aduaneira, então não existe numerador). Nota honesta em pt-BR no
  // lugar de "—%" com gráficos em branco, que não diz se falta dado ou se algo quebrou.
  if (data.incompatible) {
    return (
      <>
        <CrossProductPicker value={effProduct} onChange={setProduct} families={['mass']} />
        <div className="card subtle">
          <window.SectionHeader overline="Orientação exportadora" title="Indicador indisponível para esta seleção" />
          {data.incompatibleReason === 'sem-ncm' ? (
            <p className="caption" style={{ padding: '16px 4px' }}>
              Este agrupamento não tem <strong>correspondência na NCM</strong> no
              cruzamento deste repositório, então não há peso exportado a comparar — o
              coeficiente não tem numerador. A produção do IBGE existe e aparece nas
              perspectivas de produção; o que falta é o lado aduaneiro. Escolha um
              agrupamento com correspondência no MDIC para ver o indicador.
            </p>
          ) : (
            <p className="caption" style={{ padding: '16px 4px' }}>
              O coeficiente de exportação compara <strong>massa produzida</strong> (IBGE, em mil t)
              com <strong>peso exportado</strong> (MDIC, em kg) — uma razão só faz sentido para
              agrupamentos de família <strong>massa</strong>. A seleção atual inclui agrupamento de
              volume (m³) ou cesta mista, para a qual a razão não é interpretável. Escolha um
              agrupamento de massa para ver o indicador.
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <CrossProductPicker value={effProduct} onChange={setProduct} families={['mass']} />
      <window.UfScopePicker value={uf} onChange={setUf} />
      <window.LoadErrorNote error={data.loadError} />

      <div className="kpi-row">
        <window.KpiCardSpark label={uf ? `Coeficiente · ${uf}` : 'Coeficiente nacional'} value={data.national.coefPct == null ? '—' : msPct(data.national.coefPct)} sub={`acumulado ${coefWindow} · do produzido vai p/ exportação`} />
        <window.KpiCardSpark label="UF mais exportadora" value={top?.uf || '—'} sub={top ? `${msPct(top.coefPct)} da produção` : '—'} />
        {ranked.length > 1
          ? <window.KpiCardSpark label="UF mais interna" value={bottom?.uf || '—'} sub={`${msPct(bottom?.coefPct || 0)} exportado`} />
          : <window.KpiCardSpark label="UF mais interna" value="—" sub="produção concentrada em 1 UF" />}
        {/* As DUAS metades do denominador. A composição é separável e é o que o
            pesquisador quer ver; a RAZÃO não é — dividir todas as exportações por só
            uma das metades é exatamente o defeito que esta versão corrige. */}
        <window.KpiCardSpark
          label="Produção considerada"
          value={msNum(nat.production) + ' mil t'}
          sub={temLavoura
            ? `extração ${msNum(nat.productionExtractive, 1)} · lavoura ${msNum(nat.productionCrop, 1)} mil t`
            : `${comProducao.length} ${comProducao.length === 1 ? 'UF' : 'UFs'} · só extração nativa`} />
      </div>

      <window.MaterialityFloorNote
        dropped={floor.dropped}
        valueKey="production"
        fmt={(v) => msNum(v, v < 1 ? 3 : 1) + ' mil t'}
        floor={window.PRODUCAO_FLOOR}
        floorRel={Number.isFinite(floor.total) ? floor.total * window.PRODUCAO_FLOOR.minShare : null}
        titulo="Fora do ranking por produção"
        substantivo="UFs"
        base="da produção do recorte"
        porque="produção pequena demais para a fração exportada representar o estado"
        segue="Seguem no mapa em cinza, sem cor de intensidade." />

      <div className="card">
        <window.SectionHeader overline="Orientação exportadora · por UF" title="Quanto da produção de cada estado vai para fora"
          action={<span className="caption">% exportado · IBGE × MDIC</span>} />
        {/* As UFs abaixo do piso continuam no grid, sem cor de intensidade: `null` cai
            no índice -1 do quantil e pinta neutro. Sem isso, os 786% de uma UF com 5 t
            dominavam a escala e achatavam todas as outras numa faixa só. */}
        <window.BrazilTileMap
          data={data.byUf.map(u => ({
            ...u,
            coefPct: comparavel.has(u.uf) ? u.coefPct : null,
          }))}
          valueKey="coefPct" label="% exportado" />
        <p className="caption" style={{ padding: '10px 4px 2px' }}>
          O coeficiente compara o <strong>peso exportado</strong> (MDIC) com a{' '}
          <strong>massa produzida</strong> (IBGE) dos mesmos produtos — somando as{' '}
          <strong>duas</strong> pesquisas de produção, extração nativa (PEVS) e lavoura
          plantada (PAM), porque a alfândega não distingue as duas na saída. Pode passar
          de <strong>100%</strong> quando o estado exporta formas processadas, reexporta
          ou usa estoque de anos anteriores — não é erro. No mapa, valores abaixo de 0,5%
          aparecem arredondados como 0.
        </p>
      </div>

      <div className="card">
        <window.SectionHeader overline={uf ? `Coeficiente de ${uf} no tempo` : 'Coeficiente nacional no tempo'} title="Evolução da orientação exportadora"
          action={<span className="caption">{coefWindow} · IBGE × MDIC</span>} />
        <window.LineChart data={data.timeseries} valueKey="v" label="%" color="var(--embrapa-green)" height={260} />
      </div>

      <div className="card">
        <window.SectionHeader
          overline="Composição da produção · por UF"
          title="Quanto vem de mata nativa e quanto vem de lavoura"
          action={<span className="caption">mil t · acumulado {coefWindow}</span>} />
        <window.StackedBars rows={composicaoRows} series={composicao} labelKey="uf" label="mil t" />
        <p className="caption" style={{ padding: '10px 4px 2px' }}>
          O IBGE mede as duas em pesquisas separadas — <strong>PEVS</strong> conta o que
          se colhe de floresta nativa, <strong>PAM</strong> o que se colhe de lavoura
          plantada — e elas são disjuntas, então somam sem duplicar. A alfândega
          <strong> não</strong> distingue as duas: o NCM da castanha de caju é
          &ldquo;com casca&rdquo;/&ldquo;sem casca&rdquo;, uma distinção de
          beneficiamento. Por isso o coeficiente acima é <strong>um só</strong>, sobre a
          soma — dividir as exportações inteiras por uma das metades responderia outra
          pergunta com o rótulo desta.
        </p>
      </div>

      <div className="card">
        <window.SectionHeader overline="Ranking · maior orientação exportadora" title="UFs por coeficiente"
          action={<span className="caption">acumulado {coefWindow}</span>} />
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead><tr><th>UF</th><th className="num">Produção (mil t)</th><th className="num">Exportado (mil t)</th><th className="num">Coeficiente</th></tr></thead>
            <tbody>
              {ranked.slice(0, 10).map(u => (
                <tr key={u.uf}>
                  <td>{u.name} <small style={{ color: 'var(--fg-3)' }}>{u.uf}</small></td>
                  <td className="num tnum">{msNum(u.production, 1)}</td>
                  <td className="num tnum">{msNum(u.exportV, 1)}</td>
                  <td className="num tnum" style={{ color: 'var(--embrapa-green-darker)', fontWeight: 600 }}>{msPct(u.coefPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── (2) Brazil in the world market ─────────────────────────────────────
function ViewMarketShare() {
  const [product, setProduct] = useMSState(null);
  const data = window.marketShare(product);
  const last = data.series[data.series.length - 1];
  const first = data.series[0];
  const peak = data.series.reduce((m, d) => d.share > m.share ? d : m, data.series[0]);
  const shareTs = data.series.map(d => ({ y: d.y, v: d.share }));

  return (
    <>
      <CrossProductPicker value={product} onChange={setProduct} />
      <window.LoadErrorNote error={data.loadError} />

      <div className="kpi-row">
        <window.KpiCardSpark label="Participação atual" value={msPct(last?.share)} sub={`${last?.y ?? '—'} · do mercado mundial`} />
        <window.KpiCardSpark label="Pico histórico" value={msPct(peak?.share)} sub={`em ${peak?.y ?? '—'}`} />
        {/* `(a || 0) - (b || 0)` fabricava a diferença contra um zero inventado quando
            uma das pontas não tinha dado — o mesmo defeito da v1.49.0 numa forma que a
            varredura não cobre (subtração, não razão). diffPresent recusa e vira '—'. */}
        <window.KpiCardSpark label="Variação na janela" value={window.fmtSigned(window.diffPresent(last?.share, first?.share), 1, ' p.p.')} deltaPositive={window.deltaUp(window.diffPresent(last?.share, first?.share))} sub={`${first?.y ?? '—'}–${last?.y ?? '—'}`} />
        <window.KpiCardSpark label="Exportação BR" value={'US$ ' + msNum(last?.br, 1) + ' bi'} sub={`mundo: US$ ${msNum(last?.world)} bi`} />
      </div>

      <div className="card">
        <window.SectionHeader overline="Participação no mercado mundial" title="Fração brasileira da exportação global"
          action={<span className="caption">% · MDIC ÷ UN Comtrade</span>} />
        <window.LineChart data={shareTs} valueKey="v" label="% do mundo" color="var(--viz-1)" height={280} />
      </div>

      <div className="card">
        <window.SectionHeader overline="Participação por agrupamento · último ano" title="Onde o Brasil pesa mais no mundo" />
        <window.BarChart data={data.byProduct.slice(0, 10).map(p => ({ name: p.name, value: p.share }))} valueKey="value" color="var(--viz-1)" label="% do mundo" height={300} />
      </div>
    </>
  );
}

// ── (3) Price: farm-gate vs. FOB ──────────────────────────────────────
function ViewPriceSpread() {
  const [product, setProduct] = useMSState(null);
  // Same mass-basis requirement as the export coefficient — offer only pure-mass
  // commodities and default to the first, so the user opens on a real spread.
  const massProds = window.agrupamentoCatalog().filter(p => p.family === 'mass');
  // O padrão é o primeiro agrupamento CALCULÁVEL, não o primeiro da ordem alfabética:
  // abrir no Abacaxi, que não tem NCM, dava as boas-vindas com uma recusa. Os sem lado
  // aduaneiro seguem na lista, escolhíveis, e explicam-se quando escolhidos.
  const primeiro = massProds.find(p => p.hasCustoms) || massProds[0];
  const effProduct = product || (primeiro && primeiro.code) || null;
  // Per-UF scoping ('' = Brasil). Both sides (PEVS farm-gate + COMEX FOB) honour it.
  const [uf, setUf] = useMSState('');
  const data = window.priceSpread(effProduct, uf ? [uf] : undefined);

  // Same mass-basis requirement as the export coefficient: the gate price is
  // value ÷ mass, undefined for volume/mixed selections. The seam refuses with
  // incompatible:true — surface it honestly instead of empty charts + "—" KPIs.
  if (data.incompatible) {
    return (
      <>
        <CrossProductPicker value={effProduct} onChange={setProduct} families={['mass']} />
        <window.UfScopePicker value={uf} onChange={setUf} />
        <div className="card subtle">
          <window.SectionHeader overline="Spread de preço" title="Indicador indisponível para esta seleção" />
          <p className="caption" style={{ padding: '16px 4px' }}>
            O preço na porteira deriva de <strong>valor ÷ massa</strong> (IBGE) e o preço FOB de
            <strong> valor ÷ peso</strong> (MDIC), em US$/kg — só interpretáveis para agrupamentos de
            família <strong>massa</strong>. A seleção atual inclui agrupamento de volume (m³) ou cesta
            mista. Escolha um agrupamento de massa para ver o spread.
          </p>
        </div>
      </>
    );
  }

  const last = data.series[data.series.length - 1];
  const markupTs = data.series.map(d => ({ y: d.y, v: d.markup }));
  const lineSeries = [
    { name: 'Preço de exportação (FOB)', color: 'var(--viz-3)', data: data.series.map(d => ({ y: d.y, v: d.fob })) },
    { name: 'Preço na porteira (produção)', color: 'var(--viz-2)', data: data.series.map(d => ({ y: d.y, v: d.gate })) },
  ];

  return (
    <>
      <CrossProductPicker value={effProduct} onChange={setProduct} families={['mass']} />
      <window.UfScopePicker value={uf} onChange={setUf} />
      <window.LoadErrorNote error={data.loadError} />

      <div className="kpi-row">
        {/* Os quatro podem chegar null desde que o backend parou de responder 0 a uma
            razão indefinida (measures.py). Sem a guarda sairia "US$ —/kg" e "×—" — um
            prefixo e um sufixo afirmando uma unidade sobre um valor que não existe. */}
        <window.KpiCardSpark label="Preço FOB atual" value={msUnit(last?.fob, 'US$ ', '/kg', 2)} sub={`${last?.y ?? '—'} · no porto`} />
        <window.KpiCardSpark label="Preço na porteira" value={msUnit(last?.gate, 'US$ ', '/kg', 2)} sub="na produção" />
        <window.KpiCardSpark label="Markup" value={msUnit(last?.markup, '×', '', 1)} sub="FOB ÷ porteira" />
        <window.KpiCardSpark label="Spread" value={msUnit(last?.spread, 'US$ ', '/kg', 2)} sub="valor agregado entre porteira e porto" />
      </div>

      <div className="card">
        <window.SectionHeader overline="Porteira vs. porto · US$/kg" title="Onde o valor é capturado"
          action={<span className="caption">IBGE × MDIC</span>} />
        <window.MultiLineChart series={lineSeries} valueKey="v" label="US$/kg" height={300} trend showLegend={false} />
        <div className="pc-legend">
          {lineSeries.map(s => (
            <span key={s.name} className="pc-legend-item"><span className="pc-legend-dot" style={{ background: s.color }}></span>{s.name}</span>
          ))}
        </div>
      </div>

      <div className="card">
        <window.SectionHeader overline="Markup no tempo" title="Quantas vezes o porto vale a porteira"
          action={<span className="caption">× · FOB ÷ porteira</span>} />
        <window.LineChart data={markupTs} valueKey="v" label="×" color="var(--embrapa-blue)" height={240} />
      </div>
    </>
  );
}

// ── (4) Espelho comercial ─────────────────────────────────────────────
function ViewMirror() {
  const [product, setProduct] = useMSState(null);
  const data = window.tradeMirror(product);
  const last = data.series[data.series.length - 1];
  // meanPresent: um ano sem dado nas DUAS fontes chega com v null e não pode entrar na
  // média como zero — puxaria a divergência média para baixo com anos que ninguém mediu.
  const avgDisc = window.meanPresent((data.discrepancy || []).map(d => d.v));
  // "Maior reporte" era a STRING FIXA "Parceiros", com o sub "tendem a registrar mais
  // que a origem". A tendência é real — medido em produção 2026-09-08, os parceiros
  // reportam mais em 18 dos 26 anos —, mas o card a afirmava como se a tivesse medido
  // NESTA seleção, e os anos recentes logo ao lado a contradiziam: em 2022, 2023 e 2024
  // os parceiros reportaram MENOS. Agora conta os anos comparáveis do recorte ativo.
  const comparaveis = (data.series || []).filter(d => d.partners != null && d.mdic != null);
  const anosParceirosMaior = comparaveis.filter(d => d.partners > d.mdic).length;
  const maiorReporte = !comparaveis.length
    ? { valor: '—', sub: 'sem ano comparável no recorte' }
    : anosParceirosMaior * 2 === comparaveis.length
      ? { valor: 'Empate', sub: `${anosParceirosMaior} de ${comparaveis.length} anos para cada lado` }
      : anosParceirosMaior * 2 > comparaveis.length
        ? { valor: 'Parceiros', sub: `reportam mais em ${anosParceirosMaior} de ${comparaveis.length} anos` }
        : { valor: 'MDIC · SECEX',
            sub: `reporta mais em ${comparaveis.length - anosParceirosMaior} de ${comparaveis.length} anos` };
  // Real series window (#25) — never the hardcoded "1997–2024". Derived from the
  // same series the KPIs above read, so it tracks the actual data span.
  const mirrorYears = (data?.series || []).map(d => d.y);
  const mirrorWindow = mirrorYears.length ? `${mirrorYears[0]}–${mirrorYears[mirrorYears.length - 1]}` : '—';
  const lineSeries = [
    { name: 'MDIC · SECEX', color: 'var(--viz-1)', data: data.series.map(d => ({ y: d.y, v: d.mdic })) },
    { name: 'UN Comtrade (Brasil)', color: 'var(--viz-3)', data: data.series.map(d => ({ y: d.y, v: d.comtrade })) },
    { name: 'Reportado pelos parceiros', color: 'var(--viz-9)', data: data.series.map(d => ({ y: d.y, v: d.partners })) },
  ];

  return (
    <>
      <CrossProductPicker value={product} onChange={setProduct} />
      <window.LoadErrorNote error={data.loadError} />

      <div className="kpi-row">
        <window.KpiCardSpark label="Divergência média" value={msPct(avgDisc)} sub="entre MDIC e Comtrade" />
        <window.KpiCardSpark label="Maior reporte" value={maiorReporte.valor} sub={maiorReporte.sub} />
        <window.KpiCardSpark label="Exportação MDIC" value={'US$ ' + msNum(last?.mdic, 1) + ' bi'} sub={`${last?.y ?? '—'}`} />
        <window.KpiCardSpark label="Janela" value={mirrorWindow} sub="cobertura comparável" />
      </div>

      <div className="card">
        <window.SectionHeader overline="A mesma exportação, três fontes" title="MDIC × Comtrade × parceiros"
          action={<span className="caption">US$ bi · MDIC × UN Comtrade</span>} />
        <window.MultiLineChart series={lineSeries} valueKey="v" label="US$ bi" height={300} showLegend={false} />
        <div className="pc-legend">
          {lineSeries.map(s => (
            <span key={s.name} className="pc-legend-item"><span className="pc-legend-dot" style={{ background: s.color }}></span>{s.name}</span>
          ))}
        </div>
      </div>

      <div className="card">
        <window.SectionHeader overline="Divergência no tempo" title="Quão distantes estão as fontes"
          action={<span className="caption">% · |MDIC − Comtrade| ÷ média</span>} />
        <window.LineChart data={data.discrepancy} valueKey="v" label="% divergência" color="var(--status-warn)" height={240} />
        <p className="caption" style={{ padding: '10px 2px 2px' }}>
          Divergências persistentes apontam diferenças de metodologia, defasagem de revisão ou cobertura — um diagnóstico que nenhuma fonte isolada revela.
        </p>
      </div>
    </>
  );
}

Object.assign(window, { CrossProductPicker, ViewExportCoef, ViewMarketShare, ViewPriceSpread, ViewMirror });
