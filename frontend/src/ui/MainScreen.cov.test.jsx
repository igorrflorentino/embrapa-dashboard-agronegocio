// MainScreen.cov.test.jsx — coverage for the view router (MainScreen.jsx). The
// component is a thin dispatcher: given an infoPage (sidebar) or a view+database
// (topnav), it renders the matching child screen with the right page-hero. We stub
// every registry helper / child component it reads as plain globals and assert the
// routing decision per branch — the info pages (glossary / frozen curation / about /
// referencias / cadastro / health / unknown), the per-banco glossary (present vs
// missing), the cross-source meta-perspective (picker vs fixed), the selfData preview,
// the capability-mismatch "não se aplica", the 'soon' banco placeholder, the
// perspective-soon placeholder, and the live-banco data view with its hero counters.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const BANCOS = [
  { id: 'ibge_pevs', short: 'IBGE PEVS', sub: 'Produção extrativa', status: 'live', maturity: 'estavel', prov: {} },
  { id: 'sefaz_nf', short: 'SEFAZ NFe', sub: 'Comércio interno', status: 'soon', maturity: 'planejado', prov: {} },
];

const VIEW_GROUPS = [
  {
    id: 'aggregate',
    label: 'Análise agregada',
    views: [{ id: 'overview', label: 'Visão geral' }, { id: 'value', label: 'Valor e volume' }],
  },
  { id: 'crosssource', label: 'Análise cruzada', views: [{ id: 'cross_source', label: 'Cruzamento entre fontes' }] },
];

// A controllable child-component factory: each stub renders a marker div so the test
// can confirm which child the router chose.
function marker(name) {
  return (props) => <div className={`child-${name}`} data-database={props.database || ''} />;
}

function stubChildren() {
  window.Glossary = ({ scope }) => <div className="child-glossary" data-scope={scope} />;
  window.ViewAbout = marker('about');
  window.ViewReferencias = marker('referencias');
  window.ViewCadastroProdutos = marker('cadastro');
  window.ViewHealth = marker('health');
  window.ViewCrossSource = marker('crosssource');
  window.ViewNotApplicable = marker('notapplicable');
  window.ViewComingSoon = marker('comingsoon');
  window.ViewPerspectiveSoon = marker('perspectivesoon');
  window.ViewOverview = marker('overview');
  // Composed widgets the live/soon screens reference.
  window.MaturityBanner = () => <div className="mat-banner" />;
  window.MaturityTag = () => <span className="mat-tag" />;
  window.UsageTag = () => <span className="usage-tag" />;
  window.SectionHeader = ({ title }) => <div className="sh">{title}</div>;
}

function stubRegistry() {
  window.VIEW_GROUPS = VIEW_GROUPS;
  window.BANCOS = BANCOS;
  window.GLOSSARY = { ibge_pevs: { label: 'IBGE PEVS', sub: 'Produção extrativa', terms: [] } };
  window.bancoById = (id) => BANCOS.find((b) => b.id === id) || BANCOS[0];
  window.bancoTable = (id) => `gold_${id}`;
  window.bancoMeta = (id) => ({ domain: 'Produção', source: 'IBGE', maturityDate: null });
  window.familiesInBasket = () => ['mass'];
  window.missingCapsLabel = (m) => (m || []).join(', ') || '—';
  window.bancosSupporting = () => [BANCOS[0]];
  window.fmtRows = (n) => (n == null ? '—' : String(n));
  window.isCanonicalUf = () => true;
  window.dataStore = { meta: () => null };
  window.DEFAULT_CONVENTIONS = { currency: 'BRL', correction: 'IPCA' };
  window.DEFAULT_CROSS_STATE = { series: [{ b: 'ibge_pevs', m: 'prod_value' }] };
  // The default registry shape: a normal live view that applies, with a component.
  window.viewById = (id) => ({ id, label: id, group: { label: 'grupo' }, status: 'live' });
  window.viewComponent = () => window.ViewOverview;
  window.viewAppliesTo = () => ({ applies: true, missing: [] });
  // A representative filtered snapshot for the hero counters.
  window.applyFilters = () => ({
    ts: [{ y: 2024, v: 1 }],
    ufData: [{ uf: 'PA', value: 5, real: true }],
    ufDataFull: [{ uf: 'PA', value: 5, real: true }],
    qualityFlags: [{ id: 'OK', count: 1000 }],
    productsTotal: 3,
    _shares: {},
  });
}

