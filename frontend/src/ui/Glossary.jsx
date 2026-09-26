// Glossary — two surfaces:
//   <Glossary scope="b1" />         per-banco glossary (topnav view)
//   <Glossary scope="global" />     searchable across all bancos (sidebar info)

const { useState: useGlossState, useMemo: useGlossMemo } = React;

function Glossary({ scope = 'global' }) {
  const [q, setQ] = useGlossState('');
  const [activeCat, setActiveCat] = useGlossState('Todas');

  const sources = scope === 'global'
    ? Object.entries(window.GLOSSARY)
    : [[scope, window.GLOSSARY[scope]]];

  // Flatten with banco metadata
  const all = useGlossMemo(() => {
    const out = [];
    sources.forEach(([bid, b]) => {
      b.terms.forEach(t => out.push({ ...t, bancoId: bid, bancoLabel: b.label }));
    });
    return out;
  }, [scope]);

  // Categories present in current scope
  const cats = useGlossMemo(() => {
    const set = new Set(all.map(t => t.cat).filter(Boolean));
    return ['Todas', ...[...set].sort()];
  }, [all]);

  // Apply filters
  const matches = useGlossMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter(t => {
      if (activeCat !== 'Todas' && t.cat !== activeCat) return false;
      if (!needle) return true;
      return (
        t.term.toLowerCase().includes(needle) ||
        window.textoSimples(t.short).toLowerCase().includes(needle) ||
        (t.tag && t.tag.toLowerCase().includes(needle))
      );
    });
  }, [all, q, activeCat]);

  // Group results by banco (global) or by category (per-banco)
  const groups = useGlossMemo(() => {
    if (scope === 'global') {
      const map = new Map();
      matches.forEach(t => {
        if (!map.has(t.bancoId)) map.set(t.bancoId, { id: t.bancoId, label: t.bancoLabel, sub: window.GLOSSARY[t.bancoId].sub, items: [] });
        map.get(t.bancoId).items.push(t);
      });
      return [...map.values()];
    }
    // per-banco: group by category
    const map = new Map();
    matches.forEach(t => {
      const c = t.cat || 'Outros';
      if (!map.has(c)) map.set(c, { id: c, label: c, items: [] });
      map.get(c).items.push(t);
    });
    return [...map.values()];
  }, [matches, scope]);

  const totalLabel = scope === 'global'
    ? `${matches.length} ${matches.length === 1 ? 'termo' : 'termos'} · ${groups.length} ${groups.length === 1 ? 'grupo' : 'grupos'}`
    : `${matches.length} de ${all.length} termos`;

  return (
    <div className="gloss">
      <div className="gloss-controls">
        <div className="gloss-search">
          <window.Icon name="search" size={14} />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={scope === 'global'
              ? 'Buscar termo, coluna ou definição em todos os bancos…'
              : 'Buscar termo, coluna ou definição neste banco…'}
          />
          {q && (
            <button className="gloss-clear" onClick={() => setQ('')} aria-label="Limpar busca">×</button>
          )}
        </div>

        <div className="gloss-cats">
          {cats.map(c => (
            <button key={c}
                    className={'gloss-cat' + (activeCat === c ? ' on' : '')}
                    onClick={() => setActiveCat(c)}>
              {c}
            </button>
          ))}
        </div>

        <span className="gloss-count">{totalLabel}</span>
      </div>

      {matches.length === 0 && (
        <div className="card subtle gloss-empty">
          <strong>Nenhum termo corresponde a “{q}”.</strong>
          <p className="caption">Tente outra palavra, ou troque a categoria para "Todas".</p>
        </div>
      )}

      {groups.map(g => (
        <section key={g.id} className="gloss-group">
          <header className="gloss-group-head">
            <div>
              <div className="overline">{scope === 'global' ? (window.GLOSSARY[g.id]?.kind === 'tema' ? 'Tema' : 'Banco') : 'Categoria'}</div>
              <h2 className="gloss-group-title">{g.label}</h2>
              {g.sub && <div className="caption">{g.sub}</div>}
            </div>
            <span className="caption">{g.items.length} {g.items.length === 1 ? 'termo' : 'termos'}</span>
          </header>

          <div className="gloss-list">
            {g.items.map((t, i) => (
              <article key={t.bancoId + ':' + t.term + ':' + i} className="gloss-row">
                <div className="gloss-row-head">
                  <span className="gloss-term">{t.term}</span>
                  {t.tag && <span className="gloss-tag">{t.tag}</span>}
                  {scope === 'global' && (
                    <span className="gloss-banco">{t.bancoLabel}</span>
                  )}
                  {scope !== 'global' && t.cat && (
                    <span className="gloss-banco subtle">{t.cat}</span>
                  )}
                </div>
                <p className="gloss-short">{window.comItalico(t.short)}</p>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

window.Glossary = Glossary;
