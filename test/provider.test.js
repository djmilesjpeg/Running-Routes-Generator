import test from 'node:test';
import assert from 'node:assert/strict';

import { RouteProvider, RouteProviderError, PROVIDER_ERRORS } from '../docs/js/providers/RouteProvider.js';
import { OrsProvider } from '../docs/js/providers/OrsProvider.js';
import { generateRoutes } from '../docs/js/app/generate.js';
import { makeOrsResponse, makeFakeRouter, PLACES } from './fixtures/synthetic.js';

/**
 * Every request in this file is served by a stub. Nothing here reaches the
 * network: the real fetch is replaced so an unstubbed call fails loudly
 * rather than spending live API quota during a test run.
 */
globalThis.fetch = () => {
  throw new Error('provider tests must not perform real network calls');
};

const [LON, LAT] = PLACES.harbourCity;
const noSleep = () => Promise.resolve();

/** A stub that records calls and replies with whatever the script says. */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body, headers: init.headers });
    return handler({ url, init, body, call: calls.length });
  };
  return { fetchImpl, calls };
}

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

// ---------------------------------------------------------------------------
// the interface contract
// ---------------------------------------------------------------------------

test('RouteProvider: the base class refuses to pretend it can route', () => {
  class Incomplete extends RouteProvider {}
  assert.rejects(
    () => new Incomplete().generateCandidates({}),
    /must implement generateCandidates/,
  );
});

test('RouteProvider: validation rejects out-of-range input', () => {
  const valid = { lat: LAT, lon: LON, distanceM: 10000, seed: 1 };

  assert.doesNotThrow(() => RouteProvider.validateRequest(valid));

  assert.throws(() => RouteProvider.validateRequest({ ...valid, lat: 91 }), RouteProviderError);
  assert.throws(() => RouteProvider.validateRequest({ ...valid, lon: 181 }), RouteProviderError);
  assert.throws(() => RouteProvider.validateRequest({ ...valid, distanceM: 0 }), RouteProviderError);
  assert.throws(() => RouteProvider.validateRequest({ ...valid, seed: 1.5 }), RouteProviderError);
  assert.throws(() => RouteProvider.validateRequest({ ...valid, lat: NaN }), RouteProviderError);
});

test('RouteProvider: validation messages never contain the coordinates', () => {
  try {
    RouteProvider.validateRequest({ lat: LAT, lon: LON, distanceM: -1, seed: 1 });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(!error.message.includes(String(LAT)), 'latitude leaked into an error message');
    assert.ok(!error.message.includes(String(LON)), 'longitude leaked into an error message');
  }
});

// ---------------------------------------------------------------------------
// the ORS request
// ---------------------------------------------------------------------------

test('OrsProvider: asks the geojson endpoint for a round trip with elevation', async () => {
  const { fetchImpl, calls } = stubFetch(({ body }) =>
    jsonResponse(
      makeOrsResponse({
        requestedLengthM: body.options.round_trip.length,
        actualLengthM: 10200,
        seed: body.options.round_trip.seed,
      }),
    ),
  );

  const provider = new OrsProvider({ apiKey: 'test-key', fetchImpl, sleepImpl: noSleep });
  const [route] = await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 10000, seed: 42 });

  const [call] = calls;
  assert.match(call.url, /\/v2\/directions\/foot-walking\/geojson$/, 'wrong endpoint');
  assert.equal(call.init.method, 'POST');

  assert.equal(call.body.elevation, true, 'elevation is required for scoring and GPX');
  assert.equal(call.body.instructions, true, 'steps are required for tempo scoring');
  assert.deepEqual(call.body.coordinates, [[LON, LAT]], 'ORS takes [lon, lat]');
  assert.deepEqual(call.body.options.round_trip, { length: 10000, points: 5, seed: 42 });

  assert.equal(route.seed, 42);
  assert.equal(route.requestedLengthM, 10000);
  assert.ok(Math.abs(route.actualLengthM - 10200) < 40, 'measured from geometry');
});

test('OrsProvider: the key travels in a header, never in the URL', async () => {
  const { fetchImpl, calls } = stubFetch(({ body }) =>
    jsonResponse(makeOrsResponse({ requestedLengthM: body.options.round_trip.length, seed: 1 })),
  );

  const provider = new OrsProvider({ apiKey: 'super-secret-key', fetchImpl, sleepImpl: noSleep });
  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  const [call] = calls;
  assert.equal(call.headers.Authorization, 'super-secret-key');
  assert.ok(!call.url.includes('super-secret-key'), 'the key leaked into the URL');
  assert.ok(!call.url.includes('api_key'), 'a key query parameter was used');
  assert.ok(!call.url.includes('?'), 'no query string should be needed at all');
});

