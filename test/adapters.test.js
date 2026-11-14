import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlItems, getPath } from '../server/ingest/adapters.js';
import { Catalog } from '../server/ingest/catalog.js';
import { Scheduler } from '../server/ingest/scheduler.js';

const feed = {
  itemRegex: '<li class="item"><a href="(?<url>[^"]+)"[^>]*>(?<title>.*?)</a>\\s*<img src="(?<image>[^"]+)">\\s*<span class="y">(?<year>\\d{4})</span>',
  nextRegex: '<a class="next" href="(?<url>[^"]+)"',
};
const html = `
<ul>
  <li class="item"><a href="/watch/1" class="t">Harbour Lights &amp; Fog</a> <img src="/p/1.jpg"> <span class="y">2023</span></li>
  <li class="item"><a href="/watch/2" class="t"><b>Copper</b> Sky</a> <img src="https://cdn.test/2.jpg"> <span class="y">2017</span></li>
</ul>
<a class="next" href="?page=2">Next</a>`;

test('html list extraction resolves urls, decodes entities, strips tags, finds next page', () => {
  const { items, next } = extractHtmlItems(html, feed, 'https://portal.test/list');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: 'Harbour Lights & Fog', year: '2023', kind: undefined, url: 'https://portal.test/watch/1', image: 'https://portal.test/p/1.jpg' });
  assert.equal(items[1].title, 'Copper Sky');
  assert.equal(items[1].image, 'https://cdn.test/2.jpg');
  assert.equal(next, 'https://portal.test/list?page=2');
});

test('no next regex means a single page', () => {
  const { next } = extractHtmlItems(html, { itemRegex: feed.itemRegex }, 'https://portal.test/list');
  assert.equal(next, null);
});

test('getPath walks dotted paths', () => {
  assert.equal(getPath({ a: { b: [1, 2] } }, 'a.b.1'), 2);
  assert.equal(getPath({ a: null }, 'a.b'), undefined);
});

// Distinct names: near-identical titles would merge into one in the catalog.
const NAMES = ['Harbour Lights', 'Copper Sky', 'Salt and Signal', 'Orbital Decay', 'Red Static', 'Blue Hour', 'Northern Lights', 'The Quiet Harbour', 'Paper Trail', 'Glass Mountain', 'Winter Road', 'Iron Garden', 'Silent Running', 'Last Train Home'];
const frontPage = (n) => `<html><body>${NAMES.slice(0, n).map((name, i) => `<a href="/movies/${i}/${name.toLowerCase().replace(/ /g, '-')}"><img alt="${name} (2020)" src="/f${i}.jpg"></a>`).join('')}</body></html>`;

test('a front-page feed is pulled with each title ranked in page order, and a later pull drops what left the page', async () => {
  let html = frontPage(14);
  const fetchText = async (url) => ({ text: html, type: 'text/html', url });
  const sources = new Map([['s', { id: 's', feed: { type: 'frontpage', url: 'https://site.test/' }, intervalSec: 3600 }]]);
  const catalog = new Catalog(':memory:');
  const sched = new Scheduler({ sources, catalog, fetchText });
  try {
    let summary = await sched.run('s');
    assert.equal(summary.error, null);
    assert.equal(summary.items, 14);
    let items = catalog.since(0).items;
    assert.deepEqual(items.map((i) => i.sources[0].rank), Array.from({ length: 14 }, (_, i) => i + 1));
    assert.equal(items[0].title, 'Harbour Lights');
    assert.equal(items[0].year, 2020);
    assert.equal(items[0].artwork[0].url, 'https://site.test/f0.jpg');

    html = frontPage(13);   // the last title is off the page now
    const head = catalog.seq;
    summary = await sched.run('s');
    assert.equal(summary.left, 1);
    items = catalog.since(head).items;
    assert.deepEqual(items.map((i) => [i.title, i.sources[0].rank]), [['Last Train Home', null]]);
  } finally { sched.stop(); catalog.close(); }
});
