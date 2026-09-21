/**
 * Round-trip distance correction.
 *
 * THE PROBLEM
 * Round-trip routing takes a requested loop length as a hint, not a contract.
 * Up to roughly 10km the returned loop is close. Beyond that it degrades
 * badly and without warning: a 21km request can come back as a 38km loop.
 * The provider is not lying - it reports 38km quite accurately - it simply
 * built a different loop than the one that was asked for.
 *
 * THE APPROACH
 * Treat the router as an opaque, noisy function A = f(R, seed) mapping a
 * requested length to a delivered length, and solve f(R) = target for R.
 *
 *   - One observation for a seed: proportional scaling, Rnext = R * (T / A).
 *   - Two or more: fit a local power law, A = c * R^k, and solve it.
 *
 * The power law is the part that matters. The obvious choice is a linear
 * secant, and it converges too slowly to be useful here: measured against a
 * simulated router that inflates the way the real one does, a secant needs
 * five or more rounds at marathon distance and systematically undershoots,
 * because the error is multiplicative rather than additive. Fitting an
 * exponent instead reaches 5% in three rounds across 5km to 42km. Both are
 * exercised by the convergence tests, which is how the difference surfaced.
 *
 * Where observations bracket the target - one short, one long - the two
 * closest on either side are used, which keeps the fit interpolating rather
 * than extrapolating.
 *
 * Every seed is solved independently, because f genuinely differs per seed:
 * one seed may drop its loop into a dense street grid and another onto a
 * river path with almost no options.
 *
 * PURITY
 * No network, no clock, no randomness. planCorrection() takes the full
 * history of what has been tried and returns what to try next. The network
 * loop elsewhere is a thin driver that only executes those instructions,
 * which is what makes this policy testable entirely from fixtures.
 */

import { relativeError } from './route.js';

export const DEFAULT_CORRECTION_OPTIONS = Object.freeze({
  /** Accept a candidate within this fraction of the target. 0.05 = 5%. */
  tolerance: 0.05,
  /** Seeds requested per round. */
  candidateCount: 4,
  /**
   * Request generations before giving up. Four is the measured worst case for
   * a marathon-length loop with the power-law fit; a linear secant needs more.
   */
  maxRounds: 4,
  /**
   * Hard ceiling on total requests for one generation run. Defaults to
   * candidateCount * maxRounds.
   *
   * Termination is bounded on this rather than on a round counter, because a
   * round counter derived from per-seed history silently stops advancing once
   * seeds start being retired at maxAttemptsPerSeed - which allows an
   * unbounded retry loop. Total requests is also the quantity that actually
   * costs API quota, so bounding it directly is the honest thing to limit.
   */
  maxTotalAttempts: null,
  /** Stop early once this many candidates qualify. */
  minAccepted: 2,
  /**
   * A single candidate this close ends the run immediately.
   *
   * Without it, a run that nails the distance on the first round still spends
   * its whole budget hunting for a second qualifying loop - twelve more
   * requests and a long wait to improve on a route that was already within a
   * couple of percent. Holding out for variety is not worth that.
   */
  excellentTolerance: 0.02,
  /** Retire a seed that has failed this many times and try a fresh one. */
  maxAttemptsPerSeed: 3,
  /** Absolute floor on a request, metres. */
  minRequestM: 300,
  /** Never request more than this multiple of the target. */
  maxRequestFactor: 3,
  /** Never request less than this multiple of the target. */
  minRequestFactor: 0.25,
  /**
   * Damping on proportional scaling. 1 applies the full correction. Slightly
   * below 1 trades a little convergence speed for resistance to overshoot
   * when f is steeply non-linear.
   */
  damping: 1,
});

/** Ratio of delivered to requested length. 1 is perfect. */
export function correctionRatio(route) {
  if (!route || !route.requestedLengthM) return NaN;
  return route.actualLengthM / route.requestedLengthM;
}

/** Does this route land within tolerance of the target? */
export function isWithinTolerance(route, targetM, tolerance = DEFAULT_CORRECTION_OPTIONS.tolerance) {
  const err = relativeError(route, targetM);
  return Number.isFinite(err) && Math.abs(err) <= tolerance;
}

