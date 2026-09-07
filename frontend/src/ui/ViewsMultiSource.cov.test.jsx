// ViewsMultiSource.cov.test.jsx — render coverage for the four analytical multi-source
// perspectives: export coefficient, Brazil-in-the-world market share, farm-gate vs FOB
// price spread, and the trade mirror (MDIC × Comtrade × partners). Each is self-contained
// (own CrossProductPicker) and reads a cross-analytics producer from producers.js
// (window.exportCoefficient / marketShare / priceSpread / tradeMirror). Following the
// ViewProductCompare/ViewRebanho .cov pattern we stub every window.* dependency to drive
// the main branches — including the family-gated mass-only pickers and the seam's
// `incompatible:true` honest-note branch for export-coef / price-spread.
//
// IMPORTANT: ViewsMultiSource binds `msNum = window.numBR` / `msPct = window.pctBR` and the
// `useMSState = React` hook at MODULE-LOAD time, so those globals (and React) must be set
// BEFORE the dynamic import. We do that in a one-time module-load step.

import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
// O seriesUtils e a nota REAIS: `materialityFloor` + `PRODUCAO_FLOOR` decidem quem entra
// no ranking, e a nota é a metade "nada some em silêncio" da regra. Stubá-los examinaria
// o stub — e uma nota stubada deixaria a filtragem invisível passar verde.
import './seriesUtils.js';
import './MaterialityFloorNote.jsx';

// pt-BR-ish stubs for the import-time-captured formatters.
const numBR = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
const pctBR = (v) => (v == null ? '—' : Number(v).toFixed(1) + '%');

// Capture-friendly widget stubs shared by all four views.
function stubWidgets() {
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{error}</div> : null);
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh">
      <span className="sh-ov">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.BrazilTileMap = () => <div className="tilemap" />;
  window.LineChart = () => <div className="line" />;
  window.MultiLineChart = () => <div className="mlc" />;
  window.BarChart = () => <div className="bar" />;
  // Expõe as séries empilhadas: é o card novo da composição da produção.
  window.StackedBars = (props) => (
    <div className="stacked"
         data-series={(props.series || []).map((f) => f.id).join(',')}
         data-ufs={(props.rows || []).map((r) => r.uf).join(',')} />
  );
  window.UfScopePicker = ({ value, onChange }) => (
    <select className="uf-picker" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Brasil</option>
      <option value="PA">PA</option>
    </select>
  );
  window.fmtSigned = (x, d, suf = '') => (x >= 0 ? '+' : '') + (x || 0).toFixed(d ?? 0) + suf;
}

// The crosswalk commodity catalog the pickers offer. Açaí is mass; Madeira is volume —
// so the family-gated (mass-only) pickers drop Madeira and the "Todos os agrupamentos" option.
const CATALOG = [
  { code: 'acai', name: 'Açaí', family: 'mass' },
  { code: 'madeira', name: 'Madeira em tora', family: 'volume' },
];

let ViewExportCoef, ViewMarketShare, ViewPriceSpread, ViewMirror, CrossProductPicker;

beforeAll(async () => {
  // Import-time bindings must exist first.
  globalThis.React = React;
  window.React = React;
  window.numBR = numBR;
  window.pctBR = pctBR;
  window.agrupamentoCatalog = () => CATALOG;
  await import('./ViewsMultiSource.jsx');
  ({ ViewExportCoef, ViewMarketShare, ViewPriceSpread, ViewMirror, CrossProductPicker } = window);
});

