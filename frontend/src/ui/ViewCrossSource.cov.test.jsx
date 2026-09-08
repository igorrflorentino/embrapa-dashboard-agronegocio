// ViewCrossSource.cov.test.jsx — render coverage for the "Cruzamento entre fontes"
// perspective. The view orchestrates a 2–4 (banco, metric) selection across DIFFERENT
// bancos on a shared time axis: the series picker, the visualization toggle (base100 /
// dual-axis / panels), per-series growth metrics (variação acumulada / CAGR), pairwise
// Pearson correlation, and a ratio panel that only appears when exactly two series share
// a unit. All data flows through window.crossSeries / crossCommonWindow (producers.js),
// so — following the ViewProductCompare/ViewRebanho .cov pattern — we stub every window.*
// dependency to drive each branch deterministically.
//
// The view reads React hooks off the GLOBAL `React` (the prototype convention), so we set
// globalThis.React / window.React before importing it.

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

let multiLineProps, dualAxisProps, stackedProps;

// A tiny banco registry: two live bancos (each with one metric) + one no-data banco
// (SEFAZ-like: has a metric but no data yet → its chips stay disabled).
const BANCOS = [
  {
    id: 'ibge_pevs',
    short: 'IBGE',
    status: 'live',
    metrics: [{ id: 'prod_value', label: 'Valor da produção', unit: 'R$ mil', family: 'currency', agg: 'soma', years: [1997, 2024] }],
  },
  {
    id: 'mdic_comex',
    short: 'MDIC',
    status: 'live',
    metrics: [{ id: 'exp_value', label: 'Valor exportado', unit: 'US$ mil', family: 'currency', agg: 'soma', years: [1997, 2023] }],
  },
  {
    id: 'un_comtrade',
    short: 'Comtrade',
    status: 'live',
    metrics: [{ id: 'world_qty', label: 'Quantidade mundial', unit: 'kg', family: 'mass', agg: 'soma', years: [1997, 2022] }],
  },
  {
    id: 'sefaz',
    short: 'SEFAZ',
    status: 'planned',
    metrics: [{ id: 'flow_value', label: 'Fluxo interno', unit: 'R$ mil', family: 'currency', agg: 'soma', years: [2000, 2024] }],
  },
  // A banco with NO metrics — must be hidden entirely from the picker.
  { id: 'ibge_pam', short: 'PAM', status: 'live', metrics: [] },
];

// Per-(banco, metric) canned series. The IBGE/MDIC pair overlaps 2018–2020; the third
// banco never has data (no entry → undefined → not pickable).
const SERIES = {
  'ibge_pevs:prod_value': {
    banco: 'ibge_pevs',
    metric: 'prod_value',
    key: 'ibge_pevs:prod_value',
    bancoMeta: { short: 'IBGE' },
    label: 'Valor da produção',
    unit: 'R$ mil',
    family: 'currency',
    coverage: [1997, 2024],
    points: [{ y: 2018, v: 100 }, { y: 2019, v: 150 }, { y: 2020, v: 200 }],
  },
  'mdic_comex:exp_value': {
    banco: 'mdic_comex',
    metric: 'exp_value',
    key: 'mdic_comex:exp_value',
    bancoMeta: { short: 'MDIC' },
    label: 'Valor exportado',
    unit: 'US$ mil',
    family: 'currency',
    coverage: [1997, 2023],
    points: [{ y: 2018, v: 80 }, { y: 2019, v: 90 }, { y: 2020, v: 120 }],
  },
  // A COMTRADE (country-origin) series in a THIRD unit family — used to trigger the
  // dual-axis "too many units" disabled branch + the per-UF "not applicable" note.
  'un_comtrade:world_qty': {
    banco: 'un_comtrade',
    metric: 'world_qty',
    key: 'un_comtrade:world_qty',
    bancoMeta: { short: 'Comtrade' },
    label: 'Quantidade mundial',
    unit: 'kg',
    family: 'mass',
    coverage: [1997, 2022],
    points: [{ y: 2018, v: 500 }, { y: 2019, v: 520 }, { y: 2020, v: 540 }],
  },
  // Same unit as IBGE → makes the ratio panel eligible when paired with it.
  'mdic_comex:exp_brl': {
    banco: 'mdic_comex',
    metric: 'exp_brl',
    key: 'mdic_comex:exp_brl',
    bancoMeta: { short: 'MDIC' },
    label: 'Exportação (R$)',
    unit: 'R$ mil',
    family: 'currency',
    coverage: [1997, 2023],
    points: [{ y: 2018, v: 40 }, { y: 2019, v: 60 }, { y: 2020, v: 80 }],
  },
};

