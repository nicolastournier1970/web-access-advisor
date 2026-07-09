/**
 * Zero-dependency static server for the e2e fixture site.
 * Usage: node e2e/fixtures/serve.mjs [port]   (default 4310 — 4300 is the web dev server)
 * The site is deliberately static + client-side only: the waa_session cookie
 * IS the session, so login state survives server restarts and storageState
 * reuse can be tested without a stateful backend.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const port = Number(process.argv[2] ?? process.env.WAA_FIXTURE_PORT ?? 4310);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = path.normalize(path.join(root, file));
    if (!resolved.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(resolved);
    res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(port, () => {
  console.log(`WAA fixture site: http://localhost:${port}/`);
});