let MainScreen;

beforeEach(async () => {
  await import('./MainScreen.jsx'); // registers window.MainScreen
  MainScreen = window.MainScreen;
  stubChildren();
  stubRegistry();
});

afterEach(() => cleanup());

describe('MainScreen — info pages (sidebar)', () => {
  it('routes infoPage="glossary" to the global Glossary', () => {
    const { container } = render(<MainScreen infoPage="glossary" />);
    const g = container.querySelector('.child-glossary');
    expect(g).toBeTruthy();
    expect(g.dataset.scope).toBe('global');
    expect(container.textContent).toContain('Glossário global');
  });

  it('routes enrich_industrial/curation to the industrialization editor (unfrozen)', () => {
    window.ViewEnrichmentIndustrialization = () => <div className="stub-enrich-ind" />;
    for (const ip of ['curation', 'enrich_industrial']) {
      const { container, unmount } = render(<MainScreen infoPage={ip} />);
      expect(container.textContent).toContain('Nível de industrialização');
      expect(container.querySelector('.stub-enrich-ind')).toBeTruthy();
      unmount();
    }
  });

  it('routes infoPage="about" to ViewAbout with its hero title', () => {
    const { container } = render(<MainScreen infoPage="about" />);
    expect(container.querySelector('.child-about')).toBeTruthy();
    expect(container.textContent).toContain('Sobre o painel');
  });

  it('routes referencias / cadastro_produtos / health to their views', () => {
    const ref = render(<MainScreen infoPage="referencias" />);
    expect(ref.container.querySelector('.child-referencias')).toBeTruthy();
    expect(ref.container.textContent).toContain('Tabelas de referência');
    ref.unmount();

    const cad = render(<MainScreen infoPage="cadastro_produtos" />);
    expect(cad.container.querySelector('.child-cadastro')).toBeTruthy();
    expect(cad.container.textContent).toContain('Curadoria'); // overline
    cad.unmount();

    const hp = render(<MainScreen infoPage="health" />);
    expect(hp.container.querySelector('.child-health')).toBeTruthy();
    expect(hp.container.textContent).toContain('Saúde do sistema');
  });

  it('renders the "em construção" fallback for an unknown infoPage', () => {
    const { container } = render(<MainScreen infoPage="totally_unknown" />);
    expect(container.textContent).toContain('Conteúdo em preparação');
  });
});

describe('MainScreen — per-banco glossary (topnav)', () => {
  it('renders the per-banco Glossary when the banco has a glossary', () => {
    const { container } = render(<MainScreen view="glossary" database="ibge_pevs" />);
    const g = container.querySelector('.child-glossary');
    expect(g).toBeTruthy();
    expect(g.dataset.scope).toBe('ibge_pevs');
    expect(container.textContent).toContain('Termos e colunas');
  });

  it('shows the "glossário em preparação" placeholder when the banco has no glossary', () => {
    const { container } = render(<MainScreen view="glossary" database="banco_sem_gloss" />);
    expect(container.textContent).toContain('Glossário do banco em preparação');
    expect(container.querySelector('.child-glossary')).toBeNull();
  });
});

describe('MainScreen — cross-source meta-perspective', () => {
  it('renders the picker ViewCrossSource for the cross_source view', () => {
    window.viewById = (id) => ({ id, label: 'Cruzamento entre fontes', crossBanco: true, align: 'eixo temporal' });
    const { container } = render(
      <MainScreen view="cross_source" database="ibge_pevs" crossState={{ series: [{ b: 'ibge_pevs' }] }} />
    );
    expect(container.querySelector('.child-crosssource')).toBeTruthy();
    expect(container.textContent).toContain('Análise cruzada · multi-fonte');
    expect(container.textContent).toContain('Séries'); // picker-only meta row
  });

  it('renders a fixed cross view (non-picker) via its component', () => {
    window.viewById = (id) => ({ id, label: 'Balanço da cadeia', crossBanco: true, sources: ['ibge_pevs'], desc: 'fixo' });
    window.viewComponent = () => marker('fixedcross');
    const { container } = render(<MainScreen view="chain_balance" database="ibge_pevs" />);
    expect(container.querySelector('.child-fixedcross')).toBeTruthy();
    expect(container.textContent).not.toContain('Séries'); // no picker meta row for a fixed cross
  });
});

