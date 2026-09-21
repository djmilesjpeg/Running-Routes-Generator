import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CORRECTION_OPTIONS,
  correctionRatio,
  isWithinTolerance,
  deriveSeed,
  groupBySeed,
  nextRequestLengthM,
  chooseReferencePoints,
  powerLawRequest,
  globalPrior,
  rankByAccuracy,
  planCorrection,
  initialPlan,
} from '../docs/js/core/correction.js';

import { routeFromOrsGeoJson } from '../docs/js/core/route.js';
import { makeOrsResponse, makeFakeRouter } from './fixtures/synthetic.js';

/**
 * No test in this file may touch the network. Correction is a pure policy
 * over route objects; if a fetch ever appears in this layer, these tests fail
 * loudly rather than quietly making real requests against an API quota.
 */
globalThis.fetch = () => {
  throw new Error('correction tests must not perform network calls');
};

const HALF_MARATHON_M = 21097;

/**
 * Build a real Route that was ASKED for `requested` and DELIVERED `actual`.
 * Goes through the full ORS adapter so these tests exercise the same parsing
 * path production uses.
 */
function routeFor({ seed = 1, requested, actual, ascentM = 60, stepCount = 40 }) {
  const response = makeOrsResponse({
    requestedLengthM: requested,
    actualLengthM: actual,
    seed,
    ascentM,
    stepCount,
    pointCount: 48,
  });
  return routeFromOrsGeoJson(response, { requestedLengthM: requested, seed });
}

const closeTo = (actual, expected, tolerance, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value out of range') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual,
  );
};

// ---------------------------------------------------------------------------
// ratio and tolerance
// ---------------------------------------------------------------------------

test('correctionRatio: reports how badly the request was missed', () => {
  // The documented failure: ask for a half marathon, receive 38km.
  const route = routeFor({ requested: HALF_MARATHON_M, actual: 38000 });
  closeTo(correctionRatio(route), 38000 / HALF_MARATHON_M, 0.01);
  assert.ok(correctionRatio(route) > 1.7, 'should register as badly over');
});

test('correctionRatio: a faithful router scores 1', () => {
  const route = routeFor({ requested: 10000, actual: 10000 });
  closeTo(correctionRatio(route), 1, 0.005);
});

test('correctionRatio: guards against a missing request length', () => {
  assert.ok(Number.isNaN(correctionRatio({ actualLengthM: 100, requestedLengthM: 0 })));
  assert.ok(Number.isNaN(correctionRatio(null)));
});

test('isWithinTolerance: 5% is inclusive on both sides', () => {
  const target = 10000;

  assert.equal(isWithinTolerance(routeFor({ requested: target, actual: 9550 }), target), true);
  assert.equal(isWithinTolerance(routeFor({ requested: target, actual: 10450 }), target), true);

  assert.equal(isWithinTolerance(routeFor({ requested: target, actual: 9400 }), target), false);
  assert.equal(isWithinTolerance(routeFor({ requested: target, actual: 10600 }), target), false);
});

test('isWithinTolerance: honours a custom tolerance', () => {
  const route = routeFor({ requested: 10000, actual: 10800 });
  assert.equal(isWithinTolerance(route, 10000, 0.05), false);
  assert.equal(isWithinTolerance(route, 10000, 0.10), true);
});

// ---------------------------------------------------------------------------
// seeds
// ---------------------------------------------------------------------------

test('deriveSeed: deterministic, distinct and in range', () => {
  const seeds = Array.from({ length: 8 }, (_, i) => deriveSeed(1, i));

  assert.deepEqual(seeds, Array.from({ length: 8 }, (_, i) => deriveSeed(1, i)), 'not reproducible');
  assert.equal(new Set(seeds).size, seeds.length, 'seeds collided');

  for (const seed of seeds) {
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2147483647, 'seed out of range: ' + seed);
  }
});

test('deriveSeed: consecutive indices are spread far apart', () => {
  // Near-identical seeds would ask the router for four near-identical loops.
  const a = deriveSeed(1, 0);
  const b = deriveSeed(1, 1);
  assert.ok(Math.abs(a - b) > 1000, 'seeds too close together: ' + a + ' and ' + b);
});

