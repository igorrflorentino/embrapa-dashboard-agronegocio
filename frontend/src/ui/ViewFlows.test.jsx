// ViewFlows.test.jsx — the flow KPI magnitude formatter. The CONTRACT (serialize_flow)
// ships link/node values already in MILLIONS of `unit` — Acre → Peru arrives as 77,65.
// The earlier fix (M9) replaced a ÷1000 heuristic with window.autoScaleNum but fed it that
// millions figure as if it were raw US$, so 77,65 mi rendered "US$ 77,6" and a national
// 50.000 mi total "US$ 50 mil". Its fixtures were raw US$, which is why it passed. The
// view now converts back (× 1e6) before scaling; the fixtures below are in the contract's
// unit, as the API really sends them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
// The REAL note the view renders under the diagram (window.ValueGapNote).
import './MonetaryNotes.jsx';

// The ui-side shared magnitude helper the migrated views use (same thresholds as
// charts/magnitude.js magnitudeParts, which window.autoScaleNum is bound to).
function autoScaleNum(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return { factor: 1e9, suffix: 'bi' };
  if (a >= 1e6) return { factor: 1e6, suffix: 'mi' };
  if (a >= 1e3) return { factor: 1e3, suffix: 'mil' };
  return { factor: 1, suffix: '' };
}

// Minimal stand-ins for the window.* components ViewFlows composes. KpiCardSpark
// renders its `value` (the fmt output) into the DOM so we can assert on it.
function stubProtoGlobals(flow) {
  window.autoScaleNum = autoScaleNum;
  window.bancoById = () => ({ scope: 'País', domain: 'Comércio' });
  window.flowData = () => flow;
  window.NotApplicableNote = () => null;
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{error}</div> : null);
  window.SankeyChart = () => null;
  window.SectionHeader = () => null;
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

let ViewFlows;

beforeEach(async () => {
  await import('./ViewFlows.jsx'); // registers window.ViewFlows
  ViewFlows = window.ViewFlows;
});

afterEach(() => cleanup());

const total = (container) =>
  container.querySelector('.kpi[data-label="Fluxo total"] .kpi-value').textContent;

describe('ViewFlows fmt — the contract ships millions, and the label must say so', () => {
  it('labels a billions-scale flow as "bi"', () => {
    // Two origins → one dest; total = 3.400 mi = US$ 3,4 bi.
    stubProtoGlobals({
      unit: 'US$',
      originLabel: 'UF de origem',
      destLabel: 'País de destino',
      nodes: [
        { id: 'o0', label: 'PA', side: 'origin', value: 2400 },
        { id: 'o1', label: 'SP', side: 'origin', value: 1000 },
        { id: 'd0', label: 'China', side: 'dest', value: 3400 },
      ],
      links: [
        { source: 'o0', target: 'd0', value: 2400 },
        { source: 'o1', target: 'd0', value: 1000 },
      ],
    });
    const { container } = render(<ViewFlows summary={{}} conventions={{}} database="mdic_comex" />);
    expect(total(container)).toBe('US$ 3,4 bi');
  });

  it('labels a millions-scale flow as "mi" — the Acre → Peru case', () => {
    // ÂNCORA EXTERNA, medida em produção 2026-09-12: serialize_flow entrega 77,6481 para
    // Acre → Peru (castanha-do-pará, US$ nominal, 1997–2026). A tela mostrava "US$ 77,6".
    stubProtoGlobals({
      unit: 'US$',
      originLabel: 'UF',
      destLabel: 'País',
      nodes: [{ id: 'o0', label: 'Acre', side: 'origin', value: 77.6481 },
        { id: 'd0', label: 'Peru', side: 'dest', value: 77.6481 }],
      links: [{ source: 'o0', target: 'd0', value: 77.6481 }],
    });
    const { container } = render(<ViewFlows summary={{}} conventions={{}} database="mdic_comex" />);
    expect(total(container)).toBe('US$ 77,6 mi');
  });

  it('a sub-thousand-dollar flow carries no magnitude suffix (no fabricated " mi")', () => {
    // 0,000042 mi = US$ 42.
    stubProtoGlobals({
      unit: 'US$',
      originLabel: 'UF',
      destLabel: 'País',
      nodes: [{ id: 'o0', label: 'AC', side: 'origin', value: 0.000042 },
        { id: 'd0', label: 'Peru', side: 'dest', value: 0.000042 }],
      links: [{ source: 'o0', target: 'd0', value: 0.000042 }],
    });
    const { container } = render(<ViewFlows summary={{}} conventions={{}} database="mdic_comex" />);
    expect(total(container)).toBe('US$ 42');
  });
});

describe('ViewFlows — a convenção que o número carrega', () => {
  // Até a v1.77.0 o Sankey somava US$ nominal sob qualquer escolha da faixa de
  // convenções, e o canto do diagrama dizia só "US$".
  it('mostra valueLabel no diagrama e formata na moeda do servidor', () => {
    stubProtoGlobals({
      unit: 'R$',
      valueLabel: 'Valor real (IPCA) — R$ · FOB',
      originLabel: 'UF',
      destLabel: 'País',
      nodes: [{ id: 'o0', label: 'AC', side: 'origin', value: 5 },
        { id: 'd0', label: 'Peru', side: 'dest', value: 5 }],
      links: [{ source: 'o0', target: 'd0', value: 5 }],
    });
    window.SectionHeader = ({ action }) => <div className="sh-action">{action}</div>;
    const { container } = render(<ViewFlows summary={{}} conventions={{}} database="mdic_comex" />);
    expect(container.querySelector('.flow-valuation').textContent)
      .toBe('Valor real (IPCA) — R$ · FOB');
    expect(total(container)).toBe('R$ 5 mi');
  });
});

describe('ViewFlows — os anos que a convenção não alcança', () => {
  it('nomeia os anos fora da soma logo abaixo do título do diagrama', () => {
    window.fmtPct = (n, d = 1) => (n * 100).toFixed(d).replace('.', ',') + '%';
    stubProtoGlobals({
      unit: '€',
      valueLabel: 'Valor nominal — € · FOB',
      valueGap: { years: [1997, 1998], share: 0.0054 },
      originLabel: 'UF',
      destLabel: 'País',
      nodes: [{ id: 'o0', label: 'AC', side: 'origin', value: 67.75 },
        { id: 'd0', label: 'Peru', side: 'dest', value: 67.75 }],
      links: [{ source: 'o0', target: 'd0', value: 67.75 }],
    });
    const { container } = render(<ViewFlows summary={{}} conventions={{}} database="mdic_comex" />);
    const nota = container.querySelector('.value-gap-note').textContent;
    expect(nota).toContain('Sem valor nesta convenção em 1997–1998');
    expect(nota).toContain('fora da soma');
  });
});
