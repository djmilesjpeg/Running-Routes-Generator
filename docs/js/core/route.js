/**
 * The provider-neutral Route model.
 *
 * Everything downstream - correction, scoring, GPX, UI - consumes this shape
 * and nothing else. Swapping OpenRouteService for Trail Router means writing a
 * new adapter that emits this shape; no other file changes.
 *
 * Pure: no network, no DOM.
 *
 * @typedef {Object} Route
 * @property {string}   id                stable identity for dedupe and cache keys
 * @property {number}   seed              seed that produced it
 * @property {number}   requestedLengthM  what we ASKED the provider for
 * @property {number}   actualLengthM     what we MEASURED from the geometry
 * @property {number}   reportedLengthM   what the provider CLAIMED
 * @property {number[][]} coords          [lon, lat, ele] in GeoJSON order
 * @property {number}   ascentM
 * @property {number}   descentM
 * @property {number}   stepCount
 * @property {Array}    steps
 * @property {boolean}  isLoop
 */

import { polylineLengthM, elevationDeltas, isLoop as geoIsLoop } from './geo.js';

/**
 * ORS instruction type codes that represent a direction change.
 * Roundabout entries count: they are junctions a runner has to navigate.
 * 6 (straight), 10 (arrive) and 11 (depart) are not turns.
 */
const TURN_TYPES = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 13]);

/**
 * Why `actualLengthM` is measured rather than read from the response.
 *
 * The provider's reported distance is the distance of the route it decided to
 * build, which is exactly the number that goes wrong at long distances - ask
 * for 21km and it may hand back 38km and report 38km quite truthfully. The
 * correction loop needs ground truth, so we integrate the geometry ourselves.
 * `reportedLengthM` is kept only so the two can be compared.
 *
 * @param {Object} params
 * @param {number[][]} params.coords
 * @param {number} params.requestedLengthM
 * @param {number} params.seed
 * @param {number} [params.reportedLengthM]
 * @param {Array}  [params.steps]
 * @param {number} [params.ascentM]
 * @param {number} [params.descentM]
 * @param {string} [params.id]
 * @returns {Route}
 */
export function makeRoute({
  coords,
  requestedLengthM,
  seed,
  reportedLengthM = null,
  steps = [],
  ascentM = null,
  descentM = null,
  id = null,
}) {
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new TypeError('makeRoute: coords must hold at least two points');
  }

  const measuredLengthM = polylineLengthM(coords);

  // Prefer the provider's own ascent figures when present: they come from a
  // finer elevation sample than the returned vertices. Fall back to computing
  // from the geometry so a provider without elevation summaries still scores.
  const hasProviderElevation =
    typeof ascentM === 'number' && Number.isFinite(ascentM) &&
    typeof descentM === 'number' && Number.isFinite(descentM);

  const elevation = hasProviderElevation
    ? { ascentM, descentM }
    : elevationDeltas(coords);

  return {
    id: id ?? `seed-${seed}-req-${Math.round(requestedLengthM)}`,
    seed,
    requestedLengthM,
    actualLengthM: measuredLengthM,
    reportedLengthM: reportedLengthM ?? measuredLengthM,
    coords,
    ascentM: elevation.ascentM,
    descentM: elevation.descentM,
    stepCount: steps.length,
    turnCount: steps.filter((s) => TURN_TYPES.has(s.type)).length,
    steps,
    isLoop: geoIsLoop(coords),
  };
}

/**
 * Adapt an OpenRouteService GeoJSON directions response into a Route.
 *
 * This is the only function in core that knows the ORS response shape, and it
 * is deliberately tolerant: a missing `segments` or `ascent` degrades to a
 * still-scoreable route rather than throwing.
 *
 * @param {Object} geojson ORS FeatureCollection
 * @param {{requestedLengthM: number, seed: number}} context
 * @returns {Route}
 */
export function routeFromOrsGeoJson(geojson, { requestedLengthM, seed }) {
  const feature = geojson?.features?.[0];
  if (!feature) {
    throw new Error('ORS response contained no route feature');
  }

  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error('ORS response contained no usable geometry');
  }

  const props = feature.properties ?? {};
  const segments = Array.isArray(props.segments) ? props.segments : [];

  const steps = segments.flatMap((segment) =>
    (segment.steps ?? []).map((step) => ({
      distance: step.distance,
      duration: step.duration,
      type: step.type,
      instruction: step.instruction,
      name: step.name,
      wayPoints: step.way_points,
    })),
  );

  const sumOf = (key) =>
    segments.reduce((total, segment) => {
      const value = segment[key];
      return typeof value === 'number' && Number.isFinite(value) ? total + value : total;
    }, 0);

  const ascent = typeof props.ascent === 'number' ? props.ascent : (segments.length ? sumOf('ascent') : null);
  const descent = typeof props.descent === 'number' ? props.descent : (segments.length ? sumOf('descent') : null);

  return makeRoute({
    coords,
    requestedLengthM,
    seed,
    reportedLengthM: props.summary?.distance ?? null,
    steps,
    ascentM: ascent,
    descentM: descent,
  });
}

/** Ratio of delivered length to requested length. 1 is perfect. */
export function lengthRatio(route) {
  if (!route || !route.requestedLengthM) return NaN;
  return route.actualLengthM / route.requestedLengthM;
}

/** Signed relative error against a target. -0.1 means 10% short. */
export function relativeError(route, targetM) {
  if (!targetM) return NaN;
  return (route.actualLengthM - targetM) / targetM;
}
