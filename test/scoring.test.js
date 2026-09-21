import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_TYPES,
  RUN_TYPE_IDS,
  isRunType,
  normalise,
  routeStats,
  scoreCandidates,
  bestCandidate,
} from '../docs/js/core/scoring.js';

import { routeFromOrsGeoJson } from '../docs/js/core/route.js';
import { makeOrsResponse } from './fixtures/synthetic.js';

globalThis.fetch = () => {
  throw new Error('scoring tests must not perform network calls');
};

const TARGET = 10000;

function candidate({ seed, actual = TARGET, ascentM = 50, stepCount = 40 }) {
  return routeFromOrsGeoJson(
    makeOrsResponse({
      requestedLengthM: TARGET,
      actualLengthM: actual,
      seed,
      ascentM,
      stepCount,
      pointCount: 32,
    }),
    { requestedLengthM: TARGET, seed },
  );
}

/**
 * Four candidates that disagree on every axis, so each run type has a clearly
 * correct and clearly different answer. If two run types ever pick the same
 * route here, one of them is not reading its own metric.
 *
 *   seed 1  flattest        20m ascent, 60 steps, +4.0% long
 *   seed 2  fewest turns    90m ascent, 12 steps, +3.0% long
 *   seed 3  most climbing  400m ascent, 55 steps, -2.0% long
 *   seed 4  most accurate  120m ascent, 48 steps, +0.1% long
 */
const SPREAD = () => [
  candidate({ seed: 1, ascentM: 20, stepCount: 60, actual: 10400 }),
  candidate({ seed: 2, ascentM: 90, stepCount: 12, actual: 10300 }),
  candidate({ seed: 3, ascentM: 400, stepCount: 55, actual: 9800 }),
  candidate({ seed: 4, ascentM: 120, stepCount: 48, actual: 10010 }),
];

test('RUN_TYPES: the four types are declared and ordered', () => {
  assert.deepEqual(RUN_TYPE_IDS, ['easy', 'tempo', 'long', 'hills']);
  for (const id of RUN_TYPE_IDS) {
    assert.ok(isRunType(id), id + ' missing');
    assert.equal(RUN_TYPES[id].id, id);
    assert.ok(RUN_TYPES[id].label && RUN_TYPES[id].description);
    assert.ok(['min', 'max'].includes(RUN_TYPES[id].direction));
  }
  assert.equal(isRunType('sprint'), false);
  assert.equal(isRunType('__proto__'), false, 'prototype keys must not pass as run types');
});

test('normalise: maps best to 1 whichever direction is optimised', () => {
  assert.deepEqual(normalise([10, 20, 30], 'min'), [1, 0.5, 0]);
  assert.deepEqual(normalise([10, 20, 30], 'max'), [0, 0.5, 1]);
});

test('normalise: an identical spread scores everyone 1, not NaN', () => {
  assert.deepEqual(normalise([7, 7, 7], 'min'), [1, 1, 1]);
  assert.deepEqual(normalise([7, 7, 7], 'max'), [1, 1, 1]);
});

test('normalise: non-finite values score 0 rather than poisoning the range', () => {
  const scores = normalise([10, NaN, 30], 'min');
  assert.equal(scores[0], 1);
  assert.equal(scores[1], 0);
  assert.equal(scores[2], 0);
  assert.ok(scores.every(Number.isFinite));
});

test('easy: picks the flattest loop', () => {
  const ranked = scoreCandidates(SPREAD(), 'easy', { targetM: TARGET });
  assert.equal(ranked[0].route.seed, 1, 'seed 1 has the least ascent');
  assert.equal(ranked[0].score, 1);
  assert.equal(ranked[ranked.length - 1].route.seed, 3, 'the hilliest must rank last');
});

test('tempo: picks the loop with fewest steps', () => {
  const ranked = scoreCandidates(SPREAD(), 'tempo', { targetM: TARGET });
  assert.equal(ranked[0].route.seed, 2, 'seed 2 has 12 steps');
  assert.equal(ranked[ranked.length - 1].route.seed, 1, 'seed 1 has 60 steps');
});

test('long: picks the most accurate loop and ignores terrain', () => {
  const ranked = scoreCandidates(SPREAD(), 'long', { targetM: TARGET });
  assert.equal(ranked[0].route.seed, 4, 'seed 4 is within 0.1%');

  // Terrain must not influence it: make the most accurate loop brutally hilly.
  const skewed = SPREAD();
  skewed[3] = candidate({ seed: 4, ascentM: 2000, stepCount: 48, actual: 10010 });
  assert.equal(
    scoreCandidates(skewed, 'long', { targetM: TARGET })[0].route.seed,
    4,
    'long must ignore ascent entirely',
  );
});

test('hills: picks the loop with most climbing', () => {
  const ranked = scoreCandidates(SPREAD(), 'hills', { targetM: TARGET });
  assert.equal(ranked[0].route.seed, 3, 'seed 3 climbs 400m');
  assert.equal(ranked[ranked.length - 1].route.seed, 1, 'the flattest must rank last');
});

