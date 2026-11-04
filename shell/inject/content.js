// Injected into every proxied portal page, before the portal's own scripts.
// The page lives on the portal origin; the shell lives on the hub origin. They talk only through
// postMessage, so nothing a portal script does can reach the shell, its storage or the hub API.
// Responsibilities here: desktop-layout commitment, routing every runtime URL through the hub,
// popup/redirect suppression, noise removal that preserves grid geometry, scroll-root forwarding,
// focus candidates for spatial navigation, and the in-frame player takeover.
(function () {
  'use strict';
  const RULES = Object.assign({ css: [], removeOnMount: [], preserve: [], scrollRoot: null, player: 'video', touch: false }, window.__HUB_RULES || {});
  const SHELL = window.__HUB_SHELL || '';
  const SOURCE = RULES.sourceId, PORTAL_ORIGIN = window.__HUB_ORIGIN || '';
  const PRESERVE = RULES.preserve.join(',') || null;
  const REMOVE = RULES.removeOnMount.join(',') || null;
  const AD_RATIOS = [[300, 250], [728, 90], [320, 50], [160, 600], [970, 250], [300, 600], [336, 280]];
  const decisions = [];
  const send = (msg) => { try { parent.postMessage(msg, SHELL || '*'); } catch {} };

  // ---- 1. Commit the portal to its desktop layout ------------------------------
  if (!RULES.touch) {
    try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true }); } catch {}
    try { delete window.ontouchstart; } catch {}
    try { Object.defineProperty(window, 'ontouchstart', { get: () => undefined, set() {}, configurable: true }); } catch {}
  }

  // ---- 2. Every URL a script makes goes through the hub -------------------------
  const sameOrigin = (href) => { try { return new URL(href, location.href).origin === location.origin; } catch { return false; } };
  const HUB_PATHS = /^\/(p|x)\/|^\/shell\/inject\//;
  function toHub(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return url; }
    if (!/^https?:$/.test(u.protocol)) return url;
    // Root-relative URLs ("/api/list") are relative to the portal, not to the hub: map them under /p/<source>/.
    if (u.origin === location.origin) return HUB_PATHS.test(u.pathname) ? url : `/p/${SOURCE}${u.pathname}${u.search}${u.hash}`;
    if (PORTAL_ORIGIN && u.origin === PORTAL_ORIGIN) return `/p/${SOURCE}${u.pathname}${u.search}${u.hash}`;
    return `/x/${SOURCE}/${encodeURIComponent(u.href)}`;
  }
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' || input instanceof URL) return realFetch.call(window, toHub(String(input)), init);
    if (input instanceof Request) return realFetch.call(window, new Request(toHub(input.url), input), init);
    return realFetch.call(window, input, init);
  };
  const realXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return realXhrOpen.call(this, method, toHub(String(url)), ...rest); };
  for (const [Ctor, prop] of [[HTMLScriptElement, 'src'], [HTMLImageElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLSourceElement, 'src'],
                              [HTMLMediaElement, 'src'], [HTMLLinkElement, 'href'], [HTMLEmbedElement, 'src']]) {
    const d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(Ctor.prototype, prop, { get: d.get, set(v) { d.set.call(this, toHub(String(v))); }, configurable: true });
  }
  const realSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if ((n === 'src' || n === 'href' || n === 'data-src') && /^(https?:)?\/\//i.test(String(value))) value = toHub(String(value));
    return realSetAttribute.call(this, name, value);
  };

  // ---- 3. Popup, pop-under and redirect suppression -----------------------------
  const realOpen = window.open;
  window.open = function (url, ...rest) {
    if (url && !sameOrigin(url)) { decisions.push({ kind: 'popup', url: String(url) }); return null; }
    return realOpen.call(window, url, ...rest);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^(javascript|data|blob):/i.test(href)) return;
    if (!sameOrigin(a.href)) {
      const routed = toHub(a.href);
      if (routed.startsWith(`/p/${SOURCE}`)) { a.setAttribute('href', routed); if (a.target === '_blank') a.target = '_self'; return; }
      e.preventDefault(); e.stopImmediatePropagation(); decisions.push({ kind: 'blocked-link', url: a.href });
    } else if (a.href.startsWith(location.origin + '/x/')) {
      e.preventDefault(); e.stopImmediatePropagation(); decisions.push({ kind: 'blocked-link', url: a.href });
    } else if (a.target === '_blank') a.target = '_self';
  }, true);

  // ---- 3b. Clickable tracking for focus candidates ------------------------------
  const realAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((type === 'click' || type === 'mousedown' || type === 'pointerdown') && this instanceof Element) this.__hubClickable = true;
    return realAdd.call(this, type, fn, opts);
  };

  // ---- 4. Noise removal preserving grid geometry --------------------------------
  function inPreserved(el) { return PRESERVE ? !!el.closest(PRESERVE) : false; }
  function isGridCell(el) {
    const p = el.parentElement;
    if (!p) return false;
    const d = getComputedStyle(p).display;
    return (d === 'grid' || d === 'inline-grid' || d === 'flex' || d === 'inline-flex') && PRESERVE && p.matches(PRESERVE);
  }
  function placeholderFor(el) {
    const cs = getComputedStyle(el);
    const ph = document.createElement('div');
    ph.className = 'hub-placeholder';
    ph.setAttribute('aria-hidden', 'true');
    for (const prop of ['grid-column', 'grid-row', 'flex-basis', 'flex-grow', 'flex-shrink', 'width', 'height', 'margin']) {
      const v = cs.getPropertyValue(prop); if (v) ph.style.setProperty(prop, v);
    }
    return ph;
  }
  function hide(el, reason) {
    if (el.classList.contains('hub-hidden') || el.classList.contains('hub-placeholder')) return;
    decisions.push({ kind: 'hide', reason, tag: el.tagName, cls: el.className && String(el.className).slice(0, 60) });
    if (isGridCell(el)) { el.replaceWith(placeholderFor(el)); return; }
    el.classList.add('hub-hidden');
  }
  function heuristicScore(el) {
    if (el === document.body || el === document.documentElement) return 0;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    let score = 0;
    const fixed = cs.position === 'fixed' || cs.position === 'sticky';
    if (fixed) score += 2;
    if (+cs.zIndex > 1000) score += 2;
    const cover = (r.width * r.height) / (innerWidth * innerHeight);
    if (cover > 0.25) score += 2;
    if (el.querySelector('video')) score -= 10;
    const text = (el.textContent || '').trim();
    if (text.length > 200 && !fixed) score -= 3;
    if (el.querySelectorAll('a[href]').length >= 2) score -= 2;
    const media = el.matches('iframe,img') ? el : el.querySelector('iframe,img');
    if (media) {
      const mr = media.getBoundingClientRect();
      if (AD_RATIOS.some(([w, h]) => Math.abs(mr.width - w) < 4 && Math.abs(mr.height - h) < 4)) score += 4;
      if (media.tagName === 'IFRAME' && media.src && !sameOrigin(media.src) && !media.src.startsWith(location.origin + '/p/')) score += 2;
    }
    return score;
  }
  function evaluate(el) {
    if (!(el instanceof Element) || el.closest('.hub-hidden,.hub-placeholder,.hub-player-overlay')) return;
    if (REMOVE && el.matches(REMOVE)) { if (!el.matches(PRESERVE || '\0')) hide(el, 'rule'); return; }
    if (inPreserved(el) && !isGridCell(el)) return;
    if (heuristicScore(el) >= 4) hide(el, 'heuristic');
  }
  let pending = new Set(), scheduled = false;
  function schedule(nodes) {
    for (const n of nodes) if (n instanceof Element) pending.add(n);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const batch = [...pending]; pending.clear();
      for (const el of batch) { evaluate(el); if (el.children.length < 50) for (const c of el.children) evaluate(c); }
      markDirty();
    });
  }
  const mo = new MutationObserver((muts) => { for (const m of muts) schedule(m.addedNodes); });
  document.addEventListener('load', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.naturalWidth !== 1 || img.naturalHeight !== 1) return;
    let target = img;
    for (let p = img.parentElement; p && p !== document.body; p = p.parentElement) {
      if (isGridCell(p)) { target = p; break; }
      if (PRESERVE && p.matches(PRESERVE)) break;
    }
    hide(target, 'placeholder-image');
  }, true);

  // ---- 5. Scroll root forwarding for infinite scroll ----------------------------
  let scrollRoot = null;
  function setupScrollRoot() {
    scrollRoot = RULES.scrollRoot ? document.querySelector(RULES.scrollRoot) : null;
    if (!scrollRoot) return;
    document.documentElement.classList.add('hub-has-scroll-root');
    scrollRoot.classList.add('hub-scroll-root');
    scrollRoot.addEventListener('scroll', () => { window.dispatchEvent(new Event('scroll')); markDirty(); }, { passive: true });
    const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get, configurable: true }); } catch {} };
    def(window, 'scrollY', () => scrollRoot.scrollTop);
    def(window, 'pageYOffset', () => scrollRoot.scrollTop);
    def(document.documentElement, 'scrollTop', () => scrollRoot.scrollTop);
    def(document.documentElement, 'scrollHeight', () => scrollRoot.scrollHeight);
    def(document.documentElement, 'clientHeight', () => scrollRoot.clientHeight);
    window.scrollTo = (x, y) => { if (typeof x === 'object') scrollRoot.scrollTo(x); else scrollRoot.scrollTo(x, y); };
    window.scrollBy = (x, y) => scrollRoot.scrollBy(x, y);
  }

  // ---- 6. Focus candidates, pushed to the shell ---------------------------------
  const FOCUSABLE = 'a[href],button,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],input,select,textarea,summary,video';
  const ids = new WeakMap(); const byId = new Map(); let nextId = 1;
  const idOf = (el) => { let id = ids.get(el); if (!id) { id = nextId++; ids.set(el, id); } byId.set(id, el); return id; };
  const elOf = (id) => { const el = byId.get(id); return el && el.isConnected ? el : null; };
  function visible(el, r) {
    if (!r.width || !r.height) return false;
    if (r.bottom < -200 || r.top > innerHeight + 200) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
  }
  function snapshot() {
    const out = []; const seen = new Set();
    const push = (el) => {
      if (seen.has(el) || el.closest('.hub-hidden,.hub-placeholder')) return;
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) return;
      seen.add(el);
      out.push({ id: idOf(el), x: r.left, y: r.top, w: r.width, h: r.height, tag: el.tagName });
    };
    for (const el of document.querySelectorAll(FOCUSABLE)) push(el);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.__hubClickable && !n.closest(FOCUSABLE)) push(n);
    return out;
  }
  let dirty = true, pushScheduled = false;
  function pushCandidates() { send({ type: 'hub:candidates', list: snapshot(), href: location.pathname + location.search }); dirty = false; }
  function markDirty() {
    dirty = true;
    if (pushScheduled) return;
    pushScheduled = true;
    requestAnimationFrame(() => { pushScheduled = false; if (dirty) pushCandidates(); });
  }
  function activate(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    for (const [Ctor, type] of [[PointerEvent, 'pointerdown'], [MouseEvent, 'mousedown'], [PointerEvent, 'pointerup'], [MouseEvent, 'mouseup']]) {
      try { el.dispatchEvent(new Ctor(type, { ...common, pointerId: 1, isPrimary: true, button: 0 })); } catch {}
    }
    if (el.matches('input,select,textarea')) { el.focus(); return; }
    el.click();
    setTimeout(markDirty, 150);
  }
  function scrollIntoAnchor(el) {
    const r = el.getBoundingClientRect();
    const delta = r.top - innerHeight * 0.4;
    if (Math.abs(delta) < 8) return;
    (scrollRoot || window).scrollBy({ top: delta, behavior: 'auto' });
    markDirty();
  }
  function selectorFor(el) {
    const part = (e) => {
      if (e.id && !/\d{3,}/.test(e.id)) return '#' + CSS.escape(e.id);
      const cls = [...e.classList].filter((c) => !/^(hub-|focused|active|is-|js-)/.test(c) && !/\d{3,}/.test(c)).slice(0, 2);
      let sel = e.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
      const p = e.parentElement;
      if (p && p.querySelectorAll(':scope > ' + sel).length > 1) {
        const idx = [...p.children].filter((c) => c.tagName === e.tagName).indexOf(e) + 1;
        sel += `:nth-of-type(${idx})`;
      }
      return sel;
    };
    const chain = [];
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) { chain.unshift(part(e)); if (e.id) break; }
    return chain.join(' > ');
  }
  function hideUser(el) {
    let target = el;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if ((PRESERVE && p.matches(PRESERVE)) || p.querySelector('video')) break;
      const pr = p.getBoundingClientRect(), tr = target.getBoundingClientRect();
      if (pr.width * pr.height > tr.width * tr.height * 1.5) break;
      target = p;
    }
    const selector = selectorFor(target);
    hide(target, 'user');
    markDirty();
    return selector;
  }

  // ---- 7. In-frame player takeover ----------------------------------------------
  // The video is reparented into an overlay inside this document (keeps the decoder alive) and
  // controlled here; the shell only renders the OSD from the state we send it.
  const player = {
    video: null, home: null, overlay: null, pendingSeek: null, seekTimer: null, scanRate: 1, scanTimer: null, hadControls: false, lastSent: 0,
    get active() { return !!this.video; },
    attach(video, { resumeAt = 0 } = {}) {
      if (this.video) this.detach();
      this.video = video; this.home = { parent: video.parentNode, next: video.nextSibling };
      const overlay = document.createElement('div');
      overlay.className = 'hub-player-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646;display:flex;align-items:center;justify-content:center;';
      video.style.cssText += ';width:100%;height:100%;object-fit:contain;max-width:none;max-height:none;';
      this.hadControls = video.controls; video.controls = false;
      overlay.appendChild(video); document.body.appendChild(overlay); this.overlay = overlay;
      document.documentElement.classList.add('hub-playback');
      if (resumeAt > 0) {
        const seek = () => { if (typeof video.fastSeek === 'function') video.fastSeek(resumeAt); else video.currentTime = resumeAt; };
        if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
      }
      try { video.play(); } catch {}
      this._emit = () => this.emit();
      for (const ev of ['timeupdate', 'play', 'pause', 'ratechange', 'seeking', 'seeked', 'durationchange', 'ended']) video.addEventListener(ev, this._emit);
      this.emit(true);
    },
    detach() {
      const v = this.video; if (!v) return;
      this.stopScan();
      this.emit(true);
      v.pause();
      for (const ev of ['timeupdate', 'play', 'pause', 'ratechange', 'seeking', 'seeked', 'durationchange', 'ended']) v.removeEventListener(ev, this._emit);
      v.style.cssText = v.style.cssText.replace(/width:100%;height:100%;object-fit:contain;max-width:none;max-height:none;/, '');
      v.controls = this.hadControls;
      if (this.home.parent) this.home.parent.insertBefore(v, this.home.next);
      this.overlay?.remove(); this.overlay = null;
      document.documentElement.classList.remove('hub-playback');
      this.video = null;
      send({ type: 'hub:player', active: false });
      markDirty();
    },
    toggle() { if (!this.video) return; if (this.scanRate !== 1) { this.stopScan(); return; } this.video.paused ? this.video.play() : this.video.pause(); this.emit(true); },
    nudge(sign, repeat) {
      if (!this.video) return;
      const step = repeat ? 10 : 5;
      this.pendingSeek = Math.max(0, Math.min(this.video.duration || Infinity, (this.pendingSeek ?? this.video.currentTime) + sign * step));
      this.emit(true);
      if (!this.seekTimer) this.seekTimer = setTimeout(() => this.commit(), 250);
    },
    commit() {
      clearTimeout(this.seekTimer); this.seekTimer = null;
      if (this.pendingSeek == null || !this.video) return;
      const t = this.pendingSeek; this.pendingSeek = null;
      if (typeof this.video.fastSeek === 'function') this.video.fastSeek(t); else this.video.currentTime = t;
    },
    scan(sign) {
      if (!this.video) return;
      if (sign < 0) { this.nudge(-1, true); return; }
      const rates = [2, 4, 8]; const i = rates.indexOf(this.scanRate);
      if (i === rates.length - 1) { this.stopScan(); this.scanTimer = setInterval(() => this.nudge(1, true), 300); this.scanRate = 16; }
      else { this.scanRate = rates[i + 1]; this.video.playbackRate = this.scanRate; this.video.muted = this.scanRate > 2; this.video.play(); }
      this.emit(true);
    },
    stopScan() { clearInterval(this.scanTimer); this.scanTimer = null; if (this.video) { this.video.playbackRate = 1; this.video.muted = false; } this.scanRate = 1; },
    emit(force) {
      const v = this.video; if (!v) return;
      const now = performance.now();
      if (!force && now - this.lastSent < 500) return;
      this.lastSent = now;
      send({ type: 'hub:player', active: true, t: this.pendingSeek ?? v.currentTime, d: v.duration || 0, paused: v.paused, rate: this.scanRate, ended: v.ended, show: !!force });
    },
  };

  // ---- 8. Commands from the shell ----------------------------------------------
  window.addEventListener('message', (e) => {
    if (SHELL && e.origin !== SHELL) return;
    const m = e.data || {};
    switch (m.type) {
      case 'hub:ping': send({ type: 'hub:pong', n: m.n }); break;
      case 'hub:candidates': pushCandidates(); break;
      case 'hub:activate': { const el = elOf(m.id); if (!el) break; if (el.tagName === 'VIDEO') player.attach(el, m); else activate(el); break; }
      case 'hub:anchor': { const el = elOf(m.id); if (el) scrollIntoAnchor(el); break; }
      case 'hub:scrollBy': (scrollRoot || window).scrollBy({ top: m.dy }); markDirty(); break;
      case 'hub:elementAt': {
        const el = document.elementFromPoint(m.x, m.y); if (!el) { send({ type: 'hub:nothing' }); break; }
        if (m.then === 'hide') send({ type: 'hub:hidden', selector: hideUser(el) });
        else if (el.tagName === 'VIDEO' || el.closest('video')) player.attach(el.closest('video') || el, m);
        else activate(el);
        break;
      }
      case 'hub:hide': { const el = elOf(m.id); if (el) send({ type: 'hub:hidden', selector: hideUser(el) }); break; }
      case 'hub:play': { const v = (m.id && elOf(m.id)) || document.querySelector(RULES.player) || document.querySelector('video'); if (v) player.attach(v, m); else send({ type: 'hub:noplayer' }); break; }
      case 'hub:player': if (typeof player[m.cmd] === 'function') player[m.cmd](...(m.args || [])); break;
      case 'hub:decisions': send({ type: 'hub:decisions', total: decisions.length, hidden: decisions.filter((d) => d.kind === 'hide').length, recent: decisions.slice(-8) }); break;
      case 'hub:back': history.back(); break;
      case 'hub:navigate': if (typeof m.path === 'string' && m.path.startsWith('/p/')) location.href = m.path; break;
    }
  });

  // ---- 9. Boot ------------------------------------------------------------------
  function boot() {
    setupScrollRoot();
    mo.observe(document.documentElement, { childList: true, subtree: true });
    schedule(document.body ? document.body.querySelectorAll('*') : []);
    addEventListener('resize', markDirty, { passive: true });
    addEventListener('scroll', markDirty, { passive: true, capture: true });
    send({ type: 'hub:ready', source: SOURCE, href: location.pathname + location.search, title: document.title });
    pushCandidates();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