test('OrsProvider: refuses to make a request without a key', async () => {
  const provider = new OrsProvider({ apiKey: '', fetchImpl: () => assert.fail('should not fetch') });

  await assert.rejects(
    () => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }),
    (error) => error.code === PROVIDER_ERRORS.MISSING_KEY,
  );
});

test('OrsProvider: rounds the requested length to whole metres', async () => {
  const { fetchImpl, calls } = stubFetch(({ body }) =>
    jsonResponse(makeOrsResponse({ requestedLengthM: body.options.round_trip.length, seed: 1 })),
  );

  const provider = new OrsProvider({ apiKey: 'k', fetchImpl, sleepImpl: noSleep });
  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 12432.71828, seed: 1 });

  assert.equal(calls[0].body.options.round_trip.length, 12433);
});

// ---------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------

test('OrsProvider: maps HTTP failures onto actionable errors', async () => {
  const cases = [
    { status: 401, payload: {}, code: PROVIDER_ERRORS.INVALID_KEY, match: /rejected/ },
    { status: 403, payload: {}, code: PROVIDER_ERRORS.INVALID_KEY, match: /rejected/ },
    { status: 429, payload: {}, code: PROVIDER_ERRORS.RATE_LIMITED, match: /Wait a minute/ },
    { status: 404, payload: {}, code: PROVIDER_ERRORS.NO_ROUTE, match: /No loop/ },
    { status: 413, payload: {}, code: PROVIDER_ERRORS.NO_ROUTE, match: /too long/ },
    {
      status: 404,
      payload: { error: { code: 2010, message: 'Could not find routable point' } },
      code: PROVIDER_ERRORS.UNROUTABLE_START,
      match: /No footpath or road/,
    },
    { status: 500, payload: {}, code: PROVIDER_ERRORS.UNKNOWN, match: /HTTP 500/ },
  ];

  for (const testCase of cases) {
    const { fetchImpl } = stubFetch(() => jsonResponse(testCase.payload, testCase.status));
    const provider = new OrsProvider({ apiKey: 'k', fetchImpl, sleepImpl: noSleep });

    await assert.rejects(
      () => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }),
      (error) => {
        assert.equal(error.code, testCase.code, 'wrong code for HTTP ' + testCase.status);
        assert.match(error.message, testCase.match);
        return true;
      },
    );
  }
});

test('OrsProvider: a rate limit is marked retryable and a bad key is not', async () => {
  const check = async (status, expected) => {
    const { fetchImpl } = stubFetch(() => jsonResponse({}, status));
    const provider = new OrsProvider({ apiKey: 'k', fetchImpl, sleepImpl: noSleep });
    try {
      await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });
      assert.fail('should have thrown');
    } catch (error) {
      assert.equal(error.retryable, expected, 'retryable wrong for HTTP ' + status);
    }
  };

  await check(429, true);
  await check(401, false);
});

test('OrsProvider: a blocked request names the likely causes, not just the connection', async () => {
  // fetch rejects with a bare TypeError whichever of these it was, and the
  // browser withholds the reason on purpose. Saying "check your connection"
  // sends people to debug the one cause that is least likely on a machine
  // that is plainly online.
  const provider = new OrsProvider({
    apiKey: 'k',
    sleepImpl: noSleep,
    fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
  });

  await assert.rejects(
    () => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }),
    (error) => {
      assert.equal(error.code, PROVIDER_ERRORS.NETWORK);
      assert.equal(error.retryable, true);
      assert.match(error.message, /blocker/i, 'should name extensions as a cause');
      assert.match(error.message, /VPN|firewall/i, 'should name network filtering');
      assert.match(error.message, /offline/i, 'should still mention being offline');
      return true;
    },
  );
});

test('OrsProvider: an unreadable body is a bad response, not a crash', async () => {
  const provider = new OrsProvider({
    apiKey: 'k',
    sleepImpl: noSleep,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
  });

  await assert.rejects(
    () => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }),
    (error) => error.code === PROVIDER_ERRORS.BAD_RESPONSE,
  );
});

test('OrsProvider: a response with no geometry is a bad response', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ type: 'FeatureCollection', features: [] }));
  const provider = new OrsProvider({ apiKey: 'k', fetchImpl, sleepImpl: noSleep });

  await assert.rejects(
    () => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }),
    (error) => error.code === PROVIDER_ERRORS.BAD_RESPONSE,
  );
});

