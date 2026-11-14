import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featuredRows } from '../shell/js/catalog.js';

test('the home screen gets one row per source with front-page titles, in page order, sources in their own order', () => {
  const items = [
    { id: '1', title: 'One', sources: [{ sourceId: 'tubi', rank: 3 }] },
    { id: '2', title: 'Two', sources: [{ sourceId: 'tubi', rank: 1 }, { sourceId: 'pluto', rank: null }] },
    { id: '3', title: 'Three', sources: [{ sourceId: 'pluto', rank: 2 }, { sourceId: 'tubi', rank: 2 }] },
    { id: '4', title: 'Four', sources: [{ sourceId: 'roku', itemUrl: 'x' }] },
  ];
  const sources = [{ id: 'pluto', name: 'Pluto TV' }, { id: 'tubi', name: 'Tubi' }, { id: 'roku', name: 'The Roku Channel' }];
  const rows = featuredRows(items, sources);
  assert.deepEqual(rows.map((r) => [r.source.name, r.items.map((i) => i.title)]), [['Pluto TV', ['Three']], ['Tubi', ['Two', 'Three', 'One']]]);
  assert.deepEqual(featuredRows([], sources), []);
});
