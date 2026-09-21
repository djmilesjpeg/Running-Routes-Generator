/**
 * Deterministic test fixtures.
 *
 * PRIVACY
 * Every coordinate here is fabricated. The primary location is an invented
 * point in Wellington, New Zealand - chosen for bug-finding rather than
 * realism, since it has a negative latitude and a longitude close enough to
 * the antimeridian to expose sign and wrap errors that a European or North
 * American fixture would hide. The edge-case locations are equally invented.
 * None of them correspond to anywhere the author has been, and no real route,
 * trace or saved location appears anywhere in this repository.
 *
 * Everything is generated from a seeded PRNG, so fixtures are reproducible
 * without committing recorded data.
 */

/** Invented anchor points. Chosen to stress different parts of the maths. */
export const PLACES = Object.freeze({
  /** Negative latitude, longitude near the antimeridian. The default. */
  harbourCity: [174.7731, -41.2902],
  /** High latitude: longitude degrees are ~44% of their equatorial length. */
  northern: [-21.9331, 64.1461],
  /** Near the equator, where a latitude sign error is invisible. */
  equatorial: [32.582, 0.0031],
  /** Straddles the 180th meridian. */
  antimeridian: [179.9921, -16.7014],
});

/** Mulberry32: small, fast, fully deterministic. */
export function prng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const METRES_PER_DEG_LAT = 111320;

/**
 * Build a closed loop of approximately `lengthM`, as [lon, lat, ele] points.
 *
 * The shape is a circle perturbed by a couple of harmonics so it reads like a
 * street loop rather than a perfect ring, then rescaled once so the MEASURED
 * polyline length matches the requested length closely. Rescaling matters:
 * a 64-point polygon inscribed in a circle is measurably shorter than the
 * circle itself, and tests asserting on distance would inherit that error.
 *
 * Elevation is a sine profile whose amplitude sets total ascent, so a fixture
 * can be given a known climb without recording one.
 */
export function makeLoopCoords({
  center = PLACES.harbourCity,
  lengthM = 10000,
  seed = 1,
  pointCount = 96,
  elevationBaseM = 40,
  elevationAmplitudeM = 0,
  elevationCycles = 2,
} = {}) {
  const random = prng(seed);
  const [centerLon, centerLat] = center;

  const wobbleA = 0.06 + random() * 0.1;
  const wobbleB = 0.03 + random() * 0.06;
  const phase = random() * Math.PI * 2;
  const lobes = 3 + Math.floor(random() * 3);

  const metresPerDegLon = METRES_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);

  const build = (radiusM) => {
    const points = [];
    for (let i = 0; i <= pointCount; i += 1) {
      const t = (i / pointCount) * Math.PI * 2;
      const r = radiusM * (1 + wobbleA * Math.sin(lobes * t + phase) + wobbleB * Math.cos(2 * t));

      const dxM = r * Math.cos(t);
      const dyM = r * Math.sin(t);

      let lon = centerLon + dxM / metresPerDegLon;
      const lat = centerLat + dyM / METRES_PER_DEG_LAT;

      // Wrap across the antimeridian the way real data does.
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;

      const ele =
        elevationBaseM +
        (elevationAmplitudeM / 2) * (1 - Math.cos(elevationCycles * t)) ;

      points.push([lon, lat, ele]);
    }
    // Close the loop exactly.
    points[points.length - 1] = [points[0][0], points[0][1], points[0][2]];
    return points;
  };

  // One rescale pass against the measured length.
  const nominalRadius = lengthM / (2 * Math.PI);
  const first = build(nominalRadius);
  const measured = measureLength(first);
  if (measured === 0) return first;

  return build(nominalRadius * (lengthM / measured));
}

/** Local length measurement, so fixtures never depend on the code under test. */
export function measureLength(coords) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dPhi = toRad(lat2 - lat1);
    const dLam = toRad(lon2 - lon1);
    const h =
      Math.sin(dPhi / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLam / 2) ** 2;
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return total;
}

/** ORS instruction type codes used by the fixtures. */
const STEP_TYPES = [0, 1, 4, 5, 6, 7, 12, 13];

/** Generate a plausible step list of a given size. */
export function makeSteps(count, seed = 1, totalDistanceM = 10000) {
  const random = prng(seed + 7919);
  const per = totalDistanceM / Math.max(1, count);
  return Array.from({ length: count }, (_, i) => ({
    distance: per,
    duration: per / 2.8,
    type: i === 0 ? 11 : i === count - 1 ? 10 : STEP_TYPES[Math.floor(random() * STEP_TYPES.length)],
    instruction: i === 0 ? 'Head out' : i === count - 1 ? 'Arrive at finish' : 'Turn',
    name: '-',
    way_points: [i, i + 1],
  }));
}

/**
 * A complete OpenRouteService GeoJSON directions response.
 *
 * `actualLengthM` is what the router DELIVERS and `requestedLengthM` is what
 * was asked for. Setting them independently is the whole point: it reproduces
 * the failure this project exists to correct.
 */
export function makeOrsResponse({
  center = PLACES.harbourCity,
  requestedLengthM = 10000,
  actualLengthM = null,
  seed = 1,
  stepCount = 40,
  ascentM = 60,
  descentM = null,
  pointCount = 96,
} = {}) {
  const delivered = actualLengthM ?? requestedLengthM;

  // Ascent over `elevationCycles` sine cycles of amplitude A is cycles * A.
  const cycles = 2;
  const coords = makeLoopCoords({
    center,
    lengthM: delivered,
    seed,
    pointCount,
    elevationAmplitudeM: ascentM / cycles,
    elevationCycles: cycles,
  });

  const measured = measureLength(coords);

  return {
    type: 'FeatureCollection',
    bbox: bboxOf(coords),
    features: [
      {
        type: 'Feature',
        bbox: bboxOf(coords),
        properties: {
          segments: [
            {
              distance: measured,
              duration: measured / 2.8,
              steps: makeSteps(stepCount, seed, measured),
              ascent: ascentM,
              descent: descentM ?? ascentM,
            },
          ],
          summary: { distance: measured, duration: measured / 2.8 },
          way_points: [0, coords.length - 1],
          ascent: ascentM,
          descent: descentM ?? ascentM,
        },
        geometry: { type: 'LineString', coordinates: coords },
      },
    ],
    metadata: {
      service: 'routing',
      query: {
        profile: 'foot-walking',
        options: { round_trip: { length: requestedLengthM, points: 5, seed } },
      },
    },
  };
}

function bboxOf(coords) {
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/**
 * A stand-in for the routing service that reproduces its distance behaviour.
 *
 * Accurate to within a few percent below ~8km, then inflating sharply: at a
 * 21km request this returns roughly 38km, which is the reported real-world
 * failure. Deterministic per seed, and entirely offline.
 *
 * @returns {(requestedLengthM: number, seed: number) => number} delivered metres
 */
export function makeFakeRouter({ kneeM = 8000, strength = 0.85, noise = 0.03 } = {}) {
  return function deliver(requestedLengthM, seed) {
    const random = prng(seed);
    const seedBias = 0.8 + random() * 0.5;          // per-seed behaviour
    const over = Math.max(0, requestedLengthM - kneeM);
    const inflation = 1 + (over / 12000) * strength * seedBias;
    const jitter = 1 + (random() - 0.5) * 2 * noise;
    return requestedLengthM * inflation * jitter;
  };
}
