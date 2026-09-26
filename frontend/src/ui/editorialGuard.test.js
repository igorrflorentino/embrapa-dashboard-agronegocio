// editorialGuard.test.js — a VARREDURA do controle editorial do texto de tela.
//
// As regras (CLAUDE.md § Code Style → Language, "Editorial control"): termo estrangeiro só
// quando é padrão consagrado de interface ou lacuna conceitual; nada de jargão com
// equivalente nativo, verbo aportuguesado inventado ou gíria; o termo escolhido é o mesmo
// em toda parte; conceito estrangeiro mantido vai em itálico em texto longo, nunca em
// rótulo. Sobre o texto da v1.95.4 esta varredura reprova 104 trechos em 20 arquivos —
// "dashboard" ao lado de "painel", "URL" ao lado de "link", "Gold" ao lado de "Base final"
// para a mesma tabela. Nenhuma revisão tinha visto, porque cada tela, lida sozinha,
// parecia certa.
//
// Este arquivo extrai o texto que o pesquisador LÊ — JSX, literais de string e de template
// que são prosa em português, e os atributos que viram texto —, pela ÁRVORE SINTÁTICA, não
// por regex sobre a fonte: comentários, chaves de objeto, classes CSS e identificadores
// ficam de fora por construção. O vocabulário vive em editorialVocabulary.json, que a
// varredura Python (tests/test_editorial_guard.py) lê também.
//
// Achou uma violação? Troque o texto pelo termo em `use`. Se o termo for legítimo AQUI,
// registre em PERMITIDOS com a razão. Se a regra estiver errada, mude o vocabulário.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import VOCAB from './editorialVocabulary.json';
import './italico.jsx';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '..');
const REPO = resolve(SRC, '..', '..');

// ── O que é aceito, e POR QUÊ ────────────────────────────────────────────────
// Cada entrada: o arquivo, um trecho literal do texto e a razão. "Sempre foi assim" NÃO é
// razão; "é um nome próprio / um código que o pesquisador digita" é.
const PERMITIDOS = [];

