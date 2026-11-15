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

test('a load event with no new page behind it does not kill a page that keeps talking', () => {
  const w = new FrameWatch();
  w.load(0); w.loaded(1 * s); w.ready(1.5 * s);
  w.loaded(20 * s);                               // the browser fired load again; the same page is still there
  w.message(21 * s);                              // it answers the next ping
  assert.equal(w.state(25 * s), 'ok');
  w.loaded(30 * s);                               // a real navigation: nothing answers after it
  assert.equal(w.state(35 * s), 'dead');
});

test('an announced page that goes silent is dead, and any message resets the count', () => {
  const w = new FrameWatch();
  w.load(0); w.loaded(1 * s); w.ready(1 * s);
  assert.equal(w.state(10 * s), 'ok');
  assert.equal(w.state(11.5 * s), 'dead');
  const w2 = new FrameWatch();
  w2.load(0); w2.loaded(1 * s); w2.ready(1 * s);
  w2.message(4 * s); w2.message(7 * s);
  assert.equal(w2.state(16 * s), 'ok');
  assert.equal(Math.round(w2.silence(10 * s)), 3);
});

test('time the watcher itself slept through counts against nobody', () => {
  const w = new FrameWatch({ silentMs: 4000, tickMs: 1000 });
  w.load(0); w.loaded(1 * s); w.ready(1.5 * s);
  w.tick(2 * s); w.message(2 * s);
  w.tick(14 * s);                                 // the browser was busy for twelve seconds: no ping went out
  assert.equal(w.state(14 * s), 'ok');
  for (let t = 15; t <= 17; t++) w.tick(t * s);  // it looks on time again
  assert.equal(w.state(17 * s), 'ok');
  for (let t = 18; t <= 20; t++) w.tick(t * s);
  assert.equal(w.state(20 * s), 'dead');          // now the page really has been silent
  const w2 = new FrameWatch({ readyWaitMs: 4000, tickMs: 1000 });
  w2.load(0); w2.loaded(1 * s); w2.tick(1 * s);
  w2.tick(10 * s);                                // loaded, then the browser was busy: the page still gets its seconds to announce itself
  assert.equal(w2.state(10 * s), 'loading');
  assert.equal(w2.state(15 * s), 'dead');
});

test('a frame that never fires load nor ready is dead after the stall limit, not before', () => {
  const w = new FrameWatch();
  w.load(0);
  assert.equal(w.state(15 * s), 'loading');
  assert.equal(w.state(21 * s), 'dead');
});
