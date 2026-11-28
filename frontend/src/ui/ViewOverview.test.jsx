// ViewOverview.test.jsx — render coverage for the overview digest (H3). It also
// locks two P0 details: the "X de N flags" denominator reads window.QUALITY_FLAGS
// (now 11 flags — 5 base + 4 outlier/problemático + 2 reserved inferred tiers — not the 6 prototype ones),
// and the mass/volume quantity
// KPIs render off q_mass/q_vol. We import the real data.js for the registry and
// stub the composed window.* widgets/formatters (distinctive prefixes so the KPI
// values are unambiguous in the DOM).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
// The REAL slicing rule (window.compositionSlices): the recorte's donut must slice a basket
// exactly as the national one does. Loaded once; each test still stubs applyFilters.
import './dataFilters.js';
// The REAL RecorteNote, registered on window exactly as main.jsx loads it: it is a pure
// four-line component, and stubbing it away would hide the very disclosure these views
// exist to carry.
import './RecorteNote.jsx';
// O registro REAL de tabelas + `labelProductRows` (filtersSchema.js). A chamada na view é
// DELIBERADAMENTE incondicional: um helper ausente tem de estourar, não voltar a rotular
// duas metades do PEVS com o mesmo nome em silêncio.
import './filtersSchema.js';
// The REAL count rule: which counts may be added, and what each one is called.
import './countUnits.js';

