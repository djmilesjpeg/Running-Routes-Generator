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
import {
  RouteProvider,
  RouteProviderError,
  PROVIDER_ERRORS,
  ROUTE_STYLES,
  isRouteStyle,
} from './RouteProvider.js';

const DEFAULT_BASE_URL = 'https://api.openrouteservice.org';

/**
 * The free tier allows 40 directions requests per minute.
 *
 * A sliding window rather than a fixed gap between requests. The obvious
 * implementation - sleep 60/40 seconds between calls - makes every generation
 * feel broken: a correction run issues up to 16 requests, and spacing them
 * evenly turns a two-second job into twenty seconds of spinner for a limit
 * that was never going to be reached. This admits requests immediately until
 * the window is genuinely full, and only then waits for the oldest to expire.
 *
 * The margin below 40 covers clock skew and any request the app makes outside
 * a generation run.
 */
const REQUESTS_PER_MINUTE = 35;
const RATE_WINDOW_MS = 60000;

/**
 * How each neutral route style maps onto ORS.
 *
 * `quiet` and `green` are real ORS weightings (profile_params.weightings),
 * both 0..1. Quietness steers away from busy roads, which is the closest
 * available lever to "give me somewhere with a pavement" - ORS has no
 * sidewalk filter, because OpenStreetMap sidewalk tagging is too incomplete
 * to route on. avoid_features does not help here: for foot profiles it covers
 * ferries, fords and steps, not roads.
 *
 * These weightings depend on extended graph storages that a given ORS
 * deployment may not have built. If the request is rejected, the provider
 * retries once without them rather than failing the run - see
 * generateCandidates.
 */
