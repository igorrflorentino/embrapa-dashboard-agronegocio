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
// qPriced), and a year whose price rests on less than 90% of its value says so; a describe
// locks it.
//
// Since v1.108.18 what a measure IS comes from the data (measure_kind), never from a missing
// value: soybean in 1974–1979 under IPCA was laid out as a herd, with a zero for every UF. The
// last describe locks the crop that stays a crop, the card that says why it has no value, and
// the absences that are no longer drawn as zeros.
//
// Unlike ViewProductProfile.cov.test.jsx, which stubs every helper to drive branches, this
// file runs the REAL unit modules (data.js, MetricConventions.jsx, UnitFamily.jsx,
// countUnits.js, seriesUtils.js, CollapsingNameList.jsx), so the strings asserted are the
// ones the screen prints. Only the composed widgets, applyFilters and fetch are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

let lineCharts;
let barCharts;

function stubWidgets(filtered) {
  window.applyFilters = () => filtered;
  window.bancoDim = () => ({ codeLabel: 'Código IBGE' });
  window.EmptyCard = ({ children }) => <div className="empty-card">{children}</div>;
  // NotApplicableNote with the real atom's rule (Atoms.jsx): nothing when every message is empty.
  window.NotApplicableNote = ({ note }) => {
    const msgs = note ? Object.values(note).filter(Boolean) : [];
    return msgs.length ? <div className="na-note">{msgs.join(' ')}</div> : null;
  };
  // The spark rides along as data: the real Sparkline draws an absent point as a zero.
  window.KpiCardSpark = ({ label, value, sub, spark }) => (
    <div className="kpi" data-spark={JSON.stringify(spark ?? null)}>
      <span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.SectionHeader = ({ overline, title }) => (
    <div className="sh"><span className="sh-overline">{overline}</span><span className="sh-title">{title}</span></div>
  );
  window.LineChart = (props) => { lineCharts.push(props); return <div className="line-chart" />; };
  window.BarChart = (props) => { barCharts.push(props); return <div className="bar-chart" />; };
}

beforeEach(async () => {
  lineCharts = [];
  barCharts = [];
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

describe('ViewProductProfile — the ficha técnica names the unit the source publishes (v1.108.19)', () => {
  // Until v1.108.19 a mass or a volume read "Unidade nativa: t (toneladas)" or "m³ (metros
  // cúbicos)": the family's BASE unit (prod.unit), whatever the source publishes. Measured on
  // prod 2026-11-27, the source's unit is a different one in 109 of the 243 mass and volume
  // products: kg in 55 COMEX ("QUILOGRAMA LIQUIDO"), 50 UN Comtrade ("Peso em quilogramas") and
  // 3 PPM ("Quilogramas"), and "Mil litros" in the PPM's milk. The products below and their
  // last two years are as the API serves them.
  const MANDIOCA = {
    code: '07141000', name: 'Raízes de mandioca, frescas, refrigeradas, congeladas ou secas',
    family: 'mass', unit: 't', unit_native: 'QUILOGRAMA LIQUIDO',
  };
  const MANDIOCA_TS = inteiro([{ y: 2025, v: 0.360454, q: 0.267598 }, { y: 2026, v: 0.326007, q: 0.243954 }]);
  const LEITE = { code: '2682', name: 'Leite', family: 'volume', unit: 'm³', measure_kind: 'flow', unit_native: 'Mil litros' };
  const LEITE_TS = inteiro([{ y: 2024, v: 87478.594, q: 35.722204 }, { y: 2025, v: 89486.968, q: 36.684313 }]);
  const MEL = { code: '2687', name: 'Mel de abelha', family: 'mass', unit: 't', measure_kind: 'flow', unit_native: 'Quilogramas' };
  const MEL_TS = inteiro([{ y: 2024, v: 1026.889, q: 68.235733 }, { y: 2025, v: 1216.929, q: 71.32902 }]);

  it('COMEX: MDIC publishes the mandioca in kg, and the quantity stays in the strip’s t', () => {
    const c = renderProfile(MANDIOCA, MANDIOCA_TS, conv(), 'mdic_comex');
    expect(ficha(c, 'Unidade nativa')).toBe('QUILOGRAMA LIQUIDO');
    expect(ficha(c, 'Família de unidade')).toBe('Massa');
    expect(kpi(c, 'Quantidade · Massa · t')).toBe('244 t'); // 0,243954 mil t
  });

  it('the native unit does not follow the strip: under kg the quantity changes, the ficha does not', () => {
    const c = renderProfile(MANDIOCA, MANDIOCA_TS, conv({ mass: 'kg' }), 'mdic_comex');
    expect(kpi(c, 'Quantidade · Massa · kg')).toBe('243.954 kg');
    expect(ficha(c, 'Unidade nativa')).toBe('QUILOGRAMA LIQUIDO');
  });

  it('PPM: the milk in "Mil litros" and the honey in "Quilogramas", as IBGE publishes them', () => {
    const leite = renderProfile(LEITE, LEITE_TS);
    expect(ficha(leite, 'Unidade nativa')).toBe('Mil litros');
    expect(kpi(leite, 'Quantidade · Volume · m³')).toBe('36.684.313 m³');
    cleanup();
    const mel = renderProfile(MEL, MEL_TS);
    expect(ficha(mel, 'Unidade nativa')).toBe('Quilogramas');
    expect(kpi(mel, 'Quantidade · Massa · t')).toBe('71.329 t');
  });

  it('a product served without a native unit shows the absence mark, never the family’s base', () => {
    const c = renderProfile({ ...MANDIOCA, unit_native: undefined }, MANDIOCA_TS, conv(), 'mdic_comex');
    expect(ficha(c, 'Unidade nativa')).toBe('—');
  });
});

describe('ViewProductProfile — a product whose unit family is unknown is drawn, and claims no unit (v1.108.19)', () => {
  // UN Comtrade, every reporter, measured on prod 2026-11-27: the rows of 440335 publish no
  // unit ("Sem unidade (N/A)"), so the API serves family 'desconhecida' and no quantity at all.
  // The registry has no such family, and the screen threw on its first lookup: "Cannot read
  // properties of undefined (reading 'long')" in place of the whole perspective.
  const TORAS = {
    code: '440335', name: 'Toras de Tiama, Mansonia, Ilomba, Dibetou, Limba e Azobé',
    family: 'desconhecida', unit: null, unit_native: 'Sem unidade (N/A)', tabela: 'hs',
  };
  const soValor = (y, v) => ({ y, v, q: null, vPriced: null, qPriced: null });
  const TORAS_TS = [soValor(2000, 0.003843248), soValor(2001, 0.020038311), soValor(2003, 0.559437),
    soValor(2004, 0.091174), soValor(2005, 0.283469727)];

  it('the ficha shows the source’s own words, and the family as not identified', () => {
    const c = renderProfile(TORAS, TORAS_TS, conv(), 'un_comtrade');
    expect(ficha(c, 'Unidade nativa')).toBe('Sem unidade (N/A)');
    expect(ficha(c, 'Família de unidade')).toBe('não identificada');
  });

  it('the quantity and the price have no number and borrow no unit: never "t"', () => {
    const c = renderProfile(TORAS, TORAS_TS, conv(), 'un_comtrade');
    expect(kpi(c, 'Quantidade · unidade não identificada')).toBe('—');
    expect(kpi(c, 'Preço médio implícito')).toBe('—');
    expect(titulos(c)).toContain('R$ por unidade não identificada · 2000–2005');
    expect(titulos(c)).toContain(`${TORAS.name} · quantidade (unidade não identificada)`);
    const rotulos = [...new Set(lineCharts.map((p) => p.label))];
    expect(rotulos).toEqual(expect.arrayContaining(['unidade não identificada', 'R$/unidade não identificada']));
    expect(rotulos).not.toContain('t');
    expect(rotulos).not.toContain('R$/t');
  });
});

describe('ViewProductProfile — mass and volume keep the strip’s unit, and the price follows it', () => {
  const SOJA = { code: '2713', name: 'Soja', family: 'mass', unit: 't', unit_native: 'Toneladas' };
  const SOJA_TS = inteiro([{ y: 2022, v: 280000, q: 140000 }, { y: 2023, v: 300000, q: 150000 }]); // 150 mi t, R$ 300 bi

  it('under t, the price is per t', () => {
    const c = renderProfile(SOJA, SOJA_TS, conv(), 'ibge_pam');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 2.000 /t');
    expect(ficha(c, 'Unidade nativa')).toBe('Toneladas'); // SIDRA's own label (v1.108.19)
  });

  it('under kg, the price is per kg — it read "/t" over a number computed per kg', () => {
    const c = renderProfile(SOJA, SOJA_TS, conv({ mass: 'kg' }), 'ibge_pam');
    expect(kpi(c, 'Preço médio implícito')).toBe('R$ 2 /kg');
    expect(titulos(c)).toContain('R$ por kg · 2022–2023');
    expect(lineCharts.map((p) => p.label)).toContain('R$/kg');
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

describe('ViewProductProfile — a product with no value in the window is still what it is (v1.108.18)', () => {
  // Measured on prod 2026-11-27 (/api/snapshot?banco=ibge_pam&currency=BRL&correction=IPCA):
  // soybean, in mil t and mi R$. IPCA reaches PAM only from 1980, and the snapshot's valueGap
  // says so, naming the index that does reach 1974–1979.
  const SOJA = { code: '40124', name: 'Soja (em grão)', family: 'mass', unit: 't', unit_native: 'Toneladas', tabela: '5457' };
  const S1978 = { y: 1978, v: null, q: 9540.577, vPriced: null, qPriced: null };
  const S1979 = { y: 1979, v: null, q: 10240.306, vPriced: null, qPriced: null };
  const S1980 = { y: 1980, v: 33417.87, q: 15155.804, vPriced: 33417.87, qPriced: 15155.804 };
  const S1981 = { y: 1981, v: 31466.44, q: 15007.367, vPriced: 31466.44, qPriced: 15007.367 };
  const GAP = {
    years: [1974, 1975, 1976, 1977, 1978, 1979], partial: [], months: {}, share: null,
    valuedRange: [1980, 2025], coveredBy: ['IGP-DI'],
  };
  const IPCA = () => ({ ...conv(), currency: 'BRL', correction: 'IPCA' });
  const VALOR = 'Valor · BRL · IPCA';
  const POR_QUE = 'sem valor em 1979 nesta convenção — a série do IPCA não alcança esse ano (o IGP-DI alcança)';
  const rotulos = (c) => [...c.querySelectorAll('.kpi-label')].map((e) => e.textContent);
  const spark = (c, label) => JSON.parse(kpiCard(c, label).getAttribute('data-spark'));
  const ufRows = (rows) => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ uf: rows }) }));
  };
  const uf = (sigla, value) => ({ uf: sigla, name: sigla, region: 'S', value, q_mass: 3.5, q_vol: 0, q_count: 0 });

  beforeEach(() => { window.dataStore = { get: () => ({ valueGap: GAP }) }; });
  afterEach(() => { delete window.dataStore; });

  it('soybean in 1978–1979 under IPCA keeps the cards of a crop, in t — never the herd’s', () => {
    const c = renderProfile(SOJA, [S1978, S1979], IPCA(), 'ibge_pam');
    expect(rotulos(c)).toEqual([VALOR, 'Quantidade · Massa · t', 'Preço médio implícito', 'Participação na cesta']);
    expect(kpi(c, VALOR)).toBe('—');
    // The v1.108.7 lock, kept: the quantity in t, never multiplied as a count.
    expect(kpi(c, 'Quantidade · Massa · t')).toBe('10.240.306 t');
    expect(kpi(c, 'Preço médio implícito')).toBe('—');
    expect(ficha(c, 'Tipo de medida')).toBeUndefined();
    expect(ficha(c, 'Valor (1979)')).toBe('—');
    expect(titulos(c)).toContain('Onde Soja (em grão) é produzido');
    expect(titulos(c).filter((t) => /efetivo|criado/.test(t))).toEqual([]);
    expect(c.textContent).not.toContain('O efetivo dos rebanhos');
    expect(nuas(c)).toEqual([]);
  });

  it('the value card says WHY it has no number, and draws no line of zeros', () => {
    const c = renderProfile(SOJA, [S1978, S1979], IPCA(), 'ibge_pam');
    expect(kpiSub(c, VALOR)).toBe(POR_QUE);
    expect(spark(c, VALOR)).toEqual([]);
  });

  it('the value, price and share charts say there is no value, instead of an empty axis', () => {
    // The labels drawn, once each: the UF read re-renders the screen.
    const desenhados = () => [...new Set(lineCharts.map((p) => p.label))];
    const c = renderProfile(SOJA, [S1978, S1979], IPCA(), 'ibge_pam');
    // Only the quantity is drawn; the three value charts would be empty plots under "R$".
    expect(desenhados()).toEqual(['t']);
    const avisos = [...c.querySelectorAll('.caption')]
      .filter((e) => e.textContent === 'Nenhum ano de 1978–1979 tem valor nesta convenção.');
    expect(avisos).toHaveLength(3);
    // One year with a value is enough for the charts to draw it.
    cleanup();
    lineCharts = [];
    renderProfile(SOJA, [S1979, S1980], IPCA(), 'ibge_pam');
    expect(desenhados()).toEqual(['R$', 't', 'R$/t', '% da cesta']);
  });

  it('a value in the last year and none the year before: the variation is refused, with the reason', () => {
    const c = renderProfile(SOJA, [S1979, S1980], IPCA(), 'ibge_pam');
    expect(kpi(c, VALOR)).not.toBe('—');
    expect(kpiSub(c, VALOR)).toBe(`1980 vs. 1979 · ${POR_QUE}`);
  });

  it('a sparkline carries only the years that have the measure: an absence is not drawn as a zero', () => {
    const c = renderProfile(SOJA, [S1978, S1979, S1980, S1981], IPCA(), 'ibge_pam');
    expect(spark(c, VALOR).map((d) => d.y)).toEqual([1980, 1981]);
    expect(spark(c, 'Preço médio implícito').map((d) => d.y)).toEqual([1980, 1981]);
    expect(spark(c, 'Participação na cesta').map((d) => d.y)).toEqual([1980, 1981]);
    // The quantity exists in every year, and its line keeps all four.
    expect(spark(c, 'Quantidade · Massa · t').map((d) => d.y)).toEqual([1978, 1979, 1980, 1981]);
  });

  it('no UF has a value in the window: no bar of zero, and the card says the ranking is by value', async () => {
    // On main the crop read as a herd, ranked the UFs on q_count — 0 for a crop — and drew
    // "PR 0, RS 0" under "Onde Soja (em grão) é criado".
    ufRows([uf('PR', null), uf('RS', null)]);
    const c = renderProfile(SOJA, [S1978, S1979], IPCA(), 'ibge_pam');
    await waitFor(() => expect(c.textContent)
      .toContain('Nenhuma UF tem valor nesta convenção em 1978–1979, e o ranking é pelo valor.'));
    expect(barCharts).toEqual([]);
    expect(c.textContent).not.toContain('Sem dados por UF');
  });

  it('a UF with no value is left out of the bars and named, never a bar of zero', async () => {
    ufRows([uf('PR', 3000), uf('AC', null), uf('RS', 2000)]);
    const c = renderProfile(SOJA, [S1980, S1981], IPCA(), 'ibge_pam');
    await waitFor(() => expect(barCharts.length).toBeGreaterThan(0));
    expect(barCharts[barCharts.length - 1].data.map((d) => d.uf)).toEqual(['PR', 'RS']);
    expect(c.textContent).toContain(
      'Sem valor nesta convenção: AC. Não têm valor nesta convenção em 1980–1981, por isso não entram no ranking por valor.');
  });
});
