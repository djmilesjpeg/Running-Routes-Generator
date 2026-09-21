import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeRoute,
  routeFromOrsGeoJson,
  lengthRatio,
  relativeError,
} from '../docs/js/core/route.js';

import { makeOrsResponse, makeLoopCoords, measureLength, PLACES } from './fixtures/synthetic.js';

globalThis.fetch = () => {
  throw new Error('route tests must not perform network calls');
};

const closeTo = (actual, expected, tolerance, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value out of range') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual,
  );
};

test('makeRoute: rejects geometry too short to be a route', () => {
  assert.throws(() => makeRoute({ coords: [], requestedLengthM: 1000, seed: 1 }), TypeError);
  assert.throws(() => makeRoute({ coords: [[174.7, -41.2, 5]], requestedLengthM: 1000, seed: 1 }), TypeError);
});

test('makeRoute: measures the geometry rather than trusting the claim', () => {
  // The provider claims 21097m while the geometry is plainly 38km. Trusting
  // the claim is exactly how the distance bug goes unnoticed.
  const coords = makeLoopCoords({ lengthM: 38000, seed: 3 });
  const route = makeRoute({
    coords,
    requestedLengthM: 21097,
    seed: 3,
    reportedLengthM: 21097,
  });

  closeTo(route.actualLengthM, 38000, 50, 'measured length');
  assert.equal(route.reportedLengthM, 21097, 'the claim is retained for comparison');
  assert.ok(route.actualLengthM > route.reportedLengthM * 1.7, 'the discrepancy must survive');
});

test('makeRoute: prefers provider elevation figures when supplied', () => {
  const coords = makeLoopCoords({ lengthM: 5000, seed: 4, elevationAmplitudeM: 30 });
  const route = makeRoute({ coords, requestedLengthM: 5000, seed: 4, ascentM: 123, descentM: 456 });

  assert.equal(route.ascentM, 123, 'the finer provider sample should win');
  assert.equal(route.descentM, 456);
});

test('makeRoute: falls back to computing elevation from the geometry', () => {
  const coords = makeLoopCoords({ lengthM: 5000, seed: 4, elevationAmplitudeM: 30, elevationCycles: 2 });
  const route = makeRoute({ coords, requestedLengthM: 5000, seed: 4 });

  // Two cycles of a 30m half-amplitude sine: roughly 60m of climb.
  closeTo(route.ascentM, 60, 6, 'computed ascent');
  assert.ok(route.ascentM > 0, 'a provider without elevation summaries must still score');
});

test('makeRoute: counts turns separately from steps', () => {
  const steps = [
    { type: 11 }, // depart
    { type: 0 },  // left
    { type: 1 },  // right
    { type: 6 },  // straight on
    { type: 7 },  // enter roundabout
    { type: 10 }, // arrive
  ];
  const route = makeRoute({
    coords: makeLoopCoords({ lengthM: 3000, seed: 1 }),
    requestedLengthM: 3000,
    seed: 1,
    steps,
  });

  assert.equal(route.stepCount, 6);
  assert.equal(route.turnCount, 3, 'depart, arrive and straight-on are not turns');
});

test('makeRoute: identifies a closed loop', () => {
  const route = makeRoute({
    coords: makeLoopCoords({ lengthM: 8000, seed: 6 }),
    requestedLengthM: 8000,
    seed: 6,
  });
  assert.equal(route.isLoop, true);
});

test('routeFromOrsGeoJson: parses a full response', () => {
  const response = makeOrsResponse({
    requestedLengthM: 10000,
    actualLengthM: 10400,
    seed: 12,
    ascentM: 85,
    stepCount: 33,
  });

  const route = routeFromOrsGeoJson(response, { requestedLengthM: 10000, seed: 12 });

  assert.equal(route.seed, 12);
  assert.equal(route.requestedLengthM, 10000);
  closeTo(route.actualLengthM, 10400, 30);
  assert.equal(route.ascentM, 85);
  assert.equal(route.stepCount, 33);
  assert.equal(route.coords.length, response.features[0].geometry.coordinates.length);
  assert.ok(route.id.length > 0);
});

