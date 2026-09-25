// data.js — client-side registries + pt-BR formatters the /api deliberately
// omits, read directly by the views and joined onto the API rows in
// src/data/decorate.js. NOT data: the UF tile grid (col/row), the region and
// quality-flag taxonomies, and the unit-family conversion table.
//
// (This file used to also hold the prototype's synthetic mock series —
// OVERVIEW_TS / PRODUCT_TS / QUALITY_TS / the TOP_* tables. Those were removed
// once every view moved to the API-backed snapshot; the live series now come
// from /api via src/data/. Only the registries + formatters below remain.)
//
// IMPORTANT — unit families
//   PEVS measures volume two ways depending on the commodity:
//     · 'mass'   → t / kg            (castanha, açaí, erva-mate, carvão…)
//     · 'volume' → m³ / L            (madeira em tora, lenha)
//   Quantities of different families MUST NOT be aggregated.
//   Value (BRL real) is family-agnostic and always aggregatable.

// ────────────────────────────────────────────────────────────────────
// Products — the PEVS commodity list (a loading-frame fallback for
// familiesInBasket before a banco snapshot lands; the live list is snapshot.products).
// ────────────────────────────────────────────────────────────────────
window.PRODUCTS = [
  { code: '49101', name: 'Castanha-do-pará',  unit: 't',  family: 'mass'   },
  { code: '49103', name: 'Açaí (fruto)',      unit: 't',  family: 'mass'   },
  { code: '49105', name: 'Palmito',           unit: 't',  family: 'mass'   },
  { code: '49106', name: 'Amêndoa de babaçu', unit: 't',  family: 'mass'   },
  { code: '49108', name: 'Erva-mate',         unit: 't',  family: 'mass'   },
  { code: '49112', name: 'Pinhão',            unit: 't',  family: 'mass'   },
  { code: '49215', name: 'Madeira em tora',   unit: 'm³', family: 'volume' },
  { code: '49216', name: 'Lenha',             unit: 'm³', family: 'volume' },
  { code: '49218', name: 'Carvão vegetal',    unit: 't',  family: 'mass'   },
  { code: '49221', name: 'Borracha (látex)',  unit: 't',  family: 'mass'   },
  { code: '49222', name: 'Cera de carnaúba',  unit: 't',  family: 'mass'   },
  { code: '49224', name: 'Piaçava (fibra)',   unit: 't',  family: 'mass'   },
];

