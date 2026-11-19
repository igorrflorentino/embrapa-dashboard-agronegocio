// CsvExportModal.test.jsx — the refusal says WHY there is nothing to download.
//
// Each reason gets its own advice, because the wrong advice is worse than none: telling
// someone who chose no territory to "widen the geography" sends them to a filter that
// does nothing on that screen.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The export's own source: every refusal reason it can give is a string literal there.
const CSV_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'csvExport.js'), 'utf8');
const FALLBACK = 'O banco IBGE PEVS ainda não está liberado, então não há dados para baixar.';

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

  it('a território whose read failed says so, and does not ask to wait for it', () => {
    const m = msg('falha-territorios');
    expect(m).toMatch(/Não foi possível carregar os dados de parte dos territórios/);
    expect(m).not.toMatch(/carregando/);
  });

  it('a sub-UF narrowing that failed, or is still on its way, each get their own advice', () => {
    expect(msg('falha-recorte')).toMatch(/Não foi possível carregar os dados do recorte geográfico/);
    expect(msg('carregando-recorte')).toMatch(/ainda estão carregando/);
  });

  it('a per-product series under a sub-UF recorte is refused for good, and says what to change', () => {
    const m = msg('recorte-nao-se-aplica');
    expect(m).toMatch(/só para o Brasil inteiro/);
    expect(m).toMatch(/Retire esse recorte do filtro de geografia/);
    expect(m).not.toMatch(/carregando|Espere/); // waiting would not help
  });

  it('the basket × UF cross on its way, or failed, each get their own advice', () => {
    expect(msg('carregando-cesta-uf')).toMatch(/ainda está carregando/);
    const m = msg('falha-cesta-uf');
    expect(m).toMatch(/Não foi possível carregar o cruzamento dos produtos escolhidos com as UFs/);
    expect(m).not.toMatch(/carregando/);
  });

  it('anything else is the banco not yet released', () => {
    expect(msg('banco-indisponivel')).toBe(FALLBACK);
  });

  // An unknown reason falls through to the banco message, which would explain a failed read
  // as "not released yet" — wrong, and confidently so. Every reason the export gives must
  // have its own words (v1.108.1 added three).
  it('every reason csvExport.js can give has its own message, never the banco fallback', () => {
    const motivos = [...new Set([
      ...[...CSV_SRC.matchAll(/'((?:sem|carregando|falha)(?:-[a-z]+)*)'/g)].map((m) => m[1]),
      // A reason written straight into `motivo:`, whatever its first word (v1.108.2 added
      // 'recorte-nao-se-aplica', which the prefix list above would not see).
      ...[...CSV_SRC.matchAll(/motivo: '([a-z]+(?:-[a-z]+)*)'/g)].map((m) => m[1]),
    // The one reason whose words ARE the banco message: an unreleased banco.
    ].filter((m) => m !== 'banco-indisponivel'))];
    expect(motivos).toEqual(expect.arrayContaining(
      ['sem-linhas', 'sem-territorios', 'carregando', 'falha-territorios', 'falha-recorte', 'carregando-recorte',
        'carregando-cesta-uf', 'falha-cesta-uf', 'recorte-nao-se-aplica']));
    for (const motivo of motivos) {
      cleanup();
      expect(msg(motivo), motivo).not.toBe(FALLBACK);
    }
  });
});
