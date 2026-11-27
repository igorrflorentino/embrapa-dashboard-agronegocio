import { describe, it, expect, vi } from 'vitest';

// `colorbarAnchors`/`ptBrMagnitude` são funções PURAS — este arquivo não quer o Plotly,
// só o alcança de carona pelo import de `_base.jsx`. Mockar é o padrão de todo teste de
// gráfico aqui (BarChart, Heatmap, StackedArea, …); esta era a única exceção.
//
// Deixou de ser opcional na plotly.js v4: os `lib/*` são fachadas `require('../src/*')`,
// e esse fonte está migrando para TypeScript — `src/lib/index.js` faz `require('./mod')`
// onde só existe `mod.ts`. O Vite/Rolldown resolve (o build de produção passa); o Vitest
// carrega em CommonJS e morre com "Cannot find module './mod'". `server.deps.inline`
// não cobre, porque o require acontece fora do resolvedor do Vite.
vi.mock('./plotlyBundle', () => ({
  default: { react: () => {}, purge: () => {}, Plots: { resize: () => {} } },
}));

import {
  VERTICAL_COLORBAR, colorbarAnchors, ptBrMagnitude, verticalColorbarUnit,
} from './_base.jsx';

// The colorbar's three anchors (min / centro / max) exist so the reader can place any
// colour on the scale. Three IDENTICAL labels defeat that: they assert the scale is flat
// when it is not. A narrow value range — few regions, a short year window, a zoomed
// município — is exactly when it happens, and it is silent (no error, just a wrong-
// looking legend). So the rule is swept, not spot-checked.

describe('colorbarAnchors — rótulos', () => {
  it('nunca repete um rótulo, em qualquer magnitude ou largura de faixa', () => {
    const bases = [1, 7, 100, 1e3, 5e3, 1e6, 5e6, 1e9, 3.2e9, 1e12];
    const widths = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1, 0.5, 1, 10];
    const falhas = [];
    for (const base of bases) {
      for (const w of widths) {
        for (const sinal of [1, -1]) {
          const min = sinal * base;
          const max = min + base * w;
          const [lo, hi] = min < max ? [min, max] : [max, min];
          if (lo === hi) continue;
          const r = colorbarAnchors(lo, hi);
          if (r === null) continue;                       // devolveu o eixo ao Plotly — ok
          const n = new Set(r.ticktext).size;
          if (n !== r.ticktext.length) {
            falhas.push(`[${lo}, ${hi}] → ${r.ticktext.join(' | ')}`);
          }
        }
      }
    }
    expect(falhas).toEqual([]);
  });

  it('faixa que cruza o zero também separa', () => {
    const r = colorbarAnchors(-5e6, 3e6);
    expect(new Set(r.ticktext).size).toBe(3);
  });

  it('o caso medido que motivou a correção', () => {
    // Antes: ['5 mi', '5 mi', '5 mi'].
    const r = colorbarAnchors(5_000_000, 5_004_000);
    expect(r === null || new Set(r.ticktext).size === 3).toBe(true);
  });

  it('casos REAIS do acervo PEVS, não sintéticos', () => {
    // Medidos sobre /api/geo-yearly (ibge_pevs): 45 combinações de (região × janela de
    // anos) colapsavam os três rótulos. Duas delas, para não perder o alcance real:
    // Centro-Oeste 2018–2019 (t) exibia ['1 mil', '1 mil', '1 mil'], e 2004–2005
    // ['1,5 mil', '1,5 mil', '1,5 mil'] — seleções que qualquer pesquisador faz.
    for (const [lo, hi] of [[1029, 1033], [1473, 1481]]) {
      const r = colorbarAnchors(lo, hi);
      expect(r).not.toBeNull();
      expect(new Set(r.ticktext).size).toBe(3);
    }
  });

  it('faixa degenerada (min === max) continua devolvendo o eixo ao Plotly', () => {
    expect(colorbarAnchors(777, 777)).toBeNull();
    expect(colorbarAnchors(NaN, 10)).toBeNull();
  });

  it('a faixa larga comum não mudou de formato', () => {
    // O caminho quente não pode ganhar decimais: continua na escada bi/mi/mil.
    expect(colorbarAnchors(100, 9_000_000).ticktext).toEqual(['100', '4,5 mi', '9 mi']);
  });

  it('ptBrMagnitude sem `digits` é idêntico ao de antes (nenhum outro consumidor muda)', () => {
    expect(ptBrMagnitude(1_500_000)).toBe('1,5 mi');
    expect(ptBrMagnitude(15_000_000)).toBe('15 mi');
    expect(ptBrMagnitude(0)).toBe('0');
  });
});

// ── The unit of a VERTICAL colour bar (v1.108.12) ─────────────────────────────
//
// Until v1.108.12 the unit was the bar's own title, and its box ran 2.1 px down into the
// top tick label's (measured 2026-11-27, Plotly 4.3.0, after document.fonts.ready): "R$ mi"
// sat glued onto "79 mi". No Plotly attribute parts the two, so the unit is now a layout
// annotation, and keeping it clear is arithmetic over VERTICAL_COLORBAR plus three box
// sizes. jsdom lays nothing out, so those sizes are the browser's, measured on the fix in
// the Geografia and Sazonalidade cards (1280 px, and 375 px on a touch screen). They depend
// on the font sizes, not on the data or the card's width.

describe('verticalColorbarUnit — the unit above a vertical bar', () => {
  const UNIT_BOX = 13;          // the 11 px unit's box (no padding, no border): measured 12.7–13
  const LABEL_HALF = 6;         // half the 10 px tick label's box, centred on the bar's top end
  const MODEBAR_BOTTOM = 27.3;  // the modebar band's bottom edge: measured 26.9–27.3

  // Positions in px from the FIGURE's top edge, the plot's top edge being at topMargin.
  const cb = VERTICAL_COLORBAR;
  const unitTop = cb.topMargin - cb.unitYShift;
  const unitBottom = unitTop + UNIT_BOX;
  const topLabelTop = cb.topMargin + cb.ypad - LABEL_HALF;

  it('leaves a gap between the unit and the top tick label', () => {
    // It was −2.1 px. The arithmetic gives 3 px; the browser measured 3.5 px, in every
    // vertical case of both heatmaps.
    expect(topLabelTop - unitBottom).toBeGreaterThanOrEqual(3);
  });

  it('keeps the unit below the modebar band, which a touch screen always shows', () => {
    // 2.7 px by the arithmetic, 2.7 px measured at 1280 px and 3.1 px on a phone.
    expect(unitTop - MODEBAR_BOTTOM).toBeGreaterThanOrEqual(2);
  });

  it("is one annotation on the bar's column, its box exactly the text's", () => {
    expect(verticalColorbarUnit('R$ mi')).toEqual([{
      text: 'R$ mi',
      xref: 'paper', x: 1.02, xanchor: 'left', xshift: 10,
      yref: 'paper', y: 1, yanchor: 'top', yshift: 2,
      borderpad: 0, borderwidth: 0,
      showarrow: false,
      font: { size: 11 },
    }]);
  });

  it("starts the unit on the bar's left edge, where the title used to start", () => {
    // The bar is drawn xpad px right of x; xshift moves the unit by the same amount.
    const [a] = verticalColorbarUnit('US$');
    expect([a.x, a.xshift]).toEqual([cb.x, cb.xpad]);
  });

  it('draws nothing when there is no unit (an empty annotation still takes a box)', () => {
    for (const unit of ['', null, undefined]) expect(verticalColorbarUnit(unit)).toEqual([]);
  });
});
