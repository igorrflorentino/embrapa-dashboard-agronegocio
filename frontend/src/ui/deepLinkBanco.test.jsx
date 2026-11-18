// deepLinkBanco.test.jsx — a deep link's `?b=` selects a banco only when it names one the
// panel offers; anything else opens the default banco (IBGE PEVS).
//
// The defect (reproduced 2026-11-18 on the main build, served locally against production):
// `/?v=overview&b=comex` — `comex` is the CATALOG's token for MDIC COMEX, whose banco id is
// `mdic_comex` — went through the decoder. The SPA asked /api/source-meta and /api/snapshot for
// banco "comex" (both answer 200 with an empty payload), and the Visão geral died in the error
// boundary with "Cannot read properties of undefined (reading 'totalRows')": MainScreen reads
// the provenance by banco id. The decoder did have a guard, `!bancoById(id)`, but bancoById
// resolves ANY id (an unknown one to BANCOS[0]), so the guard could never fire.
//
// The registry (bancos.js), the menu (views.js), the decoder (urlState.js) and MainScreen are
// all the REAL modules. Only what MainScreen delegates is stubbed — the perspective itself, the
// maturity chrome and the filter engine — the same way MainScreen.cov.test.jsx stubs them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import './bancos.js';
import './views.js';
import './urlState.js';
import './MainScreen.jsx';

const decode = (search) => window.readStateFromURL(search);

describe('?b= — the decoder keeps only a banco the panel offers', () => {
  it.each([
    ['comex', "the catalog's token for MDIC COMEX (banco id mdic_comex) — the reported link"],
    ['comtrade', "the catalog's token for UN COMTRADE (banco id un_comtrade)"],
    ['pevs', "the catalog's token for IBGE PEVS (banco id ibge_pevs)"],
    ['pam', "the catalog's token for IBGE PAM (banco id ibge_pam)"],
    ['ppm', "the catalog's token for IBGE PPM (banco id ibge_ppm)"],
    ['MDIC_COMEX', 'a banco id is matched exactly, case included'],
    ['nao_existe', 'a plain typo'],
  ])('?b=%s opens the default banco (%s)', (b) => {
    const st = decode(`?v=overview&b=${b}`);
    expect(st.database).toBe('ibge_pevs');
    expect(st.view).toBe('overview');
  });

  it('keeps every banco the banco picker offers, exactly as written', () => {
    const offered = window.visibleBancos().map((b) => b.id);
    // The real registry: the five live bancos plus the planned SEFAZ one.
    expect(offered).toEqual(
      expect.arrayContaining(['ibge_pevs', 'ibge_pam', 'ibge_ppm', 'mdic_comex', 'un_comtrade']),
    );
    for (const id of offered) expect(decode(`?v=overview&b=${id}`).database).toBe(id);
  });

  it('an absent or empty ?b= opens the default banco', () => {
    expect(decode('?v=overview').database).toBe('ibge_pevs');
    expect(decode('?v=overview&b=').database).toBe('ibge_pevs');
  });

  it('a banco hidden by the visibility axis cannot be selected by a link either', () => {
    // bancos.js promises that `visible: false` hides the banco from URL restore too.
    const banco = window.BANCOS.find((b) => b.id === 'un_comtrade');
    banco.visible = false;
    try {
      expect(decode('?v=overview&b=un_comtrade').database).toBe('ibge_pevs');
    } finally {
      delete banco.visible;
    }
  });

  it('isSelectableBanco is strict membership: no fallback, no coercion', () => {
    expect(window.isSelectableBanco('mdic_comex')).toBe(true);
    expect(window.isSelectableBanco('comex')).toBe(false);
    expect(window.isSelectableBanco('')).toBe(false);
    expect(window.isSelectableBanco(null)).toBe(false);
    expect(window.isSelectableBanco(undefined)).toBe(false);
    // The resolver keeps its fallback, which the screens rely on to render a banco already
    // chosen inside the app — that is exactly why it cannot validate one from outside.
    expect(window.bancoById('comex').id).toBe('ibge_pevs');
  });
});

describe('the Visão geral renders for the banco the decoder chose', () => {
  const pevs = () => window.BANCOS.find((b) => b.id === 'ibge_pevs');
  let savedMaturity;

  beforeEach(() => {
    // DataGate mounts MainScreen only after /api/source-meta resolved the banco's maturity.
    savedMaturity = pevs().maturity;
    pevs().maturity = 'estavel';
    window.ViewOverview = (props) => (
      <div className="child-overview" data-database={props.database} />
    );
    window.MaturityBanner = () => null;
    window.MaturityTag = () => null;
    window.UsageTag = () => null;
    window.dataStore = { meta: () => null };
    // What the API serves for a banco it does not know: 200, no quality counts. With this
    // snapshot under `database="comex"`, MainScreen throws the TypeError seen in production.
    window.applyFilters = () => ({
      ts: [], ufData: [], ufDataFull: [], qualityFlags: [], productsTotal: 0, _shares: {},
    });
  });

  afterEach(() => {
    cleanup();
    if (savedMaturity === undefined) delete pevs().maturity;
    else pevs().maturity = savedMaturity;
    delete window.dataStore;
  });

  it('/?v=overview&b=comex opens the Visão geral of IBGE PEVS', () => {
    const st = decode('?v=overview&b=comex');
    const { container } = render(
      <window.MainScreen
        view={st.view}
        database={st.database}
        filters={st.summary}
        basket={st.summary.basket}
        conventions={st.conventions}
      />,
    );
    const child = container.querySelector('.child-overview');
    expect(child).toBeTruthy();
    expect(child.dataset.database).toBe('ibge_pevs');
    expect(container.querySelector('.page-title').textContent).toBe('Visão geral');
    expect(container.querySelector('.overline').textContent).toContain('IBGE PEVS');
  });
});
