import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * The staleness check compares the BUILD constant baked into main.js against
 * docs/version.json fetched from the server. If those two drift apart the
 * check either never fires or fires constantly, and in both cases it is worse
 * than not having it. Nothing in a no-build-step project keeps them in sync
 * except this test.
 */
test('version.json matches the BUILD constant in main.js', () => {
  const declared = JSON.parse(read('docs/version.json')).build;
  const inCode = read('docs/js/main.js').match(/const BUILD = '([^']+)'/);

  assert.ok(inCode, 'no BUILD constant found in main.js');
  assert.equal(
    declared,
    inCode[1],
    'docs/version.json says "' + declared + '" but main.js says "' + inCode[1] +
      '". Update both when changing the build marker.',
  );
});

test('the service worker precaches version.json but never serves it from cache', () => {
  const sw = read('docs/sw.js');

  assert.ok(sw.includes("'version.json'"), 'version.json is missing from the app shell');
  assert.match(
    sw,
    /version\.json['"]\)\)\s*return;/,
    'version.json must bypass the cache, or the staleness check reports stale answers',
  );
});

test('the service worker shell lists every published module', () => {
  // A module missing from the shell still works online and fails offline,
  // which is the hardest kind of gap to notice.
  const sw = read('docs/sw.js');
  const shell = sw.slice(sw.indexOf('APP_SHELL'), sw.indexOf('NEVER_CACHE_HOSTS'));

  const imported = new Set();
  const walk = (file) => {
    if (imported.has(file)) return;
    imported.add(file);
    const source = read('docs/' + file);
    for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      // Normalise to forward slashes: the shell list uses them, and join()
      // produces backslashes on Windows.
      const resolved = join(dirname(file), m[1]).split(sep).join('/');
      walk(resolved);
    }
  };
  walk('js/main.js');

  for (const file of imported) {
    assert.ok(shell.includes("'" + file + "'"), file + ' is not precached by the service worker');
  }
});
