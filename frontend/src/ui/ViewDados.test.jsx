// ViewDados.test.jsx — render coverage for the raw tabular-inspection view. It fetches
// the banco's table list (/api/tables) then a page of rows (/api/table); both are mocked.
// Like ViewRebanho, the view uses the GLOBAL React (main.jsx sets window.React in the app),
// so we set it before importing the view (the top-level `const { useState } = React`).

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

let ViewDados;

// One table per medallion layer — exercises the layer-grouped picker (Bronze → Serving).
const TABLES = [
  { id: 'sidra_t3939_raw', label: 'SIDRA 3939 (bruto)', grain: 'cópia fiel do IBGE', layer: 'bronze' },
  { id: 'silver_ibge_ppm', label: 'PPM padronizado', grain: 'tipado + qualidade', layer: 'silver' },
  { id: 'gold_ppm_production', label: 'Pecuária PPM', grain: 'linha por (ano, UF, município)', layer: 'gold' },
  { id: 'serving_ppm_annual', label: 'Tabela anual pré-agregada', grain: 'ano × UF × produto × família', layer: 'serving' },
];
const PAGE = {
  columns: [
    { name: 'reference_year', type: 'INTEGER' },
    { name: 'product_code', type: 'STRING' },
    { name: 'qty_native', type: 'FLOAT' },
  ],
  rows: [[2024, '2670', 238180757], [2023, '2670', null]],
  total: 2400000,
  table: 'gold_ppm_production',
  label: 'Gold · pecuária PPM',
  grain: 'linha por (ano, UF, município)',
};

function mockFetch(tablesBody = TABLES, pageBody = PAGE) {
  global.fetch = vi.fn((url) => {
    // "/api/tables?…" vs "/api/table?…" — the latter never contains the trailing 's'.
    const body = String(url).includes('/api/tables') ? tablesBody : pageBody;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(''),
    });
  });
}

beforeEach(async () => {
  globalThis.React = React;
  window.React = React;
  window.SectionHeader = ({ overline, title, action }) => (
    <div className="sh">
      <span className="sh-ov">{overline}</span>
      <span className="sh-title">{title}</span>
      <span className="sh-action">{action}</span>
    </div>
  );
  mockFetch();
  await import('./ViewDados.jsx');
  ViewDados = window.ViewDados;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ViewDados — raw table inspection', () => {
  it('lists the banco tables and renders the grid columns + rows', async () => {
    const { container } = render(<ViewDados database="ibge_ppm" />);
    // one chip per table (4 layers) appears once /api/tables resolves
    await waitFor(() => expect(container.querySelectorAll('.pp-chip').length).toBe(4));
    // tables are grouped by medallion layer — each layer header is shown
    const layerNames = [...container.querySelectorAll('.dt-layer strong')].map((e) => e.textContent);
    expect(layerNames).toEqual(['Bronze', 'Silver', 'Gold', 'Serving']);
    // grid headers + a row appear once /api/table resolves
    await waitFor(() => expect(container.querySelector('.dt-table')).toBeTruthy());
    const headers = [...container.querySelectorAll('.dt-table thead th')].map((e) =>
      e.textContent.replace(/[▲▼\s]/g, '')
    );
    expect(headers).toEqual(['reference_year', 'product_code', 'qty_native']);
    expect(container.querySelector('.dt-table tbody tr')).toBeTruthy();
    expect(container.querySelector('.dt-null')).toBeTruthy(); // the null cell renders ∅
    expect(container.textContent).toContain('2.400.000'); // pt-BR total row count
  });

  it('shows an honest empty state when the banco has no inspectable tables', async () => {
    mockFetch([], PAGE); // /api/tables → []
    const { container } = render(<ViewDados database="sefaz_nf" />);
    await waitFor(() => expect(container.textContent).toContain('Nenhuma tabela inspecionável'));
    expect(container.querySelector('.dt-table')).toBeNull(); // no grid without a table
  });

  it('re-fetches cleanly when the banco prop changes (the tableBanco guard re-enables)', async () => {
    const { container, rerender } = render(<ViewDados database="ibge_ppm" />);
    await waitFor(() => expect(container.querySelector('.dt-table')).toBeTruthy());
    // Switch banco: the rows effect is gated on tableBanco===database, so the new table
    // list is fetched and the grid renders again without getting stuck.
    rerender(<ViewDados database="mdic_comex" />);
    await waitFor(() => expect(container.querySelectorAll('.pp-chip').length).toBe(4));
    await waitFor(() => expect(container.querySelector('.dt-table')).toBeTruthy());
  });
});
