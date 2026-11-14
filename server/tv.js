// The TVs, and the way something on the home network drives them: a local model, a phone, a script.
// Every TV shell says hello here when it starts and keeps one event stream open. A controller lists
// the TVs, reads what each one is showing, and posts a command; the hub forwards it down that TV's
// stream and the TV answers with an ack, which becomes the command's result. Memory only: a hub
// restart forgets the TVs until they say hello again, which the shell does on every reconnect.
// The whole thing is described for people and models in docs/CONTROL.md and at GET /api/control.

import { randomBytes } from 'node:crypto';

/** What a controller may ask a TV to do, and what each needs. The shell carries these out (shell/js/remote.js). */
export const COMMANDS = {
  status:      { does: 'Say what the TV is showing right now.', args: {} },
  home:        { does: 'Go to the hub home screen.', args: {} },
  open_source: { does: 'Open a source (an app or site) on its start page.', args: { source: 'a source id from GET /api/sources' } },
  play:        { does: 'Open a title from the catalog and start it. Answers when playback has started, or after eight seconds if it has not.', args: { item: 'a title id from GET /api/catalog/search' } },
  open_url:    { does: 'Open one page of a source.', args: { source: 'a source id', path: 'the page path on that site, starting with /' } },
  search:      { does: 'Open the search screen with words typed in. Answers with the first matches.', args: { query: 'what to look for' } },
  key:         { does: 'Press one remote key.', args: { intent: 'one of: up, down, left, right, select, back, play, pause, playpause, ff, rw, menu, info, search' } },
  pause:       { does: 'Pause what is playing.', args: {} },
  resume:      { does: 'Resume what is paused.', args: {} },
  toggle_play: { does: 'Pause if playing, play if paused. On a page with a video, hand the video to the player.', args: {} },
  stop:        { does: 'Stop playback; if nothing is playing, leave the page and go back.', args: {} },
  back:        { does: 'The remote\'s Back key.', args: {} },
  say:         { does: 'Show a short line on the TV for a few seconds.', args: { text: 'up to 120 characters' } },
};
export const KEY_INTENTS = ['up', 'down', 'left', 'right', 'select', 'back', 'play', 'pause', 'playpause', 'ff', 'rw', 'menu', 'info', 'search'];

/** null when the command is well formed, else one sentence saying what is wrong. */
export function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return 'send a JSON object with a "type"';
  const spec = COMMANDS[cmd.type];
  if (!spec) return `unknown command "${cmd.type}": one of ${Object.keys(COMMANDS).join(', ')}`;
  for (const name of Object.keys(spec.args)) {
    const v = cmd[name];
    if (typeof v !== 'string' || !v.trim()) return `"${cmd.type}" needs "${name}": ${spec.args[name]}`;
    if (v.length > 400) return `"${name}" is too long`;
  }
  if (cmd.type === 'key' && !KEY_INTENTS.includes(cmd.intent)) return `"intent" must be one of ${KEY_INTENTS.join(', ')}`;
  if (cmd.type === 'open_url' && !cmd.path.startsWith('/')) return '"path" must start with /';
  if (cmd.type === 'say' && cmd.text.length > 120) return '"text" is at most 120 characters';
  return null;
}

/** The parts of what a TV reports that the hub keeps, each cut to size. */
export function cleanState(s = {}) {
  const str = (v, n) => (v == null ? null : String(v).slice(0, n));
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
  const playing = s.playing && typeof s.playing === 'object' ? s.playing : {};
  return {
    view: str(s.view, 20), source: str(s.source, 40), href: str(s.href, 300), title: str(s.title, 120),
    query: s.query == null ? undefined : str(s.query, 60), focus: str(s.focus, 80), mode: str(s.mode, 10),
    playing: { active: !!playing.active, paused: !!playing.paused, t: num(playing.t), d: num(playing.d) },
    sources: num(s.sources), titles: num(s.titles),
  };
}

export class TvRegistry {
  constructor({ now = Date.now, timeoutMs = 10000 } = {}) {
    this.tvs = new Map(); this.pending = new Map(); this.now = now; this.timeoutMs = timeoutMs; this.seq = 0;
  }

  /** A TV announces itself. It keeps the id it had (stored on the TV) or gets a new one. */
  hello({ id, name, ip, platform, ua } = {}) {
    let tv = id && this.tvs.get(String(id));
    if (!tv) {
      const fresh = /^[a-z0-9]{6,32}$/i.test(String(id || '')) ? String(id) : randomBytes(4).toString('hex');
      tv = { id: fresh, name: null, ip: null, platform: null, ua: null, firstSeen: this.now(), lastSeen: 0, state: cleanState(), stream: null };
      this.tvs.set(fresh, tv);
    }
    if (name) tv.name = String(name).slice(0, 40);
    if (!tv.name) tv.name = `TV ${tv.id.slice(0, 4)}`;
    if (ip) tv.ip = String(ip);
    if (platform) tv.platform = String(platform).slice(0, 20);
    if (ua) tv.ua = String(ua).slice(0, 200);
    tv.lastSeen = this.now();
    return tv.id;
  }

