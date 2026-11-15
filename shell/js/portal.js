// Portal frame: a cross-origin iframe (the portal port) rendered at the portal's native 1280
// logical width and scaled as a whole to the TV surface. The shell never touches the frame's DOM;
// it exchanges messages with the injected content script and keeps a cached candidate list.

import { FrameWatch } from './liveness.js';

export const PORTAL_WIDTH = 1280;

export class PortalFrame {
  constructor({ frame, wrap, origin }) {
    this.frame = frame; this.wrap = wrap; this.origin = origin; this.scale = 1;
    this.ready = false; this.href = null; this.title = ''; this.cands = []; this.source = null;
    this.readyAt = 0; this.loadAt = 0;
    this.watch = new FrameWatch();           // the timing rules: when a frame counts as gone
    this.onReady = () => {}; this.onBlocked = () => {}; this.onCandidates = () => {}; this.onPlayer = () => {};
    this.onHidden = () => {}; this.onNoPlayer = () => {}; this.onDecisions = () => {}; this.onTrace = () => {};
    window.addEventListener('message', (e) => this._onMessage(e));
    this.attachLoadListener();
  }

  /** Load a hub path (/p/<source>/...) on the portal origin. */
  load(path) {
    this.ready = false; this.cands = []; this.loadAt = performance.now();
    this.watch.load(this.loadAt);
    this.frame.src = this.origin + path;
    this.layout();
    this.startHeartbeat();
  }

  /** Heartbeat: a hub page answers pings. The frame counts as gone (escaped, crashed, refused)
   *  by the rules in liveness.js: a loaded page that never announces itself, or an announced page
   *  that falls silent, with seconds of patience for a heavy page or one that reloads itself. */
  startHeartbeat() {
    clearInterval(this._hb);
    this._hb = setInterval(() => {
      if (!this.frame.src || this.frame.src === 'about:blank') return;
      const now = performance.now();
      if (this.watch.state(now) === 'dead') { const why = this.watchInfo(); this.watch.load(now); this.ready = false; this.onBlocked(why); return; }
      this.send({ type: 'hub:ping', n: Date.now() });
    }, 1000);
  }
  /** Seconds since the page last said anything (for the stats). */
  get missed() { return Math.round(this.watch.silence(performance.now())); }
  /** The watch's timers as seconds ago, for the trace: which rule called the frame gone. */
  watchInfo() {
    const now = performance.now(), ago = (t) => (t == null ? null : Math.round((now - t) / 100) / 10);
    return { load: ago(this.watch.loadAt), loaded: ago(this.watch.loadedAt), ready: ago(this.watch.readyAt), seen: ago(this.watch.lastSeen), v: 2 };
  }
  stopHeartbeat() { clearInterval(this._hb); this._hb = null; }

  layout() {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    this.scale = w / PORTAL_WIDTH;
    this.frame.style.width = `${PORTAL_WIDTH}px`;
    this.frame.style.height = `${Math.round(h / this.scale)}px`;
    this.frame.style.transform = `scale(${this.scale})`;
    this.frame.style.transformOrigin = 'top left';
  }

  send(msg) { try { this.frame.contentWindow.postMessage(msg, this.origin); } catch {} }

  /** Candidate rects in shell coordinates. */
  candidates() {
    const base = this.frame.getBoundingClientRect();
    return this.cands.map((c) => ({ id: c.id, tag: c.tag, x: base.left + c.x * this.scale, y: base.top + c.y * this.scale, w: c.w * this.scale, h: c.h * this.scale }));
  }
  toFrame(x, y) { const b = this.frame.getBoundingClientRect(); return { x: (x - b.left) / this.scale, y: (y - b.top) / this.scale }; }

  _onMessage(e) {
    if (e.origin !== this.origin || e.source !== this.frame.contentWindow) return;
    const m = e.data || {};
    this.watch.message(performance.now());
    switch (m.type) {
      case 'hub:ready':
        this.watch.ready(performance.now());
        this.ready = true; this.readyAt = performance.now(); this.href = m.href; this.title = m.title || ''; this.source = m.source;
        this.onReady(m); break;
      case 'hub:pong': break;
      case 'hub:candidates': this.cands = m.list || []; if (m.href) this.href = m.href; this.onCandidates(); break;
      case 'hub:player': this.onPlayer(m); break;
      case 'hub:hidden': this.onHidden(m.selector); break;
      case 'hub:noplayer': this.onNoPlayer(); break;
      case 'hub:decisions': this.onDecisions(m); break;
      case 'hub:trace': this.onTrace(m); break;
    }
  }

  attachLoadListener() {
    // Every hub page announces itself once (hub:ready). The load event and the announcement are
    // separate tasks and can arrive in either order; liveness.js pairs them and decides when a
    // load with no announcement means the frame is not on a hub page (refused by CSP, or stuck).
    this._onLoad = () => {
      if (this.frame.src === 'about:blank' || !this.frame.src) return;
      this.loadAt = performance.now();
      this.watch.loaded(this.loadAt);
    };
    this.frame.addEventListener('load', this._onLoad);
  }

  /** Replace the iframe with a fresh browsing context after a refused navigation. */
  recreate() {
    const old = this.frame;
    const fresh = document.createElement('iframe');
    for (const a of old.attributes) if (a.name !== 'src') fresh.setAttribute(a.name, a.value);
    fresh.style.cssText = old.style.cssText;
    old.replaceWith(fresh);
    this.stopHeartbeat();
    this.frame = fresh; this.ready = false; this.cands = []; this.readyAt = 0; this.loadAt = 0; this.watch.load(performance.now());
    this.attachLoadListener();
    return fresh;
  }
}
