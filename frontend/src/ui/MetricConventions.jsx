// MetricConventions — display-time metric configuration strip.
// Sits BELOW the active-filter chips, ABOVE the dashboard views.
//
// Filters reduce *which rows* enter the visualization.
// Conventions decide *how those rows are displayed*: which currency,
// whether values are nominal or inflation-adjusted, and which units
// are used for mass / volume readouts.
//
// Controlled component:
//   <MetricConventions value={...} onChange={fn(next)} expanded={bool} onToggleExpanded={fn} />
// where value is:
//   { currency: 'BRL'|'USD'|'EUR',
//     correction: 'Nominal'|'IPCA'|'IGP-M'|'IGP-DI'|'CPI'|'HICP'  // offered per currency:
//                 see window.correctionsFor
//     units: { mass: 't', volume: 'm³', … }  // display unit per family }
//
// `expanded`/`onToggleExpanded` are lifted to the root (main.jsx), NOT local useState —
// unlike a typical collapsible, every onChange here re-triggers a snapshot load
// (contract map §0.2), and DataGate swaps ALL of its children (this component included)
// for a loading placeholder while that fetch is in flight. Local state would be wiped by
// that unmount on every single toggle, slamming the panel shut after each click. Lifting
// it above DataGate (same reasoning as filterOpen) survives the remount.

import { magnitudeParts } from '../charts/magnitude.js';

// ── Qual economia cada correção mede ────────────────────────────────────────────
//
// Um índice de inflação mede os preços de UMA economia, então só sabe dizer quanto uma
// coisa valia NAQUELA moeda. Daí saem duas operações diferentes, e a faixa precisa
// mostrar as duas em vez de fundi-las num eixo só de "correção":
//
//   • índice da MESMA moeda exibida → converte pelo câmbio do ANO DE REGISTRO e só então
//     deflaciona. "Dólares da época, trazidos a dólares de hoje." Num banco de aduana,
//     cujo valor de origem JÁ É US$, não entra câmbio nenhum.
//   • índice de OUTRA economia → deflaciona na moeda do índice e converte pelo câmbio de
//     HOJE. O número mede poder de compra brasileiro e só está impresso com um símbolo
//     estrangeiro — leitura legítima, e que NÃO é "o dólar corrigido pela inflação".
//
// Até a v1.82.0 só a segunda existia, rotulada como se fosse a primeira: "US$ · IPCA" se
// lê como dólares corrigidos pela inflação brasileira, que não é uma coisa que exista.
// Espelha webapi/format.py (CORRECTION_ECONOMY / ECONOMY_CURRENCY) — os dois lados têm
// de concordar, porque é o servidor que escolhe a coluna e esta tela que a nomeia.
window.CORRECTION_ECONOMY = { 'IPCA': 'BR', 'IGP-M': 'BR', 'IGP-DI': 'BR', CPI: 'US', HICP: 'EA' };
window.ECONOMY_CURRENCY = { BR: 'BRL', US: 'USD', EA: 'EUR' };
window.ECONOMY_LABEL = { BR: 'Brasil', US: 'EUA', EA: 'zona do euro' };
window.ECONOMY_DA = { BR: 'do Brasil', US: 'dos EUA', EA: 'da zona do euro' };

// A correção mede os preços da moeda que está sendo exibida?
window.deflatesOwnCurrency = (currency, correction) => {
  const eco = window.CORRECTION_ECONOMY[correction];
  return !!eco && window.ECONOMY_CURRENCY[eco] === currency;
};

// O catálogo de correções, na ordem em que a faixa as apresenta. `sub` é o publicador
// (o que o pesquisador precisa para citar), `economy` é o que decide tudo o mais.
window.CORRECTIONS = [
  { id: 'Nominal', sub: 'sem correção', economy: null },
  { id: 'IPCA',    sub: 'IBGE',         economy: 'BR' },
  { id: 'IGP-M',   sub: 'FGV',          economy: 'BR' },
  { id: 'IGP-DI',  sub: 'FGV',          economy: 'BR' },
  { id: 'CPI',     sub: 'BLS',          economy: 'US' },
  { id: 'HICP',    sub: 'BCE',          economy: 'EA' },
];

