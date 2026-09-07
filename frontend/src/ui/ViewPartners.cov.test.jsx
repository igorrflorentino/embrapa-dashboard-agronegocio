// ViewPartners.cov.test.jsx — render coverage for the trading-partner ranking view
// (country/UF, COMEX/COMTRADE). ViewPartners branches on the active ranking metric:
// Capital (value — exp/imp split bars + top-3 concentration), Volume (weight —
// additive single bar), and Preço médio (price — a non-additive ratio → "faixa de
// preço" range KPI). The metric is a window.React.useState toggle that recomputes
// the ranking server-side, so we set window.React BEFORE importing the view (the
// prototype hooks-off-global convention) and stub every window.* dependency.

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
// A nota e a calibração REAIS. O piso é aplicado no SERVIDOR (o corte top-N mora lá),
// então aqui o alvo é a outra metade da regra: a tela nomear quem ficou de fora, e
// anunciar o MESMO limiar que o servidor usou — a paridade entre os dois números é
// prendida por tests/test_partner_price_floor_parity.py.
import './seriesUtils.js';
import './MaterialityFloorNote.jsx';

// partnerData captures the metric it was asked for so we can prove the toggle
// drives a server-side recompute (a new partnerData call per metric).
let partnerDataCalls;

function stubGlobals(byMetric) {
  window.React = React;
  globalThis.React = React;
  window.partnerData = (db, summary, metric) => {
    partnerDataCalls.push(metric);
    return byMetric[metric] || byMetric.value;
  };
  window.bancoById = () => ({ scope: 'País', domain: 'Comércio exterior' });
  window.fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
  window.NotApplicableNote = ({ note }) => (note ? <div className="na">{note}</div> : null);
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
      <span className="kpi-value">{String(value)}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

let ViewPartners;

beforeEach(async () => {
  partnerDataCalls = [];
  window.React = React;
  globalThis.React = React;
  await import('./ViewPartners.jsx'); // registers window.ViewPartners
  ViewPartners = window.ViewPartners;
});

afterEach(() => cleanup());

// Three partner rankings keyed by metric. Value carries exp/imp split bars; weight is
// a plain additive measure; price is a non-additive US$/kg ratio.
const BY_METRIC = {
  value: {
    unit: 'US$',
    flowLabel: 'destino',
    notApplicable: 'Origem-UF não se aplica a um banco país-origem.',
    partners: [
      { name: 'China', value: 6000, exp: 5000, imp: 1000 }, // bi-scale (>=1000) → "bi"
      { name: 'EUA',   value: 3000, exp: 2500, imp: 500 },
      { name: 'Peru',  value: 1000, exp: 800,  imp: 200 },
      { name: 'Chile', value: 50,   exp: 50,   imp: 0 },     // <10 → 2-decimal "mi"
    ],
  },
  weight: {
    unit: 'US$',
    flowLabel: 'destino',
    notApplicable: null,
    partners: [
      { name: 'China', weight: 12.5 },
      { name: 'EUA',   weight: 8 },
      { name: 'Peru',  weight: 3 },
    ],
  },
  price: {
    unit: 'US$',
    flowLabel: 'destino',
    notApplicable: null,
    partners: [
      { name: 'Suíça',  price: 42.5 },
      { name: 'Japão',  price: 18 },
      { name: 'França', price: 6.25 },
      { name: 'Outro',  price: null }, // null price → '—' / filtered from range
    ],
  },
};

describe('ViewPartners — smoke + metric-toggle branches', () => {
  it('renders the default Capital ranking with exp/imp bars + top-3 concentration', () => {
    stubGlobals(BY_METRIC);
    const { container } = render(
      <ViewPartners summary={{}} conventions={{}} database="mdic_comex" />
    );
    // Honest country-origin note.
    expect(container.textContent).toContain('Origem-UF não se aplica');
    // Largest destino = China, formatted bi-scale (6000 → 6,0 bi).
    const top = container.querySelector('.kpi[data-label="Maior destino"] .kpi-value');
    expect(top.textContent).toBe('China');
    // Partners mapped = 4.
    const mapped = container.querySelector('.kpi[data-label="Parceiros mapeados"] .kpi-value');
    expect(mapped.textContent).toBe('4');
    // Additive metric → top-3 concentration KPI.
    expect(container.querySelector('.kpi[data-label="Concentração top-3"]')).toBeTruthy();
    expect(container.querySelector('.kpi[data-label="Faixa de preço"]')).toBeFalsy();
    // Value metric → exp + imp split bars + the legend.
    expect(container.querySelectorAll('.ptn-bar.exp').length).toBe(4);
    expect(container.querySelectorAll('.ptn-bar.imp').length).toBe(4);
    expect(container.querySelector('.ptn-legend')).toBeTruthy();
    // Four ranked rows, numbered #1..#4.
    expect(container.querySelectorAll('.ptn-row').length).toBe(4);
    expect(container.querySelector('.ptn-rank').textContent).toBe('#1');
  });

  it('switching to Volume recomputes server-side and renders a single additive bar', () => {
    stubGlobals(BY_METRIC);
    const { container } = render(
      <ViewPartners summary={{}} conventions={{}} database="mdic_comex" />
    );
    const volBtn = [...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Volume');
    expect(volBtn).toBeTruthy();
    fireEvent.click(volBtn);
    // The toggle triggered a fresh partnerData('weight') call (server-side re-sort).
    expect(partnerDataCalls).toContain('weight');
    // Volume is additive → still the top-3 concentration KPI, sub now "volume total".
    const kpi3 = container.querySelector('.kpi[data-label="Concentração top-3"]');
    expect(kpi3).toBeTruthy();
    expect(kpi3.querySelector('.kpi-sub').textContent).toContain('volume');
    // Weight metric → single (non-exp/imp) bars, no exp/imp split, no value legend.
    expect(container.querySelectorAll('.ptn-bar.imp').length).toBe(0);
    expect(container.querySelector('.ptn-legend')).toBeFalsy();
    // 3 partners in the weight ranking.
    expect(container.querySelectorAll('.ptn-row').length).toBe(3);
  });

  it('shows a LoadErrorNote when the partnerData fetch failed (not a false "0 parceiros")', () => {
    stubGlobals(BY_METRIC);
    // A settled fetch failure surfaces loadError on the shell (resource.errorOf → producers).
    window.partnerData = () => ({ partners: [], flowLabel: 'Parceiro', unit: 'US$', loadError: 'HTTP 500' });
    const { container } = render(
      <ViewPartners summary={{}} conventions={{}} database="mdic_comex" />
    );
    expect(container.querySelector('.load-err')).toBeTruthy();
  });

  it('switching to Preço médio shows the non-additive faixa-de-preço range KPI', () => {
    stubGlobals(BY_METRIC);
    const { container } = render(
      <ViewPartners summary={{}} conventions={{}} database="mdic_comex" />
    );
    const priceBtn = [...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Preço médio');
    fireEvent.click(priceBtn);
    expect(partnerDataCalls).toContain('price');
    // Non-additive → faixa de preço KPI, not top-3 concentration.
    expect(container.querySelector('.kpi[data-label="Faixa de preço"]')).toBeTruthy();
    expect(container.querySelector('.kpi[data-label="Concentração top-3"]')).toBeFalsy();
    // Range value spans min–max over the positive prices: 6,25–42,50/kg.
    const faixa = container.querySelector('.kpi[data-label="Faixa de preço"] .kpi-value');
    expect(faixa.textContent).toContain('6,25');
    expect(faixa.textContent).toContain('42,50');
    // The null-price partner renders '—' for its measure.
    const vals = [...container.querySelectorAll('.ptn-val')].map((e) => e.textContent);
    expect(vals).toContain('—');
  });

  it('renders the empty faixa-de-preço KPI gracefully when there are no partners', () => {
    stubGlobals({
      ...BY_METRIC,
      price: { unit: 'US$', flowLabel: 'destino', notApplicable: null, partners: [] },
    });
    const { container } = render(
      <ViewPartners summary={{}} conventions={{}} database="comtrade" />
    );
    const priceBtn = [...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Preço médio');
    fireEvent.click(priceBtn);
    // No partners → faixa value falls back to '—', "Maior destino" is '—', no rows.
    const faixa = container.querySelector('.kpi[data-label="Faixa de preço"] .kpi-value');
    expect(faixa.textContent).toBe('—');
    const top = container.querySelector('.kpi[data-label="Maior destino"] .kpi-value');
    expect(top.textContent).toBe('—');
    expect(container.querySelectorAll('.ptn-row').length).toBe(0);
  });
});

describe('ViewPartners — o piso de materialidade do preço médio', () => {
  beforeEach(() => { partnerDataCalls = []; });
  afterEach(() => cleanup());

  // ÂNCORA EXTERNA: o que o servidor devolve depois do piso, medido em produção
  // 2026-09-07 sobre o COMEX. O topo era o Lesoto com 1 kg — US$ 11,00 de comércio em
  // toda a história — e `belowFloor` é o que a tela precisa para NOMEAR quem saiu.
  const COM_PISO = {
    unit: 'US$',
    flowLabel: 'destino',
    notApplicable: null,
    partners: [
      { name: 'Estônia', price: 2.2, weight: 3.604334, value: 7.93 },
      { name: 'Belarus', price: 1.99, weight: 1.279349, value: 2.55 },
    ],
    belowFloor: [
      { name: 'Mônaco', price: 8.22, weight: 0.001522, value: 0.0125 },
      { name: 'Nauru', price: 3.09, weight: 0.0006, value: 0.0019 },
      { name: 'Lesoto', price: 11.0, weight: 0.000001, value: 0.000011 },
    ],
  };

  function renderPreco(over = {}) {
    stubGlobals({ value: COM_PISO, weight: COM_PISO, price: { ...COM_PISO, ...over } });
    const { container } = render(
      <ViewPartners summary={{}} conventions={{}} database="comex" />
    );
    const btn = [...container.querySelectorAll('.seg-opt')].find((b) => b.textContent === 'Preço médio');
    fireEvent.click(btn);
    return container;
  }

  it('o topo passa a ser o mercado de nicho REAL, não o de 1 kg', () => {
    const container = renderPreco();
    const top = container.querySelector('.kpi[data-label="Maior destino"] .kpi-value');
    expect(top.textContent).toBe('Estônia');
    const nomes = [...container.querySelectorAll('.ptn-name')].map((e) => e.textContent);
    expect(nomes).not.toContain('Lesoto');
  });

  it('a tela NOMEIA quem o piso tirou, com o comércio de cada um', () => {
    // Sem isto o piso vira filtragem invisível: o Lesoto sumiria da tela sem que
    // ninguém pudesse saber que ele existiu, nem por que saiu.
    const container = renderPreco();
    expect(container.textContent).toContain('Fora do ranking de preço');
    expect(container.textContent).toContain('Lesoto (1 kg)');
    expect(container.textContent).toContain('Mônaco (1.522 kg)');
    // Em toneladas isso virava "2 t" — o arredondamento apagava justamente a
    // informação pela qual Mônaco saiu do ranking.
    expect(container.textContent).not.toContain('Mônaco (2 t)');
    // E diz que eles continuam existindo nos outros dois rankings, onde o peso deles
    // é o próprio dado — a exclusão é do PREÇO, não do parceiro.
    expect(container.textContent).toContain('Capital e Volume');
  });

  it('anuncia o MESMO limiar que o servidor aplicou', () => {
    // 0,1 mil t = 100 t: o número tem de casar com serializers._PARTNER_PRICE_FLOOR
    // (test_partner_price_floor_parity.py prende a conversão de unidade).
    const container = renderPreco();
    expect(window.PARTNER_PRICE_FLOOR.minAbs).toBe(0.1);
    expect(container.textContent).toContain('100.000 kg no total');
    // E o limiar relativo não pode sumir no arredondamento: 0,001% com duas casas
    // vira "0,00%", que se lê como uma regra que não exclui ninguém.
    expect(container.textContent).toContain('0,001% do peso do recorte');
    expect(container.textContent).not.toContain('0,00% do peso');
  });

  it('sem belowFloor a nota não aparece (nada foi tirado, nada a declarar)', () => {
    const container = renderPreco({ belowFloor: [] });
    expect(container.textContent).not.toContain('Fora do ranking de preço');
  });
});
