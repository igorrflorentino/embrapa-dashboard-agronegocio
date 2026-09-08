// ViewRebanho.test.jsx — render coverage for the herd (efetivo) perspective. It LOCKS
// the keystone contract at the view level: the herd is built from STOCK products only
// (measure_kind='stock'), the composition/evolution are cabeças-only (count family),
// and animal-product FLOWS (eggs/milk) are excluded from the efetivo. We import the
// real data.js + MetricConventions.jsx so countQtyMul/formatCountQty (and UNIT_FAMILIES
// 'count') are the actual code under test, then stub only the composed widgets.
//
// ViewRebanho uses React hooks via the GLOBAL `React` (the prototype convention —
// main.jsx sets window.React in the app). Tests aren't booted through main.jsx, so we
// set it here BEFORE importing the view (the top-level `const { useState } = React`
// runs at import time).

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let donutProps, multiLineProps;

function stubGlobals(filtered) {
  window.applyFilters = () => filtered;
  window.fmtSigned = (x) => (x >= 0 ? '+' : '') + Math.round(x) + '%';
  window.SectionHeader = ({ overline, title }) => (
    <div className="sh"><span className="sh-ov">{overline}</span><span className="sh-title">{title}</span></div>
  );
  window.EmptyCard = ({ children }) => <div className="card subtle">{children}</div>;
  window.UnitFamilyTag = ({ family }) => <span className="uft">{family}</span>;
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi"><span className="kpi-label">{label}</span><span className="kpi-value">{value}</span><span className="kpi-sub">{sub}</span></div>
  );
  window.Donut = (props) => { donutProps = props; return <div className="donut" />; };
  window.MultiLineChart = (props) => { multiLineProps = props; return <div className="mlc" />; };
  window.BrazilTileMap = () => <div className="tilemap" />;
}

let ViewRebanho;

beforeEach(async () => {
  donutProps = undefined; multiLineProps = undefined;
  // The view's `const { useState } = React` runs at import time → React must be global first.
  globalThis.React = React;
  window.React = React;
  await import('./data.js');             // UNIT_FAMILIES['count'], UF_DATA tile grid
  await import('./MetricConventions.jsx'); // DEFAULT_CONVENTIONS, countQtyMul, formatCountQty
  await import('./ViewRebanho.jsx');     // registers window.ViewRebanho
  ViewRebanho = window.ViewRebanho;
  // jsdom has no fetch; the per-UF map effect calls /api/product-uf.
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ uf: [] }) }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Bovino (234 mi cab) + Suíno (42) are STOCK herds; Ovos de galinha is a count FLOW
// (has value) and must NOT count as part of the efetivo.
const FIXTURE = {
  products: [
    { code: '2670', name: 'Bovino', family: 'count', unit: 'un', measure_kind: 'stock' },
    { code: '2675', name: 'Suíno', family: 'count', unit: 'un', measure_kind: 'stock' },
    { code: '2685', name: 'Ovos de galinha', family: 'count', unit: 'un', measure_kind: 'flow' },
  ],
  selectedProducts: ['2670', '2675', '2685'],
  allProductTS: {
    '2670': [{ y: 2020, v: 0, q: 200, family: 'count' }, { y: 2021, v: 0, q: 234, family: 'count' }],
    '2675': [{ y: 2020, v: 0, q: 40, family: 'count' }, { y: 2021, v: 0, q: 42, family: 'count' }],
    '2685': [{ y: 2020, v: 5, q: 50, family: 'count' }, { y: 2021, v: 6, q: 55, family: 'count' }],
  },
  ufDataFull: [{ uf: 'MT', value: 0, real: true }],
  yearStart: 2020,
  yearEnd: 2021,
};

describe('ViewRebanho — the herd (efetivo) perspective', () => {
  const conv = () => window.DEFAULT_CONVENTIONS;

  it('lists ONLY stock species in the focus selector (the egg FLOW is excluded)', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    const chips = [...container.querySelectorAll('.pp-chip')].map(e => e.textContent);
    expect(chips.some(t => t.includes('Bovino'))).toBe(true);
    expect(chips.some(t => t.includes('Suíno'))).toBe(true);
    expect(chips.some(t => t.includes('Ovos'))).toBe(false); // measure_kind='flow' → not herd
  });

  it('builds the composition donut from the stock species only, shares summing to 1', () => {
    stubGlobals(FIXTURE);
    render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    expect(donutProps).toBeTruthy();
    const names = donutProps.data.map(d => d.name);
    expect(names).toEqual(expect.arrayContaining(['Bovino', 'Suíno']));
    expect(names).not.toContain('Ovos de galinha');
    const total = donutProps.data.reduce((s, d) => s + d.share, 0);
    expect(total).toBeCloseTo(1, 5);
    // Bovino (234) dominates Suíno (42)
    expect(donutProps.data[0].name).toBe('Bovino');
  });

  it('the 50-year evolution has ONE line per stock species (never stacked/summed)', () => {
    stubGlobals(FIXTURE);
    render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    expect(multiLineProps).toBeTruthy();
    expect(multiLineProps.series.map(s => s.name)).toEqual(['Bovino', 'Suíno']);
    // each series carries absolute cabeças (q × 1e6), e.g. Bovino 2021 = 234e6
    const bov = multiLineProps.series.find(s => s.name === 'Bovino');
    expect(bov.data[bov.data.length - 1].v).toBeCloseTo(234e6, 0);
  });

  it('defaults focus to the largest herd (Bovino) and shows its efetivo headcount KPI', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    expect(container.textContent).toContain('Efetivo · Bovino');
    expect(container.textContent).toMatch(/234/); // 234e6 head, pt-BR formatted
  });

  it('período FORA da cobertura não vira "0 cabeças" nem um pico de zero', () => {
    // Medido na tela em 2026-09-08 com a janela em 1950–1960 (a PPM começa em 1974):
    // "Efetivo = 0 un", "Pico histórico = 0 un em 1960" e "Espécies no efetivo = 8" —
    // três afirmações sobre um período que a pesquisa não cobre. O rebanho não é zero
    // ali, é desconhecido; e contar espécies "no efetivo" de um período sem dado nomeia
    // uma coisa e conta outra.
    stubGlobals({ ...FIXTURE, yearStart: 1950, yearEnd: 1960 });
    const { container } = render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    expect(container.textContent).not.toMatch(/Efetivo · Bovino[\s\S]{0,40}\b0\b/);
    expect(container.textContent).not.toContain('Pico histórico');
    // Sem espécie com ponto na janela, a view cai no estado vazio honesto.
    expect(container.textContent).toContain('Nenhum rebanho');
  });

  it('renders an honest empty state when the basket has no stock species', () => {
    stubGlobals({
      ...FIXTURE,
      products: [{ code: '2685', name: 'Ovos de galinha', family: 'count', unit: 'un', measure_kind: 'flow' }],
      selectedProducts: ['2685'],
    });
    const { container } = render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    expect(container.textContent).toContain('Nenhum rebanho');
  });
});
