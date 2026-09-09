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
    expect(container.textContent).toContain('Sobre o dashboard');
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
  function comShares(shares) {
    window.applyFilters = () => ({
      ts: [{ y: 2024, v: 1 }],
      ufData: [{ uf: 'PA', value: 5, real: true }],
      ufDataFull: [{ uf: 'PA', value: 5, real: true }],
      qualityFlags: [{ id: 'OK', count: 1000 }],
      productsTotal: 3,
      _shares: shares,
    });
  }
  const linhasLidas = (container) => {
    const row = [...container.querySelectorAll('.meta-row')].find(
      (e) => e.textContent.includes('Linhas'));
    return row ? row.textContent : '';
  };

  it('flagShare 0,02 NÃO encolhe o contador', () => {
    comShares({ flagShare: 0.02 });
    const { container } = render(<MainScreen />);
    // 1000 linhas (a soma das flags), inteiras: com flagShare no produto seriam 20.
    expect(linhasLidas(container)).toContain('1000');
    expect(linhasLidas(container)).not.toContain('20 de');
  });

  it('as demais dimensões continuam encolhendo', () => {
    comShares({ yearShare: 0.5 });
    const { container } = render(<MainScreen />);
    expect(linhasLidas(container)).toContain('500');
  });
});
