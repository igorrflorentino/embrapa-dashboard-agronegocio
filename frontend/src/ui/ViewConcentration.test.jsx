// ViewConcentration.test.jsx — render coverage for the concentration view (H3).
// It carries REAL math (Gini/HHI/top-N), so this exercises that computation end to
// end, and it confirms the P3 dead-code removal (the unused `conv`) didn't break
// rendering. Worked fixture: UF values [75, 25] → HHI = 75² + 25² = 6250, Gini =
// 0.25; product values [60, 40].

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
