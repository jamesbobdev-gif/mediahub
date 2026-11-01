// Injected into every proxied portal page, before the portal's own scripts.
// Responsibilities: desktop-layout commitment, popup suppression, noise removal
// that preserves grid geometry, scroll-root forwarding for infinite scroll, and a
// small same-origin API (window.__hub) the shell drives for spatial navigation.
(function () {
  'use strict';
  const RULES = Object.assign({ css: [], removeOnMount: [], preserve: [], scrollRoot: null, player: 'video', touch: false }, window.__HUB_RULES || {});
  const PRESERVE = RULES.preserve.join(',') || null;
  const REMOVE = RULES.removeOnMount.join(',') || null;
  const AD_RATIOS = [[300, 250], [728, 90], [320, 50], [160, 600], [970, 250], [300, 600], [336, 280]];
  const decisions = [];

  // ---- 1. Commit the portal to its desktop layout ------------------------------
  if (!RULES.touch) {
    try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true }); } catch {}
    try { delete window.ontouchstart; } catch {}
    try { Object.defineProperty(window, 'ontouchstart', { get: () => undefined, set() {}, configurable: true }); } catch {}
  }

  // ---- 2. Every URL a script makes goes through the hub -------------------------
  // Static markup is rewritten by the proxy; this covers URLs set at runtime (fetch, XHR, img.src,
  // script.src, location changes). Portal-origin URLs map to /p/<source>/, anything else to /x/.
  const SOURCE = RULES.sourceId, PORTAL_ORIGIN = window.__HUB_ORIGIN || '';
  const sameOrigin = (href) => { try { return new URL(href, location.href).origin === location.origin; } catch { return false; } };
  function toHub(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return url; }
    if (u.origin === location.origin || !/^https?:$/.test(u.protocol)) return url;
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
  // Navigation of this frame to any non-hub origin is also refused by the browser (CSP frame-src on
  // the shell), so even a script that bypasses these hooks cannot take the TV elsewhere.
  const realOpen = window.open;
  window.open = function (url, ...rest) {
    if (url && !sameOrigin(url)) { decisions.push({ kind: 'popup', url: String(url) }); return null; }
    return realOpen.call(window, url, ...rest);
  };
  let lastClickAt = 0;
  document.addEventListener('click', (e) => {
    lastClickAt = performance.now();
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^(javascript|data|blob):/i.test(href)) return;
    if (!sameOrigin(a.href)) {
      // A script-assigned absolute link to the portal's own origin is routed through the hub;
      // a link to any other site is a redirect attempt and is dropped.
      const routed = toHub(a.href);
      if (routed.startsWith(`/p/${SOURCE}`)) { a.setAttribute('href', routed); if (a.target === '_blank') a.target = '_self'; return; }
      e.preventDefault(); e.stopImmediatePropagation(); decisions.push({ kind: 'blocked-link', url: a.href });
    } else if (a.href.startsWith(location.origin + '/x/')) {
      e.preventDefault(); e.stopImmediatePropagation(); decisions.push({ kind: 'blocked-link', url: a.href });
    } else if (a.target === '_blank') a.target = '_self';
  }, true);
  // Navigation spawned within 100ms of a click to a different origin is a pop-under pattern.
  const realAssign = location.assign.bind(location);
  window.addEventListener('beforeunload', (e) => {
    if (performance.now() - lastClickAt < 100 && document.activeElement && document.activeElement.tagName !== 'A') { e.preventDefault(); e.returnValue = ''; }
  });

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
    if (isGridCell(el)) { el.replaceWith(placeholderFor(el)); return; }   // keep neighbours in place
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
    // Navigation chrome (several links) is not an overlay even when fixed; playback mode un-fixes it instead.
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
      rectsDirty = true;
    });
  }
  const mo = new MutationObserver((muts) => { for (const m of muts) schedule(m.addedNodes); });
  // An image that resolved to the proxy's 1x1 placeholder is a neutralised ad: collapse its slot,
  // replacing a grid cell with a same-size placeholder so neighbours keep their position.
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
    const forward = () => { window.dispatchEvent(new Event('scroll')); rectsDirty = true; };
    scrollRoot.addEventListener('scroll', forward, { passive: true });
    const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get, configurable: true }); } catch {} };
    def(window, 'scrollY', () => scrollRoot.scrollTop);
    def(window, 'pageYOffset', () => scrollRoot.scrollTop);
    def(document.documentElement, 'scrollTop', () => scrollRoot.scrollTop);
    def(document.documentElement, 'scrollHeight', () => scrollRoot.scrollHeight);
    def(document.documentElement, 'clientHeight', () => scrollRoot.clientHeight);
    const realScrollTo = window.scrollTo.bind(window);
    window.scrollTo = (x, y) => { if (typeof x === 'object') scrollRoot.scrollTo(x); else scrollRoot.scrollTo(x, y); };
    window.scrollBy = (x, y) => scrollRoot.scrollBy(x, y);
  }

  // ---- 6. Shell-facing API ------------------------------------------------------
  let rectsDirty = true, rectCache = [];
  const FOCUSABLE = 'a[href],button,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],input,select,textarea,summary,video';
  function visible(el, r) {
    if (!r.width || !r.height) return false;
    if (r.bottom < -200 || r.top > innerHeight + 200) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
  }
  function candidates() {
    if (!rectsDirty) return rectCache;
    const out = [];
    const all = document.querySelectorAll(FOCUSABLE);
    const seen = new Set();
    const push = (el) => {
      if (seen.has(el) || el.closest('.hub-hidden,.hub-placeholder')) return;
      // Collapse nested focusables (a > img wrapped by a card with its own listener) to the outermost card.
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) return;
      seen.add(el);
      out.push({ el, x: r.left, y: r.top, w: r.width, h: r.height });
    };
    for (const el of all) push(el);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.__hubClickable && !n.closest(FOCUSABLE)) push(n);
    rectCache = out; rectsDirty = false;
    return out;
  }
  function activate(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    // Many portals bind mousedown only; send the full sequence.
    for (const [Ctor, type] of [[PointerEvent, 'pointerdown'], [MouseEvent, 'mousedown'], [PointerEvent, 'pointerup'], [MouseEvent, 'mouseup']]) {
      try { el.dispatchEvent(new Ctor(type, { ...common, pointerId: 1, isPrimary: true, button: 0 })); } catch {}
    }
    if (el.matches('input,select,textarea')) { el.focus(); return; }
    el.click();
  }
  function scrollIntoAnchor(el) {
    // Keep the focused row at ~40% from the top so the infinite-scroll sentinel is reached early.
    const r = el.getBoundingClientRect();
    const target = innerHeight * 0.4;
    const delta = r.top - target;
    if (Math.abs(delta) < 8) return;
    if (scrollRoot) scrollRoot.scrollBy({ top: delta, behavior: 'auto' });
    else window.scrollBy({ top: delta, behavior: 'auto' });
    rectsDirty = true;
  }
  function findVideo() { return document.querySelector(RULES.player) || document.querySelector('video'); }
  function setPlayback(on) { document.documentElement.classList.toggle('hub-playback', !!on); rectsDirty = true; }

  // Stable-ish CSS selector for the rule inspector: id, else tag.classes chain up to three levels.
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
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) {
      chain.unshift(part(e));
      if (e.id) break;
    }
    return chain.join(' > ');
  }
  /** User-driven hide: pick the largest ancestor that is still not a preserved/grid container, hide it, return its selector. */
  function hideUser(el) {
    let target = el;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if ((PRESERVE && p.matches(PRESERVE)) || p.querySelector('video')) break;
      const pr = p.getBoundingClientRect(), tr = target.getBoundingClientRect();
      if (pr.width * pr.height > tr.width * tr.height * 1.5) break;   // parent is much bigger: stop
      target = p;
    }
    const selector = selectorFor(target);
    hide(target, 'user');
    return selector;
  }

  window.__hub = {
    candidates, activate, scrollIntoAnchor, findVideo, setPlayback, selectorFor, hideUser,
    invalidate() { rectsDirty = true; },
    decisions,
    scrollBy(dy) { (scrollRoot || window).scrollBy({ top: dy }); rectsDirty = true; },
    elementAt(x, y) { return document.elementFromPoint(x, y); },
  };

  // ---- 7. Boot ------------------------------------------------------------------
  function boot() {
    setupScrollRoot();
    mo.observe(document.documentElement, { childList: true, subtree: true });
    schedule(document.body ? document.body.querySelectorAll('*') : []);
    addEventListener('resize', () => { rectsDirty = true; }, { passive: true });
    addEventListener('scroll', () => { rectsDirty = true; }, { passive: true, capture: true });
    try { parent.postMessage({ type: 'hub:ready', source: RULES.sourceId, href: location.href }, '*'); } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
