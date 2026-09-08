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
  // ── Os `= ... || 1;` que são GEOMETRIA, não afirmação ──────────────────────
  // O total mascarado é legítimo quando o resultado vira desenho: um total zero desenha
  // nada, e nada é o certo. É ilegítimo quando vira NÚMERO NA TELA — foi por isso que os
  // outros seis do mesmo padrão foram corrigidos, não permitidos.
  {
    trecho: 'const span = max - min || 1;',
    razao: 'Sparkline: `span` é a ESCALA VERTICAL do traço, não um valor exibido. Série ' +
           'plana tem span 0, e dividir por 1 desenha a linha reta que é a leitura certa ' +
           'dela — nenhum número sai daqui para a tela.',
  },
  {
    trecho: 'const max = Math.max(...rows.map(x => x[valueKey] || 0)) || 1;',
    razao: 'ViewGeography: `max` é a LARGURA DA BARRA do ranking de municípios. Com tudo ' +
           'zerado toda barra fica com largura zero, que é o desenho correto; os valores ' +
           'ao lado saem de outro caminho e recusam sozinhos.',
  },
  {
    trecho: 'const total = data.reduce((s, d) => s + val(d), 0) || 1;',
    razao: 'Donut: `total` normaliza os ÂNGULOS das fatias. Quem decide se existe ' +
           'composição é o chamador — e desde a v1.61.0 os quatro chamadores devolvem ' +
           'lista vazia quando não há total, então o Donut nunca recebe um anel de zeros.',
  },
  {
    trecho: 'const total = sorted.reduce((s, v) => s + v, 0) || 1;',
    razao: 'LorenzCurve: `total` normaliza o eixo acumulado da CURVA. Um conjunto vazio ' +
           'desenha a diagonal, que é a leitura correta de "sem desigualdade medida"; a ' +
           'afirmação numérica ao lado é o Gini, que recusa com "n/d" por conta própria.',
  },
  {
    trecho: 'const total = ufSorted.reduce((s, u) => s + u.value, 0) || 1;',
    razao: 'ViewConcentration: esta divisão vive DENTRO do .map sobre ufSorted, que é ' +
           'filtrado a value > 0 — com a lista vazia o corpo não roda, e com um elemento ' +
           'o total já é positivo. A guarda é código morto; o `|| 1` nunca decide nada.',
  },
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
];

// Ternário cujo ramo verdadeiro divide e cujo ramo falso é 0.
const RAZAO_FALLBACK = /\?[^?:\n]*\/[^?:\n]*:\s*0(?![.0-9])/;
// Denominador mascarado: `/ (algo || 1)`.
const DENOMINADOR_MASCARADO = /\/\s*\([^()\n]*\|\|\s*1\s*\)/;

// O MESMO denominador mascarado, uma linha antes: `const total = ... || 1;` e a divisão
// depois. Escapava da regex acima, que exige o `|| 1` dentro da própria divisão — e foi
// exatamente por aí que a concentração top-N devolvia "0%" para um conjunto vazio, no
// mesmo arquivo em que o HHI já recusava com null, 20 linhas acima.
//
// O `|| 1` é LEGÍTIMO quando o resultado vira geometria (largura de barra, ângulo de
// fatia, amplitude de sparkline): ali um total zero desenha nada, e nada é o certo. É
// ilegítimo quando o resultado vira NÚMERO NA TELA, porque "0% concentrado" se lê como
// "perfeitamente disperso" — a afirmação oposta de "não há o que concentrar".
const TOTAL_MASCARADO = /\b(?:const|let|var)\s+\w+\s*=[^;\n]*\|\|\s*1\s*;/;

// ── AS DUAS FAMÍLIAS QUE ESCAPARAM DA VARREDURA ACIMA ────────────────────────
//
// A varredura das 22 perspectivas (v1.61.0–v1.67.0) achou 15 defeitos, e duas famílias
// passaram por TODAS as guardas existentes:
//
//   1. Aritmética CRUA sobre uma medida que pode faltar — `null * fator`,
//      `Math.round(null)` e `null / fator` são todos 0 em JS. Três instâncias, três
//      versões. As regex acima procuram RAZÕES (`x ? a/x : 0`, `|| 1`), e nenhuma delas
//      é uma razão: multiplicar e arredondar não são dividir.
//   2. `.toFixed()` sobre um valor anulável — `null.toFixed` LEVANTA, e derrubou a
//      perspectiva inteira duas vezes (Comparação entre fontes, na v1.66.1).
//
// As duas famílias têm a mesma origem: um contrato virou anulável e os consumidores dele
// não foram varridos. Estas varreduras são o passo que faltava nesse procedimento.

// Os campos que os serializers emitem por uma função ANULÁVEL. A lista é derivada do
// Python em tests/test_absence_contract_fields.py, que falha se ela divergir — assim ela
// não apodrece quando um serializer novo emitir outro campo anulável.
const CAMPOS_ANULAVEIS = [
  'coefPct', 'markup', 'price', 'share', 'v', 'value', 'valueShare', 'yieldKgHa',
];
const _campos = CAMPOS_ANULAVEIS.join('|');

