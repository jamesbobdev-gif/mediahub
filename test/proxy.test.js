import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy, isPrivateHost, scopeSetCookie, unscopeCookieHeader, noteBlockedHost, blockedHostsFor, sourceFromHeaders , userAgentFor } from '../server/proxy.js';
import { compileFilters } from '../server/filters.js';

const sources = new Map([['demo', { id: 'demo', originUrl: new URL('https://portal.test/app/'), rules: { css: ['.hero'], removeOnMount: [], preserve: ['.grid'], scrollRoot: '.grid', player: 'video', touch: false } }]]);
const proxy = createProxy({ sources, filters: compileFilters({}) });

test('first-party URLs map under /p/, third-party under /x/', () => {
  const s = sources.get('demo');
  assert.equal(proxy.hubUrlFor('https://portal.test/app/list?x=1', s), '/p/demo/list?x=1');
  assert.equal(proxy.hubUrlFor('https://portal.test/other.css', s), '/p/demo/other.css');
  assert.equal(proxy.hubUrlFor('https://cdn.test/a.js', s), '/x/demo/' + encodeURIComponent('https://cdn.test/a.js'));
});

test('home-network and loopback addresses are recognised as private', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.9.9', '172.31.255.1', '169.254.1.1', '::1', 'fd00::1', 'router', 'nas.local']) assert.ok(isPrivateHost(h), h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2606:4700::1111', 'cdn.portal.test']) assert.equal(isPrivateHost(h), false, h);
});

test('cookies are scoped per source and never leak across sources', () => {
  const s = { id: 'a' };
  assert.equal(scopeSetCookie('sid=abc; Path=/; Domain=.portal.test; Secure; SameSite=None; HttpOnly', s), 's_a__sid=abc; Path=/; HttpOnly');
  assert.equal(unscopeCookieHeader('s_a__sid=abc; s_b__sid=zzz; hub_pref=1', s), 'sid=abc');
  assert.equal(unscopeCookieHeader('s_b__sid=zzz', s), '');
});

test('HLS playlists have every segment, key and variant URI routed through the hub', () => {
  const m3u8 = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.cdn.test/k1"', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4.0,', 'seg1.ts', '#EXTINF:4.0,', 'https://cdn.test/v/seg2.ts', ''].join('\n');
  const out = proxy.rewriteM3u8(m3u8, sources.get('demo'), 'https://portal.test/app/stream/index.m3u8');
  assert.match(out, /URI="\/x\/demo\/https%3A%2F%2Fkeys\.cdn\.test%2Fk1"/);
  assert.match(out, /URI="\/p\/demo\/stream\/init\.mp4"/);
  assert.match(out, /^\/p\/demo\/stream\/seg1\.ts$/m);
  assert.match(out, /^\/x\/demo\/https%3A%2F%2Fcdn\.test%2Fv%2Fseg2\.ts$/m);
  assert.doesNotMatch(out, /^https:/m);
});

test('DASH manifests have BaseURL and segment template attributes routed through the hub', () => {
  const mpd = '<MPD><BaseURL>https://cdn.test/d/</BaseURL><SegmentTemplate media="chunk-$Number$.m4s" initialization="init.mp4"/></MPD>';
  const out = proxy.rewriteMpd(mpd, sources.get('demo'), 'https://portal.test/app/stream/manifest.mpd');
  assert.match(out, /<BaseURL>\/x\/demo\/https%3A%2F%2Fcdn\.test%2Fd%2F<\/BaseURL>/);
  assert.match(out, /media="\/p\/demo\/stream\/chunk-\$Number\$\.m4s"/);
  assert.match(out, /initialization="\/p\/demo\/stream\/init\.mp4"/);
});

test('meta refresh redirects are routed through the hub, never to an external site directly', () => {
  const out = proxy.rewriteHtml('<html><head><meta http-equiv="refresh" content="0;url=https://evil.test/land"><meta http-equiv="refresh" content="2; URL=/app/next"></head></html>', sources.get('demo'), 'https://portal.test/app/index.html');
  assert.doesNotMatch(out, /url=https:\/\/evil\.test/);
  assert.match(out, /url=\/x\/demo\/https%3A%2F%2Fevil\.test%2Fland/);
  assert.match(out, /URL=\/p\/demo\/next/);
});

