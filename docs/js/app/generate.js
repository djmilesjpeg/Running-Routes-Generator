/**
 * The generation orchestrator.
 *
 * Drives the correction loop: ask the provider for candidates, hand every
 * result to planCorrection, do what it says, stop when it says stop. All the
 * policy lives in core/correction.js; this file only performs I/O and
 * assembles the outcome.
 *
 * It never mentions a specific provider. It is handed something implementing
 * RouteProvider and calls one method on it.
 */

import { planCorrection, initialPlan, DEFAULT_CORRECTION_OPTIONS } from '../core/correction.js';
import { scoreCandidates } from '../core/scoring.js';
import { RouteProviderError, PROVIDER_ERRORS } from '../providers/RouteProvider.js';

/**
 * Failures where retrying with a different length or seed cannot possibly
 * help, so the run stops immediately rather than burning the request budget.
 */
const FATAL_PROVIDER_ERRORS = new Set([
  PROVIDER_ERRORS.MISSING_KEY,
  PROVIDER_ERRORS.INVALID_KEY,
  PROVIDER_ERRORS.RATE_LIMITED,
  PROVIDER_ERRORS.QUOTA_EXCEEDED,
  PROVIDER_ERRORS.UNROUTABLE_START,
]);

/**
 * Generate and rank loop routes.
 *
 * @param {Object} params
 * @param {Object}   params.provider   a RouteProvider
 * @param {number}   params.lat
 * @param {number}   params.lon
 * @param {number}   params.targetM    desired loop length in metres
 * @param {string}   params.runType    easy | tempo | long | hills
 * @param {string}   [params.style]    quiet | paths | direct
 * @param {number}   params.baseSeed   makes a run reproducible
 * @param {Object}   [params.options]  correction options
 * @param {Function} [params.onProgress] ({phase, round, requested, received})
 * @param {AbortSignal} [params.signal]
 *
 * @returns {Promise<{
 *   status: 'ok'|'failed',
 *   ranked: Array, best: Object|null, accepted: Array, attempts: Array,
 *   error: Object|null, warnings: Array, diagnostics: Object
 * }>}
 */
export async function generateRoutes({
  provider,
  lat,
  lon,
  targetM,
  runType,
  baseSeed,
  style = null,
  options = {},
  onProgress = null,
  signal = null,
}) {
  const opts = { ...DEFAULT_CORRECTION_OPTIONS, ...options };
  const attempts = [];
  const warnings = [];

  let requests = initialPlan({ targetM, baseSeed, options: opts });
  let plan = null;
  let round = 0;

  const budget = opts.maxTotalAttempts ?? opts.candidateCount * opts.maxRounds;
  const maxRounds = opts.maxRounds;

  // A spinner alone looks the same whether one request is outstanding or
  // sixteen, which is what makes a long run feel like a hang. Every callback
  // carries enough for the UI to say where it has got to.
  const report = (phase, extra = {}) => {
    if (!onProgress) return;
    onProgress({
      phase,
      round,
      maxRounds,
      measured: attempts.length,
      budget,
      accepted: plan ? plan.accepted.length : 0,
      ...extra,
    });
  };

  while (requests.length > 0) {
    // Check the signal here rather than relying on fetch to reject. A provider
    // that ignores the signal - or a cached response that never hits the
    // network - would otherwise let the loop start another round after the
    // runner has already pressed stop.
    if (signal && signal.aborted) {
      throw Object.assign(new Error('Route generation was stopped.'), { name: 'AbortError' });
    }

    round += 1;
    report('requesting', { requested: requests.length });

    const settled = await Promise.allSettled(
      requests.map((request) =>
        provider.generateCandidates({
          lat,
          lon,
          distanceM: request.lengthM,
          seed: request.seed,
          style,
          signal,
        }),
      ),
    );

    const failures = [];
    let received = 0;

    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];

      if (outcome.status === 'fulfilled') {
        for (const route of outcome.value) {
          attempts.push(route);
          received += 1;
        }
        continue;
      }

      const reason = outcome.reason;
      if (reason && reason.name === 'AbortError') throw reason;
      failures.push({ seed: requests[i].seed, error: reason });
    }

    // A fatal failure means every subsequent request would fail identically.
    const fatal = failures.find(
      (f) => f.error instanceof RouteProviderError && FATAL_PROVIDER_ERRORS.has(f.error.code),
    );
    if (fatal) {
      return failure(fatal.error, { attempts, warnings, targetM, runType });
    }

    // Nothing at all came back and nothing is retryable: stop.
    if (received === 0 && attempts.length === 0) {
      const first = failures[0]?.error;
      return failure(
        first ||
          new RouteProviderError(PROVIDER_ERRORS.NO_ROUTE, 'No routes could be generated from here.'),
        { attempts, warnings, targetM, runType },
      );
    }

    // Partial failures are survivable: note them and carry on with what came back.
    for (const { seed, error } of failures) {
      warnings.push({
        code: error instanceof RouteProviderError ? error.code : PROVIDER_ERRORS.UNKNOWN,
        message: error?.message || 'A candidate route failed to generate.',
        seed,
      });
    }

    report('measuring', { received });

    plan = planCorrection({ targetM, attempts, baseSeed, options: opts });

    if (plan.status !== 'retry') break;

    report('correcting', { nextRequests: plan.nextRequests.length });
    requests = plan.nextRequests;
  }

  if (!plan) {
    plan = planCorrection({ targetM, attempts, baseSeed, options: opts });
  }

  if (plan.status === 'exhausted') {
    return {
      status: 'failed',
      ranked: [],
      best: null,
      accepted: [],
      attempts,
      // planCorrection keeps the closest candidates, so the UI can still offer
      // a near miss rather than leaving the runner with nothing.
      error: plan.error,
      nearMisses: scoreSafely(plan.error?.detail?.candidates ?? [], runType, targetM),
      warnings,
      diagnostics: plan.diagnostics,
    };
  }

  const ranked = scoreCandidates(plan.accepted, runType, { targetM });

  // Loops that missed the tolerance are still worth showing. A single result
  // beside an empty list reads as though nothing else was found, when in fact
  // several were measured and simply landed outside 5%.
  const others = (plan.allCandidates ?? []).filter(
    (route) => !plan.accepted.some((a) => a.id === route.id),
  );

  report('done', { accepted: plan.accepted.length });

  return {
    status: 'ok',
    ranked,
    best: ranked[0] ?? null,
    accepted: plan.accepted,
    nearMisses: scoreSafely(others, runType, targetM),
    attempts,
    error: null,
    warnings,
    diagnostics: plan.diagnostics,
  };
}

/** Scoring must never turn a failure into a crash. */
function scoreSafely(routes, runType, targetM) {
  try {
    return scoreCandidates(routes, runType, { targetM });
  } catch {
    return [];
  }
}

function failure(error, { attempts, warnings, targetM, runType }) {
  return {
    status: 'failed',
    ranked: [],
    best: null,
    accepted: [],
    attempts,
    error: {
      code: error instanceof RouteProviderError ? error.code : PROVIDER_ERRORS.UNKNOWN,
      message: error?.message || 'Route generation failed.',
      detail: { targetM, runType },
    },
    nearMisses: [],
    warnings,
    diagnostics: { attemptCount: attempts.length },
  };
}
