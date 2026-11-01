// Playback takeover. The portal's <video> is reparented into a shell-owned
// overlay inside the frame document (keeps MediaSource/decoder alive on Chromium
// engines) and the shell draws its own controls. Seeks are coalesced so a held
// fast-forward key never issues one seek per key event.

export class Player {
  constructor({ osd }) {
    this.osd = osd; this.video = null; this.doc = null; this.home = null;
    this.pendingSeek = null; this.seekTimer = null; this.scanRate = 1; this.scanTimer = null;
    this.onEnd = () => {}; this.onProgress = () => {}; this.lastProgressAt = 0;
  }

  attach(video, { resumeAt = 0 } = {}) {
    this.video = video; this.doc = video.ownerDocument;
    this.home = { parent: video.parentNode, next: video.nextSibling };
    const overlay = this.doc.createElement('div');
    overlay.className = 'hub-player-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646;display:flex;align-items:center;justify-content:center;';
    video.style.cssText += ';width:100%;height:100%;object-fit:contain;max-width:none;max-height:none;';
    this.hadControls = video.controls; video.controls = false;   // the shell draws its own OSD
    overlay.appendChild(video);
    this.doc.body.appendChild(overlay);
    this.overlay = overlay;
    this.doc.documentElement.classList.add('hub-playback');
    if (resumeAt > 0) {
      const seek = () => { if (typeof video.fastSeek === 'function') video.fastSeek(resumeAt); else video.currentTime = resumeAt; };
      if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
    }
    try { video.play(); } catch {}
    video.addEventListener('timeupdate', this._onTime = () => {
      this.renderOsd();
      const now = performance.now();
      if (now - this.lastProgressAt > 3000) { this.lastProgressAt = now; this.onProgress(video.currentTime, video.duration); }
    });
    video.addEventListener('ended', this._onEnded = () => this.onEnd());
    this.renderOsd(true);
  }

  detach() {
    if (!this.video) return;
    const v = this.video;
    this.stopScan();
    this.onProgress(v.currentTime, v.duration);
    v.pause();
    v.removeEventListener('timeupdate', this._onTime);
    v.removeEventListener('ended', this._onEnded);
    v.style.cssText = v.style.cssText.replace(/width:100%;height:100%;object-fit:contain;max-width:none;max-height:none;/, '');
    v.controls = this.hadControls;
    if (this.home.parent) this.home.parent.insertBefore(v, this.home.next);
    this.overlay?.remove();
    this.doc.documentElement.classList.remove('hub-playback');
    this.video = null; this.osd.hidden = true;
  }

  get active() { return !!this.video; }

  togglePlay() { if (!this.video) return; if (this.scanRate !== 1) { this.stopScan(); return; } this.video.paused ? this.video.play() : this.video.pause(); this.renderOsd(true); }

  /** Held key: optimistic scrubber, seeks coalesced to one per 250ms or on release. */
  nudge(dirSign, repeat) {
    if (!this.video) return;
    const step = repeat ? 10 : 5;
    this.pendingSeek = (this.pendingSeek ?? this.video.currentTime) + dirSign * step;
    this.pendingSeek = Math.max(0, Math.min(this.video.duration || Infinity, this.pendingSeek));
    this.renderOsd(true);
    if (!this.seekTimer) this.seekTimer = setTimeout(() => this.commitSeek(), 250);
  }
  commitSeek() {
    clearTimeout(this.seekTimer); this.seekTimer = null;
    if (this.pendingSeek == null || !this.video) return;
    const t = this.pendingSeek; this.pendingSeek = null;
    // fastSeek snaps to the nearest keyframe: what scanning wants, and several times faster than exact seeks.
    if (typeof this.video.fastSeek === 'function') this.video.fastSeek(t); else this.video.currentTime = t;
  }

  /** Dedicated FF/RW keys cycle playbackRate 2,4,8 (muted above 2x); above 8x fall back to keyframe stepping. */
  scan(dirSign) {
    if (!this.video) return;
    if (dirSign < 0) { this.nudge(-1, true); return; }     // decoders do not play backwards; rewind = keyframe steps
    const rates = [2, 4, 8];
    const i = rates.indexOf(this.scanRate);
    if (i === rates.length - 1) { this.stopScan(); this.scanTimer = setInterval(() => this.nudge(1, true), 300); this.scanRate = 16; }
    else { this.scanRate = rates[i + 1]; this.video.playbackRate = this.scanRate; this.video.muted = this.scanRate > 2; this.video.play(); }
    this.renderOsd(true);
  }
  stopScan() {
    clearInterval(this.scanTimer); this.scanTimer = null;
    if (this.video) { this.video.playbackRate = 1; this.video.muted = false; }
    this.scanRate = 1; this.renderOsd(true);
  }

  renderOsd(show) {
    if (!this.video) return;
    const v = this.video;
    const t = this.pendingSeek ?? v.currentTime, d = v.duration || 0;
    this.osd.querySelector('.osd-time').textContent = `${fmt(t)} / ${fmt(d)}`;
    this.osd.querySelector('.osd-fill').style.width = d ? `${(t / d) * 100}%` : '0%';
    this.osd.querySelector('.osd-state').textContent = this.scanRate !== 1 ? `▶▶ ${this.scanRate}x` : v.paused ? '❚❚' : '▶';
    if (show) { this.osd.hidden = false; clearTimeout(this.osdTimer); this.osdTimer = setTimeout(() => { this.osd.hidden = true; }, 2500); }
  }
}

function fmt(s) {
  if (!isFinite(s)) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
}