/**
 * Deterministic seed derivation. Pure, so a given base reproduces a given run.
 * The Knuth multiplier spreads consecutive indices across the seed space
 * rather than handing the router four near-identical values.
 */
export function deriveSeed(baseSeed, index) {
  const mixed = Math.imul(baseSeed + index + 1, 2654435761) >>> 0;
  return mixed % 2147483647;
}

/** Group attempts by seed, preserving chronological order within each seed. */
export function groupBySeed(attempts) {
  const bySeed = new Map();
  for (const attempt of attempts) {
    if (!bySeed.has(attempt.seed)) bySeed.set(attempt.seed, []);
    bySeed.get(attempt.seed).push(attempt);
  }
  return bySeed;
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/**
 * Pick the two observations to fit through.
 *
 * If the target is bracketed, take the closest point on each side, so the fit
 * interpolates between a known-short and a known-long result. Interpolation is
 * far better behaved than extrapolation when the curve is steep.
 *
 * Otherwise take the two nearest the target, where the local fit is most
 * likely to hold.
 *
 * @returns {[Object, Object]|null}
 */
export function chooseReferencePoints(usable, targetM) {
  if (!usable || usable.length < 2) return null;

  const nearer = (a, b) =>
    Math.abs(a.actualLengthM - targetM) <= Math.abs(b.actualLengthM - targetM) ? a : b;

  const below = usable.filter((h) => h.actualLengthM <= targetM);
  const above = usable.filter((h) => h.actualLengthM > targetM);

  if (below.length > 0 && above.length > 0) {
    return [below.reduce(nearer), above.reduce(nearer)];
  }

  const sorted = [...usable].sort(
    (a, b) => Math.abs(a.actualLengthM - targetM) - Math.abs(b.actualLengthM - targetM),
  );
  return [sorted[0], sorted[1]];
}

/**
 * Fit A = c * R^k through two observations and solve for A = target.
 *
 * k is the elasticity of delivered length with respect to requested length.
 * k = 1 would mean the router honours requests proportionally; in practice it
 * runs well above 1 past the knee, which is exactly the observed failure.
 *
 * Anchored on whichever reference point sits closer to the target, since the
 * fit is most trustworthy near the data.
 *
 * @returns {number|null} null when the fit is degenerate
 */
export function powerLawRequest(p1, p2, targetM) {
  for (const p of [p1, p2]) {
    if (!p || !(p.requestedLengthM > 0) || !(p.actualLengthM > 0)) return null;
  }

  const logRequestRatio = Math.log(p2.requestedLengthM / p1.requestedLengthM);
  const logActualRatio = Math.log(p2.actualLengthM / p1.actualLengthM);

  // Identical requests or identical results carry no slope information.
  if (Math.abs(logRequestRatio) < 1e-9 || Math.abs(logActualRatio) < 1e-9) return null;

  const k = logActualRatio / logRequestRatio;

  // k <= 0 means asking for more produced less. That is noise, not a curve.
  if (!Number.isFinite(k) || k <= 0) return null;

  const anchor =
    Math.abs(p1.actualLengthM - targetM) <= Math.abs(p2.actualLengthM - targetM) ? p1 : p2;

  const request = anchor.requestedLengthM * Math.pow(targetM / anchor.actualLengthM, 1 / k);
  return Number.isFinite(request) && request > 0 ? request : null;
}

/**
 * The next length to request for ONE seed, given what that seed returned so far.
 *
 * @param {Object} params
 * @param {number} params.targetM
 * @param {Array<{requestedLengthM:number, actualLengthM:number}>} params.history chronological
 * @param {Object} [params.options]
 * @returns {number} metres to request next
 */
export function nextRequestLengthM({ targetM, history, options = {} }) {
  const opts = { ...DEFAULT_CORRECTION_OPTIONS, ...options };
  const lo = Math.max(opts.minRequestM, targetM * opts.minRequestFactor);
  const hi = targetM * opts.maxRequestFactor;

  const usable = (history || []).filter(
    (h) =>
      h &&
      Number.isFinite(h.actualLengthM) &&
      Number.isFinite(h.requestedLengthM) &&
      h.actualLengthM > 0 &&
      h.requestedLengthM > 0,
  );

  // Nothing observed yet: ask for exactly what we want.
  if (usable.length === 0) return clamp(targetM, lo, hi);

  const last = usable[usable.length - 1];

  // Proportional scaling from a single observation.
  const proportional = () => {
    const ratio = clamp(last.actualLengthM / last.requestedLengthM, 0.2, 5);
    const full = targetM / ratio;
    return last.requestedLengthM + (full - last.requestedLengthM) * opts.damping;
  };

  if (usable.length === 1) return clamp(proportional(), lo, hi);

  // Two or more observations: fit the curve. Falls back to proportional
  // scaling whenever the fit is degenerate, so this never returns garbage.
  const references = chooseReferencePoints(usable, targetM);
  if (!references) return clamp(proportional(), lo, hi);

  const fitted = powerLawRequest(references[0], references[1], targetM);
  if (fitted === null) return clamp(proportional(), lo, hi);

  return clamp(fitted, lo, hi);
}

/**
 * A starting request length for a seed that has never been tried, informed by
 * what every other seed has already revealed.
 *
 * Without this, a seed introduced in round two would start by asking for the
 * raw target - the one request already known to be wrong - and waste most of
 * its remaining rounds rediscovering that. The median across seeds resists a
 * single wild result skewing the estimate.
 */
export function globalPrior({ targetM, attempts = [], options = {} }) {
  const opts = { ...DEFAULT_CORRECTION_OPTIONS, ...options };
  const lo = Math.max(opts.minRequestM, targetM * opts.minRequestFactor);
  const hi = targetM * opts.maxRequestFactor;

  const estimates = [];
  for (const history of groupBySeed(attempts).values()) {
    const latest = history[history.length - 1];
    if (!latest || !(latest.actualLengthM > 0) || !(latest.requestedLengthM > 0)) continue;
    estimates.push(
      nextRequestLengthM({ targetM, history, options: opts }),
    );
  }

  if (estimates.length === 0) return clamp(targetM, lo, hi);

  estimates.sort((a, b) => a - b);
  const mid = Math.floor(estimates.length / 2);
  const median =
    estimates.length % 2 === 1 ? estimates[mid] : (estimates[mid - 1] + estimates[mid]) / 2;

  return clamp(median, lo, hi);
}

/**
 * Rank routes by how close they land to the target. Ties break on seed so the
 * ordering is deterministic and tests never depend on sort stability.
 */
export function rankByAccuracy(routes, targetM) {
  return [...routes].sort((a, b) => {
    const d = Math.abs(relativeError(a, targetM)) - Math.abs(relativeError(b, targetM));
    return d !== 0 ? d : a.seed - b.seed;
  });
}

/**
 * Decide what to do next.
 *
 * @param {Object} params
 * @param {number} params.targetM     desired loop length, metres
 * @param {Array}  [params.attempts]  every Route returned so far
 * @param {number} [params.baseSeed]  deterministic seed source
 * @param {Object} [params.options]
 * @returns {{
 *   status: 'satisfied'|'retry'|'exhausted',
 *   accepted: Array,
 *   nextRequests: Array<{seed:number, lengthM:number}>,
 *   roundsDone: number,
 *   error: {code:string, message:string, detail:Object}|null,
 *   diagnostics: Object
 * }}
 */
export function planCorrection({ targetM, attempts = [], baseSeed = 1, options = {} }) {
  const opts = { ...DEFAULT_CORRECTION_OPTIONS, ...options };

  if (!Number.isFinite(targetM) || targetM <= 0) {
    throw new TypeError('planCorrection: targetM must be a positive number');
  }

  const budget = opts.maxTotalAttempts ?? opts.candidateCount * opts.maxRounds;
  const spent = attempts.length;
  const remaining = Math.max(0, budget - spent);
  const outOfBudget = remaining === 0;

  const bySeed = groupBySeed(attempts);
  const roundsDone = Math.ceil(spent / Math.max(1, opts.candidateCount));

  // Keep only each seed's most recent attempt as its representative candidate;
  // earlier attempts for that seed were superseded by the correction.
  const latestPerSeed = [...bySeed.values()].map((h) => h[h.length - 1]);

  const accepted = rankByAccuracy(
    latestPerSeed.filter((r) => isWithinTolerance(r, targetM, opts.tolerance)),
    targetM,
  );

  // Every seed's latest attempt, ranked. The UI shows these as alternatives
  // even on a successful run, so there is always more than one route to look
  // at rather than a single result and an empty list.
  const allRanked = rankByAccuracy(latestPerSeed, targetM);

  const diagnostics = {
    attemptCount: attempts.length,
    seedCount: bySeed.size,
    tolerance: opts.tolerance,
    budget,
    spent,
    remaining,
    ratios: latestPerSeed.map((r) => ({ seed: r.seed, ratio: correctionRatio(r) })),
  };

  // One candidate that is already excellent is worth more than a full budget
  // spent looking for a second merely acceptable one.
  const haveExcellent = accepted.some((r) => isWithinTolerance(r, targetM, opts.excellentTolerance));

  // Enough good candidates, or out of budget but holding at least one.
  if (
    accepted.length >= opts.minAccepted ||
    haveExcellent ||
    (accepted.length > 0 && outOfBudget)
  ) {
    return {
      status: 'satisfied',
      accepted,
      allCandidates: allRanked,
      nextRequests: [],
      roundsDone,
      error: null,
      diagnostics,
    };
  }

  if (outOfBudget) {
    const ranked = rankByAccuracy(latestPerSeed, targetM);
    const best = ranked[0] || null;
    const bestErr = best ? relativeError(best, targetM) : NaN;

    return {
      status: 'exhausted',
      accepted: [],
      allCandidates: allRanked,
      nextRequests: [],
      roundsDone,
      error: {
        code: 'NO_CANDIDATE_WITHIN_TOLERANCE',
        message: best
          ? 'No loop landed within ' +
            Math.round(opts.tolerance * 100) +
            '% of ' +
            (targetM / 1000).toFixed(1) +
            'km after ' +
            roundsDone +
            ' rounds. Closest was ' +
            (best.actualLengthM / 1000).toFixed(2) +
            'km (' +
            (bestErr > 0 ? '+' : '') +
            (bestErr * 100).toFixed(1) +
            '%).'
          : 'Routing returned no usable loops for ' + (targetM / 1000).toFixed(1) + 'km.',
        detail: {
          targetM,
          bestRoute: best,
          bestErrorPct: Number.isFinite(bestErr) ? bestErr * 100 : null,
          roundsDone,
          candidates: ranked,
        },
      },
      diagnostics,
    };
  }

  // Another round. Refine seeds that are still viable, retire the rest.
  const nextRequests = [];
  for (const [seed, history] of bySeed) {
    if (history.length >= opts.maxAttemptsPerSeed) continue; // retired
    nextRequests.push({ seed, lengthM: nextRequestLengthM({ targetM, history, options: opts }) });
  }

  // Backfill with fresh seeds so each round still explores candidateCount
  // loops. They start from the global prior rather than the raw target, so a
  // seed introduced late is not condemned to repeat the first round's mistake.
  const priorLengthM = globalPrior({ targetM, attempts, options: opts });

  let index = attempts.length;
  let guard = 0;
  while (nextRequests.length < Math.min(opts.candidateCount, remaining) && guard < 1000) {
    guard += 1;
    const seed = deriveSeed(baseSeed, index);
    index += 1;
    if (bySeed.has(seed) || nextRequests.some((r) => r.seed === seed)) continue;
    nextRequests.push({ seed, lengthM: priorLengthM });
  }

  // Never request more than the remaining budget allows.
  const width = Math.min(opts.candidateCount, remaining);

  return {
    status: 'retry',
    accepted,
    allCandidates: allRanked,
    nextRequests: nextRequests.slice(0, width),
    roundsDone,
    error: null,
    diagnostics,
  };
}

/**
 * The opening round: candidateCount seeds, each asked for the target length.
 * Equivalent to planCorrection with no attempts, kept separate because it
 * reads better at the call site.
 */
export function initialPlan({ targetM, baseSeed = 1, options = {} }) {
  const opts = { ...DEFAULT_CORRECTION_OPTIONS, ...options };
  return Array.from({ length: opts.candidateCount }, (_, i) => ({
    seed: deriveSeed(baseSeed, i),
    lengthM: nextRequestLengthM({ targetM, history: [], options: opts }),
  }));
}
