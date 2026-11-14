import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sourceIdFor, siteOf, hostPattern, parseAddress, addSource, removeSource, allowHost, patchSourceRules, loadSources } from '../server/sources.js';

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
