import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sourceIdFor, siteOf, hostPattern, parseAddress, addSource, removeSource, allowHost, patchSourceRules, loadSources, ownHostPatterns, brandOf, setSourceFields, reloadSources, settleAddress, openWebsite, pruneTemporary, TEMP_LIMIT } from '../server/sources.js';

function tempFile(list) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'hub-sources-')), 'sources.json');
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  return file;
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('source ids come from the name and stay unique', () => {
  assert.equal(sourceIdFor('Pluto TV'), 'pluto-tv');
  assert.equal(sourceIdFor('  Télé Québec!  '), 'tele-quebec');
  assert.equal(sourceIdFor('Pluto TV', new Set(['pluto-tv'])), 'pluto-tv-2');
  assert.equal(sourceIdFor('Pluto TV', new Set(['pluto-tv', 'pluto-tv-2'])), 'pluto-tv-3');
  assert.equal(sourceIdFor('!!!'), 'source');
});

test('a blocked host is allowed as its whole site', () => {
  assert.equal(siteOf('abproxy.production-public.tubi.io'), 'tubi.io');
  assert.equal(siteOf('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('static.example.com.au'), 'example.com.au');
  assert.equal(siteOf('pluto.tv'), 'pluto.tv');
  assert.equal(siteOf('192.168.1.5'), '192.168.1.5');
  assert.equal(hostPattern('tubi.io'), '(^|\\.)tubi\\.io$');
  assert.equal(hostPattern('192.168.1.5'), '^192\\.168\\.1\\.5$');
  const re = new RegExp(hostPattern('tubi.io'), 'i');
  assert.ok(re.test('abproxy.production-public.tubi.io'));
  assert.ok(re.test('tubi.io'));
  assert.equal(re.test('nottubi.io'), false);
  assert.equal(re.test('tubi.io.evil.test'), false);
});

test('an address typed on the TV becomes an origin and a home page', () => {
  assert.deepEqual(parseAddress('tubitv.com'), { origin: 'https://tubitv.com', home: '/' });
  assert.deepEqual(parseAddress(' https://pluto.tv/us/on-demand?x=1 '), { origin: 'https://pluto.tv', home: '/us/on-demand?x=1' });
  assert.deepEqual(parseAddress('http://192.168.1.5:32400/web'), { origin: 'http://192.168.1.5:32400', home: '/web' });
  assert.throws(() => parseAddress(''), /empty/);
  assert.throws(() => parseAddress('ftp://x.test/'), /http/);
  assert.throws(() => parseAddress('not a url at all'), /web address/);
});

test('adding a source writes an entry the loader accepts, with its own site allowed', () => {
  const file = tempFile([{ id: 'demo', name: 'Demo', origin: 'http://127.0.0.1:8787', home: '/demo/' }]);
  const entry = addSource(file, { name: 'Pluto TV', address: 'pluto.tv/us/on-demand' });
  assert.equal(entry.id, 'pluto-tv');
  assert.deepEqual(entry.allowHosts, ['(^|\\.)pluto\\.tv$']);
  const list = read(file);
  assert.equal(list.length, 2);
  assert.deepEqual(list[1], { id: 'pluto-tv', name: 'Pluto TV', origin: 'https://pluto.tv', home: '/us/on-demand', allowHosts: ['(^|\\.)pluto\\.tv$'] });
  const loaded = loadSources(file);
  assert.equal(loaded.get('pluto-tv').originUrl.origin, 'https://pluto.tv');
  assert.equal(loaded.get('pluto-tv').rules.player, 'video');
  assert.throws(() => addSource(file, { name: '', address: 'x.test' }), /name/);
  assert.throws(() => addSource(file, { name: 'X', address: '' }), /address/);
  assert.equal(read(file).length, 2, 'a refused add writes nothing');
});

test('removing a source drops only that entry', () => {
  const file = tempFile([{ id: 'a', name: 'A', origin: 'https://a.test' }, { id: 'b', name: 'B', origin: 'https://b.test' }]);
  assert.equal(removeSource(file, 'a').name, 'A');
  assert.deepEqual(read(file).map((s) => s.id), ['b']);
  assert.throws(() => removeSource(file, 'zzz'), /unknown source/);
});

test('allowing a host adds its site pattern once and keeps the rest of the entry', () => {
  const file = tempFile([{ id: 'tubi', name: 'Tubi', origin: 'https://tubitv.com', allowHosts: ['(^|\\.)tubitv\\.com$'], rules: { css: ['.promo'] } }]);
  let r = allowHost(file, 'tubi', 'abproxy.production-public.tubi.io');
  assert.deepEqual(r, { site: 'tubi.io', pattern: '(^|\\.)tubi\\.io$', added: true });
  r = allowHost(file, 'tubi', 'realtime-logger.production-public.tubi.io');
  assert.equal(r.added, false);
  const s = read(file)[0];
  assert.deepEqual(s.allowHosts, ['(^|\\.)tubitv\\.com$', '(^|\\.)tubi\\.io$']);
  assert.deepEqual(s.rules, { css: ['.promo'] });
  assert.throws(() => allowHost(file, 'nope', 'x.test'), /unknown source/);
  assert.throws(() => allowHost(file, 'tubi', ''), /host name/);
  assert.throws(() => allowHost(file, 'tubi', 'bad host'), /host name/);
});

test('a rules patch merges lists and sets scalars', () => {
  const file = tempFile([{ id: 'a', name: 'A', origin: 'https://a.test', rules: { css: ['.x'] } }]);
  const rules = patchSourceRules(file, 'a', { css: ['.y', '.x'], dark: true, bogus: 1 });
  assert.deepEqual(rules, { css: ['.x', '.y'], dark: true });
  assert.deepEqual(read(file)[0].rules, { css: ['.x', '.y'], dark: true });
});

test("a site's own hosts are allowed without being listed: the site, and a sibling carrying its name", () => {
  const allowed = (origin, host) => ownHostPatterns(new URL(origin).hostname).some((re) => re.test(host));
  assert.ok(allowed('https://vimeo.com', 'f.vimeocdn.com'));
  assert.ok(allowed('https://www.vimeo.com', 'player.vimeo.com'));
  assert.ok(allowed('https://tubitv.com', 'abproxy.production-public.tubi.io'));
  assert.ok(allowed('https://watch.plex.tv', 'x.plex.direct'));
  assert.equal(allowed('https://vimeo.com', 'vimeo.evil.com'), false, 'the name must be the site itself');
  assert.equal(allowed('https://vimeo.com', 'vimeo-ads.com'), false, 'only letters and digits may follow the name');
  assert.equal(allowed('https://vimeo.com', 'ads.doubleclick.net'), false);
  assert.equal(allowed('https://pbs.org', 'pbskids.org'), false, 'a three-letter name is too short to trust');
  assert.equal(allowed('http://192.168.1.5:8080', '192.168.1.50'), false);
  assert.ok(allowed('http://192.168.1.5:8080', '192.168.1.5'));
  assert.equal(brandOf('tubitv.com'), 'tubi'); assert.equal(brandOf('pluto.tv'), 'pluto'); assert.equal(brandOf('app.roku.com'), 'roku'); assert.equal(brandOf('pbs.org'), null);
  const s = loadSources(tempFile([{ id: 'v', origin: 'https://vimeo.com', home: '/' }])).get('v');
  assert.ok(s.allowHostsRe.some((re) => re.test('f.vimeocdn.com')));
});

test('the start page and the browser a source is fetched as can be changed, on the same site only', () => {
  const file = tempFile([{ id: 'yt', name: 'YouTube', origin: 'https://www.youtube.com', home: '/' }]);
  let s = setSourceFields(file, 'yt', { home: 'tv', userAgent: 'tv' });
  assert.equal(s.home, '/tv'); assert.equal(s.userAgent, 'tv');
  s = setSourceFields(file, 'yt', { home: 'https://www.youtube.com/feed/trending?x=1' });
  assert.equal(s.home, '/feed/trending?x=1');
  assert.throws(() => setSourceFields(file, 'yt', { home: 'https://other.test/tv' }), /same site/);
  s = setSourceFields(file, 'yt', { userAgent: 'desktop', name: ' YouTube TV ' });
  assert.equal(s.userAgent, undefined); assert.equal(s.name, 'YouTube TV');
  assert.deepEqual(read(file)[0], { id: 'yt', name: 'YouTube TV', origin: 'https://www.youtube.com', home: '/feed/trending?x=1' });
  assert.throws(() => setSourceFields(file, 'nope', { home: '/' }), /unknown source/);
});

test('a typed address opens as a source kept in memory, never written to the file', () => {
  const file = tempFile([{ id: 'demo', name: 'Demo', origin: 'http://127.0.0.1:8787', home: '/demo/' }]);
  const sources = loadSources(file);
  const r = openWebsite(sources, parseAddress('bbc.com/news'), { now: 1000 });
  assert.equal(r.saved, false);
  assert.equal(r.path, '/p/web-bbc-com/news');
  assert.equal(r.source.id, 'web-bbc-com');
  assert.equal(r.source.name, 'bbc.com');
  assert.equal(r.source.temporary, true);
  assert.equal(r.source.originUrl.origin, 'https://bbc.com');
  assert.ok(r.source.allowHostsRe.some((re) => re.test('static.bbc.com')), 'its own site is allowed');
  assert.equal(r.source.rules.player, 'video', 'prepared like a loaded source');
  assert.equal(read(file).length, 1, 'the file is untouched');
  // The same site again reuses the entry; another page of it is just another path.
  const again = openWebsite(sources, parseAddress('https://bbc.com/sport'), { now: 2000 });
  assert.equal(again.source, r.source);
  assert.equal(again.path, '/p/web-bbc-com/sport');
  assert.equal(again.source.openedAt, 2000);
  assert.equal([...sources.keys()].filter((id) => id.startsWith('web-')).length, 1);
  // A reload of the file keeps it, and it is neither added nor removed.
  const diff = reloadSources(file, sources);
  assert.deepEqual(diff, { added: [], removed: [] });
  assert.ok(sources.has('web-bbc-com'));
});

test('an address on a saved source opens that source instead', () => {
  const sources = loadSources(tempFile([
    { id: 'tubi', name: 'Tubi', origin: 'https://tubitv.com', home: '/' },
    { id: 'demo', name: 'Demo', origin: 'http://127.0.0.1:8787/demo/', home: '/' },
  ]));
  let r = openWebsite(sources, parseAddress('tubitv.com/movies'));
  assert.deepEqual([r.saved, r.path, r.source.id], [true, '/p/tubi/movies', 'tubi']);
  r = openWebsite(sources, parseAddress('http://127.0.0.1:8787/demo/list'));
  assert.deepEqual([r.saved, r.path], [true, '/p/demo/list'], 'a source with a base path strips it');
  r = openWebsite(sources, parseAddress('http://127.0.0.1:8787/other'));
  assert.equal(r.saved, false, 'a page outside the base path is its own website');
  r = openWebsite(sources, parseAddress('www.tubitv.com'));
  assert.equal(r.saved, false, 'a different host of the site is opened on its own');
  assert.equal(r.source.id, 'web-tubitv-com');
  assert.equal(sources.size, 4);
});

test('only the last twenty opened websites are kept', () => {
  const sources = new Map();
  for (let i = 0; i < TEMP_LIMIT + 3; i++) openWebsite(sources, parseAddress(`site${i}.test`), { now: i });
  assert.equal(sources.size, TEMP_LIMIT);
  assert.equal(sources.has('web-site0-test'), false);
  assert.equal(sources.has('web-site2-test'), false);
  assert.ok(sources.has('web-site3-test'));
  assert.ok(sources.has(`web-site${TEMP_LIMIT + 2}-test`));
  assert.deepEqual(pruneTemporary(sources, 2).length, TEMP_LIMIT - 2);
  assert.deepEqual([...sources.keys()].sort(), [`web-site${TEMP_LIMIT + 1}-test`, `web-site${TEMP_LIMIT + 2}-test`], 'the two opened last stay');
  assert.equal(sources.size, 2);
});

test('a typed address settles where its own site sends it, and nowhere else', async () => {
  const hops = [];
  const fetchFn = async (url) => {
    hops.push(url);
    const reply = (status, location) => ({ status, headers: new Headers(location ? { location } : {}), body: { cancel() {} } });
    if (url === 'https://bbc.com/news') return reply(301, 'https://www.bbc.com/news');
    if (url === 'https://www.bbc.com/news') return reply(302, '/news/world');
    if (url === 'https://leaves.test/') return reply(301, 'https://elsewhere.test/');
    if (url === 'https://loop.test/') return reply(301, 'https://loop.test/');
    if (url === 'https://down.test/') throw new Error('connect ECONNREFUSED');
    return reply(200);
  };
  assert.deepEqual(await settleAddress('bbc.com/news', { fetchFn }), { origin: 'https://www.bbc.com', home: '/news/world' });
  assert.deepEqual(hops, ['https://bbc.com/news', 'https://www.bbc.com/news', 'https://www.bbc.com/news/world']);
  assert.deepEqual(await settleAddress('leaves.test', { fetchFn }), { origin: 'https://leaves.test', home: '/' }, 'a redirect to another site is not followed');
  assert.deepEqual(await settleAddress('down.test', { fetchFn }), { origin: 'https://down.test', home: '/' }, 'an error keeps the address as typed');
  hops.length = 0;
  await settleAddress('loop.test', { fetchFn, hops: 3 });
  assert.equal(hops.length, 3, 'a loop stops after the allowed hops');
  await assert.rejects(settleAddress('', { fetchFn }), /empty/);
});
