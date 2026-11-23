// ViewProductProfile.test.jsx — the profile of ONE product names its quantity by what the
// product counts, in the unit the quantity is shown in (v1.108.7).
//
// Until v1.108.7 every count on this screen read the convention's bare unit: "un" beside a
// herd, the eggs and the pineapples alike, a price "R$ 0,4 /un", and a ficha técnica whose
// "Unidade nativa" said "un (unidades)" for a product the source publishes in "Mil dúzias".
// Two more defects lived beside it and are locked here too:
//   * the price's denominator was the family's BASE unit (prod.unit), so with kg chosen in
//     the conventions a price computed per kg read "/t" — wrong by ×1000 in the label;
//   * a crop with no value in the window reached the stock cards, which called
//     formatCountQty whatever the family: ×1e6 instead of ×1e3, labelled "un".
//
// Since v1.108.10 the price divides the value and the quantity of the SAME rows (vPriced ÷
// qPriced), and a year whose price rests on less than 90% of its value says so; the last
// describe locks it.
//
// Unlike ViewProductProfile.cov.test.jsx, which stubs every helper to drive branches, this
// file runs the REAL unit modules (data.js, MetricConventions.jsx, UnitFamily.jsx,
// countUnits.js, seriesUtils.js, CollapsingNameList.jsx), so the strings asserted are the
// ones the screen prints. Only the composed widgets, applyFilters and fetch are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let lineCharts;

function stubWidgets(filtered) {
  window.applyFilters = () => filtered;
  window.bancoDim = () => ({ codeLabel: 'Código IBGE' });
  window.EmptyCard = ({ children }) => <div className="empty-card">{children}</div>;
  // NotApplicableNote with the real atom's rule (Atoms.jsx): nothing when every message is empty.
  window.NotApplicableNote = ({ note }) => {
    const msgs = note ? Object.values(note).filter(Boolean) : [];
    return msgs.length ? <div className="na-note">{msgs.join(' ')}</div> : null;
  };
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi">
      <span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.SectionHeader = ({ overline, title }) => (
    <div className="sh"><span className="sh-overline">{overline}</span><span className="sh-title">{title}</span></div>
  );
  window.LineChart = (props) => { lineCharts.push(props); return <div className="line-chart" />; };
  window.BarChart = () => <div className="bar-chart" />;
}

beforeEach(async () => {
  lineCharts = [];
  await import('./data.js');               // UNIT_FAMILIES, unitToBase, fmtPct, fmtSigned
  await import('./seriesUtils.js');        // scalePresent, ratioPresent, deltaPct…
  await import('./MetricConventions.jsx'); // DEFAULT_CONVENTIONS, formatProductQty, *QtyMul
  await import('./UnitFamily.jsx');        // UnitFamilyTag, real
  await import('./ViewProductProfile.jsx'); // imports countUnits.js + RecorteNote.jsx itself
  // jsdom has no fetch; the UF ranking effect calls /api/product-uf.
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ uf: [] }) }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// A convention with the strip's count (or mass) unit set; the default has neither key.
const conv = (units = {}) => ({
  ...window.DEFAULT_CONVENTIONS,
  units: { ...window.DEFAULT_CONVENTIONS.units, ...units },
});

// One product alone in the basket, with the series the serializer sends: `v` in mi of the
// currency, `q` in the family's internal scale (mil t · mi m³ · mi of ONE of the thing
// counted — Σ qty_base, the seed unit_family_conversions' to_base), and the priced pair
// `vPriced`/`qPriced` in those same scales: the value and the quantity of the rows that carry
// BOTH measures, which is what the price divides (v1.108.10).
// Every row of the IBGE products below carries both, so the pair is the whole year.
const inteiro = (ts) => ts.map((p) => ({ ...p, vPriced: p.v, qPriced: p.q }));
const profileOf = (product, series) => ({
  products: [product],
  selectedProducts: [product.code],
  allProductTS: { [product.code]: series },
  productTS: { [product.code]: series },
  ufDataFull: [{ uf: 'MG', value: 1, real: true }],
  qualityByProduct: [],
  yearStart: series[0].y,
  yearEnd: series[series.length - 1].y,
});

