/**
 * API key storage.
 *
 * The deployed JavaScript is public, and GitHub Pages serves every file in the
 * repository whether or not anything links to it. So the key is never in
 * source, never in a committed config file, and never in a URL. It is entered
 * by the person using the app and lives in their own browser's localStorage.
 *
 * That also makes clearing it meaningful: there is exactly one copy, and
 * clearRouteProviderKey removes it.
 */

import { warn } from '../core/log.js';

const KEY_STORAGE_NAME = 'loopgen:ors-key';

/**
 * localStorage throws rather than returning null in a few real situations:
 * Safari private browsing, blocked site data, and some embedded webviews. The
 * app has to stay usable in those cases, so every access is guarded.
 */
function storage() {
  try {
    const store = globalThis.localStorage;
    // Presence is not enough; touching it is what throws.
    const probe = '__loopgen_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** @returns {boolean} whether this browser will persist anything at all. */
export function isStorageAvailable() {
  return storage() !== null;
}

/** @returns {string|null} the stored key, or null. */
export function getRouteProviderKey() {
  const store = storage();
  if (!store) return null;
  const value = store.getItem(KEY_STORAGE_NAME);
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** @returns {boolean} whether a key is present. */
export function hasRouteProviderKey() {
  return getRouteProviderKey() !== null;
}

/**
 * Store a key.
 *
 * The format check is deliberately permissive - it rejects obvious mistakes
 * like a pasted URL or an empty string, and otherwise lets the service be the
 * judge. Guessing at a key format tends to age badly.
 *
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function setRouteProviderKey(rawValue) {
  const value = String(rawValue ?? '').trim();

  if (value.length === 0) {
    return { ok: false, reason: 'Enter a key.' };
  }
  if (/^https?:\/\//i.test(value)) {
    return { ok: false, reason: 'That looks like a URL. Paste just the key itself.' };
  }
  if (value.length < 16) {
    return { ok: false, reason: 'That key looks too short. Check you copied all of it.' };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: 'That key contains spaces. Check you copied it cleanly.' };
  }

  const store = storage();
  if (!store) {
    return {
      ok: false,
      reason: 'This browser is blocking local storage, so the key cannot be saved. Private browsing is the usual cause.',
    };
  }

  try {
    store.setItem(KEY_STORAGE_NAME, value);
    return { ok: true };
  } catch {
    warn('could not persist the provider key');
    return { ok: false, reason: 'The key could not be saved to this browser.' };
  }
}

/** Remove the stored key. Safe to call when none is stored. */
export function clearRouteProviderKey() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY_STORAGE_NAME);
  } catch {
    warn('could not clear the provider key');
  }
}

/**
 * A key reduced to something safe to show on screen, so a person can tell
 * which key is stored without the full value being shoulder-surfed or
 * captured in a screenshot.
 *
 * @returns {string|null} e.g. "5b3c...8a1f"
 */
export function maskedRouteProviderKey() {
  const key = getRouteProviderKey();
  if (!key) return null;
  if (key.length <= 12) return '•'.repeat(key.length);
  return key.slice(0, 4) + '…' + key.slice(-4);
}
