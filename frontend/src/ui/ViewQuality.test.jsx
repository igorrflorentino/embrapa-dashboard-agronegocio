// ViewQuality.test.jsx — render coverage for the data-quality view (H3). It also
// LOCKS the P0 quality-flag taxonomy fix at the render level: the REAL Gold flags
// (incl. INCOMPLETE / MISSING_WEIGHT) must reach both the flag KPI strip and the
// per-product breakdown, and the phantom prototype flags (Estimado/Outlier/…) must
// be gone. We import the real data.js so window.QUALITY_FLAGS is the actual
// registry under test, then stub only the composed window.* widgets.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Capture FlagBars' props so we can assert the per-product breakdown was built
// from the real registry (the columns come from iterating window.QUALITY_FLAGS).
// flagBarsCalls keeps EVERY call (the stock/flow facet renders two FlagBars).
let flagBarsProps;
let flagBarsCalls;

function stubGlobals(filtered) {
  window.applyFilters = () => filtered;
  window.fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
  window.SectionHeader = ({ title, action }) => (
    <div className="sh">
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.LineChart = () => null;
  window.BrazilTileMap = () => null;
  window.StackedArea = () => null;
  window.FlagBars = (props) => {
    flagBarsProps = props;
    flagBarsCalls.push(props);
    return <div className="flagbars" />;
  };
}

let ViewQuality;

beforeEach(async () => {
  flagBarsProps = undefined;
  flagBarsCalls = [];
  await import('./data.js'); // sets window.QUALITY_FLAGS to the REAL Gold flags
  await import('./ViewQuality.jsx'); // registers window.ViewQuality
  ViewQuality = window.ViewQuality;
});

afterEach(() => cleanup());

const FIXTURE = {
  qualityFlags: [
    { id: 'OK', label: 'OK', color: 'var(--ok)', share: 0.8, count: 800000 },
    { id: 'INCOMPLETE', label: 'Incompleto', color: 'var(--viz-7)', share: 0.15, count: 150000 },
    { id: 'MISSING_WEIGHT', label: 'Peso ausente', color: 'var(--viz-4)', share: 0.05, count: 50000 },
  ],
  qualityTs: [{ y: 2020, ok: 0.8, incomplete: 0.15, missing_weight: 0.05 }],
  qualityByProduct: [{ code: 'P1', name: 'Açaí', OK: 0.8, INCOMPLETE: 0.2 }],
  selectedProducts: ['P1'],
  products: [{ code: 'P1', name: 'Açaí' }],
  yearStart: 2010,
  yearEnd: 2020,
};

describe('ViewQuality — renders the REAL Gold quality flags (H3 + P0 lock-in)', () => {
  it('shows INCOMPLETE/MISSING_WEIGHT in the flag KPI strip (not the phantom flags)', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewQuality summary={{}} database="ibge_pevs" />);
    const labels = [...container.querySelectorAll('.qa-flag-label')].map((e) => e.textContent);
    expect(labels).toContain('OK');
    expect(labels).toContain('Incompleto'); // INCOMPLETE — silently dropped before the P0 fix
    expect(labels).toContain('Peso ausente'); // MISSING_WEIGHT — COMEX-only real flag
    expect(labels).not.toContain('Estimado'); // phantom prototype flags are gone
    expect(labels).not.toContain('Outlier');
  });

  it('builds the per-product breakdown from the real registry, keeping INCOMPLETE', () => {
    stubGlobals(FIXTURE);
    render(<ViewQuality summary={{}} database="ibge_pevs" />);
    // The Açaí row's columns are built by iterating window.QUALITY_FLAGS, so
    // INCOMPLETE survives only because the registry now includes it (the P0 fix).
    expect(flagBarsProps).toBeTruthy();
    const row = flagBarsProps.rows[0];
    expect(row).toHaveProperty('INCOMPLETE');
    expect(row.INCOMPLETE).toBeGreaterThan(0);
    expect(row).not.toHaveProperty('OUTLIER'); // phantom flag is not a column
  });

  it('renders an honest empty state when no flags are selected', () => {
    stubGlobals({ ...FIXTURE, qualityFlags: [] });
    const { container } = render(<ViewQuality summary={{}} database="ibge_pevs" />);
    expect(container.textContent).toContain('Nenhuma flag selecionada');
  });

  it('documents the FULL taxonomy (incl. the reserved inferred tiers) in the always-on legend', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewQuality summary={{}} database="ibge_pevs" />);
    const legend = container.querySelector('.qa-flag-legend');
    expect(legend).toBeTruthy();
    // The panel iterates the FULL registry, so a reserved 0-count flag is still explained.
    expect(legend.textContent).toContain('Quantidade inferida');
    expect(legend.textContent).toContain('reservada');
    expect(legend.textContent).toContain('preenchimento automático futuro'); // the desc text
    // one legend item per registered flag (all documented, present or reserved)
    expect(legend.querySelectorAll('.qa-flag-legend-item')).toHaveLength(window.QUALITY_FLAGS.length);
  });

  it('shows the flag descriptions as hover tooltips on the KPI cards', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewQuality summary={{}} database="ibge_pevs" />);
    const card = container.querySelector('.qa-flag-card');
    expect(card.getAttribute('title')).toBeTruthy(); // desc surfaced as native tooltip
  });
});

