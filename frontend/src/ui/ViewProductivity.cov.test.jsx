// ViewProductivity.cov.test.jsx — coverage smoke + branch tests for the
// agricultural yield/area view (ViewProductivity.jsx, PAM-only). It is a
// self-data view: it reads window.productivityData(database, crop, summary), so we
// stub that producer plus the window.* formatters/widgets and drive:
//   - the no-data empty state (EmptyCard) — banco without the 'yield' capability,
//   - a full render: crop selector, the 4 KPIs (rendimento/área/produção/CAGR), the
//     national yield+area LineCharts, the per-UF tile map + ranking BarChart,
//   - the NotApplicableNote (basket-active) branch,
//   - the fmtArea/fmtProd magnitude branches (>= 1e6 → "mi", else "mil").

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
// O seriesUtils REAL — `materialityFloor` e a calibração `AREA_FLOOR` são o alvo do
// teste do piso de área; com um stub, o teste examinaria o stub. Pelo mesmo motivo a
// chamada na view é incondicional: o helper ausente tem de estourar, não voltar a pôr
// uma UF de 205 ha no topo do ranking em silêncio.
import './seriesUtils.js';
// A nota REAL, não um stub: ela é a metade "nada some em silêncio" do piso, e um stub
// deixaria a varredura verde com a tela calada. É o mesmo motivo pelo qual
// ViewOverview.test.jsx importa o RecorteNote de verdade.
import './MaterialityFloorNote.jsx';

function stubGlobals(prodData) {
  window.productivityData = () => prodData;
  // O stub tem de devolver '—' para ausente, como o numBR REAL: com
  // `Number(null).toFixed()` ele imprimia "0", e um rendimento ausente aparecia como
  // "0 kg/ha" no teste mesmo com o código correto — o stub escondia o defeito que o
  // teste existe para pegar.
  window.numBR = (v, d) => (v == null ? '—' : Number(v).toFixed(d == null ? 0 : d).replace('.', ','));
  window.fmtSigned = (v) => `${v >= 0 ? '+' : ''}${v}%`;
  // Widgets → readable DOM.
  window.EmptyCard = ({ children }) => <div className="empty-card">{children}</div>;
  window.NotApplicableNote = ({ note }) =>
    note ? <div className="na-note">{note.basket || note.states || ''}</div> : null;
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{error}</div> : null);
  window.KpiCardSpark = ({ label, value }) => (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
  window.SectionHeader = ({ title, overline }) => (
    <div className="sh">
      <span className="sh-overline">{overline}</span>
      <span className="sh-title">{title}</span>
    </div>
  );
  window.UnitFamilyTag = () => <span className="uf-tag" />;
  window.LineChart = (props) => <div className="line-chart" data-points={(props.data || []).length} />;
  window.BarChart = (props) => (
    <div className="bar-chart" data-points={(props.data || []).length}
         data-ufs={(props.data || []).map((d) => d.uf).join(',')}
         data-hover-key={props.hoverKey || ''} />
  );
  window.BrazilTileMap = (props) => (
    <div className="tile-map" data-points={(props.data || []).length}
         data-ufs={(props.data || []).map((d) => d.uf).join(',')}
         data-sem-cor={(props.data || []).filter((d) => d[props.valueKey] == null)
           .map((d) => d.uf).join(',')} />
  );
}

// A representative productivityData payload (PAM-shaped). Area/prod are in the
// >= 1e6 band so the "mi ha" / "mi t" formatting branch is exercised.
function makeData(overrides = {}) {
  return {
    crop: { code: 'C1', name: 'Soja' },
    crops: [
      { code: 'C1', name: 'Soja' },
      { code: 'C2', name: 'Milho' },
    ],
    yieldUnit: 'kg/ha',
    areaUnit: 'ha',
    series: [
      { y: 2019, yieldKgHa: 3000, areaHa: 2_000_000, prodT: 6_000_000 },
      { y: 2020, yieldKgHa: 3300, areaHa: 2_100_000, prodT: 6_930_000 },
    ],
    national: { yieldCagr: 4.2 },
    byUF: [
      { uf: 'MT', name: 'Mato Grosso', yieldKgHa: 3500.6 },
      { uf: 'PR', name: 'Paraná', yieldKgHa: 3400.2 },
    ],
    notApplicable: undefined,
    ...overrides,
  };
}

let ViewProductivity;

beforeEach(async () => {
  await import('./ViewProductivity.jsx'); // registers window.ViewProductivity
  ViewProductivity = window.ViewProductivity;
});

afterEach(() => cleanup());

describe('ViewProductivity — empty state', () => {
  it('renders the EmptyCard when the producer returns null (no yield capability)', () => {
    stubGlobals(null);
    const { container } = render(
      <ViewProductivity summary={{}} conventions={{}} database="ibge_pevs" />
    );
    expect(container.querySelector('.empty-card')).toBeTruthy();
    expect(container.textContent).toContain('não expõe rendimento agrícola');
  });
});

