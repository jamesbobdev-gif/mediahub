import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKind, hasContentHash, upstreamFreshness, cachePolicy, createCache, TTL } from '../server/cache.js';
import { createProxy } from '../server/proxy.js';
import { compileFilters } from '../server/filters.js';

const HOUR = 3600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;

test('only scripts, styles, images, fonts and JSON/XML are kinds the cache keeps', () => {
  assert.equal(cacheKind('application/javascript; charset=utf-8', 'https://cdn.test/a.js'), 'script');
  assert.equal(cacheKind('text/css', 'https://cdn.test/a.css'), 'style');
  assert.equal(cacheKind('image/webp', 'https://cdn.test/a'), 'image');
  assert.equal(cacheKind('font/woff2', 'https://cdn.test/a'), 'font');
  assert.equal(cacheKind('application/octet-stream', 'https://cdn.test/f/open.woff2'), 'font');
  assert.equal(cacheKind('', 'https://cdn.test/f/main.js?v=2'), 'script');
  assert.equal(cacheKind('application/json', 'https://api.test/x'), 'data');
  for (const [t, u] of [['text/html; charset=utf-8', 'https://portal.test/'], ['application/vnd.apple.mpegurl', 'https://cdn.test/i.m3u8'], ['application/dash+xml', 'https://cdn.test/m.mpd'], ['video/mp2t', 'https://cdn.test/s.ts'], ['application/octet-stream', 'https://cdn.test/s.m4s'], ['text/plain', 'https://cdn.test/robots.txt'], ['audio/mpeg', 'https://cdn.test/a.mp3']]) {
    assert.equal(cacheKind(t, u), null, `${t} ${u}`);
  }
});

test('a content hash in the file name is recognised; version numbers and plain names are not', () => {
  for (const u of ['https://cdn.test/static/js/main.3f9a1c2b.js', 'https://cdn.test/chunk-X7kQ9mLp2rTv.js', 'https://cdn.test/app.css?v=a1b2c3d4e5', 'https://cdn.test/_next/static/css/0f3bd8a2c7e11a9b.css']) assert.ok(hasContentHash(u), u);
  for (const u of ['https://cdn.test/jquery-3.6.0.min.js', 'https://cdn.test/react-dom.production.min.js', 'https://cdn.test/style.css?v=12', 'https://cdn.test/images/poster.jpg', 'https://cdn.test/bootstrap.bundle.js']) assert.equal(hasContentHash(u), false, u);
});

test('upstream cache-control and expires are honoured, and no-store, private, no-cache and max-age=0 forbid', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(upstreamFreshness({ 'cache-control': 'public, max-age=600' }), { ttl: 600_000 });
  assert.deepEqual(upstreamFreshness({ 'cache-control': 'max-age=60, s-maxage=3600' }), { ttl: 3_600_000 });
  assert.deepEqual(upstreamFreshness({ expires: 'Thu, 01 Jan 2026 01:00:00 GMT' }, now), { ttl: HOUR });
  for (const h of [{ 'cache-control': 'no-store' }, { 'cache-control': 'private, max-age=600' }, { 'cache-control': 'no-cache' }, { 'cache-control': 'max-age=0' }, { expires: '0' }, { vary: 'Cookie' }, { vary: '*' }]) {
    assert.deepEqual(upstreamFreshness(h, now), { forbid: true }, JSON.stringify(h));
  }
  assert.deepEqual(upstreamFreshness({}), {});
  assert.deepEqual(upstreamFreshness(new Headers({ 'cache-control': 'max-age=5' })), { ttl: 5000 });
});