test('groupBySeed: partitions attempts and preserves order within a seed', () => {
  const attempts = [
    routeFor({ seed: 7, requested: 21000, actual: 38000 }),
    routeFor({ seed: 9, requested: 21000, actual: 30000 }),
    routeFor({ seed: 7, requested: 12000, actual: 22000 }),
  ];

  const grouped = groupBySeed(attempts);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get(7).length, 2);
  assert.equal(grouped.get(7)[0].requestedLengthM, 21000, 'chronology lost');
  assert.equal(grouped.get(7)[1].requestedLengthM, 12000);
});

// ---------------------------------------------------------------------------
// the correction step itself
// ---------------------------------------------------------------------------

test('nextRequestLengthM: with no history, ask for exactly the target', () => {
  assert.equal(nextRequestLengthM({ targetM: HALF_MARATHON_M, history: [] }), HALF_MARATHON_M);
  assert.equal(nextRequestLengthM({ targetM: 5000, history: null }), 5000);
});

test('nextRequestLengthM: one observation scales by the observed error', () => {
  // Asked 21097, got 38000. Ratio 1.8014, so request target / ratio.
  const history = [{ requestedLengthM: HALF_MARATHON_M, actualLengthM: 38000 }];
  const next = nextRequestLengthM({ targetM: HALF_MARATHON_M, history });

  closeTo(next, HALF_MARATHON_M / (38000 / HALF_MARATHON_M), 1);
  closeTo(next, 11712.7, 1);
  assert.ok(next < HALF_MARATHON_M, 'an over-long result must shrink the request');
});

test('nextRequestLengthM: a short result grows the request', () => {
  const history = [{ requestedLengthM: 10000, actualLengthM: 8000 }];
  const next = nextRequestLengthM({ targetM: 10000, history });
  closeTo(next, 12500, 1);
});

test('nextRequestLengthM: two observations fit a power law', () => {
  // Fit A = c * R^k through (21097 -> 38000) and (15000 -> 26000):
  //   k    = ln(26000/38000) / ln(15000/21097) = 1.11284
  //   next = 15000 * (21097/26000)^(1/1.11284) = 12432
  const history = [
    { requestedLengthM: HALF_MARATHON_M, actualLengthM: 38000 },
    { requestedLengthM: 15000, actualLengthM: 26000 },
  ];

  closeTo(nextRequestLengthM({ targetM: HALF_MARATHON_M, history }), 12432, 2);
});

test('nextRequestLengthM: the fit differs from naive proportional scaling', () => {
  const history = [
    { requestedLengthM: HALF_MARATHON_M, actualLengthM: 38000 },
    { requestedLengthM: 15000, actualLengthM: 26000 },
  ];

  const fitted = nextRequestLengthM({ targetM: HALF_MARATHON_M, history });
  const proportional = 15000 / (26000 / HALF_MARATHON_M);

  assert.notEqual(Math.round(fitted), Math.round(proportional), 'curve information was discarded');
});

test('powerLawRequest: recovers a known exponent exactly', () => {
  // Construct two points from A = 0.5 * R^1.2 and check the solve inverts it.
  const f = (r) => 0.5 * Math.pow(r, 1.2);
  const p1 = { requestedLengthM: 10000, actualLengthM: f(10000) };
  const p2 = { requestedLengthM: 20000, actualLengthM: f(20000) };

  const target = f(15000);
  closeTo(powerLawRequest(p1, p2, target), 15000, 1, 'should invert the curve it was fitted to');
});

test('powerLawRequest: rejects degenerate inputs rather than returning nonsense', () => {
  const base = { requestedLengthM: 10000, actualLengthM: 12000 };

  assert.equal(powerLawRequest(base, { requestedLengthM: 10000, actualLengthM: 15000 }, 11000), null,
    'identical requests carry no slope');
  assert.equal(powerLawRequest(base, { requestedLengthM: 15000, actualLengthM: 12000 }, 11000), null,
    'identical results carry no slope');
  assert.equal(powerLawRequest(base, { requestedLengthM: 15000, actualLengthM: 9000 }, 11000), null,
    'more requested yielding less is noise');
  assert.equal(powerLawRequest(base, { requestedLengthM: 0, actualLengthM: 5000 }, 11000), null);
  assert.equal(powerLawRequest(null, base, 11000), null);
});

