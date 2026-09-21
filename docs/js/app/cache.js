/**
 * Recent routes, cached for offline viewing.
 *
 * WHAT THIS HOLDS
 * Real coordinates - that is unavoidable, since the point is to open a route
 * you generated earlier while out of signal. It stays in one place, in this
 * browser's localStorage, and never leaves the device. Nothing here is sent
 * anywhere, and clearRoutes() genuinely empties it.
 *
 * Geometry is stored at reduced precision. Five decimal places is about a
 * metre, which is finer than any of this needs, and it roughly halves what is
 * written to disk.
 */

import { debug, warn } from '../core/log.js';
import { makeRoute } from '../core/route.js';

const CACHE_NAME = 'loopgen:recent-routes';
const CACHE_VERSION = 1;
const MAX_ROUTES = 5;
const COORD_PRECISION = 5;

function storage() {
  try {
    const store = globalThis.localStorage;
    const probe = '__loopgen_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Reduce a Route to what is worth persisting. */
function serialiseRoute(route, meta) {
  return {
    id: route.id,
    seed: route.seed,
    requestedLengthM: round(route.requestedLengthM, 1),
    actualLengthM: round(route.actualLengthM, 1),
    ascentM: round(route.ascentM, 1),
    descentM: round(route.descentM, 1),
    stepCount: route.stepCount,
    turnCount: route.turnCount,
    coords: route.coords.map(([lon, lat, ele]) => [
      round(lon, COORD_PRECISION),
      round(lat, COORD_PRECISION),
      Number.isFinite(ele) ? round(ele, 1) : null,
    ]),
    meta: {
      runType: meta.runType,
      targetM: meta.targetM,
      // A calendar date, for ordering the list. Never written into a GPX file.
      savedOn: meta.savedOn,
    },
  };
}

/** Rebuild a Route from its cached form. */
function deserialiseRoute(entry) {
  const route = makeRoute({
    id: entry.id,
    coords: entry.coords.map(([lon, lat, ele]) => [lon, lat, ele === null ? undefined : ele]),
    requestedLengthM: entry.requestedLengthM,
    seed: entry.seed,
    ascentM: entry.ascentM,
    descentM: entry.descentM,
    steps: new Array(entry.stepCount ?? 0).fill({ type: 6 }),
  });

  return { route, meta: entry.meta };
}

function readRaw() {
  const store = storage();
  if (!store) return [];

  try {
    const parsed = JSON.parse(store.getItem(CACHE_NAME) || 'null');
    if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.routes)) return [];
    return parsed.routes;
  } catch {
    // Corrupt or half-written cache. Treat it as empty rather than breaking
    // start-up; the next save overwrites it.
    warn('the route cache could not be read and will be replaced');
    return [];
  }
}

function writeRaw(routes) {
  const store = storage();
  if (!store) return false;

  try {
    store.setItem(CACHE_NAME, JSON.stringify({ version: CACHE_VERSION, routes }));
    return true;
  } catch (cause) {
    // Almost always the quota. Retry once with only the newest entry rather
    // than silently keeping nothing.
    warn('route cache write failed, trimming', cause?.name);
    try {
      store.setItem(CACHE_NAME, JSON.stringify({ version: CACHE_VERSION, routes: routes.slice(0, 1) }));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Save a route, newest first, keeping at most MAX_ROUTES.
 *
 * @param {Object} route
 * @param {{runType: string, targetM: number, savedOn: string}} meta
 * @returns {boolean} whether it was persisted
 */
export function saveRoute(route, meta) {
  const existing = readRaw().filter((entry) => entry.id !== route.id);
  const next = [serialiseRoute(route, meta), ...existing].slice(0, MAX_ROUTES);

  const saved = writeRaw(next);
  debug('cached route', { saved, count: next.length });
  return saved;
}

/**
 * Every cached route, newest first.
 * @returns {Array<{route: Object, meta: Object}>}
 */
export function loadRoutes() {
  const entries = [];

  for (const entry of readRaw()) {
    try {
      entries.push(deserialiseRoute(entry));
    } catch {
      // One unreadable entry should not cost the rest of the list.
      warn('skipped an unreadable cached route');
    }
  }

  return entries;
}

/** How many routes are cached. */
export function cachedRouteCount() {
  return readRaw().length;
}

/**
 * Delete every cached route.
 *
 * This is the control that makes the cache acceptable: the location data it
 * holds can be removed on demand, from the app, without clearing the browser.
 */
export function clearRoutes() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CACHE_NAME);
  } catch {
    warn('could not clear the route cache');
  }
}
