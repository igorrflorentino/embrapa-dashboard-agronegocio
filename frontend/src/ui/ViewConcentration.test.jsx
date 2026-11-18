// ViewConcentration.test.jsx — render coverage for the concentration view (H3).
// It carries REAL math (Gini/HHI/top-N), so this exercises that computation end to
// end, and it confirms the P3 dead-code removal (the unused `conv`) didn't break
// rendering. Worked fixture: UF values [75, 25] → HHI = 75² + 25² = 6250, Gini =
// 0.25; product values [60, 40].

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
// The REAL RecorteNote, registered on window exactly as main.jsx loads it: it is a pure
// four-line component, and stubbing it away would hide the very disclosure these views
// exist to carry.
import './RecorteNote.jsx';
// The REAL count rule: which counts may be added, and what each one is called.
import './countUnits.js';

function stubGlobals(filtered) {
  window.applyFilters = () => filtered;
  // O stub tem de devolver '—' para ausente, como o fmtPct REAL: com `(x || 0)` ele
  // imprimia "0%" para null, e uma recusa aparecia como "0% de concentração" — a
  // afirmação oposta. Um stub que diverge do original não testa o original.
  window.fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  window.isCanonicalUf = () => true;
  window.dataStore = { meta: () => null };
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi" data-label={label}>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.SectionHeader = () => null;
  window.LorenzCurve = () => null;
  window.LoadErrorNote = ({ error }) => (error ? <div className="load-err">{String(error)}</div> : null);
}

let ViewConcentration;

beforeEach(async () => {
  await import('./ViewConcentration.jsx'); // registers window.ViewConcentration
  ViewConcentration = window.ViewConcentration;
});

afterEach(() => cleanup());

const FIXTURE = {
  ufDataFull: [
    { uf: 'PA', value: 75, real: true },
    { uf: 'SP', value: 25, real: true },
  ],
  ufData: [
    { uf: 'PA', value: 75, real: true },
    { uf: 'SP', value: 25, real: true },
  ],
  productTS: { P1: [{ y: 2020, v: 60 }], P2: [{ y: 2020, v: 40 }] },
  products: [
    { code: 'P1', name: 'Açaí' },
    { code: 'P2', name: 'Castanha' },
  ],
  yearEnd: 2020,
  ufLatestYear: 2020,
  ufYearPartial: false,
};

describe('ViewConcentration — Gini/HHI computation renders (H3)', () => {
  it('computes the geographic HHI and Gini from the UF distribution', () => {
    stubGlobals(FIXTURE);
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_pevs" />);
    const byLabel = (l) =>
      container.querySelector(`.kpi[data-label="${l}"] .kpi-value`)?.textContent;
    expect(byLabel('HHI · geográfico (UF)')).toBe('6.250'); // 75² + 25², pt-BR thousands
    expect(byLabel('Gini · geográfico (UF)')).toBe('0,25'); // [25,75] Gini
    expect(byLabel('Concentração nas 5 maiores UFs')).toBe('100%'); // both UFs cover the total
  });

  it('falls back to product-only KPIs when the banco has no geography', () => {
    stubGlobals({ ...FIXTURE, ufDataFull: [], ufData: [] });
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_pevs" />);
    // No geo → the product-distribution KPIs are shown instead (HHI 60² + 40² = 5200).
    const hhiProd = container.querySelector('.kpi[data-label="HHI · por produto"] .kpi-value');
    expect(hhiProd?.textContent).toBe('5.200');
  });
});

