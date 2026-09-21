/**
 * Local development server for docs/.
 *
 *   npm start
 *
 * WHY THIS EXISTS RATHER THAN `python -m http.server`
 *
 * python's http.server sends no Cache-Control, so browsers fall back to
 * heuristic caching. Each ES module is cached independently and a normal
 * reload does not revalidate them, which means an edited file can sit on disk,
 * be served correctly over the wire, and still not be the version the page is
 * running. That failure is genuinely hard to see: the code looks right, the
 * server looks right, and the bug persists.
 *
 * Everything here is served with `Cache-Control: no-store`, so a reload always
 * gets what is on disk. Production caching is the service worker's job, and it
 * is versioned deliberately in docs/sw.js.
 *
 * Zero dependencies, so there is still nothing to install.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT) || 8099;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gpx': 'application/gpx+xml',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type,
      // The whole point of this server.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
    });
    res.end(body);
  };

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://' + req.headers.host).pathname);
  } catch {
    send(400, 'Bad request');
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // Contain everything within docs/. normalize collapses any ../ segments
  // before the join, so a crafted path cannot escape the root.
  const relative = normalize(pathname).replace(/^([/\\])+/, '');
  const filePath = join(ROOT, relative);

  if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
    send(403, 'Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      send(404, 'Not found: ' + pathname);
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
    });

    createReadStream(filePath).pipe(res);
    console.log('  ' + req.method + ' ' + pathname + ' -> 200');
  } catch {
    send(404, 'Not found: ' + pathname);
    console.log('  ' + req.method + ' ' + pathname + ' -> 404');
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Loop is running at  http://' + HOST + ':' + PORT);
  console.log('  Serving             ' + ROOT);
  console.log('  Caching             disabled, so a reload always gets your latest edit');
  console.log('');
  console.log('  Open that address in your browser. Ctrl+C here stops the server.');
  console.log('');
});

server.on('error', (cause) => {
  if (cause.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use.');
    console.error('  Stop the other server, or run:  PORT=8100 npm start\n');
    process.exit(1);
  }
  throw cause;
});