// ── Unit families registry ───────────────────────────────────────────
// REGISTRY-DRIVEN: each family is a physical DIMENSION. Quantities of
// different families are incommensurable and MUST NEVER be aggregated
// together (value/currency is the only family-agnostic aggregate).
// Each family declares a `base` unit and member `units` with `toBase`
// (multiply a quantity in that unit by toBase to get the base unit).
// Adding a unit = one entry; adding a family = one block. The data must
// tell each product its `family` + native `unit` (see SNAPSHOT_CONTRACTS).
//
// `unit`/`long` are kept for back-compat with existing views (default
// display unit + long name). Brazilian agribusiness set below.
window.UNIT_FAMILIES = {
  mass: {
    id: 'mass', label: 'Massa', unit: 't', long: 'toneladas', base: 't', color: 'var(--embrapa-green-darker)',
    units: [
      { id: 'kg', label: 'kg',  long: 'quilograma', toBase: 0.001 },
      { id: 't',  label: 't',   long: 'tonelada',   toBase: 1 },
      { id: '@',  label: '@',   long: 'arroba (15 kg)', toBase: 0.015 },
      { id: 'sc', label: 'sc',  long: 'saca (60 kg)',   toBase: 0.06, note: 'Saca de 60 kg (convenção; varia por produto).' },
    ],
  },
  volume: {
    id: 'volume', label: 'Volume', unit: 'm³', long: 'metros cúbicos', base: 'm³', color: 'var(--pres-yale-blue)',
    units: [
      { id: 'L',  label: 'L',  long: 'litro',       toBase: 0.001 },
      { id: 'hL', label: 'hL', long: 'hectolitro',  toBase: 0.1 },
      { id: 'm³', label: 'm³', long: 'metro cúbico', toBase: 1 },
    ],
  },
  energia: {
    id: 'energia', label: 'Energia', unit: 'MWh', long: 'megawatt-hora', base: 'MWh', color: 'var(--viz-3)',
    units: [
      { id: 'kWh', label: 'kWh', long: 'quilowatt-hora', toBase: 0.001 },
      { id: 'MWh', label: 'MWh', long: 'megawatt-hora',  toBase: 1 },
      { id: 'GJ',  label: 'GJ',  long: 'gigajoule',      toBase: 0.277778 },
      { id: 'boe', label: 'boe', long: 'barril equiv. petróleo', toBase: 1.62803 },
    ],
  },
  // key is the JS family token the serializer emits (massa→'mass', contagem→'count'),
  // NOT the pt word — so UNIT_FAMILIES[pt.family] resolves for livestock head/eggs.
  count: {
    id: 'count', label: 'Contagem', unit: 'un', long: 'unidades', base: 'un', color: 'var(--viz-9)',
    units: [
      { id: 'un',       label: 'un',       long: 'unidade',          toBase: 1 },
      { id: 'dz',       label: 'dz',       long: 'dúzia',            toBase: 12 },
      { id: 'milheiro', label: 'milheiro', long: 'milheiro (1.000)', toBase: 1000 },
      { id: 'cab',      label: 'cab',      long: 'cabeça',           toBase: 1 },
    ],
  },
  area: {
    id: 'area', label: 'Área', unit: 'ha', long: 'hectares', base: 'ha', color: 'var(--viz-10)',
    units: [
      { id: 'm²',  label: 'm²',  long: 'metro quadrado',     toBase: 0.0001 },
      { id: 'ha',  label: 'ha',  long: 'hectare',            toBase: 1 },
      { id: 'alq', label: 'alq', long: 'alqueire (~2,42 ha)', toBase: 2.42, note: 'Alqueire paulista; varia por região.' },
    ],
  },
  // INTENSITY family (a ratio: production per unit area). Like every other
  // family it is incommensurable with the rest and MUST NEVER be summed — a
  // yield is averaged (area-weighted), never added. Base = kg/ha; t/ha and
  // sc/ha (60 kg sack per hectare) convert by their mass-per-hectare factor.
  rendimento: {
    id: 'rendimento', label: 'Rendimento', unit: 'kg/ha', long: 'quilogramas por hectare', base: 'kg/ha', color: 'var(--viz-6)',
    intensity: true,
    units: [
      { id: 'kg/ha', label: 'kg/ha', long: 'quilograma por hectare', toBase: 1 },
      { id: 't/ha',  label: 't/ha',  long: 'tonelada por hectare',   toBase: 1000 },
      { id: 'sc/ha', label: 'sc/ha', long: 'saca (60 kg) por hectare', toBase: 60, note: 'Saca de 60 kg/ha (convenção; varia por produto).' },
    ],
  },
};