// ── Casamento de palavra inteira, com acento ─────────────────────────────────
// `\b` do JavaScript é ASCII: "top" casaria em "Topázio". A fronteira aqui é qualquer
// não-letra, não-dígito e não-sublinhado, em Unicode — o mesmo `\w` do re do Python.
const palavra = (p) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${p})(?![\\p{L}\\p{N}_])`, 'giu');
const contaPalavras = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const PROIBIDOS = [
  ...VOCAB.forbidden.map((f) => ({ re: palavra(f.pattern), termo: f.term, use: f.use })),
  ...VOCAB.inventedVerbs.map((v) => ({ re: palavra(v.pattern), termo: 'verbo inventado', use: v.use })),
];
const CAMADAS = new RegExp(palavra(VOCAB.layerNames.pattern).source, 'iu');
const ITALICOS = VOCAB.italic.terms.map((t) => ({ re: palavra(t.pattern), termo: t.term }));
const MIN_LONGO = VOCAB.italic.longTextMinWords;
// A marca de itálico, com as mesmas fronteiras de window.comItalico.
const MARCA = /(^|[\s(“"'‘—–-])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s.,;:!?)”"'’—–-])/;

// ── Extração do texto de tela ────────────────────────────────────────────────
const ATRIBUTOS_TECNICOS = new Set(['className', 'key', 'id', 'htmlFor', 'type', 'role', 'ref', 'style',
  'name', 'href', 'src', 'target', 'rel', 'viewBox', 'd', 'fill', 'stroke', 'xmlns', 'valueKey', 'sparkKey',
  'color', 'sparkColor', 'variant', 'size', 'icon', 'as', 'align', 'kind', 'mode', 'value', 'defaultValue',
  'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'transform', 'points', 'cx', 'cy', 'r', 'x', 'y',
  'width', 'height', 'x1', 'x2', 'y1', 'y2', 'rx', 'ry', 'opacity', 'loading']);
// O navegador desenha estes como texto puro: itálico ali é impossível, não esquecido.
const SAIDAS_TEXTO_PURO = new Set(['title', 'aria-label', 'placeholder', 'alt']);
const CHAMADAS_TECNICAS = new Set(['querySelector', 'querySelectorAll', 'getItem', 'setItem', 'removeItem',
  'addEventListener', 'getPropertyValue', 'get', 'has', 'startsWith', 'endsWith', 'includes', 'split',
  'replace', 'match', 'test', 'getElementById', 'closest', 'log', 'warn', 'error', 'info', 'debug']);
const INLINE = new Set(['strong', 'em', 'b', 'i', 'code', 'a', 'abbr', 'small', 'sup', 'sub', 'mark', 'kbd']);

// Prosa em português, ou rótulo curto Capitalizado (um botão, um título de KPI).
const PT = /[à-úÀ-Ú]|\b(de|do|da|dos|das|não|com|para|por|em|no|na|um|uma|os|as|ao|é|sem|ou)\b/i;
const EN_FUNCAO = /\b(the|and|of|to|is|when|with|from|this|that|for|not|are|be|it|by|an|on|at|as)\b/gi;
const PT_FUNCAO = /\b(de|do|da|dos|das|não|com|para|por|em|no|na|um|uma|os|as|ao|é|sem|ou|que|se|mais)\b/gi;
function ehTextoDeTela(t) {
  const s = t.trim();
  if (s.length < 2 || !/[A-Za-zÀ-ú]/.test(s)) return false;
  if (/var\(--|^#[0-9a-f]{3,8}$|^https?:|^\/|^\.\/|rgba?\(|^[\w.-]+\.(js|jsx|css|json|csv|svg|png)$/i.test(s)) return false;
  if (/^[a-z0-9_]+$/.test(s) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 4) return false;
  const rotulo = /^[A-ZÀ-Ú][\w À-ú·-]{0,30}$/.test(s) && s.split(/\s+/).length <= 3;
  if (!PT.test(s) && !rotulo) return false;
  return (s.match(EN_FUNCAO) || []).length <= (s.match(PT_FUNCAO) || []).length;
}

function fontes(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) { saida.push(...fontes(caminho)); continue; }
    if (!/\.jsx?$/.test(nome) || /\.test\./.test(nome) || nome === 'bootstrap-globals.js') continue;
    saida.push(caminho);
  }
  return saida;
}

const nomeJsx = (el) => (el.openingElement.name.type === 'JSXIdentifier' ? el.openingElement.name.name : null);

function textoJsx(no) {
  if (!no || typeof no.type !== 'string') return '';
  if (no.type === 'JSXText') return no.value;
  return (no.children || []).map(textoJsx).join(' ');
}

// Cada linha: { arquivo, linha, texto, tipo: 'str'|'jsx', chave, atributo, emItalico, palavrasDoBloco }.
export function extrairTexto(codigo, arquivo) {
  const ast = parse(codigo, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });
  const linhas = [];
  const anc = [];
  const contexto = () => {
    let atributo = null;
    let chave = null;
    for (let i = anc.length - 1; i >= 0; i--) {
      const a = anc[i];
      if (a.type === 'JSXElement') break;
      if (a.type === 'JSXAttribute') { atributo = a.name && a.name.name; break; }
    }
    const pai = anc[anc.length - 1];
    if (pai && pai.type === 'ObjectProperty' && !pai.computed) chave = pai.key.name || pai.key.value;
    return { atributo, chave };
  };
  const tecnico = (no, pai, campo) => {
    if (pai && pai.type === 'ObjectProperty' && campo === 'key' && !pai.computed) return true;
    const { atributo } = contexto();
    if (atributo && (ATRIBUTOS_TECNICOS.has(atributo) || atributo.startsWith('data-'))) return true;
    for (let i = anc.length - 1; i >= 0; i--) {
      const c = anc[i];
      if (c.type !== 'CallExpression') continue;
      const f = c.callee;
      if (f.type === 'MemberExpression' && CHAMADAS_TECNICAS.has(f.property && f.property.name)) return true;
      if (f.type === 'Identifier' && ['require', 'fetch', 'cssVar', 'resolveColor'].includes(f.name)) return true;
      break;
    }
    return false;
  };
  const push = (no, texto, extra) => {
    if (!ehTextoDeTela(texto)) return;
    linhas.push({ arquivo, linha: no.loc.start.line, texto: texto.replace(/\s+/g, ' ').trim(), ...extra });
  };
  (function walk(no, pai, campo) {
    if (!no || typeof no.type !== 'string') return;
    if (no.type === 'ImportDeclaration' || no.type === 'ExportAllDeclaration') return;
    if (no.type === 'JSXText') {
      const els = anc.filter((a) => a.type === 'JSXElement');
      const emItalico = els.some((e) => ['em', 'i'].includes(nomeJsx(e)));
      const bloco = [...els].reverse().find((e) => { const n = nomeJsx(e); return n && /^[a-z]/.test(n) && !INLINE.has(n); });
      push(no, no.value, { tipo: 'jsx', chave: null, atributo: null, emItalico,
        palavrasDoBloco: contaPalavras(bloco ? textoJsx(bloco) : no.value) });
    } else if (no.type === 'StringLiteral' && !tecnico(no, pai, campo)) {
      push(no, no.value, { tipo: 'str', ...contexto(), emItalico: false, palavrasDoBloco: contaPalavras(no.value) });
    } else if (no.type === 'TemplateLiteral' && !tecnico(no, pai, campo)) {
      const texto = no.quasis.map((q) => q.value.cooked || '').join(' ');
      push(no, texto, { tipo: 'str', ...contexto(), emItalico: false, palavrasDoBloco: contaPalavras(texto) });
    }
    anc.push(no);
    for (const k of Object.keys(no)) {
      if (['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra'].includes(k)) continue;
      const v = no[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, no, k));
      else if (v && typeof v.type === 'string') walk(v, no, k);
    }
    anc.pop();
  })(ast.program, null, null);
  return linhas;
}

const TEXTO = [join(SRC, 'ui'), join(SRC, 'charts'), join(SRC, 'data')]
  .flatMap(fontes)
  .flatMap((f) => extrairTexto(readFileSync(f, 'utf-8'), relative(REPO, f).replace(/\\/g, '/')));

// ── As regras ────────────────────────────────────────────────────────────────
export function violacoesDeVocabulario(linha) {
  const out = [];
  for (const p of PROIBIDOS) {
    for (const m of linha.texto.matchAll(p.re)) out.push({ ...linha, achado: m[0], regra: `${p.termo} → use “${p.use}”` });
  }
  return out;
}

export function violacaoDeCamada(linha) {
  if (!CAMADAS.test(linha.texto)) return null;
  const ok = VOCAB.layerNames.allowedIn.some((a) => a.file === linha.arquivo && linha.texto.includes(a.contains));
  return ok ? null : { ...linha, regra: 'nome de camada fora de explicação de arquitetura → use “base analítica”' };
}

export function violacoesDeItalico(linha) {
  if (linha.tipo === 'str' && SAIDAS_TEXTO_PURO.has(linha.atributo)) return [];
  if (linha.palavrasDoBloco < MIN_LONGO) return [];   // rótulo: sem itálico
  if (linha.tipo === 'jsx' && linha.emItalico) return [];
  const out = [];
  for (const t of ITALICOS) {
    for (const m of linha.texto.matchAll(t.re)) {
      const marcado = linha.tipo === 'str'
        && linha.texto[m.index - 1] === '*' && linha.texto[m.index + m[0].length] === '*';
      if (!marcado) out.push({ ...linha, achado: m[0], regra: `“${t.termo}” em texto longo sem itálico` });
    }
  }
  return out;
}

const permitido = (v) => PERMITIDOS.some((p) => p.arquivo === v.arquivo && v.texto.includes(p.trecho));
const relatorio = (vs) => vs.map((v) => `${v.arquivo}:${v.linha} — ${v.regra}${v.achado ? ` [${v.achado}]` : ''}: “${v.texto.slice(0, 110)}”`);

describe('controle editorial — o texto que o pesquisador lê', () => {
  it('a extração enxerga o texto de tela (sanidade: sem ela, toda varredura passa vazia)', () => {
    expect(TEXTO.length).toBeGreaterThan(2000);
    expect(TEXTO.some((l) => l.texto === 'Estrutura de dados')).toBe(true);
  });

  it('nenhum estrangeirismo com equivalente nativo, verbo inventado ou gíria', () => {
    const vs = TEXTO.flatMap(violacoesDeVocabulario).filter((v) => !permitido(v));
    expect(relatorio(vs)).toEqual([]);
  });

  it('nomes de camada (Bronze/Silver/Gold/Serving) só nas explicações de arquitetura', () => {
    const vs = TEXTO.map(violacaoDeCamada).filter(Boolean).filter((v) => !permitido(v));
    expect(relatorio(vs)).toEqual([]);
  });

  it('conceito estrangeiro mantido vai em itálico em texto longo', () => {
    const vs = TEXTO.flatMap(violacoesDeItalico).filter((v) => !permitido(v));
    expect(relatorio(vs)).toEqual([]);
  });

  it('a marca *termo* só aparece nos campos que a tela passa por window.comItalico', () => {
    // Fora deles, a marca chegaria à tela como asteriscos literais.
    const vs = TEXTO.filter((l) => l.tipo === 'str' && MARCA.test(l.texto))
      .filter((l) => !VOCAB.italic.renderedRegistries.some((r) => r.file === l.arquivo && r.key === l.chave))
      .map((l) => ({ ...l, regra: 'marca de itálico num campo que não passa por comItalico' }));
    expect(relatorio(vs)).toEqual([]);
  });

  it('PERMITIDOS: cada entrada tem razão e ainda corresponde a uma violação real', () => {
    const todas = [
      ...TEXTO.flatMap(violacoesDeVocabulario),
      ...TEXTO.map(violacaoDeCamada).filter(Boolean),
      ...TEXTO.flatMap(violacoesDeItalico),
    ];
    for (const p of PERMITIDOS) {
      expect(p.razao.length, `razão curta demais para ${p.trecho}`).toBeGreaterThanOrEqual(60);
      expect(todas.some((v) => v.arquivo === p.arquivo && v.texto.includes(p.trecho)),
        `PERMITIDO obsoleto (nada mais casa): ${p.arquivo} — ${p.trecho}`).toBe(true);
    }
  });
});

describe('controle editorial — as próprias regras (contraprova)', () => {
  const linha = (texto, extra = {}) => ({ arquivo: 'x.jsx', linha: 1, texto, tipo: 'str', chave: null,
    atributo: null, emItalico: false, palavrasDoBloco: contaPalavras(texto), ...extra });

  it('o vocabulário compila, e cada entrada diz o que usar', () => {
    for (const f of [...VOCAB.forbidden, ...VOCAB.inventedVerbs]) {
      expect(() => palavra(f.pattern)).not.toThrow();
      expect(f.use.length).toBeGreaterThan(0);
    }
    const termos = VOCAB.forbidden.map((f) => f.term.toLowerCase());
    expect(new Set(termos).size).toBe(termos.length);
  });

  it.each([
    ['Sobre o dashboard', 'dashboard'],
    ['Concentração top-5 UFs', 'top'],
    ['Top 10 · Valor', 'top'],
    ['URL copiada', 'URL'],
    ['Pipeline construído, mas os dados ainda estão sendo baixados', 'pipeline'],
    ['Copiar URL com o estado atual (filtros, view, convenções)', 'view'],
    ['sem mudança de layout.', 'layout'],
    ['Os resultados em cache estão desatualizados.', 'cache'],
    ['O spread entre porteira e porto', 'spread'],
    ['Precisamos taguear os produtos antes de startar a carga', 'verbo inventado'],
    ['Marque uma call para discutir o deadline', 'call'],
  ])('reprova: “%s”', (texto, termo) => {
    const vs = violacoesDeVocabulario(linha(texto));
    expect(vs.map((v) => v.regra.split(' → ')[0])).toContain(termo);
  });

  it.each([
    'Topázio e topografia não são gíria',
    'gold_pevs_production é o nome da tabela',
    'val_real_*_brl e val_yearfx_* são famílias de colunas',
    'Link copiado',
    'Enviar feedback',
    'Ranking de UFs',
    'Status do banco',
    'O cachê do artista não é memória temporária',
  ])('aprova: “%s”', (texto) => {
    expect(relatorio(violacoesDeVocabulario(linha(texto)))).toEqual([]);
  });

  it('camada fora de explicação reprova; dentro da explicação, não', () => {
    expect(violacaoDeCamada(linha('Nova versão da Gold publicada'))).not.toBeNull();
    expect(violacaoDeCamada(linha('agregada na camada de serving'))).not.toBeNull();
    expect(violacaoDeCamada(linha('Tabela de referência do banco na camada Gold (a base analítica).',
      { arquivo: 'frontend/src/ui/MainScreen.jsx' }))).toBeNull();
  });

  it('itálico: texto longo sem marca reprova; marcado, rótulo ou dica nativa não', () => {
    const longo = 'a modalidade legal sob a qual a mercadoria entra, como drawback ou admissão temporária';
    expect(violacoesDeItalico(linha(longo))).toHaveLength(1);
    expect(violacoesDeItalico(linha(longo.replace('drawback', '*drawback*')))).toHaveLength(0);
    expect(violacoesDeItalico(linha('Commodity Pura'))).toHaveLength(0);
    expect(violacoesDeItalico(linha(longo, { atributo: 'title' }))).toHaveLength(0);
    expect(violacoesDeItalico(linha('Silver', { tipo: 'jsx', palavrasDoBloco: 30 }))).toHaveLength(1);
    expect(violacoesDeItalico(linha('Silver', { tipo: 'jsx', palavrasDoBloco: 30, emItalico: true }))).toHaveLength(0);
  });

  it('a extração separa texto de tela de código', () => {
    const codigo = [
      "const a = { term: 'x', short: 'Texto do glossário com *drawback* no meio da frase' };",
      "const b = <p title=\"Dica nativa do navegador\">Texto <strong><em>Silver</em></strong> da camada</p>;",
      "document.querySelector('.top-bar'); console.log('pipeline de teste');",
    ].join('\n');
    const ls = extrairTexto(codigo, 'y.jsx');
    const porTexto = Object.fromEntries(ls.map((l) => [l.texto, l]));
    expect(porTexto['Texto do glossário com *drawback* no meio da frase'].chave).toBe('short');
    expect(porTexto['Dica nativa do navegador'].atributo).toBe('title');
    expect(porTexto.Silver).toMatchObject({ tipo: 'jsx', emItalico: true });
    expect(ls.some((l) => /top-bar|pipeline de teste/.test(l.texto))).toBe(false);
  });
});

describe('window.comItalico / window.textoSimples', () => {
  it('troca *termo* por <em> e preserva o resto', () => {
    const out = window.comItalico('regimes como *drawback* (reexportação) e *Gold*.');
    expect(out.filter((p) => typeof p !== 'string').map((p) => [p.type, p.props.children]))
      .toEqual([['em', 'drawback'], ['em', 'Gold']]);
    expect(out.filter((p) => typeof p === 'string').join('|')).toBe('regimes como | (reexportação) e |.');
  });

  it('não confunde o asterisco de uma família de colunas com marca', () => {
    for (const s of ['val_real_*_brl', 'val_yearfx_* e val_real_*', '2 * 3 * 4', 'sem marca']) {
      expect(window.comItalico(s)).toBe(s);
      expect(window.textoSimples(s)).toBe(s);
    }
  });

  it('textoSimples tira a marca para dica nativa e busca', () => {
    expect(window.textoSimples('camadas *Silver* e *Gold*')).toBe('camadas Silver e Gold');
  });
});
