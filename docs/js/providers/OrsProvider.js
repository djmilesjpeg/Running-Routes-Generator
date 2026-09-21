/**
 * OpenRouteService implementation of RouteProvider.
 *
 * THE ONLY FILE THAT KNOWS ORS EXISTS. Nothing above this layer references an
 * ORS URL, header, response shape or error code.
 *
 * GEOJSON, NOT THE GPX ENDPOINT
 * ORS can return GPX directly, and this deliberately does not use it:
 *   - its GPX is route-based (<rte>), and Strava wants a track;
 *   - GPX carries no structured step list, which all four run types score on.
 * Requesting GeoJSON gives elevation and steps as data, and core/gpx.js
 * serialises a correct track from that.
 *
 * PRIVACY
 * The key travels in the Authorization header, never in a query string, so it
 * cannot end up in a server log or a browser history entry. Coordinates are
 * never logged, and never appear in an error message.
 */

import { routeFromOrsGeoJson } from '../core/route.js';
import { RouteProvider, RouteProviderError, PROVIDER_ERRORS } from './RouteProvider.js';

const DEFAULT_BASE_URL = 'https://api.openrouteservice.org';

/**
 * The free tier allows 40 directions requests per minute. A full correction
 * run is up to 16 requests, so the ceiling is reachable if someone generates
 * twice in quick succession. Spacing requests is friendlier than absorbing a
 * 429 and retrying.
 */
const MIN_REQUEST_INTERVAL_MS = 1600;

export class OrsProvider extends RouteProvider {
  static get id() {
    return 'ors';
  }

  /**
   * @param {Object} options
   * @param {string} options.apiKey                  from localStorage, never from source
   * @param {string} [options.profile='foot-walking']
   * @param {number} [options.roundTripPoints=5]     waypoints around the loop
   * @param {Function} [options.fetchImpl]           injectable for tests
   * @param {Function} [options.sleepImpl]           injectable for tests
   * @param {string} [options.baseUrl]
   */
  constructor({
    apiKey,
    profile = 'foot-walking',
    roundTripPoints = 5,
    fetchImpl = null,
    sleepImpl = null,
    baseUrl = DEFAULT_BASE_URL,
    minRequestIntervalMs = MIN_REQUEST_INTERVAL_MS,
  } = {}) {
    super();
    this.apiKey = apiKey;
    this.profile = profile;
    this.roundTripPoints = roundTripPoints;
    this.baseUrl = baseUrl;
    this.minRequestIntervalMs = minRequestIntervalMs;

    this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this._sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    // Serialises requests through a promise chain so concurrent callers still
    // respect the interval.
    this._queue = Promise.resolve();
    this._lastRequestAt = 0;
  }

  get displayName() {
    return 'OpenRouteService';
  }

  get attribution() {
    return [
      { text: 'Routing by OpenRouteService', url: 'https://openrouteservice.org/' },
      { text: 'Map data © OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    ];
  }

  /**
   * One loop for one seed.
   *
   * Returns an array because the interface is plural and a provider may
   * legitimately return several alternatives for a single seed; ORS returns
   * one, so this is usually an array of one.
   *
   * @param {{lat:number, lon:number, distanceM:number, seed:number, signal?:AbortSignal}} request
   * @returns {Promise<Array>} Route objects
   */
  async generateCandidates({ lat, lon, distanceM, seed, signal = null }) {
    if (!this.apiKey) {
      throw new RouteProviderError(
        PROVIDER_ERRORS.MISSING_KEY,
        'No OpenRouteService API key. Add one to start generating routes.',
      );
    }

    RouteProvider.validateRequest({ lat, lon, distanceM, seed });

    const body = {
      // ORS takes [lon, lat]. A round trip needs exactly one coordinate.
      coordinates: [[lon, lat]],
      elevation: true,
      instructions: true,
      units: 'm',
      options: {
        round_trip: {
          length: Math.round(distanceM),
          points: this.roundTripPoints,
          seed,
        },
      },
    };

    const geojson = await this._post(
      '/v2/directions/' + encodeURIComponent(this.profile) + '/geojson',
      body,
      signal,
    );

    let route;
    try {
      route = routeFromOrsGeoJson(geojson, { requestedLengthM: distanceM, seed });
    } catch (cause) {
      throw new RouteProviderError(
        PROVIDER_ERRORS.BAD_RESPONSE,
        'The routing service returned a response this app could not read.',
        { cause },
      );
    }

    return [route];
  }

  /**
   * Rate-limited POST returning parsed JSON.
   * @private
   */
  async _post(path, body, signal) {
    const run = async () => {
      const waitMs = this.minRequestIntervalMs - (Date.now() - this._lastRequestAt);
      if (waitMs > 0) await this._sleep(waitMs);
      this._lastRequestAt = Date.now();

      let response;
      try {
        response = await this._fetch(this.baseUrl + path, {
          method: 'POST',
          headers: {
            // Key in a header, never a query string.
            Authorization: this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/geo+json, application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (cause) {
        if (cause && cause.name === 'AbortError') throw cause;
        throw new RouteProviderError(
          PROVIDER_ERRORS.NETWORK,
          'Could not reach the routing service. Check your connection.',
          { cause, retryable: true },
        );
      }

      if (!response.ok) throw await this._toError(response);

      try {
        return await response.json();
      } catch (cause) {
        throw new RouteProviderError(
          PROVIDER_ERRORS.BAD_RESPONSE,
          'The routing service returned a malformed response.',
          { cause },
        );
      }
    };

    // Chain onto the queue so parallel callers are spaced, and keep the chain
    // alive when a request rejects.
    const result = this._queue.then(run, run);
    this._queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Map an HTTP failure onto a typed error.
   *
   * ORS puts a numeric code in the body for routing failures; 2010 means no
   * routable way was found near the start point, which for this app almost
   * always means the runner is somewhere the pedestrian network does not
   * reach. That deserves its own message rather than a generic failure.
   *
   * @private
   */
  async _toError(response) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const orsCode = payload?.error?.code ?? null;
    const orsMessage = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;

    if (response.status === 401 || response.status === 403) {
      return new RouteProviderError(
        PROVIDER_ERRORS.INVALID_KEY,
        'That OpenRouteService key was rejected. Check it, or clear it and enter another.',
        { status: response.status },
      );
    }

    if (response.status === 429) {
      return new RouteProviderError(
        PROVIDER_ERRORS.RATE_LIMITED,
        'Too many requests to OpenRouteService. Wait a minute and try again.',
        { status: response.status, retryable: true },
      );
    }

    if (orsCode === 2010 || orsCode === 2009) {
      return new RouteProviderError(
        PROVIDER_ERRORS.UNROUTABLE_START,
        'No footpath or road was found near your start point. Move somewhere more connected and try again.',
        { status: response.status },
      );
    }

    if (response.status === 404 || orsCode === 2099) {
      return new RouteProviderError(
        PROVIDER_ERRORS.NO_ROUTE,
        'No loop could be built from here at that distance.',
        { status: response.status },
      );
    }

    if (response.status === 413) {
      return new RouteProviderError(
        PROVIDER_ERRORS.NO_ROUTE,
        'That distance is too long for the routing service to plan in one loop.',
        { status: response.status },
      );
    }

    return new RouteProviderError(
      PROVIDER_ERRORS.UNKNOWN,
      // orsMessage comes from the service and never contains the request body.
      orsMessage || 'Routing failed (HTTP ' + response.status + ').',
      { status: response.status },
    );
  }
}