describe('MainScreen — banco/view gating', () => {
  it('shows the SAME generic coming-soon window for a soon banco on ANY perspective (even selfData)', () => {
    // The banco-level 'soon' check runs FIRST (before the selfData-preview + capability
    // branches), so every perspective renders the one generic coming-soon window —
    // never a per-view preview or "não se aplica".
    window.viewById = (id) => ({ id, label: 'Sazonalidade', group: { label: 'temporal' }, selfData: true });
    window.viewComponent = () => marker('preview');
    const { container } = render(<MainScreen view="seasonality" database="sefaz_nf" />);
    expect(container.querySelector('.child-comingsoon')).toBeTruthy();
    expect(container.querySelector('.child-preview')).toBeNull(); // no synthetic preview
    expect(container.textContent).not.toContain('Proveniência');
  });

  it('shows the coming-soon window (NOT "não se aplica") for a soon banco on an incompatible view', () => {
    // Consistency: a capability mismatch must NOT surface for a not-yet-built banco —
    // it shows the same coming-soon as every other perspective.
    window.viewById = (id) => ({ id, label: 'Geografia', group: { label: 'geo' } });
    window.viewAppliesTo = () => ({ applies: false, missing: ['geo'] });
    const { container } = render(<MainScreen view="geo" database="sefaz_nf" />);
    expect(container.querySelector('.child-comingsoon')).toBeTruthy();
    expect(container.querySelector('.child-notapplicable')).toBeNull();
    expect(container.textContent).not.toContain('Não se aplica');
  });

  it('renders the FULL hero (beta banner + provenance box) for a selfData view on a LIVE banco', () => {
    // Produtividade/PAM is selfData but its banco is live → it must NOT fall into the
    // minimal preview hero (that path is gated on isSoon); it flows to the full hero
    // with the MaturityBanner + provenance/selection box, like every live perspective
    // (audit HERO-1). ibge_pevs is the live banco in the stub registry.
    window.viewById = (id) => ({ id, label: 'Produtividade', group: { label: 'produto' }, selfData: true, status: 'live' });
    window.viewComponent = () => marker('productivity');
    const { container } = render(
      <MainScreen filters={{}} view="productivity" database="ibge_pevs" basket={['P1']} />
    );
    expect(container.querySelector('.child-productivity')).toBeTruthy();
    expect(container.querySelector('.mat-banner')).toBeTruthy();   // beta caveat banner
    expect(container.textContent).toContain('Proveniência');
    expect(container.textContent).toContain('Seleção ativa');
  });

  it('renders ViewNotApplicable when the view does not apply to the banco', () => {
    window.viewAppliesTo = () => ({ applies: false, missing: ['flow'] });
    window.viewById = (id) => ({ id, label: 'Fluxos', group: { label: 'flows' } });
    const { container } = render(<MainScreen view="flows" database="ibge_pevs" />);
    expect(container.querySelector('.child-notapplicable')).toBeTruthy();
    expect(container.textContent).toContain('Não se aplica');
  });

  it('renders ViewComingSoon for a soon banco when the view applies but is not selfData', () => {
    const { container } = render(<MainScreen view="overview" database="sefaz_nf" />);
    expect(container.querySelector('.child-comingsoon')).toBeTruthy();
  });

  it('renders ViewPerspectiveSoon when the banco is live but the view status is soon', () => {
    window.viewById = (id) => ({ id, label: 'Em breve', group: { label: 'grupo' }, status: 'soon' });
    const { container } = render(<MainScreen view="future_view" database="ibge_pevs" />);
    expect(container.querySelector('.child-perspectivesoon')).toBeTruthy();
    expect(container.textContent).toContain('Em breve');
  });

  it('renders the live-banco data view with the provenance + selection hero', () => {
    const { container } = render(
      <MainScreen filters={{}} view="overview" database="ibge_pevs" basket={['P1']} />
    );
    // The data view child + the hero counters (products selected/total, UFs).
    expect(container.querySelector('.child-overview')).toBeTruthy();
    expect(container.querySelector('.mat-banner')).toBeTruthy();
    expect(container.textContent).toContain('Proveniência');
    expect(container.textContent).toContain('Seleção ativa');
    expect(container.textContent).toContain('UFs cobertas');
  });
});