function stubGlobals() {
  window.crossCommonWindow = (refs) => {
    // Union bounds from the canned coverages; the comparable window is pinned to a
    // small, deterministic 2018–2020 regardless of the real coverage so the option
    // list and assertions stay stable.
    const covs = refs
      .map((r) => SERIES[r.banco + ':' + r.metric]?.coverage)
      .filter(Boolean);
    if (!covs.length) return { y0: 2018, y1: 2020, union: [2018, 2020] };
    const union = [Math.min(...covs.map((c) => c[0])), Math.max(...covs.map((c) => c[1]))];
    return { y0: 2018, y1: 2020, union: [union[0], union[1]] };
  };
  window.crossSeries = (b, m, opts = {}) => {
    const s = SERIES[b + ':' + m];
    if (!s) return null;
    const { y0, y1 } = opts;
    const points = s.points.filter((p) => (y0 == null || p.y >= y0) && (y1 == null || p.y <= y1));
    return { ...s, points };
  };

  // Metric/series math — predictable so branches are assertable.
  window.cagrPct = (v0, vT, span) => (v0 && span ? ((vT / v0) ** (1 / span) - 1) * 100 : 0);
  window.spanYears = (pts) => (pts.length ? pts[pts.length - 1].y - pts[0].y : 0);
  window.accumPct = (v0, vT) => (v0 ? ((vT - v0) / v0) * 100 : 0);
  // O stub REAL devolve null quando não há dois pares comparáveis (v1.62.0) — este
  // devolvia sempre número, e por isso nenhum teste exercitava o caminho da ausência.
  // Foi assim que `corr[0][1].toFixed(2)` derrubou a perspectiva em produção.
  window.pearsonByYear = (a, b) => (a === b ? 1 : 0.42);
  window.corrColor = () => 'var(--ok)';
  window.fmtSigned = (x, d) => (x >= 0 ? '+' : '') + (x || 0).toFixed(d ?? 0) + '%';
  window.METRIC_FAMILIES = { currency: { label: 'Valor' }, mass: { label: 'Massa' } };

  // Banco registry helpers.
  window.BANCOS = BANCOS;
  window.visibleBancos = () => BANCOS;
  window.maturityMeta = (b) => ({ hasData: b.status === 'live' });
  window.bancoAvailability = (b) => (b.status === 'planned' ? 'planejado' : 'beta');

  // Composed widgets — render markers / capture props.
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{error}</div> : null);
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh">
      <span className="sh-ov">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.Icon = () => <span className="icon" />;
  window.UfScopePicker = ({ value, onChange }) => (
    <select className="uf-picker" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Brasil</option>
      <option value="PA">PA</option>
    </select>
  );
  window.MultiLineChart = (props) => { multiLineProps = props; return <div className="mlc" />; };
  window.DualAxisLineChart = (props) => { dualAxisProps = props; return <div className="dual" />; };
  window.StackedPanels = (props) => { stackedProps = props; return <div className="panels" />; };
}

let ViewCrossSource;