test('OrsProvider: an abort propagates rather than becoming a network error', async () => {
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const provider = new OrsProvider({ apiKey: 'k', sleepImpl: noSleep, fetchImpl: () => Promise.reject(abortError) });

  await assert.rejects(
    () => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }),
    (error) => error.name === 'AbortError',
  );
});

test('OrsProvider: a burst inside the rate limit is not delayed at all', async () => {
  // A whole correction run is ~16 requests against a 40/minute allowance.
  // Spacing those evenly would turn a couple of seconds into twenty for a
  // limit that is never reached, so nothing should wait here.
  const waits = [];
  const { fetchImpl } = stubFetch(({ body }) =>
    jsonResponse(makeOrsResponse({ requestedLengthM: body.options.round_trip.length, seed: 1 })),
  );

  const provider = new OrsProvider({
    apiKey: 'k',
    fetchImpl,
    sleepImpl: (ms) => { waits.push(ms); return Promise.resolve(); },
  });

  await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: i + 1 }),
    ),
  );

  assert.deepEqual(waits, [], 'a burst within the allowance should never sleep');
});

test('OrsProvider: the window throttles once it is genuinely full', async () => {
  const waits = [];
  let now = 1_000_000;

  const { fetchImpl } = stubFetch(({ body }) =>
    jsonResponse(makeOrsResponse({ requestedLengthM: body.options.round_trip.length, seed: 1 })),
  );

  const provider = new OrsProvider({
    apiKey: 'k',
    fetchImpl,
    requestsPerMinute: 3,
    nowImpl: () => now,
    sleepImpl: (ms) => { waits.push(ms); now += ms; return Promise.resolve(); },
  });

  for (let seed = 1; seed <= 3; seed += 1) {
    await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed });
  }
  assert.deepEqual(waits, [], 'the first three filled the window without waiting');

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 4 });

  assert.equal(waits.length, 1, 'the fourth request should have waited');
  assert.ok(waits[0] > 59_000 && waits[0] <= 61_000, 'waited ' + waits[0] + 'ms, expected about a minute');

  // The window has now rolled over, so the next request goes straight through.
  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 5 });
  assert.equal(waits.length, 1, 'a request after the window rolled over should not wait');
});

test('OrsProvider: a failed request does not stall the admission gate behind it', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return jsonResponse({}, 500);
    return jsonResponse(makeOrsResponse({ requestedLengthM: 5000, seed: 2 }));
  };

  const provider = new OrsProvider({ apiKey: 'k', fetchImpl, sleepImpl: noSleep });

  await assert.rejects(() => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }));

  const [route] = await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 2 });
  assert.ok(route, 'the admission gate deadlocked after a rejection');
});

test('OrsProvider: declares the attribution it requires', () => {
  const attribution = new OrsProvider({ apiKey: 'k' }).attribution;
  assert.ok(attribution.some((a) => /OpenStreetMap/.test(a.text)), 'ODbL attribution missing');
  assert.ok(attribution.every((a) => a.url.startsWith('https://')));
});

// ---------------------------------------------------------------------------
// the orchestrator
// ---------------------------------------------------------------------------

/** A provider backed by the simulated router, with no HTTP at all. */
function simulatedProvider({ deliver = makeFakeRouter(), failFor = () => null } = {}) {
  const requests = [];
  return {
    requests,
    async generateCandidates({ distanceM, seed }) {
      requests.push({ distanceM, seed });

      const failure = failFor({ distanceM, seed, call: requests.length });
      if (failure) throw failure;

      const { routeFromOrsGeoJson } = await import('../docs/js/core/route.js');
      return [
        routeFromOrsGeoJson(
          makeOrsResponse({
            requestedLengthM: distanceM,
            actualLengthM: deliver(distanceM, seed),
            seed,
            pointCount: 24,
          }),
          { requestedLengthM: distanceM, seed },
        ),
      ];
    },
  };
}

test('generateRoutes: corrects a badly inflated half marathon and ranks the result', async () => {
  const provider = simulatedProvider();

  const result = await generateRoutes({
    provider,
    lat: LAT,
    lon: LON,
    targetM: 21097,
    runType: 'long',
    baseSeed: 7,
  });

  assert.equal(result.status, 'ok', result.error?.message);
  assert.ok(result.best, 'no best candidate returned');

  const errorPct = Math.abs((result.best.route.actualLengthM - 21097) / 21097) * 100;
  assert.ok(errorPct <= 5, 'best candidate is ' + errorPct.toFixed(1) + '% off target');

  assert.ok(provider.requests.length > 4, 'correction should have taken more than one round');
  assert.ok(provider.requests.length <= 16, 'exceeded the request budget');
});

