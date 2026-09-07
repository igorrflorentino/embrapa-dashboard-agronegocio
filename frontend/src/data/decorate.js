// decorate.js — join the client-side registries the /api/snapshot deliberately
// omits onto the API rows (see PLANS/react_migration_contract_map.md §0.3).
//
// The API returns the keys to join on (uf, quality-flag id); the presentation
// metadata — UF tile coordinates (col/row) and quality-flag label/color — lives
// in the UI registries (window.UF_DATA, window.QUALITY_FLAGS), which the
// views also use directly. Joining them server-side would duplicate the
// registries and invite drift, so we decorate here, in the data layer.

/** uf → { col, row, region, name } from the UF tile-grid registry. */
function ufTiles() {
  const idx = {};
  (window.UF_DATA || []).forEach((u) => {
    idx[u.uf] = u;
  });
  return idx;
}

/** Canonical 2-letter region codes (window.REGIONS ids), and a display-name →
 *  code map. Downstream region matching (ui/dataFilters.js regionData groups
 *  ufData by `region === r.id`) keys off the CODE, so a row whose region arrived
 *  as a display name ("Norte") would never match and RegionBars would empty.
 *  Derived from the live REGIONS registry so it tracks any future region edit. */
function regionCodeIndex() {
  const codes = new Set();
  const byName = {};
  (window.REGIONS || []).forEach((r) => {
    if (r.id) codes.add(r.id);
    if (r.label) byName[r.label] = r.id;
  });
  return { codes, byName };
}

/** Normalize an API-supplied region to the canonical 2-letter code: keep it if
 *  it is already a valid code; map a known display name ("Norte" → "N");
 *  otherwise fall back to the registry/UF_DATA region (`tileRegion`). Exported +
 *  exposed on window so the UI's parallel cube-row decoration
 *  (dataFilters._decorateUf) reuses the SAME normalization — both feed the one
 *  region-code groupBy, so they must agree. */
export function normalizeRegion(apiRegion, tileRegion) {
  const { codes, byName } = regionCodeIndex();
  if (apiRegion && codes.has(apiRegion)) return apiRegion;
  if (apiRegion && byName[apiRegion]) return byName[apiRegion];
  return tileRegion ?? apiRegion;
}
// Expose for the UI views/filters, which call window.* at render time.
if (typeof window !== 'undefined') window.normalizeRegion = normalizeRegion;

/** True iff `uf` is one of the 27 canonical Brazilian states (present in the
 *  UF tile registry). COMEX trade origins carry non-state pseudo-codes
 *  (ND/EX/ZN/CB/RE/MC…) that are NOT in the registry — used to keep the
 *  "UFs cobertas" tally to real states only (FINDING #4 fallback when the
 *  backend's per-row `real` flag is absent). */
export function isCanonicalUf(uf) {
  if (!uf) return false;
  return (window.UF_DATA || []).some((u) => u.uf === uf);
}
// Expose for the reused views, which call window.* helpers at render time.
if (typeof window !== 'undefined') window.isCanonicalUf = isCanonicalUf;

/** Join UF tile coords (col/row/region/name) onto any uf-keyed rows. The
 *  BrazilTileMap positions each tile by col/row, which /api omits (the views own
 *  the UF_DATA registry) — so any per-UF series headed to the tile map must be
 *  decorated here, the same join ufData gets in decorateSnapshot. */
export function decorateUfRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  const tiles = ufTiles();
  return rows.map((r) => {
    const t = tiles[r.uf] || {};
    return {
      ...r,
      col: r.col ?? t.col,
      row: r.row ?? t.row,
      // Always store the canonical region CODE — downstream region matching keys
      // off it (ui/dataFilters.js). Prefer the registry/UF_DATA code; map a
      // display name to its code; keep the API value only if it is already a code.
      region: normalizeRegion(r.region, t.region),
      name: r.name || t.name,
    };
  });
}

/** quality-flag id → { label, color } from the shared taxonomy. */
function qualityTaxonomy() {
  const idx = {};
  (window.QUALITY_FLAGS || []).forEach((f) => {
    idx[f.id] = f;
  });
  return idx;
}

export function decorateSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;

  if (Array.isArray(snap.ufData) && snap.ufData.length) {
    snap.ufData = decorateUfRows(snap.ufData);
  }

  if (Array.isArray(snap.quality) && snap.quality.length) {
    const tax = qualityTaxonomy();
    snap.quality = snap.quality.map((q) => {
      const f = tax[q.id] || {};
      // Prefer the client registry label, then the SERVER-supplied pt-BR label
      // (serializers._FLAG_LABEL_PT emits it precisely so a flag the registry
      // hasn't caught up to — e.g. a newly added Gold flag — still renders in
      // pt-BR instead of leaking the raw English id), then the id as last resort.
      return { ...q, label: f.label || q.label || q.id, color: f.color || 'var(--pres-gray-400)' };
    });
  }

  // applyFilters reads snap.regions (falls back to window.REGIONS anyway, but be
  // explicit). qualityTs + qualityByProduct ARRIVE in the snapshot; topMunis stays
  // optional and defaults to [] in applyFilters.
  snap.regions = snap.regions || window.REGIONS || [];
  return snap;
}
