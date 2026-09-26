// Glossary.cov.test.jsx — coverage smoke + branch tests for the glossary surface
// (Glossary.jsx). Two scopes: scope="global" (searchable across all bancos, grouped
// by banco/tema) and scope="<bancoId>" (per-banco, grouped by category). We drive the
// main branches: the unfiltered render, a search needle that matches (term/short/tag),
// the category filter, the no-match empty state, the tema-vs-banco overline, and the
// per-banco grouping. window.GLOSSARY + window.Icon are stubbed as plain globals so the
// component's logic is exercised against a controlled fixture.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// A small, controlled glossary: one banco + one tema, each with a couple of terms
// across two categories — enough to exercise every grouping / filter branch.
const GLOSSARY = {
  ibge_pevs: {
    label: 'IBGE PEVS',
    sub: 'Produção da Extração Vegetal',
    terms: [
      { term: 'PEVS', cat: 'Fonte', tag: 'IBGE', short: 'Produção da Extração Vegetal e da Silvicultura.' },
      { term: 'Açaí', cat: 'Produto', tag: '49103', short: 'Fruto da palmeira Euterpe oleracea.' },
      { term: 'Lenha', cat: 'Produto', short: 'Madeira para combustão direta, em m³.' },
    ],
  },
  inflacao: {
    label: 'Inflação e câmbio',
    sub: 'Correção monetária',
    kind: 'tema',
    terms: [
      { term: 'IPCA', cat: 'Índice', tag: 'IBGE', short: 'Índice oficial de inflação ao consumidor.' },
    ],
  },
};

function stubGlobals() {
  window.GLOSSARY = GLOSSARY;
  window.Icon = ({ name }) => <i className="icon" data-icon={name} />;
}

let Glossary;

beforeEach(async () => {
  stubGlobals();
  await import('./Glossary.jsx'); // registers window.Glossary
  Glossary = window.Glossary;
});

afterEach(() => cleanup());

describe('Glossary — global scope', () => {
  it('renders every term grouped by banco/tema with the count label', () => {
    const { container } = render(<Glossary scope="global" />);
    // All four terms across both sources are present.
    expect(container.textContent).toContain('PEVS');
    expect(container.textContent).toContain('Açaí');
    expect(container.textContent).toContain('IPCA');
    // The count label: 4 termos · 2 grupos.
    expect(container.querySelector('.gloss-count').textContent).toContain('4 termos');
    expect(container.querySelector('.gloss-count').textContent).toContain('2 grupos');
    // The group overlines distinguish Banco from Tema (kind:'tema').
    const overlines = [...container.querySelectorAll('.gloss-group .overline')].map((e) => e.textContent);
    expect(overlines).toContain('Banco');
    expect(overlines).toContain('Tema');
  });

  it('filters to matching terms via the search box (term/short/tag)', () => {
    const { container } = render(<Glossary scope="global" />);
    const input = container.querySelector('.gloss-search input');
    // "euterpe" matches only Açaí's `short`.
    fireEvent.change(input, { target: { value: 'euterpe' } });
    // Assert on the rendered term names (.gloss-term) — the banco LABEL "IBGE PEVS"
    // always shows in the group header, so check the term rows directly.
    const terms = [...container.querySelectorAll('.gloss-term')].map((e) => e.textContent);
    expect(terms).toEqual(['Açaí']);
    // singular grammar: one term, one group.
    expect(container.querySelector('.gloss-count').textContent).toContain('1 termo ');
    expect(container.querySelector('.gloss-count').textContent).toContain('1 grupo');
    // The clear button appears while a query is active and resets it.
    const clear = container.querySelector('.gloss-clear');
    expect(clear).toBeTruthy();
    fireEvent.click(clear);
    expect(container.textContent).toContain('PEVS'); // back to the full list
  });

  it('matches on a numeric tag (49103 → Açaí)', () => {
    const { container } = render(<Glossary scope="global" />);
    fireEvent.change(container.querySelector('.gloss-search input'), { target: { value: '49103' } });
    expect(container.textContent).toContain('Açaí');
    expect(container.textContent).not.toContain('Lenha');
  });

  it('shows the honest empty state when nothing matches', () => {
    const { container } = render(<Glossary scope="global" />);
    fireEvent.change(container.querySelector('.gloss-search input'), { target: { value: 'zzz-nada' } });
    expect(container.querySelector('.gloss-empty')).toBeTruthy();
    expect(container.textContent).toContain('Nenhum termo corresponde');
  });

  it('narrows by category chip and back to "Todas"', () => {
    const { container } = render(<Glossary scope="global" />);
    const catButtons = [...container.querySelectorAll('.gloss-cat')];
    const produto = catButtons.find((b) => b.textContent === 'Produto');
    expect(produto).toBeTruthy();
    fireEvent.click(produto);
    // Only Produto-category terms survive (Açaí, Lenha); Fonte/Índice drop.
    const terms = [...container.querySelectorAll('.gloss-term')].map((e) => e.textContent);
    expect(terms.sort()).toEqual(['Açaí', 'Lenha']);
    expect(terms).not.toContain('PEVS'); // Fonte-category term dropped
    expect(terms).not.toContain('IPCA'); // Índice-category term dropped
    // The chip is marked active.
    expect(produto.className).toContain('on');
    // Back to Todas restores all four terms.
    const todas = catButtons.find((b) => b.textContent === 'Todas');
    fireEvent.click(todas);
    const all = [...container.querySelectorAll('.gloss-term')].map((e) => e.textContent);
    expect(all).toContain('PEVS');
    expect(all).toContain('IPCA');
  });
});

