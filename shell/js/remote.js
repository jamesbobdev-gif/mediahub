// This TV can be driven from the hub: a local model, a phone or a script posts a command to the hub,
// the hub forwards it on this TV's event stream, and the result goes back as an ack (server/tv.js,
// docs/CONTROL.md). The TV also tells the hub what it is showing, so a controller can read it.
// The TV keeps its id in localStorage, so it is the same TV to the hub across restarts.

import { PLATFORM } from './keymap.js';

const ID_KEY = 'hub:tvId', NAME_KEY = 'hub:tvName';

/** A name a person would recognise, from what the browser says it is. Settings can rename it later. */
export function defaultName(ua = navigator.userAgent, platform = PLATFORM) {
  if (/AFT[A-Z0-9]*\b|Fire ?TV|FireOS/i.test(ua)) return 'Fire TV';
  if (platform === 'webos') return 'LG TV';
  if (platform === 'tizen') return 'Samsung TV';
  if (/Android TV|BRAVIA|SHIELD|Chromecast/i.test(ua)) return 'Android TV';
  if (platform === 'android') return 'Android TV';
  return 'Browser';
}

/**
 * @param snapshot  () => what the TV is showing, posted to the hub when it changes and every few seconds
 * @param run       async (command) => result: carries a command out in the shell; {ok:false, error} when it cannot
 */
export function startRemote({ snapshot, run }) {
  let id = null; try { id = localStorage.getItem(ID_KEY); } catch {}
  // ?tv=Living%20room in the address names this TV; the name is kept, so it is needed once
  let name = null;
  try {
    const given = new URLSearchParams(location.search).get('tv');
    if (given && given.trim()) { name = given.trim().slice(0, 40); localStorage.setItem(NAME_KEY, name); }
    else name = localStorage.getItem(NAME_KEY);
  } catch {}
  if (!name) name = defaultName();
  let es = null, backoff = 1000, last = '', connected = false;

  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});

  async function hello() {
    const r = await fetch('/api/tv/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name, platform: PLATFORM, ua: navigator.userAgent }) });
    if (!r.ok) throw new Error(`hello: HTTP ${r.status}`);
    const j = await r.json();
    id = j.id;
    try { localStorage.setItem(ID_KEY, id); } catch {}
  }

  function listen() {
    es = new EventSource(`/api/tv/${id}/events`);
    es.addEventListener('command', onCommand);
    es.onopen = () => { connected = true; backoff = 1000; report(true); };
    es.onerror = () => {
      connected = false;
      try { es.close(); } catch {}
      es = null;
      setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2);
    };
  }
  async function connect() {
    try { await hello(); listen(); }
    catch { setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2); }
  }

  async function onCommand(e) {
    let cmd = {};
    try { cmd = JSON.parse(e.data); } catch { return; }
    let result;
    try { result = (await run(cmd)) || { ok: true }; }
    catch (err) { result = { ok: false, error: (err && err.message) || String(err) }; }
    await post(`/api/tv/${id}/ack`, { command: cmd.id, result });
    setTimeout(() => report(true), 400);
  }

  function report(force = false) {
    if (!id) return;
    let s;
    try { s = snapshot(); } catch { return; }
    const body = JSON.stringify(s);
    if (!force && body === last) return;
    last = body;
    post(`/api/tv/${id}/state`, s);
  }

  connect();
  setInterval(() => report(false), 5000);
  return { report: () => report(true), get id() { return id; }, get name() { return name; }, get connected() { return connected; } };
}
