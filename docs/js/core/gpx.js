/**
 * GPX serialisation. Pure: string in, string out.
 *
 * THREE RULES, ALL LEARNED THE HARD WAY
 *
 * 1. Tracks, not routes. Emit trk / trkseg / trkpt. Strava's importer treats
 *    a <rte> as a navigation aid rather than a path and can reject or flatten
 *    it. Routing APIs that export GPX directly tend to emit <rte>, which is
 *    the main reason this writer exists instead of passing their file through.
 *
 * 2. <ele> on every point. Without it Strava and Runna report zero elevation
 *    gain for the whole route. Gaps are interpolated rather than zero-filled,
 *    because a zero would read as sea level and wreck the climb total.
 *
 * 3. No <time>, anywhere. This is a plan, not a recorded run. A GPX carrying
 *    timestamps can be read as an activity, which would mean inventing a pace
 *    that was never run. Nothing in this module can produce a timestamp: there
 *    is no clock access here, and assertNoTimestamps() enforces it.
 */

const GPX_CREATOR = 'loop-route-generator';

/** Escape the five XML metacharacters. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Fill elevation gaps by linear interpolation between known points, extending
 * the nearest known value outward at either end.
 *
 * Zero-filling would be wrong in a way that is easy to miss: the file would
 * still import, and the climb total would quietly be nonsense.
 *
 * @param {number[][]} coords [lon, lat, ele?]
 * @returns {number[][]} coords with a finite elevation on every point
 */
export function fillMissingElevations(coords) {
  const known = coords.map((c) => (Number.isFinite(c[2]) ? c[2] : null));
  if (known.every((e) => e === null)) return coords.map((c) => [c[0], c[1], null]);

  const filled = known.slice();

  // Forward pass: interpolate interior gaps.
  let lastIndex = -1;
  for (let i = 0; i < filled.length; i += 1) {
    if (filled[i] === null) continue;
    if (lastIndex >= 0 && i - lastIndex > 1) {
      const span = i - lastIndex;
      const step = (filled[i] - filled[lastIndex]) / span;
      for (let j = 1; j < span; j += 1) filled[lastIndex + j] = filled[lastIndex] + step * j;
    }
    lastIndex = i;
  }

  // Extend the first and last known values over any leading or trailing gap.
  const firstKnown = filled.findIndex((e) => e !== null);
  for (let i = 0; i < firstKnown; i += 1) filled[i] = filled[firstKnown];

  let lastKnown = -1;
  for (let i = filled.length - 1; i >= 0; i -= 1) {
    if (filled[i] !== null) { lastKnown = i; break; }
  }
  for (let i = lastKnown + 1; i < filled.length; i += 1) filled[i] = filled[lastKnown];

  return coords.map((c, i) => [c[0], c[1], filled[i]]);
}

/**
 * Throw if a GPX document contains any time element or attribute.
 *
 * Called on every document this module produces. A regression that started
 * emitting timestamps would otherwise be invisible until Strava displayed the
 * plan as a run at some pace that was never actually run.
 */
export function assertNoTimestamps(gpx) {
  const patterns = [/<time[\s>]/i, /<\/time>/i, /\btime\s*=\s*"/i];
  for (const pattern of patterns) {
    if (pattern.test(gpx)) {
      throw new Error(
        'GPX generation produced a time element. This file is a plan, not a ' +
          'recorded activity, and must never carry timestamps.',
      );
    }
  }
  return gpx;
}

/**
 * Serialise a Route to a GPX 1.1 document.
 *
 * @param {Object} route      a Route (see core/route.js)
 * @param {Object} [options]
 * @param {string} [options.name]           track name; no coordinates in it
 * @param {string} [options.description]
 * @param {number} [options.coordDigits=7]  ~1cm, the GPX convention
 * @returns {string} GPX document
 */
export function buildGpx(route, options = {}) {
  if (!route || !Array.isArray(route.coords) || route.coords.length < 2) {
    throw new TypeError('buildGpx: route must carry at least two coordinates');
  }

  const coordDigits = options.coordDigits ?? 7;
  const coords = fillMissingElevations(route.coords);

  if (coords.every((c) => c[2] === null)) {
    throw new Error(
      'buildGpx: no elevation data on any point. Request routing with ' +
        'elevation enabled - without it Strava and Runna report zero climb.',
    );
  }

  const name = options.name ?? defaultTrackName(route);
  const distanceKm = (route.actualLengthM / 1000).toFixed(2);
  const description =
    options.description ??
    'Planned loop: ' +
      distanceKm +
      'km, ' +
      Math.round(route.ascentM) +
      'm ascent. Generated route, not a recorded activity.';

  const points = coords
    .map(([lon, lat, ele]) => {
      const attrs = 'lat="' + lat.toFixed(coordDigits) + '" lon="' + lon.toFixed(coordDigits) + '"';
      return '      <trkpt ' + attrs + '><ele>' + ele.toFixed(1) + '</ele></trkpt>';
    })
    .join('\n');

  // Element order inside <metadata> follows the GPX 1.1 schema sequence:
  // name, desc, author, copyright. <time> is omitted by design, not oversight.
  const gpx =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="' + GPX_CREATOR + '"\n' +
    '     xmlns="http://www.topografix.com/GPX/1/1"\n' +
    '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
    '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 ' +
    'http://www.topografix.com/GPX/1/1/gpx.xsd">\n' +
    '  <metadata>\n' +
    '    <name>' + escapeXml(name) + '</name>\n' +
    '    <desc>' + escapeXml(description) + '</desc>\n' +
    '    <copyright author="OpenStreetMap contributors">\n' +
    '      <license>https://opendatacommons.org/licenses/odbl/1-0/</license>\n' +
    '    </copyright>\n' +
    '  </metadata>\n' +
    '  <trk>\n' +
    '    <name>' + escapeXml(name) + '</name>\n' +
    '    <type>running</type>\n' +
    '    <trkseg>\n' +
    points + '\n' +
    '    </trkseg>\n' +
    '  </trk>\n' +
    '</gpx>\n';

  return assertNoTimestamps(gpx);
}

/**
 * Track name. Distance and run type only - never a place name or coordinate,
 * since the filename travels with the file into other apps.
 */
export function defaultTrackName(route, runType = null) {
  const km = (route.actualLengthM / 1000).toFixed(1);
  return runType ? km + 'km ' + runType + ' loop' : km + 'km loop';
}

/**
 * A filesystem-safe download name.
 *
 * `dateIso` is a parameter rather than a call to the clock, both to keep this
 * function pure and because nothing here should be able to reach for a time.
 *
 * @param {Object} route
 * @param {string} [runType]
 * @param {string} [dateIso] YYYY-MM-DD
 */
export function gpxFilename(route, runType = null, dateIso = null) {
  const km = (route.actualLengthM / 1000).toFixed(1).replace('.', '-');
  const parts = ['loop', km + 'km'];
  if (runType) parts.push(runType);
  if (dateIso) parts.push(String(dateIso).slice(0, 10));
  return parts.join('_').replace(/[^a-zA-Z0-9_-]/g, '') + '.gpx';
}