test('easy and hills are exact opposites', () => {
  const easy = scoreCandidates(SPREAD(), 'easy', { targetM: TARGET }).map((e) => e.route.seed);
  const hills = scoreCandidates(SPREAD(), 'hills', { targetM: TARGET }).map((e) => e.route.seed);
  assert.deepEqual(easy, [...hills].reverse());
});

test('the four run types genuinely disagree', () => {
  // If two types pick the same candidate from this spread, one is not
  // consulting its own metric.
  const picks = RUN_TYPE_IDS.map((id) => bestCandidate(SPREAD(), id, { targetM: TARGET }).route.seed);
  assert.deepEqual(picks, [1, 2, 4, 3]);
  assert.equal(new Set(picks).size, 4, 'run types collapsed onto the same choice');
});

test('scoring re-ranks without re-routing', () => {
  // Same candidate objects, four orderings. Nothing here can perform a
  // request: the fetch stub above would throw.
  const candidates = SPREAD();
  const orders = RUN_TYPE_IDS.map((id) =>
    scoreCandidates(candidates, id, { targetM: TARGET }).map((e) => e.route.seed).join(','),
  );
  assert.equal(new Set(orders).size, 4, 'expected four distinct orderings');
});

test('ranks are dense and start at 1', () => {
  const ranked = scoreCandidates(SPREAD(), 'easy', { targetM: TARGET });
  assert.deepEqual(ranked.map((e) => e.rank), [1, 2, 3, 4]);
});

test('ties break deterministically', () => {
  // A total tie needs identical geometry: two different fixture seeds produce
  // marginally different lengths, and accuracy would separate them first.
  // Same route, two seed labels, so only the seed can decide.
  const base = candidate({ seed: 3, ascentM: 100, stepCount: 30, actual: 10200 });
  const tied = [
    { ...base, seed: 9 },
    { ...base, seed: 3 },
  ];

  const first = scoreCandidates(tied, 'easy', { targetM: TARGET }).map((e) => e.route.seed);
  const second = scoreCandidates([...tied].reverse(), 'easy', { targetM: TARGET }).map((e) => e.route.seed);

  assert.deepEqual(first, [3, 9]);
  assert.deepEqual(first, second, 'ordering must not depend on input order');
});

test('accuracy breaks ties within a run type', () => {
  // Equal ascent, so easy cannot separate them; the closer loop should win.
  const tied = [
    candidate({ seed: 1, ascentM: 100, stepCount: 30, actual: 10400 }),
    candidate({ seed: 2, ascentM: 100, stepCount: 30, actual: 10020 }),
  ];
  assert.equal(scoreCandidates(tied, 'easy', { targetM: TARGET })[0].route.seed, 2);
});

test('scoreCandidates: rejects an unknown run type', () => {
  assert.throws(() => scoreCandidates(SPREAD(), 'sprint', { targetM: TARGET }), /unknown run type/);
});

test('scoreCandidates: an empty candidate list is empty, not an error', () => {
  assert.deepEqual(scoreCandidates([], 'easy', { targetM: TARGET }), []);
  assert.equal(bestCandidate([], 'easy', { targetM: TARGET }), null);
});

test('scoreCandidates: a single candidate scores 1 and ranks 1', () => {
  const only = scoreCandidates([candidate({ seed: 1 })], 'hills', { targetM: TARGET });
  assert.equal(only.length, 1);
  assert.equal(only[0].score, 1);
  assert.equal(only[0].rank, 1);
});

test('each entry carries a human-readable label', () => {
  const easy = scoreCandidates(SPREAD(), 'easy', { targetM: TARGET });
  assert.match(easy[0].label, /^\d+m up$/);

  const tempo = scoreCandidates(SPREAD(), 'tempo', { targetM: TARGET });
  assert.match(tempo[0].label, /^\d+ turns$/);

  const long = scoreCandidates(SPREAD(), 'long', { targetM: TARGET });
  assert.match(long[0].label, /^[+-]\d+\.\d%$/);
});

test('routeStats: derives per-kilometre figures', () => {
  const route = candidate({ seed: 1, ascentM: 200, stepCount: 50, actual: 10000 });
  const stats = routeStats(route, TARGET);

  assert.ok(Math.abs(stats.distanceKm - 10) < 0.05);
  assert.equal(stats.ascentM, 200);
  assert.ok(Math.abs(stats.ascentPerKm - 20) < 0.2);
  assert.ok(Math.abs(stats.stepsPerKm - 5) < 0.1);
  assert.ok(Math.abs(stats.errorPct) < 0.5);
  assert.equal(stats.isLoop, true);
});

test('routeStats: tolerates a missing target', () => {
  const stats = routeStats(candidate({ seed: 1 }), undefined);
  assert.equal(stats.errorPct, null);
  assert.ok(Number.isFinite(stats.ascentPerKm));
});