test('generateRoutes: respects the run type when ranking', async () => {
  const provider = simulatedProvider({ deliver: (requested) => requested });

  const results = {};
  for (const runType of ['easy', 'hills']) {
    results[runType] = await generateRoutes({
      provider,
      lat: LAT,
      lon: LON,
      targetM: 10000,
      runType,
      baseSeed: 3,
    });
  }

  assert.equal(results.easy.status, 'ok');
  assert.equal(results.hills.status, 'ok');
  assert.ok(results.easy.ranked.length > 0);

  // Same candidate pool, opposite objectives, so the orderings must differ.
  assert.ok(
    results.easy.ranked[0].route.ascentM <= results.hills.ranked[0].route.ascentM,
    'easy should not pick a hillier loop than hills',
  );
});

test('generateRoutes: a bad key stops the run immediately', async () => {
  const provider = simulatedProvider({
    failFor: () => new RouteProviderError(PROVIDER_ERRORS.INVALID_KEY, 'key rejected'),
  });

  const result = await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 10000, runType: 'easy', baseSeed: 1,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, PROVIDER_ERRORS.INVALID_KEY);
  assert.equal(provider.requests.length, 4, 'should not retry past a fatal error');
});

test('generateRoutes: an unroutable start stops the run immediately', async () => {
  const provider = simulatedProvider({
    failFor: () => new RouteProviderError(PROVIDER_ERRORS.UNROUTABLE_START, 'nothing nearby'),
  });

  const result = await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 10000, runType: 'easy', baseSeed: 1,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, PROVIDER_ERRORS.UNROUTABLE_START);
});

test('generateRoutes: survives partial failures and reports them as warnings', async () => {
  // Every third request fails. The run should still produce routes.
  const provider = simulatedProvider({
    deliver: (requested) => requested,
    failFor: ({ call }) =>
      call % 3 === 0 ? new RouteProviderError(PROVIDER_ERRORS.NO_ROUTE, 'no loop for this seed') : null,
  });

  const result = await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 10000, runType: 'easy', baseSeed: 5,
  });

  assert.equal(result.status, 'ok', 'one failing seed should not sink the run');
  assert.ok(result.warnings.length > 0, 'the failure should be surfaced');
  assert.equal(result.warnings[0].code, PROVIDER_ERRORS.NO_ROUTE);
  assert.ok(result.best);
});

test('generateRoutes: surfaces the error and a near miss when nothing qualifies', async () => {
  // Always returns roughly double, whatever is asked, so correction cannot win.
  const provider = simulatedProvider({ deliver: (requested) => requested * 2 + 15000 });

  const result = await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 10000, runType: 'long', baseSeed: 1,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'NO_CANDIDATE_WITHIN_TOLERANCE');
  assert.match(result.error.message, /Closest was/, 'the message should quantify the miss');

  assert.ok(result.nearMisses.length > 0, 'the closest loops should still be offered');
  assert.ok(result.nearMisses[0].route.actualLengthM > 0);
  assert.ok(provider.requests.length <= 16, 'must not loop forever');
});

test('generateRoutes: reports progress through the phases', async () => {
  const phases = [];
  const provider = simulatedProvider();

  await generateRoutes({
    provider,
    lat: LAT,
    lon: LON,
    targetM: 21097,
    runType: 'easy',
    baseSeed: 7,
    onProgress: ({ phase }) => phases.push(phase),
  });

  assert.ok(phases.includes('requesting'));
  assert.ok(phases.includes('measuring'));
  assert.ok(phases.includes('correcting'), 'a corrected run should report the correction phase');
  assert.equal(phases[phases.length - 1], 'done');
});

test('generateRoutes: an abort propagates out of the run', async () => {
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const provider = simulatedProvider({ failFor: () => abortError });

  await assert.rejects(
    () => generateRoutes({ provider, lat: LAT, lon: LON, targetM: 10000, runType: 'easy', baseSeed: 1 }),
    (error) => error.name === 'AbortError',
  );
});

test('generateRoutes: the same base seed reproduces the same run', async () => {
  const run = async () => {
    const provider = simulatedProvider();
    const result = await generateRoutes({
      provider, lat: LAT, lon: LON, targetM: 16000, runType: 'long', baseSeed: 99,
    });
    return {
      seeds: provider.requests.map((r) => r.seed),
      best: result.best.route.actualLengthM,
    };
  };

  const first = await run();
  const second = await run();

  assert.deepEqual(first.seeds, second.seeds, 'seed sequence is not reproducible');
  assert.equal(first.best, second.best, 'the same inputs produced a different result');
});