test('chooseReferencePoints: prefers points that bracket the target', () => {
  const target = 20000;
  const usable = [
    { requestedLengthM: 30000, actualLengthM: 44000 },
    { requestedLengthM: 9000, actualLengthM: 14000 },
    { requestedLengthM: 14000, actualLengthM: 22000 },
    { requestedLengthM: 12000, actualLengthM: 19000 },
  ];

  const [low, high] = chooseReferencePoints(usable, target);
  assert.equal(low.actualLengthM, 19000, 'closest result below the target');
  assert.equal(high.actualLengthM, 22000, 'closest result above the target');
});

test('chooseReferencePoints: with no bracket, takes the two nearest', () => {
  const target = 20000;
  const usable = [
    { requestedLengthM: 30000, actualLengthM: 60000 },
    { requestedLengthM: 20000, actualLengthM: 38000 },
    { requestedLengthM: 16000, actualLengthM: 30000 },
  ];

  const picked = chooseReferencePoints(usable, target).map((p) => p.actualLengthM).sort((a, b) => a - b);
  assert.deepEqual(picked, [30000, 38000]);
});

test('chooseReferencePoints: needs at least two points', () => {
  assert.equal(chooseReferencePoints([{ requestedLengthM: 1, actualLengthM: 1 }], 100), null);
  assert.equal(chooseReferencePoints([], 100), null);
});

test('globalPrior: with nothing learned, it is just the target', () => {
  closeTo(globalPrior({ targetM: 10000, attempts: [] }), 10000, 1);
});

test('globalPrior: a late seed starts from what other seeds revealed', () => {
  // Three seeds all came back roughly 80% over. A fresh seed should not begin
  // by asking for the full target again.
  const attempts = [
    routeFor({ seed: 1, requested: HALF_MARATHON_M, actual: 38000 }),
    routeFor({ seed: 2, requested: HALF_MARATHON_M, actual: 37000 }),
    routeFor({ seed: 3, requested: HALF_MARATHON_M, actual: 39000 }),
  ];

  const prior = globalPrior({ targetM: HALF_MARATHON_M, attempts });
  assert.ok(prior < HALF_MARATHON_M * 0.7, 'prior did not absorb the observed inflation: ' + prior);
  closeTo(prior, 12028, 400);
});

test('globalPrior: the median resists one wild outlier', () => {
  const attempts = [
    routeFor({ seed: 1, requested: 10000, actual: 10500 }),
    routeFor({ seed: 2, requested: 10000, actual: 10300 }),
    routeFor({ seed: 3, requested: 10000, actual: 90000 }), // nonsense
  ];

  const prior = globalPrior({ targetM: 10000, attempts });
  closeTo(prior, 9600, 400, 'the outlier should not drag the prior down');
});

test('nextRequestLengthM: a flat response falls back instead of dividing by zero', () => {
  // Two different requests, identical results: slope is zero.
  const history = [
    { requestedLengthM: 20000, actualLengthM: 30000 },
    { requestedLengthM: 15000, actualLengthM: 30000 },
  ];

  const next = nextRequestLengthM({ targetM: 10000, history });
  assert.ok(Number.isFinite(next), 'produced ' + next);
  closeTo(next, 15000 / (30000 / 10000), 1, 'should fall back to proportional scaling');
});

test('nextRequestLengthM: a repeated request falls back instead of dividing by zero', () => {
  const history = [
    { requestedLengthM: 15000, actualLengthM: 28000 },
    { requestedLengthM: 15000, actualLengthM: 30000 },
  ];
  assert.ok(Number.isFinite(nextRequestLengthM({ targetM: 10000, history })));
});

