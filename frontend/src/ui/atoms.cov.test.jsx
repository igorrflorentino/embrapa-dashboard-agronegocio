// atoms.cov.test.jsx — coverage smoke tests for the small presentational primitives:
//   Icon · Sparkline/KpiCardSpark · Status (Maturity*/Usage*) · UnitFamily(Banner|Tag) ·
//   DataBoundary (FreshnessBanner/DataLoading/DataError) · ViewComingSoon ·
//   ViewNotApplicable · ViewPerspectiveSoon · Atoms (SectionHeader/UfScopePicker/EmptyCard).
//
// These are all tiny window.* side-effect modules. Each block installs the minimal
// globals the component reads (mirroring the existing .cov.test pattern of stubbing
// the registries directly rather than booting the full UI), imports the source for its
// side effect, then renders via React.createElement against the global React.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import React from 'react';

const h = React.createElement;

beforeAll(() => {
  globalThis.React = React;
  window.React = React;
});

afterEach(cleanup);

// ── Icon ─────────────────────────────────────────────────────────────────────
describe('Icon', () => {
  beforeAll(async () => {
    await import('./Icon.jsx');
  });

  it('renders an <svg> for a known icon name', () => {
    const { container } = render(h(window.Icon, { name: 'search' }));
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('honours a custom size', () => {
    const { container } = render(h(window.Icon, { name: 'info', size: 32 }));
    const svg = container.querySelector('svg');
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('height')).toBe('32');
  });

  it('renders nothing for an unknown icon name', () => {
    const { container } = render(h(window.Icon, { name: 'does-not-exist' }));
    expect(container.querySelector('svg')).toBeNull();
  });
});

// ── Sparkline + KpiCardSpark ──────────────────────────────────────────────────
describe('Sparkline + KpiCardSpark', () => {
  beforeAll(async () => {
    window.Icon = ({ name }) => h('span', { 'data-icon': name });
    await import('./Sparkline.jsx');
  });

  it('Sparkline renders an svg polyline from a data series', () => {
    const data = [{ v: 1 }, { v: 5 }, { v: 3 }];
    const { container } = render(h(window.Sparkline, { data }));
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('polyline')).toBeTruthy();
    expect(container.querySelector('polygon')).toBeTruthy();
    expect(container.querySelector('circle')).toBeTruthy();
  });

  it('Sparkline copes with a flat (zero-span) series', () => {
    const data = [{ v: 7 }, { v: 7 }];
    const { container } = render(h(window.Sparkline, { data }));
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('Sparkline reads a custom valueKey', () => {
    const data = [{ q: 2 }, { q: 9 }];
    const { container } = render(h(window.Sparkline, { data, valueKey: 'q' }));
    expect(container.querySelector('polyline')).toBeTruthy();
  });

  it('KpiCardSpark renders its label + value, with the spark when long enough', () => {
    const { container } = render(
      h(window.KpiCardSpark, {
        label: 'Produção',
        value: '1.234',
        sub: 'sub',
        delta: '+5%',
        deltaPositive: true,
        spark: [{ v: 1 }, { v: 2 }],
      })
    );
    expect(container.textContent).toContain('Produção');
    expect(container.textContent).toContain('1.234');
    expect(container.querySelector('.kpi-delta.up')).toBeTruthy();
    expect(container.querySelector('svg')).toBeTruthy(); // sparkline present (length > 1)
  });

  it('KpiCardSpark omits the spark for a single-point series and shows the down delta', () => {
    const { container } = render(
      h(window.KpiCardSpark, {
        label: 'X',
        value: '0',
        delta: '-3%',
        deltaPositive: false,
        spark: [{ v: 1 }],
      })
    );
    expect(container.querySelector('.kpi-delta.down')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull(); // single-point spark suppressed
  });

  it('KpiCardSpark renders without a delta', () => {
    const { container } = render(h(window.KpiCardSpark, { label: 'L', value: 'V' }));
    expect(container.querySelector('.kpi-delta')).toBeNull();
  });

  it('a variação AUSENTE é neutra e SEM seta — não verde para cima nem vermelha', () => {
    // `fmtSigned(null)` devolve '—', uma STRING: o bloco da variação renderiza. E como
    // `null >= 0` é true em JS, os call sites entregavam `true` aqui e a tela mostrava
    // seta verde para cima ao lado do travessão que declara a ausência. Os call sites
    // "guardados" entregavam `null`, que o átomo lia como 'down' — vermelho, também uma
    // afirmação. Um terceiro estado é a única saída honesta.
    const { container } = render(
      h(window.KpiCardSpark, { label: 'L', value: 'V', delta: '—', deltaPositive: null })
    );
    const chip = container.querySelector('.kpi-delta');
    expect(chip, 'o travessão da variação sumiu do card').toBeTruthy();
    expect(chip.className).toContain('none');
    expect(chip.className).not.toContain('up');
    expect(chip.className).not.toContain('down');
    // A seta é uma AFIRMAÇÃO de direção; sobre uma ausência, não pode existir.
    expect(container.querySelector('svg, .icon, [class*="arrow"]')).toBeNull();
  });
});

// ── Status (MaturityTag/UsageDot/UsageTag/MaturityBanner/MaturityLegend) ───────
describe('Status indicators', () => {
  const MATURITY = {
    planejado: { id: 'planejado', label: 'Planejado', color: 'var(--gray)', desc: 'd', order: 1 },
    beta: { id: 'beta', label: 'Beta', color: 'var(--info)', desc: 'em beta', caveat: true, order: 4 },
    estavel: { id: 'estavel', label: 'Estável', color: 'var(--ok)', desc: 'estável', order: 5 },
  };

  beforeAll(async () => {
    window.MATURITY = MATURITY;
    window.maturityMeta = (b) => (b && b.maturity ? MATURITY[b.maturity] : MATURITY.planejado);
    await import('./Status.jsx');
  });

  it('MaturityTag renders the label + dot from an explicit status', () => {
    const { container } = render(h(window.MaturityTag, { status: 'beta' }));
    expect(container.textContent).toContain('Beta');
    expect(container.querySelector('.mat-tag-dot')).toBeTruthy();
    expect(container.querySelector('.mat-beta')).toBeTruthy();
  });

  it('MaturityTag falls back to maturityMeta(banco) and honours size=sm', () => {
    const { container } = render(h(window.MaturityTag, { banco: { maturity: 'estavel' }, size: 'sm' }));
    expect(container.textContent).toContain('Estável');
    expect(container.querySelector('.mat-tag.sm')).toBeTruthy();
  });

  it('MaturityTag uses planejado fallback for an unknown status', () => {
    const { container } = render(h(window.MaturityTag, { status: 'bogus' }));
    expect(container.textContent).toContain('Planejado');
  });

  it('UsageDot reflects the active flag', () => {
    const on = render(h(window.UsageDot, { active: true }));
    expect(on.container.querySelector('.use-dot.on')).toBeTruthy();
    cleanup();
    const off = render(h(window.UsageDot, { active: false }));
    expect(off.container.querySelector('.use-dot.off')).toBeTruthy();
  });

  it('UsageTag shows Ativo/Inativo text and shares the maturity-tag chip style', () => {
    const a = render(h(window.UsageTag, { active: true }));
    expect(a.container.textContent).toContain('Ativo');
    // Harmonized: reuses the .mat-tag chip base so the two hero status pills
    // (maturity + usage) read as one visual family (audit HERO-2).
    expect(a.container.querySelector('.mat-tag.use-on')).toBeTruthy();
    cleanup();
    const i = render(h(window.UsageTag, { active: false }));
    expect(i.container.textContent).toContain('Inativo');
    expect(i.container.querySelector('.mat-tag.use-off')).toBeTruthy();
  });

  it('UsageTag size="sm" applies the small chip modifier (matches the hero maturity tag)', () => {
    const sm = render(h(window.UsageTag, { active: true, size: 'sm' }));
    expect(sm.container.querySelector('.mat-tag.use-on.sm')).toBeTruthy();
    cleanup();
    // Default (no size) must NOT carry the sm modifier.
    const reg = render(h(window.UsageTag, { active: false }));
    expect(reg.container.querySelector('.mat-tag.use-off')).toBeTruthy();
    expect(reg.container.querySelector('.sm')).toBeNull();
  });

  it('MaturityBanner shows the registry stage desc (same copy as the Sobre legend) + date', () => {
    const { container } = render(
      h(window.MaturityBanner, { banco: { maturity: 'beta', maturityDate: '2026-06' } })
    );
    expect(container.querySelector('.mat-banner-beta')).toBeTruthy();
    expect(container.textContent).toContain('Beta');
    expect(container.textContent).toContain('2026-06');
    // The caveat copy is MATURITY.beta.desc — IDENTICAL to the maturity legend in
    // "Sobre o dashboard", so the beta description reads the same in both places.
    expect(container.textContent).toContain(MATURITY.beta.desc);
  });

  it('MaturityBanner prefers an explicit banco.maturityNote over the registry desc', () => {
    const { container } = render(
      h(window.MaturityBanner, { banco: { maturity: 'beta', maturityNote: 'Nota custom' } })
    );
    expect(container.textContent).toContain('Nota custom');
    expect(container.textContent).not.toContain(MATURITY.beta.desc);
  });

  it('MaturityBanner renders nothing for a non-caveat stage or no banco', () => {
    const stable = render(h(window.MaturityBanner, { banco: { maturity: 'estavel' } }));
    expect(stable.container.querySelector('.mat-banner')).toBeNull();
    cleanup();
    const none = render(h(window.MaturityBanner, { banco: null }));
    expect(none.container.firstChild).toBeNull();
  });

  it('MaturityLegend lists every registry stage, sorted by order', () => {
    const { container } = render(h(window.MaturityLegend, { compact: true }));
    const rows = container.querySelectorAll('.mat-legend-row');
    expect(rows.length).toBe(Object.keys(MATURITY).length);
    expect(container.querySelector('.mat-legend.compact')).toBeTruthy();
  });
});

// ── UnitFamily (Banner + Tag) ─────────────────────────────────────────────────
describe('UnitFamily', () => {
  const UNIT_FAMILIES = {
    mass: { id: 'mass', label: 'Massa', unit: 't', long: 'toneladas', color: 'var(--green)' },
    volume: { id: 'volume', label: 'Volume', unit: 'm³', long: 'metros cúbicos', color: 'var(--blue)' },
  };

  beforeAll(async () => {
    window.UNIT_FAMILIES = UNIT_FAMILIES;
    await import('./UnitFamily.jsx');
  });

  it('UnitFamilyBanner renders the single-family banner', () => {
    const { container } = render(h(window.UnitFamilyBanner, { families: ['mass'] }));
    expect(container.querySelector('.ufam-banner.single')).toBeTruthy();
    expect(container.textContent).toContain('Massa');
    expect(container.textContent).toContain('somáveis');
  });

  it('UnitFamilyBanner renders the mixed-basket banner for >1 family', () => {
    const { container } = render(h(window.UnitFamilyBanner, { families: ['mass', 'volume'] }));
    expect(container.querySelector('.ufam-banner.mixed')).toBeTruthy();
    expect(container.textContent).toContain('Cesta mista');
    // No static unit in parentheses — just the family names.
    expect(container.textContent).toContain('Massa + Volume');
    expect(container.textContent).not.toContain('(t)');
    expect(container.textContent).not.toContain('(m³)');
  });

  it('UnitFamilyBanner renders nothing with no families', () => {
    for (const fams of [undefined, null, []]) {
      const { container } = render(h(window.UnitFamilyBanner, { families: fams }));
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });

  it('UnitFamilyTag renders the family label + default unit', () => {
    const { container } = render(h(window.UnitFamilyTag, { family: 'mass' }));
    expect(container.textContent).toContain('Massa · t');
  });

  it('UnitFamilyTag honours the conventions-supplied unit override', () => {
    const { container } = render(
      h(window.UnitFamilyTag, { family: 'mass', conv: { units: { mass: 'kg' } } })
    );
    expect(container.textContent).toContain('Massa · kg');
  });

  it('UnitFamilyTag falls back to the base unit when conv lacks the family', () => {
    const { container } = render(
      h(window.UnitFamilyTag, { family: 'volume', conv: { units: {} } })
    );
    expect(container.textContent).toContain('Volume · m³');
  });
});

// ── DataBoundary (FreshnessBanner / DataLoading / DataError) ───────────────────
describe('DataBoundary widgets', () => {
  beforeAll(async () => {
    window.Icon = ({ name }) => h('span', { 'data-icon': name });
    // useBancoData touches dataStore on import-time use; the widgets below don't,
    // but a minimal store keeps the module's effect hooks from throwing if invoked.
    window.dataStore = {
      subscribe: () => () => {},
      load: () => {},
      status: () => 'ready',
      isStale: () => false,
      error: () => null,
      loadedAt: () => null,
      version: () => null,
      latestAt: () => null,
    };
    await import('./DataBoundary.jsx');
  });

  it('DataLoading renders the skeleton with the banco short name', () => {
    const { container } = render(h(window.DataLoading, { banco: { short: 'IBGE PEVS' } }));
    expect(container.textContent).toContain('Consultando IBGE PEVS');
    expect(container.querySelectorAll('.dl-skel.kpi').length).toBe(4);
  });

  it('DataLoading uses the "dados" fallback with no banco', () => {
    const { container } = render(h(window.DataLoading, {}));
    expect(container.textContent).toContain('Consultando dados');
  });

  it('FreshnessBanner renders the reload affordance with a latestAt timestamp', () => {
    const { container } = render(
      h(window.FreshnessBanner, { banco: {}, latestAt: '2026-06-27', onReload: () => {} })
    );
    expect(container.textContent).toContain('Nova versão da Gold');
    expect(container.textContent).toContain('2026-06-27');
    expect(container.querySelector('.fresh-btn')).toBeTruthy();
  });

  it('FreshnessBanner reload button triggers onReload', () => {
    let called = false;
    const { container } = render(
      h(window.FreshnessBanner, { banco: {}, latestAt: '—', onReload: () => { called = true; } })
    );
    container.querySelector('.fresh-btn').click();
    expect(called).toBe(true);
  });

  it('DataError renders the message + retry button', () => {
    const { container } = render(
      h(window.DataError, { banco: { short: 'PPM' }, message: 'Falha X', onRetry: () => {} })
    );
    expect(container.textContent).toContain('PPM');
    expect(container.textContent).toContain('Falha X');
    expect(container.querySelector('.derr-btn')).toBeTruthy();
  });

  it('DataError retry button triggers onRetry and uses the default copy', () => {
    let called = false;
    const { container } = render(
      h(window.DataError, { banco: null, onRetry: () => { called = true; } })
    );
    expect(container.textContent).toContain('os dados'); // banco fallback
    expect(container.textContent).toContain('BigQuery'); // default message
    container.querySelector('.derr-btn').click();
    expect(called).toBe(true);
  });
});

// ── ViewComingSoon ────────────────────────────────────────────────────────────
describe('ViewComingSoon', () => {
  beforeAll(async () => {
    window.Icon = ({ name }) => h('span', { 'data-icon': name });
    window.MaturityTag = ({ banco }) => h('span', { className: 'mat' }, banco?.maturity || '');
    window.SectionHeader = ({ title, action }) =>
      h('div', { className: 'sh' }, title, action);
    window.bancoTable = (id) => `gold_${id}`;
    window.bancoMeta = (id) => ({
      domain: 'Produção',
      scope: 'Município',
      source: 'IBGE',
      cobertura: {
        years: '1986–2024',
        atualizacao: 'Anual',
        granularidade: 'ano × produto',
        restricoes: 'Sem restrições',
      },
    });
    window.viewLabel = (v) => `Perspectiva ${v}`;
    await import('./ViewComingSoon.jsx');
  });

  const BANCO = {
    id: 'ibge_pam',
    label: 'IBGE PAM',
    sub: 'Produção agrícola municipal',
    maturity: 'ingestao',
    plannedScope: [
      { col: 'reference_year', desc: 'Ano de referência' },
      { col: 'product', desc: 'Produto agrícola' },
    ],
  };

  it('renders a generic, detail-free "Em breve" message', () => {
    const { container } = render(h(window.ViewComingSoon, { banco: BANCO }));
    expect(container.querySelector('.cs-simple')).toBeTruthy();
    expect(container.textContent).toContain('Em breve');
    expect(container.textContent).toContain('ainda não foi implementado');
    // GENERIC: no per-banco schema/coverage detail leaks (so it serves any planned banco).
    expect(container.querySelector('.cs-col-row, .cs-cols, .cs-cov')).toBeNull();
    expect(container.textContent).not.toContain('reference_year');
    expect(container.textContent).not.toContain('gold_ibge_pam');
  });

  it('renders the same window regardless of the banco (planejado, no plannedScope)', () => {
    const { container } = render(
      h(window.ViewComingSoon, { banco: { ...BANCO, maturity: 'planejado', plannedScope: [] } })
    );
    expect(container.querySelector('.cs-simple')).toBeTruthy();
    expect(container.textContent).toContain('Em breve');
  });

  it('renders nothing with no banco', () => {
    const { container } = render(h(window.ViewComingSoon, { banco: null, view: 'overview' }));
    expect(container.firstChild).toBeNull();
  });
});

// ── ViewNotApplicable ─────────────────────────────────────────────────────────
describe('ViewNotApplicable', () => {
  beforeAll(async () => {
    window.Icon = ({ name }) => h('span', { 'data-icon': name });
    window.SectionHeader = ({ title, action }) => h('div', { className: 'sh' }, title, action);
    window.missingCapsLabel = (m) => (m || []).join(', ');
    window.visibleBancos = () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    window.bancoAvailability = (b) => (b.status === 'live' ? 'Disponível' : 'Em breve');
    await import('./ViewNotApplicable.jsx');
  });

  const viewMeta = {
    label: 'Geografia',
    desc: 'Distribuição por UF',
    group: { label: 'Espacial', hint: 'mapas' },
  };

  it('renders the not-applicable hero + compatible bancos list', () => {
    let picked = null;
    const supporters = [
      { id: 'pevs', short: 'PEVS', status: 'live', domain: 'Produção', sub: 'sub1' },
      { id: 'ppm', short: 'PPM', status: 'soon', domain: 'Pecuária', sub: 'sub2' },
    ];
    const { container } = render(
      h(window.ViewNotApplicable, {
        viewMeta,
        banco: { short: 'COMTRADE' },
        missing: ['geo'],
        supporters,
        onPickBanco: (id) => { picked = id; },
      })
    );
    expect(container.textContent).toContain('Não se aplica');
    expect(container.textContent).toContain('Geografia');
    expect(container.textContent).toContain('COMTRADE');
    expect(container.querySelectorAll('.na-banco').length).toBe(2);
    container.querySelector('.na-banco.live').click();
    expect(picked).toBe('pevs');
  });

  it('falls back to "a dimensão necessária" with no missing caps', () => {
    const { container } = render(
      h(window.ViewNotApplicable, { viewMeta, banco: null, supporters: [] })
    );
    expect(container.textContent).toContain('a dimensão necessária');
    expect(container.textContent).toContain('Nenhum banco disponível'); // empty supporters branch
  });

  it('renders nothing with no viewMeta', () => {
    const { container } = render(h(window.ViewNotApplicable, { viewMeta: null }));
    expect(container.firstChild).toBeNull();
  });
});

// ── ViewPerspectiveSoon ───────────────────────────────────────────────────────
describe('ViewPerspectiveSoon', () => {
  beforeAll(async () => {
    window.Icon = ({ name }) => h('span', { 'data-icon': name });
    window.SectionHeader = ({ title, action }) => h('div', { className: 'sh' }, title, action);
    await import('./ViewPerspectiveSoon.jsx');
  });

  it('renders the planned blocks with numbered rows', () => {
    const viewMeta = {
      label: 'Sazonalidade',
      desc: 'Padrões mensais',
      group: { label: 'Temporal', hint: 'séries' },
      planned: ['Heatmap mensal', 'Índice de sazonalidade'],
    };
    const { container } = render(h(window.ViewPerspectiveSoon, { viewMeta }));
    expect(container.textContent).toContain('Em breve');
    expect(container.textContent).toContain('Sazonalidade');
    expect(container.querySelectorAll('.ps-planned-row').length).toBe(2);
    expect(container.textContent).toContain('01');
    expect(container.textContent).toContain('Heatmap mensal');
  });

  it('handles a viewMeta with no planned blocks or group', () => {
    const { container } = render(
      h(window.ViewPerspectiveSoon, { viewMeta: { label: 'X', desc: 'd' } })
    );
    expect(container.querySelectorAll('.ps-planned-row').length).toBe(0);
    expect(container.textContent).toContain('0 blocos');
  });

  it('renders nothing with no viewMeta', () => {
    const { container } = render(h(window.ViewPerspectiveSoon, { viewMeta: null }));
    expect(container.firstChild).toBeNull();
  });
});

// ── Atoms (SectionHeader / UfScopePicker / EmptyCard) — NotApplicableNote is
//    covered by the existing Atoms.test.jsx, here we cover the rest. ────────────
describe('Atoms — SectionHeader / UfScopePicker / EmptyCard', () => {
  beforeAll(async () => {
    window.Icon = ({ name }) => h('span', { 'data-icon': name });
    window.UF_DATA = [
      { uf: 'SP', name: 'São Paulo' },
      { uf: 'PA', name: 'Pará' },
    ];
    await import('./Atoms.jsx');
  });

  it('SectionHeader renders overline + title + action', () => {
    const { container } = render(
      h(window.SectionHeader, { overline: 'Seção', title: 'Título', action: h('span', null, 'Ação') })
    );
    expect(container.querySelector('.overline').textContent).toBe('Seção');
    expect(container.querySelector('.section-title').textContent).toBe('Título');
    expect(container.querySelector('.section-action')).toBeTruthy();
  });

  it('SectionHeader omits the action wrapper when no action is given', () => {
    const { container } = render(h(window.SectionHeader, { overline: 'O', title: 'T' }));
    expect(container.querySelector('.section-action')).toBeNull();
  });

  it('UfScopePicker renders a sorted UF option list with the Brasil default', () => {
    let changed = null;
    const { container } = render(
      h(window.UfScopePicker, { value: 'SP', onChange: (v) => { changed = v; } })
    );
    const opts = [...container.querySelectorAll('option')].map((o) => o.value);
    expect(opts[0]).toBe(''); // Brasil (todas as UFs)
    expect(opts).toContain('SP');
    expect(opts).toContain('PA');
    const select = container.querySelector('select');
    select.value = 'PA';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(changed).toBe('PA');
  });

  it('UfScopePicker uses a custom label and tolerates an empty value', () => {
    const { container } = render(h(window.UfScopePicker, { value: '', onChange: () => {}, label: 'UF' }));
    expect(container.textContent).toContain('UF');
    expect(container.querySelector('select').value).toBe('');
  });

  it('EmptyCard renders its children message inside a subtle card', () => {
    const { container } = render(h(window.EmptyCard, null, 'Sem dados para esta seleção.'));
    expect(container.querySelector('.card.subtle')).toBeTruthy();
    expect(container.textContent).toContain('Sem dados para esta seleção.');
  });
});