beforeEach(async () => {
  multiLineProps = undefined; dualAxisProps = undefined; stackedProps = undefined;
  globalThis.React = React;
  window.React = React;
  await import('./ViewCrossSource.jsx'); // registers window.ViewCrossSource + DEFAULT_CROSS_STATE
  ViewCrossSource = window.ViewCrossSource;
  stubGlobals();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Default landing state: IBGE prod_value × MDIC exp_value (two distinct units).
const defaultState = () => ({
  series: [
    { b: 'ibge_pevs', m: 'prod_value' },
    { b: 'mdic_comex', m: 'exp_value' },
  ],
  mode: 'base100',
  y0: null,
  y1: null,
});

describe('ViewCrossSource — smoke + default two-series base100', () => {
  it('exposes a sane DEFAULT_CROSS_STATE', () => {
    expect(window.DEFAULT_CROSS_STATE).toBeTruthy();
    expect(window.DEFAULT_CROSS_STATE.series.length).toBe(2);
    expect(window.DEFAULT_CROSS_STATE.mode).toBe('base100');
  });

  it('renders KPIs, the picker, the base100 chart and the metrics + correlation tables', () => {
    const onChange = vi.fn();
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={onChange} />);
    // KPI strip — 2 of 4 series, comparable window label.
    expect(container.querySelector('.kpi[data-label="Séries comparadas"] .kpi-value').textContent).toBe('2 / 4');
    expect(container.querySelector('.kpi[data-label="Janela comparável"] .kpi-value').textContent).toBe('2018–2020');
    // Picker shows the two live bancos; the no-metric banco (PAM) is hidden, the
    // no-data banco (SEFAZ) shows its card but disabled chips.
    expect(container.textContent).toContain('IBGE');
    expect(container.textContent).toContain('MDIC');
    expect(container.textContent).not.toContain('PAM'); // metrics:[] → hidden entirely
    // base100 chart is the active visualization.
    expect(multiLineProps).toBeTruthy();
    expect(multiLineProps.series.length).toBe(2);
    expect(multiLineProps.series[0].data[0].v).toBe(100); // reindexed to 100 at y0
    // Two selected chips are "on".
    expect(container.querySelectorAll('.xs-chip.on').length).toBe(2);
    // Metrics table: one row per series.
    expect(container.querySelectorAll('.pc-table tbody tr').length).toBe(2);
    // Correlation matrix present (≥2 series).
    expect(container.querySelector('.pc-corr')).toBeTruthy();
  });

  it('correlação AUSENTE não derruba a perspectiva — mostra "—"', () => {
    // Reproduzido na tela em 2026-09-08: "ERRO AO RENDERIZAR A PERSPECTIVA — Cannot read
    // properties of null (reading 'toFixed')". A v1.62.0 tornou `pearson` anulável (sem
    // dois pares comparáveis não há correlação) e corrigiu a célula da MATRIZ, neste
    // mesmo arquivo — e deixou o card do topo com `.toFixed`. Corrigir um consumidor sem
    // varrer o arquivo atrás dos outros foi o defeito, não o null.
    window.pearsonByYear = () => null;
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={vi.fn()} />);
    const card = container.querySelector('.kpi[data-label="Correlação (par principal)"] .kpi-value');
    expect(card, 'a perspectiva não renderizou (crash?)').toBeTruthy();
    expect(card.textContent).toBe('—');
    // E a matriz também recusa, sem inventar um "0,00".
    expect(container.textContent).not.toContain('0,00');
  });

  it('falls back to DEFAULT_CROSS_STATE when value is undefined', () => {
    const { container } = render(<ViewCrossSource onChange={vi.fn()} />);
    // Default state has 2 series → "2 / 4".
    expect(container.querySelector('.kpi[data-label="Séries comparadas"] .kpi-value').textContent).toBe('2 / 4');
  });

  it('disables a no-data banco\'s chips and marks them blocked', () => {
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={vi.fn()} />);
    const disabledChips = [...container.querySelectorAll('.xs-chip')].filter((c) => c.disabled);
    // The SEFAZ (planned) metric chip is disabled.
    expect(disabledChips.length).toBeGreaterThanOrEqual(1);
    // Clicking a blocked chip is a no-op (no onChange).
  });
});

describe('ViewCrossSource — selection toggling', () => {
  it('toggling an off chip on adds the series and recomputes the window', () => {
    const onChange = vi.fn();
    // Start with a SINGLE series so an MDIC chip is off and can be toggled on.
    const single = { series: [{ b: 'ibge_pevs', m: 'prod_value' }], mode: 'base100', y0: null, y1: null };
    const { container } = render(<ViewCrossSource value={single} onChange={onChange} />);
    const offChip = [...container.querySelectorAll('.xs-chip:not(.on)')].find((c) => !c.disabled);
    fireEvent.click(offChip);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0];
    expect(next.series.length).toBe(2);   // added a second series
    expect(next.y0).toBeNull();           // window reset on a new selection
  });

  it('removing the last remaining series is refused (keep ≥1)', () => {
    const onChange = vi.fn();
    const single = { series: [{ b: 'ibge_pevs', m: 'prod_value' }], mode: 'base100', y0: null, y1: null };
    const { container } = render(<ViewCrossSource value={single} onChange={onChange} />);
    const onChip = container.querySelector('.xs-chip.on');
    fireEvent.click(onChip); // would drop the only series → guarded no-op
    expect(onChange).not.toHaveBeenCalled();
  });

  it('toggling an active chip off removes it from the selection', () => {
    const onChange = vi.fn();
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={onChange} />);
    const onChip = container.querySelector('.xs-chip.on');
    fireEvent.click(onChip);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].series.length).toBe(1); // one removed
  });
});

