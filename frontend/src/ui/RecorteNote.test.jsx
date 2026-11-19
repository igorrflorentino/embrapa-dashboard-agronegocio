// RecorteNote.test.jsx — the one wording for the selected UFs' per-product series (v1.108.3).
//
// Six screens draw applyFilters' per-product series. Under a UF subset those are the UFs' own
// read, and each screen says the same thing about its state through window.seriesPorUf, so one
// read cannot be described six ways. These pin the states and their precedence; the screens'
// own tests pin where each one says it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import './RecorteNote.jsx';

const UF = { productUfRequested: true, productUfLoading: false, productUfLoadError: null, productUfUnavailable: false };

describe('seriesPorUf — the state of the UFs’ per-product series, in words', () => {
  it('nothing to say with no UF subset, or once the UFs’ own series are here', () => {
    expect(window.seriesPorUf(null)).toBeNull();
    expect(window.seriesPorUf({})).toBeNull();
    expect(window.seriesPorUf({ ...UF, productUfRequested: false, productUfLoading: true })).toBeNull();
    expect(window.seriesPorUf(UF)).toBeNull();
  });

  it('on its way: held, and said to be loading', () => {
    expect(window.seriesPorUf({ ...UF, productUfLoading: true })).toEqual({
      estado: 'carregando', texto: 'Carregando as séries por produto das UFs escolhidas…',
    });
  });

  it('failed: held, and said to have failed — ahead of "loading", with the error', () => {
    const r = window.seriesPorUf({ ...UF, productUfLoading: true, productUfLoadError: 'HTTP 503' });
    expect(r.estado).toBe('falha');
    expect(r.erro).toBe('HTTP 503');
    expect(r.texto).toMatch(/^Não foi possível carregar as séries por produto das UFs escolhidas/);
    expect(r.texto).toContain('Recarregue a página');
  });

  it('unavailable: the national series stand, and are said to be national', () => {
    expect(window.seriesPorUf({ ...UF, productUfUnavailable: true })).toEqual({
      estado: 'nacional',
      texto: 'As séries por produto deste banco existem só para o Brasil inteiro: os números '
        + 'por produto desta perspectiva não se limitam às UFs escolhidas.',
    });
  });

  // Found in the preview against prod: the national sentence said "os números por produto
  // abaixo" and Visão geral draws it UNDER its donut, pointing at nothing. The screens mount
  // these texts above their numbers and Visão geral below, so none may name a direction.
  it('no state names a position: the screens mount it both above and below their numbers', () => {
    const estados = [
      { ...UF, productUfLoading: true },
      { ...UF, productUfLoadError: 'HTTP 503' },
      { ...UF, productUfUnavailable: true },
    ];
    for (const f of estados) {
      const { estado, texto } = window.seriesPorUf(f);
      expect(texto, estado).not.toMatch(/\b(abaixo|acima)\b/i);
    }
  });
});

describe('SeriesPorUfNote — the card each screen shows', () => {
  beforeEach(() => { window.Icon = () => null; });
  afterEach(() => { cleanup(); delete window.Icon; });
  const nota = (filtered) => render(<window.SeriesPorUfNote filtered={filtered} />).container.querySelector('.na-note');

  it('renders nothing when nothing needs saying', () => {
    expect(nota(UF)).toBeNull();
    expect(nota({})).toBeNull();
  });

  it('a failure is an alert; loading and national are information', () => {
    expect(nota({ ...UF, productUfLoadError: 'HTTP 503' }).getAttribute('role')).toBe('alert');
    cleanup();
    expect(nota({ ...UF, productUfLoading: true }).getAttribute('role')).toBeNull();
    cleanup();
    expect(nota({ ...UF, productUfUnavailable: true }).getAttribute('role')).toBeNull();
  });
});