test('cache policy: lifetime defaults by kind, a week for hashed names, upstream lifetime when given', () => {
  const ok = (over) => cachePolicy({ status: 200, resHeaders: {}, ...over });
  assert.deepEqual(ok({ ctype: 'application/javascript', url: 'https://cdn.test/app.js' }), { ok: true, ttl: TTL.script, kind: 'script' });
  assert.equal(ok({ ctype: 'text/css', url: 'https://cdn.test/app.css' }).ttl, HOUR);
  assert.equal(ok({ ctype: 'image/png', url: 'https://cdn.test/a.png' }).ttl, DAY);
  assert.equal(ok({ ctype: 'font/woff2', url: 'https://cdn.test/a.woff2' }).ttl, DAY);
  assert.equal(ok({ ctype: 'application/javascript', url: 'https://cdn.test/main.3f9a1c2b.js' }).ttl, WEEK);
  assert.equal(ok({ ctype: 'application/javascript', url: 'https://cdn.test/app.js', resHeaders: { 'cache-control': 'max-age=120' } }).ttl, 120_000);
  assert.equal(ok({ ctype: 'image/png', url: 'https://cdn.test/a.png', resHeaders: { 'cache-control': 'max-age=99999999' } }).ttl, WEEK, 'never longer than a week');
});

test('cache policy refuses what must not be reused', () => {
  const no = (over) => cachePolicy({ status: 200, ctype: 'application/javascript', url: 'https://cdn.test/app.js', resHeaders: {}, ...over });
  assert.equal(no({ method: 'POST' }).reason, 'method');
  assert.equal(no({ reqHeaders: { range: 'bytes=0-100' } }).reason, 'range');
  assert.equal(no({ reqHeaders: { authorization: 'Bearer x' } }).reason, 'authorization');
  assert.equal(no({ status: 304 }).reason, 'status');
  assert.equal(no({ status: 404 }).reason, 'status');
  assert.equal(no({ ctype: 'text/html', url: 'https://portal.test/' }).reason, 'kind');
  assert.equal(no({ ctype: 'application/vnd.apple.mpegurl', url: 'https://cdn.test/i.m3u8' }).reason, 'kind');
  assert.equal(no({ ctype: 'video/mp4', url: 'https://cdn.test/v.mp4' }).reason, 'kind');
  assert.equal(no({ resHeaders: { 'set-cookie': 'sid=1' } }).reason, 'set-cookie');
  assert.equal(no({ resHeaders: new Headers([['set-cookie', 'a=1'], ['content-type', 'application/javascript']]) }).reason, 'set-cookie');
  assert.equal(no({ resHeaders: { 'cache-control': 'no-store' } }).reason, 'upstream');
  assert.equal(no({ resHeaders: { 'cache-control': 'private' } }).reason, 'upstream');
  // JSON and XML only when upstream gives a lifetime, and only small
  assert.equal(no({ ctype: 'application/json', url: 'https://api.test/list' }).reason, 'data-needs-upstream-ttl');
  assert.equal(no({ ctype: 'application/json', url: 'https://api.test/list', resHeaders: { 'cache-control': 'max-age=60' }, size: 5_000_000 }).reason, 'data-too-big');
  assert.equal(no({ ctype: 'application/json', url: 'https://api.test/list', resHeaders: { 'cache-control': 'max-age=60' }, size: 5_000 }).ok, true);
});

test('the store evicts the least recently used entries once over its byte budget, and forgets expired ones', () => {
  let t = 1000;
  const c = createCache({ maxBytes: 1000, now: () => t });        // ten entries of 100 bytes fill it
  const body = (n) => Buffer.alloc(n, 'x');
  for (const k of 'abcdefghij') assert.ok(c.set(k, { body: body(100), ttl: 10_000 }), k);
  assert.ok(c.get('a'));                                           // a is now the most recent
  assert.ok(c.set('k', { body: body(100), ttl: 10_000 }));        // 1100 > 1000: b (least recent) goes
  assert.deepEqual([c.has('a'), c.has('b'), c.has('c'), c.has('k')], [true, false, true, true]);
  assert.deepEqual({ entries: c.stats.entries, bytes: c.stats.bytes, evictions: c.stats.evictions }, { entries: 10, bytes: 1000, evictions: 1 });
  t += 10_001;
  assert.equal(c.get('a'), null, 'expired');
  assert.equal(c.stats.entries, 9);
  assert.equal(c.set('big', { body: body(5000), ttl: 10_000 }), false, 'over the per-entry size');
  assert.equal(c.set('zero', { body: body(5), ttl: 0 }), false, 'no lifetime');
  assert.equal(c.stats.hits, 1); assert.equal(c.stats.misses, 1);
});