test('html rewrite injects viewport, rules, content script and rewrites urls', () => {
  const out = proxy.rewriteHtml('<html><head><meta name="viewport" content="width=device-width"><link href="style.css" rel="stylesheet"></head><body><a href="/app/x">x</a><img src="https://cdn.test/i.png"><div style="background:url(bg.png)"></div></body></html>', sources.get('demo'), 'https://portal.test/app/index.html');
  assert.match(out, /<meta name="viewport" content="width=1280">/);
  assert.equal((out.match(/name="viewport"/g) || []).length, 1);
  assert.match(out, /window\.__HUB_RULES=\{"sourceId":"demo"/);
  assert.match(out, /src="\/shell\/inject\/content\.js"/);
  assert.match(out, /href="\/p\/demo\/style\.css"/);
  assert.match(out, /href="\/p\/demo\/x"/);
  assert.match(out, /src="\/x\/demo\/https%3A%2F%2Fcdn\.test%2Fi\.png"/);
  assert.match(out, /url\(\/p\/demo\/bg\.png\)/);
  assert.match(out, /\.hero\{display:none !important\}/);
});

test('blocked third-party hosts are kept per source for the Settings screen; ad-list blocks are not', () => {
  const map = new Map();
  noteBlockedHost(map, 'tubi', 'abproxy.tubi.io', { block: true, reason: 'third-party-other:abproxy.tubi.io', destination: 'other' });
  noteBlockedHost(map, 'tubi', 'abproxy.tubi.io', { block: true, reason: 'third-party-script:abproxy.tubi.io', destination: 'script' });
  noteBlockedHost(map, 'tubi', 'cdn.tubi.io', { block: true, reason: 'third-party-xhr:cdn.tubi.io', destination: 'xhr' });
  noteBlockedHost(map, 'tubi', 'ads.doubleclick.net', { block: true, reason: 'host:(^|\\.)doubleclick\\.net$', destination: 'script' });
  noteBlockedHost(map, 'tubi', 'img.tubi.io', { block: false, destination: 'image' });
  noteBlockedHost(map, 'pluto', 'api.pluto.tv', { block: true, reason: 'third-party-xhr:api.pluto.tv', destination: 'xhr' });
  const tubi = blockedHostsFor(map, 'tubi');
  assert.deepEqual(tubi.map((e) => [e.host, e.count, e.kinds]), [['abproxy.tubi.io', 2, ['other', 'script']], ['cdn.tubi.io', 1, ['xhr']]]);
  assert.deepEqual(blockedHostsFor(map, 'pluto').map((e) => e.host), ['api.pluto.tv']);
  assert.deepEqual(blockedHostsFor(map, 'none'), []);
});

test('the proxy forgets blocks an allow pattern now covers', () => {
  const p = createProxy({ sources, filters: compileFilters({}) });
  noteBlockedHost(p.stats.blockedHosts, 'demo', 'a.cdn.test', { block: true, reason: 'third-party-script:a.cdn.test', destination: 'script' });
  noteBlockedHost(p.stats.blockedHosts, 'demo', 'b.other.test', { block: true, reason: 'third-party-script:b.other.test', destination: 'script' });
  p.forgetBlocked('demo', /(^|\.)cdn\.test$/i);
  assert.deepEqual(p.blockedHosts('demo').map((e) => e.host), ['b.other.test']);
});

test('a request without the hub prefix is mapped to the source named by the hub cookie or the referer', () => {
  assert.equal(sourceFromHeaders({ cookie: 's_demo__sid=1; hub_source=demo' }, sources)?.id, 'demo');
  assert.equal(sourceFromHeaders({ referer: 'http://192.168.1.200:8788/p/demo/list?x=1' }, sources)?.id, 'demo');
  assert.equal(sourceFromHeaders({ cookie: 'hub_source=nope', referer: 'http://192.168.1.200:8788/p/demo/' }, sources)?.id, 'demo');
  assert.equal(sourceFromHeaders({ cookie: 'hub_source=nope' }, sources), null);
  assert.equal(sourceFromHeaders({}, sources), null);
  assert.equal(unscopeCookieHeader('hub_source=demo; s_demo__sid=abc', { id: 'demo' }), 'sid=abc', 'the hub cookie never goes upstream');
});

test('a page on an https portal asking for plain http gets https, and bare paths follow the hub cookie', () => {
  const enc = encodeURIComponent;
  assert.equal(proxy.resolve({ url: '/x/demo/' + enc('http://cdn.test/a.js'), headers: {} }).upstream.href, 'https://cdn.test/a.js');
  assert.equal(proxy.resolve({ url: '/x/demo/' + enc('https://cdn.test/b.js'), headers: {} }).upstream.href, 'https://cdn.test/b.js');
  assert.equal(proxy.resolve({ url: '/p/demo/list?x=1', headers: {} }).upstream.href, 'https://portal.test/app/list?x=1');
  const bare = proxy.resolve({ url: '/oz/auth?x=1', headers: { cookie: 'hub_source=demo' } });
  assert.equal(bare.upstream.href, 'https://portal.test/app/oz/auth?x=1');
  assert.equal(bare.firstParty, true);
  assert.equal(proxy.resolve({ url: '/oz/auth', headers: {} }), null);
});

test('attribute URLs are HTML-decoded before routing: &amp; becomes & upstream, never a parameter named amp;', () => {
  const out = proxy.rewriteHtml('<html><head></head><body><iframe src="https://player.test/video/1?h=abc&amp;badge=0"></iframe><a href="/app/list?a=1&amp;b=2">x</a></body></html>', sources.get('demo'), 'https://portal.test/app/index.html');
  assert.match(out, /src="\/x\/demo\/https%3A%2F%2Fplayer\.test%2Fvideo%2F1%3Fh%3Dabc%26badge%3D0"/);
  assert.doesNotMatch(out, /%26amp%3B/);
  assert.match(out, /href="\/p\/demo\/list\?a=1&amp;b=2"/);
});

test('css url() is rewritten in style blocks and style attributes, and left alone inside scripts', () => {
  const html = '<html><head><style>.a{background:url(bg.png)}</style><script>function f(qs){return new URL(qs, base)} var u = url(x)</script></head><body><div style="background:url(&quot;i.png&quot;)"></div></body></html>';
  const out = proxy.rewriteHtml(html, sources.get('demo'), 'https://portal.test/app/index.html');
  assert.match(out, /<style>\.a\{background:url\(\/p\/demo\/bg\.png\)\}<\/style>/);
  assert.match(out, /style="background:url\(&quot;\/p\/demo\/i\.png&quot;\)"/);
  assert.match(out, /return new URL\(qs, base\)\} var u = url\(x\)/);
});

