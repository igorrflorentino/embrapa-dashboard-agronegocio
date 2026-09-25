// maplibreLoader.js — the ONE place maplibre-gl is loaded, shared by every map.
//
// BrazilChoropleth and MunicipioChoropleth used to each run the same three dynamic
// imports plus setWorkerUrl on EVERY mount. The browser caches modules, so the cost was
// mostly the repeated setWorkerUrl and two copies of a fragile sequence to keep in sync.
// Now the sequence runs once per session and every map awaits the same promise.
//
// maplibre-gl (~250 KB gz) stays LAZY: nothing here runs until a map mounts, and Vite
// code-splits the library into its own chunk.

let pending = null;

/** Resolve to the maplibre-gl namespace, with its CSS applied and its worker wired.
 *  A failed load is not cached, so a later mount can retry (a flaky network should not
 *  disable the maps for the rest of the session). */
export function loadMaplibre() {
  if (pending) return pending;
  pending = (async () => {
    // NAMESPACE import, never `.default`. maplibre 5+ ships pure ESM with ~85 NAMED
    // exports and NO default, so `(await import(…)).default` is undefined and
    // `maplibregl.Map` throws "Cannot read properties of undefined (reading 'Map')".
    // What makes that trap nasty is that it fails ONLY in the build: with nothing but a
    // non-existent export referenced, Rollup tree-shakes the whole library away (the
    // chunk collapsed 786 kB → 514 bytes) while the dev server, which serves modules
    // directly, kept rendering fine. That is exactly how the first 4→6 attempt passed
    // tests, lint and `vite build` and still broke production (see v1.24.22).
    const maplibregl = await import('maplibre-gl');
    await import('maplibre-gl/dist/maplibre-gl.css');
    // maplibre 5+ runs geojson-vt in a MODULE WORKER shipped as a separate file, and
    // resolves it at runtime as a sibling of its own `import.meta.url`. That URL is
    // invisible to the bundler, so Vite never emitted the file: the request fell through
    // to the SPA's index.html fallback and died on strict MIME checking. The worker then
    // never started, so no source ever finished loading — `isStyleLoaded()` and
    // `loaded()` stayed false forever and NO 'idle' event ever fired.
    // `?worker&url` makes Vite BUNDLE the worker and hand back its URL. It has to be
    // `?worker&url`, not a plain `?url`: the published worker is an ES module that
    // imports a sibling, `./maplibre-gl-shared.mjs`. A plain `?url` copies that one file
    // verbatim, so the relative import resolves to an asset Vite never emitted and the
    // module worker dies on load. `?worker&url` follows the import graph and emits one
    // self-contained worker instead.
    // `setWorkerUrl` is maplibre's supported override (it takes priority over the
    // import.meta.url guess) and must run BEFORE the first `new Map()`, which is what
    // spins up the worker pool. Awaiting this promise before constructing guarantees it.
    maplibregl.setWorkerUrl(
      (await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')).default,
    );
    return maplibregl;
  })().catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

// Container size: NOT handled here, on purpose. maplibre 6 observes its own container
// (`trackResize`, default true, via a ResizeObserver) and resizes the canvas when the card
// changes width. v1.93.1 added a second observer on the claim that maplibre only listened
// to the window; that was never true of the installed version, so every container change
// resized the map twice. Removed in v1.93.5 after a browser check with only maplibre's
// observer in place. Keep `trackResize` at its default when constructing a Map (the map
// tests assert it).
