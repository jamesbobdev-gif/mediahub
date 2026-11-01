import { installKeyRouter, registerPlatformKeys, PLATFORM } from './keymap.js';
import { pickNext, refind } from './spatial.js';
import { VirtualCursor } from './cursor.js';
import { Player } from './player.js';
import { CatalogCache, ArtworkLru } from './catalog.js';
import { PortalFrame } from './portal.js';

const $ = (s) => document.querySelector(s);
const views = { home: $('#view-home'), portal: $('#view-portal') };
const ring = $('#focus-ring'), cursorEl = $('#cursor'), toast = $('#toast'), osd = $('#osd'), hud = $('#hud');

const state = {
  view: 'home',            // 'home' | 'portal'
  mode: 'spatial',         // 'spatial' | 'cursor'
  focus: null,             // {el,x,y,w,h} in shell coordinates
  sources: [],
  metrics: { focus: [], seek: [] },
};

const catalog = new CatalogCache();
const art = new ArtworkLru();
const portal = new PortalFrame({ frame: $('#portal-frame'), wrap: $('#portal-wrap') });
const cursor = new VirtualCursor({ el: cursorEl, bounds: () => ({ w: innerWidth, h: innerHeight }) });
const player = new Player({ osd });

// ---------- focus ring ----------
function setFocus(c, { scroll = true } = {}) {
  state.focus = c;
  if (!c) { ring.hidden = true; return; }
  // Scroll first, then measure: the ring is fixed-position and must follow the post-scroll rect.
  if (state.view === 'home') { c.el.classList.add('focused'); if (scroll) c.el.scrollIntoView({ block: 'center', inline: 'nearest' }); }
  else if (scroll) portal.hub?.scrollIntoAnchor(c.el);
  drawRing(c);
}
function drawRing(c) {
  let { x, y, w, h } = c;
  if (state.view === 'home') { const r = c.el.getBoundingClientRect(); x = r.left; y = r.top; w = r.width; h = r.height; }
  else { const fresh = refind(portal.candidates(), c.el); if (fresh) ({ x, y, w, h } = fresh); }
  ring.hidden = false;
  ring.style.transform = `translate(${x}px, ${y}px)`;
  ring.style.width = `${w}px`; ring.style.height = `${h}px`;
}
function currentCandidates() {
  if (state.view === 'home') {
    return [...views.home.querySelectorAll('[data-focusable]')].map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.left, y: r.top, w: r.width, h: r.height }; });
  }
  return portal.candidates();
}
function refreshFocus() {
  // Rects move after scroll/mutation; re-find the same element and redraw.
  const cands = currentCandidates();
  const same = state.focus && refind(cands, state.focus.el);
  if (same) setFocus(same, { scroll: false });
  else if (cands.length) setFocus(pickNext(null, cands, null), { scroll: false });
  else setFocus(null);
}
function move(dir) {
  const t0 = performance.now();
  views.home.querySelectorAll('.focused').forEach((e) => e.classList.remove('focused'));
  const cands = currentCandidates();
  const cur = state.focus && refind(cands, state.focus.el) || state.focus;
  const next = pickNext(cur, cands, dir);
  if (next) setFocus(next);
  else if (state.view === 'portal' && (dir === 'down' || dir === 'up')) { portal.hub?.scrollBy(dir === 'down' ? 300 : -300); requestAnimationFrame(refreshFocus); }
  requestAnimationFrame(() => { state.metrics.focus.push(performance.now() - t0); if (state.metrics.focus.length > 200) state.metrics.focus.shift(); });
}