// O contador "Seleção ativa · Linhas" descreve o que está NA TELA. A seleção de
// qualidade não recorta série alguma (nenhum mart de serving carrega a flag), então
// incluí-la no produto fazia o cabeçalho afirmar um recorte que nenhum gráfico refletia.
describe('MainScreen — o contador de linhas ignora a seleção de qualidade', () => {
  function comShares(shares, extra = {}) {
    window.applyFilters = () => ({
      ts: [{ y: 2024, v: 1 }],
      ufData: [{ uf: 'PA', value: 5, real: true }],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }],
      qualityFlags: [{ id: 'OK', count: 1000 }],
      productsTotal: 3,
      _shares: shares,
      ...extra,
    });
  }
  const linhasLidas = (container) => {
    const row = [...container.querySelectorAll('.meta-row')].find(
      (e) => e.textContent.includes('Linhas'));
    return row ? row.textContent : '';
  };

  it('contado: a seleção de qualidade não entra na soma', () => {
    // 700 counted rows: with flagShare in the product they would be 14.
    comShares({ flagShare: 0.02 }, { rowsInView: 700 });
    const { container } = render(<MainScreen />);
    expect(linhasLidas(container)).toContain('700 de 1000');
  });

  it('na estimativa, flagShare 0,02 também NÃO encolhe o contador', () => {
    comShares({ flagShare: 0.02 });
    const { container } = render(<MainScreen />);
    // 1000 linhas (a soma das flags), inteiras: com flagShare no produto seriam 20.
    expect(linhasLidas(container)).toContain('≈ 1000');
    expect(linhasLidas(container)).not.toContain('20 de');
  });

  it('na estimativa, as demais dimensões continuam encolhendo', () => {
    comShares({ yearShare: 0.5 });
    const { container } = render(<MainScreen />);
    expect(linhasLidas(container)).toContain('≈ 500');
  });
});

// "Linhas" COUNTS the recorte's rows (v1.108.9): applyFilters sums the Gold rows behind the
// screen's series (`rowsInView`), and the shares only back an estimate when that count did not
// come. Before, the estimate was all there was, and it read thousands of rows for PAM's açaí over
// 1990–2000 — a period it has no row in.
describe('MainScreen — "Linhas" conta as linhas do recorte', () => {
  const comContagem = (extra) => {
    window.applyFilters = () => ({
      ts: [{ y: 2024, v: 1 }],
      ufData: [{ uf: 'PA', value: 5, real: true }],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }],
      qualityFlags: [{ id: 'OK', count: 100000 }],
      productsTotal: 3,
      // Shares that would give 50.000 rows: a count must win over them, whatever they say.
      _shares: { productShare: 1, yearShare: 0.5 },
      ...extra,
    });
  };
  const linhas = (container) => [...container.querySelectorAll('.meta-row')]
    .find((e) => e.textContent.includes('Linhas')).querySelector('.meta-val');

  it('a contagem é o número, e o título a traz por inteiro', () => {
    comContagem({ rowsInView: 60557 });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('60557');
    expect(v.getAttribute('title')).toBe('60.557 linhas da base analítica neste recorte.');
  });

  it('zero linhas é uma contagem: aparece 0, nunca a estimativa', () => {
    // PAM açaí over 1990–2000: the estimate gave 50.000 here; the recorte has no row at all.
    comContagem({ rowsInView: 0 });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('0');
    expect(v.getAttribute('title')).toBe('0 linhas da base analítica neste recorte.');
  });

  it('uma linha, no singular', () => {
    comContagem({ rowsInView: 1 });
    const v = linhas(render(<MainScreen />).container);
    expect(v.getAttribute('title')).toBe('1 linha da base analítica neste recorte.');
  });

  it('sem contagem, a estimativa aparece marcada e o título diz que é uma', () => {
    comContagem({ rowsInView: null });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('≈ 50000');
    expect(v.getAttribute('title')).toMatch(/^Estimativa: a contagem exata deste recorte não está disponível/);
  });

  it('cesta × UF aguardando o cubo: "…", nem contagem nem estimativa', () => {
    comContagem({ rowsInView: null, geoComboPending: true });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('…');
    expect(v.getAttribute('title')).toBe('O recorte geográfico escolhido ainda está carregando.');
  });

  it('cesta × UF com o cubo em falha: "—", e o título diz que não carregou', () => {
    comContagem({ rowsInView: null, geoComboPending: false, geoComboLoadError: 'HTTP 503' });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('—');
    expect(v.getAttribute('title')).toBe('Não foi possível carregar o recorte geográfico escolhido.');
  });

  it('sem contagem e sem total, não há o que estimar: "—"', () => {
    comContagem({ rowsInView: null, qualityFlags: [] });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('—');
    expect(v.getAttribute('title')).toBeNull();
  });
});

