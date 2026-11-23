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
import { cleanup, render, waitFor } from '@testing-library/react';

let donutProps, multiLineProps, tileMapProps;

function stubGlobals(filtered) {
  window.applyFilters = () => filtered;
  window.fmtSigned = (x) => (x >= 0 ? '+' : '') + Math.round(x) + '%';
  window.SectionHeader = ({ overline, title }) => (
    <div className="sh"><span className="sh-ov">{overline}</span><span className="sh-title">{title}</span></div>
  );
  window.EmptyCard = ({ children }) => <div className="card subtle">{children}</div>;
  // NotApplicableNote with the real atom's rule (Atoms.jsx): one line per message, nothing
  // when every message is empty — a stub that renders an empty box hides a real "nothing".
  window.NotApplicableNote = ({ note }) => {
    const msgs = note ? Object.values(note).filter(Boolean) : [];
    return msgs.length ? <div className="na-note">{msgs.join(' ')}</div> : null;
  };
  window.UnitFamilyTag = ({ family, unit }) => <span className="uft">{family}{unit ? ` · ${unit}` : ''}</span>;
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi"><span className="kpi-label">{label}</span><span className="kpi-value">{value}</span><span className="kpi-sub">{sub}</span></div>
  );
  window.Donut = (props) => { donutProps = props; return <div className="donut" />; };
  window.MultiLineChart = (props) => { multiLineProps = props; return <div className="mlc" />; };
  window.BrazilTileMap = (props) => { tileMapProps = props; return <div className="tilemap" />; };
}

let ViewRebanho;