// ---------- home view ----------
function renderHome() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const items = catalog.list();
  $('#home-count').textContent = `${items.length} titles · ${state.sources.length} sources`;
  for (const it of items) {
    const tile = document.createElement('div');
    tile.className = 'tile'; tile.dataset.focusable = ''; tile.dataset.id = it.id;
    tile.innerHTML = `<div class="poster"></div><div class="meta"><div class="title"></div><div class="sub"></div></div>`;
    tile.querySelector('.title').textContent = it.title;
    tile.querySelector('.sub').textContent = [it.year, it.kind, it.sources.map((s) => s.sourceId).join(', ')].filter(Boolean).join(' · ');
    grid.appendChild(tile);
  }
  for (const s of state.sources) {
    const b = document.createElement('div');
    b.className = 'tile source'; b.dataset.focusable = ''; b.dataset.portal = s.home;
    b.innerHTML = `<div class="poster"><span>⌂</span></div><div class="meta"><div class="title"></div><div class="sub">open portal</div></div>`;
    b.querySelector('.title').textContent = s.name;
    grid.prepend(b);
  }
  lazyArtwork();
}
let artObserver;
function lazyArtwork() {
  artObserver?.disconnect();
  // Only the visible grid plus two rows of lookahead is decoded (rootMargin).
  artObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const tile = e.target; artObserver.unobserve(tile);
      const it = catalog.items.get(tile.dataset.id); if (!it) continue;
      const url = catalog.artworkUrl(it); if (!url) continue;
      art.get(url).then((obj) => { tile.querySelector('.poster').style.backgroundImage = `url(${obj})`; }).catch(() => {});
    }
  }, { root: $('#view-home'), rootMargin: '600px 0px' });
  for (const t of $('#grid').querySelectorAll('.tile[data-id]')) artObserver.observe(t);
}
function homeSelect() {
  const el = state.focus?.el; if (!el) return;
  if (el.dataset.portal) return openPortal(el.dataset.portal);
  const it = catalog.items.get(el.dataset.id);
  const src = it?.sources.find((s) => s.itemUrl);
  if (!src) return say('No source URL for this title');
  const def = state.sources.find((s) => s.id === src.sourceId);
  const u = new URL(src.itemUrl);
  const origin = def?.origin ? new URL(def.origin) : null;
  const base = origin ? origin.pathname.replace(/\/$/, '') : '';
  const path = base && u.pathname.startsWith(base) ? u.pathname.slice(base.length) : u.pathname;
  openPortal(`/p/${src.sourceId}${path}${u.search}`);
}

// ---------- portal view ----------
function openPortal(url) {
  showView('portal');
  portal.load(url);
  say('Loading portal…');
}
portal.onReady = () => {
  say('');
  const hub = portal.hub;
  if (!hub) { say('Portal is not same-origin; injection failed'); return; }
  setTimeout(refreshFocus, 50);
  // Poll for a late-mounted player and for layout churn; cheap because rects are cached in-frame.
  clearInterval(state.portalTick);
  state.portalTick = setInterval(() => { if (state.view === 'portal' && !player.active) refreshFocus(); }, 500);
};
function portalSelect() {
  const hub = portal.hub; if (!hub) return;
  if (state.mode === 'cursor') {
    const p = portal.toFrame(cursor.x, cursor.y);
    const el = hub.elementAt(p.x, p.y); if (el) hub.activate(el);
    return;
  }
  const el = state.focus?.el; if (!el) return;
  if (el.tagName === 'VIDEO') { startPlayback(el); return; }
  hub.activate(el);
  setTimeout(refreshFocus, 150);
}
function startPlayback(video) {
  video = video || portal.hub?.findVideo();
  if (!video) return say('No player on this page');
  player.attach(video);
  player.onEnd = () => stopPlayback();
  ring.hidden = true;
  say('');
}
function stopPlayback() { player.detach(); refreshFocus(); }

function showView(name) {
  state.view = name;
  for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
  if (name === 'home') { clearInterval(state.portalTick); portal.frame.src = 'about:blank'; cursor.hide(); state.mode = 'spatial'; }
  refreshFocus();
}
function setMode(mode) {
  state.mode = mode;
  if (mode === 'cursor') { cursor.show(); ring.hidden = true; say('Cursor mode'); }
  else { cursor.hide(); refreshFocus(); say('Navigation mode'); }
}
function say(msg) { toast.textContent = msg; toast.hidden = !msg; clearTimeout(say.t); if (msg) say.t = setTimeout(() => { toast.hidden = true; }, 2000); }

