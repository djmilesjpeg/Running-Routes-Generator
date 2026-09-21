/**
 * Application wiring.
 *
 * Holds no routing logic and no maths. It reads the controls, calls
 * generateRoutes, and renders what comes back. Everything it depends on is
 * unit tested elsewhere; this file is the part that needs a browser.
 */

import { generateRoutes } from './app/generate.js';
import { saveRoute, loadRoutes, clearRoutes, cachedRouteCount } from './app/cache.js';
import { OrsProvider } from './providers/OrsProvider.js';
import { PROVIDER_ERRORS } from './providers/RouteProvider.js';
import { RUN_TYPES, RUN_TYPE_IDS, scoreCandidates, routeStats } from './core/scoring.js';
import { buildGpx, gpxFilename, defaultTrackName } from './core/gpx.js';
import { relativeError } from './core/route.js';
import { RouteMap } from './ui/map.js';
import {
  getRouteProviderKey,
  setRouteProviderKey,
  clearRouteProviderKey,
  hasRouteProviderKey,
  maskedRouteProviderKey,
} from './ui/keystore.js';
import { debug, error as logError } from './core/log.js';

const PREFS_NAME = 'loopgen:prefs';

const el = (id) => document.getElementById(id);

const state = {
  map: null,
  runType: 'easy',
  distanceKm: 10,
  position: null,      // {lat, lon} - held in memory only, never persisted
  ranked: [],
  selected: null,
  busy: false,
};

// ---------------------------------------------------------------------------
// preferences (distance and run type only - never a location)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_NAME) || 'null');
    if (!raw) return;
    if (Number.isFinite(raw.distanceKm)) state.distanceKm = raw.distanceKm;
    if (RUN_TYPE_IDS.includes(raw.runType)) state.runType = raw.runType;
  } catch {
    /* first run, or storage unavailable */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_NAME,
      JSON.stringify({ distanceKm: state.distanceKm, runType: state.runType }),
    );
  } catch {
    /* not important enough to surface */
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderRunTypes() {
  const container = el('run-types');
  container.innerHTML = '';

  for (const id of RUN_TYPE_IDS) {
    const spec = RUN_TYPES[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-type';
    button.setAttribute('aria-pressed', String(id === state.runType));
    button.dataset.runType = id;
    button.title = spec.description;

    const name = document.createElement('span');
    name.className = 'run-type-name';
    name.textContent = spec.label;

    const hint = document.createElement('span');
    hint.className = 'run-type-hint';
    hint.textContent = spec.hint;

    button.append(name, hint);
    button.addEventListener('click', () => selectRunType(id));
    container.append(button);
  }
}

function selectRunType(id) {
  state.runType = id;
  savePrefs();

  for (const button of document.querySelectorAll('.run-type')) {
    button.setAttribute('aria-pressed', String(button.dataset.runType === id));
  }

  // Re-rank in place. The candidates are already downloaded, so changing run
  // type must not cost another request.
  if (state.ranked.length > 0) {
    const routes = state.ranked.map((entry) => entry.route);
    state.ranked = scoreCandidates(routes, id, { targetM: state.distanceKm * 1000 });
    selectCandidate(state.ranked[0], { redraw: true });
    renderCandidates();
  }
}

function syncDistanceChips() {
  for (const chip of document.querySelectorAll('.chip[data-km]')) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.km) === state.distanceKm));
  }
}

function showPanel(id, visible) {
  el(id).hidden = !visible;
}

function setBusy(busy, { title = 'Finding routes', detail = '' } = {}) {
  state.busy = busy;
  showPanel('progress', busy);
  el('start-here').disabled = busy;

  if (busy) {
    el('progress-title').textContent = title;
    el('progress-detail').textContent = detail;
  }
}

function showError(title, message, actions = []) {
  el('error-title').textContent = title;
  el('error-message').textContent = message;

  const container = el('error-actions');
  container.innerHTML = '';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ' + (action.primary ? 'primary' : 'subtle');
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    container.append(button);
  }

  showPanel('error-panel', true);
}