// Default display unit per family (used to seed conventions).
window.defaultUnitOf = (familyId) => (window.UNIT_FAMILIES[familyId] || {}).unit || '';
// Lookup a unit's toBase factor within its family.
window.unitToBase = (familyId, unitId) => {
  const fam = window.UNIT_FAMILIES[familyId];
  const u = fam && (fam.units || []).find(x => x.id === unitId);
  return u ? u.toBase : 1;
};
window.familiesInBasket = (productCodes, bancoId) => {
  // Banco-aware: resolve the ACTIVE banco's product list (snapshot first, then
  // the PEVS fallback list above for pre-load). This keeps a mass-only banco
  // (COMEX/Comtrade) from showing spurious volume controls.
  const snap = (bancoId && window.dataStore && window.dataStore.get && window.dataStore.get(bancoId))
            || (bancoId && window.snapshotFor && window.snapshotFor(bancoId))
            || null;
  const products = (snap && snap.products) || window.PRODUCTS || [];
  const famOf = (c) => { const p = products.find(x => x.code === c); return p ? p.family : null; };
  // Keep only DISPLAYABLE unit families (present in UNIT_FAMILIES). A product whose
  // source unit isn't one of the 5 known families gets 'desconhecida' from Silver
  // (common in COMTRADE's varied HS6 units); that sentinel is not a real family and
  // must not reach UnitFamilyBanner/MetricConventions (UNIT_FAMILIES['desconhecida']
  // is undefined → would crash the banner). Its qty_base is NULL anyway (unsummable).
  const known = (f) => !!(f && window.UNIT_FAMILIES && window.UNIT_FAMILIES[f]);
  // null/undefined = "no product filter" → all families present in the banco.
  // An explicit (possibly empty) selection is honoured literally: zero
  // products → zero families (nothing to measure).
  if (productCodes == null) return [...new Set(products.map(p => p.family).filter(known))];
  return [...new Set(productCodes.map(c => famOf(c)).filter(known))];
};

// ────────────────────────────────────────────────────────────────────
// Geography — Brazilian states and regions
// ────────────────────────────────────────────────────────────────────
window.REGIONS = [
  { id: 'N',  label: 'Norte',         color: 'var(--viz-1)' },
  { id: 'NE', label: 'Nordeste',      color: 'var(--viz-3)' },
  { id: 'CO', label: 'Centro-Oeste',  color: 'var(--viz-5)' },
  { id: 'SE', label: 'Sudeste',       color: 'var(--viz-2)' },
  { id: 'S',  label: 'Sul',           color: 'var(--viz-4)' },
];

// 27 UFs · grid position for the tile map (col, row) + region. These are the
// tile coordinates the /api omits (decorate.js joins them onto the API ufData).
window.UF_DATA = [
  // North
  { uf: 'RR', name: 'Roraima',       region: 'N',  col: 3, row: 0 },
  { uf: 'AP', name: 'Amapá',         region: 'N',  col: 5, row: 0 },
  { uf: 'AM', name: 'Amazonas',      region: 'N',  col: 2, row: 1 },
  { uf: 'PA', name: 'Pará',          region: 'N',  col: 4, row: 1 },
  { uf: 'AC', name: 'Acre',          region: 'N',  col: 1, row: 2 },
  { uf: 'RO', name: 'Rondônia',      region: 'N',  col: 2, row: 2 },
  { uf: 'TO', name: 'Tocantins',     region: 'N',  col: 4, row: 2 },
  // Northeast
  { uf: 'MA', name: 'Maranhão',      region: 'NE', col: 5, row: 1 },
  { uf: 'CE', name: 'Ceará',         region: 'NE', col: 6, row: 1 },
  { uf: 'RN', name: 'Rio Grande do Norte', region: 'NE', col: 7, row: 1 },
  { uf: 'PI', name: 'Piauí',         region: 'NE', col: 5, row: 2 },
  { uf: 'PB', name: 'Paraíba',       region: 'NE', col: 7, row: 2 },
  { uf: 'BA', name: 'Bahia',         region: 'NE', col: 5, row: 3 },
  { uf: 'PE', name: 'Pernambuco',    region: 'NE', col: 6, row: 3 },
  { uf: 'AL', name: 'Alagoas',       region: 'NE', col: 6, row: 4 },
  { uf: 'SE', name: 'Sergipe',       region: 'NE', col: 5, row: 5 },
  // Center-West
  { uf: 'MT', name: 'Mato Grosso',   region: 'CO', col: 3, row: 3 },
  { uf: 'MS', name: 'Mato Grosso do Sul', region: 'CO', col: 3, row: 4 },
  { uf: 'GO', name: 'Goiás',         region: 'CO', col: 4, row: 4 },
  { uf: 'DF', name: 'Distrito Federal', region: 'CO', col: 4, row: 5 },
  // Southeast
  { uf: 'MG', name: 'Minas Gerais',  region: 'SE', col: 5, row: 4 },
  { uf: 'ES', name: 'Espírito Santo', region: 'SE', col: 6, row: 5 },
  { uf: 'RJ', name: 'Rio de Janeiro', region: 'SE', col: 5, row: 6 },
  { uf: 'SP', name: 'São Paulo',     region: 'SE', col: 4, row: 6 },
  // South
  { uf: 'PR', name: 'Paraná',        region: 'S',  col: 3, row: 6 },
  { uf: 'SC', name: 'Santa Catarina', region: 'S', col: 3, row: 7 },
  { uf: 'RS', name: 'Rio Grande do Sul', region: 'S', col: 3, row: 8 },
];