// ---------- intent dispatch ----------
function dispatch(intent, { repeat, phase }) {
  if (phase === 'up') { if (state.mode === 'cursor' && ['up', 'down', 'left', 'right'].includes(intent)) cursor.release(intent); if (player.active && (intent === 'left' || intent === 'right')) player.commitSeek(); return; }
  if (player.active) {
    switch (intent) {
      case 'left': return player.nudge(-1, repeat);
      case 'right': return player.nudge(1, repeat);
      case 'ff': return player.scan(1);
      case 'rw': return player.scan(-1);
      case 'select': case 'play': case 'pause': case 'playpause': return player.togglePlay();
      case 'back': return stopPlayback();
      case 'info': return player.renderOsd(true);
      default: return;
    }
  }
  if (state.mode === 'cursor' && ['up', 'down', 'left', 'right'].includes(intent)) { if (!repeat) cursor.press(intent); return; }
  switch (intent) {
    case 'up': case 'down': case 'left': case 'right': return move(intent);
    case 'select': return state.view === 'home' ? homeSelect() : portalSelect();
    case 'back':
      if (state.view === 'portal') { const w = portal.win; if (w && w.history.length > 1 && !repeat && state.portalDepth > 0) { state.portalDepth--; w.history.back(); } else showView('home'); }
      return;
    case 'mode': case 'cursor': if (state.view === 'portal') setMode(state.mode === 'cursor' ? 'spatial' : 'cursor'); return;
    case 'play': case 'playpause': if (state.view === 'portal') startPlayback(); return;
    case 'menu': return showView('home');
    case 'info': return toggleHud();
    default: return;
  }
}
function toggleHud() {
  hud.hidden = !hud.hidden;
  if (hud.hidden) return;
  const p = (arr) => arr.length ? [50, 95].map((q) => `p${q}=${arr.slice().sort((a, b) => a - b)[Math.floor((q / 100) * (arr.length - 1))].toFixed(1)}ms`).join(' ') : 'n/a';
  const dec = portal.hub?.decisions || [];
  hud.textContent = `platform=${PLATFORM} view=${state.view} mode=${state.mode}\nfocus latency ${p(state.metrics.focus)}\nportal decisions: ${dec.length} (${dec.filter((d) => d.kind === 'hide').length} hidden, ${dec.filter((d) => d.kind !== 'hide').length} popups)\n` + dec.slice(-8).map((d) => `  ${d.kind} ${d.reason || ''} ${d.tag || ''} ${d.cls || d.url || ''}`).join('\n');
}

// ---------- boot ----------
async function boot() {
  registerPlatformKeys();
  installKeyRouter(dispatch);
  portal.attachReadyListener();
  state.sources = await fetch('/api/sources').then((r) => r.json());
  await catalog.init();
  renderHome();
  showView('home');
  try { const n = await catalog.sync(); if (n) { renderHome(); refreshFocus(); } } catch (e) { say(`Catalog sync failed: ${e.message}`); }
  setInterval(async () => { try { if (await catalog.sync()) { if (state.view === 'home') renderHome(); } } catch {} }, 60_000);
  addEventListener('resize', () => { portal.layout(); refreshFocus(); });
  let ringRaf = 0;
  views.home.addEventListener('scroll', () => { if (ringRaf) return; ringRaf = requestAnimationFrame(() => { ringRaf = 0; if (state.focus) drawRing(state.focus); }); }, { passive: true });
  window.addEventListener('message', (e) => { if (e.data?.type === 'hub:ready') { state.portalDepth = (state.portalDepth || 0) + 1; setTimeout(refreshFocus, 50); } });
  // Desktop convenience: mouse click on a tile focuses+selects it.
  views.home.addEventListener('click', (e) => { const t = e.target.closest('[data-focusable]'); if (!t) return; const r = t.getBoundingClientRect(); setFocus({ el: t, x: r.left, y: r.top, w: r.width, h: r.height }); homeSelect(); });
}
boot();
window.__app = { state, catalog, portal, player, dispatch };
