// produto.test.js — o nome do produto tem UMA fonte, e a única cópia é fixada aqui.
//
// Duas garantias:
//   1. Nada no código do usuário repete o nome literalmente (um renome futuro que mude
//      só produto.js não pode deixar uma tela para trás).
//   2. O <title> estático do index.html — a única duplicação inevitável, porque o HTML é
//      servido antes do JS — concorda com a constante.
//
// A âncora é EXTERNA ao módulo: os arquivos são lidos do disco, não importados. Um teste
// que só comparasse window.PRODUTO consigo mesmo passaria com as telas desatualizadas.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import './produto.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '../..');
const ler = (rel) => readFileSync(resolve(RAIZ, rel), 'utf-8');

describe('window.PRODUTO — a fonte única do nome', () => {
  it('compõe os nomes a partir do escopo, sem repetir o texto', () => {
    const p = window.PRODUTO;
    expect(p.escopo).toBe('produtos agropecuários e florestais');
    expect(p.nome).toBe('Análise histórica de produtos agropecuários e florestais');
    expect(p.tituloCitacao).toBe('Dashboard de análise histórica de produtos agropecuários e florestais');
    // Os três derivam do MESMO escopo — é isso que faz o renome ser de uma linha.
    for (const s of [p.nome, p.tituloCitacao, p.tituloAba.toLowerCase()]) {
      expect(s.toLowerCase()).toContain(p.escopo.toLowerCase());
    }
  });

  it('o <title> estático do index.html concorda com a constante', () => {
    const html = ler('index.html');
    const m = html.match(/<title>([^<]*)<\/title>/);
    expect(m, 'index.html sem <title>').toBeTruthy();
    expect(m[1]).toBe(window.PRODUTO.tituloAba);
  });

  it('o boot reescreve document.title a partir da constante', () => {
    expect(document.title).toBe(window.PRODUTO.tituloAba);
  });
});

describe('nenhuma tela repete o nome literalmente', () => {
  // Os arquivos que exibiam o nome antes da v1.50.0. Se um renome futuro deixar um deles
  // para trás, é aqui que aparece.
  const TELAS = ['src/ui/AppShell.jsx', 'src/ui/ViewAbout.jsx'];

  it.each(TELAS)('%s lê window.PRODUTO em vez de escrever o nome', (rel) => {
    const src = ler(rel);
    expect(src).toContain('window.PRODUTO');
    expect(src).not.toMatch(/An[áa]lise hist[óo]rica d[eo]s? produtos/i);
  });

  it('o nome antigo não sobrevive em nenhuma superfície lida pelo usuário', () => {
    // produto.js fica de FORA de propósito: é o único arquivo autorizado a escrever o
    // nome antigo, porque é ele que documenta por que o nome mudou. Excluí-lo é o preço
    // de manter essa memória junto da constante, e não numa doc que ninguém abre.
    const suspeitos = [...TELAS, 'src/ui/bancos.js', 'index.html'];
    for (const rel of suspeitos) {
      expect(ler(rel), `${rel} ainda chama o acervo de "agrícola"`).not.toMatch(
        /produtos agr[íi]colas/i,
      );
    }
  });
});