function clearError() {
  showPanel('error-panel', false);
}

function formatKm(metres) {
  return (metres / 1000).toFixed(2) + ' km';
}

function renderResult() {
  const entry = state.selected;
  if (!entry) return;

  const { route } = entry;
  const targetM = state.distanceKm * 1000;
  const stats = routeStats(route, targetM);

  el('result-distance').textContent = formatKm(route.actualLengthM);

  const errPct = relativeError(route, targetM) * 100;
  el('result-error').textContent =
    (errPct >= 0 ? '+' : '') + errPct.toFixed(1) + '% of ' + state.distanceKm + ' km';

  const figures = [
    ['Ascent', Math.round(stats.ascentM) + ' m'],
    ['Descent', Math.round(stats.descentM) + ' m'],
    ['Climb / km', Math.round(stats.ascentPerKm) + ' m'],
    ['Turns', String(stats.stepCount)],
  ];

  const list = el('result-stats');
  list.innerHTML = '';
  for (const [label, value] of figures) {
    const wrapper = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrapper.append(dt, dd);
    list.append(wrapper);
  }

  showPanel('results', true);
}

function renderCandidates() {
  const list = el('candidates');
  list.innerHTML = '';

  for (const entry of state.ranked) {
    const item = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'candidate';
    button.setAttribute('aria-current', String(entry.route.id === state.selected?.route.id));

    const main = document.createElement('span');
    const distance = document.createElement('span');
    distance.className = 'candidate-main';
    distance.textContent = formatKm(entry.route.actualLengthM);

    const meta = document.createElement('span');
    meta.className = 'candidate-meta';
    meta.textContent = ' · ' + entry.label;

    main.append(distance, meta);
    button.append(main);

    button.addEventListener('click', () => {
      selectCandidate(entry, { redraw: true });
      renderCandidates();
    });

    item.append(button);
    list.append(item);
  }
}

function selectCandidate(entry, { redraw = false } = {}) {
  if (!entry) return;
  state.selected = entry;

  if (redraw && state.map) {
    state.map.showRoute(entry.route, state.ranked.map((other) => other.route));
  }
  renderResult();
}