// "Anos cobertos" counts the years WITH ROWS (v1.108.15): the years of the screen's series that
// carry the rows "Linhas" counts (applyFilters' `yearsWithRows`). It read `ts.length`, a point
// for every year of the banco inside the period, rows or not: in production PAM's açaí over
// 1990–2000 read "Linhas 0" beside "Anos cobertos 11 / 52", and a COMEX code with one row
// in 2010 read "30 / 30".
describe('MainScreen — "Anos cobertos" conta os anos com linhas', () => {
  // The 11 points the series has for 1990–2000, none with a row: what the old counter counted.
  const PERIODO = Array.from({ length: 11 }, (_, i) => ({ y: 1990 + i, v: null, rows: 0 }));
  const comAnos = (extra) => {
    window.dataStore = { meta: () => ({ prov: { yearsTotal: 52 } }) };
    window.applyFilters = () => ({
      ts: PERIODO,
      ufData: [],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }],
      qualityFlags: [{ id: 'OK', count: 100000 }],
      productsTotal: 14,
      _shares: { productShare: 1, yearShare: 0.5 },
      ...extra,
    });
  };
  const linha = (container, rotulo) => [...container.querySelectorAll('.meta-row')]
    .find((e) => e.querySelector('.meta-label')?.textContent === rotulo)
    .querySelector('.meta-val');
  const anos = (container) => linha(container, 'Anos cobertos');

  it('o açaí em 1990–2000: nenhum ano, ao lado de nenhuma linha, e não os 11 do período', () => {
    comAnos({ rowsInView: 0, yearsWithRows: [] });
    const { container } = render(<MainScreen />);
    expect(anos(container).textContent).toBe('0 / 52');
    expect(anos(container).getAttribute('title'))
      .toBe('Nenhum ano com linhas da base analítica neste recorte.');
    expect(linha(container, 'Linhas').querySelector('strong').textContent).toBe('0');
  });

  it('os anos contados, e o título diz o primeiro e o último', () => {
    // Açaí over 2010–2020: rows from 2015 on, so 6 of the period's 11 years.
    comAnos({ rowsInView: 33024, yearsWithRows: [2015, 2016, 2017, 2018, 2019, 2020] });
    const v = anos(render(<MainScreen />).container);
    expect(v.textContent).toBe('6 / 52');
    expect(v.getAttribute('title'))
      .toBe('6 anos com linhas da base analítica neste recorte, entre 2015 e 2020.');
  });

  it('um ano só, no singular, com o ano', () => {
    comAnos({ rowsInView: 1, yearsWithRows: [2010] });
    const v = anos(render(<MainScreen />).container);
    expect(v.textContent).toBe('1 / 52');
    expect(v.getAttribute('title')).toBe('1 ano com linhas da base analítica neste recorte: 2010.');
  });

  it('sem contagem: "—", nunca os anos do período, enquanto "Linhas" estima', () => {
    comAnos({ rowsInView: null, yearsWithRows: null });
    const { container } = render(<MainScreen />);
    expect(anos(container).textContent).toBe('— / 52');
    expect(anos(container).getAttribute('title'))
      .toBe('A contagem dos anos deste recorte não está disponível.');
    expect(linha(container, 'Linhas').querySelector('strong').textContent).toBe('≈ 50000');
  });

  it('cesta × UF aguardando o cubo: "…", com o título de "Linhas"', () => {
    comAnos({ rowsInView: null, yearsWithRows: null, geoComboPending: true });
    const v = anos(render(<MainScreen />).container);
    expect(v.textContent).toBe('… / 52');
    expect(v.getAttribute('title')).toBe('O recorte geográfico escolhido ainda está carregando.');
  });

  it('cesta × UF com o cubo em falha: "—", com o título de "Linhas"', () => {
    comAnos({ rowsInView: null, yearsWithRows: null, geoComboLoadError: 'HTTP 503' });
    const v = anos(render(<MainScreen />).container);
    expect(v.textContent).toBe('— / 52');
    expect(v.getAttribute('title')).toBe('Não foi possível carregar o recorte geográfico escolhido.');
  });

  it('recorte abaixo da UF carregando: "…" mesmo com anos de outro recorte na mão', () => {
    // As with "Linhas": whatever came, the selection is not resolved yet.
    comAnos({ subUfLoading: true, rowsInView: 10, yearsWithRows: [2015] });
    const v = anos(render(<MainScreen />).container);
    expect(v.textContent).toBe('… / 52');
    expect(v.getAttribute('title')).toBe('O recorte geográfico escolhido ainda está carregando.');
  });

  it('recorte abaixo da UF em falha: "—"', () => {
    comAnos({ subUfLoadError: 'HTTP 503', rowsInView: null, yearsWithRows: null });
    const v = anos(render(<MainScreen />).container);
    expect(v.textContent).toBe('— / 52');
    expect(v.getAttribute('title')).toBe('Não foi possível carregar o recorte geográfico escolhido.');
  });
});