test('nextRequestLengthM: an inverted slope is treated as noise, not signal', () => {
  // Asking for less produced more. Extrapolating along that slope would send
  // the next request the wrong way entirely.
  const history = [
    { requestedLengthM: 20000, actualLengthM: 25000 },
    { requestedLengthM: 10000, actualLengthM: 30000 },
  ];

  const next = nextRequestLengthM({ targetM: 20000, history });
  assert.ok(next > 0 && Number.isFinite(next));
  closeTo(next, 10000 / (30000 / 20000), 1, 'should fall back to proportional scaling');
});

test('nextRequestLengthM: never requests an absurd multiple of the target', () => {
  // Router returned almost nothing; naive scaling would ask for 20x.
  const history = [{ requestedLengthM: 10000, actualLengthM: 100 }];
  const next = nextRequestLengthM({ targetM: 10000, history });

  assert.ok(next <= 10000 * DEFAULT_CORRECTION_OPTIONS.maxRequestFactor, 'clamp breached: ' + next);
});

test('nextRequestLengthM: never requests a uselessly small length', () => {
  const history = [{ requestedLengthM: 10000, actualLengthM: 900000 }];
  const next = nextRequestLengthM({ targetM: 10000, history });

  assert.ok(next >= 10000 * DEFAULT_CORRECTION_OPTIONS.minRequestFactor, 'clamp breached: ' + next);
  assert.ok(next >= DEFAULT_CORRECTION_OPTIONS.minRequestM);
});

test('nextRequestLengthM: ignores unusable history entries', () => {
  const history = [
    { requestedLengthM: 10000, actualLengthM: NaN },
    { requestedLengthM: 0, actualLengthM: 5000 },
    { requestedLengthM: 10000, actualLengthM: 12000 },
  ];
  closeTo(nextRequestLengthM({ targetM: 12000, history }), 10000, 1);
});

test('nextRequestLengthM: damping shortens the correction step', () => {
  const history = [{ requestedLengthM: 20000, actualLengthM: 40000 }];

  const full = nextRequestLengthM({ targetM: 20000, history, options: { damping: 1 } });
  const damped = nextRequestLengthM({ targetM: 20000, history, options: { damping: 0.5 } });

  closeTo(full, 10000, 1);
  closeTo(damped, 15000, 1, 'half way from 20000 to 10000');
});

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

test('rankByAccuracy: closest first, regardless of direction of error', () => {
  const target = 10000;
  const routes = [
    routeFor({ seed: 1, requested: target, actual: 11000 }), // +10%
    routeFor({ seed: 2, requested: target, actual: 9800 }),  //  -2%
    routeFor({ seed: 3, requested: target, actual: 10300 }), //  +3%
  ];

  assert.deepEqual(rankByAccuracy(routes, target).map((r) => r.seed), [2, 3, 1]);
});

test('rankByAccuracy: equal errors break on seed for a stable order', () => {
  const target = 10000;
  const routes = [
    routeFor({ seed: 5, requested: target, actual: 10500 }),
    routeFor({ seed: 2, requested: target, actual: 9500 }),
  ];
  assert.deepEqual(rankByAccuracy(routes, target).map((r) => r.seed), [2, 5]);
});

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

test('initialPlan: asks candidateCount seeds for the target length', () => {
  const plan = initialPlan({ targetM: HALF_MARATHON_M, baseSeed: 1 });

  assert.equal(plan.length, DEFAULT_CORRECTION_OPTIONS.candidateCount);
  assert.equal(new Set(plan.map((p) => p.seed)).size, plan.length, 'duplicate seeds');
  for (const request of plan) assert.equal(request.lengthM, HALF_MARATHON_M);
});

test('planCorrection: rejects a nonsensical target', () => {
  assert.throws(() => planCorrection({ targetM: 0 }), TypeError);
  assert.throws(() => planCorrection({ targetM: -5000 }), TypeError);
  assert.throws(() => planCorrection({ targetM: NaN }), TypeError);
});

