import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../server/ingest/catalog.js';
import { normaliseRecord } from '../server/ingest/normalise.js';

test('re-ingesting unchanged items does not move the delta cursor', () => {
  const c = new Catalog(':memory:');
  const items = [
    normaliseRecord({ title: 'Red Static (2018)', url: 'http://a/1', image: 'http://a/1.jpg' }, 'a'),
    normaliseRecord({ title: 'Red.Static.2018.1080p', url: 'http://b/9' }, 'b'),
  ];
  let r = c.upsertMany(items);
  assert.equal(r.inserted, 1); assert.equal(r.merged, 1); assert.equal(r.changed, 2);
  const head1 = c.seq;
  assert.equal(c.since(0).items.length, 1);
  assert.equal(c.since(0).items[0].sources.length, 2);

  r = c.upsertMany(items);
  assert.equal(r.changed, 0);
  assert.equal(c.seq, head1, 'cursor unchanged on identical re-ingest');
  assert.equal(c.since(head1).items.length, 0);

  // A changed link bumps it.
  items[1].sources[0].itemUrl = 'http://b/10';
  r = c.upsertMany(items);
  assert.equal(r.changed, 1);
  assert.ok(c.seq > head1);
  assert.equal(c.since(head1).items[0].sources.find((s) => s.sourceId === 'b').itemUrl, 'http://b/10');

  // Artwork becoming available bumps the owning item.
  const head2 = c.seq;
  c.setArtworkHash('http://a/1.jpg', 'abc', 300, 450);
  assert.ok(c.seq > head2);
  assert.equal(c.since(head2).items[0].artwork[0].hash, 'abc');
  c.close();
});

test('removing a source drops the titles only it provided and re-sends shared ones', () => {
  const c = new Catalog(':memory:');
  c.upsertMany([
    normaliseRecord({ title: 'Red Static (2018)', url: 'http://a/1', image: 'http://a/1.jpg' }, 'a'),
    normaliseRecord({ title: 'Red Static (2018)', url: 'http://b/1' }, 'b'),
    normaliseRecord({ title: 'Only On A (2019)', url: 'http://a/2' }, 'a'),
  ]);
  const head = c.seq;
  assert.equal(c.count(), 2);
  assert.deepEqual(c.removeSource('a'), { removed: 1, kept: 1 });
  assert.equal(c.count(), 1);
  const delta = c.since(head);
  assert.equal(delta.items.length, 1);
  assert.deepEqual(delta.items[0].sources.map((s) => s.sourceId), ['b']);
  assert.deepEqual(c.removeSource('zzz'), { removed: 0, kept: 0 });
  c.close();
});
