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

  it('lista curta fica inline, com todos os nomes à vista', () => {
    const { container } = renderNota();
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).toContain('AL (0,715 mil t)');
    expect(container.textContent).toContain('RJ (0,008 mil t)');
  });

  it('lista longa recolhe em <details> SEM perder um nome sequer', () => {
    // O piso de preço tira 38 países do COMEX; enumerá-los inline enterra a conclusão
    // em oito linhas de nomes. Recolher não é omitir — e truncar em "e mais 30"
    // quebraria a busca por um nome específico, que é a razão de a nota existir.
    const muitos = Array.from({ length: 38 }, (_, i) => ({
      name: `País ${i + 1}`, weight: (38 - i) / 1e6,
    }));
    const { container } = renderNota({
      dropped: muitos, labelKey: 'name', substantivo: 'parceiros', cada: 'Cada um',
    });
    const det = container.querySelector('details');
    expect(det, 'lista longa não recolheu').toBeTruthy();
    // A CONTAGEM e a regra ficam à vista, fora do <details>.
    expect(container.querySelector('p').textContent).toContain('38 parceiros');
    // Concordância: 'parceiros' é masculino, e o átomo servia 'Cada uma' a todo mundo.
    expect(container.querySelector('p').textContent).toContain('Cada um fica');
    // E a lista inteira está lá dentro: o primeiro, o último e a contagem batem.
    expect(det.textContent).toContain('País 1 ');
    expect(det.textContent).toContain('País 38 ');
    // Contar por vírgula contaria também as decimais em pt-BR ("0,000038"); o nome é
    // a unidade que importa.
    expect(det.textContent.match(/País \d+ /g)).toHaveLength(38);
    expect(container.textContent).not.toMatch(/e mais \d+/);
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

  it('labelKey nomeia linhas que não são UFs (o ranking de parceiros é de países)', () => {
    const { container } = renderNota({
      dropped: [{ name: 'Lesoto', weight: 0.000001 }, { name: 'Mônaco', weight: 0.001522 }],
      valueKey: 'weight',
      labelKey: 'name',
      fmt: (v) => `${window.numBR(v * 1e6)} kg`,
    });
    expect(container.textContent).toContain('Mônaco (1522 kg), Lesoto (1 kg)');
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
