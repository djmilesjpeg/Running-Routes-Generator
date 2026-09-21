import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTE_STYLES,
  ROUTE_STYLE_IDS,
  isRouteStyle,
} from '../docs/js/providers/RouteProvider.js';
import { OrsProvider } from '../docs/js/providers/OrsProvider.js';
import { generateRoutes } from '../docs/js/app/generate.js';
import { routeFromOrsGeoJson } from '../docs/js/core/route.js';
import { makeOrsResponse, makeFakeRouter, PLACES } from './fixtures/synthetic.js';

globalThis.fetch = () => {
  throw new Error('style tests must not perform real network calls');
};

const [LON, LAT] = PLACES.harbourCity;
const noSleep = () => Promise.resolve();

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return handler({ url, body, call: calls.length });
  };
  return { fetchImpl, calls };
}

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const okRoute = ({ body }) =>
  jsonResponse(makeOrsResponse({ requestedLengthM: body.options.round_trip.length, seed: 1 }));

// ---------------------------------------------------------------------------
// the neutral vocabulary
// ---------------------------------------------------------------------------

test('ROUTE_STYLES: three styles, with the safest one first', () => {
  assert.deepEqual(ROUTE_STYLE_IDS, ['quiet', 'paths', 'direct']);
  assert.equal(ROUTE_STYLE_IDS[0], 'quiet', 'the default should avoid busy roads');

  for (const id of ROUTE_STYLE_IDS) {
    assert.ok(isRouteStyle(id));
    assert.ok(ROUTE_STYLES[id].label, id + ' has no label');
    assert.ok(ROUTE_STYLES[id].description, id + ' has no description');
  }

  assert.equal(isRouteStyle('motorway'), false);
  assert.equal(isRouteStyle('__proto__'), false);
});

test('ROUTE_STYLES: no style claims to guarantee a pavement', () => {
  // Overstating this would be a safety problem, not a copy problem: OSM
  // sidewalk tagging is too incomplete for any router to promise it.
  for (const id of ROUTE_STYLE_IDS) {
    const text = (ROUTE_STYLES[id].label + ' ' + ROUTE_STYLES[id].description).toLowerCase();
    assert.ok(!/\b(guarantee|always|never uses|safe)\b/.test(text), id + ' overpromises: ' + text);
  }
});

// ---------------------------------------------------------------------------
// translation to ORS
// ---------------------------------------------------------------------------

test('quiet: walking profile with quietness weighting', async () => {
  const { fetchImpl, calls } = stubFetch(okRoute);
  const provider = new OrsProvider({ apiKey: 'k', style: 'quiet', fetchImpl, sleepImpl: noSleep });

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  assert.match(calls[0].url, /foot-walking/);
  assert.deepEqual(calls[0].body.options.profile_params.weightings, { quiet: 1.0, green: 0.4 });
});

test('paths: hiking profile, weighted towards green space', async () => {
  const { fetchImpl, calls } = stubFetch(okRoute);
  const provider = new OrsProvider({ apiKey: 'k', style: 'paths', fetchImpl, sleepImpl: noSleep });

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  assert.match(calls[0].url, /foot-hiking/);
  assert.equal(calls[0].body.options.profile_params.weightings.green, 1.0);
});

test('direct: no weightings sent at all', async () => {
  const { fetchImpl, calls } = stubFetch(okRoute);
  const provider = new OrsProvider({ apiKey: 'k', style: 'direct', fetchImpl, sleepImpl: noSleep });

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  assert.equal(calls[0].body.options.profile_params, undefined);
  assert.match(calls[0].url, /foot-walking/);
});

test('a per-request style overrides the provider default', async () => {
  const { fetchImpl, calls } = stubFetch(okRoute);
  const provider = new OrsProvider({ apiKey: 'k', style: 'quiet', fetchImpl, sleepImpl: noSleep });

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1, style: 'direct' });

  assert.equal(calls[0].body.options.profile_params, undefined);
});

test('an unknown style falls back to the default rather than failing', async () => {
  const { fetchImpl, calls } = stubFetch(okRoute);
  const provider = new OrsProvider({ apiKey: 'k', style: 'nonsense', fetchImpl, sleepImpl: noSleep });

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  assert.ok(calls[0].body.options.profile_params, 'should have used the quiet default');
});

test('an explicit profile overrides the style mapping', async () => {
  const { fetchImpl, calls } = stubFetch(okRoute);
  const provider = new OrsProvider({
    apiKey: 'k', style: 'paths', profile: 'foot-walking', fetchImpl, sleepImpl: noSleep,
  });

  await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });
  assert.match(calls[0].url, /foot-walking/, 'the override should win over the hiking profile');
});

// ---------------------------------------------------------------------------
// the fallback that keeps a run alive
// ---------------------------------------------------------------------------

test('weightings rejected by the deployment fall back to an unweighted route', async () => {
  // quiet and green need extended graph storages a deployment may not have
  // built, and it answers 400. Losing the preference must not lose the run.
  let call = 0;
  const bodies = [];
  const fetchImpl = async (url, init) => {
    call += 1;
    bodies.push(JSON.parse(init.body));
    if (call === 1) return jsonResponse({ error: { message: 'unknown parameter' } }, 400);
    return jsonResponse(makeOrsResponse({ requestedLengthM: 5000, seed: 1 }));
  };

  const provider = new OrsProvider({ apiKey: 'k', style: 'quiet', fetchImpl, sleepImpl: noSleep });
  const [route] = await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  assert.equal(call, 2, 'should have retried exactly once');
  assert.ok(bodies[0].options.profile_params, 'first attempt carried the weightings');
  assert.equal(bodies[1].options.profile_params, undefined, 'the retry dropped them');

  assert.ok(route, 'a usable route should still come back');
  assert.equal(provider.weightingsUnsupported, true, 'the caller must be able to tell');
  assert.equal(route.styleApplied, false, 'the route must not claim a style it did not get');
});