// PPM carries measure_kind on its products → the per-product quality splits into
// Estoque (herd) vs Fluxo (animal products), which have different flag profiles.
const PPM_FIXTURE = {
  qualityFlags: [
    { id: 'OK', label: 'OK', color: 'var(--ok)', share: 0.85, count: 850000 },
    { id: 'MISSING_QUANTITY', label: 'Quantidade ausente', color: 'var(--viz-4)', share: 0.1, count: 100000 },
    { id: 'MISSING_VALUE', label: 'Valor ausente', color: 'var(--viz-7)', share: 0.05, count: 50000 },
  ],
  qualityTs: [{ y: 2020, ok: 0.85 }],
  qualityByProduct: [
    { code: '2670', name: 'Bovino', OK: 0.95, MISSING_QUANTITY: 0.05 },   // stock (herd)
    { code: '2682', name: 'Leite', OK: 0.8, MISSING_VALUE: 0.2 },          // flow (animal product)
  ],
  selectedProducts: ['2670', '2682'],
  products: [
    { code: '2670', name: 'Bovino', family: 'count', measure_kind: 'stock' },
    { code: '2682', name: 'Leite', family: 'volume', measure_kind: 'flow' },
  ],
  yearStart: 1974,
  yearEnd: 2024,
};

describe('ViewQuality — stock/flow facet for livestock (measure_kind)', () => {
  it('splits the per-product breakdown into Estoque + Fluxo FlagBars groups', () => {
    stubGlobals(PPM_FIXTURE);
    const { container } = render(<ViewQuality summary={{}} database="ibge_ppm" />);
    // Two FlagBars rendered (one per measure_kind group), not one merged list.
    expect(flagBarsCalls).toHaveLength(2);
    const groups = flagBarsCalls.map((c) => c.rows.map((r) => r.name));
    expect(groups).toContainEqual(['Bovino']); // Estoque (stock) group
    expect(groups).toContainEqual(['Leite']);  // Fluxo (flow) group
    expect(container.textContent).toContain('Estoque · efetivo dos rebanhos');
    expect(container.textContent).toContain('Fluxo · produção de origem animal');
  });

  it('falls back to a single FlagBars when the banco has no measure_kind (PEVS)', () => {
    stubGlobals(FIXTURE); // ibge_pevs products carry no measure_kind
    render(<ViewQuality summary={{}} database="ibge_pevs" />);
    expect(flagBarsCalls).toHaveLength(1); // unchanged single-list behaviour
  });
});