// De qual economia é cada moeda — o inverso de ECONOMY_CURRENCY.
window.CURRENCY_ECONOMY = { BRL: 'BR', USD: 'US', EUR: 'EA' };

// As correções que o painel OFERECE para uma moeda: sem correção, ou os índices da
// PRÓPRIA economia dela — R$ → IPCA · IGP-M · IGP-DI; US$ → CPI; € → HICP. É a regra
// única: a faixa mostra só estas opções, clampConvention conserta qualquer outra, e o
// decodificador de deep link passa por clampConvention.
//
// Até a v1.87 o painel oferecia também um índice brasileiro sob US$/€ (val_real_ipca_usd:
// "poder de compra brasileiro, impresso em dólares"). A leitura é legítima, mas a escolha
// confundia mais do que servia — quem pede dólares corrigidos pela inflação espera a
// inflação do dólar — e a faixa precisava de três bandas e de uma frase de negação para
// sustentá-la. Decisão do mantenedor (2026-09-23, v1.88.0): o índice acompanha a moeda.
// As colunas cruzadas continuam no Gold (Looker, "Estrutura de dados") e o BFF ainda as
// serve a quem pedir por URL; o painel só não as oferece. webapi/format.py
// (correction_offered) espelha esta regra para as sugestões de lacuna do valueGap.
window.correctionsFor = (currency) =>
  window.CORRECTIONS.filter(c => !c.economy || window.ECONOMY_CURRENCY[c.economy] === currency);

window.offeredConvention = (currency, correction) =>
  window.correctionsFor(currency).some(c => c.id === correction);

