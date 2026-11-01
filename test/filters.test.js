import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFilters, classify, placeholderFor, destinationFor } from '../server/filters.js';

const f = compileFilters({ hosts: ['(^|\\.)ads\\.example$'], paths: ['/track(ing)?/', 'pop(under|up)'], adSizes: [[300, 250], [728, 90]] });

test('host and path lists block', () => {
  assert.ok(classify(f, 'https://cdn.ads.example/x.js', { destination: 'script' }).block);
  assert.ok(classify(f, 'https://portal.test/tracking/beacon', { destination: 'xhr' }).block);
  assert.ok(classify(f, 'https://portal.test/js/popunder.js', { destination: 'script' }).block);
  assert.equal(classify(f, 'https://portal.test/js/app.js', { destination: 'script' }).block, false);
});

test('ad unit dimensions in query or path block images', () => {
  assert.ok(classify(f, 'https://img.portal.test/b?w=300&h=250', { destination: 'image' }).block);
  assert.ok(classify(f, 'https://img.portal.test/banners/728x90.png', { destination: 'image' }).block);
  assert.equal(classify(f, 'https://img.portal.test/poster/300x450.jpg', { destination: 'image' }).block, false);
});

test('third-party iframes block, third-party media does not', () => {
  assert.ok(classify(f, 'https://other.test/embed', { destination: 'iframe', firstParty: false }).block);
  assert.equal(classify(f, 'https://cdn.test/stream.m3u8', { destination: 'media', firstParty: false }).block, false);
});

test('placeholders are well-formed per destination', () => {
  assert.match(placeholderFor('script').type, /javascript/);
  assert.equal(placeholderFor('image').type, 'image/png');
  assert.equal(placeholderFor('xhr').status, 204);
  assert.match(placeholderFor('iframe').body, /<html>/);
});

test('destination inferred from sec-fetch-dest, then accept, then extension', () => {
  assert.equal(destinationFor({ 'sec-fetch-dest': 'image' }, 'https://x/y'), 'image');
  assert.equal(destinationFor({ accept: 'text/html' }, 'https://x/y'), 'document');
  assert.equal(destinationFor({}, 'https://x/y.js'), 'script');
  assert.equal(destinationFor({}, 'https://x/v.mp4'), 'media');
});
