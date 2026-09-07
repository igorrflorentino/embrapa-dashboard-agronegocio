// absenceGuard.test.js — a VARREDURA que impede a instância nº 16.
//
// A v1.49.0 encontrou o mesmo defeito em 15 pontos: `x ? a/x : 0` — responder ZERO a uma
// pergunta INDEFINIDA. Corrigi os 15 e centralizei as primitivas em seriesUtils. Mas o
// padrão desta base de código é justamente esse: em TODOS os casos a regra certa já
// existia em algum lugar e não tinha se propagado (o Gini recusava com "n/d" 27 linhas
// antes do HHI que não recusava; `price` já preservava `None` no serializer; o
// `latestYearComplete` já resolvia isto na outra ponta da série).
//
// Sem guarda, o 16º é questão de tempo. Este arquivo falha quando um call site NOVO
// reintroduz a forma, e obriga quem o escreveu a ou usar as primitivas, ou registrar aqui
// por que aquele caso é benigno. É o mesmo idioma de test_filter_axes_wiring.py e
// producers.axes.wiring.test.js — varrer o domínio, não somar casos.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '..');

function fontes(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) { saida.push(...fontes(caminho)); continue; }
    if (!/\.jsx?$/.test(nome) || /\.test\./.test(nome)) continue;
    saida.push(caminho);
  }
  return saida;
}

// ── O que conta como benigno, e POR QUÊ ──────────────────────────────────────
// Cada entrada é um trecho literal + a razão. Uma razão só é aceitável se o zero for
// MEDIDO (uma contagem de verdade) ou se não houver divisão por medida ausente.
// "Não deu problema até agora" NÃO é razão.
const PERMITIDOS = [
  {
    trecho: "v >= 1000 ? _nf(v / 1000, 1) + ' bi'",
    razao: 'ViewPartners: troca de ESCALA (bi vs mi), não guarda de denominador — o `: 0` ' +
           'que o padrão casa é o argumento de casas decimais do _nf, não um fallback.',
  },
  {
    trecho: 'allProducts.length ? (selectedProducts.length / allProducts.length) : 0',
    razao: 'dataFilters.productShare: denominador é uma CONTAGEM de produtos. Zero produtos ' +
           'no banco realmente é participação zero, não ausência de medida.',
  },
  {
    trecho: 'return (da && db) ? num / Math.sqrt(da * db) : 0;',
    razao: 'seriesUtils.pearson: variância zero é uma propriedade MEDIDA da série (ela é ' +
           'plana), não um dado que falta. Correlação 0 = "sem relação linear" é a leitura ' +
           'convencional e honesta aqui.',
  },
  {
    trecho: "return (a.length ? a[a.length - 1]?.y - a[0]?.y : 0) || 1;",
    razao: 'seriesUtils.spanYears: conta ANOS, não mede valor. O `|| 1` evita expoente 1/0 ' +
           'numa série de ponto único e está documentado na função.',
  },
  {
    trecho: 'const max = positives.length ? positives[positives.length - 1] : 0;',
    razao: 'BrazilTileMap: é um MÁXIMO sobre uma lista já filtrada para positivos, sem ' +
           'divisão. Lista vazia → escala vazia, que o coroplético pinta como "sem dado".',
  },
  {
    trecho: '/ (data.discrepancy.length || 1)',
    razao: 'ViewsMultiSource: o denominador é o TAMANHO do array, não uma medida. Array ' +
           'vazio → 0/1 = 0, e o numerador também é 0.',
  },
];

// Ternário cujo ramo verdadeiro divide e cujo ramo falso é 0.
const RAZAO_FALLBACK = /\?[^?:\n]*\/[^?:\n]*:\s*0(?![.0-9])/;
// Denominador mascarado: `/ (algo || 1)`.
const DENOMINADOR_MASCARADO = /\/\s*\([^()\n]*\|\|\s*1\s*\)/;

describe('varredura: ausência não pode voltar a virar zero', () => {
  const arquivos = [...fontes(join(SRC, 'ui')), ...fontes(join(SRC, 'charts')), ...fontes(join(SRC, 'data'))];

  it('encontra os arquivos a varrer (a varredura precisa varrer algo)', () => {
    // Guarda do próprio varredor: se o glob quebrar, os testes abaixo passam vazios.
    expect(arquivos.length).toBeGreaterThan(40);
  });

  it('nenhum call site NOVO responde zero a uma razão indefinida', () => {
    const achados = [];
    for (const caminho of arquivos) {
      const linhas = readFileSync(caminho, 'utf-8').split('\n');
      linhas.forEach((linha, i) => {
        if (linha.trimStart().startsWith('//') || linha.trimStart().startsWith('*')) return;
        if (!RAZAO_FALLBACK.test(linha) && !DENOMINADOR_MASCARADO.test(linha)) return;
        if (PERMITIDOS.some((p) => linha.includes(p.trecho))) return;
        achados.push(`${relative(SRC, caminho)}:${i + 1}\n      ${linha.trim()}`);
      });
    }
    expect(achados, [
      'Um call site respondeu 0 a uma razão indefinida — o defeito da v1.49.0.',
      'Use as primitivas de seriesUtils (deltaPct / ratioPresent / scalePresent / addPresent),',
      'que devolvem null e chegam à tela como "—". Se o zero aqui for MEDIDO de verdade,',
      'registre o trecho em PERMITIDOS neste arquivo, com a razão.',
      '', ...achados,
    ].join('\n')).toEqual([]);
  });

  it('cada permissão declara uma razão de verdade (a lista não vira despejo)', () => {
    for (const p of PERMITIDOS) {
      expect(p.razao.length, `sem razão: ${p.trecho}`).toBeGreaterThan(60);
      expect(p.razao, `razão vazia de conteúdo: ${p.trecho}`).not.toMatch(/não deu problema|por enquanto|TODO/i);
    }
  });

  it('toda permissão ainda corresponde a código existente (a lista não apodrece)', () => {
    const todo = arquivos.map((c) => readFileSync(c, 'utf-8')).join('\n');
    for (const p of PERMITIDOS) {
      expect(todo, `permissão obsoleta, remova de PERMITIDOS: ${p.trecho}`).toContain(p.trecho);
    }
  });
});
