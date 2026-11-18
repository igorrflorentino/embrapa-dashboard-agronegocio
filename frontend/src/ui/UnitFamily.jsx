// UnitFamily — surfaces the active unit families (mass/volume) for the current
// basket so the researcher never accidentally compares incompatible quantities.

function UnitFamilyBanner({ families }) {
  const F = window.UNIT_FAMILIES;
  // Nothing selected → no quantity families → no banner (zero means none).
  if (!families || families.length === 0) return null;
  const mixed = families.length > 1;

  // A count is a family of units, not a unit: heads, eggs and fruits all reduce to "un"
  // and still do not add up. The banner must not promise they do (countUnits.js).
  const countRule = 'Na contagem, só se somam produtos que contam a mesma coisa: '
    + 'cabeças, ovos e frutos aparecem separados.';

  if (!mixed) {
    const f = F[families[0]];
    return (
      <div className="ufam-banner single">
        <span className="ufam-dot" style={{ background: 'var(--embrapa-green)' }}></span>
        <span className="ufam-label">Família de unidades</span>
        {/* The family label alone — NO specific unit, which would go stale when the user
            switches the unit in the conventions strip (the unit is shown there + on the axes). */}
        <strong>{f.label}</strong>
        <span className="ufam-note">
          {families[0] === 'count'
            ? `Todos os produtos da cesta são contagens. ${countRule}`
            : 'Todos os produtos da cesta compartilham a mesma família de unidade; as quantidades são somáveis.'}
        </span>
      </div>
    );
  }

  return (
    <div className="ufam-banner mixed">
      <span className="ufam-dot warn"></span>
      <span className="ufam-label">Cesta mista</span>
      {/* Just the families (no unit in parentheses) — informing they differ is the whole point;
          the parenthetical unit was static and didn't follow the unit selector. */}
      <strong>
        {families.map(id => F[id].label).join(' + ')}
      </strong>
      <span className="ufam-note">
        Quantidades de famílias diferentes <u>não</u> são agregadas: cada métrica
        de quantidade aparece separada por família e unidade. Valor monetário
        permanece agregável e somável.{families.includes('count') ? ` ${countRule}` : ''}
      </span>
    </div>
  );
}

// Tag for inline use inside chart titles / KPI labels.
// When `conv` is provided, the displayed unit reflects the active
// metric-conventions selection (kg/t for mass · L/m³ for volume).
// `unit` overrides it where the family's unit cannot say WHAT is measured: a count reads
// "ovos" or "frutos" (window.countGroupUnit), never the bare "un" of the whole family.
function UnitFamilyTag({ family, conv, unit: unitOverride }) {
  const f = window.UNIT_FAMILIES[family];
  const unit = unitOverride
    || (!conv ? f.unit : ((conv.units && conv.units[family]) || f.unit));
  return <span className="ufam-tag" style={{ color: f.color || 'var(--fg-2)' }}>{f.label} · {unit}</span>;
}

Object.assign(window, { UnitFamilyBanner, UnitFamilyTag });
