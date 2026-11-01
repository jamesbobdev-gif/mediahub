import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlItems, getPath } from '../server/ingest/adapters.js';

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
