import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy, isPrivateHost, scopeSetCookie, unscopeCookieHeader } from '../server/proxy.js';
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