describe('ViewCrossSource — visualization modes', () => {
  it('dual-axis mode renders the DualAxisLineChart (≤2 unit families)', () => {
    const state = { ...defaultState(), mode: 'dual' };
    render(<ViewCrossSource value={state} onChange={vi.fn()} />);
    expect(dualAxisProps).toBeTruthy();
    expect(dualAxisProps.series.length).toBe(2);
  });

  it('panels mode renders StackedPanels', () => {
    const state = { ...defaultState(), mode: 'panels' };
    render(<ViewCrossSource value={state} onChange={vi.fn()} />);
    expect(stackedProps).toBeTruthy();
    expect(stackedProps.series.length).toBe(2);
  });

  it('clicking a mode segment requests the mode change', () => {
    const onChange = vi.fn();
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={onChange} />);
    const panelsBtn = [...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Painéis');
    fireEvent.click(panelsBtn);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'panels' }));
  });

  it('the start-year select change requests a new window (y0)', () => {
    const onChange = vi.fn();
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={onChange} />);
    const startSelect = container.querySelectorAll('.xs-select')[0];
    fireEvent.change(startSelect, { target: { value: '2019' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ y0: 2019 }));
  });

  it('the end-year select change requests a new window (y1)', () => {
    const onChange = vi.fn();
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={onChange} />);
    const endSelect = container.querySelectorAll('.xs-select')[1];
    fireEvent.change(endSelect, { target: { value: '2019' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ y1: 2019 }));
  });
});

describe('ViewCrossSource — dual-axis incompatibility (>2 unit families)', () => {
  // Three series in three distinct units → "Eixo duplo" cannot render → disabled + note.
  const threeUnitState = () => ({
    series: [
      { b: 'ibge_pevs', m: 'prod_value' }, // R$ mil
      { b: 'mdic_comex', m: 'exp_value' }, // US$ mil
      { b: 'un_comtrade', m: 'world_qty' }, // kg
    ],
    mode: 'dual',
    y0: null, y1: null,
  });

  it('disables the dual segment and shows the >2-units note when in dual mode', () => {
    const { container } = render(<ViewCrossSource value={threeUnitState()} onChange={vi.fn()} />);
    const dualBtn = [...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Eixo duplo');
    expect(dualBtn.disabled).toBe(true);
    expect(container.textContent).toContain('Eixo duplo comporta 2 unidades');
  });

  it('renders three series in base100 mode with three distinct unit families', () => {
    const state = { ...threeUnitState(), mode: 'base100' };
    const { container } = render(<ViewCrossSource value={state} onChange={vi.fn()} />);
    expect(multiLineProps.series.length).toBe(3);
    // "Famílias de unidade" KPI reflects 2 distinct unit FAMILIES (currency + mass).
    expect(container.textContent).toContain('Famílias de unidade');
  });

  it('shows the COMTRADE "UF não se aplica" note when a UF scope is set with a Comtrade series', () => {
    const { container } = render(<ViewCrossSource value={{ ...threeUnitState(), mode: 'base100' }} onChange={vi.fn()} />);
    const ufPicker = container.querySelector('.uf-picker');
    fireEvent.change(ufPicker, { target: { value: 'PA' } });
    expect(container.textContent).toContain('UN Comtrade');
    expect(container.textContent).toContain('permanecem nacionais');
  });
});

describe('ViewCrossSource — ratio panel (same-unit pair)', () => {
  it('shows the ratio panel + coefficient note when exactly two series share a unit', () => {
    // IBGE prod_value (R$ mil) × MDIC exp_brl (R$ mil) → identical units → ratio eligible.
    const state = {
      series: [{ b: 'ibge_pevs', m: 'prod_value' }, { b: 'mdic_comex', m: 'exp_brl' }],
      mode: 'base100', y0: null, y1: null,
    };
    const { container } = render(<ViewCrossSource value={state} onChange={vi.fn()} />);
    expect(container.textContent).toContain('Razão entre séries');
    expect(container.textContent).toContain('coeficiente de exportação');
    // KPI strip flips to "Razão média (par)" instead of the correlation card.
    expect(container.textContent).toContain('Razão média (par)');
  });

  it('different units → no ratio panel, correlation KPI instead', () => {
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={vi.fn()} />);
    expect(container.textContent).not.toContain('Razão entre séries');
    expect(container.textContent).toContain('Correlação (par principal)');
  });
});

describe('ViewCrossSource — per-UF scope', () => {
  it('selecting a UF re-scopes the series (UfScopePicker onChange)', () => {
    const { container } = render(<ViewCrossSource value={defaultState()} onChange={vi.fn()} />);
    const ufPicker = container.querySelector('.uf-picker');
    fireEvent.change(ufPicker, { target: { value: 'PA' } });
    // Still renders without crashing; the picker reflects the new scope.
    expect(container.querySelector('.uf-picker').value).toBe('PA');
  });
});