const renderProfile = (product, series, c = conv(), database = 'ibge_ppm') => {
  stubWidgets(profileOf(product, series));
  return render(<window.ViewProductProfile summary={{}} database={database} conventions={c} />).container;
};
const kpiCard = (c, label) => [...c.querySelectorAll('.kpi')]
  .find((k) => k.querySelector('.kpi-label').textContent === label);
const kpi = (c, label) => {
  const card = kpiCard(c, label);
  return card ? card.querySelector('.kpi-value').textContent : undefined;
};
const kpiSub = (c, label) => {
  const card = kpiCard(c, label);
  return card ? card.querySelector('.kpi-sub').textContent : undefined;
};
const ficha = (c, termo) => {
  const dts = [...c.querySelectorAll('.pp-spec dt')];
  const dt = dts.find((d) => d.textContent === termo);
  return dt ? dt.nextElementSibling.textContent : undefined;
};
const titulos = (c) => [...c.querySelectorAll('.sh-title')].map((e) => e.textContent);
// Each printed string on its own: textContent glues neighbours ("R$ 0,4 /unParticipação"),
// and a regex word boundary never falls between two letters. The convention's bare unit is a
// string that ENDS in it ("234 un", "/un", "Contagem · un") or the old ficha "un (unidades)".
const impressos = (c) => [...c.querySelectorAll('.kpi-value, .kpi-label, .sh-title, .sh-overline, .pp-spec dd')]
  .map((e) => e.textContent.trim());
