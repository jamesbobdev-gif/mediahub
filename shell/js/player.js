// Shell-side remote for the in-frame player. All control lives in the content script (the video
// stays in the portal document so its decoder is undisturbed); this class sends commands and
// renders the OSD from the state the frame reports.

export class Player {
  constructor({ osd, portal }) {
    this.osd = osd; this.portal = portal;
    this.state = { active: false, t: 0, d: 0, paused: true, rate: 1 };
    this.onEnd = () => {}; this.onProgress = () => {}; this.lastProgressAt = 0;
    portal.onPlayer = (s) => this.receive(s);
  }
  get active() { return this.state.active; }

  attach({ id = null, resumeAt = 0 } = {}) { this.portal.send({ type: 'hub:play', id, resumeAt }); }
  detach() { this.portal.send({ type: 'hub:player', cmd: 'detach' }); this.state = { ...this.state, active: false }; this.osd.hidden = true; }
  togglePlay() { this.cmd('toggle'); }
  nudge(sign, repeat) { this.cmd('nudge', sign, !!repeat); }
  commitSeek() { this.cmd('commit'); }
  scan(sign) { this.cmd('scan', sign); }
  cmd(name, ...args) { this.portal.send({ type: 'hub:player', cmd: name, args }); }

  receive(s) {
    const wasActive = this.state.active;
    this.state = s;
    if (!s.active) { this.osd.hidden = true; if (wasActive) this.onProgress(this.state.t, this.state.d); return; }
    this.renderOsd(s.show);
    const now = performance.now();
    if (now - this.lastProgressAt > 3000) { this.lastProgressAt = now; this.onProgress(s.t, s.d); }
    if (s.ended) this.onEnd();
  }

  renderOsd(show) {
    const s = this.state; if (!s.active) return;
    this.osd.querySelector('.osd-time').textContent = `${fmt(s.t)} / ${fmt(s.d)}`;
    this.osd.querySelector('.osd-fill').style.width = s.d ? `${(s.t / s.d) * 100}%` : '0%';
    this.osd.querySelector('.osd-state').textContent = s.rate !== 1 ? `▶▶ ${s.rate}x` : s.paused ? '❚❚' : '▶';
    if (show) { this.osd.hidden = false; clearTimeout(this.osdTimer); this.osdTimer = setTimeout(() => { this.osd.hidden = true; }, 2500); }
  }
}

function fmt(s) {
  if (!isFinite(s)) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
}
