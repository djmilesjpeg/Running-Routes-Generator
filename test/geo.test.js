import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_RADIUS_M,
  haversineM,
  polylineLengthM,
  cumulativeDistancesM,
  elevationDeltas,
  isLoop,
  boundsOf,
} from '../docs/js/core/geo.js';

import { PLACES, makeLoopCoords, measureLength } from './fixtures/synthetic.js';

/** One degree of latitude, from the mean-radius sphere these functions assume. */
const ONE_DEG_LAT_M = (EARTH_RADIUS_M * Math.PI) / 180;

const closeTo = (actual, expected, tolerance, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    (message || 'value out of range') + ': expected ' + expected + ' +/- ' + tolerance + ', got ' + actual,
  );
};

test('haversineM: identical points measure zero', () => {
  assert.equal(haversineM([174.7731, -41.2902], [174.7731, -41.2902]), 0);
});

test('haversineM: one degree of latitude is the same everywhere', () => {
  // Meridians are great circles, so this holds at any longitude or latitude.
  closeTo(haversineM([0, 0], [0, 1]), ONE_DEG_LAT_M, 0.001, 'at the equator');
  closeTo(haversineM([174.7731, -41], [174.7731, -40]), ONE_DEG_LAT_M, 0.001, 'southern mid-latitude');
  closeTo(haversineM([-21.93, 64], [-21.93, 65]), ONE_DEG_LAT_M, 0.001, 'high north');
});

test('haversineM: longitude shrinks by cos(latitude)', () => {
  const atEquator = haversineM([0, 0], [1, 0]);

  for (const lat of [-41.2902, 0.0031, 64.1461]) {
    const here = haversineM([0, lat], [1, lat]);
    const expected = atEquator * Math.cos((lat * Math.PI) / 180);
    // Loose tolerance: the cosine relation is exact on a sphere only in the
    // limit, and a whole degree of separation is not that limit.
    closeTo(here, expected, expected * 0.0002, 'longitude scaling at ' + lat);
  }
});

test('haversineM: crossing the antimeridian is not measured the long way round', () => {
  // 179.99E to 179.99W is 0.02 degrees apart, not 359.98.
  const across = haversineM([179.99, 0], [-179.99, 0]);
  closeTo(across, 0.02 * ONE_DEG_LAT_M, 0.01, 'short way across 180');

  // The naive implementation would return half the planet here.
  assert.ok(across < 3000, 'expected a short hop, got ' + across + 'm');
});

test('haversineM: latitude sign is handled symmetrically', () => {
  const north = haversineM([174.7731, 41.0], [174.7731, 41.5]);
  const south = haversineM([174.7731, -41.0], [174.7731, -41.5]);
  closeTo(north, south, 0.001, 'hemispheres should mirror');
});

test('haversineM: antipodal points do not produce NaN', () => {
  // sqrt(h) can drift fractionally above 1 here; asin would then return NaN.
  const d = haversineM([0, 0], [180, 0]);
  assert.ok(Number.isFinite(d), 'expected a finite distance, got ' + d);
  closeTo(d, Math.PI * EARTH_RADIUS_M, 1, 'half the circumference');
});

test('polylineLengthM: degenerate inputs are zero, not errors', () => {
  assert.equal(polylineLengthM([]), 0);
  assert.equal(polylineLengthM([[174.7731, -41.2902]]), 0);
  assert.equal(polylineLengthM(null), 0);
  assert.equal(polylineLengthM(undefined), 0);
});

test('polylineLengthM: sums segments', () => {
  const coords = [
    [0, 0],
    [0, 1],
    [0, 2],
  ];
  closeTo(polylineLengthM(coords), 2 * ONE_DEG_LAT_M, 0.001);
});

test('polylineLengthM: agrees with the independent fixture measurement', () => {
  // The fixtures measure length with their own copy of the formula. If these
  // two ever disagree, one of them has drifted.
  const coords = makeLoopCoords({ lengthM: 12000, seed: 42 });
  closeTo(polylineLengthM(coords), measureLength(coords), 0.01);
});

test('polylineLengthM: a generated loop measures its requested length', () => {
  for (const lengthM of [3000, 10000, 21097, 42195]) {
    const coords = makeLoopCoords({ lengthM, seed: 7 });
    closeTo(polylineLengthM(coords), lengthM, lengthM * 0.001, lengthM + 'm loop');
  }
});