beforeEach(() => {
  // Re-establish the catalog + widgets per test (cheap; some tests override producers).
  window.agrupamentoCatalog = () => CATALOG;
  stubWidgets();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── CrossProductPicker ────────────────────────────────────────────────────────
describe('CrossProductPicker', () => {
  it('offers "Todos os agrupamentos" + every commodity when no family gate', () => {
    const onChange = vi.fn();
    const { container } = render(<CrossProductPicker value={null} onChange={onChange} />);
    const chips = [...container.querySelectorAll('.pp-chip')].map((c) => c.textContent);
    expect(chips).toContain('Todos os agrupamentos');
    expect(chips).toContain('Açaí');
    expect(chips).toContain('Madeira em tora');
    // The basket chip is "on" when value is null.
    expect(container.querySelector('.pp-chip.on').textContent).toBe('Todos os agrupamentos');
  });

  it('a mass-only gate drops the volume commodity AND the mixed basket', () => {
    const { container } = render(<CrossProductPicker value="acai" onChange={vi.fn()} families={['mass']} />);
    const chips = [...container.querySelectorAll('.pp-chip')].map((c) => c.textContent);
    expect(chips).toContain('Açaí');
    expect(chips).not.toContain('Madeira em tora'); // volume → gated out
    expect(chips).not.toContain('Todos os agrupamentos');  // mixed → incompatible
  });

  it('clicking a commodity chip emits its code; the basket chip emits null', () => {
    const onChange = vi.fn();
    const { container } = render(<CrossProductPicker value={null} onChange={onChange} />);
    const acai = [...container.querySelectorAll('.pp-chip')].find((c) => c.textContent === 'Açaí');
    fireEvent.click(acai);
    expect(onChange).toHaveBeenCalledWith('acai');
    const basket = [...container.querySelectorAll('.pp-chip')].find((c) => c.textContent === 'Todos os agrupamentos');
    fireEvent.click(basket);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

// ── ViewExportCoef ──────────────────────────────────────────────────────────
describe('ViewExportCoef', () => {
  function goodData() {
    return {
      incompatible: false,
      // O formato REAL desde a v1.58.0: a produção vem partida em extração (PEVS) +
      // lavoura (PAM), e `production` é a soma — é o que a barra empilhada desenha.
      national: {
        coefPct: 12.5, production: 1234, productionExtractive: 900, productionCrop: 334,
      },
      byUf: [
        { uf: 'PA', name: 'Pará', production: 800, productionExtractive: 700,
          productionCrop: 100, exportV: 100, coefPct: 12.5 },
        { uf: 'AM', name: 'Amazonas', production: 400, productionExtractive: 200,
          productionCrop: 200, exportV: 20, coefPct: 5 },
      ],
      timeseries: [{ y: 2010, v: 8 }, { y: 2020, v: 12 }],
    };
  }

  it('renders KPIs, tile map, timeseries chart and the UF ranking table', () => {
    window.exportCoefficient = () => goodData();
    const { container } = render(<ViewExportCoef />);
    expect(container.querySelector('.tilemap')).toBeTruthy();
    expect(container.querySelector('.line')).toBeTruthy();
    // Ranking table: one row per producing UF (2).
    expect(container.querySelectorAll('.pc-table tbody tr').length).toBe(2);
    // National coefficient KPI present.
    expect(container.textContent).toContain('Coeficiente nacional');
    // Coverage window derived from the real series (2010–2020).
    expect(container.textContent).toContain('2010–2020');
    // Family-gated picker → only the mass commodity chip.
    const chips = [...container.querySelectorAll('.pp-chip')].map((c) => c.textContent);
    expect(chips).toContain('Açaí');
    expect(chips).not.toContain('Madeira em tora');
  });

  it('o KPI de produção mostra as DUAS metades do denominador', () => {
    window.exportCoefficient = () => goodData();
    const { container } = render(<ViewExportCoef />);
    const card = [...container.querySelectorAll('.kpi')]
      .find((e) => e.dataset.label === 'Produção considerada');
    expect(card, 'card de produção não encontrado').toBeTruthy();
    // O total continua sendo o valor; a COMPOSIÇÃO vai no sub. A razão fica UMA só —
    // "todas as exportações ÷ só a extração" seria o próprio defeito com outro rótulo.
    expect(card.querySelector('.kpi-value').textContent).toContain('1234');
    expect(card.querySelector('.kpi-sub').textContent).toContain('extração');
    expect(card.querySelector('.kpi-sub').textContent).toContain('lavoura');
  });

  it('a barra empilhada mostra extração e lavoura na mesma UF', () => {
    window.exportCoefficient = () => goodData();
    const { container } = render(<ViewExportCoef />);
    const emp = container.querySelector('.stacked');
    expect(emp, 'card de composição não renderizou').toBeTruthy();
    expect(emp.getAttribute('data-series')).toBe('productionExtractive,productionCrop');
    // Ordenada por produção total (PA 800 > AM 400), não pela ordem de chegada.
    expect(emp.getAttribute('data-ufs')).toBe('PA,AM');
  });

  it('só extração: o sub do KPI não inventa uma metade de lavoura que não existe', () => {
    // Carvão vegetal e castanha-do-pará têm `pam: []` no catálogo — a produção é
    // inteiramente extrativa e o card deve dizer isso, não "lavoura 0,0".
    window.exportCoefficient = () => ({
      ...goodData(),
      national: { coefPct: 5, production: 1000, productionExtractive: 1000, productionCrop: 0 },
    });
    const { container } = render(<ViewExportCoef />);
    const sub = [...container.querySelectorAll('.kpi')]
      .find((e) => e.dataset.label === 'Produção considerada')
      .querySelector('.kpi-sub').textContent;
    expect(sub).toContain('só extração nativa');
    expect(sub).not.toContain('lavoura');
  });

  it('o piso tira do topo a UF que produz quase nada, e a tela diz quem saiu', () => {
    // ÂNCORA EXTERNA, medida em produção 2026-09-07: Minas produz 5 t de castanha-do-pará
    // e aparecia como "UF mais exportadora" com 786,0%; o Pará, com 208 mil t e 52,0%,
    // ficava abaixo dela. Todo coeficiente acima de 100% vinha de UF com menos de 10 t.
    window.exportCoefficient = () => ({
      ...goodData(),
      byUf: [
        { uf: 'MG', name: 'Minas Gerais', production: 0.005, productionExtractive: 0.005,
          productionCrop: 0, exportV: 0.039, coefPct: 786.0 },
        { uf: 'PA', name: 'Pará', production: 208.233, productionExtractive: 208.233,
          productionCrop: 0, exportV: 108.3, coefPct: 52.0 },
        { uf: 'AC', name: 'Acre', production: 257.143, productionExtractive: 257.143,
          productionCrop: 0, exportV: 127.5, coefPct: 49.6 },
      ],
    });
    const { container } = render(<ViewExportCoef />);
    const topo = [...container.querySelectorAll('.kpi')]
      .find((e) => e.dataset.label === 'UF mais exportadora');
    expect(topo.querySelector('.kpi-value').textContent).toBe('PA');
    // E nada some em silêncio: a nota nomeia Minas com a produção dela.
    expect(container.textContent).toContain('Fora do ranking por produção');
    expect(container.textContent).toContain('MG');
    // O ranking também: 2 linhas, não 3.
    expect(container.querySelectorAll('.pc-table tbody tr').length).toBe(2);
  });

  it('a single-producing-UF dataset shows the "concentrated" fallback KPI', () => {
    window.exportCoefficient = () => ({
      ...goodData(),
      byUf: [{ uf: 'PA', name: 'Pará', production: 800, productionExtractive: 700,
               productionCrop: 100, exportV: 100, coefPct: 12.5 }],
    });
    const { container } = render(<ViewExportCoef />);
    expect(container.textContent).toContain('produção concentrada em 1 UF');
  });

  it('sem NCM, a recusa diz que falta o NUMERADOR — não repete a nota de família', () => {
    // Desde a v1.58.0 o gate de família lê as DUAS pesquisas de produção, então
    // agrupamentos só-PAM chegam a esta view. Três deles (abacaxi, café, cana-de-açúcar)
    // não têm NCM no cruzamento: sem lado aduaneiro não existe coeficiente, e "—" em
    // todos os KPIs deixaria o pesquisador sem saber se falta dado ou se algo quebrou.
    window.exportCoefficient = () => ({
      incompatible: true, incompatibleReason: 'sem-ncm',
      byUf: [], national: {}, timeseries: [],
    });
    const { container } = render(<ViewExportCoef />);
    expect(container.textContent).toContain('correspondência na NCM');
    expect(container.textContent).not.toContain('cesta mista');
    expect(container.querySelector('.line')).toBeNull(); // sem gráficos em branco
  });

  it('an incompatible (volume/mixed) selection renders the honest note instead of charts', () => {
    // The view computes `data.byUf.filter(...)` before the incompatible check, so the
    // refusal payload still carries the (empty) arrays the contract guarantees.
    window.exportCoefficient = () => ({ incompatible: true, byUf: [], national: {}, timeseries: [] });
    const { container } = render(<ViewExportCoef />);
    expect(container.textContent).toContain('Indicador indisponível para esta seleção');
    expect(container.querySelector('.tilemap')).toBeFalsy(); // no charts in the refusal state
  });

  it('changing the commodity re-queries (picker onChange)', () => {
    const calls = [];
    window.exportCoefficient = (code) => { calls.push(code); return goodData(); };
    const { container } = render(<ViewExportCoef />);
    // Default lands on the first mass commodity (acai). Clicking it again is a no-op-ish
    // re-select; just assert the producer was called and the view didn't crash.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const acai = [...container.querySelectorAll('.pp-chip')].find((c) => c.textContent === 'Açaí');
    fireEvent.click(acai);
    expect(container.querySelector('.tilemap')).toBeTruthy();
  });
});

// ── ViewMarketShare ──────────────────────────────────────────────────────────
describe('ViewMarketShare', () => {
  it('renders KPIs, the share timeseries and the by-commodity bar chart', () => {
    window.marketShare = () => ({
      series: [
        { y: 2010, share: 5, br: 1.2, world: 24 },
        { y: 2020, share: 8, br: 2.0, world: 25 },
      ],
      byProduct: [{ name: 'Açaí', share: 8 }, { name: 'Castanha', share: 3 }],
    });
    const { container } = render(<ViewMarketShare />);
    expect(container.querySelector('.line')).toBeTruthy();
    expect(container.querySelector('.bar')).toBeTruthy();
    expect(container.textContent).toContain('Participação atual');
    expect(container.textContent).toContain('Pico histórico');
    // Non-mass-gated picker → includes the basket + both commodities.
    const chips = [...container.querySelectorAll('.pp-chip')].map((c) => c.textContent);
    expect(chips).toContain('Todos os agrupamentos');
    expect(chips).toContain('Madeira em tora');
  });

  it('selecting a commodity re-queries marketShare', () => {
    const calls = [];
    window.marketShare = (code) => {
      calls.push(code);
      return { series: [{ y: 2020, share: 4, br: 1, world: 25 }], byProduct: [] };
    };
    const { container } = render(<ViewMarketShare />);
    const madeira = [...container.querySelectorAll('.pp-chip')].find((c) => c.textContent === 'Madeira em tora');
    fireEvent.click(madeira);
    expect(calls).toContain('madeira');
  });
});

// ── ViewPriceSpread ──────────────────────────────────────────────────────────
describe('ViewPriceSpread', () => {
  function goodSpread() {
    return {
      incompatible: false,
      series: [
        { y: 2010, fob: 2.0, gate: 0.8, markup: 2.5, spread: 1.2 },
        { y: 2020, fob: 3.0, gate: 1.0, markup: 3.0, spread: 2.0 },
      ],
    };
  }

  it('renders the FOB/gate KPIs + the two price charts', () => {
    window.priceSpread = () => goodSpread();
    const { container } = render(<ViewPriceSpread />);
    expect(container.querySelector('.mlc')).toBeTruthy(); // FOB vs gate lines
    expect(container.querySelector('.line')).toBeTruthy(); // markup line
    expect(container.textContent).toContain('Preço FOB atual');
    expect(container.textContent).toContain('Markup');
    // Mass-only picker present + the UF scope picker.
    expect(container.querySelector('.uf-picker')).toBeTruthy();
  });

  it('an incompatible selection renders the honest refusal note', () => {
    window.priceSpread = () => ({ incompatible: true });
    const { container } = render(<ViewPriceSpread />);
    expect(container.textContent).toContain('Indicador indisponível para esta seleção');
    expect(container.querySelector('.mlc')).toBeFalsy();
    // The UF picker is still offered in the refusal state.
    expect(container.querySelector('.uf-picker')).toBeTruthy();
  });

  it('scoping by UF re-queries priceSpread with the state', () => {
    const calls = [];
    window.priceSpread = (code, states) => { calls.push(states); return goodSpread(); };
    const { container } = render(<ViewPriceSpread />);
    const uf = container.querySelector('.uf-picker');
    fireEvent.change(uf, { target: { value: 'PA' } });
    // After the change, the producer is re-invoked with ['PA'].
    expect(calls.some((s) => Array.isArray(s) && s[0] === 'PA')).toBe(true);
  });
});

// ── ViewMirror ──────────────────────────────────────────────────────────────
describe('ViewMirror', () => {
  it('renders the three-source lines + the divergence chart and KPIs', () => {
    window.tradeMirror = () => ({
      series: [
        { y: 2010, mdic: 1.0, comtrade: 1.1, partners: 1.2 },
        { y: 2020, mdic: 2.0, comtrade: 2.1, partners: 2.3 },
      ],
      discrepancy: [{ y: 2010, v: 9 }, { y: 2020, v: 5 }],
    });
    const { container } = render(<ViewMirror />);
    expect(container.querySelector('.mlc')).toBeTruthy();   // 3-source overlay
    expect(container.querySelector('.line')).toBeTruthy();  // divergence
    expect(container.textContent).toContain('Divergência média');
    expect(container.textContent).toContain('Exportação MDIC');
    // Window KPI derived from the real series (2010–2020).
    expect(container.textContent).toContain('2010–2020');
  });

  it('an empty discrepancy series does not divide-by-zero (avgDisc guard)', () => {
    window.tradeMirror = () => ({
      series: [{ y: 2020, mdic: 2.0, comtrade: 2.1, partners: 2.3 }],
      discrepancy: [],
    });
    const { container } = render(<ViewMirror />);
    // Renders the window fallback safely.
    expect(container.textContent).toContain('Divergência média');
  });

  it('an empty mirror series renders the "Exportação MDIC" KPI without leaking "undefined"', () => {
    // Reachable payload: an agrupamento with no Comtrade-mirror rows → series: [].
    // The KPI year-sub must fall back to the em dash, never the literal "undefined".
    window.tradeMirror = () => ({ series: [], discrepancy: [] });
    const { container } = render(<ViewMirror />);
    expect(container.textContent).toContain('Exportação MDIC');
    expect(container.textContent).not.toContain('undefined');
  });
});
