import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameWatch } from '../shell/js/liveness.js';

const s = 1000;

test('a page that announces itself and keeps answering is fine, whichever order load and ready come in', () => {
  const w = new FrameWatch();
  w.load(0);
  assert.equal(w.state(1 * s), 'loading');
  w.loaded(2 * s); w.ready(2.5 * s);
  assert.equal(w.state(3 * s), 'ok');
  w.message(6 * s);
  assert.equal(w.state(9 * s), 'ok');
  const w2 = new FrameWatch();
  w2.load(0); w2.ready(1 * s); w2.loaded(1.2 * s);
  assert.equal(w2.state(2 * s), 'ok');
});

test('a heavy page gets seconds after its load event before it counts as dead', () => {
  const w = new FrameWatch();
  w.load(0); w.loaded(1 * s);
  assert.equal(w.state(1.6 * s), 'loading', 'well past the old 600 ms');
  assert.equal(w.state(4.9 * s), 'loading');
  w.ready(4.95 * s);
  assert.equal(w.state(5 * s), 'ok');
});

test('a page that loads but never announces itself is dead after the wait', () => {
  const w = new FrameWatch();
  w.load(0); w.loaded(1 * s);
  assert.equal(w.state(5.1 * s), 'dead');
});

test('a page that reloads itself once is given the same patience again', () => {
  const w = new FrameWatch();
  w.load(0); w.loaded(1 * s); w.ready(1.5 * s);
  w.loaded(3 * s);                                // navigated: a new document is coming
  assert.equal(w.state(6 * s), 'loading');
  w.ready(6.5 * s);
  assert.equal(w.state(7 * s), 'ok');
});

test('an announced page that goes silent is dead, and any message resets the count', () => {
  const w = new FrameWatch();
  w.load(0); w.loaded(1 * s); w.ready(1 * s);
  assert.equal(w.state(4 * s), 'ok');
  assert.equal(w.state(5.5 * s), 'dead');
  const w2 = new FrameWatch();
  w2.load(0); w2.loaded(1 * s); w2.ready(1 * s);
  w2.message(4 * s); w2.message(7 * s);
  assert.equal(w2.state(10 * s), 'ok');
  assert.equal(Math.round(w2.silence(10 * s)), 3);
});

test('a frame that never fires load nor ready is dead after the stall limit, not before', () => {
  const w = new FrameWatch();
  w.load(0);
  assert.equal(w.state(15 * s), 'loading');
  assert.equal(w.state(21 * s), 'dead');
});
