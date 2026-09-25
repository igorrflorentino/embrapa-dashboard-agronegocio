// CsvExportModal.test.jsx — the refusal says WHY there is nothing to download.
//
// Each reason gets its own advice, because the wrong advice is worse than none: telling
// someone who chose no territory to "widen the geography" sends them to a filter that
// does nothing on that screen.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

beforeEach(async () => {
  window.Icon = () => null;
  await import('./CsvExportModal.jsx');
});
afterEach(() => { cleanup(); delete window.Icon; });

const msg = (motivo) => {
  const { container } = render(
    <window.CsvExportModal preview={{ erro: true, motivo, banco: 'IBGE PEVS' }} onClose={() => {}} />);
  return container.querySelector('.cite-head .caption').textContent;
};

describe('CsvExportModal — the reason for "Nada para baixar"', () => {
  it('an empty cut asks to widen it', () => {
    expect(msg('sem-linhas')).toMatch(/Amplie o período, os produtos ou a geografia/);
  });

  it('no territory chosen asks for one, not for a wider geography', () => {
    const m = msg('sem-territorios');
    expect(m).toMatch(/Nenhum território foi escolhido/);
    expect(m).not.toMatch(/geografia/);
  });

  it('a território still loading asks to wait, so the file comes out whole', () => {
    expect(msg('carregando')).toMatch(/ainda está carregando/);
  });

  it('anything else is the banco not yet released', () => {
    expect(msg('banco-indisponivel')).toBe('O banco IBGE PEVS ainda não está liberado, então não há dados para baixar.');
  });
});
