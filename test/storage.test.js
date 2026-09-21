import test from 'node:test';
import assert from 'node:assert/strict';

import { redact } from '../docs/js/core/log.js';
import { routeFromOrsGeoJson } from '../docs/js/core/route.js';
import { makeOrsResponse, PLACES } from './fixtures/synthetic.js';

/**
 * A localStorage stand-in. `failOn` reproduces the browsers that throw rather
 * than return null - Safari private browsing and blocked site data - which is
 * the case most likely to be missed.
 */
function fakeStorage({ failOn = null, quotaBytes = Infinity } = {}) {
  const map = new Map();
  return {
    get size() {
      return map.size;
    },
    getItem(key) {
      if (failOn === 'get' || failOn === 'all') throw new DOMException('denied');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (failOn === 'set' || failOn === 'all') throw new DOMException('denied');
      const total = [...map.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
      if (total + key.length + value.length > quotaBytes) {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      }
      map.set(key, String(value));
    },
    removeItem(key) {
      if (failOn === 'remove' || failOn === 'all') throw new DOMException('denied');
      map.delete(key);
    },
  };
}

/**
 * keystore and cache read globalThis.localStorage at call time, so swapping it
 * per test is enough. Modules are re-imported with a cache-busting query so
 * each block starts clean.
 */
async function withStorage(store, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
}

const keystore = () => import('../docs/js/ui/keystore.js');
const cache = () => import('../docs/js/app/cache.js');

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test('redact: strips coordinate-shaped numbers from strings', () => {
  assert.equal(redact('start at 174.7731234, -41.2902456'), 'start at [coord], [coord]');
  assert.equal(redact('requested 21097m'), 'requested 21097m');
  assert.equal(redact('ratio 1.80'), 'ratio 1.80');
});

test('redact: removes location fields from objects by name', () => {
  const redacted = redact({ lat: -41.2902, lon: 174.7731, distanceM: 21097, runType: 'long' });

  assert.equal(redacted.lat, '[redacted]');
  assert.equal(redacted.lon, '[redacted]');
  assert.equal(redacted.distanceM, 21097, 'non-location data should survive');
  assert.equal(redacted.runType, 'long');
});

test('redact: reaches nested structures and coordinate arrays', () => {
  const redacted = redact({ request: { center: [174.7731, -41.2902], seed: 42 } });

  assert.equal(redacted.request.center, '[redacted]');
  assert.equal(redacted.request.seed, 42);
});

test('redact: truncates bare precise numbers', () => {
  assert.equal(redact(-41.29024567), -41.29);
  assert.equal(redact(21097), 21097);
});

test('redact: a whole route object exposes no coordinates', () => {
  const route = routeFromOrsGeoJson(
    makeOrsResponse({ requestedLengthM: 10000, seed: 1, pointCount: 16 }),
    { requestedLengthM: 10000, seed: 1 },
  );

  const serialised = JSON.stringify(redact(route));
  assert.ok(!serialised.includes(String(PLACES.harbourCity[0]).slice(0, 8)), 'a longitude survived');
  assert.ok(!/-?\d{1,3}\.\d{4,}/.test(serialised), 'coordinate-precision number survived: ' + serialised.slice(0, 200));
});

// ---------------------------------------------------------------------------
// the key store
// ---------------------------------------------------------------------------

test('keystore: stores, reads and clears a key', async () => {
  await withStorage(fakeStorage(), async () => {
    const ks = await keystore();

    assert.equal(ks.hasRouteProviderKey(), false);
    assert.equal(ks.getRouteProviderKey(), null);

    assert.deepEqual(ks.setRouteProviderKey('5b3ce3597851110001cf6248abcdef'), { ok: true });
    assert.equal(ks.hasRouteProviderKey(), true);
    assert.equal(ks.getRouteProviderKey(), '5b3ce3597851110001cf6248abcdef');

    ks.clearRouteProviderKey();
    assert.equal(ks.hasRouteProviderKey(), false, 'clearing must actually remove it');
  });
});

test('keystore: trims surrounding whitespace from a pasted key', async () => {
  await withStorage(fakeStorage(), async () => {
    const ks = await keystore();
    ks.setRouteProviderKey('  5b3ce3597851110001cf6248abcdef \n');
    assert.equal(ks.getRouteProviderKey(), '5b3ce3597851110001cf6248abcdef');
  });
});

test('keystore: rejects obvious mistakes with a usable reason', async () => {
  await withStorage(fakeStorage(), async () => {
    const ks = await keystore();

    assert.match(ks.setRouteProviderKey('').reason, /Enter a key/);
    assert.match(ks.setRouteProviderKey('   ').reason, /Enter a key/);
    assert.match(ks.setRouteProviderKey('https://api.openrouteservice.org/key').reason, /URL/);
    assert.match(ks.setRouteProviderKey('short').reason, /too short/);
    assert.match(ks.setRouteProviderKey('has spaces in the middle here').reason, /spaces/);

    assert.equal(ks.hasRouteProviderKey(), false, 'a rejected key must not be stored');
  });
});

test('keystore: survives a browser that blocks local storage', async () => {
  // Safari private browsing throws on access rather than returning null.
  await withStorage(fakeStorage({ failOn: 'all' }), async () => {
    const ks = await keystore();

    assert.equal(ks.isStorageAvailable(), false);
    assert.equal(ks.getRouteProviderKey(), null, 'should degrade, not throw');
    assert.doesNotThrow(() => ks.clearRouteProviderKey());

    const result = ks.setRouteProviderKey('5b3ce3597851110001cf6248abcdef');
    assert.equal(result.ok, false);
    assert.match(result.reason, /blocking local storage/);
  });
});

test('keystore: masks the key for display', async () => {
  await withStorage(fakeStorage(), async () => {
    const ks = await keystore();

    assert.equal(ks.maskedRouteProviderKey(), null);

    ks.setRouteProviderKey('5b3ce3597851110001cf6248abcdef');
    const masked = ks.maskedRouteProviderKey();

    assert.equal(masked, '5b3c…cdef');
    assert.ok(!masked.includes('7851110001'), 'the middle of the key must not be shown');
  });
});

// ---------------------------------------------------------------------------
// the route cache
// ---------------------------------------------------------------------------

function sampleRoute(seed = 1, lengthM = 10000) {
  return routeFromOrsGeoJson(
    makeOrsResponse({ requestedLengthM: lengthM, actualLengthM: lengthM, seed, ascentM: 75, pointCount: 24 }),
    { requestedLengthM: lengthM, seed },
  );
}

const meta = (runType = 'easy', targetM = 10000) => ({ runType, targetM, savedOn: '2026-09-21' });

test('cache: saves and restores a route', async () => {
  await withStorage(fakeStorage(), async () => {
    const c = await cache();
    const original = sampleRoute();

    assert.equal(c.saveRoute(original, meta()), true);

    const [restored] = c.loadRoutes();
    assert.ok(restored, 'nothing came back');
    assert.equal(restored.route.seed, original.seed);
    assert.equal(restored.meta.runType, 'easy');

    assert.ok(Math.abs(restored.route.actualLengthM - original.actualLengthM) < 5, 'length drifted');
    assert.equal(restored.route.coords.length, original.coords.length);
    assert.ok(Number.isFinite(restored.route.coords[0][2]), 'elevation must survive the round trip');
  });
});

test('cache: keeps newest first and caps the list at five', async () => {
  await withStorage(fakeStorage(), async () => {
    const c = await cache();

    for (let i = 1; i <= 8; i += 1) c.saveRoute(sampleRoute(i, 5000 + i * 1000), meta());

    const routes = c.loadRoutes();
    assert.equal(routes.length, 5, 'the cache should be capped');
    assert.equal(routes[0].route.seed, 8, 'newest should be first');
    assert.equal(c.cachedRouteCount(), 5);
  });
});

test('cache: re-saving a route moves it to the front without duplicating', async () => {
  await withStorage(fakeStorage(), async () => {
    const c = await cache();
    const first = sampleRoute(1);

    c.saveRoute(first, meta());
    c.saveRoute(sampleRoute(2), meta());
    c.saveRoute(first, meta());

    const routes = c.loadRoutes();
    assert.equal(routes.length, 2, 'the same route was cached twice');
    assert.equal(routes[0].route.seed, 1);
  });
});

test('cache: clearing removes every stored coordinate', async () => {
  const store = fakeStorage();
  await withStorage(store, async () => {
    const c = await cache();

    c.saveRoute(sampleRoute(), meta());
    assert.equal(c.cachedRouteCount(), 1);

    c.clearRoutes();

    assert.equal(c.cachedRouteCount(), 0);
    assert.deepEqual(c.loadRoutes(), []);
    assert.equal(store.size, 0, 'the storage key itself should be gone, not just emptied');
  });
});

test('cache: coordinates are stored at reduced precision', async () => {
  const store = fakeStorage();
  await withStorage(store, async () => {
    const c = await cache();
    c.saveRoute(sampleRoute(), meta());

    const raw = store.getItem('loopgen:recent-routes');
    assert.ok(!/\d\.\d{7,}/.test(raw), 'full-precision coordinates were written to disk');
  });
});

test('cache: a corrupt entry is discarded rather than breaking start-up', async () => {
  const store = fakeStorage();
  await withStorage(store, async () => {
    const c = await cache();
    store.setItem('loopgen:recent-routes', '{ this is not json');

    assert.deepEqual(c.loadRoutes(), [], 'should read as empty');
    assert.equal(c.saveRoute(sampleRoute(), meta()), true, 'and still accept a new save');
    assert.equal(c.cachedRouteCount(), 1);
  });
});

test('cache: a cache from a future version is ignored', async () => {
  const store = fakeStorage();
  await withStorage(store, async () => {
    const c = await cache();
    store.setItem('loopgen:recent-routes', JSON.stringify({ version: 99, routes: [{ id: 'x' }] }));
    assert.deepEqual(c.loadRoutes(), []);
  });
});

test('cache: one unreadable entry does not cost the rest of the list', async () => {
  const store = fakeStorage();
  await withStorage(store, async () => {
    const c = await cache();
    c.saveRoute(sampleRoute(1), meta());

    const parsed = JSON.parse(store.getItem('loopgen:recent-routes'));
    parsed.routes.unshift({ id: 'broken', coords: [] });
    store.setItem('loopgen:recent-routes', JSON.stringify(parsed));

    const routes = c.loadRoutes();
    assert.equal(routes.length, 1, 'the good entry should survive');
    assert.equal(routes[0].route.seed, 1);
  });
});

test('cache: a full quota degrades to keeping the newest route', async () => {
  await withStorage(fakeStorage({ quotaBytes: 4000 }), async () => {
    const c = await cache();

    for (let i = 1; i <= 4; i += 1) c.saveRoute(sampleRoute(i), meta());

    const routes = c.loadRoutes();
    assert.ok(routes.length >= 1, 'a full quota should not empty the cache entirely');
    assert.equal(routes[0].route.seed, 4, 'the newest route should be the one kept');
  });
});

test('cache: a browser blocking storage degrades quietly', async () => {
  await withStorage(fakeStorage({ failOn: 'all' }), async () => {
    const c = await cache();

    assert.equal(c.saveRoute(sampleRoute(), meta()), false);
    assert.deepEqual(c.loadRoutes(), []);
    assert.doesNotThrow(() => c.clearRoutes());
  });
});
