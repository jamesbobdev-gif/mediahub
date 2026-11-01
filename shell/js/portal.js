// Portal frame: a same-origin iframe (via the proxy) rendered at the portal's
// native 1280 logical width and scaled as a whole to the TV surface. The shell
// talks to the injected window.__hub API directly; no postMessage round trips.

export const PORTAL_WIDTH = 1280;

export class PortalFrame {
  constructor({ frame, wrap }) { this.frame = frame; this.wrap = wrap; this.scale = 1; this.ready = false; this.onReady = () => {}; this.onNavigate = () => {}; }

  load(url) {
    this.ready = false;
    this.frame.src = url;
    this.layout();
  }

  /** Scale the 1280px frame to the surface. Cap logical surface at 1920 on 4K panels (set by the host CSS). */
  layout() {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    this.scale = w / PORTAL_WIDTH;
    this.frame.style.width = `${PORTAL_WIDTH}px`;
    this.frame.style.height = `${Math.round(h / this.scale)}px`;
    this.frame.style.transform = `scale(${this.scale})`;
    this.frame.style.transformOrigin = 'top left';
  }

  get win() { try { return this.frame.contentWindow; } catch { return null; } }
  get hub() { try { return this.frame.contentWindow.__hub || null; } catch { return null; } }

  /** Candidate rects in shell coordinates (frame rect scaled). */
  candidates() {
    const hub = this.hub; if (!hub) return [];
    const base = this.frame.getBoundingClientRect();
    return hub.candidates().map((c) => ({ el: c.el, x: base.left + c.x * this.scale, y: base.top + c.y * this.scale, w: c.w * this.scale, h: c.h * this.scale }));
  }
  /** Convert shell coordinates to frame coordinates. */
  toFrame(x, y) { const b = this.frame.getBoundingClientRect(); return { x: (x - b.left) / this.scale, y: (y - b.top) / this.scale }; }

  attachReadyListener() {
    this.frame.addEventListener('load', () => {
      this.ready = true;
      this.onReady();
      const w = this.win; if (!w) return;
      // In-frame navigation: re-run ready work and tell the app for history purposes.
      try { w.addEventListener('unload', () => { this.ready = false; }); } catch {}
    });
  }
}
