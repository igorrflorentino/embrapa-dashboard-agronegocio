// recorteProducts.js — the basket's products INSIDE the active sub-UF recorte, in one year.
//
// applyFilters' per-product series (productTS, topProducts) are NATIONAL: the snapshot has
// no product × território grain. Under a sub-UF recorte they answered for the whole country
// beneath the recorte's chip — with Portel and Breves (PA) selected on PPM, the Visão geral's
// "Participação por produto" read Leite 70% / Ovos de galinha 28%, the national shares, while
// the recorte loaded, after it failed and once it had loaded (until v1.108.2).
//
// The município reader (window.productsByMunicipio → POST /api/products-by-municipio) sums
// each product over a city set and a year window; read for ONE year it is exactly the
// cross-section a composition or a concentration needs, on the same value basis.
//
// Returns null when no sub-UF recorte is asked for (the caller keeps its national path),
// else { year, products, loading, loadError, unavailable }:
//   loading     — the recorte (its mesh or its município cube) or this read is on its way;
//   loadError   — one of them failed for good;
//   unavailable — the API answered that this banco has no per-product reader by município;
//   none        — `products` IS the answer, and [] means "measured, nothing": the recorte's
//                 municípios record none of the basket in the window.
// `products` is null until known. `year` is the latest year in the window in which the
// recorte's município cube has a row (null when it has none): never a year with no data.
(function () {
  const ESPERA = { year: null, products: null, loading: true, loadError: null, unavailable: false };

  window.recorteProducts = function recorteProducts(filtered, summary, database, conv) {
    if (!filtered || !filtered.subUfRequested) return null;
    if (filtered.subUfLoadError) {
      return { ...ESPERA, loading: false, loadError: filtered.subUfLoadError };
    }
    if (filtered.subUfLoading || !filtered.subUfLoaded) return ESPERA;

    // The cube's rows in scope: inside the window and, like every cube row on screen, inside
    // the UF filter. The latest such year is the cross-section; the cities with a row in it
    // are the ones that produced any of the basket then — a city with no row adds nothing.
    const states = summary && summary.states != null ? new Set(summary.states) : null;
    const inScope = (r) => typeof r.year === 'number'
      && r.year >= filtered.yearStart && r.year <= filtered.yearEnd
      && (!states || states.has(r.uf));
    const rows = (filtered.muniYearlySeries || []).filter(inScope);
    let year = null;
    for (const r of rows) if (year == null || r.year > year) year = r.year;
    if (year == null) return { ...ESPERA, loading: false, products: [] };
    const cities = [...new Set(rows.filter((r) => r.year === year).map((r) => String(r.cityCode)))];

    const read = window.productsByMunicipio(
      database,
      { ...(summary || {}), startDate: `${year}-01-01`, endDate: `${year}-12-01` },
      conv,
      cities,
    );
    if (read.loadError) return { ...ESPERA, year, loading: false, loadError: read.loadError };
    if (read.loading) return { ...ESPERA, year };
    if (read.unavailable) return { ...ESPERA, year, loading: false, unavailable: true };
    return { year, products: read.products, loading: false, loadError: null, unavailable: false };
  };
})();