// Hoisted to module scope: it closes over nothing (everything arrives via props).
// Defined inside the render body it was a NEW component type on every render, so
// React unmounted and remounted the whole segmented control each time instead of
// updating it (react-hooks/static-components).
function Group({ label, options, active, onPick, mono }) {
  return (
    <div className="mc-group">
      <span className="mc-label">{label}</span>
      {/* A 4-option group lays out as a balanced 2×2 grid (e.g. Massa kg/t/@/sc) instead of
          wrapping 3+1 with a lopsided lone item; ≤3 options stay on one row. */}
      <div className={'seg' + (options.length === 4 ? ' seg-2x2' : '')}>
        {options.map(o => (
          <button key={o.id}
                  type="button"
                  aria-pressed={active === o.id}
                  className={'seg-opt ' + (active === o.id ? 'on' : '')}
                  onClick={() => onPick(o.id)}>
            <span className={mono ? 'tnum' : ''}>{o.id}</span>
            {o.sub && <small>{o.sub}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

// A correção é UMA linha de opções, e as opções dependem da moeda (window.correctionsFor):
// o painel só oferece o que faz sentido, em vez de mostrar tudo e desabilitar metade. O
// nome da economia vai ao lado do rótulo — "inflação do Brasil", "dos EUA" — porque é ele
// que explica por que as opções mudam quando a moeda muda.
function CorrectionGroup({ currency, active, onPick }) {
  const eco = window.CURRENCY_ECONOMY[currency];
  return (
    <div className="mc-group mc-group-corr">
      <div className="mc-label-row"
           title="Cada índice corrige apenas a moeda da economia cujos preços ele mede — por isso as opções acompanham a moeda escolhida.">
        <span className="mc-label">Correção monetária</span>
        {eco && <span className="mc-label-note">inflação {window.ECONOMY_DA[eco]}</span>}
      </div>
      <div className="seg">
        {window.correctionsFor(currency).map(o => (
          <button key={o.id}
                  type="button"
                  aria-pressed={active === o.id}
                  className={'seg-opt ' + (active === o.id ? 'on' : '')}
                  onClick={() => onPick(o.id)}>
            <span>{o.id}</span>
            {o.sub && <small>{o.sub}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

function MetricConventions({ value, onChange, families, banco, expanded, onToggleExpanded }) {
  const set = (patch) => onChange({ ...value, ...patch });

  // Currency + monetary-correction only apply to a banco that carries a monetary
  // value (window.isMonetaryBanco — derived from its metrics/baseCurrency). All
  // current bancos are monetary, so this is forward-looking: a future physical-only
  // source (e.g. a pure energy-volume series) would show the unit groups only,
  // never an inapplicable moeda/correção the user can't meaningfully change.
  const monetary = window.isMonetaryBanco ? window.isMonetaryBanco(banco) : true;

  // Physical-unit groups are REGISTRY-DRIVEN: one group per family present
  // in the data (familiesInBasket). Mass/volume keep their dedicated conv
  // fields for back-compat; any other family stores its unit in value.units.
  const physFams = ((families && families.length ? families : ['mass', 'volume']))
    .filter(f => window.UNIT_FAMILIES[f]);
  const unitFor = (fid) => (value.units && value.units[fid]) || window.defaultUnitOf(fid);
  const setUnitFor = (fid, id) => set({ units: { ...(value.units || {}), [fid]: id } });


  // Picking a currency must not leave a correction the new currency does not offer: R$ ·
  // IGP-M → US$ becomes US$ · CPI in the SAME update (a correction was on, so it stays on,
  // by the new currency's own index), and Nominal stays Nominal. Reuses
  // window.clampConvention — the strip, the deep-link decoder and the banco-switch default
  // share one rule.
  const setCurrency = (id) => onChange(window.clampConvention({ ...value, currency: id }));

  // Collapsed-state summary chips — read-only, mirror FilterTriggerBar's
  // .fm-chip-filter/.fm-chip-k pattern so the compact row reads consistently with the
  // filter chips above it. Every current convention gets a chip (unlike filter chips,
  // which are capability-gated per banco) since there's no "default/inactive" state to
  // omit here — moeda/correção/unit/escala always have a value.
  const chips = [
    monetary && { k: 'Moeda', v: (window.CURRENCY_FX[value.currency] || {}).symbol || value.currency },
    // O chip recolhido carrega a ECONOMIA junto com o índice: "IPCA · Brasil" sob um
    // símbolo de dólar já diz, sem abrir a faixa, que a correção não é americana.
    monetary && {
      k: 'Correção',
      v: window.correctionChip(value),
      t: window.conventionExplain(value, banco),
    },
    ...physFams.map((fid) => ({ k: window.UNIT_FAMILIES[fid].label, v: unitFor(fid) })),
    { k: 'Escala', v: value.autoScale ? 'Automática' : 'Fixa' },
  ].filter(Boolean);

  return (
    <div className="mc-bar">
      {!expanded ? (
        // Mesmas duas áreas de .fm-trigger-bar (chips que quebram · ação que não quebra),
        // para que "Editar métricas" e "Editar filtros" ancorem no MESMO ponto do bloco.
        // As duas faixas ficam uma sobre a outra: um botão em altura diferente da outra
        // lê como hierarquia que não existe.
        <div className="mc-head mc-head-compact">
          <div className="fm-tb-chips">
            <span className="mc-overline">Convenções métricas</span>
            {chips.map((c, i) => (
              <span key={i} className="fm-chip-filter" title={c.t}>
                <span className="fm-chip-k">{c.k}</span>{c.v}
              </span>
            ))}
          </div>
          <div className="fm-tb-acoes">
            <button type="button" className="fm-edit-btn" aria-expanded="false" onClick={onToggleExpanded}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 20h4l10-10-4-4L4 16zM14 6l4 4"/>
              </svg>
              Editar métricas
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Expandido usa as MESMAS duas áreas do recolhido: "Recolher" ocupa o lugar exato
              de onde "Editar métricas" estava, então abrir e fechar não move o botão. */}
          <div className="mc-head">
            <div className="fm-tb-chips mc-head-info">
              <span className="mc-overline">Convenções métricas</span>
              <span className="mc-caption">
                Como os valores e quantidades são exibidos — não altera quais linhas entram na visualização.
              </span>
              <label className="mc-check" title="Reescala automaticamente entre mil/mi/bi para evitar números longos">
                <input type="checkbox"
                       checked={!!value.autoScale}
                       onChange={(e) => set({ autoScale: e.target.checked })} />
                <span>Auto-escala (mil/mi/bi)</span>
              </label>
            </div>
            <div className="fm-tb-acoes">
              <button type="button" className="fm-edit-btn" aria-expanded="true" onClick={onToggleExpanded}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="18 15 12 9 6 15"/>
                </svg>
                Recolher
              </button>
            </div>
          </div>

          {/* Duas áreas: VALOR MONETÁRIO (moeda + correção + o que o número é) e UNIDADES.
              Cada uma tem a altura do próprio conteúdo — a grade única de antes deixava a
              correção alta numa coluna e empurrava Volume para uma segunda linha vazia. */}
          <div className="mc-groups">
            {monetary && (
              <section className="mc-block mc-block-money" aria-label="Valor monetário">
                <div className="mc-block-row">
                  <Group
                    label="Moeda"
                    mono
                    options={[
                      // BRL/USD/EUR are real Gold columns (BCB PTAX series).
                      { id: 'BRL', sub: 'R$'  },
                      { id: 'USD', sub: 'US$' },
                      { id: 'EUR', sub: '€'   },
                    ]}
                    active={value.currency}
                    onPick={setCurrency}
                  />
                  <CorrectionGroup
                    currency={value.currency}
                    active={value.correction}
                    onPick={(id) => set({ correction: id })}
                  />
                </div>
                {/* O que o número É, em uma frase — sob os dois grupos, porque depende dos dois. */}
                <p className="mc-corr-explain">{window.conventionExplain(value, banco)}</p>
              </section>
            )}

            <section className={'mc-block mc-block-units' + (monetary ? '' : ' mc-block-solo')}
                     aria-label="Unidades de medida">
              {physFams.map(fid => {
                const fam = window.UNIT_FAMILIES[fid];
                return (
                  <Group key={fid}
                    label={fam.label}
                    mono
                    options={(fam.units || []).map(u => ({ id: u.id, sub: u.long }))}
                    active={unitFor(fid)}
                    onPick={(id) => setUnitFor(fid, id)}
                  />
                );
              })}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// Helpers — exported on window for use by views ----------------------

// O painel abre SEM correção: valores nominais, na moeda de cada ano. É o estado que não
// presume nenhuma escolha metodológica — a correção é uma decisão do pesquisador, e a
// frase sob a faixa diz, desde o primeiro carregamento, para que o nominal serve e para
// que não serve. Vale também quando o estado anterior não pode ser reconhecido (link sem
// `corr`, ou com um valor que não existe). Era IPCA até a v1.87.
window.DEFAULT_CONVENTIONS = {
  currency:   'BRL',
  correction: 'Nominal',
  units:      { mass: 't', volume: 'm³' },
  autoScale:  false,
};

// A fonte única das combinações oferecidas é window.correctionsFor (no topo). A faixa só
// mostra essas, e o decodificador de deep link (main.jsx) e a troca de banco passam por
// aqui — um ?cur=USD&corr=IPCA guardado nos favoritos não pode passar por baixo da tela.
// Devolve SEMPRE uma convenção oferecida, e a MESMA REFERÊNCIA quando nada muda (main.jsx
// conta com isso para não re-renderizar as convenções à toa).
//
// A moeda é do usuário; é a correção que cede. Qual correção entra depende do que dá para
// reconhecer do pedido:
//   • um ÍNDICE conhecido que a moeda não oferece (US$ · IPCA, R$ · CPI, € · IGP-M) → o
//     primeiro índice da própria moeda. A intenção era "corrigir pela inflação", e ela se
//     mantém — pela inflação da economia cuja moeda está na tela.
//   • algo que não é índice nenhum → Nominal, o padrão: sem saber o que a pessoa queria,
//     o painel não presume uma correção.
window.clampConvention = (conv) => {
  if (!conv) return conv;
  const { currency, correction } = conv;
  if (window.offeredConvention(currency, correction)) return conv;
  const pedidoDeCorrecao = !!window.CORRECTION_ECONOMY[correction];
  const propria = window.correctionsFor(currency).find(c => c.economy);
  return { ...conv, correction: pedidoDeCorrecao && propria ? propria.id : 'Nominal' };
};

// O que o número É, em uma frase — a linha que a faixa inteira existe para poder dizer.
// `banco` é opcional: num banco cuja moeda de origem já é a exibida (aduana em US$), a
// correção pela própria moeda não passa por câmbio NENHUM, e vale dizer isso.
window.conventionExplain = (conv, banco) => {
  if (!conv) return '';
  const { currency, correction } = conv;
  const sym = (window.CURRENCY_FX[currency] || {}).symbol || currency;
  const moeda = { BRL: 'reais', USD: 'dólares', EUR: 'euros' }[currency] || sym;
  if (correction === 'Nominal') {
    return `Valores em ${moeda} de cada ano, sem correção: servem para auditar um ano ou `
      + `comparar séries dentro do mesmo ano — não para comparar anos distantes.`;
  }
  const eco = window.CORRECTION_ECONOMY[correction];
  if (!eco) return '';
  if (eco === 'BR' && currency === 'BRL') {
    return `Deflacionado pelo ${correction}: reais de hoje.`;
  }
  if (eco === 'BR') {
    // A negativa explícita é o ponto: sem ela, o leitor completa a frase sozinho — e
    // completa errado. Nomeia a inflação que este número NÃO é, pela moeda na tela.
    const outra = window.ECONOMY_DA[{ USD: 'US', EUR: 'EA' }[currency]] || 'de fora';
    return `Deflacionado pelo ${correction} — a inflação do BRASIL — e convertido ao câmbio `
      + `de hoje. Mede poder de compra brasileiro, apresentado em ${moeda}: não é a inflação `
      + `${outra}.`;
  }
  const base = window.canonCurrencyFor ? window.canonCurrencyFor(banco) : 'BRL';
  const semCambio = base === currency;
  return semCambio
    ? `Deflacionado pelo ${correction} (inflação ${window.ECONOMY_DA[eco]}): ${moeda} de hoje. `
      + `O valor já é declarado em ${sym} na fonte, então não passa por câmbio nenhum.`
    : `Convertido ao câmbio do ano de registro e deflacionado pelo ${correction} (inflação `
      + `${window.ECONOMY_DA[eco]}): ${moeda} de hoje, pelo poder de compra ${window.ECONOMY_DA[eco]}.`;
};

// O valor do chip recolhido: o índice mais a economia que ele mede, porque é a economia
// que o símbolo da moeda ao lado não revela.
window.correctionChip = (conv) => {
  if (!conv || conv.correction === 'Nominal') return 'Sem correção';
  const eco = window.CORRECTION_ECONOMY[conv.correction];
  return eco ? `${conv.correction} · ${window.ECONOMY_LABEL[eco]}` : conv.correction;
};
// Display unit chosen for a family (falls back to the registry default).
window.unitOf = (conv, fam) => (conv && conv.units && conv.units[fam]) || window.defaultUnitOf(fam);

// Auto-scale helper — picks a (factor, suffix) so the number sits in a readable
// magnitude. Used only when conv.autoScale === true. The bi/mi/mil ladder is the SHARED
// kernel (magnitude.js), identical to the chart axis's ptBrMagnitude so the two can't
// drift (DEDUP-7).
window.autoScaleNum = magnitudeParts;

function _fmtRescaled(v, conv, unitSuffix) {
  if (conv.autoScale) {
    const { factor, suffix } = window.autoScaleNum(v);
    const scaled = v / factor;
    const txt = scaled.toLocaleString('pt-BR', {
      maximumFractionDigits: scaled < 10 ? 2 : scaled < 100 ? 1 : 0,
    });
    return suffix
      ? `${txt} ${suffix} ${unitSuffix}`.trim()
      : `${txt} ${unitSuffix}`.trim();
  }
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' ' + unitSuffix;
}

// Currency display SYMBOLS (R$ / US$ / €). This is a label table ONLY — there is
// deliberately NO numeric FX rate here. Every live banco (PEVS/PAM production AND
// COMEX/Comtrade trade) now serves its snapshot value IN the requested currency
// SERVER-side, at the REAL year-FX / deflated Gold columns (val_*_brl / val_*_usd /
// val_*_eur, real BCB PTAX). So no client-side conversion of real data exists — the
// old frozen mock rates (USD 0.205 / EUR 0.187) used to cross-convert a USD-native
// trade banco were a wrong-number path on explicit BRL/EUR selection and are gone.
window.CURRENCY_FX = {
  BRL: { symbol: 'R$', long: 'Real'  },
  USD: { symbol: 'US$', long: 'Dólar' },
  EUR: { symbol: '€',   long: 'Euro'  },
};

// Multiplicative display factor for a server-backed *value*. ALWAYS 1: currency ×
// correction now select the REAL deflated value column SERVER-side
// (val_real_{ipca,igpm,igpdi}_{brl,usd,eur}, val_yearfx_{brl,usd,eur} for Nominal —
// the scientific core, real BCB PTAX), so the snapshot value already ARRIVES in the
// requested currency for EVERY live banco (production AND trade). There is no client
// multiplier left; this helper exists so the manual value-scaling sites (views
// building chart series by hand) read a single factor that agrees with applyConv /
// formatValue. (Edge, BFF-only since v1.88.0 — the strip no longer offers it: USD +
// IGP-M/IGP-DI has no _usd column → the BFF falls back to the real BRL column and the
// value_label flags "moeda indisponível → R$"; the figure is still real, never a mock
// conversion.)
window.convFactor = (_conv) => 1;

// Base-aware value multiplier — kept for the views that call it (ViewGeography /
// ViewOverview UF map) so their call sites need no change. It is now ALWAYS 1: a
// trade banco's snapshot (ufData/overview) no longer arrives in a fixed US$ that the
// client must cross-convert — the BFF serves it IN the requested display currency
// (the real BRL/USD/EUR Gold column). Cross-converting again via a frozen mock rate
// was the wrong-number bug on explicit BRL/EUR selection; that path is removed. The
// `base` arg is ignored on purpose — server-native values need no base→display rate.
window.convFactorFor = (_base, conv) => window.convFactor(conv);

// Convert a BRL-canonical value through the active currency + correction.
window.applyConv = (val, conv) => {
  if (val == null) return null;
  return val * window.convFactor(conv);
};

// Format a BRL-canonical value through the active convention.
// Auto-scale (mil/mi/bi) only when conv.autoScale === true.
window.formatValue = (brl, conv) => {
  if (brl == null) return '—';
  const sym = window.CURRENCY_FX[conv.currency].symbol;
  const v = window.applyConv(brl, conv);
  if (conv.autoScale) {
    const { factor, suffix } = window.autoScaleNum(v);
    const scaled = v / factor;
    const txt = scaled.toLocaleString('pt-BR', {
      maximumFractionDigits: scaled < 10 ? 2 : scaled < 100 ? 1 : 0,
    });
    return suffix ? `${sym} ${txt} ${suffix}` : `${sym} ${txt}`;
  }
  return sym + ' ' + v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
};

// Axis label — when auto-scale is ON, append the picked suffix for the
// passed reference magnitude; otherwise just the currency symbol.
window.valueAxisLabel = (conv, refMagnitude) => {
  const sym = window.CURRENCY_FX[conv.currency].symbol;
  if (conv.autoScale && refMagnitude != null) {
    const { suffix } = window.autoScaleNum(refMagnitude);
    return suffix ? `${sym} ${suffix}` : sym;
  }
  return sym;
};

// Convert a series {y, v: value in banco base currency} to displayed currency.
window.convertSeries = (series, conv, key = 'v') => {
  const factor = window.convFactor(conv);
  // scalePresent, não `*`: em JS `null * factor === 0`, e estas duas funções são o
  // último lugar por onde TODA série de valor passa antes do gráfico. Multiplicar
  // direto aqui re-fabricava, no caminho para o Plotly, exatamente o zero que o
  // serializer tinha acabado de eliminar — o KPI dizia '—' e a linha continuava
  // colada no eixo, afirmando produção zero em anos que a convenção não cobre.
  return series.map(d => ({ ...d, [key]: window.scalePresent(d[key], factor) }));
};

// Mass / volume: native data is in t (mass) and m³ (volume) at internal scale.
// OVERVIEW_TS.q_mass holds *thousands of tonnes*; PRODUCT_TS.q (mass) same.
// OVERVIEW_TS.q_vol holds *millions of m³*; PRODUCT_TS.q (volume) same.
//
// Display rule (per user request): never auto-rescale to abbreviated units.
// The user picks t or kg → we render in t or kg. Same for m³ vs L.

window.formatMassQty = (milT, conv) => {
  if (milT == null) return '—';
  const v = milT * window.massQtyMul(conv);
  return _fmtRescaled(v, conv, window.unitOf(conv, 'mass'));
};
window.formatVolumeQty = (miM3, conv) => {
  if (miM3 == null) return '—';
  const v = miM3 * window.volumeQtyMul(conv);
  return _fmtRescaled(v, conv, window.unitOf(conv, 'volume'));
};
// Contagem (head / eggs — PPM livestock): internal q_count holds *millions of units*
// (mi un), the same ÷1e6 scaling the serializer applies. Mirrors mass/volume so the
// herd reads in the user-picked count unit (un / dz / milheiro / cabeça).
window.formatCountQty = (miUn, conv) => {
  if (miUn == null) return '—';
  const v = miUn * window.countQtyMul(conv);
  return _fmtRescaled(v, conv, window.unitOf(conv, 'count'));
};

// Multipliers: internal dataset units (mil t / mi m³) → selected display
// unit, via the registry factors so any member unit (kg/t/@/sc, L/m³/hL…)
// converts correctly. internal mass = mil t (×1000 t); internal vol = mi m³.
window.massQtyMul    = (conv) => 1000 / window.unitToBase('mass', window.unitOf(conv, 'mass'));
window.volumeQtyMul  = (conv) => 1e6  / window.unitToBase('volume', window.unitOf(conv, 'volume'));
// internal count = mi un (×1e6 un); convert to the picked count unit via the registry.
window.countQtyMul   = (conv) => 1e6  / window.unitToBase('count', window.unitOf(conv, 'count'));
window.massAxisLabel   = (conv) => window.unitOf(conv, 'mass');
window.volumeAxisLabel = (conv) => window.unitOf(conv, 'volume');
window.countAxisLabel  = (conv) => window.unitOf(conv, 'count');

// Human label for the active monetary convention (e.g. "USD · IPCA (Brasil)").
// A economia entra entre parênteses quando o índice NÃO é o da moeda exibida — é aí que
// o rótulo curto engana: "USD · IPCA" se lê como dólar corrigido por inflação americana.
window.conventionMonetaryLabel = (conv) => {
  if (conv.correction === 'Nominal') return conv.currency + ' · nominal';
  const eco = window.CORRECTION_ECONOMY[conv.correction];
  const propria = window.deflatesOwnCurrency(conv.currency, conv.correction);
  const onde = eco && !propria ? ` (${window.ECONOMY_LABEL[eco]})` : '';
  return `${conv.currency} · ${conv.correction}${onde}`;
};

// scaleLabel — axis/series label grammar for a magnitude-scaled unit: a currency symbol
// sits BEFORE the magnitude suffix ("R$ bi"), a physical unit AFTER ("bi t"). Single
// source for the symbol list + ordering so the three scalers (scaleSeries, ValueVolume
// _scaleStack, Geography heatScaled) can't drift when a symbol changes — the CNY removal
// showed the list does churn (DEDUP-9). Pure string / label-only — never touches a value.
window.SCALE_CURRENCY_SYMS = ['R$', 'US$', '€'];
window.scaleLabel = (unit, suffix) =>
  window.SCALE_CURRENCY_SYMS.includes(unit) ? `${unit} ${suffix}` : `${suffix} ${unit}`.trim();

// scaleSeries — rescales a series + returns the matching axis label.
// When conv.autoScale is OFF, returns the data as-is and unitSuffix only.
// When ON, divides every value by autoScale(refMagnitude).factor and
// builds the label respecting unit grammar (see scaleLabel).
window.scaleSeries = (series, refMag, conv, valueKey, unitSuffix) => {
  if (!conv.autoScale) {
    return { data: series, label: unitSuffix };
  }
  const { factor, suffix } = window.autoScaleNum(refMag);
  if (!suffix) return { data: series, label: unitSuffix };
  const data = series.map(d => ({ ...d, [valueKey]: window.scalePresent(d[valueKey], 1 / factor) }));
  return { data, label: window.scaleLabel(unitSuffix, suffix) };
};

window.MetricConventions = MetricConventions;