beforeEach(async () => {
  donutProps = undefined; multiLineProps = undefined; tileMapProps = undefined;
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
// (has value) and must NOT count as part of the efetivo. `unit_native` is what the API
// serves (measured on prod 2026-11-18): it is what a count is named by.
const FIXTURE = {
  products: [
    { code: '2670', name: 'Bovino', family: 'count', unit: 'un', measure_kind: 'stock', unit_native: 'Cabeças' },
    { code: '2675', name: 'Suíno', family: 'count', unit: 'un', measure_kind: 'stock', unit_native: 'Cabeças' },
    { code: '2685', name: 'Ovos de galinha', family: 'count', unit: 'un', measure_kind: 'flow', unit_native: 'Mil dúzias' },
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

// ── Um recorte sub-UF não se aplica aqui — e a tela diz, em todo estado (v1.108.2) ──────
// This perspective's series exist only for the whole country (or whole UFs): it can apply a
// sub-UF recorte in no state of it. Until v1.108.2 it showed those numbers under the
// recorte's chip without a word — while the recorte loaded, after it failed, and once it had
// loaded alike.
describe('ViewRebanho — a sub-UF recorte does not apply, and the screen says so', () => {
  const conv = () => window.DEFAULT_CONVENTIONS;
  it.each([
    ['on its way', { subUfLoading: true }],
    ['failed', { subUfLoadError: 'HTTP 503' }],
    ['resolved', { subUfLoaded: true }],
  ])('recorte %s → the note', (_estado, extra) => {
    stubGlobals({ ...FIXTURE, subUfRequested: true, ...extra });
    const { container } = render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    const nota = container.querySelector('.na-note').textContent;
    expect(nota).toContain('O recorte territorial abaixo da UF não se aplica a esta perspectiva: o efetivo de cada espécie existe aqui por UF inteira, não por município.');
    expect(nota).toContain('Os números abaixo não se limitam aos municípios escolhidos.');
  });

  it('no recorte → no note', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv()} />);
    expect(container.querySelector('.na-note')).toBeNull();
  });
});

// ── Sob um subconjunto de UFs, o rebanho é o das UFs (v1.108.3) ───────────────────────────
// The species series are applyFilters' per-product ones. Under a UF subset they were Brazil's,
// under a title that said "Rebanho brasileiro" and a chip that said "1 UF". Now they are the
// UFs' own, the title names whose herd it is, and while the read is on its way or after it
// failed nothing is drawn — never "Nenhum rebanho", which would claim the UFs have none.
describe('ViewRebanho — under a UF subset the herd is the UFs’ own', () => {
  const conv = () => window.DEFAULT_CONVENTIONS;
  const UF = { productUfRequested: true, productUfLoading: false, productUfLoadError: null, productUfUnavailable: false };
  const titulos = (c) => [...c.querySelectorAll('.sh-title')].map((e) => e.textContent);
  const renderWith = (extra, states = ['PA']) => {
    stubGlobals({ ...FIXTURE, ...UF, ...extra });
    window.Icon = () => null;
    return render(<ViewRebanho summary={{ states }} database="ibge_ppm" conventions={conv()} />).container;
  };
  afterEach(() => { delete window.Icon; });

  it('resolved, one UF: the title names it, and nothing else is said', () => {
    const c = renderWith({});
    expect(titulos(c)).toContain('Rebanho · Pará · cabeças');
    expect(titulos(c)).not.toContain('Rebanho brasileiro · cabeças');
    expect(donutProps).toBeTruthy();
    expect(c.querySelector('.na-note')).toBeNull();
  });

  it('resolved, several UFs: the title counts them', () => {
    const c = renderWith({}, ['PA', 'AM']);
    expect(titulos(c)).toContain('Rebanho · 2 UFs · cabeças');
  });

  it.each([
    ['on its way', { productUfLoading: true }, 'Carregando as séries por produto das UFs escolhidas…'],
    ['failed', { productUfLoadError: 'HTTP 503' }, 'Não foi possível carregar as séries por produto das UFs escolhidas'],
  ])('%s: no herd drawn, the note says which — never "Nenhum rebanho"', (_estado, extra, texto) => {
    const c = renderWith({ ...extra, allProductTS: {}, productTS: {} });
    expect(donutProps).toBeUndefined();
    expect(multiLineProps).toBeUndefined();
    expect(c.querySelector('.kpi')).toBeNull();
    expect(c.textContent).not.toMatch(/Nenhum rebanho/);
    expect(c.querySelector('.na-note').textContent).toContain(texto);
  });

  it('a banco without series by UF: the national herd, titled as Brazil’s, and a note saying so', () => {
    const c = renderWith({ productUfUnavailable: true });
    expect(titulos(c)).toContain('Rebanho brasileiro · cabeças');
    expect(c.querySelector('.na-note').textContent)
      .toContain('As séries por produto deste banco existem só para o Brasil inteiro');
  });

  it('no UF subset: Brazil’s herd, titled as such, with no note', () => {
    const c = renderWith({ productUfRequested: false }, undefined);
    expect(titulos(c)).toContain('Rebanho brasileiro · cabeças');
    expect(c.querySelector('.na-note')).toBeNull();
  });
});

// ── Uma contagem se nomeia pelo que conta (v1.108.7) ──────────────────────────────────────
// Until v1.108.7 the cards, the evolution's axis and the UF map wrote the convention's unit
// beside every herd: "234.000.000 un" for Bovino under the default, "cab" under the other.
// The herd counts heads, and the screen now says so in every convention worth ONE of the
// thing; a multiple the researcher picked ('dz') keeps its own label, since the number is
// in that multiple. A species whose unit nobody named says so, and is never drawn on the
// herd's shared unit.
describe('ViewRebanho — a count is named by what it counts', () => {
  const withCount = (count) => ({
    ...window.DEFAULT_CONVENTIONS,
    units: { ...window.DEFAULT_CONVENTIONS.units, ...(count ? { count } : {}) },
  });
  const kpi = (c, label) => {
    const card = [...c.querySelectorAll('.kpi')]
      .find((k) => k.querySelector('.kpi-label').textContent === label);
    return card && { value: card.querySelector('.kpi-value').textContent, sub: card.querySelector('.kpi-sub').textContent };
  };
  const renderRb = (conv, fixture = FIXTURE) => {
    stubGlobals(fixture);
    return render(<ViewRebanho summary={{}} database="ibge_ppm" conventions={conv} />).container;
  };
  // Each printed string on its own: textContent glues neighbours ("234.000.000 un2021 vs."),
  // and a regex word boundary never falls between two word characters.
  const impressos = (c) => [...c.querySelectorAll('.kpi-value, .kpi-sub, .sh-title, .sh-ov, .uft')]
    .map((e) => e.textContent.trim());
  const UNIDADE_NUA = /(\s|\/)(un|cab)$/;

  // The table holds the unit id, not the convention: it.each runs before beforeEach has
  // imported MetricConventions.jsx, so DEFAULT_CONVENTIONS does not exist yet at that point.
  it.each([
    ['the default (un)', null],
    ['cab', 'cab'],
  ])('under %s the cards, the axis and the tag say "cabeças", never the bare unit', (_nome, count) => {
    const c = renderRb(withCount(count));
    expect(kpi(c, 'Efetivo · Bovino').value).toBe('234.000.000 cabeças');
    expect(kpi(c, 'Pico histórico').value).toBe('234.000.000 cabeças');
    expect(multiLineProps.label).toBe('cabeças');
    expect(c.textContent).toContain('count · cabeças');
    expect(impressos(c).filter((t) => UNIDADE_NUA.test(t))).toEqual([]);
  });

  it('under a multiple the researcher picked (dz), the number is in dúzias and says "dz"', () => {
    const c = renderRb(withCount('dz'));
    expect(kpi(c, 'Efetivo · Bovino').value).toBe('19.500.000 dz'); // 234e6 / 12
    expect(multiLineProps.label).toBe('dz');
  });

  it('the UF map and the UF líder card name the heads too', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ uf: [{ uf: 'MT', q_count: 30 }, { uf: 'GO', q_count: 20 }] }),
    }));
    const c = renderRb(withCount(null));
    await waitFor(() => expect(tileMapProps).toBeTruthy());
    expect(tileMapProps.label).toBe('cabeças');
    expect(kpi(c, 'UF líder · Bovino').sub).toBe('30.000.000 cabeças');
    expect(impressos(c).filter((t) => UNIDADE_NUA.test(t))).toEqual([]);
  });

  // A species whose unit is not recognised: its own cards say so, and the composition and
  // the evolution — which put every species on one unit — are refused and named, never drawn
  // on "cabeças", which would be a claim about something it may not count.
  const SEM_UNIDADE = {
    ...FIXTURE,
    products: [...FIXTURE.products,
      { code: '2699', name: 'Espécie sem unidade', family: 'count', unit: 'un', measure_kind: 'stock' }],
    selectedProducts: [...FIXTURE.selectedProducts, '2699'],
    allProductTS: { ...FIXTURE.allProductTS,
      '2699': [{ y: 2020, v: 0, q: 400, family: 'count' }, { y: 2021, v: 0, q: 500, family: 'count' }] },
  };

  it('an unrecognised species says "unidade não identificada" and the shared charts are refused', () => {
    const c = renderRb(withCount(null), SEM_UNIDADE);
    expect(kpi(c, 'Efetivo · Espécie sem unidade').value).toBe('500.000.000 unidade não identificada');
    expect(donutProps).toBeUndefined();
    expect(multiLineProps).toBeUndefined();
    expect(c.textContent).toContain('Contagens que não se somam');
    expect(c.textContent).toContain('Espécie sem unidade (unidade não identificada)');
    expect(c.textContent).toContain('Bovino (cabeças)');
  });

  it('under dz an unrecognised species keeps the multiple and still says it is unknown', () => {
    const c = renderRb(withCount('dz'), SEM_UNIDADE);
    expect(kpi(c, 'Efetivo · Espécie sem unidade').value)
      .toBe('41.666.667 dz (unidade não identificada)'); // 500e6 / 12
  });
});
