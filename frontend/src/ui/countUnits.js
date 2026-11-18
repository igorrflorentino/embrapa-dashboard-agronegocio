// countUnits.js — what a count counts, and which counts may be added together.
//
// The 'contagem' family reduces every count to ONE base unit, 'un': a head of cattle, a
// hen egg and a pineapple are each 1 un. That makes them addable as numbers and
// meaningless once added. Until v1.108.0 the Geografia map did exactly that: Mato Grosso
// 2025 showed 3,88 bi under "Quantidade (cabeças)", which was 80,4 mi heads of eight
// species (the herd) plus 3,80 bi eggs (a year's production; measured on prod 2026-11-18).
//
// Two things decide whether two counts may be added:
//   * their NATURE. A herd is a stock (heads alive at year end), eggs are a year's
//     production. The server never adds the two: a reader that sums ACROSS products returns
//     `q_count_stock` and `q_count_flow` (sql._count_split), and nothing returns their sum.
//   * WHAT they count, named by the unit the source publishes ("Cabeças", "Mil dúzias",
//     "Mil frutos"). The server's two totals cannot tell eggs from fruits, so this module
//     checks it: a total whose products count different things is REFUSED (never drawn),
//     and the screens name the products it holds.
//
// Heads of different species ARE the same unit and stay addable; the screens keep saying
// that heads do not compare across species, as they did before.

(function () {
  // "Mil Dúzias " → "mil duzias": the sources disagree on case and accents ("NUMERO
  // (UNIDADE)", "Número de itens"), and the dbt seeds list both spellings of some units.
  const norm = (s) => String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  // The thing counted, per noun. `plural` names ONE base unit of the count ('un'), the
  // magnitude the screens multiply by the convention's count unit.
  const NOUNS = {
    cabecas: { plural: 'cabeças' },
    ovos: { plural: 'ovos' },
    frutos: { plural: 'frutos' },
    arvores: { plural: 'árvores' },
    unidades: { plural: 'unidades' },
  };

  // Every count unit the sources publish, by what it counts (normalized native unit →
  // noun). countUnits.test.js reads the dbt seeds that make a unit a count
  // (unit_family_conversions, pam_count_unit_products, comex_unit, comtrade_unit) and fails
  // on a unit missing here AND on a key no seed publishes, so a new count unit cannot land
  // in a nameless total.
  //   - A unit that names the thing (cabeças, frutos, árvores) gives that thing.
  //   - "Mil dúzias" gives "ovos": IBGE uses it for the egg products of the PPM only
  //     (tabela 74: ovos de galinha, ovos de codorna).
  //   - A unit that only counts (un, dúzia, milheiro, pares, número de itens) gives
  //     "unidades": it says how many, not of what.
  const UNIT_NOUN = {
    'cabeca': 'cabecas',
    'cabecas': 'cabecas',
    'mil duzias': 'ovos',
    'mil frutos': 'frutos',
    'mil arvores': 'arvores',
    'un': 'unidades',
    'unidade': 'unidades',
    'numero (unidade)': 'unidades',
    'numero de itens': 'unidades',
    'duzia': 'unidades',
    'milheiro': 'unidades',
    'pares': 'unidades',
  };

  /** The noun id of what a count product counts ('cabecas', 'ovos', …), or null when its
   *  unit is unknown — and an unknown count is never added to anything. */
  function countNounOf(product) {
    return UNIT_NOUN[norm(product && product.unit_native)] || null;
  }

  // The two totals a reader that sums across products returns (sql._count_split), in the
  // order the screens offer them: the herd first, the defining content of the PPM.
  const TOTALS = [
    { id: 'count_stock', total: 'stock', key: 'q_count_stock',
      member: (p) => p.measure_kind === 'stock', label: (plural) => `Efetivo (${plural})` },
    { id: 'count_flow', total: 'flow', key: 'q_count_flow',
      member: (p) => p.measure_kind !== 'stock', label: (plural) => `Quantidade (${plural})` },
  ];

  /**
   * The count groups of a basket — one per server total that holds any of its products.
   *
   * @param {object[]} products       the banco's product list (snapshot `products`)
   * @param {string[]} selectedCodes  the basket's codes (applyFilters' selectedProducts)
   * @returns {{id, total, key, noun, plural, label, products, mixed, plurals}[]}
   *   `mixed` is true when the products of a total count different things (or something
   *   unknown): that total has no unit, so no screen may draw it. `plurals` names what each
   *   of its products counts, for the note that says why.
   */
  function countGroups(products, selectedCodes) {
    const sel = new Set(selectedCodes || []);
    const counts = (products || []).filter((p) => p && p.family === 'count' && sel.has(p.code));
    return TOTALS.map((t) => {
      const members = counts.filter(t.member);
      if (!members.length) return null;
      const nouns = [...new Set(members.map(countNounOf))];
      const plurals = nouns.map((n) => (n ? NOUNS[n].plural : 'unidade não identificada'));
      const mixed = nouns.length !== 1 || nouns[0] == null;
      const plural = mixed ? null : NOUNS[nouns[0]].plural;
      return {
        id: t.id,
        total: t.total,
        key: t.key,
        noun: mixed ? null : nouns[0],
        plural,
        label: mixed ? null : t.label(plural),
        products: members,
        mixed,
        plurals,
      };
    }).filter(Boolean);
  }

  /** The display unit of a count group under the active convention. A unit worth ONE of
   *  the thing ('un', 'cab') is named by the thing itself, so eggs never read "cab" and a
   *  herd never reads "un"; a multiple the researcher picked ('dz', 'milheiro') keeps its
   *  own label. */
  function countGroupUnit(group, conv) {
    const unitId = window.unitOf ? window.unitOf(conv, 'count') : 'un';
    const fam = (window.UNIT_FAMILIES || {}).count;
    const u = fam && (fam.units || []).find((x) => x.id === unitId);
    if (!u || u.toBase === 1) return group.plural;
    return u.label;
  }

  /** The group a single-measure reading should draw when the basket has NO value at all
   *  (Visão geral's tile map, Concentração): the first drawable group with data in `rows`,
   *  the herd first. Null when none — the caller then has nothing to draw. */
  function countGroupWithData(groups, rows) {
    return (groups || []).find((g) => !g.mixed
      && (rows || []).some((r) => (r[g.key] || 0) > 0)) || null;
  }

  /** Is anything counted in this row (either total)? A PRESENCE test for "UFs cobertas";
   *  it never adds the two totals into a figure. */
  function hasCount(row) {
    return (row.q_count_stock || 0) > 0 || (row.q_count_flow || 0) > 0;
  }

  /** The CSV column of a drawable group, named by what it counts: `efetivo_cabecas` for
   *  the herd, `qtd_ovos` or `qtd_frutos` for a counted production. Until v1.108.0 one
   *  `qtd_contagem_un` column carried heads plus eggs. */
  function countColumn(group) {
    return `${group.total === 'stock' ? 'efetivo' : 'qtd'}_${group.noun}`;
  }

  Object.assign(window, {
    countNounOf,
    countGroups,
    countGroupUnit,
    countGroupWithData,
    hasCount,
    countColumn,
    COUNT_NOUNS: NOUNS,
    COUNT_UNIT_NOUN: UNIT_NOUN,
  });
})();
