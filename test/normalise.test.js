import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, titleKey, jaroWinkler, normaliseRecord, canonicalId } from '../server/ingest/normalise.js';

test('release tokens, separators and bracket tags are stripped', () => {
  const r = cleanTitle('The.Quiet.Harbour.2019.1080p.WEB-DL.x264');
  assert.equal(r.title, 'The Quiet Harbour');
  assert.equal(r.year, 2019);
});

test('bracketed year survives, other tags do not', () => {
  const r = cleanTitle('Quiet Harbour (2019) [HD]');
  assert.equal(r.title, 'Quiet Harbour');
  assert.equal(r.year, 2019);
});

test('episode markers are extracted', () => {
  assert.deepEqual(pick(cleanTitle('Northern Lights S01E03')), { title: 'Northern Lights', season: 1, episode: 3 });
  assert.deepEqual(pick(cleanTitle('Paper Kingdom 2x05')), { title: 'Paper Kingdom', season: 2, episode: 5 });
  assert.deepEqual(pick(cleanTitle('Ash Garden Season 2')), { title: 'Ash Garden', season: 2, episode: undefined });
});

test('diacritics folded and articles dropped in the matching key only', () => {
  assert.equal(titleKey(cleanTitle('Último Tren a Madrid (2021) [Dub]').title), 'ultimo tren a madrid');
  assert.equal(titleKey('The Tale of Two Rivers'), 'tale of two rivers');
  assert.equal(titleKey('Salt & Signal'), 'salt and signal');
});

test('same title across providers yields the same canonical id', () => {
  const a = normaliseRecord({ title: 'The.Quiet.Harbour.2019.1080p.WEB-DL.x264', url: 'http://a/1' }, 'a');
  const b = normaliseRecord({ title: 'Quiet Harbour (2019) [HD]', url: 'http://b/9' }, 'b');
  assert.equal(a.id, b.id);
  assert.equal(a.kind, 'movie');
});

test('jaro-winkler catches near misses above threshold', () => {
  assert.ok(jaroWinkler('quiet harbour', 'quiet harbor') > 0.92);
  assert.ok(jaroWinkler('orbital decay', 'glass meridian') < 0.7);
  assert.equal(jaroWinkler('x', 'x'), 1);
});

test('canonical id is stable and distinguishes year', () => {
  assert.equal(canonicalId('red static', 2018, 'movie'), canonicalId('red static', 2018, 'movie'));
  assert.notEqual(canonicalId('red static', 2018, 'movie'), canonicalId('red static', 2019, 'movie'));
});

const pick = ({ title, season, episode }) => ({ title, season, episode });
