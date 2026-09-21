/**
 * Run-type scoring.
 *
 * Scoring never triggers routing. It ranks the candidates that already
 * survived distance correction, so choosing "hills" over "easy" re-sorts a
 * list that is already in hand rather than spending more of the API quota.
 *
 * Every metric comes from the elevation profile and the step list, both of
 * which arrive in the routing response.
 *
 * Pure: no network, no DOM.
 */

import { relativeError } from './route.js';

/**
 * Each run type names one objective, per the spec. Candidates reaching this
 * point are already within tolerance of the target, so distance accuracy is
 * settled for every type except `long`, which optimises it further.
 *
 * `metric`    pulls the raw number off a Route
 * `direction` 'min' or 'max'
 */
export const RUN_TYPES = Object.freeze({
  easy: {
    id: 'easy',
    label: 'Easy',
    hint: 'Flattest loop',
    description: 'Minimises total ascent.',
    direction: 'min',
    unit: 'm ascent',
    metric: (route) => route.ascentM,
    format: (route) => Math.round(route.ascentM) + 'm up',
  },
  tempo: {
    id: 'tempo',
    label: 'Tempo',
    hint: 'Fewest interruptions',
    description: 'Minimises turns and road crossings, measured as the number of routing steps.',
    direction: 'min',
    unit: 'steps',
    metric: (route) => route.stepCount,
    format: (route) => route.stepCount + ' turns',
  },
  long: {
    id: 'long',
    label: 'Long',
    hint: 'Closest to target',
    description: 'Maximises distance accuracy and ignores terrain entirely.',
    direction: 'min',
    unit: 'error',
    metric: (route, ctx) => Math.abs(relativeError(route, ctx.targetM)),
    format: (route, ctx) => {
      const err = relativeError(route, ctx.targetM) * 100;
      return (err > 0 ? '+' : '') + err.toFixed(1) + '%';
    },
  },
  hills: {
    id: 'hills',
    label: 'Hills',
    hint: 'Most climbing',
    description: 'Maximises total ascent.',
    direction: 'max',
    unit: 'm ascent',
    metric: (route) => route.ascentM,
    format: (route) => Math.round(route.ascentM) + 'm up',
  },
});

/** Run type ids in the order they should appear in the UI. */
export const RUN_TYPE_IDS = Object.freeze(['easy', 'tempo', 'long', 'hills']);

/** @returns {boolean} */
export function isRunType(id) {
  return Object.prototype.hasOwnProperty.call(RUN_TYPES, id);
}

/**
 * Min-max normalise a raw metric to 0..1 where 1 is always best, whichever
 * direction the run type optimises.
 *
 * Normalising across the candidate set rather than against absolute limits is
 * deliberate: "most climbing" means most among what is actually reachable
 * from here, and 180m of ascent may be the hilliest loop in a flat city.
 *
 * A degenerate spread - every candidate identical - scores everyone 1 rather
 * than dividing by zero.
 */
export function normalise(values, direction) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0);

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;

  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    if (span === 0) return 1;
    const unit = (v - min) / span;
    return direction === 'max' ? unit : 1 - unit;
  });
}

/**
 * Handy per-candidate figures for display. Not used in ranking.
 */
export function routeStats(route, targetM) {
  const km = route.actualLengthM / 1000;
  return {
    distanceKm: km,
    ascentM: route.ascentM,
    descentM: route.descentM,
    ascentPerKm: km > 0 ? route.ascentM / km : 0,
    stepCount: route.stepCount,
    turnCount: route.turnCount,
    stepsPerKm: km > 0 ? route.stepCount / km : 0,
    errorPct: Number.isFinite(targetM) ? relativeError(route, targetM) * 100 : null,
    isLoop: route.isLoop,
  };
}

/**
 * Rank candidates for a run type.
 *
 * @param {Array} routes   candidates that already passed distance correction
 * @param {string} runType one of RUN_TYPE_IDS
 * @param {{targetM: number}} context
 * @returns {Array<{route:Object, score:number, raw:number, rank:number, label:string, stats:Object}>}
 *          best first
 */
export function scoreCandidates(routes, runType, context = {}) {
  if (!isRunType(runType)) {
    throw new TypeError(
      'scoreCandidates: unknown run type "' + runType + '". Expected one of ' + RUN_TYPE_IDS.join(', '),
    );
  }
  if (!Array.isArray(routes) || routes.length === 0) return [];

  const spec = RUN_TYPES[runType];
  const ctx = { targetM: context.targetM };

  const raws = routes.map((route) => spec.metric(route, ctx));
  const scores = normalise(raws, spec.direction);

  const scored = routes.map((route, i) => ({
    route,
    score: scores[i],
    raw: raws[i],
    label: spec.format(route, ctx),
    stats: routeStats(route, ctx.targetM),
  }));

  // Primary: the run type's own score. Then distance accuracy, then seed, so
  // that equal candidates always come back in the same order.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const aErr = Math.abs(relativeError(a.route, ctx.targetM));
    const bErr = Math.abs(relativeError(b.route, ctx.targetM));
    if (Number.isFinite(aErr) && Number.isFinite(bErr) && aErr !== bErr) return aErr - bErr;

    return a.route.seed - b.route.seed;
  });

  return scored.map((entry, i) => ({ ...entry, rank: i + 1 }));
}

/**
 * The single best candidate for a run type, or null.
 */
export function bestCandidate(routes, runType, context = {}) {
  const ranked = scoreCandidates(routes, runType, context);
  return ranked.length > 0 ? ranked[0] : null;
}