const UNIDADE_NUA = /(\s|\/)(un|cab)$|^un \(/;
const nuas = (c) => impressos(c).filter((t) => UNIDADE_NUA.test(t));

// PPM tabela 74: ovos de galinha, published in "Mil dúzias" (to_base 12.000 → ovos).
const OVOS = { code: '2685', name: 'Ovos de galinha', family: 'count', unit: 'un', measure_kind: 'flow', unit_native: 'Mil dúzias' };
const OVOS_TS = inteiro([{ y: 2022, v: 20000, q: 50000 }, { y: 2023, v: 24000, q: 60000 }]); // 60 bi ovos, R$ 24 bi
// PAM: abacaxi, published in "Mil frutos" (pam_count_unit_products) and carrying no measure_kind.
const ABACAXI = { code: '2696', name: 'Abacaxi', family: 'count', unit: 'un', unit_native: 'Mil frutos' };
const ABACAXI_TS = inteiro([{ y: 2022, v: 2800, q: 1400 }, { y: 2023, v: 3000, q: 1500 }]); // 1,5 bi frutos, R$ 3 bi
// PPM: the herd, a value-less stock in "Cabeças" — no row has a value, so no priced pair.
const BOVINO = { code: '2670', name: 'Bovino', family: 'count', unit: 'un', measure_kind: 'stock', unit_native: 'Cabeças' };
const BOVINO_TS = [{ y: 2022, v: 0, q: 230 }, { y: 2023, v: 0, q: 234 }];

describe('ViewProductProfile — a count is named by what the product counts', () => {
  it('ovos de galinha: the quantity in ovos, the price per ovo, the native unit as published', () => {
    const c = renderProfile(OVOS, OVOS_TS);
    expect(kpi(c, 'Quantidade · Contagem · ovos')).toBe('60.000.000.000 ovos');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 0,4 /ovo'); // 24e9 ÷ 60e9
    expect(titulos(c)).toContain('R$ por ovo · 2022–2023');
    expect(titulos(c)).toContain('Ovos de galinha · quantidade (ovos)');
    expect(lineCharts.map((p) => p.label)).toEqual(expect.arrayContaining(['ovos', 'R$/ovo']));
    expect(ficha(c, 'Unidade nativa')).toBe('Mil dúzias');
    expect(nuas(c)).toEqual([]);
  });

  it('abacaxi: the quantity in frutos, the price per fruto, "Mil frutos" as the native unit', () => {
    const c = renderProfile(ABACAXI, ABACAXI_TS, conv(), 'ibge_pam');
    expect(kpi(c, 'Quantidade · Contagem · frutos')).toBe('1.500.000.000 frutos');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 2 /fruto'); // 3e9 ÷ 1,5e9
    expect(titulos(c)).toContain('R$ por fruto · 2022–2023');
    expect(ficha(c, 'Unidade nativa')).toBe('Mil frutos');
    expect(nuas(c)).toEqual([]);
  });

  it('a herd: the efetivo, its peak and the ficha in cabeças', () => {
    const c = renderProfile(BOVINO, BOVINO_TS);
    expect(kpi(c, 'Efetivo · Contagem · cabeças')).toBe('234.000.000 cabeças');
    expect(kpi(c, 'Pico histórico')).toBe('234.000.000 cabeças');
    expect(titulos(c)).toContain('Bovino · efetivo (cabeças)');
    expect(ficha(c, 'Unidade nativa')).toBe('Cabeças');
    expect(ficha(c, 'Efetivo (2023)')).toBe('234.000.000 cabeças');
    expect(nuas(c)).toEqual([]);
  });

  it('the strip’s "cab" is worth one of the thing: the eggs still read ovos, never "cab"', () => {
    const c = renderProfile(OVOS, OVOS_TS, conv({ count: 'cab' }));
    expect(kpi(c, 'Quantidade · Contagem · ovos')).toBe('60.000.000.000 ovos');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 0,4 /ovo');
  });

  it('a multiple the researcher picked (dz) keeps its label, and the number is in dúzias', () => {
    const c = renderProfile(OVOS, OVOS_TS, conv({ count: 'dz' }));
    expect(kpi(c, 'Quantidade · Contagem · dz')).toBe('5.000.000.000 dz'); // 60e9 ÷ 12
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 4,8 /dz');            // 24e9 ÷ 5e9
  });

  it('a count whose unit nobody named says so everywhere, and never wears another’s label', () => {
    const SEM = { code: 'X1', name: 'Contagem sem unidade', family: 'count', unit: 'un', measure_kind: 'flow', unit_native: 'Bichos' };
    const c = renderProfile(SEM, ABACAXI_TS);
    expect(kpi(c, 'Quantidade · Contagem · unidade não identificada')).toBe('1.500.000.000 unidade não identificada');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 2 /unidade não identificada');
    expect(ficha(c, 'Unidade nativa')).toBe('unidade não identificada');
    // Under a multiple the number is in that multiple, and the screen still says it is unknown.
    cleanup();
    const dz = renderProfile(SEM, ABACAXI_TS, conv({ count: 'dz' }));
    expect(kpi(dz, 'Quantidade · Contagem · dz (unidade não identificada)'))
      .toBe('125.000.000 dz (unidade não identificada)'); // 1,5e9 ÷ 12
  });
});

describe('ViewProductProfile — mass and volume keep the strip’s unit, and the price follows it', () => {
  const SOJA = { code: '2713', name: 'Soja', family: 'mass', unit: 't', unit_native: 'Toneladas' };
  const SOJA_TS = inteiro([{ y: 2022, v: 280000, q: 140000 }, { y: 2023, v: 300000, q: 150000 }]); // 150 mi t, R$ 300 bi

  it('under t, the price is per t', () => {
    const c = renderProfile(SOJA, SOJA_TS, conv(), 'ibge_pam');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 2.000 /t');
    expect(ficha(c, 'Unidade nativa')).toBe('t (toneladas)');
  });

  it('under kg, the price is per kg — it read "/t" over a number computed per kg', () => {
    const c = renderProfile(SOJA, SOJA_TS, conv({ mass: 'kg' }), 'ibge_pam');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 2 /kg');
    expect(titulos(c)).toContain('R$ por kg · 2022–2023');
    expect(lineCharts.map((p) => p.label)).toContain('R$/kg');
  });

  it('a crop with no value in the window is shown in t, not multiplied as a count', () => {
    // PAM before 1980 under IPCA: the quantity exists, the corrected value does not. The
    // screen lays it out with the stock cards (no value to show), and those cards called
    // formatCountQty: 150.000 mil t became "150.000.000.000 un".
    const SEM_VALOR = [{ y: 1978, v: null, q: 140000 }, { y: 1979, v: null, q: 150000 }];
    const c = renderProfile(SOJA, SEM_VALOR, conv(), 'ibge_pam');
    // The number and its unit only: that a crop is laid out as a herd ("Efetivo") is a
    // separate defect, left for its own change.
    expect(kpi(c, 'Pico histórico')).toBe('150.000.000 t');
    expect([...c.querySelectorAll('.pp-spec dd')].map((d) => d.textContent)).toContain('150.000.000 t');
    expect(nuas(c)).toEqual([]);
  });
});

describe('ViewProductProfile — the price divides the value and the quantity of the SAME rows (v1.108.10)', () => {
  // UN Comtrade publishes rows with a value and no quantity in the product's unit: in another
  // unit, or none at all. The year's `v` adds them every one; the price must not. Measured on
  // prod: 200919 in 2002, Brazil as reporter, read US$ 69,906/t as v ÷ q, while the rows with
  // both measures give US$ 5,649/t and hold 8.08% of the year's value. The same shape, rounded:
  const SUCO = { code: '200919', name: 'Suco de laranja', family: 'mass', unit: 't', unit_native: 'kg' };
  const SUCO_TS = [
    { y: 2001, v: 500, q: 100, vPriced: 500, qPriced: 100 }, // every row priced
    { y: 2002, v: 1000, q: 20, vPriced: 100, qPriced: 20 },  // 10% of the value behind the price
  ];
  const precos = () => lineCharts.find((p) => p.label === 'R$/t').data.map((d) => d.v);
  const notaParcial = (c) => [...c.querySelectorAll('.caption')]
    .map((e) => e.textContent).find((t) => t.startsWith('Preço apoiado em parte do valor'));

  it('the KPI and the series divide vPriced by qPriced: R$ 5.000/t, never the R$ 50.000/t of v ÷ q', () => {
    const c = renderProfile(SUCO, SUCO_TS, conv(), 'un_comtrade');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 5.000 /t');
    expect(precos()).toEqual([5000, 5000]);
  });

  it('a year whose price rests on less than 90% of its value is named, with its share', () => {
    const c = renderProfile(SUCO, SUCO_TS, conv(), 'un_comtrade');
    expect(kpiSub(c, 'Preço médio implícito')).toBe('valor ÷ quantidade · apoiado em 10,0% do valor');
    const nota = notaParcial(c);
    expect(nota).toContain('Preço apoiado em parte do valor: 2002 (10,0%).');
    expect(nota).not.toContain('2001');
  });

  it('at 90% nothing is named, and a year with a value and no priced row is a gap, never a zero', () => {
    const TS = [
      { y: 2001, v: 1000, q: 100, vPriced: 900, qPriced: 100 },    // exactly the threshold
      { y: 2002, v: 1000, q: null, vPriced: null, qPriced: null }, // a value, no quantity in t
    ];
    const c = renderProfile(SUCO, TS, conv(), 'un_comtrade');
    expect(precos()).toEqual([9000, null]);
    expect(kpi(c, 'Preço médio implícito')).toBe('—');
    expect(kpiSub(c, 'Preço médio implícito')).toBe('valor ÷ quantidade');
    expect(notaParcial(c)).toBeUndefined();
  });

  it('a tiny share keeps its first significant digit: 0,03%, never "0,0%"', () => {
    // 440310 in 2022, every reporter (prod, 2026-11-23): US$ 193 mi in the year, 0.03% of it
    // in rows with a quantity in m³. One decimal would say nothing stands behind the price.
    const MADEIRA = { code: '440310', name: 'Madeira tratada', family: 'volume', unit: 'm³', unit_native: 'm³' };
    const TS = [{ y: 2022, v: 193.3, q: 0.0035, vPriced: 0.058, qPriced: 0.0035 }];
    const c = renderProfile(MADEIRA, TS, conv(), 'un_comtrade');
    expect(kpiSub(c, 'Preço médio implícito')).toBe('valor ÷ quantidade · apoiado em 0,03% do valor');
    expect(notaParcial(c)).toContain('Preço apoiado em parte do valor: 2022 (0,03%).');
  });
});
