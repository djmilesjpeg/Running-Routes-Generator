/**
 * Service worker.
 *
 * Caches the app shell so "Add to Home Screen" gives something that opens
 * instantly and still works without a signal. Saved routes come from
 * localStorage, not from here.
 *
 * WHAT IS DELIBERATELY NEVER CACHED
 *
 *   Routing API responses. They contain the runner's start point and are
 *   fetched with the API key in a header. Neither belongs in a cache that
 *   outlives the session, so these requests bypass the worker entirely.
 *
 *   Map tiles. A tile URL encodes the area being looked at, so a tile cache is
 *   a record of where someone has been. The app shell is what needs to work
 *   offline; a blank backdrop with the correct route drawn on it is a fair
 *   trade, and the UI says so when tiles fail.
 *
 * Bump CACHE_VERSION to ship an update. The old cache is deleted on activate.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = 'loopgen-shell-' + CACHE_VERSION;

/** Everything needed to boot with no network. Paths are relative to scope. */
const APP_SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/core/geo.js',
  'js/core/route.js',
  'js/core/correction.js',
  'js/core/scoring.js',
  'js/core/gpx.js',
  'js/core/log.js',
  'js/providers/RouteProvider.js',
  'js/providers/OrsProvider.js',
  'js/app/generate.js',
  'js/app/cache.js',
  'js/ui/map.js',
  'js/ui/keystore.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
];

/** Hosts whose responses must never be stored. */
const NEVER_CACHE_HOSTS = [
  'api.openrouteservice.org',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Added individually so one missing entry cannot fail the whole install
      // and leave the app with no offline support at all.
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            /* skipped; fetched from the network when needed */
          }),
        ),
      );

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('loopgen-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Location data and credentialled requests: hand straight to the network
  // and never look at, or write to, the cache.
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  // Navigations: prefer the network so an update is picked up promptly, and
  // fall back to the cached shell when there is no signal.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (
            (await cache.match('index.html')) ||
            (await cache.match('./')) ||
            new Response('Offline, and no cached copy of the app is available.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            })
          );
        }
      })(),
    );
    return;
  }

  // Everything else: cache first, since the shell is versioned by CACHE_NAME.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);

        // Only store same-origin successes and CORS-readable CDN responses.
        // An opaque response has an unknown status and could poison the cache
        // with an error page.
        if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
          cache.put(request, response.clone());
        }
        return response;
      } catch (cause) {
        const fallback = await cache.match(request, { ignoreSearch: true });
        if (fallback) return fallback;
        throw cause;
      }
    })(),
  );
});