test('planCorrection: with no attempts, requests a first round', () => {
  const plan = planCorrection({ targetM: HALF_MARATHON_M, attempts: [] });

  assert.equal(plan.status, 'retry');
  assert.equal(plan.roundsDone, 0);
  assert.equal(plan.nextRequests.length, DEFAULT_CORRECTION_OPTIONS.candidateCount);
});

test('planCorrection: stops once enough candidates qualify', () => {
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10100 }),
    routeFor({ seed: 2, requested: target, actual: 9900 }),
    routeFor({ seed: 3, requested: target, actual: 14000 }),
  ];

  const plan = planCorrection({ targetM: target, attempts });

  assert.equal(plan.status, 'satisfied');
  assert.equal(plan.accepted.length, 2, 'the 14km loop must not qualify');
  assert.equal(plan.nextRequests.length, 0, 'no further quota should be spent');
  assert.equal(plan.error, null);
});

test('planCorrection: accepted candidates come back closest-first', () => {
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10400 }),
    routeFor({ seed: 2, requested: target, actual: 10050 }),
  ];

  assert.deepEqual(planCorrection({ targetM: target, attempts }).accepted.map((r) => r.seed), [2, 1]);
});

test('planCorrection: one merely acceptable candidate is not enough to stop', () => {
  // 10400 is inside the 5% tolerance but outside the 2% excellent band, so
  // the run should keep looking for a second qualifying loop.
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10400 }),
    routeFor({ seed: 2, requested: target, actual: 15000 }),
  ];

  const plan = planCorrection({ targetM: target, attempts });

  assert.equal(plan.status, 'retry', 'minAccepted is 2, so keep looking');
  assert.equal(plan.accepted.length, 1, 'but the good one is retained meanwhile');
});

test('planCorrection: one excellent candidate ends the run immediately', () => {
  // Holding out for a second acceptable loop would spend twelve more requests
  // to improve on something already within 1% of target.
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10050 }),
    routeFor({ seed: 2, requested: target, actual: 15000 }),
  ];

  const plan = planCorrection({ targetM: target, attempts });

  assert.equal(plan.status, 'satisfied', 'a 0.5% loop is good enough to stop on');
  assert.equal(plan.nextRequests.length, 0, 'no further quota should be spent');
  assert.equal(plan.accepted.length, 1);
});

test('planCorrection: the excellent threshold is configurable', () => {
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10300 }),
    routeFor({ seed: 2, requested: target, actual: 15000 }),
  ];

  assert.equal(planCorrection({ targetM: target, attempts }).status, 'retry', '3% is not excellent by default');
  assert.equal(
    planCorrection({ targetM: target, attempts, options: { excellentTolerance: 0.04 } }).status,
    'satisfied',
    'a looser excellent band should stop on the same candidate',
  );
});

test('planCorrection: alternatives are offered even on a successful run', () => {
  // A single result with an empty alternatives list reads as though the app
  // found nothing else. Every seed's latest attempt comes back ranked.
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10050 }),
    routeFor({ seed: 2, requested: target, actual: 15000 }),
    routeFor({ seed: 3, requested: target, actual: 8000 }),
  ];

  const plan = planCorrection({ targetM: target, attempts });

  assert.equal(plan.status, 'satisfied');
  assert.equal(plan.accepted.length, 1, 'only one is within tolerance');
  assert.equal(plan.allCandidates.length, 3, 'but all three should be offered');
  assert.equal(plan.allCandidates[0].seed, 1, 'closest first');
});

test('planCorrection: a retry corrects the failing seed downward', () => {
  const attempts = [routeFor({ seed: 42, requested: HALF_MARATHON_M, actual: 38000 })];
  const plan = planCorrection({ targetM: HALF_MARATHON_M, attempts, baseSeed: 1 });

  assert.equal(plan.status, 'retry');

  const retry = plan.nextRequests.find((r) => r.seed === 42);
  assert.ok(retry, 'the failing seed should be retried, not discarded');
  assert.ok(
    retry.lengthM < HALF_MARATHON_M,
    'a 38km result must shrink the request, got ' + retry.lengthM,
  );
  closeTo(retry.lengthM, 11711, 200);
});

