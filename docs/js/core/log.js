/**
 * Logging that cannot leak a location.
 *
 * Coordinates must not reach the console on a production path. Console output
 * is visible to anything with devtools access, survives in crash reporters and
 * gets pasted verbatim into bug reports.
 *
 * Rather than relying on remembering, everything routed through here is
 * redacted first, and verbose logging is off unless deliberately switched on
 * in this browser.
 */

const DEBUG_FLAG = 'loopgen:debug';

/** Verbose logging is opt-in, per browser, and never on by default. */
export function isDebugEnabled(storage = safeStorage()) {
  try {
    return storage?.getItem(DEBUG_FLAG) === '1';
  } catch {
    return false;
  }
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked in private mode or by site settings
  }
}

/**
 * Replace anything coordinate-shaped with a placeholder.
 *
 * Deliberately blunt: it truncates any number carrying four or more decimal
 * places, which is well past the precision anything else in this app uses and
 * squarely in coordinate territory. Over-redacting a log line costs nothing;
 * under-redacting one publishes where somebody runs.
 */
export function redact(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Number(value.toFixed(3));
  }

  if (typeof value === 'string') {
    return value.replace(/-?\d{1,3}\.\d{4,}/g, '[coord]');
  }

  if (Array.isArray(value)) return value.map(redact);

  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /^(lat|lon|lng|latitude|longitude|coords|coordinates|center|bbox)$/i.test(key)
        ? '[redacted]'
        : redact(entry);
    }
    return out;
  }

  return value;
}

/** Verbose diagnostics. Silent unless debug is enabled, and always redacted. */
export function debug(...args) {
  if (!isDebugEnabled()) return;
  console.debug('[loopgen]', ...args.map(redact));
}

/** Warnings are always shown, and always redacted. */
export function warn(...args) {
  console.warn('[loopgen]', ...args.map(redact));
}

/**
 * Errors are always shown and always redacted.
 *
 * An Error instance is reduced to its name and message: a stack can embed
 * arguments, and the message may have been built from a response body.
 */
export function error(...args) {
  console.error(
    '[loopgen]',
    ...args.map((arg) =>
      arg instanceof Error ? arg.name + ': ' + redact(arg.message) : redact(arg),
    ),
  );
}
