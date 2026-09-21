/**
 * Daily API request tally.
 *
 * The free OpenRouteService tier allows 2000 directions requests a day, and
 * one generation can cost up to sixteen. That budget is easy to spend without
 * noticing - and when it runs out, ORS answers 403 with no CORS header, which
 * the browser reports as an unreadable failure indistinguishable from a wrong
 * key. Somebody then goes looking for a problem with their key that does not
 * exist.
 *
 * So the app keeps its own count. It cannot be authoritative - it does not see
 * requests made from another browser or device, and it cannot read the real
 * figure back - but it turns "it worked yesterday and not today" into
 * something visible.
 *
 * Stores a date and a number. No coordinates, no key.
 */

import { warn } from '../core/log.js';

const USAGE_NAME = 'loopgen:usage';

/** Free tier: 2000 directions requests a day. */
export const FREE_TIER_DAILY = 2000;

/** Warn from this fraction of the daily allowance. */
export const WARN_AT = 0.75;

function storage() {
  try {
    const store = globalThis.localStorage;
    const probe = '__loopgen_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/**
 * The current quota day.
 *
 * ORS resets on its own schedule, which this cannot observe, so the tally is
 * kept per UTC day and is an indication rather than a mirror of the real
 * counter. `today` is a parameter so the behaviour is testable without
 * pretending to control the clock.
 */
export function quotaDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function read(day) {
  const store = storage();
  if (!store) return { day, count: 0 };

  try {
    const parsed = JSON.parse(store.getItem(USAGE_NAME) || 'null');
    if (!parsed || parsed.day !== day || !Number.isFinite(parsed.count)) return { day, count: 0 };
    return { day, count: parsed.count };
  } catch {
    return { day, count: 0 };
  }
}

/**
 * Record requests made.
 * @param {number} n how many
 * @param {Date} [now]
 * @returns {number} the running total for the day
 */
export function recordRequests(n, now = new Date()) {
  if (!Number.isFinite(n) || n <= 0) return todaysUsage(now).count;

  const day = quotaDay(now);
  const current = read(day);
  const next = { day, count: current.count + n };

  const store = storage();
  if (store) {
    try {
      store.setItem(USAGE_NAME, JSON.stringify(next));
    } catch {
      warn('could not record API usage');
    }
  }

  return next.count;
}

/**
 * @returns {{count:number, limit:number, remaining:number, fraction:number, high:boolean}}
 */
export function todaysUsage(now = new Date()) {
  const { count } = read(quotaDay(now));
  const fraction = count / FREE_TIER_DAILY;

  return {
    count,
    limit: FREE_TIER_DAILY,
    remaining: Math.max(0, FREE_TIER_DAILY - count),
    fraction,
    high: fraction >= WARN_AT,
  };
}

/** Reset the tally. */
export function clearUsage() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(USAGE_NAME);
  } catch {
    warn('could not clear API usage');
  }
}
