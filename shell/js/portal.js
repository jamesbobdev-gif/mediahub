// Portal frame: a cross-origin iframe (the portal port) rendered at the portal's native 1280
// logical width and scaled as a whole to the TV surface. The shell never touches the frame's DOM;
// it exchanges messages with the injected content script and keeps a cached candidate list.

export const PORTAL_WIDTH = 1280;

export class PortalFrame {
  constructor({ frame, wrap, origin }) {
    this.frame = frame; this.wrap = wrap; this.origin = origin; this.scale = 1;
    this.ready = false; this.href = null; this.title = ''; this.cands = []; this.source = null;
    this.readyAt = 0; this.loadAt = 0;
    this.onReady = () => {}; this.onBlocked = () => {}; this.onCandidates = () => {}; this.onPlayer = () => {};
    this.onHidden = () => {}; this.onNoPlayer = () => {}; this.onDecisions = () => {};
    window.addEventListener('message', (e) => this._onMessage(e));
    this.attachLoadListener();
  }

  /** Load a hub path (/p/<source>/...) on the portal origin. */
  load(path) {
    this.ready = false; this.cands = []; this.loadAt = performance.now(); this.missed = 0; this.readyPending = false;
    clearTimeout(this._blockTimer); this._blockTimer = null;
    this.frame.src = this.origin + path;
    this.layout();
    this.startHeartbeat();
  }

  /** Heartbeat: a hub page answers pings. Two misses in a row means the frame is no longer a hub
   *  page (escaped, crashed, or refused), whatever events the browser did or did not fire. */
  startHeartbeat() {
    clearInterval(this._hb);
    this._hb = setInterval(() => {
      if (!this.frame.src || this.frame.src === 'about:blank') return;
      if (performance.now() - this.loadAt < 1500) return;          // still loading
      if (this.missed >= 2) { this.missed = 0; this.ready = false; this.onBlocked(); return; }
      this.missed++;
      this.send({ type: 'hub:ping', n: Date.now() });
    }, 1000);
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
    switch (m.type) {
      case 'hub:ready':
        // A late announcement answers a pending load; an early one is kept for the load that follows.
        if (this._blockTimer) { clearTimeout(this._blockTimer); this._blockTimer = null; this.readyPending = false; } else this.readyPending = true;
        this.ready = true; this.readyAt = performance.now(); this.href = m.href; this.title = m.title || ''; this.source = m.source; this.missed = 0;
        this.onReady(m); break;
      case 'hub:pong': this.missed = 0; break;
      case 'hub:candidates': this.cands = m.list || []; if (m.href) this.href = m.href; this.onCandidates(); break;
      case 'hub:player': this.onPlayer(m); break;
      case 'hub:hidden': this.onHidden(m.selector); break;
      case 'hub:noplayer': this.onNoPlayer(); break;
      case 'hub:decisions': this.onDecisions(m); break;
    }
  }

  attachLoadListener() {
    this._onLoad = () => {
      // Every hub page announces itself once (hub:ready). Each load event consumes one announcement.
      // The two are separate tasks and can arrive in either order, so a load with no announcement
      // waits briefly for a late one before concluding the frame is not on a hub page (refused by CSP).
      if (this.frame.src === 'about:blank' || !this.frame.src) return;
      this.loadAt = performance.now();
      if (this.readyPending) { this.readyPending = false; return; }
      clearTimeout(this._blockTimer);
      this._blockTimer = setTimeout(() => { this._blockTimer = null; this.ready = false; this.onBlocked(); }, 600);
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
    clearTimeout(this._blockTimer); this._blockTimer = null; this.stopHeartbeat();
    this.frame = fresh; this.ready = false; this.cands = []; this.readyAt = 0; this.loadAt = 0; this.missed = 0; this.readyPending = false;
    this.attachLoadListener();
    return fresh;
  }
}
