// Injected into every proxied portal page, before the portal's own scripts.
// The page lives on the portal origin; the shell lives on the hub origin. They talk only through
// postMessage, so nothing a portal script does can reach the shell, its storage or the hub API.
// Responsibilities here: desktop-layout commitment, routing every runtime URL through the hub,
// popup/redirect suppression, seeing into web components' shadow trees, noise removal that preserves
// grid geometry, scroll-root forwarding, dimming bright pages, focus candidates for spatial
// navigation, and the in-frame player takeover.
(function () {
  'use strict';
  const RULES = Object.assign({ css: [], removeOnMount: [], preserve: [], scrollRoot: null, player: 'video', touch: false }, window.__HUB_RULES || {});
  const SHELL = window.__HUB_SHELL || '';
  const SOURCE = RULES.sourceId, PORTAL_ORIGIN = window.__HUB_ORIGIN || '';
  // The hub serves this page under /p/<source>/..., but the site's own router reads location.pathname
  // and takes the prefix for an unknown page (Tubi then sends itself to its 404 screen on its real
  // host, which the frame refuses: a white screen). So the prefix is dropped from the address before
  // the site's scripts run. Every URL this script routes still carries it, and the shell is told the
  // prefixed path; a request the page makes without it is mapped back by the hub from a cookie.
  const PREFIX = `/p/${SOURCE}`;
  try {
    if (location.pathname === PREFIX || location.pathname.startsWith(PREFIX + '/')) history.replaceState(history.state, '', (location.pathname.slice(PREFIX.length) || '/') + location.search + location.hash);
  } catch {}
  const hubHref = () => `${PREFIX}${location.pathname}${location.search}`;
  const PRESERVE = RULES.preserve.join(',') || null;
  const REMOVE = RULES.removeOnMount.join(',') || null;
  const AD_RATIOS = [[300, 250], [728, 90], [320, 50], [160, 600], [970, 250], [300, 600], [336, 280]];
  const decisions = [];
  // A site's player often lives in an embedded frame, itself a hub page with this script. Only the
  // top page talks to the shell; a nested frame talks to its parent page, which relays.
  // Nested means the parent is a hub page too (same origin, readable); the shell's window is not.
  const NESTED = (() => { try { return window.parent !== window && window.parent.location.origin === location.origin; } catch { return false; } })();
  const send = (msg) => {
    try {
      if (!NESTED) parent.postMessage(msg, SHELL || '*');
      else parent.postMessage(Object.assign({}, msg, { hubFrame: true }), location.origin);
    } catch {}
  };

  // ---- 1. Commit the portal to its desktop layout ------------------------------
  // The page sees the browser the hub fetched it as (desktop Chrome, or a TV browser), not the
  // TV's own: a site that reads "Android" offers its app instead of playing.
  if (RULES.ua) {
    for (const k of ['userAgent', 'appVersion']) { try { Object.defineProperty(navigator, k, { get: () => RULES.ua, configurable: true }); } catch {} }
    try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64', configurable: true }); } catch {}
    try { Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true }); } catch {}
  }
  if (!RULES.touch) {
    try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true }); } catch {}
    try { delete window.ontouchstart; } catch {}
    try { Object.defineProperty(window, 'ontouchstart', { get: () => undefined, set() {}, configurable: true }); } catch {}
  }
  // A source with "dark": true gets a translucent black sheet over the page (content.css), so a
  // white site does not light up the room. Set before first paint; lifted during playback.
  if (RULES.dark) document.documentElement.classList.add('hub-dark');

  // ---- 2. Every URL a script makes goes through the hub -------------------------
  const sameOrigin = (href) => { try { return new URL(href, location.href).origin === location.origin; } catch { return false; } };
  const HUB_PATHS = /^\/(p|x)\/|^\/shell\/inject\//;
  /** Where this page really is: its own path on the portal's origin, not on the hub's. */
  const realBase = () => { try { return new URL(location.pathname + location.search, PORTAL_ORIGIN || location.origin).href; } catch { return location.href; } };
  function toHub(url) {
    const s = String(url);
    let u;
    try { u = new URL(s, location.href); } catch { return url; }
    if (!/^https?:$/.test(u.protocol)) return url;
    if (u.origin === location.origin && HUB_PATHS.test(u.pathname)) return url;        // already a hub URL
    // The page's own relative URL ("/api/list") and a protocol-relative one ("//cdn/x.js") mean the
    // portal's origin and scheme, not the hub's: resolve them against where the page really is.
    try {
      if (s.startsWith('//')) u = new URL(s, realBase());
      else if (u.origin === location.origin) u = new URL(u.pathname + u.search + u.hash, realBase());
    } catch { return url; }
    if (PORTAL_ORIGIN && u.origin === PORTAL_ORIGIN) return `/p/${SOURCE}${u.pathname}${u.search}${u.hash}`;
    return `/x/${SOURCE}/${encodeURIComponent(u.href)}`;
  }
  /** The address a page wrote, back from the hub's routed form: what the page reads from src/href
   *  must look like what it set, or its own checks fail (Vimeo's player code refuses an iframe
   *  whose src is not a vimeo.com address). */
  function fromHub(value) {
    const s = String(value);
    if (!HUB_PATHS.test(s) && !s.includes('/x/') && !s.includes('/p/')) return value;
    let u;
    try { u = new URL(s, location.href); } catch { return value; }
    if (u.origin !== location.origin) return value;
    let m = u.pathname.match(/^\/x\/[^/]+\/(.+)$/);
    if (m) { try { return decodeURIComponent(m[1]) + u.search + u.hash; } catch { return value; } }
    m = u.pathname.match(/^\/p\/[^/]+(\/.*)?$/);
    if (m && PORTAL_ORIGIN) return PORTAL_ORIGIN + (m[1] || '/') + u.search + u.hash;
    return value;
  }
  const toHubSrcset = (v) => String(v).split(',').map((part) => {
    const [u, d] = part.trim().split(/\s+/);
    return u ? [toHub(u), d].filter(Boolean).join(' ') : part;
  }).join(', ');
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
    Object.defineProperty(Ctor.prototype, prop, { get() { return fromHub(d.get.call(this)); }, set(v) { d.set.call(this, toHub(String(v))); }, configurable: true });
  }
  for (const Ctor of [HTMLImageElement, HTMLSourceElement]) {
    const d = Object.getOwnPropertyDescriptor(Ctor.prototype, 'srcset');
    if (!d || !d.set) continue;
    Object.defineProperty(Ctor.prototype, 'srcset', { get: d.get, set(v) { d.set.call(this, toHubSrcset(v)); }, configurable: true });
  }
  // Pictures a script sets as CSS backgrounds go through the hub too; the page's policy refuses a
  // direct load from any other host, so without this a TV-style app shows blank tiles.
  const routeCssUrls = (v) => String(v).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => (/^(data|blob):/i.test(u) ? m : `url(${q}${toHub(u)}${q})`));
  for (const prop of ['backgroundImage', 'background', 'maskImage', 'listStyleImage']) {
    const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop);
    if (d && d.set) Object.defineProperty(CSSStyleDeclaration.prototype, prop, { get: d.get, set(v) { d.set.call(this, routeCssUrls(v)); }, configurable: true });
  }
  const realSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) { return realSetProperty.call(this, name, /url\(/i.test(String(value)) ? routeCssUrls(value) : value, priority); };
  const realSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if ((n === 'src' || n === 'href' || n === 'data-src' || n === 'poster') && /^(https?:)?\/\//i.test(String(value))) value = toHub(String(value));
    else if (n === 'srcset' || n === 'data-srcset') value = toHubSrcset(value);
    else if (n === 'style' && /url\(/i.test(String(value))) value = routeCssUrls(value);
    return realSetAttribute.call(this, name, value);
  };
  const realGetAttribute = Element.prototype.getAttribute;
  const rawAttribute = (el, name) => realGetAttribute.call(el, name);
  Element.prototype.getAttribute = function (name) {
    const v = realGetAttribute.call(this, name);
    if (v == null || this.tagName === 'A') return v;                // links stay as routed
    const n = String(name).toLowerCase();
    return (n === 'src' || n === 'href' || n === 'data-src' || n === 'poster') ? fromHub(v) : v;
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
    } else {
      const routed = toHub(a.href);
      if (routed !== a.href && routed.startsWith(PREFIX)) a.setAttribute('href', routed);
      if (a.target === '_blank') a.target = '_self';
    }
  }, true);

  // ---- 3a. Play at once ----------------------------------------------------------
  // A title chosen on the hub's home screen should start without a visit to the site's page: press
  // the page's own play control if it has one, then take over the video once it carries a source.
  // A preview or trailer video is not taken while a play control is still there to press.
  const PLAY_WORDS = /^(play|play now|play movie|play episode|play video|watch|watch now|watch free|watch for free|resume|continue watching|start watching)\b/i;
  const PLAY_HINT = /\b(play|watch)[-_ ]?(btn|button|cta|now)?\b/i;
  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').slice(0, 200)).replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  /** The page's own play control for the title it shows: the first one in the page that says so,
   *  skipping controls that sit inside a link to some other page (a tile's play overlay). */
  function findPlayControl() {
    let hinted = null;
    for (const el of queryAll(FOCUSABLE + ',[class*="play" i],[data-testid*="play" i],[id*="play" i]')) {
      if (el.tagName === 'VIDEO' || el.closest('.hub-hidden,.hub-placeholder')) continue;
      // Anywhere on the page, not only in view: on a TV the hero fills the frame and the play
      // button sits below it. It is scrolled to before it is pressed.
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.width > innerWidth * 0.9) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const link = el.closest('a[href]');
      if (link && link !== el) {
        const to = link.getAttribute('href') || '';
        try { if (to && !/^(#|javascript:)/i.test(to) && new URL(to, location.href).pathname !== location.pathname) continue; } catch {}
      }
      const label = labelOf(el);
      if (label.length > 30 || /trailer|preview|playlist|player|in the app|get the app|download|app store|google play|^play icon$/i.test(label)) continue;   // a tile's text, an app offer, not the control
      if (PLAY_WORDS.test(label)) return el;
      if (!hinted && !label && PLAY_HINT.test(`${el.className} ${el.id} ${el.getAttribute('data-testid') || ''}`)) hinted = el;
    }
    return hinted;
  }
  const tell = (step, data) => send({ type: 'hub:trace', step, data });
  function autoplay(m) {
    const deadline = Date.now() + 20000;
    let pressed = null;
    tell('autoplay-start', { path: location.pathname, title: document.title.slice(0, 60), videos: queryAll('video').length });
    const ready = (v) => !!(v && (v.readyState > 0 || v.currentSrc || v.getAttribute('src') || v.querySelector('source')));
    // The biggest video that is not a preview or trailer clip (a hero's teaser is not the film).
    const isClip = (v) => /preview|trailer|promo|teaser/i.test(String(v.currentSrc || v.getAttribute('src') || ''));
    const largest = () => { const vs = queryAll(RULES.player).concat(queryAll('video')).filter((v) => { const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; }); return vs.find((v) => !isClip(v)) || (pressed ? vs[0] : undefined); };
    const step = () => {
      const btn = pressed ? null : findPlayControl();
      if (btn) {
        pressed = Date.now(); decisions.push({ kind: 'autoplay', tag: btn.tagName, cls: labelOf(btn) });
        tell('pressed', { tag: btn.tagName, label: labelOf(btn), href: btn.getAttribute('href') || '', top: Math.round(btn.getBoundingClientRect().top) });
        try { btn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
        activate(btn); return false;
      }
      const v = largest();
      if (ready(v) && (pressed || !findPlayControl())) { tell('attach', { readyState: v.readyState, src: String(v.currentSrc || v.getAttribute('src') || '').slice(0, 80) }); player.attach(v, m); return true; }
      return false;
    };
    const timer = setInterval(() => {
      if (step()) return clearInterval(timer);
      if (Date.now() > deadline) {
        clearInterval(timer);
        const v = largest();
        const seen = queryAll('button,a[href],[role="button"]').map((e) => labelOf(e)).filter((l) => /play|watch|resume/i.test(l)).slice(0, 6);
        tell('autoplay-gave-up', { pressed: !!pressed, videos: queryAll('video').length, path: location.pathname, title: document.title.slice(0, 60), playish: seen, video: v ? { readyState: v.readyState, src: String(v.currentSrc || v.getAttribute('src') || '').slice(0, 80), w: Math.round(v.getBoundingClientRect().width) } : null });
        send({ type: 'hub:noplayer' });
      }
    }, 700);
    step();
  }

  // ---- 3b. Clickable tracking for focus candidates ------------------------------
  const realAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((type === 'click' || type === 'mousedown' || type === 'pointerdown') && this instanceof Element) this.__hubClickable = true;
    return realAdd.call(this, type, fn, opts);
  };

  // ---- 3c. Shadow roots ----------------------------------------------------------
  // Sites built from web components keep their tiles, links and players inside shadow trees, which
  // document-level queries and observers never reach. Every root the page creates is forced open,
  // remembered, and watched for changes the same way the document is.
  const shadowRoots = new Set();
  const shadowMo = new MutationObserver(() => markDirty());
  const realAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = realAttachShadow.call(this, Object.assign({}, init, { mode: 'open' }));
    shadowRoots.add(root);
    try { shadowMo.observe(root, { childList: true, subtree: true }); } catch {}
    markDirty();
    return root;
  };
  /** The document plus every shadow root whose host is still in the page. */
  function roots() {
    const out = [document];
    for (const r of shadowRoots) { if (r.host && r.host.isConnected) out.push(r); else shadowRoots.delete(r); }
    return out;
  }
  function queryAll(selector) {
    const out = [];
    for (const r of roots()) { try { out.push(...r.querySelectorAll(selector)); } catch {} }
    return out;
  }
  /** elementFromPoint that keeps descending while the hit is a shadow host. */
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && el.shadowRoot && i < 12; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

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
    for (const el of queryAll(FOCUSABLE)) push(el);
    for (const root of roots()) {
      const base = root === document ? document.body : root;
      if (!base) continue;
      const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.__hubClickable && !n.closest(FOCUSABLE)) push(n);
    }
    return out;
  }
  let dirty = true, pushScheduled = false;
  function pushCandidates() { send({ type: 'hub:candidates', list: snapshot(), href: hubHref() }); dirty = false; }
  function markDirty() {
    dirty = true;
    if (pushScheduled) return;
    pushScheduled = true;
    requestAnimationFrame(() => { pushScheduled = false; if (dirty) pushCandidates(); });
  }
  /** Click an element the way a mouse would, at the given point (the cursor) or at its centre. */
  function activate(el, px, py) {
    const r = el.getBoundingClientRect();
    const x = px ?? r.left + r.width / 2, y = py ?? r.top + r.height / 2;
    hoverAt(x, y, el);
    const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };
    for (const [Ctor, type] of [[PointerEvent, 'pointerdown'], [MouseEvent, 'mousedown'], [PointerEvent, 'pointerup'], [MouseEvent, 'mouseup']]) {
      try { el.dispatchEvent(new Ctor(type, { ...common, pointerId: 1, isPrimary: true, button: 0, buttons: type.endsWith('down') ? 1 : 0 })); } catch {}
    }
    if (el.matches('input,select,textarea')) { el.focus(); return; }
    try { el.dispatchEvent(new MouseEvent('click', { ...common, button: 0, detail: 1 })); } catch { el.click(); }
    setTimeout(markDirty, 150);
  }

  // ---- 6b. The shell's cursor, as a mouse the page can see -------------------------
  // Hover menus and player controls appear on mouse movement; the virtual cursor sends its
  // position and the page gets pointer events as if a mouse had moved there.
  let hovered = null;
  function hoverAt(x, y, el = deepElementFromPoint(x, y)) {
    if (!el) return;
    const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    const fire = (target, Ctor, type, extra = {}) => { try { target.dispatchEvent(new Ctor(type, { ...common, ...extra })); } catch {} };
    if (el !== hovered) {
      if (hovered && hovered.isConnected) {
        fire(hovered, PointerEvent, 'pointerout', { relatedTarget: el }); fire(hovered, MouseEvent, 'mouseout', { relatedTarget: el });
        fire(hovered, PointerEvent, 'pointerleave', { bubbles: false, relatedTarget: el }); fire(hovered, MouseEvent, 'mouseleave', { bubbles: false, relatedTarget: el });
      }
      fire(el, PointerEvent, 'pointerover', { relatedTarget: hovered }); fire(el, MouseEvent, 'mouseover', { relatedTarget: hovered });
      fire(el, PointerEvent, 'pointerenter', { bubbles: false, relatedTarget: hovered }); fire(el, MouseEvent, 'mouseenter', { bubbles: false, relatedTarget: hovered });
      hovered = el;
    }
    fire(el, PointerEvent, 'pointermove'); fire(el, MouseEvent, 'mousemove');
  }
  /** A same-origin embedded frame under the point (a site's player): the window to pass the shell's command to. */
  function frameAt(el) {
    if (!el || el.tagName !== 'IFRAME' || !el.contentWindow) return null;
    try { if (new URL(rawAttribute(el, 'src') || '', location.href).origin !== location.origin) return null; } catch { return null; }
    return el;
  }
  const intoFrame = (frame, m, x, y) => {
    const r = frame.getBoundingClientRect();
    try { frame.contentWindow.postMessage(Object.assign({}, m, { x: x - r.left, y: y - r.top, hubParent: true }), location.origin); } catch {}
  };
  // The nested frame whose player is running, enlarged to fill this page while it plays.
  let playerFrame = null, playerFrameStyle = '';
  function frameOf(win) { return queryAll('iframe').find((f) => f.contentWindow === win) || null; }
  function framePlayback(win, active) {
    if (active) {
      const f = frameOf(win); if (!f) return;
      if (playerFrame && playerFrame !== f) framePlayback(playerFrame.contentWindow, false);
      if (playerFrame !== f) { playerFrame = f; playerFrameStyle = f.style.cssText; f.style.cssText += ';position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;z-index:2147483646;background:#000;'; }
      document.documentElement.classList.add('hub-playback');
    } else if (playerFrame && (!win || playerFrame.contentWindow === win)) {
      playerFrame.style.cssText = playerFrameStyle; playerFrame = null;
      document.documentElement.classList.remove('hub-playback');
      markDirty();
    }
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

  // In an embedded frame, a video that starts playing is the site's player (an embedded player
  // frame has nothing else in it): take it over, so the remote's transport keys work and the
  // frame fills the TV. Top-level pages keep their decorative autoplay clips.
  if (NESTED) {
    document.addEventListener('playing', (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement) || player.active) return;
      const r = v.getBoundingClientRect();
      if (r.width * r.height < innerWidth * innerHeight * 0.3) return;
      player.attach(v, {});
    }, true);
  }

  // ---- 8. Commands from the shell ----------------------------------------------
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    // From an embedded hub frame (a site's player): relay what the shell needs, and when its player
    // runs, make the frame fill this page.
    if (m.hubFrame && e.origin === location.origin && e.source && e.source !== window) {
      const msg = Object.assign({}, m); delete msg.hubFrame;
      if (msg.type === 'hub:player') { framePlayback(e.source, !!msg.active); send(msg); }
      else if (['hub:hidden', 'hub:nothing', 'hub:noplayer'].includes(msg.type)) send(msg);
      return;
    }
    const fromShell = e.source === parent && (!SHELL || e.origin === SHELL);
    const fromParent = NESTED && m.hubParent && e.source === parent && e.origin === location.origin;
    if (!fromShell && !fromParent) return;
    switch (m.type) {
      case 'hub:ping': send({ type: 'hub:pong', n: m.n }); break;
      case 'hub:candidates': pushCandidates(); break;
      case 'hub:activate': { const el = elOf(m.id); if (!el) break; if (el.tagName === 'VIDEO') player.attach(el, m); else activate(el); break; }
      case 'hub:anchor': { const el = elOf(m.id); if (el) scrollIntoAnchor(el); break; }
      case 'hub:scrollBy': (scrollRoot || window).scrollBy({ top: m.dy }); markDirty(); break;
      case 'hub:pointer': { const el = deepElementFromPoint(m.x, m.y); const f = frameAt(el); if (f) intoFrame(f, m, m.x, m.y); else hoverAt(m.x, m.y, el); break; }
      case 'hub:elementAt': {
        const el = deepElementFromPoint(m.x, m.y); if (!el) { send({ type: 'hub:nothing' }); break; }
        const f = frameAt(el);
        if (f && m.then !== 'hide') { intoFrame(f, m, m.x, m.y); break; }
        if (m.then === 'hide') send({ type: 'hub:hidden', selector: hideUser(el) });
        else if (el.tagName === 'VIDEO' || el.closest('video')) player.attach(el.closest('video') || el, m);
        else activate(el, m.x, m.y);
        break;
      }
      case 'hub:hide': { const el = elOf(m.id); if (el) send({ type: 'hub:hidden', selector: hideUser(el) }); break; }
      case 'hub:play': {
        const v = (m.id && elOf(m.id)) || queryAll(RULES.player)[0] || queryAll('video')[0];
        if (v) player.attach(v, m);
        else if (playerFrame) intoFrame(playerFrame, m, 0, 0);
        else send({ type: 'hub:noplayer' });
        break;
      }
      case 'hub:autoplay': autoplay(m); break;
      // A remote key for the page itself (rules.keys = 'page'): sent as the key a TV browser would
      // send, so an app that drives its own highlight sees it.
      case 'hub:key': {
        const codes = { up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'], select: [13, 'Enter'], back: [27, 'Escape'], play: [415, 'MediaPlay'], pause: [19, 'MediaPause'], playpause: [179, 'MediaPlayPause'], ff: [417, 'MediaFastForward'], rw: [412, 'MediaRewind'] };
        const c = codes[m.intent]; if (!c) break;
        const target = document.activeElement || document.body;
        for (const type of ['keydown', 'keyup']) {
          const ev = new KeyboardEvent(type, { key: c[1], code: c[1], bubbles: true, cancelable: true });
          for (const prop of ['keyCode', 'which']) { try { Object.defineProperty(ev, prop, { get: () => c[0] }); } catch {} }
          target.dispatchEvent(ev);
        }
        break;
      }
      // Move to another page of this site inside its app, the way a click on one of its own links
      // would, without a new document: some sites only build a title page properly this way.
      case 'hub:go': {
        const p = String(m.path || '');
        if (!p.startsWith('/')) break;
        const real = p.startsWith(PREFIX) ? p.slice(PREFIX.length) || '/' : p;
        const was = document.title, t0 = Date.now();
        try { history.pushState({}, '', real); dispatchEvent(new PopStateEvent('popstate', { state: {} })); } catch {}
        markDirty();
        // Then start the title, but only once the app has drawn it: the address is the title's and
        // the page title has changed. An app still booting may have missed the first nudge, so it
        // is repeated; if the title never appears, nothing is pressed (the wrong film is worse than none).
        if (m.then === 'autoplay') {
          const target = real.split('?')[0];
          const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const want = norm(m.title).slice(0, 16);
          // The chosen title's name in the page title says the app has drawn that page, not the one before.
          const drawn = () => location.pathname === target && (want ? norm(document.title).includes(want) : document.title !== was);
          let tries = 0;
          tell('go', { real, want, title: was.slice(0, 60) });
          const wait = setInterval(() => {
            if (drawn()) { clearInterval(wait); tell('drawn', { path: location.pathname, title: document.title.slice(0, 60), ms: Date.now() - t0 }); setTimeout(() => autoplay(m), 1200); return; }
            if (Date.now() - t0 > 15000) { clearInterval(wait); tell('not-drawn', { path: location.pathname, title: document.title.slice(0, 60) }); send({ type: 'hub:noplayer' }); return; }
            if (++tries % 4 === 0) { try { history.replaceState({}, '', real); dispatchEvent(new PopStateEvent('popstate', { state: {} })); } catch {} }
          }, 400);
        }
        break;
      }
      case 'hub:player':
        if (player.active) { if (typeof player[m.cmd] === 'function') player[m.cmd](...(m.args || [])); }
        else if (playerFrame) intoFrame(playerFrame, m, 0, 0);     // the running player is in an embedded frame
        break;
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
    send({ type: 'hub:ready', source: SOURCE, href: hubHref(), title: document.title });
    pushCandidates();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