// A sub-UF narrowing still on its way, or one that failed, owns an EMPTY grid, and counting it
// gave "UFs cobertas 0 / 27": a claim that the selection covers no state, made by a read that
// never answered (v1.108.1).
describe('MainScreen — "UFs cobertas" de um recorte sub-UF que não resolveu', () => {
  const comRecorte = (extra) => {
    window.applyFilters = () => ({
      ts: [{ y: 2024, v: 1 }],
      ufData: [],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }, { uf: 'AM', value: 3, real: true }],
      qualityFlags: [{ id: 'OK', count: 1000 }],
      productsTotal: 3,
      _shares: {},
      ...extra,
    });
  };
  const ufsCobertas = (container) => [...container.querySelectorAll('.meta-row')]
    .find((e) => e.textContent.includes('UFs cobertas')).querySelector('.meta-val');

  it('carregando: "…", e o título diz que ainda carrega', () => {
    comRecorte({ subUfLoading: true, subUfLoadError: null });
    const v = ufsCobertas(render(<MainScreen />).container);
    expect(v.textContent).toBe('… / 2');
    expect(v.getAttribute('title')).toBe('O recorte geográfico escolhido ainda está carregando.');
  });

  it('com falha: "—", e o título diz que não carregou', () => {
    comRecorte({ subUfLoading: false, subUfLoadError: 'HTTP 503' });
    const v = ufsCobertas(render(<MainScreen />).container);
    expect(v.textContent).toBe('— / 2');
    expect(v.getAttribute('title')).toBe('Não foi possível carregar o recorte geográfico escolhido.');
  });

  it('contraprova: resolvido e vazio, o zero é uma medida e aparece', () => {
    comRecorte({ subUfLoading: false, subUfLoadError: null });
    const v = ufsCobertas(render(<MainScreen />).container);
    expect(v.textContent).toBe('0 / 2');
    expect(v.getAttribute('title')).toBeNull();
  });
});

// "Linhas" under a sub-UF recorte (v1.108.2). stateShare counts WHOLE states, so Portel and
// Breves read as all of Pará — "134 mil" in every state, as measured in production. The
// recorte's share of the municípios sizes the ESTIMATE now (since v1.108.9 the counter counts,
// and the estimate is only its fallback); while the recorte loads, or after it failed, the
// counter holds with the same marks and tooltip as "UFs cobertas".
describe('MainScreen — "Linhas" sob um recorte sub-UF', () => {
  const comRecorte = (extra) => {
    window.applyFilters = () => ({
      ts: [{ y: 2024, v: 1 }],
      ufData: [],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }, { uf: 'AM', value: 3, real: true }],
      qualityFlags: [{ id: 'OK', count: 1000 }],
      productsTotal: 3,
      _shares: {},
      ...extra,
    });
  };
  const linhas = (container) => [...container.querySelectorAll('.meta-row')]
    .find((e) => e.textContent.includes('Linhas')).querySelector('.meta-val');

  it('resolvido: a fração dos MUNICÍPIOS dimensiona o recorte, não a da UF inteira', () => {
    comRecorte({ _shares: { stateShare: 0.5, muniShare: 0.01 } });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('≈ 10'); // 1000 × 0,01 — the UF's 0,5 gave 500
  });

  it('resolvido e contado: a contagem dos municípios, não a fração', () => {
    comRecorte({ rowsInView: 37, _shares: { stateShare: 0.5, muniShare: 0.01 } });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('37');
  });

  it('carregando: "…" mesmo com a contagem de outro estado na mão', () => {
    // rowsInView is null in this state (applyFilters refuses to count), but the hold must not
    // depend on it: whatever came, the selection is not resolved yet.
    comRecorte({ subUfLoading: true, rowsInView: 1000, _shares: { stateShare: 0.5 } });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('…');
  });

  it('carregando: "…", com o título de "UFs cobertas"', () => {
    comRecorte({ subUfLoading: true, _shares: { stateShare: 0.5 } });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('…');
    expect(v.getAttribute('title')).toBe('O recorte geográfico escolhido ainda está carregando.');
  });

  it('com falha: "—", e o título diz que não carregou', () => {
    comRecorte({ subUfLoadError: 'HTTP 503', _shares: { stateShare: 0.5 } });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('—');
    expect(v.getAttribute('title')).toBe('Não foi possível carregar o recorte geográfico escolhido.');
  });

  it('contraprova: sem recorte sub-UF, a fração das UFs segue valendo na estimativa', () => {
    comRecorte({ _shares: { stateShare: 0.5 } });
    const v = linhas(render(<MainScreen />).container);
    expect(v.querySelector('strong').textContent).toBe('≈ 500');
    expect(v.getAttribute('title')).toMatch(/^Estimativa:/);
  });
});

