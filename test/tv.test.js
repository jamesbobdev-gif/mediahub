import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TvRegistry, validateCommand, cleanState, controlHelp, COMMANDS } from '../server/tv.js';
import { controlAllowed, loadAccess } from '../server/access.js';

const fakeStream = () => { const s = { out: [], ended: false }; s.write = (x) => s.out.push(x); s.end = () => { s.ended = true; }; return s; };

test('a TV keeps its id across hellos and gets a name', () => {
  const r = new TvRegistry();
  const id = r.hello({ name: 'Living room', ip: '192.168.1.9', platform: 'android' });
  assert.match(id, /^[a-f0-9]{8}$/);
  assert.equal(r.hello({ id }), id, 'the same id comes back');
  assert.equal(r.get(id).name, 'Living room');
  assert.equal(r.get(id).online, false);
  const other = r.hello({});
  assert.notEqual(other, id);
  assert.equal(r.get(other).name, `TV ${other.slice(0, 4)}`);
  assert.equal(r.list().length, 2);
});

test('a command goes down the stream and the ack is its result', async () => {
  const r = new TvRegistry({ timeoutMs: 1000 });
  const id = r.hello({ name: 'TV' });
  const s = fakeStream();
  assert.ok(r.attach(id, s));
  const p = r.send(id, { type: 'play', item: 'abc12345' });
  assert.equal(s.out.length, 1);
  const data = JSON.parse(s.out[0].split('data: ')[1]);
  assert.equal(data.type, 'play'); assert.equal(data.item, 'abc12345');
  assert.equal(r.ack('someone-else', data.id, { ok: true }), false, 'only that TV may answer');
  assert.ok(r.ack(id, data.id, { ok: true, title: 'A film', started: true }));
  const res = await p;
  assert.deepEqual(res, { ok: true, title: 'A film', started: true, command: data.id });
  assert.equal(r.ack(id, data.id, {}), false, 'answered once');
});

test('no answer in time is reported, not hung; a disconnected TV is refused up front', async () => {
  const r = new TvRegistry({ timeoutMs: 30 });
  const id = r.hello({ name: 'Bedroom' });
  let res = await r.send(id, { type: 'home' });
  assert.equal(res.ok, false); assert.match(res.error, /not connected/);
  const s = fakeStream(); r.attach(id, s);
  res = await r.send(id, { type: 'home' });
  assert.equal(res.ok, false); assert.equal(res.pending, true); assert.match(res.error, /no answer from Bedroom/);
  assert.equal(r.pending.size, 0);
  res = await r.send('nope', { type: 'home' });
  assert.match(res.error, /unknown TV/);
});

test('a newer stream replaces the old one, and a closed stream goes offline', () => {
  const r = new TvRegistry();
  const id = r.hello({});
  const a = fakeStream(), b = fakeStream();
  r.attach(id, a); r.attach(id, b);
  assert.ok(a.ended, 'the old stream is closed');
  assert.equal(r.get(id).online, true);
  r.detach(id, a);
  assert.equal(r.get(id).online, true, 'detaching the old one changes nothing');
  r.detach(id, b);
  assert.equal(r.get(id).online, false);
});

test('commands are checked before they go anywhere', () => {
  assert.equal(validateCommand({ type: 'home' }), null);
  assert.equal(validateCommand({ type: 'key', intent: 'select' }), null);
  assert.match(validateCommand({ type: 'key', intent: 'volume' }), /intent/);
  assert.match(validateCommand({ type: 'play' }), /needs "item"/);
  assert.match(validateCommand({ type: 'open_url', source: 'pbs', path: 'video' }), /start with \//);
  assert.match(validateCommand({ type: 'say', text: 'x'.repeat(121) }), /120/);
  assert.match(validateCommand({ type: 'reboot' }), /unknown command/);
  assert.match(validateCommand(null), /JSON object/);
  for (const name of Object.keys(COMMANDS)) assert.ok(COMMANDS[name].does, `${name} is described`);
});

test('a TV\'s state is kept in a fixed shape, cut to size', () => {
  const s = cleanState({ view: 'portal', source: 'tubi', href: '/p/tubi/movies/x', title: 'T'.repeat(200), playing: { active: true, paused: false, t: '12.7', d: 5400.2 }, extra: 'dropped' });
  assert.equal(s.view, 'portal'); assert.equal(s.title.length, 120);
  assert.deepEqual(s.playing, { active: true, paused: false, t: 13, d: 5400 });
  assert.equal('extra' in s, false);
  assert.deepEqual(cleanState().playing, { active: false, paused: false, t: 0, d: 0 });
});

test('without a token, control stays on the hub machine; with one, the token decides', () => {
  const none = loadAccess('/nonexistent/access.json');
  assert.equal(none.controlToken, '');
  assert.ok(controlAllowed(none, { ip: '127.0.0.1' }));
  assert.equal(controlAllowed(none, { ip: '192.168.1.20' }), false);
  const a = { allowClients: [], controlToken: 'secret-words' };
  assert.ok(controlAllowed(a, { ip: '192.168.1.20', header: 'Bearer secret-words' }));
  assert.ok(controlAllowed(a, { ip: '192.168.1.20', query: 'secret-words' }));
  assert.equal(controlAllowed(a, { ip: '192.168.1.20', header: 'Bearer wrong' }), false);
  assert.equal(controlAllowed(a, { ip: '192.168.1.20', header: 'Bearer secret-word' }), false, 'a prefix is not the token');
  assert.equal(controlAllowed(a, { ip: '192.168.1.20' }), false);
  assert.equal(controlAllowed(a, { ip: '127.0.0.1' }), false, 'once a token is set, the hub machine needs it too');
});

test('the self-description names the base address and every command', () => {
  const h = controlHelp({ host: '192.168.1.200', port: 8787, tokenSet: true });
  assert.equal(h.base, 'http://192.168.1.200:8787');
  assert.match(h.auth, /Bearer/);
  assert.deepEqual(Object.keys(h.commands), Object.keys(COMMANDS));
  assert.match(controlHelp({ host: 'pi', port: 8787, tokenSet: false }).auth, /only from the hub machine/);
});
