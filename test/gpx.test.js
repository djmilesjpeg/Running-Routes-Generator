import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGpx,
  escapeXml,
  fillMissingElevations,
  assertNoTimestamps,
  defaultTrackName,
  gpxFilename,
} from '../docs/js/core/gpx.js';

import { routeFromOrsGeoJson } from '../docs/js/core/route.js';
import { makeOrsResponse, PLACES } from './fixtures/synthetic.js';

globalThis.fetch = () => {
  throw new Error('gpx tests must not perform network calls');
};

function routeOf({ lengthM = 10000, seed = 1, ascentM = 120, center = PLACES.harbourCity } = {}) {
  return routeFromOrsGeoJson(
    makeOrsResponse({ center, requestedLengthM: lengthM, actualLengthM: lengthM, seed, ascentM, pointCount: 40 }),
    { requestedLengthM: lengthM, seed },
  );
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// the three hard requirements
// ---------------------------------------------------------------------------

test('emits a track, never a route', () => {
  const gpx = buildGpx(routeOf());

  assert.ok(gpx.includes('<trk>'), 'missing <trk>');
  assert.ok(gpx.includes('<trkseg>'), 'missing <trkseg>');
  assert.ok(gpx.includes('<trkpt '), 'missing <trkpt>');

  // Strava treats <rte> as a navigation aid rather than a path.
  assert.ok(!gpx.includes('<rte>'), 'a <rte> element leaked in');
  assert.ok(!gpx.includes('<rtept'), 'an <rtept> element leaked in');
});

test('every single point carries an elevation', () => {
  const route = routeOf();
  const gpx = buildGpx(route);

  const points = countOf(gpx, '<trkpt ');
  const elevations = countOf(gpx, '<ele>');

  assert.equal(points, route.coords.length, 'lost points in serialisation');
  assert.equal(elevations, points, 'without <ele> on every point, Strava reports zero climb');
});

test('no timestamps anywhere, in any form', () => {
  const gpx = buildGpx(routeOf());

  assert.ok(!/<time[\s>]/i.test(gpx), '<time> element present');
  assert.ok(!/<\/time>/i.test(gpx), 'closing </time> present');
  assert.ok(!/\btime\s*=\s*"/i.test(gpx), 'time attribute present');

  // Metadata time is the easy one to add by reflex. It must not be there.
  assert.ok(!gpx.includes('<metadata><time>'), 'metadata timestamp present');
});

test('assertNoTimestamps: catches every form a timestamp could take', () => {
  const forms = [
    '<gpx><time>2026-09-21T06:00:00Z</time></gpx>',
    '<gpx><trkpt><TIME>2026-09-21T06:00:00Z</TIME></trkpt></gpx>',
    '<gpx><metadata time="2026-09-21T06:00:00Z"/></gpx>',
  ];

  for (const form of forms) {
    assert.throws(() => assertNoTimestamps(form), /plan, not a/, 'not caught: ' + form);
  }

  const clean = '<gpx><trkpt lat="1" lon="2"><ele>3</ele></trkpt></gpx>';
  assert.equal(assertNoTimestamps(clean), clean, 'a clean document should pass through');
});

test('a timestamp injected through the name cannot become a live element', () => {
  // Two independent defences: escaping turns the markup into text, and
  // assertNoTimestamps then inspects the finished document. Either alone
  // would be enough; the point is that neither is relied on exclusively.
  const gpx = buildGpx(routeOf(), { name: 'Morning run <time>2026-09-21T06:00:00Z</time>' });

  assert.ok(!/<time[\s>]/i.test(gpx), 'a live <time> element was produced');
  assert.ok(gpx.includes('&lt;time&gt;'), 'the injection should survive as inert text');
});

// ---------------------------------------------------------------------------
// elevation handling
// ---------------------------------------------------------------------------

test('fillMissingElevations: interpolates an interior gap', () => {
  const filled = fillMissingElevations([
    [0, 0, 100],
    [0, 1, null],
    [0, 2, null],
    [0, 3, 160],
  ]);

  assert.equal(filled[1][2], 120);
  assert.equal(filled[2][2], 140);
});

test('fillMissingElevations: extends the edges rather than zero-filling', () => {
  // A zero would read as sea level and wreck the climb total.
  const filled = fillMissingElevations([
    [0, 0, null],
    [0, 1, 50],
    [0, 2, null],
  ]);

  assert.equal(filled[0][2], 50, 'leading gap should take the first known value');
  assert.equal(filled[2][2], 50, 'trailing gap should take the last known value');
});

test('fillMissingElevations: leaves complete data untouched', () => {
  const coords = [
    [0, 0, 10],
    [0, 1, 20],
  ];
  assert.deepEqual(fillMissingElevations(coords), coords);
});

test('fillMissingElevations: reports total absence rather than inventing zeros', () => {
  const filled = fillMissingElevations([
    [0, 0],
    [0, 1],
  ]);
  assert.ok(filled.every((c) => c[2] === null));
});

test('buildGpx: refuses to write a file with no elevation at all', () => {
  // Silently emitting a flat track would import fine and show zero climb,
  // which is the failure this is meant to prevent.
  const route = routeOf();
  route.coords = route.coords.map(([lon, lat]) => [lon, lat]);

  assert.throws(() => buildGpx(route), /no elevation data/);
});

test('buildGpx: fills a partial elevation gap rather than refusing', () => {
  const route = routeOf();
  route.coords = route.coords.map(([lon, lat, ele], i) => (i % 3 === 0 ? [lon, lat] : [lon, lat, ele]));

  const gpx = buildGpx(route);
  assert.equal(countOf(gpx, '<ele>'), route.coords.length);
  assert.ok(!gpx.includes('<ele>0.0</ele>'), 'gaps should be interpolated, not zero-filled');
});

// ---------------------------------------------------------------------------
// document shape
// ---------------------------------------------------------------------------

test('buildGpx: declares GPX 1.1 and the correct namespace', () => {
  const gpx = buildGpx(routeOf());

  assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(gpx.includes('version="1.1"'));
  assert.ok(gpx.includes('xmlns="http://www.topografix.com/GPX/1/1"'));
  assert.ok(gpx.trimEnd().endsWith('</gpx>'));
});

test('buildGpx: carries OpenStreetMap attribution into the file', () => {
  const gpx = buildGpx(routeOf());
  assert.ok(gpx.includes('OpenStreetMap contributors'), 'ODbL requires attribution to travel with the data');
  assert.ok(gpx.includes('opendatacommons.org/licenses/odbl'));
});

test('buildGpx: coordinates are written at 7 decimal places', () => {
  const gpx = buildGpx(routeOf());
  const first = gpx.match(/<trkpt lat="(-?\d+\.\d+)" lon="(-?\d+\.\d+)">/);

  assert.ok(first, 'no trkpt found');
  assert.equal(first[1].split('.')[1].length, 7);
  assert.equal(first[2].split('.')[1].length, 7);
});

test('buildGpx: escapes XML metacharacters in the name', () => {
  const gpx = buildGpx(routeOf(), { name: 'Tom & Jerry <loop> "fast"' });

  assert.ok(gpx.includes('Tom &amp; Jerry &lt;loop&gt; &quot;fast&quot;'));
  assert.ok(!gpx.includes('<loop>'), 'raw markup leaked into the document');
});

test('buildGpx: rejects geometry too short to be a track', () => {
  assert.throws(() => buildGpx({ coords: [[1, 2, 3]] }), TypeError);
  assert.throws(() => buildGpx(null), TypeError);
});

test('buildGpx: handles every fixture location, including across the antimeridian', () => {
  for (const [name, center] of Object.entries(PLACES)) {
    const gpx = buildGpx(routeOf({ center }));
    assert.ok(gpx.includes('<trkpt '), 'no points at ' + name);

    for (const [, lat, lon] of gpx.matchAll(/<trkpt lat="(-?[\d.]+)" lon="(-?[\d.]+)"/g)) {
      assert.ok(Number(lat) >= -90 && Number(lat) <= 90, 'latitude out of range at ' + name);
      assert.ok(Number(lon) >= -180 && Number(lon) <= 180, 'longitude out of range at ' + name);
    }
  }
});

test('escapeXml: covers all five metacharacters', () => {
  assert.equal(escapeXml('<&>"\''), '&lt;&amp;&gt;&quot;&apos;');
  assert.equal(escapeXml('plain'), 'plain');
  assert.equal(escapeXml(42), '42');
});

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

test('defaultTrackName: distance and run type only, never a place', () => {
  const route = routeOf({ lengthM: 21097 });

  assert.equal(defaultTrackName(route), '21.1km loop');
  assert.equal(defaultTrackName(route, 'hills'), '21.1km hills loop');
});

test('gpxFilename: safe, descriptive, and free of coordinates', () => {
  const route = routeOf({ lengthM: 21097 });

  assert.equal(gpxFilename(route), 'loop_21-1km.gpx');
  assert.equal(gpxFilename(route, 'tempo'), 'loop_21-1km_tempo.gpx');
  assert.equal(gpxFilename(route, 'tempo', '2026-09-21'), 'loop_21-1km_tempo_2026-09-21.gpx');
});

test('gpxFilename: strips anything unsafe for a filesystem', () => {
  const route = routeOf({ lengthM: 10000 });
  const name = gpxFilename(route, '../../etc/passwd');

  assert.ok(!name.includes('/'), 'path separator survived: ' + name);
  assert.ok(!name.includes('..'), 'traversal survived: ' + name);
  assert.match(name, /^[a-zA-Z0-9_-]+\.gpx$/);
});

test('the GPX module cannot reach a clock', () => {
  // gpxFilename takes the date as a parameter precisely so nothing in this
  // module needs Date. If that ever changes, the no-timestamp guarantee stops
  // being structural and becomes a matter of remembering.
  const route = routeOf();
  assert.equal(gpxFilename(route), gpxFilename(route), 'output should not vary with time');
  assert.ok(!buildGpx(route).includes(String(new Date().getFullYear()) + '-'));
});