test('polylineLengthM: holds up at high latitude and across the antimeridian', () => {
  for (const [name, center] of Object.entries(PLACES)) {
    const coords = makeLoopCoords({ center, lengthM: 8000, seed: 3 });
    closeTo(polylineLengthM(coords), 8000, 40, 'loop at ' + name);
  }
});

test('cumulativeDistancesM: starts at zero and ends at total length', () => {
  const coords = makeLoopCoords({ lengthM: 5000, seed: 11 });
  const cumulative = cumulativeDistancesM(coords);

  assert.equal(cumulative.length, coords.length);
  assert.equal(cumulative[0], 0);
  closeTo(cumulative[cumulative.length - 1], polylineLengthM(coords), 0.001);
});

test('cumulativeDistancesM: never decreases', () => {
  const cumulative = cumulativeDistancesM(makeLoopCoords({ lengthM: 5000, seed: 12 }));
  for (let i = 1; i < cumulative.length; i += 1) {
    assert.ok(cumulative[i] >= cumulative[i - 1], 'decreased at index ' + i);
  }
});

test('elevationDeltas: a flat route climbs nothing', () => {
  const coords = [
    [0, 0, 100],
    [0, 0.01, 100],
    [0, 0.02, 100],
  ];
  assert.deepEqual(elevationDeltas(coords), { ascentM: 0, descentM: 0 });
});

test('elevationDeltas: separates ascent from descent', () => {
  const coords = [
    [0, 0, 100],
    [0, 0.01, 150],
    [0, 0.02, 120],
    [0, 0.03, 180],
  ];
  const { ascentM, descentM } = elevationDeltas(coords);
  assert.equal(ascentM, 110); // +50, +60
  assert.equal(descentM, 30); // -30
});

test('elevationDeltas: a closed loop returns to its starting elevation', () => {
  const coords = makeLoopCoords({ lengthM: 8000, seed: 5, elevationAmplitudeM: 40 });
  const { ascentM, descentM } = elevationDeltas(coords, 0.5);
  closeTo(ascentM, descentM, 1, 'what goes up must come down on a loop');
});

test('elevationDeltas: the noise floor suppresses sensor jitter', () => {
  // 200 points of +-0.3m jitter around a flat profile. Without a threshold
  // this accumulates tens of phantom metres of climb.
  const coords = Array.from({ length: 200 }, (_, i) => [
    0,
    i * 0.0001,
    100 + (i % 2 === 0 ? 0.3 : -0.3),
  ]);

  assert.equal(elevationDeltas(coords, 1).ascentM, 0, 'jitter should be filtered');
  assert.ok(elevationDeltas(coords, 0).ascentM > 50, 'unfiltered, jitter accumulates');
});

test('elevationDeltas: a gradual climb below the threshold is still counted', () => {
  // The threshold must not discard a real climb made of small steps, so the
  // reference point carries forward rather than resetting each vertex.
  const coords = Array.from({ length: 101 }, (_, i) => [0, i * 0.0001, 100 + i * 0.5]);

  const { ascentM } = elevationDeltas(coords, 1);
  closeTo(ascentM, 50, 1, '100 steps of 0.5m is a real 50m climb');
});

test('elevationDeltas: missing or non-numeric elevations do not corrupt the total', () => {
  const coords = [
    [0, 0, 100],
    [0, 0.01, null],
    [0, 0.02, 150],
    [0, 0.03, undefined],
    [0, 0.04, 140],
  ];
  const { ascentM, descentM } = elevationDeltas(coords);
  assert.equal(ascentM, 50);
  assert.equal(descentM, 10);
});

test('elevationDeltas: no elevation data at all yields zero, not NaN', () => {
  const coords = [
    [0, 0],
    [0, 0.01],
  ];
  assert.deepEqual(elevationDeltas(coords), { ascentM: 0, descentM: 0 });
});

test('isLoop: recognises a closed loop and rejects an open path', () => {
  assert.equal(isLoop(makeLoopCoords({ lengthM: 5000, seed: 2 })), true);

  const open = [
    [174.7731, -41.2902, 10],
    [174.79, -41.2902, 10],
    [174.81, -41.2902, 10],
  ];
  assert.equal(isLoop(open), false);
});

test('boundsOf: encloses every point', () => {
  const coords = makeLoopCoords({ lengthM: 5000, seed: 9 });
  const b = boundsOf(coords);

  for (const [lon, lat] of coords) {
    assert.ok(lon >= b.minLon && lon <= b.maxLon, 'longitude outside bounds');
    assert.ok(lat >= b.minLat && lat <= b.maxLat, 'latitude outside bounds');
  }
  assert.equal(boundsOf([]), null);
});
