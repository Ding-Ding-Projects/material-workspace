#!/usr/bin/env node
/**
 * Serve site-dist over loopback, for verification only.
 *
 * The site is a set of ES modules, which a browser refuses to load from a
 * file:// origin. Serving it is therefore not a convenience — it is the only way
 * to exercise what a visitor will actually receive.
 *
 * Bound to 127.0.0.1 and nothing else. Nothing here is a production server, and
 * it refuses any path that tries to escape the output directory.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'site-dist');
const port = Number(process.argv[2] ?? 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const requested = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const target = path.resolve(DIST, relative);

  // Path containment, checked on the RESOLVED path. Comparing the requested
  // string would be satisfied by anything that normalises out of the directory.
  if (target !== DIST && !target.startsWith(DIST + path.sep)) {
    response.writeHead(403).end('outside the served directory');
    return;
  }

  fs.readFile(target, (error, data) => {
    if (error) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('[serve] http://127.0.0.1:' + port + '/\n');
});