// ────────────────────────────────────────────────────────────────────
// Quality dimension — flag taxonomy (id → label + colour). The per-flag
// COUNTS come from the API (snapshot.quality); this is just the display map.
// ────────────────────────────────────────────────────────────────────
// The REAL Gold data_quality_flag taxonomy: dbt/macros/data_quality_flag.sql (the
// cascade) + dbt/macros/quality_outlier_ctes.sql (the implied-price detector, ON in
// prod via enable_quality_outliers), plus two per-banco extras — MISSING_WEIGHT in the
// trade bancos (COMEX inline CASE; COMTRADE since v1.90.0) and AREA_INCONSISTENT in
// gold_pam_production. Labels mirror the
// backend's _FLAG_LABEL_PT (serializers.py) so the donut/legend stays pt-BR.
// The earlier ESTIMATED/BOUNDARY_HISTORIC/OUTLIER ids were the prototype's synthetic
// taxonomy — Gold never emits them, and listing them here silently dropped real rows out
// of the quality charts and the quality filter. Keep this in sync with
// serializers._FLAG_LABEL_PT.
// Labels say what the row IS in plain words (v1.93.0). They started as the "Contrato de
// Dados" spreadsheet's wording ("Normais", "Valor atípico (válido)", "Não avaliada"), which
// had to be decoded: "(válido)" read as a guarantee the detector never gives, and "Normais"
// did not say that the row had been examined. "Sem ressalva" and "Sem base para avaliar"
// repeat the words of the Qualidade KPI. The labels live twice, here and in
// serializers._FLAG_LABEL_PT; tests/test_flag_label_parity.py fails if they differ.
// The Sheet's "inferidos" (auto-preenchido) tier is
// RESERVED for a future auto-fill pipeline: the two INFERRED_* flags below are
// accepted-but-absent (render 0 today, exactly like a Gold flag with no rows).
// `desc` is the plain-pt-BR legend shown in the Qualidade window ("O que significa cada
// flag?"). Every claim in a `desc` was checked against the detector's SQL and measured on
// prod in docs/audits/qualidade_dados_audit_2026-09-24.md — until v1.89.0 the
// PROBLEMATIC_QUANTITY legend said "bem acima do esperado" while 83% of those rows were
// BELOW it. Re-measure before changing a number here.
window.QUALITY_FLAGS = [
  { id: 'OK',                   label: 'Sem ressalva',                      color: 'var(--ok)',     desc: 'O registro tem quantidade e valor, e o sistema conseguiu conferir se os dois combinam. A conferência divide o valor pela quantidade e compara o preço por unidade com o preço típico daquele produto. Nesta linha, nada fugiu do normal.' },
  // A distinção que faltava: "examinada e aprovada" ≠ "nunca examinada". Até a v1.49.0
  // as duas eram 'OK' — na PAM, só 33,6% das linhas 'OK' tinham de fato passado pelo
  // detector (medido em produção 2026-09-06).
  // A descrição enumera os MOTIVOS porque a versão anterior citava só a lacuna do
  // deflator — 12,8% dos casos na PAM, medido em 2026-09-08. O motivo dominante (70%)
  // é o zero medido, e a legenda oficial "o que significa cada flag" não o mencionava.
  { id: 'UNSCORED',             label: 'Sem base para avaliar',             color: 'var(--fg-4)',   desc: 'O sistema não teve como conferir esta linha, o que não quer dizer que ela tenha algum problema. Os casos mais comuns são o município que não produziu nada naquele ano, o registro pequeno demais para uma comparação confiável (abaixo de R$ 100 mil ou US$ 100 mil), o produto com poucos registros para se saber qual é o preço típico e os rebanhos, que são contados em cabeças e não têm preço. É a situação da maioria das linhas, mas elas somam uma parte muito pequena do valor total.' },
  { id: 'MISSING_VALUE',        label: 'Sem valor',                         color: 'var(--warn)',   desc: 'A fonte informou a quantidade, mas deixou o valor em branco. Nas pesquisas do IBGE isso não acontece, porque quando falta informação falta o registro inteiro, e ele nem entra na base. Um município que não teve nenhuma extração vegetal no ano, por exemplo, simplesmente não aparece.' },
  { id: 'MISSING_QUANTITY',     label: 'Sem quantidade',                    color: 'var(--info)',   desc: 'A fonte informou o valor, mas deixou a quantidade em branco. Hoje isso não aparece em nenhuma base, porque no IBGE falta sempre o registro inteiro e, no comércio exterior, o que falta é o peso, que tem marca própria.' },
  { id: 'MISSING_WEIGHT',       label: 'Sem peso',                          color: 'var(--viz-4)',  desc: 'Um registro de comércio exterior que informa o valor, mas não o peso. Sem o peso não dá para calcular o preço por quilo, que é como esses registros são conferidos. Acontece no COMTRADE, quase sempre com madeira, que costuma ser medida em outras unidades.' },
  { id: 'INCOMPLETE',           label: 'Sem valor nem quantidade',          color: 'var(--viz-7)',  desc: 'O registro não tem nem quantidade nem valor, então não há o que analisar.' },
  // "Muito alto" is counted as real and kept by the default filter, but it is not a
  // guarantee: the detector only asks that the price be within 100× of the median, so the
  // desc must say the margin is wide (the old label's "(válida)" said the opposite, and was
  // dropped in v1.93.0). v1.92.1 dropped that caveat while
  // simplifying the text; data_contracts.cov.test.js now pins it. Re-measured on prod
  // 2026-09-24, outliers whose price is ≥ 10× from the median: COMTRADE 460/4.671 (9,8%) ·
  // COMEX 152/3.030 (5,0%) · PEVS 30/1.531 (2,0%) · PAM 52/4.994 (1,0%) · PPM 11/11.773 (0,1%).
  { id: 'OUTLIER_QUANTITY',     label: 'Quantidade muito alta',             color: 'var(--viz-3)',  desc: 'A quantidade é muito maior do que esse produto costuma registrar, mas o preço por unidade fica a menos de 100 vezes do preço típico. Por isso o registro é tratado como um número grande de verdade, como o de um grande produtor, e não como erro. Essa margem é larga, e uma parte desses registros tem preço 10 vezes ou mais longe do típico, então vale conferir antes de usar um deles como referência. A comparação considera toda a história do produto, e quem cresceu muito tende a ter mais registros assim nos anos recentes.' },
  { id: 'PROBLEMATIC_QUANTITY', label: 'Quantidade provavelmente errada',   color: 'var(--viz-9)',  desc: 'O preço por unidade ficou mais de 100 vezes acima ou abaixo do preço típico do produto, e a quantidade é o número que parece fora do lugar. Quase sempre é erro de digitação na fonte. O caso mais comum é o peso registrado como 1 kg numa carga de alto valor, e também aparecem pesos com zeros a mais.' },
  { id: 'OUTLIER_VALUE',        label: 'Valor muito alto',                  color: 'var(--viz-5)',  desc: 'O valor é muito maior do que esse produto costuma registrar, mas o preço por unidade fica a menos de 100 vezes do preço típico. Por isso o registro é tratado como um número grande de verdade, como o de um grande produtor, e não como erro. Essa margem é larga, e uma parte desses registros tem preço 10 vezes ou mais longe do típico, então vale conferir antes de usar um deles como referência. A comparação considera toda a história do produto, e quem cresceu muito tende a ter mais registros assim nos anos recentes.' },
  { id: 'PROBLEMATIC_VALUE',    label: 'Valor provavelmente errado',        color: 'var(--err)',    desc: 'O preço por unidade ficou mais de 100 vezes acima ou abaixo do preço típico do produto, e o valor é o número que parece fora do lugar. Quase sempre é erro de digitação na fonte, como um valor com zeros a mais ou a menos.' },
  // IBGE bancos (v1.92.0): o detector de preço não vê um produto lançado na tabela errada a
  // preço de mercado. Este olha a série no tempo. Medido: 138 linhas em 60 saltos estaduais.
  { id: 'ISOLATED_SPIKE',       label: 'Pico num único ano',                color: 'var(--viz-1)',  desc: 'Um valor grande que aparece num único ano, sem produção no ano anterior nem no seguinte, e que faz o total do estado dar um salto justamente naquele ano. O preço pode parecer normal, mas esse padrão costuma indicar um registro lançado no lugar errado pela fonte. Um exemplo é a madeira nativa registrada em Ortigueira e Telêmaco Borba (PR) só em 2011, que sozinha equivale a quase metade do Paraná naquele ano. Vale olhar o registro antes de usar esse ano na série do estado.' },
  // PAM-only: a SIDRA source error preserved faithfully and now surfaced in-product.
  { id: 'AREA_INCONSISTENT',    label: 'Área plantada menor que a colhida', color: 'var(--viz-6)',  desc: 'A área plantada informada pelo IBGE é menor que a área colhida, o que não é possível, já que não se colhe mais do que se planta. É um erro da própria fonte. O registro fica como veio e recebe esta marca, em vez de ser corrigido sem aviso. Acontece só nas lavouras (PAM).' },
  // Reserved for a FUTURE auto-fill pipeline (accepted-but-absent — render 0 today).
  { id: 'INFERRED_QUANTITY',    label: 'Quantidade estimada',               color: 'var(--viz-8)',  reserved: true, desc: 'Reservada para uma etapa futura que completaria automaticamente uma quantidade que veio em branco. Ainda não é usada.' },
  { id: 'INFERRED_VALUE',       label: 'Valor estimado',                    color: 'var(--viz-10)', reserved: true, desc: 'Reservada para uma etapa futura que completaria automaticamente um valor que veio em branco. Ainda não é usada.' },
];

