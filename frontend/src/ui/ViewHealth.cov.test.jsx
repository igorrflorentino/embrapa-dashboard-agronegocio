// ViewHealth.cov.test.jsx — coverage smoke + branch tests for the institutional
// "Saúde do sistema" page (ViewHealth.jsx). The page is OPERABILITY-focused (all
// bancos), NOT data-quality: it reads everything off the live backend seam
// (window.dataStore.meta = /api/source-meta provenance + the per-banco Gold query
// status/error) and the banco registry helpers, all stubbed here as plain globals.
// We drive the main branches: the multi-bank KPI strip (status rollup, bancos
// operando, total Gold volume, operational alert count), the per-banco operational
// table (status + Fonte + Período coberto + Linhas), the failure-only alert builder
// (real Gold-query errors → "Falha de consulta"; all-clear empty-state), the sources
// freshness card, and the architecture card (running version + honest run-telemetry
// note). Crucially: NO data-quality chart / integrity alert exists anymore.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// A controllable fake of the dataStore seam the page subscribes to + queries.
function makeStore({ snapshots = {}, metas = {}, statuses = {}, errors = {} } = {}) {
  return {
    subscribe: () => () => {}, // returns an unsubscribe fn (used in a cleanup effect)
    loadMeta: vi.fn(),
    load: vi.fn(),
    get: (id) => snapshots[id] || null,
    meta: (id) => metas[id] || {},
    status: (id) => statuses[id] || 'idle',
    error: (id) => errors[id] || null,
  };
}

// The banco registry the page iterates. Two live bancos + one planned, so the table
// + freshness rows + KPI denominators all have rows to render.
const BANCOS = [
  { id: 'ibge_pevs', short: 'IBGE PEVS', status: 'live', maturity: 'estavel', source: 'IBGE' },
  { id: 'comex', short: 'COMEX', status: 'live', maturity: 'beta', source: 'MDIC · SECEX' },
  { id: 'sefaz', short: 'SEFAZ', status: 'soon', maturity: 'ingestao', source: 'Receita · SEFAZ' },
];

// Two live bancos with real coverage/refresh; one planned with no meta.
function liveMetas() {
  return {
    ibge_pevs: {
      refresh: '2026-06-20',
      source: 'IBGE',
      coverage: { totalRows: 1000, yearStart: 1986, yearEnd: 2024 },
      prov: { lastCrop: 'PEVS 2024' },
    },
    comex: {
      refresh: '2026-06-19',
      source: 'MDIC · SECEX',
      coverage: { totalRows: 500, yearStart: 1997, yearEnd: 2024 },
      prov: { lastCrop: 'COMEX 2024 · M12' },
    },
  };
}

