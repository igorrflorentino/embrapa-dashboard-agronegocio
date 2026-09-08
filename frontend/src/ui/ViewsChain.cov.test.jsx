// ViewsChain.cov.test.jsx — render coverage for the two EXTENDED multi-source views:
//   · ViewChainBalance — the PEVS→SEFAZ→MDIC→Comtrade supply balance (Sankey + world slice)
//   · ViewHarvestLag   — harvest (modeled monthly) vs shipments, with the ±6-month lag bars
// Both read data-blocked producers (window.chainBalance / harvestShipmentLag) that today
// return `preview:true` shells, so the views render a PreviewBanner over demonstration
// values. Following the ViewProductCompare/ViewRebanho .cov pattern we stub every window.*
// dependency to drive both the preview branch and a non-preview (hypothetical real-data)
// branch.
//
// IMPORTANT: ViewsChain binds `chNum = window.numBR` / `chPct = window.pctBR` and the
// `useChState = React` hook at MODULE-LOAD time, so those globals (and React) must exist
// BEFORE the dynamic import.

import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const numBR = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
const pctBR = (v) => (v == null ? '—' : Number(v).toFixed(1) + '%');

let previewBannerProps, sankeyProps, monthlyProps, lagBarsProps;

function stubWidgets() {
  previewBannerProps = undefined; sankeyProps = undefined;
  monthlyProps = undefined; lagBarsProps = undefined;

  window.PreviewBanner = (props) => { previewBannerProps = props; return <div className="preview-banner" />; };
  window.CrossProductPicker = ({ value, onChange }) => (
    <select className="pp" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Todos os agrupamentos</option>
      <option value="acai">Açaí</option>
    </select>
  );
  window.crossPreviewBanco = (view) => ({ short: 'SEFAZ', view });
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
  window.SankeyChart = (props) => { sankeyProps = props; return <div className="sankey" />; };
  window.MonthlyOverlay = (props) => { monthlyProps = props; return <div className="monthly" />; };
  window.LagBars = (props) => { lagBarsProps = props; return <div className="lagbars" />; };
}

let ViewChainBalance, ViewHarvestLag;

beforeAll(async () => {
  globalThis.React = React;
  window.React = React;
  window.numBR = numBR;
  window.pctBR = pctBR;
  await import('./ViewsChain.jsx');
  ({ ViewChainBalance, ViewHarvestLag } = window);
});

beforeEach(() => { stubWidgets(); });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── ViewChainBalance ──────────────────────────────────────────────────────────
describe('ViewChainBalance', () => {
  function balance(overrides = {}) {
    return {
      preview: false,
      unit: 'mil t', year: 2024,
      produced: 1000, exported: 300, internal: 200, domestic: 500,
      expFrac: 0.3, intFrac: 0.2, domFrac: 0.5,
      worldShare: 6.5, worldTotal: 40, exportUsd: 2.6,
      sankey: {
        nodes: [{ id: 'prod', label: 'Produção' }, { id: 'exp', label: 'Exportado' }],
        links: [{ source: 'prod', target: 'exp', value: 300 }],
      },
      ...overrides,
    };
  }

  it('renders KPIs, the Sankey and the world-share bar (non-preview real data)', () => {
    window.chainBalance = () => balance();
    const { container } = render(<ViewChainBalance view="cross_chain" />);
    expect(container.querySelector('.sankey')).toBeTruthy();
    expect(sankeyProps.nodes.length).toBe(2);
    expect(container.textContent).toContain('Produção');
    expect(container.textContent).toContain('Exportado');
    expect(container.textContent).toContain('Fatia no mundo');
    // The world-share fill width reflects the share.
    expect(container.querySelector('.ch-world-fill')).toBeTruthy();
    // No preview banner when preview:false.
    expect(previewBannerProps).toBeUndefined();
    expect(container.querySelector('.preview-banner')).toBeFalsy();
  });

  it('shows the demonstration PreviewBanner when the producer is data-blocked (preview:true)', () => {
    window.chainBalance = () => balance({ preview: true });
    const { container } = render(<ViewChainBalance view="cross_chain" />);
    expect(container.querySelector('.preview-banner')).toBeTruthy();
    expect(previewBannerProps).toBeTruthy();
    expect(previewBannerProps.banco.short).toBe('SEFAZ');
    expect(previewBannerProps.capabilityNote).toContain('demonstração');
  });

  it('changing the year select re-queries the balance', () => {
    const years = [];
    window.chainBalance = (_code, year) => { years.push(year); return balance(); };
    const { container } = render(<ViewChainBalance view="cross_chain" />);
    const yearSelect = container.querySelector('.xs-select');
    fireEvent.change(yearSelect, { target: { value: '2010' } });
    expect(years).toContain(2010);
  });

  it('changing the commodity re-queries the balance', () => {
    const codes = [];
    window.chainBalance = (code) => { codes.push(code); return balance(); };
    const { container } = render(<ViewChainBalance view="cross_chain" />);
    fireEvent.change(container.querySelector('.pp'), { target: { value: 'acai' } });
    expect(codes).toContain('acai');
  });

  it('clamps the world-share bar width to ≥2% even for a tiny share', () => {
    window.chainBalance = () => balance({ worldShare: 0 });
    const { container } = render(<ViewChainBalance view="cross_chain" />);
    const fill = container.querySelector('.ch-world-fill');
    expect(fill.style.width).toBe('2%'); // Math.max(2, …)
  });
});