// Como a legenda "O que significa cada flag?" agrupa as marcas. Cada id do registro acima
// entra em exatamente um grupo (testado em data_contracts.cov.test.js): um id esquecido
// aqui sumiria da legenda sem aviso. A ordem dos grupos e dentro deles é a de leitura.
window.QUALITY_FLAG_GROUPS = [
  { title: 'Conferidas pelo sistema', ids: ['OK', 'OUTLIER_VALUE', 'OUTLIER_QUANTITY', 'ISOLATED_SPIKE', 'PROBLEMATIC_VALUE', 'PROBLEMATIC_QUANTITY'] },
  { title: 'Sem como conferir', ids: ['UNSCORED'] },
  { title: 'Dados que faltam ou não batem na fonte', ids: ['MISSING_VALUE', 'MISSING_QUANTITY', 'MISSING_WEIGHT', 'INCOMPLETE', 'AREA_INCONSISTENT'] },
  { title: 'Reservadas para o futuro', ids: ['INFERRED_QUANTITY', 'INFERRED_VALUE'] },
];

// As flags que significam "o detector de preço implícito RODOU nesta linha" — as que
// ele examinou e liberou (OK) e as que ele examinou e MARCOU (atípico, problemático).
// Existe porque "examinado" não é o complemento de "não avaliada": as linhas incompletas
// (valor/quantidade/peso ausente) e a área inconsistente também nunca passaram pelo
// detector, e `1 - UNSCORED` as contava como examinadas. No COMTRADE isso são 0,893% do
// valor (25.630 linhas com valor e sem quantidade), medido em produção 2026-09-08 — o
// número saía 96,8% sob um rótulo que promete 95,9%. Pequeno, e é justamente o formato de
// erro que este projeto persegue: aritmética certa respondendo outra pergunta.
window.EXAMINED_FLAGS = [
  'OK', 'OUTLIER_VALUE', 'OUTLIER_QUANTITY', 'PROBLEMATIC_VALUE', 'PROBLEMATIC_QUANTITY',
  // Marcada por um detector que examinou a linha (o de picos no tempo, v1.92.0) — examinada.
  'ISOLATED_SPIKE',
];