test('planCorrection: fresh seeds backfill the round to full width', () => {
  const attempts = [routeFor({ seed: 42, requested: HALF_MARATHON_M, actual: 38000 })];
  const plan = planCorrection({ targetM: HALF_MARATHON_M, attempts, baseSeed: 1 });

  assert.equal(plan.nextRequests.length, DEFAULT_CORRECTION_OPTIONS.candidateCount);
  assert.equal(
    new Set(plan.nextRequests.map((r) => r.seed)).size,
    plan.nextRequests.length,
    'a seed was requested twice in one round',
  );
});

test('planCorrection: a seed that keeps failing is retired', () => {
  const attempts = [
    routeFor({ seed: 42, requested: 21000, actual: 38000 }),
    routeFor({ seed: 42, requested: 12000, actual: 30000 }),
    routeFor({ seed: 42, requested: 8000, actual: 26000 }),
  ];

  const plan = planCorrection({
    targetM: HALF_MARATHON_M,
    attempts,
    options: { maxAttemptsPerSeed: 3, maxRounds: 5 },
  });

  assert.equal(plan.status, 'retry');
  assert.ok(
    !plan.nextRequests.some((r) => r.seed === 42),
    'seed 42 hit its attempt limit and should have been retired',
  );
  assert.ok(plan.nextRequests.length > 0, 'fresh seeds should replace it');
});

test('planCorrection: surfaces a usable error when nothing qualifies', () => {
  const target = HALF_MARATHON_M;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 38000 }),
    routeFor({ seed: 1, requested: 12000, actual: 26000 }),
    routeFor({ seed: 1, requested: 9000, actual: 24000 }),
    routeFor({ seed: 2, requested: target, actual: 35000 }),
    routeFor({ seed: 2, requested: 13000, actual: 27000 }),
    routeFor({ seed: 2, requested: 10000, actual: 23000 }),
  ];

  // Two seeds, three attempts each: exactly the budget for a 2-wide run.
  const plan = planCorrection({
    targetM: target,
    attempts,
    options: { maxRounds: 3, candidateCount: 2 },
  });

  assert.equal(plan.status, 'exhausted');
  assert.equal(plan.accepted.length, 0);
  assert.equal(plan.nextRequests.length, 0, 'must stop rather than burn quota forever');

  assert.equal(plan.error.code, 'NO_CANDIDATE_WITHIN_TOLERANCE');
  assert.match(plan.error.message, /21\.1km/, 'should name the target');
  assert.match(plan.error.message, /23\.00km/, 'should name the closest result');
  assert.match(plan.error.message, /\+9\.0%/, 'should quantify the miss');

  // The closest attempt is still handed back so the UI can offer it anyway.
  assert.equal(plan.error.detail.bestRoute.seed, 2);
  closeTo(plan.error.detail.bestErrorPct, 9.0, 0.3);
  assert.equal(plan.error.detail.candidates.length, 2, 'one representative per seed');
});

test('planCorrection: out of budget but holding a good candidate still succeeds', () => {
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 10200 }),
    routeFor({ seed: 2, requested: target, actual: 18000 }),
    routeFor({ seed: 2, requested: 6000, actual: 14000 }),
    routeFor({ seed: 2, requested: 4000, actual: 13000 }),
  ];

  const plan = planCorrection({
    targetM: target,
    attempts,
    options: { maxRounds: 2, candidateCount: 2 },
  });

  assert.equal(plan.status, 'satisfied', 'one qualifying loop beats reporting failure');
  assert.equal(plan.accepted.length, 1);
});

test('planCorrection: only the latest attempt per seed is judged', () => {
  // Seed 1 was hopeless at first and is fine now. The stale attempt must not
  // count as a separate candidate.
  const target = 10000;
  const attempts = [
    routeFor({ seed: 1, requested: target, actual: 19000 }),
    routeFor({ seed: 1, requested: 5200, actual: 10050 }),
  ];

  const plan = planCorrection({ targetM: target, attempts });
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.diagnostics.seedCount, 1);
});