test('a 400 with no weightings to drop is not retried', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return jsonResponse({ error: { message: 'bad request' } }, 400);
  };

  const provider = new OrsProvider({ apiKey: 'k', style: 'direct', fetchImpl, sleepImpl: noSleep });

  await assert.rejects(() => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }));
  assert.equal(call, 1, 'nothing to retry without, so one attempt only');
});

test('a non-400 failure is not retried either', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return jsonResponse({}, 500);
  };

  const provider = new OrsProvider({ apiKey: 'k', style: 'quiet', fetchImpl, sleepImpl: noSleep });

  await assert.rejects(() => provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 }));
  assert.equal(call, 1, 'a server error is not a weighting problem');
});

test('a route reports the style that was actually applied', async () => {
  const { fetchImpl } = stubFetch(okRoute);
  const provider = new OrsProvider({ apiKey: 'k', style: 'quiet', fetchImpl, sleepImpl: noSleep });

  const [route] = await provider.generateCandidates({ lat: LAT, lon: LON, distanceM: 5000, seed: 1 });

  assert.equal(route.styleId, 'quiet');
  assert.equal(route.styleApplied, true);
});

// ---------------------------------------------------------------------------
// the orchestrator
// ---------------------------------------------------------------------------

function simulatedProvider({ deliver = makeFakeRouter() } = {}) {
  const requests = [];
  return {
    requests,
    async generateCandidates({ distanceM, seed, style }) {
      requests.push({ distanceM, seed, style });
      return [
        routeFromOrsGeoJson(
          makeOrsResponse({
            requestedLengthM: distanceM,
            actualLengthM: deliver(distanceM, seed),
            seed,
            pointCount: 16,
          }),
          { requestedLengthM: distanceM, seed },
        ),
      ];
    },
  };
}

test('generateRoutes: the style reaches every request', async () => {
  const provider = simulatedProvider();

  await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 10000, runType: 'easy', baseSeed: 1, style: 'paths',
  });

  assert.ok(provider.requests.length > 0);
  assert.ok(provider.requests.every((r) => r.style === 'paths'), 'a request lost the style');
});

test('generateRoutes: progress carries counts the UI can show', async () => {
  // A spinner alone looks identical whether one request is outstanding or
  // sixteen, which is what makes a long run feel like a hang.
  const updates = [];
  const provider = simulatedProvider();

  await generateRoutes({
    provider,
    lat: LAT,
    lon: LON,
    targetM: 21097,
    runType: 'easy',
    baseSeed: 7,
    onProgress: (update) => updates.push(update),
  });

  const measuring = updates.find((u) => u.phase === 'measuring');
  assert.ok(measuring, 'no measuring update was reported');

  assert.ok(Number.isInteger(measuring.round) && measuring.round >= 1, 'round missing');
  assert.ok(Number.isInteger(measuring.maxRounds) && measuring.maxRounds >= 1, 'maxRounds missing');
  assert.ok(Number.isInteger(measuring.measured) && measuring.measured > 0, 'measured count missing');
  assert.ok(Number.isInteger(measuring.budget) && measuring.budget > 0, 'budget missing');
  assert.ok(Number.isInteger(measuring.accepted), 'accepted count missing');
});

test('generateRoutes: a successful run still offers the loops that missed', async () => {
  const provider = simulatedProvider();

  const result = await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 21097, runType: 'easy', baseSeed: 7,
  });

  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.nearMisses), 'nearMisses should always be present');

  for (const entry of result.nearMisses) {
    assert.ok(
      !result.ranked.some((r) => r.route.id === entry.route.id),
      'a candidate appeared in both lists',
    );
  }
});

test('generateRoutes: an excellent first round stops without spending the budget', async () => {
  // The complaint this fixes: it finds a good route and then appears to think
  // forever, hunting for a second one.
  const provider = simulatedProvider({ deliver: (requested) => requested });

  const result = await generateRoutes({
    provider, lat: LAT, lon: LON, targetM: 10000, runType: 'easy', baseSeed: 4,
  });

  assert.equal(result.status, 'ok');
  assert.equal(provider.requests.length, 4, 'should have stopped after one round of four');
});

test('generateRoutes: stopping is honoured even by a provider that ignores the signal', async () => {
  // Cancellation must not depend on the provider being well behaved. A cached
  // response, or an adapter that drops the signal, would otherwise let another
  // round start after the runner pressed stop.
  const controller = new AbortController();
  const provider = simulatedProvider();
  let rounds = 0;

  const ignoresSignal = {
    async generateCandidates(request) {
      rounds += 1;
      if (rounds === 1) controller.abort(); // aborted mid-first-round
      return provider.generateCandidates(request);
    },
  };

  await assert.rejects(
    () =>
      generateRoutes({
        provider: ignoresSignal,
        lat: LAT,
        lon: LON,
        targetM: 21097,
        runType: 'easy',
        baseSeed: 7,
        signal: controller.signal,
      }),
    (error) => error.name === 'AbortError',
  );

  assert.ok(rounds <= 4, 'should not have started another round, saw ' + rounds + ' requests');
});