function stubWidgets() {
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.SectionHeader = ({ title, overline, action }) => (
    <div className="sh">
      <span className="sh-overline">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.MaturityTag = ({ banco }) => <span className="mat-tag">{banco?.maturity || '…'}</span>;
  window.MaturityLegend = () => <div className="mat-legend" />;
  window.Icon = ({ name }) => <i className="icon" data-icon={name} />;
}

function stubHelpers(store) {
  window.dataStore = store;
  window.BANCOS = BANCOS;
  window.visibleBancos = () => BANCOS;
  window.maturityMeta = (b) => {
    if (b && (b.maturity === 'estavel' || b.maturity === 'beta')) {
      return { id: b.maturity, hasData: true };
    }
    return { id: b ? b.maturity : 'planejado', hasData: false };
  };
  window.bancoTable = (id) => `gold_${id}`;
  window.fmtRows = (n) => (n == null ? '—' : `${n}`);
  window.auditBancoCoverage = vi.fn();
  window.APP_VERSION = '1.9.0';
}

let ViewHealth;

beforeEach(async () => {
  await import('./ViewHealth.jsx'); // registers window.ViewHealth
  ViewHealth = window.ViewHealth;
});

afterEach(() => cleanup());

describe('ViewHealth — render smoke + operability sections', () => {
  it('renders the operability KPI strip, per-banco table, freshness + architecture cards', () => {
    const store = makeStore({
      metas: liveMetas(),
      statuses: { ibge_pevs: 'ready', comex: 'ready' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);

    // KPI strip — four OPERABILITY cards by label (no PEVS-scoped / quality KPI).
    const labels = [...container.querySelectorAll('.kpi')].map((e) => e.dataset.label);
    expect(labels).toContain('Status geral do sistema');
    expect(labels).toContain('Bancos operando');
    expect(labels).toContain('Volume total na base analítica');
    expect(labels).toContain('Alertas operacionais');

    // The per-banco table renders a row per banco (short label appears).
    expect(container.textContent).toContain('IBGE PEVS');
    expect(container.textContent).toContain('COMEX');
    expect(container.textContent).toContain('SEFAZ');

    // Architecture card: stateless-pushdown prose, honest run-telemetry note, version.
    expect(container.textContent).toContain('Cloud Run');
    expect(container.textContent).toContain('não monitorada');
    expect(container.textContent).toContain('Versão em produção');
    expect(container.textContent).toContain('1.9.0');

    // The mount effects fire the seam loaders for every banco / live banco.
    expect(store.loadMeta).toHaveBeenCalled();
    expect(store.load).toHaveBeenCalled();
  });

  it('has NO data-quality chart or integrity alert (that lives in the Qualidade perspective)', () => {
    // Even with a snapshot qualityTs present, the operability page must ignore it.
    const store = makeStore({
      snapshots: { ibge_pevs: { qualityTs: [{ y: 2023, ok: 0.97 }, { y: 2024, ok: 0.90 }] } },
      metas: liveMetas(),
      statuses: { ibge_pevs: 'ready', comex: 'ready' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    expect(container.querySelector('.line-chart')).toBeNull();
    expect(container.textContent).not.toContain('Qualidade dos dados · histórico');
    expect(container.textContent).not.toContain('% de linhas íntegras');
    expect(container.textContent).not.toContain('Integridade abaixo do padrão');
  });
});

describe('ViewHealth — multi-bank KPI rollups + table columns', () => {
  it('sums Gold rows across live bancos into the Volume KPI', () => {
    const store = makeStore({
      metas: liveMetas(),
      statuses: { ibge_pevs: 'ready', comex: 'ready' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    const vol = container.querySelector('.kpi[data-label="Volume total na base analítica"] .kpi-value');
    expect(vol?.textContent).toBe('1500'); // 1000 + 500 (fmtRows stub → String(n))
    // The 'Bancos operando' KPI reads healthy/live.
    const ok = container.querySelector('.kpi[data-label="Bancos operando"] .kpi-value');
    expect(ok?.textContent).toBe('2 / 2');
  });

  it('renders the Período coberto + Fonte columns from real coverage', () => {
    const store = makeStore({
      metas: liveMetas(),
      statuses: { ibge_pevs: 'ready', comex: 'ready' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    // Per-row coverage span (COMEX 1997–2024, distinct from the system span).
    expect(container.textContent).toContain('1997–2024');
    expect(container.textContent).toContain('1986–2024');
    // Source-system column.
    expect(container.textContent).toContain('MDIC · SECEX');
  });
});

describe('ViewHealth — operational alerts (real query failures only)', () => {
  it('raises a "Falha de consulta" alert + bumps the Alertas KPI when a live banco query errors', () => {
    const store = makeStore({
      metas: liveMetas(),
      statuses: { ibge_pevs: 'error', comex: 'ready' },
      errors: { ibge_pevs: 'boom' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    expect(container.textContent).toContain('Falha de consulta · IBGE PEVS');
    expect(container.textContent).toContain('retornou erro: boom');
    const alertsKpi = container.querySelector('.kpi[data-label="Alertas operacionais"] .kpi-value');
    expect(alertsKpi?.textContent).toBe('1');
    // Overall status pill flips to Falha.
    expect(container.textContent).toContain('Falha');
  });

  it('shows the all-clear empty-state when every live banco responds', () => {
    const store = makeStore({
      metas: liveMetas(),
      statuses: { ibge_pevs: 'ready', comex: 'ready' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    expect(container.textContent).toContain('Nenhuma falha de operação');
    expect(container.textContent).toContain('Todos os bancos em produção responderam');
    expect(container.textContent).not.toContain('Falha de consulta');
    const alertsKpi = container.querySelector('.kpi[data-label="Alertas operacionais"] .kpi-value');
    expect(alertsKpi?.textContent).toBe('0');
  });
});

describe('ViewHealth — overall status from the real Gold query', () => {
  it('reports "Verificando…" when no live banco has responded yet', () => {
    const store = makeStore({
      metas: { ibge_pevs: { refresh: '—', prov: {} } },
      statuses: {}, // both live bancos idle → in-flight
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    expect(container.textContent).toContain('Verificando…');
  });

  it('reports "Falha" overall when a live banco query errored', () => {
    const store = makeStore({
      metas: liveMetas(),
      statuses: { ibge_pevs: 'error', comex: 'ready' },
      errors: { ibge_pevs: 'boom' },
    });
    stubWidgets();
    stubHelpers(store);

    const { container } = render(<ViewHealth summary={{}} />);
    expect(container.textContent).toContain('Falha');
  });
});