test('planCorrection: diagnostics expose the per-seed error ratios', () => {
  const attempts = [routeFor({ seed: 42, requested: HALF_MARATHON_M, actual: 38000 })];
  const { diagnostics } = planCorrection({ targetM: HALF_MARATHON_M, attempts });

  assert.equal(diagnostics.attemptCount, 1);
  assert.equal(diagnostics.tolerance, 0.05);
  closeTo(diagnostics.ratios[0].ratio, 1.80, 0.02);
});

// ---------------------------------------------------------------------------
// closed-loop convergence, still with no network
// ---------------------------------------------------------------------------

test('convergence: a half marathon request that starts 80% over lands within 5%', () => {
  const target = HALF_MARATHON_M;
  const deliver = makeFakeRouter();
  const attempts = [];

  // Confirm the simulated router really does reproduce the failure.
  const naive = deliver(target, 1);
  assert.ok(naive > 35000, 'fixture router should inflate 21km to ~38km, gave ' + naive);

  let requests = initialPlan({ targetM: target, baseSeed: 1 });
  let plan = null;

  for (let round = 0; round < DEFAULT_CORRECTION_OPTIONS.maxRounds; round += 1) {
    for (const request of requests) {
      attempts.push(
        routeFor({ seed: request.seed, requested: request.lengthM, actual: deliver(request.lengthM, request.seed) }),
      );
    }

    plan = planCorrection({ targetM: target, attempts, baseSeed: 1 });
    if (plan.status !== 'retry') break;
    requests = plan.nextRequests;
  }

  assert.equal(plan.status, 'satisfied', plan.error ? plan.error.message : 'did not converge');

  for (const route of plan.accepted) {
    const errorPct = Math.abs((route.actualLengthM - target) / target) * 100;
    assert.ok(errorPct <= 5, 'accepted a candidate ' + errorPct.toFixed(1) + '% off target');
  }
});

test('convergence: holds across marathon-training distances', () => {
  const deliver = makeFakeRouter();

  for (const target of [5000, 10000, 16000, HALF_MARATHON_M, 32000, 42195]) {
    const attempts = [];
    let requests = initialPlan({ targetM: target, baseSeed: 7 });
    let plan = null;

    for (let round = 0; round < DEFAULT_CORRECTION_OPTIONS.maxRounds; round += 1) {
      for (const request of requests) {
        attempts.push(
          routeFor({
            seed: request.seed,
            requested: request.lengthM,
            actual: deliver(request.lengthM, request.seed),
          }),
        );
      }
      plan = planCorrection({ targetM: target, attempts, baseSeed: 7 });
      if (plan.status !== 'retry') break;
      requests = plan.nextRequests;
    }

    assert.equal(
      plan.status,
      'satisfied',
      target / 1000 + 'km failed: ' + (plan.error ? plan.error.message : 'unknown'),
    );
  }
});

test('convergence: a router that cannot be corrected is reported, not looped on', () => {
  // Always returns double, whatever is asked. Correction cannot help, and the
  // clamp stops the request running away.
  const deliver = (requested) => requested * 2 + 20000;
  const target = 10000;
  const attempts = [];

  let requests = initialPlan({ targetM: target, baseSeed: 3 });
  let plan = null;
  let rounds = 0;

  for (let round = 0; round < 10; round += 1) {
    rounds += 1;
    for (const request of requests) {
      attempts.push(
        routeFor({ seed: request.seed, requested: request.lengthM, actual: deliver(request.lengthM) }),
      );
    }
    plan = planCorrection({ targetM: target, attempts, baseSeed: 3 });
    if (plan.status !== 'retry') break;
    requests = plan.nextRequests;
  }

  assert.equal(plan.status, 'exhausted');
  assert.ok(rounds <= DEFAULT_CORRECTION_OPTIONS.maxRounds, 'looped ' + rounds + ' times');
  assert.equal(plan.error.code, 'NO_CANDIDATE_WITHIN_TOLERANCE');
  assert.ok(plan.error.detail.bestRoute, 'the closest attempt should still be offered');
});