  /** The TV's event stream: anything with write() and end(). One per TV; a newer one replaces the old. */
  attach(id, stream) {
    const tv = this.tvs.get(id); if (!tv) return false;
    if (tv.stream && tv.stream !== stream) { try { tv.stream.end(); } catch {} }
    tv.stream = stream; tv.lastSeen = this.now();
    return true;
  }
  detach(id, stream) { const tv = this.tvs.get(id); if (tv && tv.stream === stream) tv.stream = null; }

  setState(id, state) {
    const tv = this.tvs.get(id); if (!tv) return false;
    tv.state = { ...cleanState(state), at: this.now() }; tv.lastSeen = this.now();
    return true;
  }

  describe(tv) { return { id: tv.id, name: tv.name, ip: tv.ip, platform: tv.platform, online: !!tv.stream, lastSeen: tv.lastSeen, state: tv.state }; }
  list() { return [...this.tvs.values()].map((tv) => this.describe(tv)); }
  get(id) { const tv = this.tvs.get(id); return tv ? this.describe(tv) : null; }

  /** Forward a command and wait for the TV's answer. Always resolves: {ok, ...} with an error line when it did not work. */
  send(id, cmd) {
    const tv = this.tvs.get(id);
    if (!tv) return Promise.resolve({ ok: false, error: 'unknown TV' });
    const bad = validateCommand(cmd);
    if (bad) return Promise.resolve({ ok: false, error: bad });
    if (!tv.stream) return Promise.resolve({ ok: false, error: `${tv.name} is not connected right now: is the hub open on it?` });
    const commandId = String(++this.seq);
    const msg = { id: commandId, ...cmd };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        resolve({ ok: false, pending: true, command: commandId, error: `no answer from ${tv.name} in ${Math.round(this.timeoutMs / 1000)} seconds; read its state with GET /api/tv/${id}` });
      }, this.timeoutMs);
      this.pending.set(commandId, { resolve, timer, tvId: id });
      try { tv.stream.write(`event: command\ndata: ${JSON.stringify(msg)}\n\n`); }
      catch (e) { clearTimeout(timer); this.pending.delete(commandId); resolve({ ok: false, error: `could not reach ${tv.name}: ${e.message}` }); }
    });
  }

  /** The TV's answer to a command. False when nothing was waiting for it. */
  ack(id, commandId, result = {}) {
    const p = this.pending.get(String(commandId));
    if (!p || p.tvId !== id) return false;
    clearTimeout(p.timer); this.pending.delete(String(commandId));
    const r = result && typeof result === 'object' ? result : {};
    p.resolve({ ok: r.ok !== false, ...r, command: String(commandId) });
    return true;
  }
}

/** The self-description a model reads first: GET /api/control. */
export function controlHelp({ host, port, tokenSet }) {
  const base = `http://${host}:${port}`;
  return {
    about: 'Media Hub control: list the TVs on this hub, read what each shows, find titles, and send a TV a command. Everything stays on the home network.',
    base,
    auth: tokenSet
      ? 'Send the control token on every control call: header "Authorization: Bearer <token>" (or ?token=<token>). It is controlToken in the hub\'s config/access.json.'
      : 'No control token is set, so commands are accepted only from the hub machine itself. Set controlToken in config/access.json to control the TVs from another computer.',
    steps: [
      `GET ${base}/api/tv: the TVs, with id, name, online and state.`,
      `GET ${base}/api/catalog/search?q=words: titles across every source, each with its id.`,
      `POST ${base}/api/tv/<id>/command with JSON {"type": "play", "item": "<title id>"}: the answer is the TV's result.`,
      `GET ${base}/api/tv/<id>: what the TV shows now (view, source, title, playing position).`,
    ],
    commands: COMMANDS,
    state: {
      view: 'home, search, settings or portal (a site is open)', source: 'the open source id, or null', href: 'the open page, or null',
      title: 'the title being watched, when known', playing: '{active, paused, t, d}: whether the player has a video, paused or not, position and length in seconds',
      focus: 'the text of the tile or button the remote focus is on', mode: 'spatial (focus moves between elements) or cursor (a pointer)',
    },
    also: {
      sources: `GET ${base}/api/sources`, status: `GET ${base}/api/status`, item: `GET ${base}/api/catalog/item/<id>`, trace: `GET ${base}/api/trace (the TV's recent steps)`,
    },
  };
}
