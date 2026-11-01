// Single-origin hub server: TV shell, rewriting proxy, catalog API, artwork, and
// the demo portal, all on one port so the TV app never deals with CORS.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { loadSources } from './sources.js';
import { loadFilters } from './filters.js';
import { createProxy } from './proxy.js';
import { serveStatic } from './static.js';
import { Catalog } from './ingest/catalog.js';
import { Scheduler } from './ingest/scheduler.js';
import { ArtworkStore } from './ingest/artwork.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.HUB_DATA || path.join(ROOT, 'data');
const log = (...a) => { if (process.env.HUB_QUIET) return; console.log(new Date().toISOString().slice(11, 19), ...a); };

mkdirSync(DATA, { recursive: true });
const sources = loadSources(path.join(ROOT, 'config', 'sources.json'));
const filters = loadFilters(path.join(ROOT, 'config', 'filters.json'));
const proxy = createProxy({ sources, filters, log });
const catalog = new Catalog(path.join(DATA, 'catalog.sqlite'));
const artwork = new ArtworkStore({ dir: path.join(DATA, 'artwork'), budgetBytes: Number(process.env.HUB_ART_BUDGET || 2 * 1024 ** 3), log });
await artwork.init();
const scheduler = new Scheduler({ sources, catalog, artwork, log });

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'hub'}`);
  const p = url.pathname;

  if (p.startsWith('/p/') || p.startsWith('/x/')) return proxy.handle(req, res);

  if (p === '/api/sources') {
    return json(res, 200, [...sources.values()].map((s) => ({ id: s.id, name: s.name, home: `/p/${s.id}${s.home || '/'}`, rules: s.rules })));
  }
  if (p === '/api/catalog') {
    const since = Number(url.searchParams.get('since') || 0);
    const delta = catalog.since(since, Number(url.searchParams.get('limit') || 500));
    const etag = `"${delta.head}"`;
    if (req.headers['if-none-match'] === etag && !delta.items.length) { res.writeHead(304, { etag }).end(); return; }
    return json(res, 200, delta, { etag, 'cache-control': 'no-cache' });
  }
  if (p.startsWith('/api/artwork/')) {
    const [hash, size] = p.slice('/api/artwork/'.length).split('/');
    const file = await artwork.resolve(hash, size);
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('cache-control', 'public, max-age=604800, immutable');
    return serveStatic(path.dirname(file), path.basename(file), req, res);
  }
  if (p === '/api/ingest/run' && req.method === 'POST') {
    const id = url.searchParams.get('source');
    const ids = id ? [id] : [...sources.keys()];
    const results = await Promise.all(ids.map((s) => scheduler.run(s)));
    return json(res, 200, { results, count: catalog.count() });
  }
  if (p === '/api/status') {
    return json(res, 200, {
      items: catalog.count(), head: catalog.seq,
      ingest: Object.fromEntries(scheduler.status),
      proxy: { requests: proxy.stats.requests, blocked: proxy.stats.blocked, byReason: Object.fromEntries(proxy.stats.byReason) },
    });
  }

  if (p === '/' || p === '/index.html') return serveStatic(path.join(ROOT, 'shell'), 'index.html', req, res);
  if (p.startsWith('/shell/')) { if (await serveStatic(path.join(ROOT, 'shell'), p.slice(7), req, res)) return; }
  if (p.startsWith('/demo/')) { if (await serveStatic(path.join(ROOT, 'demo'), p.slice(6), req, res)) return; }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    log('error', req.url, e.stack || e.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });
});

server.listen(PORT, () => {
  log(`hub listening on http://127.0.0.1:${PORT}  (shell: /, status: /api/status)`);
  scheduler.start();
  setInterval(() => { if (!scheduler.running.size) artwork.sweep(); }, 24 * 3600 * 1000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { scheduler.stop(); catalog.close(); server.close(() => process.exit(0)); });