describe('ViewProductivity — full render (PAM)', () => {
  it('renders the crop selector, the four KPIs, the trajectory charts and the UF geography', () => {
    stubGlobals(makeData());
    const { container } = render(
      <ViewProductivity summary={{}} conventions={{ currency: 'BRL' }} database="ibge_pam" />
    );

    // Crop selector with both crops; the active one (C1/Soja) carries the 'on' class.
    expect(container.textContent).toContain('Lavoura em análise');
    const chips = [...container.querySelectorAll('.pp-chip')];
    expect(chips.map((c) => c.textContent.trim())).toEqual(['Soja', 'Milho']);
    expect(chips[0].className).toContain('on');

    // KPI strip — four cards.
    const kpiLabels = [...container.querySelectorAll('.kpi-label')].map((e) => e.textContent);
    expect(kpiLabels.some((l) => l.includes('Rendimento nacional'))).toBe(true);
    expect(kpiLabels).toContain('Área colhida');
    expect(kpiLabels).toContain('Produção');
    expect(kpiLabels).toContain('CAGR do rendimento');

    // fmtArea/fmtProd hit the >= 1e6 branch → "mi ha" / "mi t".
    const kpiValues = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(kpiValues.some((v) => v.includes('mi ha'))).toBe(true);
    expect(kpiValues.some((v) => v.includes('mi t'))).toBe(true);

    // Two national trajectory LineCharts + the per-UF tile map + the ranking BarChart.
    expect(container.querySelectorAll('.line-chart').length).toBe(2);
    expect(container.querySelector('.tile-map')).toBeTruthy();
    expect(container.querySelector('.bar-chart')).toBeTruthy();

    // No basket note when notApplicable is undefined.
    expect(container.querySelector('.na-note')).toBeNull();
  });

  it('surfaces the basket NotApplicableNote when the producer flags it', () => {
    stubGlobals(
      makeData({
        notApplicable: { basket: 'A cesta de produtos não se aplica aqui.' },
      })
    );
    const { container } = render(
      <ViewProductivity summary={{ basket: ['C1'] }} conventions={{}} database="ibge_pam" />
    );
    expect(container.querySelector('.na-note')).toBeTruthy();
    expect(container.textContent).toContain('A cesta de produtos não se aplica aqui.');
  });

  it('falls into the "mil ha"/"mil t" formatting branch for sub-million area/production', () => {
    stubGlobals(
      makeData({
        series: [
          { y: 2019, yieldKgHa: 2000, areaHa: 30_000, prodT: 60_000 },
          { y: 2020, yieldKgHa: 2100, areaHa: 32_000, prodT: 67_200 },
        ],
      })
    );
    const { container } = render(
      <ViewProductivity summary={{}} conventions={{}} database="ibge_pam" />
    );
    const kpiValues = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(kpiValues.some((v) => v.includes('mil ha'))).toBe(true);
    expect(kpiValues.some((v) => v.includes('mil t'))).toBe(true);
  });

  it('guards the empty-series loading frame without crashing', () => {
    // series: [] → last/prev/first fall back to the zero guard; deltas are 0.
    stubGlobals(makeData({ series: [], byUF: [] }));
    const { container } = render(
      <ViewProductivity summary={{}} conventions={{}} database="ibge_pam" />
    );
    // Still renders the selector + KPI strip (no throw on the empty series).
    expect(container.textContent).toContain('Lavoura em análise');
    expect(container.querySelectorAll('.kpi').length).toBe(4);
  });
});

// ── O piso de área (v1.57.0) ───────────────────────────────────────────────
//
// ÂNCORA EXTERNA: cana-de-açúcar, safra 2024, medida em serving_pam_annual em
// 2026-09-07 — as 8 UFs de maior rendimento, na ordem real. Não é fixture inventada:
// é exatamente o que a tela mostrava, com o DF (205 ha, 0,002% da área nacional)
// encabeçando "UFs mais produtivas" por causa do arredondamento da fonte.
const CANA_2024 = [
  { uf: 'DF', name: 'Distrito Federal', areaHa: 205, yieldKgHa: 85000 },
  { uf: 'TO', name: 'Tocantins', areaHa: 36105, yieldKgHa: 81663 },
  { uf: 'MT', name: 'Mato Grosso', areaHa: 241946, yieldKgHa: 81479 },
  { uf: 'GO', name: 'Goiás', areaHa: 1015810, yieldKgHa: 79735 },
  { uf: 'MS', name: 'Mato Grosso do Sul', areaHa: 672523, yieldKgHa: 78063 },
  { uf: 'SP', name: 'São Paulo', areaHa: 5398676, yieldKgHa: 77532 },
  { uf: 'MG', name: 'Minas Gerais', areaHa: 1118810, yieldKgHa: 74869 },
  { uf: 'BA', name: 'Bahia', areaHa: 74564, yieldKgHa: 74768 },
];