// O aviso de "valores corrigidos de anos até 1994 são indicativos" (v1.103.0) é montado aqui,
// uma vez, em vez de em cada perspectiva. A regra de QUANDO aparece é de window.inflacaoAltaNoPeriodo
// (MonetaryNotes.test.jsx); o que se prova aqui é a montagem: recebe a convenção ativa e o início
// do período da tela, e as perspectivas sem valor em moeda não o recebem.
describe('MainScreen — aviso de anos de inflação muito alta', () => {
  beforeEach(() => {
    window.HighInflationNote = ({ conventions, start }) => (
      <div className="child-inflacao-alta" data-correction={conventions && conventions.correction} data-start={start} />
    );
  });

  // A série filtrada começando em y0 (a de PAM/PPM na tela padrão começa em 1974): o stub padrão
  // do arquivo, só com a série trocada.
  const serieDesde = (y0, y1 = 2024) => {
    const padrao = window.applyFilters;
    return (...args) => ({
      ...padrao(...args),
      ts: Array.from({ length: y1 - y0 + 1 }, (_, i) => ({ y: y0 + i, v: 1 })),
    });
  };

  it('monta o aviso com a convenção ativa e o primeiro ano que a tela mostra', () => {
    window.applyFilters = serieDesde(1974);
    const { container } = render(
      <MainScreen filters={{ startDate: '1974-01-01' }} view="overview" database="ibge_pevs" basket={['P1']}
                  conventions={{ currency: 'BRL', correction: 'IGP-DI' }} />
    );
    const nota = container.querySelector('.child-inflacao-alta');
    expect(nota).toBeTruthy();
    expect(nota.getAttribute('data-correction')).toBe('IGP-DI');
    expect(nota.getAttribute('data-start')).toBe('1974');
  });

  // O defeito da v1.103.0: o painel abre sem filtro de período (`startDate` vazio = a cobertura
  // inteira), e a nota lia o vazio como "não se sabe" — sumindo justamente na tela padrão, que
  // mostra 1974–1994 corrigidos.
  it('sem filtro de período (a tela padrão), o início é o primeiro ano da série', () => {
    window.applyFilters = serieDesde(1974);
    const { container } = render(
      <MainScreen filters={{}} view="overview" database="ibge_pevs" basket={['P1']}
                  conventions={{ currency: 'BRL', correction: 'IGP-DI' }} />
    );
    expect(container.querySelector('.child-inflacao-alta').getAttribute('data-start')).toBe('1974');
  });

  it('um filtro anterior ao dado não conta: vale o primeiro ano que a série tem', () => {
    window.applyFilters = serieDesde(2001);
    const { container } = render(
      <MainScreen filters={{ startDate: '1974-01-01' }} view="overview" database="ibge_pevs" basket={['P1']}
                  conventions={{ currency: 'BRL', correction: 'IGP-DI' }} />
    );
    expect(container.querySelector('.child-inflacao-alta').getAttribute('data-start')).toBe('2001');
  });

  it('sem a série filtrada, recai no início do filtro', () => {
    delete window.applyFilters;
    const { container } = render(
      <MainScreen filters={{ startDate: '1986-01-01' }} view="overview" database="ibge_pevs" basket={['P1']}
                  conventions={{ currency: 'BRL', correction: 'IGP-DI' }} />
    );
    expect(container.querySelector('.child-inflacao-alta').getAttribute('data-start')).toBe('1986-01-01');
  });

  it('sem convenção própria, usa a padrão do painel', () => {
    const { container } = render(
      <MainScreen filters={{ startDate: '1986-01-01' }} view="overview" database="ibge_pevs" basket={['P1']} />
    );
    expect(container.querySelector('.child-inflacao-alta').getAttribute('data-correction')).toBe('IPCA');
  });

  it.each(['quality', 'dados', 'rebanho', 'productivity'])(
    'não monta o aviso em %s, que não mostra valor em moeda', (view) => {
      window.viewById = (id) => ({ id, label: id, group: { label: 'grupo' }, status: 'live' });
      const { container } = render(
        <MainScreen filters={{ startDate: '1974-01-01' }} view={view} database="ibge_pevs" basket={['P1']} />
      );
      expect(container.querySelector('.child-inflacao-alta')).toBeNull();
    });
});