// ── ViewHarvestLag ────────────────────────────────────────────────────────────
describe('ViewHarvestLag', () => {
  function lag(overrides = {}) {
    return {
      preview: false,
      months: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
      production: [{ m: 0, v: 100 }],
      shipments: [{ m: 2, v: 80 }],
      peakHarvest: 3, peakShip: 5,
      lagMonths: 2, corrAtLag: 0.87,
      lagProfile: [{ lag: -1, corr: 0.4 }, { lag: 2, corr: 0.87 }],
      ...overrides,
    };
  }

  it('renders the monthly overlay, lag bars, peak KPIs and the markers (non-preview)', () => {
    window.harvestShipmentLag = () => lag();
    const { container } = render(<ViewHarvestLag view="cross_lag" />);
    expect(container.querySelector('.monthly')).toBeTruthy();
    expect(container.querySelector('.lagbars')).toBeTruthy();
    // Two series fed to the overlay; two markers (peak harvest + peak ship).
    expect(monthlyProps.series.length).toBe(2);
    expect(monthlyProps.markers.length).toBe(2);
    // Lag bars receive the best-lag marker derived from the producer.
    expect(lagBarsProps.best).toEqual({ lag: 2, corr: 0.87 });
    // Lag KPI uses the +/- sign + plural "meses".
    expect(container.textContent).toContain('+2 meses');
    // Peak months resolved from the month-name array.
    expect(container.textContent).toContain('Abr'); // peakHarvest index 3
    expect(container.textContent).toContain('Jun'); // peakShip index 5
    expect(previewBannerProps).toBeUndefined();
  });

  it('a +1 lag uses the singular "mês"', () => {
    window.harvestShipmentLag = () => lag({ lagMonths: 1 });
    const { container } = render(<ViewHarvestLag view="cross_lag" />);
    expect(container.textContent).toContain('+1 mês');
  });

  it('shows the demonstration PreviewBanner when data-blocked (preview:true)', () => {
    window.harvestShipmentLag = () => lag({ preview: true });
    const { container } = render(<ViewHarvestLag view="cross_lag" />);
    expect(container.querySelector('.preview-banner')).toBeTruthy();
    expect(previewBannerProps.capabilityNote).toContain('demonstração');
  });

  it('changing the commodity re-queries the lag producer', () => {
    const codes = [];
    window.harvestShipmentLag = (code) => { codes.push(code); return lag(); };
    const { container } = render(<ViewHarvestLag view="cross_lag" />);
    fireEvent.change(container.querySelector('.pp'), { target: { value: 'acai' } });
    expect(codes).toContain('acai');
  });
});

describe('ViewsChain — a fonte bloqueada mostra AUSÊNCIA, não zero', () => {
  it('o balanço sem fonte não afirma "0 mil t" nem "0,0%"', () => {
    // Os produtores bloqueados devolviam 0 em toda medida. O banner já diz que a
    // perspectiva é demonstração, mas "Produção = 0 mil t" e "Exportado = 0,0%" se leem
    // como MEDIDA — e aqui não há nem fonte para medir. Com null, numBR/pctBR rendem '—'.
    window.chainBalance = () => ({
      preview: true, unit: 'mil t', year: 2024,
      produced: null, exported: null, internal: null, domestic: null,
      expFrac: null, intFrac: null, domFrac: null,
      worldShare: null, worldTotal: null, exportUsd: null,
      sankey: { nodes: [], links: [] },
    });
    const { container } = render(<ViewChainBalance view={{ id: 'cross_chain' }} />);
    const vals = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(vals.every((v) => v.includes('—')), `afirmou número: ${vals}`).toBe(true);
    expect(container.textContent).not.toContain('0,0%');
  });

  it('a defasagem sem fonte não afirma "+0 meses" nem "0,00" de correlação', () => {
    // `data.corrAtLag.toFixed(2)` era ainda um CRASH esperando o dia em que o produtor
    // devolvesse null — o mesmo formato que derrubou a Comparação entre fontes.
    window.harvestShipmentLag = () => ({
      preview: true, months: [], production: [], shipments: [],
      peakHarvest: null, peakShip: null, lagMonths: null, corrAtLag: null, lagProfile: [],
    });
    const { container } = render(<ViewHarvestLag view={{ id: 'cross_lag' }} />);
    const vals = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(vals.every((v) => v.includes('—')), `afirmou número: ${vals}`).toBe(true);
    expect(container.textContent).not.toContain('+0 meses');
  });
});