function stubGlobals(filtered) {
  window.applyFilters = () => filtered;
  window.DEFAULT_CONVENTIONS = { currency: 'BRL', correction: 'IPCA' };
  window.conventionMonetaryLabel = () => 'R$';
  window.valueAxisLabel = () => 'R$';
  window.canonCurrencyFor = () => 'BRL';
  window.convFactorFor = () => 1;
  window.formatValue = (v) => `val:${v}`;
  window.formatMassQty = (v) => `mass:${v}`;
  window.formatVolumeQty = (v) => `vol:${v}`;
  // The unit rides in the text: a count must say WHAT it counts (countUnits.js).
  window.formatCountQty = (v, _conv, unit) => (unit ? `count:${v} ${unit}` : `count:${v}`);
  window.fmtSigned = () => '+0%';
  window.fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
  window.convertSeries = (s) => s;
  window.scaleSeries = (data, _max, _conv, _key, label) => ({ data, label });
  window.isCanonicalUf = () => true;
  window.dataStore = { meta: () => null };
  // Widgets: KPI card renders its label + value so we can read them.
  // `sub` incluído: desde a v1.56.0 ele carrega informação (a cobertura em VALOR),
  // não só decoração — um stub que o descartasse tornaria o card não-testável.
  window.KpiCardSpark = ({ label, value, sub }) => (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
  window.SectionHeader = ({ title, action }) => (
    <div className="sh">
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  window.UnitFamilyBanner = () => null;
  window.UnitFamilyTag = () => null;
  window.LineChart = () => null;
  // Expõe os rótulos que o Donut recebeu: é o que o defeito das duas metades corrompia.
  window.Donut = (props) => (
    <div className="donut" data-rotulos={(props.data || []).map((d) => d.name).join('|')} />
  );
  window.BrazilTileMap = () => null;
}

let ViewOverview;

beforeEach(async () => {
  await import('./data.js'); // sets window.QUALITY_FLAGS to the REAL 14-flag taxonomy
  await import('./ViewOverview.jsx'); // registers window.ViewOverview
  ViewOverview = window.ViewOverview;
});

afterEach(() => cleanup());

const FIXTURE = {
  ts: [
    // The count in its two totals (dataFilters): the herd's heads and the counted production.
    { y: 2019, v: 1, q_mass: 100, q_vol: 10, q_count_stock: 30, q_count_flow: 1000 },
    { y: 2020, v: 2, q_mass: 200, q_vol: 20, q_count_stock: 31.6, q_count_flow: 2000 },
  ],
  qualityFlags: [
    { id: 'OK', label: 'OK', color: 'var(--ok)', share: 0.8, count: 800000 },
    { id: 'INCOMPLETE', label: 'Sem valor nem quantidade', color: 'var(--viz-7)', share: 0.2, count: 200000 },
  ],
  qualityTs: [{ y: 2020, ok: 0.8 }],
  ufData: [{ uf: 'PA', value: 5, real: true }],
  ufDataFull: [{ uf: 'PA', value: 5, real: true }],
  selectedProducts: ['P1'],
  productsTotal: 3,
  topProducts: [{ code: 'P1', name: 'Açaí', share: 1 }],
  yearStart: 2019,
  yearEnd: 2020,
  ufLatestYear: 2020,
  ufYearPartial: false,
  notFilteredByBasket: false,
  geoComboPending: false,
  // The coverage count applyFilters makes once for the hero and this card (v1.108.21).
  ufsCovered: 1,
  ufsCoveredLoading: false,
  ufsCoveredLoadError: null,
  ufsTotal: 1,
};

// Count products as the PPM serves them (unit_native as SIDRA publishes it). The count
// groups come from the REAL rule (countUnits.js), as applyFilters builds them.
const BOVINO = { code: '2670', name: 'Bovino', family: 'count', measure_kind: 'stock', unit_native: 'Cabeças' };
const OVOS = { code: '2685', name: 'Ovos de galinha', family: 'count', measure_kind: 'flow', unit_native: 'Mil dúzias' };
const ABACAXI = { code: '40092', name: 'Abacaxi', family: 'count', unit_native: 'Mil frutos' };
const withCounts = (products) => {
  const codes = products.map((p) => p.code);
  return { ...FIXTURE, products, selectedProducts: codes, countGroups: window.countGroups(products, codes) };
};

describe('ViewOverview — KPI strip + quality digest (H3 + P0 lock-in)', () => {
  it('renders mass AND volume quantity KPIs off q_mass/q_vol when both families present', () => {
    stubGlobals(FIXTURE);
    const { container } = render(
      <ViewOverview families={['mass', 'volume']} summary={{}} database="ibge_pevs" conventions={{}} />
    );
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(values).toContain('mass:200'); // latest q_mass via formatMassQty
    expect(values).toContain('vol:20'); // latest q_vol via formatVolumeQty
  });

  it('the quality digest denominator counts the REAL registry (14 marcas)', () => {
    stubGlobals(FIXTURE);
    const { container } = render(
      <ViewOverview families={['mass']} summary={{}} database="ibge_pevs" conventions={{}} />
    );
    // "{qualityFlags.length} de {QUALITY_FLAGS.length} marcas" → "2 de 14 marcas". 14 = the 5
    // base flags + the 4 outlier/problemático tiers + the 2 reserved inferred tiers + the
    // PAM-only AREA_INCONSISTENT + UNSCORED + the IBGE ISOLATED_SPIKE (all in the registry
    // regardless of the dbt var / pipeline state). "marcas", not "flags" (v1.108.3): the
    // editorial vocabulary's word for a quality tag on screen.
    expect(container.textContent).toContain('de 14 marcas');
    expect(container.textContent).not.toContain('de 6 marcas'); // the old prototype count
    expect(container.textContent).not.toMatch(/\bflags\b/);
  });

  it('o card de qualidade mostra a cobertura em VALOR ao lado da de linhas', () => {
    // Sem isso o card conta metade da história. Números reais do PEVS em produção
    // (2026-09-07): 18,2% das LINHAS examinadas e 99,3% do VALOR — o que o detector pula
    // são células vazias do cubo do IBGE e remessas abaixo do piso, numerosas e
    // economicamente irrelevantes. Só a fração de linhas diria que dois terços do acervo
    // não foram examinados: verdade sobre as LINHAS, falso sobre o ASSUNTO.
    stubGlobals({
      ...FIXTURE,
      qualityFlags: [
        { id: 'OK', label: 'Sem ressalva', share: 0.182, count: 246412, valueShare: 0.993 },
        { id: 'UNSCORED', label: 'Sem base para avaliar', share: 0.816, count: 1103462, valueShare: 0.007 },
      ],
    });
    const { container } = render(
      <ViewOverview families={['mass']} summary={{}} database="ibge_pevs" conventions={{}} />
    );
    const card = [...container.querySelectorAll('.kpi')].find(
      (e) => /examinadas sem ressalva/i.test(e.textContent));
    expect(card, 'card de qualidade não encontrado').toBeTruthy();
    // O NÚMERO, não só o texto: "examinado" SOMA as flags que o detector rodou —
    // OK + atípicas + problemáticas —, porque uma linha marcada também passou pelo
    // exame. Usar só o valueShare do OK daria 99,3% → 79,1% e poria um número sob um
    // rótulo que nomeia outra coisa. (Neste recorte, com só OK e UNSCORED presentes,
    // a soma coincide com 1 − UNSCORED; o teste seguinte separa as duas contas.)
    // (o stub de fmtPct neste arquivo arredonda para inteiro — 99%, não 99,3%)
    expect(card.textContent).toContain('99% do valor examinado');
    expect(card.textContent).toContain('82% das linhas sem base para avaliar');
    // A asserção que realmente prende o defeito: 79% é o valueShare do OK, e usá-lo
    // subestimaria a cobertura porque exclui as linhas EXAMINADAS e marcadas.
    expect(card.textContent).not.toContain('79%');
  });

  it('"valor examinado" soma as flags EXAMINADAS — não é o complemento do não avaliado', () => {
    // As duas contas divergem sempre que existe uma flag que não é UNSCORED e também
    // nunca passou pelo detector: incompleto, valor/quantidade/peso ausente, área
    // inconsistente. No COMTRADE em produção são 25.630 linhas com valor e sem
    // quantidade — 0,893% do valor. O complemento as contava como examinadas.
    stubGlobals({
      ...FIXTURE,
      qualityFlags: [
        { id: 'OK', label: 'Sem ressalva', share: 0.337, count: 693055, valueShare: 0.835 },
        { id: 'UNSCORED', label: 'Sem base para avaliar', share: 0.646, count: 1327364, valueShare: 0.032 },
        { id: 'MISSING_QUANTITY', label: 'Sem quantidade', share: 0.012, count: 25630, valueShare: 0.009 },
        { id: 'OUTLIER_VALUE', label: 'Valor atípico', share: 0.002, count: 3692, valueShare: 0.115 },
      ],
    });
    const { container } = render(
      <ViewOverview families={['mass']} summary={{}} database="un_comtrade" conventions={{}} />
    );
    const card = [...container.querySelectorAll('.kpi')].find(
      (e) => /examinadas sem ressalva/i.test(e.textContent));
    // 0,835 + 0,115 = 0,95 → 95%. O complemento (1 − 0,032 = 0,968) daria 97%, varrendo
    // para dentro do "examinado" as 25.630 linhas que o detector nunca olhou.
    expect(card.textContent).toContain('95% do valor examinado');
    expect(card.textContent).not.toContain('97% do valor examinado');
  });

  it('renders the count KPI off q_count_flow, named by what it counts (ovos, never cabeças)', () => {
    stubGlobals(withCounts([OVOS]));
    const { container } = render(
      <ViewOverview families={['count']} summary={{}} database="ibge_ppm" conventions={{}} />
    );
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(values).toContain('count:2000 ovos'); // latest q_count_flow, in eggs (keystone)
    expect(values).not.toContain('mass:200'); // mass KPI absent — no mass family in the basket
  });

  it('the herd gets no headline: heads do not add across species, and the strip points to Rebanho', () => {
    stubGlobals(withCounts([BOVINO]));
    const { container } = render(
      <ViewOverview families={['count']} summary={{}} database="ibge_ppm" conventions={{}} />
    );
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(values.some((v) => v.startsWith('count:'))).toBe(false);
    expect(container.textContent).toContain('Rebanho'); // redirect note instead
  });

  it('a herd beside the eggs no longer hides them, and never enters their figure', () => {
    // Until v1.108.0 the headline read the whole count family (herd + eggs), so a herd in
    // the basket hid it. It reads only the counted production now.
    stubGlobals(withCounts([BOVINO, OVOS]));
    const { container } = render(
      <ViewOverview families={['count']} summary={{}} database="ibge_ppm" conventions={{}} />
    );
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(values).toContain('count:2000 ovos'); // q_count_flow alone
    expect(values).not.toContain('count:2031.6 ovos'); // never heads + eggs
    expect(container.textContent).toContain('Rebanho');
  });

  it('products that count different things get no headline, and the strip names them', () => {
    // No banco holds eggs and counted fruits together today; this proves the refusal.
    stubGlobals(withCounts([OVOS, ABACAXI]));
    const { container } = render(
      <ViewOverview families={['count']} summary={{}} database="ibge_ppm" conventions={{}} />
    );
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(values.some((v) => v.startsWith('count:'))).toBe(false);
    expect(container.textContent).toContain('Contagens que não se somam');
    expect(container.textContent).toContain('Abacaxi (frutos)');
    expect(container.textContent).toContain('Ovos de galinha (ovos)');
  });

  it('a value-less basket maps ONE count, the herd, and names the eggs it leaves out', () => {
    let mapa = null;
    stubGlobals({
      ...withCounts([BOVINO, OVOS]),
      ts: [
        { y: 2019, v: 0, q_mass: 0, q_vol: 0, q_count_stock: 30, q_count_flow: 1000 },
        { y: 2020, v: 0, q_mass: 0, q_vol: 0, q_count_stock: 31.6, q_count_flow: 2000 },
      ],
      // Mato Grosso 2025 as measured on prod: 80,4 mi heads, 3,80 bi eggs (mi un).
      ufData: [{ uf: 'MT', value: 0, real: true, q_count_stock: 80.4, q_count_flow: 3803.2 }],
      ufDataFull: [{ uf: 'MT', value: 0, real: true, q_count_stock: 80.4, q_count_flow: 3803.2 }],
    });
    window.countQtyMul = () => 1e6; // mi un → un, the convention's 'un'
    window.BrazilTileMap = (props) => { mapa = props; return null; };
    const { container } = render(
      <ViewOverview families={['count']} summary={{}} database="ibge_ppm" conventions={{}} />
    );
    expect(mapa.label).toBe('cabeças');
    expect(mapa.data.map((u) => u.value)).toEqual([80.4e6]); // the herd alone, never + the eggs
    expect(container.textContent).toContain('Efetivo por UF · cabeças');
    expect(container.textContent).toContain('Fora desta leitura: Ovos de galinha');
    delete window.countQtyMul;
  });

  it('o Donut não mostra duas fatias com o MESMO rótulo quando o nome se repete', () => {
    // Madeira em tora existe nas DUAS tabelas do PEVS com o mesmo nome. O Donut usa índice
    // como chave, então não FUNDE as fatias — mas mostrava "Madeira em tora 57%" e
    // "Madeira em tora 7%", e o leitor não tinha como saber qual metade era qual.
    // A desambiguação vem da tabela, que é o terceiro componente da identidade do produto.
    stubGlobals({
      ...FIXTURE,
      topProducts: [
        { code: '3457', name: 'Madeira em tora', tabela: '291', share: 0.57 },
        { code: '3435', name: 'Madeira em tora', tabela: '289', share: 0.07 },
        { code: '3403', name: 'Açaí (fruto)', tabela: '289', share: 0.02 },
      ],
    });
    const { container } = render(
      <ViewOverview families={['mass']} summary={{}} database="ibge_pevs" conventions={{}} />
    );
    const rotulos = container.querySelector('.donut').getAttribute('data-rotulos').split('|');
    expect(new Set(rotulos).size, `rótulos repetidos: ${rotulos}`).toBe(rotulos.length);
    expect(rotulos).toEqual([
      'Madeira em tora · silvicultura',
      'Madeira em tora · extração',
      'Açaí (fruto)',   // nome único → sem sufixo
    ]);
  });

  it('omits the volume KPI when the banco has no volume family', () => {
    stubGlobals(FIXTURE);
    const { container } = render(
      <ViewOverview families={['mass']} summary={{}} database="ibge_pevs" conventions={{}} />
    );
    const values = [...container.querySelectorAll('.kpi-value')].map((e) => e.textContent);
    expect(values).toContain('mass:200');
    expect(values).not.toContain('vol:20');
  });
});

// ── Um recorte sub-UF a caminho ou que falhou segura os números (v1.108.1) ───────────────
// While the narrowing loads, or after it failed, applyFilters' series is the NATIONAL one:
// shown under the sub-UF chip, it would be data the filter excludes. Pending holds with
// "…"; a failure holds with "—" and says why. Until v1.108.1 a failure read as pending,
// and the strip said "cruzando produto × UF…" for good.
describe('ViewOverview — a sub-UF narrowing on its way or failed holds the numbers', () => {
  const quantityCards = (c) => [...c.querySelectorAll('.kpi')]
    .filter((k) => /Valor total|Quantidade/.test(k.querySelector('.kpi-label').textContent));
  const renderWith = (extra) => {
    stubGlobals({ ...FIXTURE, ...extra });
    window.LoadErrorNote = ({ error }) => (error ? <div className="load-err" role="alert">{String(error)}</div> : null);
    return render(
      <ViewOverview families={['mass', 'volume']} summary={{}} database="ibge_pevs" conventions={{}} />,
    ).container;
  };
  afterEach(() => { delete window.LoadErrorNote; });

  it('pending: every number is "…", and the series card says it is crossing the filters', () => {
    // applyFilters holds the coverage count too, exactly then (v1.108.21).
    const c = renderWith({ geoComboPending: true, subUfLoading: true,
      ufsCovered: null, ufsCoveredLoading: true });
    const cards = quantityCards(c);
    expect(cards).toHaveLength(3);
    for (const k of cards) {
      expect(k.querySelector('.kpi-value').textContent).toBe('…');
      expect(k.querySelector('.kpi-sub').textContent).toBe('cruzando produto × UF…');
    }
    expect(c.textContent).toContain('Variação acumulada: …');
    expect(c.textContent).toContain('Cobertura geográfica da seleção: … /');
    expect(c.querySelector('.load-err')).toBeNull();
  });

  it('failed: every number is "—", the series card alerts, and nothing says it is still coming', () => {
    const c = renderWith({ geoComboPending: false, subUfLoadError: 'HTTP 503',
      ufsCovered: null, ufsCoveredLoadError: 'HTTP 503' });
    for (const k of quantityCards(c)) {
      expect(k.querySelector('.kpi-value').textContent).toBe('—');
      expect(k.querySelector('.kpi-sub').textContent).toBe('recorte sub-UF não carregado');
    }
    expect(c.textContent).toContain('Variação acumulada: —');
    // The empty grid of an unresolved recorte would count "0" UFs: a claim about the data.
    expect(c.textContent).toContain('Cobertura geográfica da seleção: — /');
    expect(c.querySelector('.load-err')).not.toBeNull();
    expect(c.textContent).not.toMatch(/[Cc]ruzando/);
  });

  it('counter-proof: resolved, the same fixture shows its numbers', () => {
    const c = renderWith({});
    // The latest value through formatValue (bi → absolute reais), not a hold mark.
    expect(quantityCards(c)[0].querySelector('.kpi-value').textContent).toBe('val:2000000000');
    expect(c.textContent).toContain('Cobertura geográfica da seleção: 1 /');
    expect(c.querySelector('.load-err')).toBeNull();
  });
});

// ── Sob um recorte sub-UF, a composição e o mapa são os do recorte (v1.108.2) ─────────────
// Portel + Breves (PA) on PPM, as measured in production: the donut showed the COUNTRY's
// Leite 70% / Ovos de galinha 28% while the recorte loaded, after it failed and once it had
// loaded; the tile map was blank while it loaded and drew an "R$ 0 – 0" legend after it
// failed. The composition now reads the recorte's own products (recorteProducts.js) for ONE
// year, and every state of that read says what it is.
describe('ViewOverview — under a sub-UF recorte the composition and the map are the recorte’s', () => {
  const NACIONAL = [
    { code: 'L', name: 'Leite', share: 0.7 }, { code: 'O', name: 'Ovos de galinha', share: 0.28 },
  ];
  const RECORTE = {
    ...FIXTURE,
    topProducts: NACIONAL,   // the national composition, which must NOT reach the donut
    subUfRequested: true, subUfLoaded: true, subUfLoading: false, subUfLoadError: null,
    muniYearlySeries: [
      { year: 2019, cityCode: 1505809, uf: 'PA', value: 1 },
      { year: 2020, cityCode: 1505809, uf: 'PA', value: 1 },
    ],
  };
  const LIDO = (products) => ({ products, loading: false, unavailable: false, loadError: null });
  const donut = (c) => c.querySelector('.donut');
  const rotulos = (c) => donut(c).getAttribute('data-rotulos').split('|');
  const fatias = (c) => donut(c).getAttribute('data-fatias').split('|').map(Number);
  const cartao = (c, overline) => [...c.querySelectorAll('.card')]
    .find((k) => (k.querySelector('.sh-ov') || {}).textContent?.startsWith(overline));
  let pbm;
  const renderWith = (extra, read = LIDO([])) => {
    stubGlobals({ ...RECORTE, ...extra });
    window.LoadErrorNote = ({ error }) => (error ? <div className="load-err" role="alert">{String(error)}</div> : null);
    window.SectionHeader = ({ overline, title, action }) => (
      <div className="sh">
        <span className="sh-ov">{overline}</span>
        <span className="sh-title">{title}</span>
        <span className="sh-action">{action}</span>
      </div>
    );
    window.Donut = (props) => (
      <div className="donut" data-rotulos={(props.data || []).map((d) => d.name).join('|')}
           data-fatias={(props.data || []).map((d) => d.share).join('|')} />
    );
    window.BrazilTileMap = () => <div className="tilemap" />;
    pbm = vi.fn(() => read);
    window.productsByMunicipio = pbm;
    return render(
      <ViewOverview families={['mass']} summary={{ munis: ['1505809'] }} database="ibge_ppm" conventions={{}} />,
    ).container;
  };
  afterEach(() => { delete window.LoadErrorNote; delete window.productsByMunicipio; });

  it('loaded: the slices are the recorte’s products in its year — never the national shares', () => {
    const c = renderWith({}, LIDO([
      { code: 'L', name: 'Leite', measure_kind: 'flow', value: 1 },
      { code: 'M', name: 'Mel de abelha', measure_kind: 'flow', value: 3 },
      { code: 'B', name: 'Bovino', measure_kind: 'stock', value: null }, // a herd is no slice
    ]));
    expect(rotulos(c)).toEqual(['Mel de abelha', 'Leite']);
    expect(fatias(c)).toEqual([0.75, 0.25]);
    expect(cartao(c, 'Composição')).toBeTruthy();
    expect(c.textContent).toContain('Composição · 2020 · municípios do recorte');
    // One read, for the recorte's year and the cities that recorded the basket in it.
    expect(pbm.mock.calls[0][1]).toMatchObject({ startDate: '2020-01-01', endDate: '2020-12-01' });
    expect(pbm.mock.calls[0][3]).toEqual(['1505809']);
  });

  it('the recorte on its way: the composition waits, and nothing national stands in', () => {
    const c = renderWith({ subUfLoaded: false, subUfLoading: true, geoComboPending: true, muniYearlySeries: [] });
    expect(donut(c)).toBeNull();
    expect(cartao(c, 'Composição').textContent).toContain('Carregando a composição dos municípios do recorte…');
    expect(pbm).not.toHaveBeenCalled();
    // The strip and the series card name the recorte, not a product × UF cross.
    expect(c.querySelector('.kpi-sub').textContent).toBe('carregando o recorte sub-UF…');
    expect(c.textContent).toContain('Carregando o recorte territorial…');
  });

  it('the recorte failed: the composition says so, and no donut is drawn', () => {
    const c = renderWith({ subUfLoaded: false, subUfLoadError: 'HTTP 503', muniYearlySeries: [] });
    expect(donut(c)).toBeNull();
    expect(cartao(c, 'Composição').textContent).toContain('Não foi possível carregar o recorte territorial.');
    expect(pbm).not.toHaveBeenCalled();
  });

  it.each([
    ['on its way', { products: [], loading: true, unavailable: false, loadError: null },
      'Carregando a composição dos municípios do recorte…'],
    ['refused by the banco', { products: [], loading: false, unavailable: true, loadError: null },
      'Este banco não tem a composição por produto abaixo da UF.'],
    ['measured empty', LIDO([]),
      'Os municípios do recorte não registram nenhum produto da cesta no período.'],
    ['only a herd', LIDO([{ code: 'B', name: 'Bovino', measure_kind: 'stock', value: null }]),
      'A cesta só tem efetivo de rebanho, que não tem valor monetário.'],
    ['flows with no value in the convention', LIDO([{ code: 'O', name: 'Ovos', measure_kind: 'flow', value: null }]),
      'Nenhum produto da cesta tem valor em 2020 na convenção escolhida.'],
  ])('the products read %s says what it is, with no donut', (_estado, read, texto) => {
    const c = renderWith({}, read);
    expect(donut(c)).toBeNull();
    expect(cartao(c, 'Composição').textContent).toContain(texto);
  });

  it('the products read failed: its own error note, inside the composition card', () => {
    const c = renderWith({}, { products: [], loading: false, unavailable: false, loadError: 'HTTP 500' });
    expect(donut(c)).toBeNull();
    expect(cartao(c, 'Composição').querySelector('.load-err').textContent).toBe('HTTP 500');
  });

  it('no recorte: the national composition, unchanged', () => {
    const c = renderWith({ subUfRequested: false });
    expect(rotulos(c)).toEqual(['Leite', 'Ovos de galinha']);
    expect(pbm).not.toHaveBeenCalled();
  });

  it('the map waits while the recorte loads, and says it failed after — never a blank or "R$ 0 – 0" map', () => {
    let c = renderWith({ subUfLoaded: false, subUfLoading: true, geoComboPending: true, muniYearlySeries: [], ufData: [] });
    let mapa = cartao(c, 'Distribuição geográfica');
    expect(mapa.querySelector('.tilemap')).toBeNull();
    expect(mapa.textContent).toContain('Carregando o recorte territorial…');
    expect(mapa.querySelector('.sh-action').textContent).toBe('…');
    cleanup();
    c = renderWith({ subUfLoaded: false, subUfLoadError: 'HTTP 503', muniYearlySeries: [], ufData: [] });
    mapa = cartao(c, 'Distribuição geográfica');
    expect(mapa.querySelector('.tilemap')).toBeNull();
    expect(mapa.textContent).toContain('Não foi possível carregar o recorte territorial.');
    expect(mapa.querySelector('.sh-action').textContent).toBe('—');
  });
});

// ── O cubo produto × UF da cesta: a caminho, falhou (v1.108.2) ───────────────────────────
describe('ViewOverview — the basket’s product × UF cube on its way or failed', () => {
  const renderWith = (extra) => {
    stubGlobals({ ...FIXTURE, ...extra });
    window.LoadErrorNote = ({ error }) => (error ? <div className="load-err" role="alert">{String(error)}</div> : null);
    return render(
      <ViewOverview families={['mass']} summary={{}} database="ibge_pevs" conventions={{}} />,
    ).container;
  };
  afterEach(() => { delete window.LoadErrorNote; });

  it('failed beside a UF subset: the value is "—" with the reason, never "…" for good', () => {
    const c = renderWith({ geoComboPending: false, geoComboLoadError: 'HTTP 503' });
    const valor = [...c.querySelectorAll('.kpi')].find((k) => /Valor total/.test(k.textContent));
    expect(valor.querySelector('.kpi-value').textContent).toBe('—');
    expect(valor.querySelector('.kpi-sub').textContent).toBe('produto × UF não carregado');
    expect(c.querySelector('.load-err').textContent).toBe('HTTP 503');
    expect(c.textContent).not.toMatch(/[Cc]ruzando/);
  });

  it('the map note says whether the basket’s UF split is on its way or failed', () => {
    let c = renderWith({ notFilteredByBasket: true, basketGeoLoadError: null });
    expect(c.textContent).toContain('a distribuição por UF da cesta selecionada ainda está carregando');
    cleanup();
    c = renderWith({ notFilteredByBasket: true, basketGeoLoadError: 'HTTP 503' });
    expect(c.textContent).toContain('não foi possível carregar a distribuição por UF da cesta selecionada');
    expect(c.textContent).not.toContain('ainda está carregando');
  });
});

// ── Sob um subconjunto de UFs, a composição é a das UFs (v1.108.3) ────────────────────────
// Measured on prod 2026-11-18 (PPM, Pará): the donut sliced BRAZIL's latest year under a
// "1 UF" chip. applyFilters now hands the UFs' own slices; while their read is on its way, or
// after it failed, it hands none, and the card says which instead of "nenhum produto".
describe('ViewOverview — under a UF subset the composition is the UFs’ own', () => {
  const PARA = [{ code: 'L', name: 'Leite', share: 0.9 }, { code: 'O', name: 'Ovos de galinha', share: 0.1 }];
  const UF = { productUfRequested: true, productUfLoading: false, productUfLoadError: null, productUfUnavailable: false };
  const cartao = (c, overline) => [...c.querySelectorAll('.card')]
    .find((k) => (k.querySelector('.sh-ov') || {}).textContent?.startsWith(overline));
  const renderWith = (extra) => {
    stubGlobals({ ...FIXTURE, ...UF, ...extra });
    window.SectionHeader = ({ overline, title, action }) => (
      <div className="sh">
        <span className="sh-ov">{overline}</span>
        <span className="sh-title">{title}</span>
        <span className="sh-action">{action}</span>
      </div>
    );
    window.NotApplicableNote = ({ note }) => {
      const m = note ? Object.values(note).filter(Boolean) : [];
      return m.length ? <div className="na-note">{m.join(' ')}</div> : null;
    };
    return render(
      <ViewOverview families={['mass']} summary={{ states: ['PA'] }} database="ibge_ppm" conventions={{}} />,
    ).container;
  };
  afterEach(() => { delete window.NotApplicableNote; });

  it('resolved: the slices are the UFs’, with no note', () => {
    const c = renderWith({ topProducts: PARA });
    expect(cartao(c, 'Composição').querySelector('.donut').getAttribute('data-rotulos')).toBe('Leite|Ovos de galinha');
    expect(cartao(c, 'Composição').querySelector('.na-note')).toBeNull();
  });

  it('on its way: no donut, and the card says it is loading — not "nenhum produto"', () => {
    const c = renderWith({ topProducts: [], productUfLoading: true });
    const card = cartao(c, 'Composição');
    expect(card.querySelector('.donut')).toBeNull();
    expect(card.textContent).toContain('Carregando as séries por produto das UFs escolhidas…');
    expect(card.textContent).not.toMatch(/Nenhum produto|não têm valor/);
  });

  it('failed: no donut, and the card says it failed — never "still loading"', () => {
    const c = renderWith({ topProducts: [], productUfLoadError: 'HTTP 503' });
    const card = cartao(c, 'Composição');
    expect(card.querySelector('.donut')).toBeNull();
    expect(card.textContent).toContain('Não foi possível carregar as séries por produto das UFs escolhidas');
    expect(card.textContent).not.toMatch(/Carregando/);
  });

  it('a banco without series by UF: the national slices, and a note saying they are national', () => {
    const c = renderWith({ topProducts: PARA, productUfUnavailable: true });
    const card = cartao(c, 'Composição');
    expect(card.querySelector('.donut')).not.toBeNull();
    expect(card.querySelector('.na-note').textContent)
      .toContain('As séries por produto deste banco existem só para o Brasil inteiro');
  });

  it('resolved and empty: the UFs record none of the basket — said as such', () => {
    const c = renderWith({ topProducts: [] });
    expect(cartao(c, 'Composição').textContent)
      .toContain('Os produtos selecionados não têm valor registrado nas UFs escolhidas no período.');
  });

  it('no UF subset: the national composition, no note', () => {
    const c = renderWith({ topProducts: PARA, productUfRequested: false });
    expect(cartao(c, 'Composição').querySelector('.donut')).not.toBeNull();
    expect(cartao(c, 'Composição').querySelector('.na-note')).toBeNull();
  });

  // The flag counts are the banco's whole collection under any filter, like the KPI beside
  // them ("acervo do banco"). The overline said "agregado", which under a UF chip read as
  // "summed over my selection".
  it('the quality card names its scope: the banco’s collection, not the selection', () => {
    const c = renderWith({ topProducts: PARA });
    const card = cartao(c, 'Qualidade dos dados');
    expect(card.querySelector('.sh-ov').textContent).toBe('Qualidade dos dados · acervo do banco');
    expect(card.querySelector('.sh-title').textContent).toMatch(/^Cobertura geográfica da seleção: /);
    expect(c.textContent).not.toContain('agregado');
  });
});

// ── "3 maiores" names only UFs that produced (v1.108.22) ──────────────────────────────────
// PAM publishes a zeroed row for every município, so a UF that never grew the basket still has
// a row at zero. The caption sorted every row and named it: açaí × RS over 1974–2025 read
// "3 maiores: RS" with RS at R$ 0 in every year. A UF at zero, or with no figure, is no producer.
describe('ViewOverview — "3 maiores" names only UFs that produced', () => {
  const legenda = (c, titulo) => {
    const sh = [...c.querySelectorAll('.sh')]
      .find((k) => k.querySelector('.sh-title').textContent === titulo);
    return sh && sh.querySelector('.sh-action').textContent;
  };
  // `ufData` last: `withCounts` spreads the whole FIXTURE, whose single PA row would win.
  const renderWith = (ufData, extra = {}, families = ['mass']) => {
    stubGlobals({ ...FIXTURE, ...extra, ufData, ufDataFull: ufData });
    return render(
      <ViewOverview families={families} summary={{}} database="ibge_pam" conventions={{}} />,
    ).container;
  };
  afterEach(() => { delete window.countQtyMul; });

  it('the only UF in the selection is at R$ 0: no UF is named, the caption says "—"', () => {
    const c = renderWith([{ uf: 'RS', value: 0, real: true }]);
    expect(legenda(c, 'Valor por UF · R$')).toBe('—');
  });

  it('UFs at zero or with no figure are skipped, and the producers keep their order', () => {
    const c = renderWith([
      { uf: 'RS', value: 0, real: true },
      { uf: 'MT', value: 10, real: true },
      { uf: 'GO', value: null, real: true },
      { uf: 'SP', value: 5, real: true },
      { uf: 'PR', value: undefined, real: true },
    ]);
    expect(legenda(c, 'Valor por UF · R$')).toBe('3 maiores: MT · SP');
  });

  it('counter-proof: with four producers, the three largest are named', () => {
    const c = renderWith([
      { uf: 'PA', value: 7, real: true }, { uf: 'AM', value: 3, real: true },
      { uf: 'AP', value: 9, real: true }, { uf: 'MA', value: 1, real: true },
    ]);
    expect(legenda(c, 'Valor por UF · R$')).toBe('3 maiores: AP · PA · AM');
  });

  it('on a count, a UF whose herd is zero is not named either', () => {
    window.countQtyMul = () => 1e6; // mi un → un, the convention's 'un'
    const c = renderWith(
      [
        { uf: 'MT', value: 0, real: true, q_count_stock: 0 },
        { uf: 'GO', value: 0, real: true, q_count_stock: 12 },
      ],
      {
        ...withCounts([BOVINO]),
        ts: [{ y: 2019, v: 0, q_count_stock: 12 }, { y: 2020, v: 0, q_count_stock: 12 }],
      },
      ['count'],
    );
    expect(legenda(c, 'Efetivo por UF · cabeças')).toBe('3 maiores: GO');
  });
});