// ── O mês das séries por produto das UFs entra no aviso de dois meses (v1.108.3) ─────────
// Under a UF subset the per-product series are a read of their own, cached on their own: across
// a build they can come back a month apart from the snapshot, like the cubes. The note that
// says so is mounted here, once, over every base applyFilters' reads carry.
describe('MainScreen — the UFs’ per-product series join the two-months check', () => {
  let recebidas;
  const SETEMBRO = { column: null, month: '2026-09', fxDate: null };
  beforeEach(() => {
    recebidas = undefined;
    window.PriceBaseSkewNote = ({ bases }) => { recebidas = bases; return <div className="child-skew" />; };
  });
  afterEach(() => { delete window.PriceBaseSkewNote; });
  const comBase = (extra) => {
    const padrao = window.applyFilters;
    return (...args) => ({ ...padrao(...args), ...extra });
  };

  it('mounted for the product base alone, which is among the bases compared', () => {
    window.applyFilters = comBase({ productPriceBase: SETEMBRO });
    const { container } = render(
      <MainScreen filters={{ states: ['PA'] }} view="overview" database="ibge_pevs" basket={['P1']} />,
    );
    expect(container.querySelector('.child-skew')).toBeTruthy();
    expect(recebidas).toContain(SETEMBRO);
  });

  it('no read with a base of its own: nothing to compare, no note', () => {
    const { container } = render(
      <MainScreen filters={{}} view="overview" database="ibge_pevs" basket={['P1']} />,
    );
    expect(container.querySelector('.child-skew')).toBeNull();
  });
});

// "Produtos" counts the selection the engine draws: the basket inside the origin (v1.108.5).
// Under "Extração vegetal" it read "10 / 10" — the raw basket (null = all) over the banco —
// beside numbers that were already the extração's.
describe('MainScreen — "Produtos" conta a seleção dentro da origem', () => {
  const EXTRACAO = ['3403', '3404', '3405', '3433', '3434', '3435', '3450'];
  const comSelecao = (selectedProducts) => {
    window.applyFilters = () => ({
      ts: [{ y: 2024, v: 1 }],
      ufData: [{ uf: 'PA', value: 5, real: true }],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }],
      qualityFlags: [{ id: 'OK', count: 1383211 }],
      productsTotal: 10,
      selectedProducts,
      _shares: {},
    });
  };
  const produtos = (container) => [...container.querySelectorAll('.meta-row')]
    .find((e) => e.querySelector('.meta-label')?.textContent === 'Produtos')
    .querySelector('.meta-val');

  it('Extração vegetal: 7 / 10, não 10 / 10', () => {
    comSelecao(EXTRACAO);
    expect(produtos(render(<MainScreen basket={null} />).container).textContent).toBe('7 / 10');
  });

  it('uma cesta só com produtos da outra metade: 0 / 10, o que a tela desenha', () => {
    comSelecao([]);
    expect(produtos(render(<MainScreen basket={['3455', '3456']} />).container).textContent)
      .toBe('0 / 10');
  });

  it('sem a seleção do motor (resultado de outra forma), vale a cesta como antes', () => {
    comSelecao(undefined);
    expect(produtos(render(<MainScreen basket={['3403', '3404']} />).container).textContent)
      .toBe('2 / 10');
  });
});