function renderRecent() {
  const entries = loadRoutes();
  const list = el('recent-list');
  list.innerHTML = '';

  showPanel('recent', entries.length > 0);
  el('cache-status').textContent =
    entries.length === 0
      ? 'No routes saved on this device.'
      : entries.length + (entries.length === 1 ? ' route' : ' routes') + ' saved on this device.';

  for (const { route, meta } of entries) {
    const item = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'candidate';

    const main = document.createElement('span');
    const distance = document.createElement('span');
    distance.className = 'candidate-main';
    distance.textContent = formatKm(route.actualLengthM);

    const metaLabel = document.createElement('span');
    metaLabel.className = 'candidate-meta';
    metaLabel.textContent =
      ' · ' + (RUN_TYPES[meta.runType]?.label ?? meta.runType) + ' · ' + meta.savedOn;

    main.append(distance, metaLabel);

    button.addEventListener('click', () => {
      state.ranked = [];
      state.selected = { route, label: '' };
      state.map.showRoute(route, []);
      renderResult();
      el('candidates').innerHTML = '';
    });

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'button subtle';
    download.textContent = 'GPX';
    download.addEventListener('click', (event) => {
      event.stopPropagation();
      downloadRoute(route, meta.runType);
    });

    const actions = document.createElement('span');
    actions.className = 'candidate-actions';
    actions.append(download);

    button.append(main);
    item.append(button, actions);
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

/**
 * Ask for the current position.
 *
 * The result is held in memory for the length of the session and never
 * written to storage. Nothing else needs it.
 */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser cannot provide your location.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      (cause) => {
        const messages = {
          1: 'Location permission was declined. Allow it in your browser settings to start from where you are.',
          2: 'Your location could not be determined. Try again somewhere with a clearer view of the sky.',
          3: 'Finding your location took too long. Try again.',
        };
        reject(new Error(messages[cause.code] || 'Your location could not be determined.'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

async function startFromHere() {
  if (state.busy) return;

  clearError();
  setBusy(true, { title: 'Finding you', detail: 'Waiting for a location fix…' });

  try {
    state.position = await getPosition();
    state.map.showStart(state.position.lat, state.position.lon);
  } catch (cause) {
    setBusy(false);
    showError('Could not get your location', cause.message, [
      { label: 'Try again', primary: true, onClick: startFromHere },
    ]);
    return;
  }

  await generate();
}

async function generate() {
  const key = getRouteProviderKey();
  if (!key) {
    setBusy(false);
    showKeyGate();
    return;
  }
  if (!state.position) {
    setBusy(false);
    showError('No start point yet', 'Tap "Start from here" to use your current location.');
    return;
  }

  const targetM = state.distanceKm * 1000;
  const provider = new OrsProvider({ apiKey: key });

  setBusy(true, { title: 'Finding routes', detail: 'Asking for candidate loops…' });
  clearError();

  try {
    const result = await generateRoutes({
      provider,
      lat: state.position.lat,
      lon: state.position.lon,
      targetM,
      runType: state.runType,
      // A fresh base seed each run, so tapping again offers different loops.
      baseSeed: Math.floor(Math.random() * 2 ** 31),
      onProgress: ({ phase, attempts }) => {
        const detail = {
          requesting: 'Asking for candidate loops…',
          measuring: 'Measuring what came back…',
          correcting: 'Correcting the distance and asking again…',
          done: 'Ranking candidates…',
        };
        setBusy(true, { title: 'Finding routes', detail: detail[phase] || '' });
        debug('progress', { phase, attempts });
      },
    });

    setBusy(false);

    if (result.status === 'failed') {
      handleFailure(result);
      return;
    }

    state.ranked = result.ranked;
    selectCandidate(result.ranked[0], { redraw: true });
    renderCandidates();

    if (result.warnings.length > 0) {
      debug('completed with warnings', { count: result.warnings.length });
    }

    saveRoute(state.selected.route, {
      runType: state.runType,
      targetM,
      savedOn: new Date().toISOString().slice(0, 10),
    });
    renderRecent();
  } catch (cause) {
    setBusy(false);
    logError(cause);
    showError('Route generation failed', cause.message || 'Something went wrong. Try again.', [
      { label: 'Try again', primary: true, onClick: generate },
    ]);
  }
}

/** Turn a failed run into something the runner can act on. */
function handleFailure(result) {
  const { code, message } = result.error;

  if (code === PROVIDER_ERRORS.INVALID_KEY || code === PROVIDER_ERRORS.MISSING_KEY) {
    showError('API key problem', message, [
      {
        label: 'Enter a different key',
        primary: true,
        onClick: () => {
          clearRouteProviderKey();
          showKeyGate();
          clearError();
        },
      },
    ]);
    return;
  }

  if (code === 'NO_CANDIDATE_WITHIN_TOLERANCE') {
    const actions = [{ label: 'Try again', primary: true, onClick: generate }];

    // A near miss is usually more useful than nothing at all, so offer it
    // rather than discarding work already paid for.
    if (result.nearMisses.length > 0) {
      actions.push({
        label: 'Use the closest anyway (' + formatKm(result.nearMisses[0].route.actualLengthM) + ')',
        onClick: () => {
          state.ranked = result.nearMisses;
          selectCandidate(result.nearMisses[0], { redraw: true });
          renderCandidates();
          clearError();
        },
      });
    }

    showError('No loop matched that distance', message, actions);
    return;
  }

  showError('Could not build a route', message, [
    { label: 'Try again', primary: true, onClick: generate },
  ]);
}

function downloadRoute(route, runType) {
  try {
    const gpx = buildGpx(route, { name: defaultTrackName(route, runType) });
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = gpxFilename(route, runType, new Date().toISOString().slice(0, 10));
    document.body.append(link);
    link.click();
    link.remove();

    // Revoke on the next frame; revoking synchronously can beat the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (cause) {
    logError(cause);
    showError('Could not build the GPX file', cause.message);
  }
}

// ---------------------------------------------------------------------------
// key gate and settings
// ---------------------------------------------------------------------------

function showKeyGate() {
  showPanel('key-gate', true);
  showPanel('app', false);
  el('key-input').focus();
}

function hideKeyGate() {
  showPanel('key-gate', false);
  showPanel('app', true);
  if (state.map) state.map.invalidate();
}

function renderKeyStatus() {
  const masked = maskedRouteProviderKey();
  el('key-status').textContent = masked ? 'Stored in this browser: ' + masked : 'No key stored.';
  el('clear-key').disabled = !masked;
}

// ---------------------------------------------------------------------------
// start-up
// ---------------------------------------------------------------------------

function wireEvents() {
  el('start-here').addEventListener('click', startFromHere);

  el('distance').addEventListener('change', (event) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    state.distanceKm = Math.min(60, Math.max(1, value));
    event.target.value = String(state.distanceKm);
    savePrefs();
    syncDistanceChips();
  });

  for (const chip of document.querySelectorAll('.chip[data-km]')) {
    chip.addEventListener('click', () => {
      state.distanceKm = Number(chip.dataset.km);
      el('distance').value = String(state.distanceKm);
      savePrefs();
      syncDistanceChips();
    });
  }

  el('download').addEventListener('click', () => {
    if (state.selected) downloadRoute(state.selected.route, state.runType);
  });

  el('settings-toggle').addEventListener('click', () => {
    const settings = el('settings');
    const open = settings.hidden;
    settings.hidden = !open;
    el('settings-toggle').setAttribute('aria-expanded', String(open));
    if (open) renderKeyStatus();
  });

  el('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('key-input');
    const result = setRouteProviderKey(input.value);

    const errorLine = el('key-error');
    if (!result.ok) {
      errorLine.textContent = result.reason;
      errorLine.hidden = false;
      return;
    }

    errorLine.hidden = true;
    input.value = ''; // do not leave the key sitting in the DOM
    hideKeyGate();
    renderKeyStatus();
  });

  el('clear-key').addEventListener('click', () => {
    clearRouteProviderKey();
    renderKeyStatus();
    showKeyGate();
  });

  el('clear-cache').addEventListener('click', () => {
    clearRoutes();
    renderRecent();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Relative path, so the app works from a project page such as
  // https://user.github.io/repo/ as well as from a domain root.
  const register = () => {
    navigator.serviceWorker.register('sw.js').catch((cause) => {
      debug('service worker registration failed', cause?.name);
    });
  };

  // This module has a deep import graph, and resolving it can outlast the load
  // event. Waiting unconditionally for an event that has already fired would
  // mean the worker is never registered and the app is never installable.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

function init() {
  loadPrefs();

  try {
    state.map = new RouteMap('map', {
      onTileError: () => showPanel('tile-warning', true),
    });
  } catch (cause) {
    logError(cause);
    showError('Map failed to load', cause.message);
  }

  el('distance').value = String(state.distanceKm);
  syncDistanceChips();
  renderRunTypes();
  wireEvents();
  renderKeyStatus();
  renderRecent();

  if (hasRouteProviderKey()) hideKeyGate();
  else showKeyGate();

  el('cache-status').textContent =
    cachedRouteCount() === 0
      ? 'No routes saved on this device.'
      : cachedRouteCount() + ' saved on this device.';

  registerServiceWorker();
}

// Same race as the service worker above: if module resolution outlasts
// DOMContentLoaded, waiting for it would leave the app permanently blank.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