test('a budget of zero turns the cache off', () => {
  const c = createCache({ maxBytes: 0 });
  assert.equal(c.enabled, false);
  assert.equal(c.set('a', { body: Buffer.from('x'), ttl: 1000 }), false);
  assert.equal(c.get('a'), null);
  assert.deepEqual([c.stats.hits, c.stats.misses], [0, 0]);
});

test('an entry kept per source (rewritten CSS) answers only that source', () => {
  const c = createCache({ maxBytes: 1000 });
  c.set('https://cdn.test/a.css', { body: Buffer.from('url(/x/a/...)'), ttl: 1000, sourceId: 'a' });
  assert.ok(c.get('https://cdn.test/a.css', 'a'));
  assert.equal(c.get('https://cdn.test/a.css', 'b'), null);
});

// ---- the proxy end to end, with a fake upstream ----
const sources = new Map([
  ['demo', { id: 'demo', originUrl: new URL('https://portal.test/app/'), rules: { css: [], removeOnMount: [], preserve: [], scrollRoot: '', player: 'video', touch: false } }],
  ['two', { id: 'two', originUrl: new URL('https://two.test/'), rules: { css: [], removeOnMount: [], preserve: [], scrollRoot: '', player: 'video', touch: false } }],
]);

function fakeRes() {
  const r = { status: 0, headers: {}, chunks: [], _resolve: () => {} };
  r.writeHead = (s, h) => { r.status = s; r.headers = h || {}; return r; };
  r.end = (b) => { if (b) r.chunks.push(Buffer.from(b)); r._resolve(); };
  r.write = (b) => r.chunks.push(Buffer.from(b));
  r.destroy = () => r._resolve();
  r.on = () => r; r.once = () => r; r.emit = () => false;
  r.body = () => Buffer.concat(r.chunks).toString();
  return r;
}
const req = (url, headers = {}, method = 'GET') => ({ url, method, headers: { accept: '*/*', ...headers } });