// `<algo>.<campo anulável> * x` ou `/ x` — aritmética direta sobre o que pode faltar.
const ARITMETICA_CRUA = new RegExp(`\\.(?:${_campos})\\s*[*/]\\s*[A-Za-z0-9_$(]`);
// `Math.round(<algo>.<campo anulável>)` — Math.round(null) === 0.
const ARREDONDA_AUSENTE = new RegExp(`Math\\.round\\([A-Za-z_$][\\w$]*\\.(?:${_campos})\\b`);
// `<identificador ou índice>.toFixed(` — o receptor NÃO é uma expressão entre parênteses
// (essas sempre produzem número). É a forma exata dos dois crashes.
const TOFIXED_NU = /(?<!\))\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*\.toFixed\(/;

const PERMITIDOS_ARITMETICA = [
  {
    trecho: "width: (l.value / max * 100) + '%'",
    razao: 'ViewFlows: LARGURA DE BARRA, não número exibido — e `l.value` vem de ' +
           'serialize_flow, que usa _num sobre USD nominal do comércio (sem lacuna de ' +
           'índice). Geometria sobre um campo que não fica nulo.',
  },
  {
    trecho: 'const share = u.value / total;',
    razao: 'ViewConcentration: vive DENTRO do .map sobre ufSorted, filtrado a value > 0 — ' +
           'o corpo não roda com a lista vazia, e cada linha que chega tem valor positivo ' +
           'por construção. A divisão nunca vê ausência.',
  },
];

const PERMITIDOS_TOFIXED = [
  {
    trecho: "return (n >= 0 ? '+' : '') + n.toFixed(digits).replace('.', ',') + suffix;",
    razao: 'data.fmtSigned: a linha ANTERIOR é `if (n == null) return \'—\';`. O guarda ' +
           'existe, só não cabe na mesma linha — é o formatador central de variação, e ' +
           'recusar a ausência é literalmente a função dele.',
  },
  {
    trecho: "return 'US$ ' + n.toFixed(0);",
    razao: 'enrichment.fmtUsdShort: `const n = Number(v || 0)` no topo da função, então n ' +
           'é sempre número. O `|| 0` ali é sobre um TOTAL de matriz (contagem de valor ' +
           'agregado), não sobre uma medida que possa faltar.',
  },
  {
    trecho: "value: g.toFixed(2).replace('.', ','), ...giniBand(g) };",
    razao: 'ViewConcentration.giniInfo: só roda no ramo `count >= 2`, e window.gini ' +
           'devolve número sempre (0 nos casos degenerados, por decisão registrada). O ' +
           'ramo count < 2 devolve "n/d" sem tocar em g.',
  },
];

describe('varredura: aritmética crua sobre medida ausente', () => {
  const arquivos = [...fontes(join(SRC, 'ui')), ...fontes(join(SRC, 'charts')), ...fontes(join(SRC, 'data'))];

  it('a lista de campos anuláveis não está vazia (a varredura precisa de alvos)', () => {
    expect(CAMPOS_ANULAVEIS.length).toBeGreaterThan(5);
  });

  it('nenhum campo anulável entra em aritmética direta', () => {
    const achados = [];
    for (const caminho of arquivos) {
      readFileSync(caminho, 'utf-8').split('\n').forEach((linha, i) => {
        const t = linha.trimStart();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (!ARITMETICA_CRUA.test(linha) && !ARREDONDA_AUSENTE.test(linha)) return;
        if (linha.includes('Present(')) return;  // já passa por uma primitiva
        // Guarda na MESMA linha: o ternário que recusa a ausência antes de operar.
        if (/Number\.isFinite|== *null|!= *null/.test(linha)) return;
        if (PERMITIDOS_ARITMETICA.some((p) => linha.includes(p.trecho))) return;
        achados.push(`${relative(SRC, caminho)}:${i + 1}\n      ${linha.trim()}`);
      });
    }
    expect(achados, [
      'Aritmética direta sobre um campo que o serializer pode emitir NULO.',
      'Em JS `null * f`, `null / f` e `Math.round(null)` são todos 0 — o zero que o',
      'serializer acabou de recusar volta na tela. Use scalePresent / ratioPresent /',
      'roundPresent. Se o campo aqui não puder ser nulo, registre em',
      'PERMITIDOS_ARITMETICA com a razão.',
      '', ...achados,
    ].join('\n')).toEqual([]);
  });

  it('nenhum `.toFixed` sobre um receptor que pode ser nulo', () => {
    const achados = [];
    for (const caminho of arquivos) {
      readFileSync(caminho, 'utf-8').split('\n').forEach((linha, i) => {
        const t = linha.trimStart();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (!TOFIXED_NU.test(linha)) return;
        // Guarda na MESMA linha: o ternário que já recusa a ausência.
        if (/Number\.isFinite|== *null|!= *null/.test(linha)) return;
        if (PERMITIDOS_TOFIXED.some((p) => linha.includes(p.trecho))) return;
        achados.push(`${relative(SRC, caminho)}:${i + 1}\n      ${linha.trim()}`);
      });
    }
    expect(achados, [
      '`.toFixed()` sobre um identificador que pode ser null — e `null.toFixed` LEVANTA,',
      'derrubando a perspectiva inteira no error boundary (aconteceu duas vezes).',
      'Use numBR/pctBR, que já rendem "—", ou guarde na mesma linha com Number.isFinite.',
      'Uma expressão entre parênteses — `(a / b).toFixed(1)` — sempre produz número e',
      'não é sinalizada. Se o receptor aqui não puder ser nulo, registre em',
      'PERMITIDOS_TOFIXED com a razão.',
      '', ...achados,
    ].join('\n')).toEqual([]);
  });

  it('cada permissão declara uma razão de verdade', () => {
    for (const p of [...PERMITIDOS_ARITMETICA, ...PERMITIDOS_TOFIXED]) {
      expect(p.razao.length, `sem razão: ${p.trecho}`).toBeGreaterThan(60);
      expect(p.razao, `razão vazia: ${p.trecho}`).not.toMatch(/não deu problema|por enquanto|TODO/i);
    }
  });

  it('toda permissão ainda corresponde a código existente', () => {
    const todo = arquivos.map((c) => readFileSync(c, 'utf-8')).join('\n');
    for (const p of [...PERMITIDOS_ARITMETICA, ...PERMITIDOS_TOFIXED]) {
      expect(todo, `permissão obsoleta, remova: ${p.trecho}`).toContain(p.trecho);
    }
  });
});

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
        if (!RAZAO_FALLBACK.test(linha) && !DENOMINADOR_MASCARADO.test(linha)
            && !TOTAL_MASCARADO.test(linha)) return;
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

// ── A terceira forma: a ausência com SETA e COR ───────────────────────────────
//
// O mesmo defeito, uma camada acima do número. `fmtSigned(null)` devolve '—' — uma
// STRING, não null — então o KpiCardSpark renderiza o bloco da variação; e `null >= 0`
// é `true` em JS. Resultado: a variação que NÃO EXISTE aparecia com seta para cima e
// fundo verde, ao lado do próprio travessão que a declara ausente.
//
// Havia três respostas diferentes espalhadas por 11 call sites, e as três erravam:
//   `d >= 0`                        → null vira VERDE
//   `d != null && d >= 0`           → null vira false, e false é VERMELHO no átomo
//   `last.q >= prev.q`              → colore a seta a partir de OUTRA grandeza
// A última é a mais traiçoeira: o número no card vem de uma conta e a seta de outra,
// e as duas só divergem exatamente onde importa.
//
// `window.deltaUp` é a única resposta, e o átomo trata `null` como neutro sem seta.
describe('varredura: a variação ausente não pode apontar direção', () => {
  const arquivos = [...fontes(join(SRC, 'ui')), ...fontes(join(SRC, 'charts')), ...fontes(join(SRC, 'data'))];

  it('a varredura encontra os call sites de deltaPositive (senão passa vazia)', () => {
    const total = arquivos
      .map((c) => (readFileSync(c, 'utf-8').match(/deltaPositive=/g) || []).length)
      .reduce((a, b) => a + b, 0);
    // Âncora externa: 12 call sites, enumerados nas 6 views que mostram variação em
    // KPI — Produtividade 2, Visão geral 4, Rebanho 1, Perfil do produto 3, multi-fonte
    // 1, Perfil do território 1. Se este número cair, alguém apagou um card; se subir
    // sem esta linha mudar, um card novo entrou sem passar pela varredura abaixo.
    expect(total).toBe(12);
  });

  it('todo deltaPositive passa por window.deltaUp', () => {
    const achados = [];
    for (const caminho of arquivos) {
      readFileSync(caminho, 'utf-8').split('\n').forEach((linha, i) => {
        if (!linha.includes('deltaPositive=')) return;
        if (linha.includes('window.deltaUp(')) return;
        achados.push(`${relative(SRC, caminho)}:${i + 1}\n      ${linha.trim()}`);
      });
    }
    expect(achados, [
      'Um call site decidiu a direção da seta por conta própria.',
      'Use window.deltaUp(<a MESMA variação que o card mostra>): devolve true, false ou',
      'null — e null é "não há variação a apontar", que o átomo pinta neutro e sem seta.',
      'Comparar as medidas cruas (last.q >= prev.q) colore a seta a partir de outra',
      'grandeza, e `d >= 0` pinta de verde o travessão da ausência.',
      '', ...achados,
    ].join('\n')).toEqual([]);
  });
});
