// productOrigin.js — the products one ORIGIN offers.
//
// A produto's identity is (banco, tabela, código), and in IBGE PEVS the table IS the origin:
// 289 extração vegetal (native forest), 291 silvicultura (planted forest). The origin filter
// (`tabela`, the `tb` chip) narrows the product UNIVERSE, not only the numbers: under
// "Extração vegetal" the 3 silvicultura produtos are outside the selection.
//
// Until v1.108.5 the counts did not know it. Under either half the screen read "Produtos
// 10 / 10", "10 de 10 produtos" and "Todos (10)", and the picker listed all 10, beside
// numbers that (since v1.108.4) were already the chosen half's. Every place that counts or
// lists products under an origin goes through this one rule:
// - applyFilters (dataFilters.js), and through it the hero, the Visão geral caption and the
//   chip rebuilt from a link (main.jsx);
// - the FilterMenu picker.
//
// Its consumers import it explicitly instead of relying on the script order in main.jsx,
// because the tests import them alone.

/**
 * The products of ONE SIDRA table, or every product when no table is chosen (`tabela`
 * absent or 'all'). Order is preserved.
 *
 * A table that NONE of the products carries is not an origin of this banco, and narrows
 * nothing: a hand-edited link can carry PEVS's `tb=289` into COMEX, whose readers ignore the
 * table on the server (one table per banco). Emptying the list there would hide every
 * product beside numbers that are all of them. The same holds for a products list from
 * before the products carried their table.
 *
 * @param {Array<{code: string, tabela?: string}>|null|undefined} products
 * @param {string|null|undefined} tabela
 * @returns {Array} the products the origin offers
 */
export function productsInOrigin(products, tabela) {
  const list = products || [];
  if (!tabela || tabela === 'all') return list;
  const inOrigin = list.filter((p) => p.tabela === tabela);
  return inOrigin.length ? inOrigin : list;
}

window.productsInOrigin = productsInOrigin;