const STYLE_TO_ORS = Object.freeze({
  quiet: { profile: 'foot-walking', weightings: { quiet: 1.0, green: 0.4 } },
  paths: { profile: 'foot-hiking', weightings: { green: 1.0, quiet: 0.6 } },
  direct: { profile: 'foot-walking', weightings: null },
});

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
   * @param {number} [options.requestsPerMinute]
   * @param {Function} [options.nowImpl]              injectable for tests
   */
  constructor({
    apiKey,
    profile = null,
    style = 'quiet',
    roundTripPoints = 5,
    fetchImpl = null,
    sleepImpl = null,
    baseUrl = DEFAULT_BASE_URL,
    requestsPerMinute = REQUESTS_PER_MINUTE,
    nowImpl = null,
  } = {}) {
    super();
    this.apiKey = apiKey;
    // An explicit profile overrides the style mapping, for callers that want
    // a specific ORS profile. Otherwise the style decides.
    this.profileOverride = profile;
    this.style = isRouteStyle(style) ? style : 'quiet';
    this.roundTripPoints = roundTripPoints;
    this.baseUrl = baseUrl;
    this.requestsPerMinute = requestsPerMinute;

    this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this._sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._now = nowImpl || (() => Date.now());

    // Admission control is serialised through this chain so concurrent callers
    // cannot both see a free slot and take it. The fetch itself runs outside
    // the chain, so requests still go out in parallel.
    this._gate = Promise.resolve();
    this._recent = [];
    this._weightingsUnsupported = false;
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
   * @param {{lat:number, lon:number, distanceM:number, seed:number,
   *          style?:string, signal?:AbortSignal}} request
   * @returns {Promise<Array>} Route objects
   */
  async generateCandidates({ lat, lon, distanceM, seed, style = null, signal = null }) {
    if (!this.apiKey) {
      throw new RouteProviderError(
        PROVIDER_ERRORS.MISSING_KEY,
        'No OpenRouteService API key. Add one to start generating routes.',
      );
    }

    RouteProvider.validateRequest({ lat, lon, distanceM, seed });

    const styleId = isRouteStyle(style) ? style : this.style;
    const mapping = STYLE_TO_ORS[styleId];
    const profile = this.profileOverride || mapping.profile;

    const baseBody = {
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

    const weightedBody = mapping.weightings
      ? {
          ...baseBody,
          options: {
            ...baseBody.options,
            profile_params: { weightings: { ...mapping.weightings } },
          },
        }
      : baseBody;

    const path = '/v2/directions/' + encodeURIComponent(profile) + '/geojson';

    let geojson;
    try {
      geojson = await this._post(path, weightedBody, signal);
    } catch (cause) {
      // Quiet and green weightings need extended graph storages that a given
      // ORS deployment may not have built, and it answers 400 when they are
      // missing. Losing the preference is much better than losing the run, so
      // retry once unweighted and let the caller know the style did not apply.
      const rejectedWeightings =
        mapping.weightings && cause instanceof RouteProviderError && cause.status === 400;

      if (!rejectedWeightings) throw cause;

      this._weightingsUnsupported = true;
      geojson = await this._post(path, baseBody, signal);
    }

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

    // Record which style was actually delivered, so the UI can be honest when
    // a preference could not be applied.
    route.styleId = styleId;
    route.styleApplied = Boolean(mapping.weightings) && !this._weightingsUnsupported;

    return [route];
  }

  /**
   * True once a request has been rejected for its weightings, meaning this
   * deployment cannot honour the quiet and paths preferences.
   */
  get weightingsUnsupported() {
    return this._weightingsUnsupported === true;
  }

  /**
   * Rate-limited POST returning parsed JSON.
   * @private
   */
  async _post(path, body, signal) {
    await this._acquireSlot();

    const run = async () => {
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

        // A bare TypeError here has two very different causes with completely
        // different fixes, and the browser will not say which.
        //
        //   1. The request never got out - an extension, VPN or firewall.
        //   2. It got out and came back rejected, but ORS omits
        //      Access-Control-Allow-Origin on its 403, so the browser discards
        //      the response and reports it as a failure. That is what a bad
        //      key looks like from JavaScript: not "forbidden", just "failed".
        //
        // The second is far more common and was previously reported as a
        // connection problem, sending people to debug their network when the
        // actual fix was to re-enter their key. A no-cors probe separates
        // them: it completes opaquely whenever the host is genuinely
        // reachable, and fails when something is blocking traffic.
        throw await this._explainOpaqueFailure(cause);
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

    return run();
  }

  /**
   * Work out what a bare fetch TypeError actually meant, and return a typed
   * error that says something useful.
   *
   * The probe is a no-cors GET at the API root. no-cors cannot read the
   * response, which is the point: it completes opaquely for any reply at all,
   * so it succeeds exactly when the host is reachable and fails when traffic
   * is being blocked. That is the distinction the original error could not
   * make.
   *
   * @private
   * @returns {Promise<RouteProviderError>}
   */
  async _explainOpaqueFailure(cause) {
    let reachable = false;
    try {
      await this._fetch(this.baseUrl + '/', { method: 'GET', mode: 'no-cors' });
      reachable = true;
    } catch {
      reachable = false;
    }

    if (reachable) {
      return new RouteProviderError(
        PROVIDER_ERRORS.INVALID_KEY,
        'OpenRouteService rejected the request, which almost always means the ' +
          'API key is wrong, not yet active, or out of quota. The service does ' +
          'not send CORS headers on a rejection, so the browser cannot show the ' +
          'real reason. Clear the key and enter it again.',
        { cause, retryable: false },
      );
    }

    return new RouteProviderError(
      PROVIDER_ERRORS.NETWORK,
      'The browser could not reach OpenRouteService at all - the request was ' +
        'blocked before it left. The usual causes are an ad or privacy blocker, ' +
        'a VPN or firewall, or being offline.',
      { cause, retryable: true },
    );
  }

  /**
   * Take a slot in the rate window, waiting only if it is genuinely full.
   * @private
   */
  async _acquireSlot() {
    const admit = this._gate.then(async () => {
      const prune = (at) => {
        this._recent = this._recent.filter((t) => at - t < RATE_WINDOW_MS);
      };

      prune(this._now());

      if (this._recent.length >= this.requestsPerMinute) {
        // Wait for the oldest request to fall out of the window.
        const waitMs = RATE_WINDOW_MS - (this._now() - this._recent[0]) + 50;
        if (waitMs > 0) await this._sleep(waitMs);
        prune(this._now());
      }

      this._recent.push(this._now());
    });

    // Keep the chain alive even if a waiter rejects.
    this._gate = admit.then(
      () => undefined,
      () => undefined,
    );

    return admit;
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

    if (response.status === 400) {
      return new RouteProviderError(
        PROVIDER_ERRORS.BAD_REQUEST,
        orsMessage || 'The routing service rejected the request.',
        { status: 400 },
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
