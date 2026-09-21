/**
 * Geodesic primitives. Pure functions, no I/O, no DOM.
 *
 * COORDINATE ORDER: every function here takes GeoJSON order - [lon, lat] or
 * [lon, lat, elevation]. This matches what OpenRouteService returns, so no
 * axis swapping happens anywhere between the network layer and the maths.
 * Leaflet uses the opposite order; that flip happens once, in the UI layer.
 */

/** Mean Earth radius in metres (WGS84 mean radius, IUGG). */
export const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 *
 * Naturally correct across the antimeridian: the formula depends on
 * sin(delta-lon / 2), and sin is periodic, so a raw delta of -359.8 degrees
 * yields the same value as the true +0.2 degrees. No wrapping needed.
 *
 * @param {number[]} a [lon, lat, ...]
 * @param {number[]} b [lon, lat, ...]
 * @returns {number} metres
 */
export function haversineM(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);

  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);

  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;

  // clamp guards against floating-point h drifting just above 1 for
  // antipodal points, which would make asin return NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Total length of a polyline in metres.
 * @param {number[][]} coords array of [lon, lat, ...]
 * @returns {number} metres; 0 for fewer than two points
 */
export function polylineLengthM(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += haversineM(coords[i - 1], coords[i]);
  }
  return total;
}

/**
 * Running distance from the start at each vertex.
 * @param {number[][]} coords
 * @returns {number[]} same length as coords, first element 0
 */
export function cumulativeDistancesM(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  const out = [0];
  for (let i = 1; i < coords.length; i += 1) {
    out.push(out[i - 1] + haversineM(coords[i - 1], coords[i]));
  }
  return out;
}

/**
 * Total ascent and descent from the third element of each coordinate.
 *
 * `minDeltaM` suppresses sensor and SRTM sampling noise: without it, a flat
 * route accumulates hundreds of phantom metres from +-0.1m jitter. Deltas
 * below the threshold are carried forward rather than discarded, so a long
 * gradual climb still registers in full.
 *
 * @param {number[][]} coords array of [lon, lat, ele]
 * @param {number} [minDeltaM=1] noise floor in metres
 * @returns {{ascentM: number, descentM: number}}
 */
export function elevationDeltas(coords, minDeltaM = 1) {
  if (!Array.isArray(coords) || coords.length < 2) return { ascentM: 0, descentM: 0 };

  let ascentM = 0;
  let descentM = 0;
  let reference = coords[0][2];

  if (typeof reference !== 'number' || !Number.isFinite(reference)) {
    return { ascentM: 0, descentM: 0 };
  }

  for (let i = 1; i < coords.length; i += 1) {
    const ele = coords[i][2];
    if (typeof ele !== 'number' || !Number.isFinite(ele)) continue;

    const delta = ele - reference;
    if (Math.abs(delta) < minDeltaM) continue; // carry reference forward

    if (delta > 0) ascentM += delta;
    else descentM -= delta;
    reference = ele;
  }

  return { ascentM, descentM };
}

/**
 * Whether a polyline returns to where it started.
 * @param {number[][]} coords
 * @param {number} [toleranceM=50]
 */
export function isLoop(coords, toleranceM = 50) {
  if (!Array.isArray(coords) || coords.length < 3) return false;
  return haversineM(coords[0], coords[coords.length - 1]) <= toleranceM;
}

/**
 * Bounding box for map fitting.
 * @param {number[][]} coords
 * @returns {{minLon:number,minLat:number,maxLon:number,maxLat:number}|null}
 */
export function boundsOf(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}
