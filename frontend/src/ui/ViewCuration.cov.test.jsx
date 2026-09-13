// ViewCuration.cov.test.jsx — coverage for the FROZEN curation surfaces:
//   • ViewCuration.jsx        → ViewEnrichmentIndustrialization (industrialization editor)
//   • ViewCuratedAnalyses.jsx → ViewValueAdded + ViewMarketNature
// Both feature sets are hidden behind the frozen Curadoria feature but the
// scaffold still renders when reached via stale deep links — so we mount each
// screen and drive its main branches (grouping toggle, todo rows, the apply-bar
// states, the matrix, the empty/populated analysis states).
//
// Strategy mirrors the existing view tests: stub the composed window.* widgets +
// formatters, then provide a controllable fake window.enrichment / the two cross
// analyses, then import the JSX (which registers the views on window) and render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
// The REAL note (window.NominalSeriesNote) the value-added chart renders.
import './MonetaryNotes.jsx';

// ── shared widget/formatter stubs ─────────────────────────────────────────────
function stubWidgets() {
  window.Icon = ({ name }) => <i data-icon={name} />;
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{error}</div> : null);
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh">
      <span className="sh-overline">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.StackedArea = () => <div className="stacked-area" />;
  window.MultiLineChart = () => <div className="multiline" />;
  window.LineChart = () => <div className="linechart" />;
  window.Donut = () => <div className="donut" />;
  window.UfScopePicker = ({ value, onChange }) => (
    <button className="uf-picker" onClick={() => onChange('PA')}>
      uf:{value || 'BR'}
    </button>
  );
  window.bancoById = (id) => ({ short: id === 'ibge_pevs' ? 'PEVS' : 'COMEX' });
  // pt-BR formatters used by ViewCuratedAnalyses.
  window.numBR = (v, d = 0) => Number(v || 0).toFixed(d);
  window.pctBR = (v) => `${Math.round(v || 0)}%`;
  window.fmtSigned = (v, d = 1, suffix = '') => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}${suffix}`;
}

// ── static enrichment registries (mirror data/enrichment.js) ──────────────────
function stubRegistries() {
  window.ENRICH_LEVELS = [
    { id: 'commodity_pura', label: 'Commodity Pura', color: 'var(--viz-3)', description: 'Produto em estado original.' },
    { id: 'commodity_acondicionada', label: 'Commodity Acondicionada', color: 'var(--viz-2)', description: 'Produto acondicionado.' },
    { id: 'manufaturado_industrial', label: 'Manufaturado Industrial', color: 'var(--viz-1)', description: 'Produto manufaturado.' },
  ];
  window.ENRICH_MARKETS = [
    { id: 'consumo', label: 'Consumo', short: 'Consumo', color: 'var(--viz-1)' },
    { id: 'processamento', label: 'Processamento', short: 'Processamento', color: 'var(--viz-9)' },
  ];
  window.ENRICH_GROUPS = [
    { id: 'acai', label: 'Açaí' },
    { id: 'madeira', label: 'Madeira' },
  ];
}

// A controllable fake enrichment store. `over` patches any method so individual
// tests can drive the apply-bar states (committing / pending / error) etc.
function fakeEnrichment(over = {}) {
  const codes = [
    { id: 'ibge_pevs:1.1', group: 'acai', source: 'ibge_pevs', code: '1.1', desc: 'Açaí', level: 'commodity_pura' },
    { id: 'ibge_pevs:1.2', group: 'acai', source: 'ibge_pevs', code: '1.2', desc: 'Açaí proc.', level: '' }, // todo
    { id: 'mdic_comex:4407', group: 'madeira', source: 'mdic_comex', code: '4407', desc: 'Madeira', level: 'manufaturado_industrial' },
  ];
  // regime × flow matrix fixtures (flow ids are the NORMALIZED tokens the mart exposes).
  const regimes = [
    { id: 'C03', term: 'Exportação definitiva (C03)', label: 'Exportação definitiva (C03)', hint: 'saída definitiva.' },
    { id: 'C04', term: 'Entreposto aduaneiro (C04)', label: 'Entreposto aduaneiro (C04)', hint: 'armazenada.' },
  ];
  const flowTypes = [
    { id: 'import', term: 'Importação (import)', label: 'Importação (import)', hint: 'entrada.' },
    { id: 'export', term: 'Exportação (export)', label: 'Exportação (export)', hint: 'saída.' },
  ];
  const base = {
    codes: () => codes,
    worklist: () => codes,
    stats: () => ({
      codesTotal: 3,
      unclassified: 1,
      byLevel: { commodity_pura: 1, commodity_acondicionada: 0, manufaturado_industrial: 1 },
      flowsTotal: 4,
      flowsClassified: 1,
    }),
    levelDesc: (id) => (window.ENRICH_LEVELS.find((l) => l.id === id) || {}).description || '',
    chapterOf: (src, code) => (src === 'ibge_pevs' ? 'Produtos alimentícios' : '44 · Madeira'),
    setCode: vi.fn(),
    // matrix accessors
    regimes: () => regimes,
    flowTypes: () => flowTypes,
    pairMarket: (c, f) => (c === 'C04' && f === 'import' ? 'consumo' : null),
    pairValueLabel: (c, f) => (c === 'C03' && f === 'export' ? 'US$ 3 bi' : ''),
    setPair: vi.fn(),
    apply: vi.fn((cb) => cb && cb()),
    discard: vi.fn(),
    isCommitting: () => false,
    pendingCount: () => 0,
    lastError: () => null,
    subscribe: () => () => {},
  };
  window.enrichment = { ...base, ...over };
  return window.enrichment;
}

let viewsLoaded = false;
async function loadViews() {
  if (!viewsLoaded) {
    await import('./ViewCuration.jsx'); // registers ViewEnrichment{Industrialization,MarketNature}
    await import('./ViewCuratedAnalyses.jsx'); // registers ViewValueAdded + ViewMarketNature
    viewsLoaded = true;
  }
}

beforeEach(async () => {
  stubWidgets();
  stubRegistries();
  fakeEnrichment();
  await loadViews();
});

afterEach(() => cleanup());

// ── ViewEnrichmentIndustrialization (the codes worklist) ──────────────────────
describe('ViewEnrichmentIndustrialization', () => {
  it('renders the KPI strip + codes table grouped by commodity (default)', () => {
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    // KPIs from stats()
    const kpi = (l) => container.querySelector(`.kpi[data-label="${l}"] .kpi-value`)?.textContent;
    expect(kpi('Total de códigos')).toBe('3');
    expect(kpi('A classificar')).toBe('1');
    expect(kpi('Classificados')).toBe('2');
    expect(kpi('Níveis usados')).toBe('2'); // commodity_pura + manufaturado_industrial
    // commodity group header + a "a classificar" todo pill on the level-less row
    expect(container.textContent).toContain('Açaí');
    expect(container.textContent).toContain('a classificar');
    // a level <select> exists per code row
    expect(container.querySelectorAll('select.cur-level').length).toBe(3);
  });

  it('switches to grouping by banco (chapters) and exercises chapterOf', () => {
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    const bancoBtn = [...container.querySelectorAll('button.seg-opt')].find((b) =>
      b.textContent.includes('Banco')
    );
    fireEvent.click(bancoBtn);
    // chapter rows from chapterOf are now present
    expect(container.textContent).toContain('Produtos alimentícios');
    expect(container.textContent).toContain('Madeira');
  });

  it('a level <select> change calls enrichment.setCode', () => {
    const setCode = vi.fn();
    fakeEnrichment({ setCode });
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    const sel = container.querySelector('select.cur-level');
    fireEvent.change(sel, { target: { value: 'manufaturado_industrial' } });
    expect(setCode).toHaveBeenCalledWith('ibge_pevs:1.1', { level: 'manufaturado_industrial' });
  });
});

// ── EnrichmentApplyBar states (driven through the industrialization screen) ────
describe('EnrichmentApplyBar states', () => {
  it('shows the clean "em sincronia" state when there are no pending edits', () => {
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    expect(container.textContent).toContain('em sincronia');
    // Apply button is disabled with nothing pending.
    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Aplicar à base'));
    expect(applyBtn.disabled).toBe(true);
  });

  it('shows the dirty state + Descartar when edits are pending, and apply()/discard() fire', () => {
    const apply = vi.fn((cb) => cb && cb());
    const discard = vi.fn();
    fakeEnrichment({ pendingCount: () => 2, apply, discard });
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    expect(container.textContent).toContain('alterações não aplicadas');
    const discardBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Descartar');
    fireEvent.click(discardBtn);
    expect(discard).toHaveBeenCalled();
    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Aplicar à base'));
    expect(applyBtn.disabled).toBe(false);
    fireEvent.click(applyBtn);
    expect(apply).toHaveBeenCalled();
  });

  it('flips to the "Aplicado à base" done banner after a successful apply', () => {
    // pending=2 enables the apply button; once apply()'s callback fires, the staged
    // edits have landed so pendingCount drops to 0 — now the justApplied branch wins.
    let applied = false;
    const apply = vi.fn((cb) => {
      applied = true; // the commit "lands"
      cb && cb(); // setJustApplied(true) + the 2.8s reset timer
    });
    fakeEnrichment({ pendingCount: () => (applied ? 0 : 2), apply });
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    const applyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Aplicar à base'));
    fireEvent.click(applyBtn);
    expect(apply).toHaveBeenCalled();
    expect(container.textContent).toContain('Aplicado à base'); // the justApplied done banner
  });

  it('shows the singular wording for exactly one pending edit', () => {
    fakeEnrichment({ pendingCount: () => 1 });
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    expect(container.textContent).toContain('alteração não aplicada');
  });

  it('renders the committing spinner state', () => {
    fakeEnrichment({ isCommitting: () => true, pendingCount: () => 2 });
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    expect(container.textContent).toContain('Salvando suas classificações');
    expect(container.querySelector('.cur-spinner')).toBeTruthy();
  });

  it('surfaces a write error banner from lastError()', () => {
    fakeEnrichment({ lastError: () => 'HTTP 401', pendingCount: () => 1 });
    const { container } = render(<window.ViewEnrichmentIndustrialization />);
    const alert = container.querySelector('.cur-write-error');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('HTTP 401');
  });
});

// ── ViewEnrichmentMarketNature (the regime × flow matrix editor) ──────────────
describe('ViewEnrichmentMarketNature', () => {
  it('renders the matrix with regime rows, flow columns + per-cell values', () => {
    const { container } = render(<window.ViewEnrichmentMarketNature />);
    // matrix legend uses ENRICH_MARKETS shorts
    expect(container.textContent).toContain('Consumo');
    expect(container.textContent).toContain('Processamento');
    // regime/flow header terms + the per-pair value label (materiality)
    expect(container.textContent).toContain('Exportação definitiva (C03)');
    expect(container.textContent).toContain('Importação (import)');
    expect(container.textContent).toContain('US$ 3 bi');
    // 2 regimes × 2 flows = 4 cell selects
    expect(container.querySelectorAll('select.cur-cell').length).toBe(4);
  });

  it('a matrix cell change calls enrichment.setPair with the chosen market', () => {
    const setPair = vi.fn();
    fakeEnrichment({ setPair });
    const { container } = render(<window.ViewEnrichmentMarketNature />);
    fireEvent.change(container.querySelector('select.cur-cell'), { target: { value: 'consumo' } });
    expect(setPair).toHaveBeenCalled();
    expect(setPair.mock.calls[0][2]).toBe('consumo');
  });

  it('the CurHint fast-tooltip machinery fires on hover (enter/move/leave)', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<window.ViewEnrichmentMarketNature />);
      const hint = container.querySelector('.cur-hashint').closest('th, td');
      fireEvent.mouseEnter(hint, { clientX: 10, clientY: 10 });
      vi.advanceTimersByTime(120);
      const tip = document.querySelector('.cur-tip-pop');
      expect(tip).toBeTruthy();
      expect(tip.classList.contains('on')).toBe(true);
      fireEvent.mouseMove(hint, { clientX: 600, clientY: 400 });
      fireEvent.mouseLeave(hint);
      expect(tip.classList.contains('on')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── ViewValueAdded (curated analysis powered by the enrichment layer) ─────────
function valueAddedData(over = {}) {
  const levels = ['commodity_pura', 'manufaturado_industrial']; // ordinal order
  const series = [
    {
      y: 2019,
      levels: {
        commodity_pura: { v: 7, w: 70, price: 0.1 },
        manufaturado_industrial: { v: 3, w: 10, price: 0.3 },
      },
      totalV: 10,
      totalW: 80,
    },
    {
      y: 2020,
      levels: {
        commodity_pura: { v: 8, w: 72, price: 0.11 },
        manufaturado_industrial: { v: 4, w: 11, price: 0.36 },
      },
      totalV: 12,
      totalW: 83,
    },
  ];
  return {
    series,
    levels,
    byLevel: {
      commodity_pura: [{ y: 2019, v: 7 }, { y: 2020, v: 8 }],
      manufaturado_industrial: [{ y: 2019, v: 3 }, { y: 2020, v: 4 }],
    },
    byLevelWeight: {
      commodity_pura: [{ y: 2019, v: 70 }, { y: 2020, v: 72 }],
      manufaturado_industrial: [{ y: 2019, v: 10 }, { y: 2020, v: 11 }],
    },
    byLevelPrice: {
      commodity_pura: [{ y: 2019, v: 0.1 }, { y: 2020, v: 0.11 }],
      manufaturado_industrial: [{ y: 2019, v: 0.3 }, { y: 2020, v: 0.36 }],
    },
    premium: 3.3,
    predominant: { level: 'commodity_pura', shareV: 66.7 },
    nCodes: 5,
    ...over,
  };
}

describe('ViewValueAdded', () => {
  it('renders the per-level chart stack + KPIs when codes are classified', () => {
    window.valueAddedAnalysis = vi.fn(() => valueAddedData());
    const { container } = render(<window.ViewValueAdded />);
    expect(window.valueAddedAnalysis).toHaveBeenCalled();
    // commodity chips (Todas curadas + ENRICH_GROUPS)
    expect(container.textContent).toContain('Todas curadas');
    expect(container.textContent).toContain('Açaí');
    // KPI: códigos na análise = nCodes; níveis presentes = levels.length
    expect(container.querySelector('.kpi[data-label="Códigos na análise"] .kpi-value')?.textContent).toBe('5');
    expect(container.querySelector('.kpi[data-label="Níveis presentes"] .kpi-value')?.textContent).toBe('2');
    // value + volume stacked areas + the per-level price multiline (nCodes >= 1)
    expect(container.querySelectorAll('.stacked-area').length).toBe(2); // value + weight
    expect(container.querySelector('.multiline')).toBeTruthy(); // price per level
    // the old binary "% processado" line chart is gone (gradient replaces it)
    expect(container.querySelector('.linechart')).toBeFalsy();
  });

  it('selecting a commodity chip + the UF picker re-queries valueAddedAnalysis', () => {
    const fn = vi.fn(() => valueAddedData());
    window.valueAddedAnalysis = fn;
    const { container } = render(<window.ViewValueAdded />);
    // pick a commodity group chip
    const chip = [...container.querySelectorAll('button.pp-chip')].find((b) => b.textContent === 'Açaí');
    fireEvent.click(chip);
    // pick a UF via the stubbed picker (calls onChange('PA'))
    fireEvent.click(container.querySelector('button.uf-picker'));
    // re-rendered with group + uf scoping
    const lastCall = fn.mock.calls[fn.mock.calls.length - 1];
    expect(lastCall[0]).toBe('acai');
    expect(lastCall[1]).toEqual(['PA']);
  });

  it('shows the honest empty state when no codes are classified (nCodes < 1)', () => {
    window.valueAddedAnalysis = vi.fn(() =>
      valueAddedData({ nCodes: 0, levels: [], byLevel: {}, byLevelWeight: {}, byLevelPrice: {} })
    );
    const { container } = render(<window.ViewValueAdded />);
    expect(container.textContent).toContain('Nenhum código classificado incluído');
    // the secondary charts are suppressed when nCodes < 1
    expect(container.querySelector('.multiline')).toBeFalsy();
  });
});

// ── ViewMarketNature (curated economic-purpose analysis) ──────────────────────
describe('ViewMarketNature (curated analysis)', () => {
  it('renders the honest empty state when the series is empty (no classified pair)', () => {
    window.marketNatureAnalysis = vi.fn(() => ({ series: [] }));
    const { container } = render(<window.ViewMarketNature />);
    expect(container.textContent).toContain('Sem finalidade econômica classificada');
    expect(container.textContent).toContain('Tipo de Mercado');
    // selector still renders
    expect(container.textContent).toContain('Todas curadas');
  });

  it('renders KPIs + stacked area + donut when classified series exist', () => {
    window.marketNatureAnalysis = vi.fn(() => ({
      series: [
        { y: 2019, consumo: 4, processamento: 1 },
        { y: 2020, consumo: 6, processamento: 2 },
      ],
      latest: { y: 2020, consumo: 6, processamento: 2 },
    }));
    const { container } = render(<window.ViewMarketNature />);
    // one KPI per market + the janela KPI
    const labels = [...container.querySelectorAll('.kpi[data-label]')].map((e) => e.getAttribute('data-label'));
    expect(labels).toContain('Consumo');
    expect(labels).toContain('Processamento');
    expect(labels).toContain('Janela');
    // window KPI shows the year span
    expect(container.querySelector('.kpi[data-label="Janela"] .kpi-value')?.textContent).toBe('2019–2020');
    // the area chart + donut are rendered
    expect(container.querySelector('.stacked-area')).toBeTruthy();
    expect(container.querySelector('.donut')).toBeTruthy();
  });

  it('selecting a commodity chip re-queries marketNatureAnalysis with the group', () => {
    const fn = vi.fn(() => ({ series: [] }));
    window.marketNatureAnalysis = fn;
    const { container } = render(<window.ViewMarketNature />);
    const chip = [...container.querySelectorAll('button.pp-chip')].find((b) => b.textContent === 'Madeira');
    fireEvent.click(chip);
    const lastCall = fn.mock.calls[fn.mock.calls.length - 1];
    expect(lastCall[0]).toBe('madeira');
  });
});