describe('Glossary — per-banco scope', () => {
  it('groups by category and uses the "de N termos" count', () => {
    const { container } = render(<Glossary scope="ibge_pevs" />);
    // Only the PEVS banco terms (3) — IPCA (a different source) is absent.
    expect(container.textContent).toContain('PEVS');
    expect(container.textContent).not.toContain('IPCA');
    // per-banco count grammar: "3 de 3 termos".
    expect(container.querySelector('.gloss-count').textContent).toContain('3 de 3 termos');
    // Per-banco overline reads Categoria (not Banco/Tema).
    const overlines = [...container.querySelectorAll('.gloss-group .overline')].map((e) => e.textContent);
    expect(overlines).toContain('Categoria');
    // The per-banco search placeholder differs from the global one.
    expect(container.querySelector('.gloss-search input').placeholder).toContain('neste banco');
  });

  it('filters within the banco and updates the de-N count', () => {
    const { container } = render(<Glossary scope="ibge_pevs" />);
    fireEvent.change(container.querySelector('.gloss-search input'), { target: { value: 'lenha' } });
    expect(container.textContent).toContain('Lenha');
    expect(container.textContent).not.toContain('Açaí');
    expect(container.querySelector('.gloss-count').textContent).toContain('1 de 3 termos');
  });
});

// O glossário REAL, não a fixture: é ele que carrega as marcas *termo* (controle
// editorial, v1.96.0). A marca tem de chegar à tela como itálico, nunca como asterisco.
describe('Glossary — itálico dos conceitos estrangeiros (glossário real)', () => {
  let real;
  beforeAll(async () => {
    await import('./glossary.js');
    real = window.GLOSSARY;
  });

  it('renderiza *drawback* e *Commodity* como <em>, sem asterisco na tela', () => {
    window.GLOSSARY = real;
    const { container } = render(<Glossary scope="global" />);
    const italicos = [...container.querySelectorAll('.gloss-short em')].map((e) => e.textContent);
    expect(italicos).toEqual(expect.arrayContaining(['drawback', 'Commodity']));
    // A família val_real_* tem asterisco legítimo — só a MARCA (início de palavra) é defeito.
    const marcas = [...container.querySelectorAll('.gloss-short')]
      .map((e) => e.textContent).filter((t) => /(^|[\s(“])\*[^\s*]/.test(t));
    expect(marcas).toEqual([]);
  });

  it('a busca acha o termo marcado pelo texto puro', () => {
    window.GLOSSARY = real;
    const { container } = render(<Glossary scope="global" />);
    fireEvent.change(container.querySelector('.gloss-search input'), { target: { value: 'admissão temporária, drawback' } });
    const termos = [...container.querySelectorAll('.gloss-term')].map((e) => e.textContent);
    expect(termos).toEqual(expect.arrayContaining(['Par regime × fluxo', 'Regime aduaneiro']));
  });
});