test('routeFromOrsGeoJson: measurement is independent of the reported summary', () => {
  const response = makeOrsResponse({ requestedLengthM: 21097, actualLengthM: 38000, seed: 1 });

  // Corrupt the summary the way a provider bug would.
  response.features[0].properties.summary.distance = 21097;

  const route = routeFromOrsGeoJson(response, { requestedLengthM: 21097, seed: 1 });

  assert.equal(route.reportedLengthM, 21097);
  closeTo(route.actualLengthM, 38000, 60, 'the geometry is the ground truth');
});

test('routeFromOrsGeoJson: flattens steps across multiple segments', () => {
  const response = makeOrsResponse({ requestedLengthM: 10000, seed: 2, stepCount: 10 });
  const [segment] = response.features[0].properties.segments;
  response.features[0].properties.segments = [segment, { ...segment, ascent: 20, descent: 20 }];
  delete response.features[0].properties.ascent;
  delete response.features[0].properties.descent;

  const route = routeFromOrsGeoJson(response, { requestedLengthM: 10000, seed: 2 });

  assert.equal(route.stepCount, 20, 'steps from both segments');
  assert.ok(route.ascentM > 0, 'segment ascents should sum');
});

test('routeFromOrsGeoJson: degrades rather than throwing on a sparse response', () => {
  const response = makeOrsResponse({ requestedLengthM: 5000, seed: 1 });
  delete response.features[0].properties.segments;
  delete response.features[0].properties.ascent;
  delete response.features[0].properties.descent;
  delete response.features[0].properties.summary;

  const route = routeFromOrsGeoJson(response, { requestedLengthM: 5000, seed: 1 });

  assert.equal(route.stepCount, 0);
  assert.ok(Number.isFinite(route.actualLengthM), 'geometry alone is enough to be usable');
  assert.ok(Number.isFinite(route.ascentM), 'elevation falls back to the geometry');
  assert.equal(route.reportedLengthM, route.actualLengthM, 'no claim, so the measurement stands in');
});

test('routeFromOrsGeoJson: rejects a response with no route', () => {
  assert.throws(() => routeFromOrsGeoJson({ features: [] }, { requestedLengthM: 1, seed: 1 }), /no route feature/);
  assert.throws(() => routeFromOrsGeoJson({}, { requestedLengthM: 1, seed: 1 }), /no route feature/);
});

test('routeFromOrsGeoJson: rejects a response with unusable geometry', () => {
  const response = makeOrsResponse({ requestedLengthM: 5000, seed: 1 });
  response.features[0].geometry.coordinates = [[174.77, -41.29, 3]];

  assert.throws(
    () => routeFromOrsGeoJson(response, { requestedLengthM: 5000, seed: 1 }),
    /no usable geometry/,
  );
});

test('routeFromOrsGeoJson: works at every fixture location', () => {
  for (const [name, center] of Object.entries(PLACES)) {
    const response = makeOrsResponse({ center, requestedLengthM: 8000, actualLengthM: 8000, seed: 5 });
    const route = routeFromOrsGeoJson(response, { requestedLengthM: 8000, seed: 5 });

    closeTo(route.actualLengthM, 8000, 50, 'route at ' + name);
    assert.equal(route.isLoop, true, 'loop at ' + name);
  }
});

test('lengthRatio and relativeError agree on the direction of the miss', () => {
  const response = makeOrsResponse({ requestedLengthM: 21097, actualLengthM: 38000, seed: 1 });
  const route = routeFromOrsGeoJson(response, { requestedLengthM: 21097, seed: 1 });

  assert.ok(lengthRatio(route) > 1, 'delivered more than requested');
  assert.ok(relativeError(route, 21097) > 0, 'over target');
  closeTo(relativeError(route, 21097) * 100, 80.1, 1);

  assert.ok(Number.isNaN(relativeError(route, 0)), 'a zero target is not a ratio');
});

test('fixtures: the generator and the parser measure the same length', () => {
  const response = makeOrsResponse({ requestedLengthM: 12000, actualLengthM: 17500, seed: 8 });
  const route = routeFromOrsGeoJson(response, { requestedLengthM: 12000, seed: 8 });

  closeTo(route.actualLengthM, measureLength(response.features[0].geometry.coordinates), 0.01);
});
