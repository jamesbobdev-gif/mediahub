import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../shell/js/search.js';

const items = ['The Quiet Harbour', 'Harbour Lights & Fog', 'Northern Lights', 'Copper Sky', 'Salt and Signal', 'Orbital Decay']
  .map((title, i) => ({ id: String(i), title, sources: [] }));
const titles = (q) => search(items, q).map((i) => i.title);

test('prefix beats word-prefix beats substring', () => {
  assert.deepEqual(titles('har'), ['Harbour Lights & Fog', 'The Quiet Harbour']);
  assert.deepEqual(titles('light'), ['Northern Lights', 'Harbour Lights & Fog']);
  assert.deepEqual(titles('bour'), ['The Quiet Harbour', 'Harbour Lights & Fog']);
});

test('fuzzy catches d-pad typos once the query is long enough', () => {
  assert.ok(titles('harbor').includes('The Quiet Harbour'));
  assert.ok(titles('coper sky').includes('Copper Sky'));
  assert.deepEqual(titles('zzzz'), []);
});

test('diacritics and punctuation are ignored', () => {
  assert.deepEqual(titles('salt and'), ['Salt and Signal']);
  assert.deepEqual(search([{ id: 'x', title: 'Último Tren', sources: [] }], 'ult').length, 1);
});

test('empty query yields nothing', () => { assert.deepEqual(titles('   '), []); });