describe('ViewProductivity — piso de área no ranking e no mapa', () => {
  function renderCana() {
    stubGlobals(makeData({ crop: { code: 'C1', name: 'Cana-de-açúcar' }, byUF: CANA_2024 }));
    return render(<ViewProductivity summary={{}} conventions={{}} database="ibge_pam" />);
  }

  it('o ranking deixa de ser liderado pela UF de área desprezível', () => {
    const { container } = renderCana();
    const ufs = container.querySelector('.bar-chart').getAttribute('data-ufs').split(',');
    // TO é o líder que a consulta sobre as 27 UFs reais também devolve com o piso ligado.
    expect(ufs[0]).toBe('TO');
    expect(ufs).not.toContain('DF'); // 205 ha — reprova nas duas provas
    // E as UFs comparáveis continuam TODAS lá, na ordem de rendimento. O TO está entre
    // elas por causa da prova ABSOLUTA: 36.105 ha, apenas 0,42% do recorte.
    expect(ufs).toEqual(['TO', 'MT', 'GO', 'MS', 'SP', 'MG', 'BA']);
  });

  it('as UFs de fora permanecem no MAPA, sem cor de intensidade (não somem)', () => {
    const { container } = renderCana();
    const mapa = container.querySelector('.tile-map');
    // Todas as 8 continuam no grid — sair do gradiente não é sair do mapa.
    expect(mapa.getAttribute('data-points')).toBe('8');
    // A de fora chega com o valor NULO (índice -1 do quantil ⇒ célula neutra).
    // Zero seria uma afirmação de rendimento zero; nulo é a recusa de comparar.
    expect(mapa.getAttribute('data-sem-cor').split(',')).toEqual(['DF']);
  });

  it('a tela NOMEIA quem ficou de fora, com a área e o motivo', () => {
    const { container } = renderCana();
    expect(container.textContent).toContain('Fora da comparação por área');
    expect(container.textContent).toContain('DF');
    expect(container.textContent).toContain('205 ha'); // a área concreta, para o leitor julgar
    // A nota enuncia a REGRA (as duas provas reprovadas), não uma causa que só valeria
    // para parte da lista: "arredondamento da fonte" é verdade para 205 ha e mentira
    // para 50 mil, e a mesma nota pode cobrir as duas.
    expect(container.textContent).toContain('0,5% da área colhida do recorte');
    expect(container.textContent).toContain('1 mil ha no total');
    expect(container.textContent).not.toContain('arredondamento da fonte');
  });

  it('a barra carrega a ÁREA no hover, para o leitor julgar a base de cada uma', () => {
    const { container } = renderCana();
    expect(container.querySelector('.bar-chart').getAttribute('data-hover-key')).toBe('areaHa');
  });

  it('rendimento AUSENTE não vira "0 kg/ha" na tela', () => {
    // Uma UF sem área colhida não tem rendimento: a razão é indefinida, e o serializer
    // manda `null` desde a v1.60.2. `Math.round(null) === 0` transformava isso em "0
    // kg/ha" — uma afirmação sobre um estado que sequer planta a lavoura.
    stubGlobals(makeData({
      series: [
        { y: 2023, yieldKgHa: null, areaHa: 0, prodT: 0 },
        { y: 2024, yieldKgHa: null, areaHa: 0, prodT: 0 },
      ],
      byUF: [
        { uf: 'CE', name: 'Ceará', areaHa: 50000, yieldKgHa: 2000 },
        { uf: 'RS', name: 'Rio Grande do Sul', areaHa: 0, yieldKgHa: null },
      ],
    }));
    const { container } = render(<ViewProductivity summary={{}} conventions={{}} database="ibge_pam" />);
    const valores = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(valores.some((v) => /^0 kg\/ha/.test(v)), `KPI afirmou zero: ${valores}`).toBe(false);
    // E no mapa a célula do RS chega NULA, não zerada — o quantil a pinta de neutro.
    const semCor = container.querySelector('.tile-map').getAttribute('data-sem-cor').split(',');
    expect(semCor).toContain('RS');
  });

  it('sem coluna de área o piso não morde — o ranking não pode esvaziar', () => {
    // makeData() padrão traz byUF SEM areaHa (um banco que não informa área).
    stubGlobals(makeData());
    const { container } = render(<ViewProductivity summary={{}} conventions={{}} database="ibge_pam" />);
    expect(container.querySelector('.bar-chart').getAttribute('data-ufs')).toBe('MT,PR');
    expect(container.textContent).not.toContain('Fora da comparação por área');
  });
});
