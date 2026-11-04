// Single-origin hub server: TV shell, rewriting proxy, catalog API, artwork, and
// the demo portal, all on one port so the TV app never deals with CORS.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, watch } from 'node:fs';
import { loadSources, reloadSources, patchSourceRules } from './sources.js';
import { loadFilters, compileFilters } from './filters.js';
import { loadAccess, clientAllowed } from './access.js';
import { readFileSync } from 'node:fs';
import { createProxy } from './proxy.js';
import { serveStatic } from './static.js';
import { Catalog } from './ingest/catalog.js';
import { Scheduler } from './ingest/scheduler.js';
import { ArtworkStore } from './ingest/artwork.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
// Portal pages are served from a second origin so their scripts can never touch the shell, its
// storage, or the hub API. The shell and the frame talk only through postMessage.
const PORTAL_PORT = Number(process.env.HUB_PORTAL_PORT || PORT + 1);
const DATA = process.env.HUB_DATA || path.join(ROOT, 'data');
const log = (...a) => { if (process.env.HUB_QUIET) return; console.log(new Date().toISOString().slice(11, 19), ...a); };

mkdirSync(DATA, { recursive: true });
const CONFIG = path.join(ROOT, 'config');
const SOURCES_FILE = path.join(CONFIG, 'sources.json'), FILTERS_FILE = path.join(CONFIG, 'filters.json');
const ACCESS_FILE = path.join(CONFIG, 'access.json');
const sources = loadSources(SOURCES_FILE);
const filters = loadFilters(FILTERS_FILE);
const access = loadAccess(ACCESS_FILE);
const proxy = createProxy({ sources, filters, log });
const catalog = new Catalog(path.join(DATA, 'catalog.sqlite'));
const artwork = new ArtworkStore({ dir: path.join(DATA, 'artwork'), budgetBytes: Number(process.env.HUB_ART_BUDGET || 2 * 1024 ** 3), log });
await artwork.init();
const scheduler = new Scheduler({ sources, catalog, artwork, log });

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Config hot-reload: edit config/*.json (or let the rule inspector write it) and nothing restarts.
let reloadTimer = null;
function reloadConfig(reason) {
  try {
    const diff = reloadSources(SOURCES_FILE, sources);
    Object.assign(filters, compileFilters(JSON.parse(readFileSync(FILTERS_FILE, 'utf8'))));
    Object.assign(access, loadAccess(ACCESS_FILE));
    scheduler.refresh(diff);
    log('config reloaded', reason, diff.added.length ? `+${diff.added}` : '', diff.removed.length ? `-${diff.removed}` : '');
  } catch (e) { log('config reload failed (keeping previous):', e.message); }
}
try {
  watch(CONFIG, (evt, file) => { if (!/\.json$/.test(file || '')) return; clearTimeout(reloadTimer); reloadTimer = setTimeout(() => reloadConfig(file), 300); });
} catch (e) { log('config watch unavailable:', e.message); }

const hostnameOf = (req) => { const h = req.headers.host || '127.0.0.1'; return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]; };

/** Second origin: portal pages, third-party assets and the injected script only. */
async function routePortal(req, res) {
  const p = new URL(req.url, 'http://hub').pathname;
  req.hubShellOrigin = `http://${hostnameOf(req)}:${PORT}`;
  if (p.startsWith('/p/') || p.startsWith('/x/')) return proxy.handle(req, res);
  if (p.startsWith('/shell/inject/')) { if (await serveStatic(path.join(ROOT, 'shell', 'inject'), p.slice('/shell/inject/'.length), req, res)) return; }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'hub'}`);
  const p = url.pathname;

  if (p.startsWith('/p/') || p.startsWith('/x/')) { res.writeHead(404, { 'content-type': 'text/plain' }).end('portal content is served on the portal port'); return; }

  if (p === '/api/env') return json(res, 200, { portalOrigin: `http://${hostnameOf(req)}:${PORTAL_PORT}`, version: '0.2.0' });
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
  const rulesMatch = p.match(/^\/api\/sources\/([^/]+)\/rules$/);
  if (rulesMatch && req.method === 'PATCH') {
    const id = decodeURIComponent(rulesMatch[1]);
    if (!sources.has(id)) return json(res, 404, { error: 'unknown source' });
    const patch = await readJsonBody(req);
    const rules = patchSourceRules(SOURCES_FILE, id, patch);
    reloadConfig('rules-patch');
    return json(res, 200, { id, rules });
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

  if (p === '/' || p === '/index.html') {
    // The portal frame may only ever load hub-origin URLs. A page script that tries to send the
    // frame to another site is refused by the browser before any request leaves the TV.
    res.setHeader('content-security-policy', `frame-src http://${hostnameOf(req)}:${PORTAL_PORT}; form-action 'self'; object-src 'none'`);
    return serveStatic(path.join(ROOT, 'shell'), 'index.html', req, res);
  }
  if (p.startsWith('/shell/')) { if (await serveStatic(path.join(ROOT, 'shell'), p.slice(7), req, res)) return; }
  if (p.startsWith('/demo/')) { if (await serveStatic(path.join(ROOT, 'demo'), p.slice(6), req, res)) return; }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}

function guarded(handler) {
  return (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!clientAllowed(access, ip)) {
      log('denied client', ip, req.url);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('This device is not allowed to use the hub. Add its address to config/access.json.');
      return;
    }
    handler(req, res).catch((e) => {
      log('error', req.url, e.stack || e.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    });
  };
}
const server = http.createServer(guarded(route));
const portalServer = http.createServer(guarded(routePortal));
portalServer.listen(PORTAL_PORT, () => log(`portal content on port ${PORTAL_PORT}`));

server.listen(PORT, () => {
  log(`hub listening on http://127.0.0.1:${PORT}  (shell: /, status: /api/status)`);
  log(access.allowClients.length ? `clients allowed: ${access.allowClients.join(', ')} (+ this machine)` : 'clients allowed: any device on the network (set config/access.json to restrict)');
  scheduler.start();
  setInterval(() => { if (!scheduler.running.size) artwork.sweep(); }, 24 * 3600 * 1000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { scheduler.stop(); catalog.close(); portalServer.close(); server.close(() => process.exit(0)); });
