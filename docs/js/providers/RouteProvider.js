/**
 * The routing provider interface.
 *
 * THE CONTRACT
 * One method. Given a start point, a requested loop length and a seed, return
 * Route objects (see core/route.js).
 *
 *   generateCandidates({ lat, lon, distanceM, seed }) => Promise<Route[]>
 *
 * WHY THIS SEAM EXISTS
 * Everything above it - correction, scoring, GPX, UI - is written against the
 * Route shape and never against a provider. Adding Trail Router means writing
 * one new subclass and changing the single line that constructs the provider.
 * No scoring or UI code is touched.
 *
 * WHAT IMPLEMENTATIONS OWE THE CALLER
 *   - Return Routes whose `requestedLengthM` is what was asked for, and whose
 *     `actualLengthM` was MEASURED from the returned geometry. Never copy the
 *     provider's own reported distance into actualLengthM; that figure is the
 *     one that goes wrong, and correction depends on ground truth.
 *   - Request elevation. Scoring and GPX both need it.
 *   - Throw RouteProviderError, so the UI can distinguish a bad key from a
 *     rate limit from an unroutable start point.
 *   - Never log coordinates, and never place a key in a URL.
 */

/**
 * A typed provider failure.
 *
 * `code` is a stable string the UI switches on. `cause` keeps the original
 * error for debugging without forcing it into the user-facing message.
 */
export class RouteProviderError extends Error {
  constructor(code, message, { status = null, cause = null, retryable = false } = {}) {
    super(message);
    this.name = 'RouteProviderError';
    this.code = code;
    this.status = status;
    this.cause = cause;
    this.retryable = retryable;
  }
}

/**
 * Route styles, expressed in neutral terms.
 *
 * Providers translate these into their own profiles and weightings, so the UI
 * and the orchestrator never name a provider-specific profile.
 *
 * WHAT THESE CANNOT PROMISE
 * None of them guarantees a pavement. Footway and sidewalk tagging in
 * OpenStreetMap is incomplete almost everywhere, so a road can be routable on
 * foot simply because nobody has recorded whether it has a path beside it.
 * `quiet` biases hard away from busy roads and is the right default, but the
 * map is still worth a glance before setting off.
 */
export const ROUTE_STYLES = Object.freeze({
  quiet: {
    id: 'quiet',
    label: 'Quiet',
    hint: 'Avoids busy roads',
    description: 'Prefers residential streets and footpaths over main roads.',
  },
  paths: {
    id: 'paths',
    label: 'Paths',
    hint: 'Parks and trails',
    description: 'Prefers parks, trails and green space. Surfaces may be uneven.',
  },
  direct: {
    id: 'direct',
    label: 'Direct',
    hint: 'Shortest sensible',
    description: 'No preference applied. Can use main roads.',
  },
});

/** Route style ids in display order. The default is first. */
export const ROUTE_STYLE_IDS = Object.freeze(['quiet', 'paths', 'direct']);

/** @returns {boolean} */
export function isRouteStyle(id) {
  return Object.prototype.hasOwnProperty.call(ROUTE_STYLES, id);
}

/** Stable error codes. The UI maps these to advice. */
export const PROVIDER_ERRORS = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_KEY: 'INVALID_KEY',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  NO_ROUTE: 'NO_ROUTE',
  UNROUTABLE_START: 'UNROUTABLE_START',
  NETWORK: 'NETWORK',
  BAD_RESPONSE: 'BAD_RESPONSE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Base class. Subclass it and implement generateCandidates.
 *
 * @abstract
 */
export class RouteProvider {
  /** Short identifier used in cache keys and diagnostics. */
  static get id() {
    return 'abstract';
  }

  /** Human-readable name for the attribution line. */
  get displayName() {
    return 'Unknown provider';
  }

  /**
   * Attribution this provider requires, shown in the footer alongside the
   * OpenStreetMap notice. Data sourced from OSM must say so.
   * @returns {{text: string, url: string}[]}
   */
  get attribution() {
    return [];
  }

  /**
   * @param {Object} request
   * @param {number} request.lat
   * @param {number} request.lon
   * @param {number} request.distanceM requested loop length
   * @param {number} request.seed
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Array>} Route objects
   */
  // eslint-disable-next-line no-unused-vars
  async generateCandidates(request) {
    throw new Error(this.constructor.name + ' must implement generateCandidates()');
  }

  /**
   * Shared argument validation, so every provider rejects nonsense the same
   * way and none of them has to repeat these checks.
   *
   * Deliberately does not include the coordinates in any message: errors reach
   * logs and bug reports, and a start point is exactly what must not leak.
   */
  static validateRequest({ lat, lon, distanceM, seed }) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new RouteProviderError('BAD_REQUEST', 'Start latitude is out of range.');
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new RouteProviderError('BAD_REQUEST', 'Start longitude is out of range.');
    }
    if (!Number.isFinite(distanceM) || distanceM <= 0) {
      throw new RouteProviderError('BAD_REQUEST', 'Requested distance must be a positive number.');
    }
    if (!Number.isInteger(seed) || seed < 0) {
      throw new RouteProviderError('BAD_REQUEST', 'Seed must be a non-negative integer.');
    }
  }
}
