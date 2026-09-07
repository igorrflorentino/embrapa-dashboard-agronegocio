// MaterialityFloorNote.test.jsx — a nota que impede a filtragem invisível.
//
// Estes testes existem porque a suíte NÃO pegou os dois defeitos que a tela pegou: com
// o piso de produção (só relativo, 0,01%) a nota saía dizendo "abaixo de 0,0% da
// produção do recorte e de — mil t no total" — um limiar arredondado até virar zero, e
// uma segunda prova que aquele piso não aplica. Nenhum teste exercitava um piso de UMA
// prova só, nem um limiar abaixo de 0,1%.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import './MaterialityFloorNote.jsx';

const DESCARTADAS = [
  { uf: 'RJ', production: 0.008 },
  { uf: 'AL', production: 0.715 },
];

function renderNota(over = {}) {
  const props = {
    dropped: DESCARTADAS,
    valueKey: 'production',
    fmt: (v) => `${window.numBR(v, 3)} mil t`,
    floor: { minShare: 0.0001 },
    floorRel: 1.24,
    titulo: 'Fora do ranking por produção',
    base: 'da produção do recorte',
    porque: 'produção pequena demais',
    segue: 'Seguem no mapa em cinza.',
    ...over,
  };
  return render(<window.MaterialityFloorNote {...props} />);
}

beforeEach(() => {
  window.numBR = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d).replace('.', ','));
});
afterEach(() => cleanup());

describe('MaterialityFloorNote', () => {
  it('não renderiza nada quando o piso não descartou ninguém', () => {
    const { container } = renderNota({ dropped: [] });
    expect(container.textContent).toBe('');
  });

  it('nomeia TODAS as descartadas, da maior para a menor, com a grandeza de cada uma', () => {
    // A lista curta é justamente a informação: um "e mais N" devolveria a filtragem
    // invisível que esta nota existe para impedir.
    const { container } = renderNota();
    expect(container.textContent).toContain('AL (0,715 mil t), RJ (0,008 mil t)');
  });

  it('um limiar pequeno NÃO é arredondado até virar zero', () => {
    // 0,01% com uma casa decimal vira "0,0%", que se lê como "abaixo de zero" — uma
    // regra que não excluiria ninguém, ao lado de uma lista de excluídos.
    const { container } = renderNota();
    expect(container.textContent).toContain('0,01% da produção do recorte');
    expect(container.textContent).not.toContain('0,0% da produção');
  });

  it('um piso de UMA prova não anuncia a outra', () => {
    // PRODUCAO_FLOOR não tem minAbs. `fmt(undefined)` rendia "— mil t no total": um
    // limiar que ninguém aplicou, apresentado como se tivesse sido aplicado.
    const { container } = renderNota();
    expect(container.textContent).not.toContain('no total');
    // O travessão da pontuação é legítimo ("— produção pequena demais"); o defeito era
    // um LIMIAR renderizado como travessão, que é outra coisa.
    expect(container.textContent).not.toContain('— mil t');
  });

  it('um piso de DUAS provas anuncia as duas, ligadas por "e"', () => {
    const { container } = renderNota({
      floor: { minShare: 0.005, minAbs: 1000 },
      fmt: (v) => `${window.numBR(v)} ha`,
      floorRel: 285,
      base: 'da área colhida do recorte',
    });
    expect(container.textContent).toContain('0,5% da área colhida do recorte (285 ha)');
    expect(container.textContent).toContain('1000 ha no total');
  });

  it('sem o piso relativo convertido, a frase omite o parêntese em vez de mostrar vazio', () => {
    const { container } = renderNota({ floorRel: null });
    expect(container.textContent).toContain('0,01% da produção do recorte —');
    expect(container.textContent).not.toContain('()');
  });
});