async function withFetch(responses, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, init) => {
    calls.push(String(u));
    const make = responses[String(u)];
    if (!make) throw new Error(`no fake for ${u}`);
    return make(init);
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test('the proxy answers a second request for a script from memory, with x-hub-cache and a browser lifetime', async () => {
  const proxy = createProxy({ sources, filters: compileFilters({}), cacheMb: 1 });
  const url = 'https://portal.test/app/main.js';
  await withFetch({ [url]: () => new Response('console.log(1)', { status: 200, headers: { 'content-type': 'application/javascript', 'content-length': '14' } }) }, async (calls) => {
    const a = fakeRes(); await proxy.handle(req('/p/demo/main.js'), a);
    assert.equal(a.status, 200); assert.equal(a.headers['x-hub-cache'], 'miss'); assert.equal(a.body(), 'console.log(1)');
    assert.equal(a.headers['cache-control'], 'public, max-age=3600');
    const b = fakeRes(); await proxy.handle(req('/p/demo/main.js'), b);
    assert.equal(b.status, 200); assert.equal(b.headers['x-hub-cache'], 'hit'); assert.equal(b.body(), 'console.log(1)');
    assert.equal(b.headers['x-hub-source'], 'demo'); assert.equal(b.headers['content-length'], '14');
    assert.match(b.headers['cache-control'], /^public, max-age=\d+$/);
    assert.equal(calls.length, 1, 'the internet was asked once');
    assert.deepEqual([proxy.cache.stats.hits, proxy.cache.stats.misses, proxy.cache.stats.entries], [1, 1, 1]);
  });
});

test('HTML pages are never cached and stay no-store; a range request goes upstream every time', async () => {
  const proxy = createProxy({ sources, filters: compileFilters({}), cacheMb: 1 });
  const page = 'https://portal.test/app/', seg = 'https://portal.test/app/v/seg1.ts';
  await withFetch({
    [page]: () => new Response('<html><head></head><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    [seg]: () => new Response('tsdata', { status: 206, headers: { 'content-type': 'video/mp2t' } }),
  }, async (calls) => {
    for (let i = 0; i < 2; i++) {
      const r = fakeRes(); await proxy.handle(req('/p/demo/', { accept: 'text/html' }), r);
      assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-hub-cache'], 'miss');
      const s = fakeRes(); await proxy.handle(req('/p/demo/v/seg1.ts', { range: 'bytes=0-5' }), s);
      assert.equal(s.headers['x-hub-cache'], 'miss');
    }
    assert.equal(calls.length, 4);
    assert.equal(proxy.cache.stats.entries, 0);
  });
});

test('a response that sets a cookie is not kept', async () => {
  const proxy = createProxy({ sources, filters: compileFilters({}), cacheMb: 1 });
  const url = 'https://portal.test/app/a.js';
  await withFetch({ [url]: () => new Response('x', { status: 200, headers: { 'content-type': 'text/javascript', 'set-cookie': 'sid=1; Path=/' } }) }, async (calls) => {
    const a = fakeRes(); await proxy.handle(req('/p/demo/a.js'), a);
    assert.deepEqual(a.headers['set-cookie'], ['s_demo__sid=1; Path=/']);
    assert.equal(a.headers['cache-control'], undefined);
    const b = fakeRes(); await proxy.handle(req('/p/demo/a.js'), b);
    assert.equal(b.headers['x-hub-cache'], 'miss');
    assert.equal(calls.length, 2);
  });
});

test('rewritten CSS is kept per source: another source fetching the same stylesheet gets its own rewrite', async () => {
  const proxy = createProxy({ sources, filters: compileFilters({}), cacheMb: 1 });
  const url = 'https://cdn.test/t.css';
  await withFetch({ [url]: () => new Response('a{background:url(https://cdn.test/i.png)}', { status: 200, headers: { 'content-type': 'text/css' } }) }, async (calls) => {
    const enc = encodeURIComponent(url);
    const a = fakeRes(); await proxy.handle(req(`/x/demo/${enc}`, { accept: 'text/css' }), a);
    assert.equal(a.headers['x-hub-cache'], 'miss'); assert.match(a.body(), /url\(\/x\/demo\//);
    assert.equal(a.headers['cache-control'], 'public, max-age=3600');
    const b = fakeRes(); await proxy.handle(req(`/x/demo/${enc}`, { accept: 'text/css' }), b);
    assert.equal(b.headers['x-hub-cache'], 'hit'); assert.match(b.body(), /url\(\/x\/demo\//);
    const c = fakeRes(); await proxy.handle(req(`/x/two/${enc}`, { accept: 'text/css' }), c);
    assert.equal(c.headers['x-hub-cache'], 'miss'); assert.match(c.body(), /url\(\/x\/two\//);
    assert.equal(calls.length, 2);
  });
});

test('with HUB_CACHE_MB=0 nothing is kept and rewritten CSS stays no-store', async () => {
  const proxy = createProxy({ sources, filters: compileFilters({}), cacheMb: 0 });
  const url = 'https://portal.test/app/t.css';
  await withFetch({ [url]: () => new Response('a{}', { status: 200, headers: { 'content-type': 'text/css' } }) }, async (calls) => {
    for (let i = 0; i < 2; i++) {
      const r = fakeRes(); await proxy.handle(req('/p/demo/t.css', { accept: 'text/css' }), r);
      assert.equal(r.headers['x-hub-cache'], 'off'); assert.equal(r.headers['cache-control'], 'no-store');
    }
    assert.equal(calls.length, 2);
  });
});