// ────────────────────────────────────────────────────────────────────
// Formatters
// ────────────────────────────────────────────────────────────────────
// bi/mi/mil ladder kept local on purpose (per-tier decimals), but buckets on the MAGNITUDE
// (|n|) and re-applies the sign — aligned with magnitude.js's abs-based kernel (DEDUP-7), so
// a large negative (e.g. a net balance) abbreviates to "-2,50 bi" instead of falling through
// to the unabbreviated locale string.
// ── Percentages: THREE formatters, TWO opposite input conventions ────────────
//
//     fmtPct(0.6)   → '60,0%'   takes a FRACTION   (multiplies by 100)
//     pctBR(60)     → '60,0%'   takes a PERCENTAGE (only appends '%')
//     fmtSigned(60) → '+60,0%'  takes a PERCENTAGE (like pctBR)
//
// The names do not say which is which, and passing a percentage to fmtPct renders
// something like "4361,4%" — which shipped once (v1.29.0). The payload field names are
// the guardrail: `*Frac` is a fraction, `*Share`/`*Pct` is a percentage, and a call site
// crossing the boundary multiplies EXPLICITLY (`chPct(data.expFrac * 100)`).
//
// formatterContracts.test.js pins all of this against real values — change a convention
// there first, and read it there before writing a call site or a test stub.
window.fmtPct = (n, digits = 1) => {
  if (n == null) return '—';
  return (n * 100).toFixed(digits).replace('.', ',') + '%';
};
window.fmtSigned = (n, digits = 1, suffix = '%') => {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits).replace('.', ',') + suffix;
};

// pt-BR number with a FIXED number of decimals (min = max), or '—' for null.
// Shared by the multi-source / curated views (was copy-pasted as caNum / msNum
// / chNum). `pctBR` appends '%' to an ALREADY-percentage value — distinct from
// fmtPct above, which multiplies a fraction by 100 (see the note there).
//
// The null guard is on pctBR itself, not inherited from numBR: appending '%' to numBR's
// em dash rendered "—%", which reads as a value rather than as absence.
window.numBR = (v, d = 0) =>
  (v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d }));
window.pctBR = (v, d = 1) => (v == null ? '—' : window.numBR(v, d) + '%');

// Compact row-counter label (mi / mil) for provenance "Linhas" readouts.
// Shared by MainScreen + ViewHealth (was duplicated verbatim in both). Deliberately a
// 2-tier SUBSET of magnitude.js (no 'bi' — row counts never reach 1e9), so it keeps its
// own ladder (DEDUP-7).
window.fmtRows = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' mi';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' mil';
  return n.toLocaleString('pt-BR');
};