test('a portal page may be framed by the shell and by another hub page (an embedded player)', async () => {
  const p = createProxy({ sources, filters: compileFilters({}), cacheMb: 0 });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><head></head><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    const res = { writeHead(s, h) { this.status = s; this.headers = h; return this; }, end() {}, destroy() {}, on() { return this; } };
    await p.handle({ url: '/p/demo/', method: 'GET', headers: { accept: 'text/html' }, hubShellOrigin: 'http://tv:8787' }, res);
    assert.match(res.headers['content-security-policy'], /^frame-ancestors http:\/\/tv:8787 'self'; /);
  } finally { globalThis.fetch = real; }
});

test('script addresses written out in full inside inline scripts are routed, so import(url) stays inside the hub', () => {
  const html = '<html><head><script>window.cfg={"js_module":"https://cdn.test/p/1/player.module.js","api":"https://api.test/v1","escaped":"https:\\/\\/cdn.test\\/v.js"};import(cfg.js_module)</script><script src="https://cdn.test/a.js"></script></head><body></body></html>';
  const out = proxy.rewriteHtml(html, sources.get('demo'), 'https://portal.test/app/index.html');
  assert.match(out, /"js_module":"\/x\/demo\/https%3A%2F%2Fcdn\.test%2Fp%2F1%2Fplayer\.module\.js"/);
  assert.match(out, /"api":"https:\/\/api\.test\/v1"/, 'a plain address stays as it is');
  assert.ok(out.includes('"escaped":"\\/x\\/demo\\/https%3A%2F%2Fcdn.test%2Fv.js"'), 'JSON escaping is kept: ' + out);
  assert.match(out, /<script src="\/x\/demo\/https%3A%2F%2Fcdn\.test%2Fa\.js">/);
});

test('a proxied script has its full script addresses routed too, and is kept per source', async () => {
  const p = createProxy({ sources, filters: compileFilters({}), cacheMb: 1 });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('const m = "https://portal.test/app/chunk.js"; import(m);', { status: 200, headers: { 'content-type': 'application/javascript' } });
  try {
    const res = { chunks: [], writeHead(s, h) { this.status = s; this.headers = h; return this; }, end(b) { if (b) this.chunks.push(Buffer.from(b)); }, destroy() {}, on() { return this; } };
    await p.handle({ url: '/p/demo/main.js', method: 'GET', headers: {} }, res);
    assert.equal(Buffer.concat(res.chunks).toString(), 'const m = "/p/demo/chunk.js"; import(m);');
    assert.equal(p.cache.stats.entries, 1);
  } finally { globalThis.fetch = real; }
});

test('a source is fetched as a desktop browser unless it asks for a TV one or names its own', () => {
  assert.match(userAgentFor({}), /X11; Linux x86_64/);
  assert.match(userAgentFor({ userAgent: 'desktop' }), /X11; Linux x86_64/);
  assert.match(userAgentFor({ userAgent: 'tv' }), /SMART-TV/);
  assert.equal(userAgentFor({ userAgent: 'Custom/1.0' }), 'Custom/1.0');
});