// A value-less herd basket (a stock, R$ 0 every year) must compute concentration on
// HEADCOUNT (q_count_stock) instead of an all-zero value — else Gini/HHI/Lorenz collapse.
// The count groups come from the REAL rule (countUnits.js), as applyFilters builds them.
const BOVINO = { code: 'P1', name: 'Bovino', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
const SUINO = { code: 'P2', name: 'Suíno', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
const OVOS = { code: 'P3', name: 'Ovos de galinha', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
const herdFixture = (products) => {
  const codes = products.map((p) => p.code);
  return {
    // The eggs' total is the LARGER one on purpose (as in Mato Grosso, where 3,80 bi eggs
    // sit beside 80,4 mi heads): a fallback that read it, or added it, would show it.
    ufDataFull: [
      { uf: 'MT', value: 0, q_count_stock: 75, q_count_flow: 100, real: true },
      { uf: 'SP', value: 0, q_count_stock: 25, q_count_flow: 900, real: true },
    ],
    ufData: [
      { uf: 'MT', value: 0, q_count_stock: 75, q_count_flow: 100, real: true },
      { uf: 'SP', value: 0, q_count_stock: 25, q_count_flow: 900, real: true },
    ],
    productTS: {
      P1: [{ y: 2020, v: 0, q: 60 }], P2: [{ y: 2020, v: 0, q: 40 }], P3: [{ y: 2020, v: 0, q: 1000 }],
    },
    products,
    selectedProducts: codes,
    countGroups: window.countGroups(products, codes),
    yearEnd: 2020,
    ufLatestYear: 2020,
    ufYearPartial: false,
  };
};

describe('ViewConcentration — value-less herd falls back to cabeças', () => {
  const byLabelIn = (container) => (l) =>
    container.querySelector(`.kpi[data-label="${l}"] .kpi-value`)?.textContent;

  it('computes geographic Gini/HHI on the herd when the basket has no value', () => {
    stubGlobals(herdFixture([BOVINO, SUINO]));
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_ppm" />);
    const byLabel = byLabelIn(container);
    // same [75,25] distribution as the value case, now read from q_count_stock → HHI 6250, Gini 0,25
    expect(byLabel('HHI · geográfico (UF)')).toBe('6.250');
    expect(byLabel('Gini · geográfico (UF)')).toBe('0,25');
    // the onCount note explains the basis is headcount, not value
    expect(container.textContent).toContain('efetivo dos rebanhos');
    expect(container.textContent).toContain('cabeças');
  });

  it('reads the herd alone beside the eggs, and names the eggs it leaves out', () => {
    stubGlobals(herdFixture([BOVINO, SUINO, OVOS]));
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_ppm" />);
    const byLabel = byLabelIn(container);
    // [75,25] again: the eggs ([100,900]) never enter, and heads + eggs ([175,925]) is no measure.
    expect(byLabel('HHI · geográfico (UF)')).toBe('6.250');
    expect(container.textContent).toContain('Fora desta leitura: Ovos de galinha');
    // The eggs HAVE value, just not in this convention: the note must not call the whole
    // basket value-less by nature.
    expect(container.textContent).not.toContain('não tem valor monetário');
    expect(container.textContent).toContain('não tem valor nesta convenção');
  });

  it('the product distribution ranks only the products of the group it reads', () => {
    // No geography: the product KPIs carry the reading. Herd only → 60² + 40² = 5200.
    // With the eggs (q 1000) it would be 1000/1100 of one product, an HHI of ~8.300.
    stubGlobals({ ...herdFixture([BOVINO, SUINO, OVOS]), ufDataFull: [], ufData: [] });
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_ppm" />);
    expect(byLabelIn(container)('HHI · por produto')).toBe('5.200');
  });
});

describe('ViewConcentration — conjunto vazio não é "0% de concentração"', () => {
  it('a concentração top-N RECUSA quando não há nada a concentrar', () => {
    // `hasGeo` só exige LINHAS de UF, não valores positivos: um recorte cujos produtos
    // não produzem nada em UF alguma chega aqui com a lista cheia e os valores zerados.
    // `topNShare` fazia `total = 0 || 1` e devolvia 0/1 = 0 → "0%", que se lê como
    // "nada concentrado" — a afirmação OPOSTA de "não há dado".
    //
    // A regra certa já existia 20 linhas acima, no mesmo arquivo: o HHI devolve `null`
    // e o comentário dele explica exatamente este raciocínio ("um sinal de tudo-certo
    // sobre nada"). O Gini recusa com "n/d". Só o top-N não tinha recebido a regra.
    stubGlobals({
      ...FIXTURE,
      ufDataFull: [{ uf: 'PA', value: 0, real: true }, { uf: 'SP', value: 0, real: true }],
      ufData: [{ uf: 'PA', value: 0, real: true }, { uf: 'SP', value: 0, real: true }],
      productTS: { P1: [{ y: 2020, v: 0 }], P2: [{ y: 2020, v: 0 }] },
    });
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_pevs" />);
    const byLabel = (l) =>
      container.querySelector(`.kpi[data-label="${l}"] .kpi-value`)?.textContent;
    expect(byLabel('Concentração nas 5 maiores UFs')).toBe('—');
    expect(byLabel('Concentração nos 3 maiores produtos')).toBe('—');
    // E os vizinhos seguem recusando como já recusavam — a mudança não os altera.
    expect(byLabel('HHI · geográfico (UF)')).toBe('n/d');
    expect(byLabel('Gini · geográfico (UF)')).toBe('n/d');
  });

  it('com um único produtor, 100% é a resposta CERTA — não uma recusa', () => {
    // O piso é sobre a AUSÊNCIA de base, não sobre base pequena: um recorte com uma UF
    // só está de fato 100% concentrado nela, e recusar aqui perderia a informação.
    stubGlobals({
      ...FIXTURE,
      ufDataFull: [{ uf: 'PA', value: 42, real: true }],
      ufData: [{ uf: 'PA', value: 42, real: true }],
    });
    const { container } = render(<ViewConcentration summary={{}} conventions={{}} database="ibge_pevs" />);
    expect(
      container.querySelector('.kpi[data-label="Concentração nas 5 maiores UFs"] .kpi-value')?.textContent,
    ).toBe('100%');
  });
});

// ── Sob um recorte sub-UF (v1.108.2) ───────────────────────────────────────────────────
// While the recorte loaded, or after it failed, the UF grid was EMPTY for want of data, and
// the strip read "n/d · sem dados" and "de 0 UFs com produção" — a measurement of an empty
// recorte. The product half, meanwhile, read the NATIONAL per-product series under the
// recorte's chip. Now the geographic half waits ("…") or says it failed ("—"), and the
// product half is the recorte's own products in one year (recorteProducts.js).
describe('ViewConcentration — under a sub-UF recorte', () => {
  const kpi = (c, l) => c.querySelector(`.kpi[data-label="${l}"]`);
  const valor = (c, l) => kpi(c, l).querySelector('.kpi-value').textContent;
  const sub = (c, l) => kpi(c, l).querySelector('.kpi-sub').textContent;
  const TODOS = ['Gini · geográfico (UF)', 'HHI · geográfico (UF)',
    'Concentração nas 5 maiores UFs', 'Concentração nos 3 maiores produtos'];
  const RECORTE = {
    ...FIXTURE,
    yearStart: 2019,
    subUfRequested: true, subUfLoaded: true, subUfLoading: false, subUfLoadError: null,
    muniYearlySeries: [{ year: 2020, cityCode: 1505809, uf: 'PA', value: 1 }],
  };
  const LIDO = (products) => ({ products, loading: false, unavailable: false, loadError: null });
  let pbm;
  const renderWith = (extra, read = LIDO([])) => {
    stubGlobals({ ...RECORTE, ...extra });
    window.SectionHeader = ({ overline, title }) => (
      <div className="sh"><span className="sh-ov">{overline}</span><span className="sh-title">{title}</span></div>
    );
    pbm = vi.fn(() => read);
    window.productsByMunicipio = pbm;
    return render(
      <ViewConcentration summary={{ munis: ['1505809'] }} conventions={{}} database="ibge_pevs" />,
    ).container;
  };
  afterEach(() => { delete window.productsByMunicipio; });

  it('on its way: every number waits with "…", and nothing reads as an empty recorte', () => {
    const c = renderWith({ subUfLoaded: false, subUfLoading: true, ufData: [], muniYearlySeries: [] });
    for (const l of TODOS) expect(valor(c, l)).toBe('…');
    expect(sub(c, 'HHI · geográfico (UF)')).toBe('carregando o recorte sub-UF…');
    expect(sub(c, 'Concentração nos 3 maiores produtos')).toBe('carregando os produtos do recorte…');
    expect(c.textContent).not.toMatch(/sem dados|n\/d|de 0 UFs/);
    expect(c.textContent).toContain('Carregando o recorte territorial…');
    expect(c.querySelector('.load-err')).toBeNull();
    expect(pbm).not.toHaveBeenCalled();
  });

  it('failed: "—" everywhere, the error noted once, and nothing says it is still coming', () => {
    const c = renderWith({ subUfLoaded: false, subUfLoadError: 'HTTP 503', ufData: [], muniYearlySeries: [] });
    for (const l of TODOS) expect(valor(c, l)).toBe('—');
    expect(sub(c, 'Gini · geográfico (UF)')).toBe('recorte sub-UF não carregado');
    expect(sub(c, 'Concentração nos 3 maiores produtos')).toBe('recorte sub-UF não carregado');
    expect(c.querySelectorAll('.load-err')).toHaveLength(1);
    expect(c.textContent).not.toMatch(/sem dados|n\/d|[Cc]arregando/);
  });

  it('resolved: the product half is the recorte’s own products, in its year', () => {
    const c = renderWith({}, LIDO([
      { code: 'P1', name: 'Açaí', value: 90, q_count: null },
      { code: 'P2', name: 'Castanha', value: 10, q_count: null },
    ]));
    // Gini [10, 90] = 0,40 — the national FIXTURE.productTS [60, 40] would give 0,10.
    expect(c.textContent).toContain('Desigualdade entre produtos · Gini 0,40');
    expect(sub(c, 'Concentração nos 3 maiores produtos')).toBe('de 2 produtos no recorte');
    expect(c.textContent).toContain('Curva de Lorenz · por produto · 2020 · municípios do recorte');
    // The geographic half is the recorte's grid, shown as measured.
    expect(valor(c, 'HHI · geográfico (UF)')).toBe('6.250');
  });

  it.each([
    ['failed', { products: [], loading: false, unavailable: false, loadError: 'HTTP 500' },
      '—', 'produtos do recorte não carregados'],
    ['refused by the banco', { products: [], loading: false, unavailable: true, loadError: null },
      '—', 'sem composição por produto abaixo da UF'],
    ['on its way', { products: [], loading: true, unavailable: false, loadError: null },
      '…', 'carregando os produtos do recorte…'],
  ])('the products read %s holds the product half only', (_estado, read, marca, motivo) => {
    const c = renderWith({}, read);
    expect(valor(c, 'Concentração nos 3 maiores produtos')).toBe(marca);
    expect(sub(c, 'Concentração nos 3 maiores produtos')).toBe(motivo);
    expect(c.textContent).toContain(`Desigualdade entre produtos · Gini ${marca}`);
    expect(valor(c, 'HHI · geográfico (UF)')).toBe('6.250'); // the recorte's grid is in
  });

  it('measured empty: the recorte has no product of the basket — a real answer', () => {
    const c = renderWith({}, LIDO([]));
    expect(valor(c, 'Concentração nos 3 maiores produtos')).toBe('—');
    expect(sub(c, 'Concentração nos 3 maiores produtos')).toBe('de 0 produtos no recorte');
    expect(c.querySelector('.load-err')).toBeNull();
  });

  it('the basket note says whether the UF split is on its way or failed', () => {
    let c = renderWith({ subUfRequested: false, notFilteredByBasket: true, basketGeoLoadError: null });
    expect(c.textContent).toContain('a distribuição por UF da cesta selecionada ainda está carregando');
    cleanup();
    c = renderWith({ subUfRequested: false, notFilteredByBasket: true, basketGeoLoadError: 'HTTP 503' });
    expect(c.textContent).toContain('não foi possível carregar a distribuição por UF da cesta selecionada');
  });
});
