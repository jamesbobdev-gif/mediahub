// Virtual cursor mode: hold-to-accelerate pointer drawn by the shell. Used when
// a portal layout resists spatial navigation. The user switches modes explicitly.

export class VirtualCursor {
  constructor({ el, bounds }) {
    this.el = el; this.bounds = bounds;
    this.x = 200; this.y = 200; this.vx = 0; this.vy = 0; this.held = new Set(); this.raf = null;
    this.accel = 2400; this.maxV = 1800; this.lastT = 0;
  }
  show() { this.el.hidden = false; this.render(); }
  hide() { this.el.hidden = true; this.stop(); }
  press(dir) { this.held.add(dir); this.start(); }
  release(dir) { this.held.delete(dir); if (!this.held.size) { this.vx = this.vy = 0; this.stop(); } }
  start() { if (this.raf) return; this.lastT = performance.now(); const step = (t) => { this.tick((t - this.lastT) / 1000); this.lastT = t; this.raf = requestAnimationFrame(step); }; this.raf = requestAnimationFrame(step); }
  stop() { cancelAnimationFrame(this.raf); this.raf = null; }
  tick(dt) {
    const ax = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    const ay = (this.held.has('down') ? 1 : 0) - (this.held.has('up') ? 1 : 0);
    this.vx = clamp(this.vx + ax * this.accel * dt, -this.maxV, this.maxV);
    this.vy = clamp(this.vy + ay * this.accel * dt, -this.maxV, this.maxV);
    if (!ax) this.vx *= 0.6; if (!ay) this.vy *= 0.6;
    const b = this.bounds();
    this.x = clamp(this.x + this.vx * dt, 0, b.w); this.y = clamp(this.y + this.vy * dt, 0, b.h);
    this.render();
  }
  render() { this.el.style.transform = `translate(${this.x}px, ${this.y}px)`; }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
