import { installKeyRouter, registerPlatformKeys, PLATFORM } from './keymap.js';
import { pickNext, refind } from './spatial.js';
import { VirtualCursor } from './cursor.js';
import { Player } from './player.js';
import { CatalogCache, ArtworkLru } from './catalog.js';
import { PortalFrame } from './portal.js';
import { progress } from './progress.js';
import { search, KEY_ROWS } from './search.js';

const $ = (s) => document.querySelector(s);
const views = { home: $('#view-home'), search: $('#view-search'), portal: $('#view-portal') };
const ring = $('#focus-ring'), cursorEl = $('#cursor'), toast = $('#toast'), osd = $('#osd'), hud = $('#hud');

const state = {
  view: 'home',            // 'home' | 'portal'
  mode: 'spatial',         // 'spatial' | 'cursor'
  focus: null,             // {el,x,y,w,h} in shell coordinates
  sources: [],
  portalDepth: 0, goingBack: false, portalSource: null,
  query: '', searchReturn: 'home',
  playKey: null, playTitle: null, playItemId: null,
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
  for (const e of document.querySelectorAll('.focused')) if (e !== c?.el) e.classList.remove('focused');
  if (!c) { ring.hidden = true; return; }
  // Scroll first, then measure: the ring is fixed-position and must follow the post-scroll rect.
  if (state.view !== 'portal') { c.el.classList.add('focused'); if (scroll) c.el.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  else if (scroll) portal.hub?.scrollIntoAnchor(c.el);
  drawRing(c);
}
function drawRing(c) {
  if (c.el.classList?.contains('key')) { ring.hidden = true; return; }   // keys carry their own focus style
  let { x, y, w, h } = c;
  if (state.view !== 'portal') { const r = c.el.getBoundingClientRect(); x = r.left; y = r.top; w = r.width; h = r.height; }
  else { const fresh = refind(portal.candidates(), c.el); if (fresh) ({ x, y, w, h } = fresh); }
  ring.hidden = false;
  ring.style.transform = `translate(${x}px, ${y}px)`;
  ring.style.width = `${w}px`; ring.style.height = `${h}px`;
}
function currentCandidates() {
  if (state.view !== 'portal') {
    return [...views[state.view].querySelectorAll('[data-focusable]')].map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.left, y: r.top, w: r.width, h: r.height }; });
  }
  return portal.candidates();
}
function refreshFocus() {
  const cands = currentCandidates();
  const same = state.focus && refind(cands, state.focus.el);
  if (same) setFocus(same, { scroll: false });
  else if (cands.length) setFocus(pickNext(null, cands, null), { scroll: false });
  else setFocus(null);
}
function move(dir) {
  const t0 = performance.now();
  document.querySelectorAll('.focused').forEach((e) => e.classList.remove('focused'));
  const cands = currentCandidates();
  const cur = state.focus && refind(cands, state.focus.el) || state.focus;
  const next = pickNext(cur, cands, dir);
  if (next) setFocus(next);
  else if (state.view === 'portal' && (dir === 'down' || dir === 'up')) { portal.hub?.scrollBy(dir === 'down' ? 300 : -300); requestAnimationFrame(refreshFocus); }
  requestAnimationFrame(() => { state.metrics.focus.push(performance.now() - t0); if (state.metrics.focus.length > 200) state.metrics.focus.shift(); });
}

// ---------- home view: rows ----------
function tile({ id, title, sub, portal: portalUrl, key, pct, icon }) {
  const t = document.createElement('div');
  t.className = 'tile' + (icon ? ' source' : ''); t.dataset.focusable = '';
  if (id) t.dataset.id = id; if (portalUrl) t.dataset.portal = portalUrl; if (key) t.dataset.key = key;
  t.innerHTML = `<div class="poster">${icon ? `<span>${icon}</span>` : ''}${pct != null ? '<div class="bar"><i></i></div>' : ''}</div><div class="meta"><div class="title"></div><div class="sub"></div></div>`;
  t.querySelector('.title').textContent = title; t.querySelector('.sub').textContent = sub || '';
  if (pct != null) t.querySelector('.bar i').style.width = `${Math.round(pct * 100)}%`;
  return t;
}
function row(title, tiles) {
  if (!tiles.length) return null;
  const s = document.createElement('section'); s.className = 'row';
  s.innerHTML = `<h2></h2><div class="row-tiles"></div>`;
  s.querySelector('h2').textContent = title;
  const wrap = s.querySelector('.row-tiles'); for (const t of tiles) wrap.appendChild(t);
  return s;
}
function renderHome() {
  const rows = $('#rows'); rows.innerHTML = '';
  const items = catalog.list();
  $('#home-count').textContent = `${items.length} titles · ${state.sources.length} sources`;
  const sub = (it) => [it.year, it.kind === 'episode' && it.season != null ? `S${it.season}E${it.episode ?? '?'}` : null, it.sources.map((s) => s.sourceId).join(', ')].filter(Boolean).join(' · ');
  const byKind = (k) => items.filter((i) => i.kind === k).map((it) => tile({ id: it.id, title: it.title, sub: sub(it) }));
  const cont = progress.list().map((p) => tile({ key: p.key, id: p.itemId, portal: p.portalUrl, title: p.title, sub: `${fmtMin(p.d - p.t)} left`, pct: p.t / p.d }));
  const srcs = state.sources.map((s) => tile({ portal: s.home, title: s.name, sub: 'open portal', icon: '⌂' }));
  const searchTile = tile({ title: 'Search', sub: `${items.length} titles`, icon: '⌕' }); searchTile.dataset.search = '';
  for (const r of [row('Continue watching', cont), row('Sources', [searchTile, ...srcs]), row('Movies', byKind('movie')), row('Series', byKind('series')), row('Episodes', byKind('episode'))]) if (r) rows.appendChild(r);
  lazyArtwork($('#rows'));
}

// ---------- search view ----------
function renderKeyboard() {
  const kb = $('#keyboard'); if (kb.children.length) return;
  for (const keys of KEY_ROWS) {
    const r = document.createElement('div'); r.className = 'krow';
    for (const k of keys) {
      const b = document.createElement('div');
      b.className = 'key' + (k.length > 1 ? ' wide ' + k : ''); b.dataset.focusable = ''; b.dataset.key = k;
      b.textContent = { space: 'space', back: '⌫  delete', clear: '✕  clear' }[k] || k;
      r.appendChild(b);
    }
    kb.appendChild(r);
  }
}
function openSearch() {
  state.searchReturn = state.view === 'portal' ? 'home' : state.view;
  renderKeyboard();
  showView('search');
  renderSearch();
  const first = $('#keyboard .key'); const r = first.getBoundingClientRect();
  setFocus({ el: first, x: r.left, y: r.top, w: r.width, h: r.height });
}
function setQuery(q) { state.query = q; renderSearch(); }
function renderSearch() {
  const qEl = $('#search-query');
  qEl.textContent = ''; qEl.append(state.query, Object.assign(document.createElement('span'), { className: 'caret' }));
  const rows = $('#search-rows'); rows.innerHTML = '';
  if (!state.query) { rows.innerHTML = `<div class="search-hint">Search ${catalog.items.size} titles across ${state.sources.length} source${state.sources.length === 1 ? '' : 's'}. Results appear as you type; typos are fine.</div>`; return; }
  const results = search(catalog.list(), state.query);
  const sub = (it) => [it.year, it.kind, it.sources.map((s) => s.sourceId).join(', ')].filter(Boolean).join(' · ');
  const r = row(`${results.length} result${results.length === 1 ? '' : 's'} for “${state.query}”`, results.map((it) => tile({ id: it.id, title: it.title, sub: sub(it) })));
  if (r) rows.appendChild(r); else rows.innerHTML = `<div class="empty">Nothing matches “${state.query}”</div>`;
  lazyArtwork(rows);
  if (state.focus && !document.contains(state.focus.el)) refreshFocus();
}
function typeChar(ch) { setQuery((state.query + ch).slice(0, 40)); }
function searchKey(k) {
  if (k === 'space') typeChar(' ');
  else if (k === 'back') setQuery(state.query.slice(0, -1));
  else if (k === 'clear') setQuery('');
  else typeChar(k);
}
function searchSelect() {
  const el = state.focus?.el; if (!el) return;
  if (el.dataset.key) return searchKey(el.dataset.key);
  if (el.dataset.id) { state.searchReturn = 'search'; return openItem(el.dataset.id); }
}
const fmtMin = (s) => `${Math.max(1, Math.round(s / 60))} min`;
let artObserver;
function lazyArtwork(container) {
  artObserver?.disconnect();
  artObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const t = e.target; artObserver.unobserve(t);
      const it = catalog.items.get(t.dataset.id); if (!it) continue;
      const url = catalog.artworkUrl(it); if (!url) continue;
      art.get(url).then((obj) => { t.querySelector('.poster').style.backgroundImage = `url(${obj})`; }).catch(() => {});
    }
  }, { root: container.closest('section'), rootMargin: '400px 600px' });
  for (const t of container.querySelectorAll('.tile[data-id]')) artObserver.observe(t);
}
function portalPathFor(sourceId, absUrl) {
  const def = state.sources.find((s) => s.id === sourceId);
  const u = new URL(absUrl);
  const base = def?.origin ? new URL(def.origin).pathname.replace(/\/$/, '') : '';
  const path = base && u.pathname.startsWith(base) ? u.pathname.slice(base.length) : u.pathname;
  return `/p/${sourceId}${path}${u.search}`;
}
function homeSelect() {
  const el = state.focus?.el; if (!el) return;
  if ('search' in el.dataset) return openSearch();
  if (el.dataset.key) { const p = progress.get(el.dataset.key); if (p) return openPortal(p.portalUrl, { key: el.dataset.key, title: p.title, itemId: p.itemId }); }
  if (el.dataset.portal) return openPortal(el.dataset.portal);
  openItem(el.dataset.id);
}
function openItem(id) {
  const it = catalog.items.get(id);
  const src = it?.sources.find((s) => s.itemUrl);
  if (!src) return say('No source URL for this title');
  openPortal(portalPathFor(src.sourceId, src.itemUrl), { key: it.id, title: it.title, itemId: it.id });
}

// ---------- portal view ----------
function openPortal(url, { key = null, title = null, itemId = null } = {}) {
  state.playKey = key; state.playTitle = title; state.playItemId = itemId;
  state.portalDepth = 0; state.goingBack = false;
  state.portalSource = (url.match(/^\/p\/([^/]+)/) || [])[1] || null;
  showView('portal');
  portal.load(url);
  say('Loading portal…');
}
portal.onReady = () => {
  if (state.view !== 'portal' || portal.frame.src === 'about:blank') return;
  say('');
  if (!portal.hub) { say('Portal is not same-origin; injection failed'); return; }
  setTimeout(refreshFocus, 50);
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
function playbackKey() {
  if (state.playKey) return state.playKey;
  const w = portal.win; try { return `${state.portalSource}:${w.location.pathname}${w.location.search}`; } catch { return null; }
}
function startPlayback(video) {
  video = video || portal.hub?.findVideo();
  if (!video) return say('No player on this page');
  const key = playbackKey();
  const saved = key && progress.get(key);
  player.onEnd = () => stopPlayback();
  player.onProgress = (t, d) => {
    let title = state.playTitle; try { title = title || portal.frame.contentDocument.title; } catch {}
    let portalUrl; try { const l = portal.win.location; portalUrl = l.pathname + l.search; } catch {}
    progress.save(key, { t, d, title, portalUrl, itemId: state.playItemId });
  };
  player.attach(video, { resumeAt: saved ? saved.t : 0 });
  ring.hidden = true;
  say(saved ? `Resuming at ${fmtTime(saved.t)}` : '');
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function stopPlayback() { player.detach(); refreshFocus(); }

/** Rule inspector: hide the element under the cursor (or the focused one) and persist its selector. */
async function inspectHide() {
  const hub = portal.hub; if (!hub || !state.portalSource) return;
  let el;
  if (state.mode === 'cursor') { const p = portal.toFrame(cursor.x, cursor.y); el = hub.elementAt(p.x, p.y); }
  else el = state.focus?.el;
  if (!el) return say('Nothing under the cursor');
  const selector = hub.hideUser(el);
  hub.invalidate(); refreshFocus();
  try {
    const r = await fetch(`/api/sources/${encodeURIComponent(state.portalSource)}/rules`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ css: [selector] }) });
    say(r.ok ? `Hidden and saved: ${selector}` : `Hidden (save failed: HTTP ${r.status})`);
  } catch (e) { say(`Hidden (save failed: ${e.message})`); }
}

function showView(name) {
  state.view = name;
  for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
  if (name !== 'portal') { clearInterval(state.portalTick); portal.frame.src = 'about:blank'; cursor.hide(); state.mode = 'spatial'; }
  if (name === 'home') renderHome();
  if (name === 'search') renderSearch();
  refreshFocus();
}
function leavePortal() { showView(state.searchReturn === 'search' ? 'search' : 'home'); state.searchReturn = 'home'; }
function setMode(mode) {
  state.mode = mode;
  if (mode === 'cursor') { cursor.show(); ring.hidden = true; say('Cursor mode'); }
  else { cursor.hide(); refreshFocus(); say('Navigation mode'); }
}
function say(msg) { toast.textContent = msg; toast.hidden = !msg; clearTimeout(say.t); if (msg) say.t = setTimeout(() => { toast.hidden = true; }, 2500); }

// ---------- intent dispatch ----------
function dispatch(intent, { repeat, phase }) {
  if (phase === 'up') {
    if (state.mode === 'cursor' && ['up', 'down', 'left', 'right'].includes(intent)) cursor.release(intent);
    if (player.active && (intent === 'left' || intent === 'right')) player.commitSeek();
    return;
  }
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
    case 'select': return state.view === 'home' ? homeSelect() : state.view === 'search' ? searchSelect() : portalSelect();
    case 'search': if (state.view !== 'search') openSearch(); return;
    case 'back':
      if (repeat) return;
      if (state.view === 'search') { if (state.query) setQuery(state.query.slice(0, -1)); else showView('home'); return; }
      if (state.view !== 'portal') return;
      if (state.portalDepth > 1) { state.goingBack = true; try { portal.win.history.back(); } catch { leavePortal(); } }
      else leavePortal();
      return;
    case 'mode': case 'cursor': if (state.view === 'portal') setMode(state.mode === 'cursor' ? 'spatial' : 'cursor'); return;
    case 'play': case 'playpause': if (state.view === 'portal') startPlayback(); return;
    case 'menu': if (state.view === 'portal') inspectHide(); return;
    case 'info': return toggleHud();
    default: return;
  }
}
function toggleHud() {
  hud.hidden = !hud.hidden;
  if (hud.hidden) return;
  const p = (arr) => arr.length ? [50, 95].map((q) => `p${q}=${arr.slice().sort((a, b) => a - b)[Math.floor((q / 100) * (arr.length - 1))].toFixed(1)}ms`).join(' ') : 'n/a';
  const dec = portal.hub?.decisions || [];
  hud.textContent = `platform=${PLATFORM} view=${state.view} mode=${state.mode} depth=${state.portalDepth}\nfocus latency ${p(state.metrics.focus)}\nportal decisions: ${dec.length} (${dec.filter((d) => d.kind === 'hide').length} hidden, ${dec.filter((d) => d.kind !== 'hide').length} popups)\n` + dec.slice(-8).map((d) => `  ${d.kind} ${d.reason || ''} ${d.tag || ''} ${d.cls || d.url || ''}`).join('\n');
}

// ---------- boot ----------
async function boot() {
  registerPlatformKeys();
  // Physical keyboard (desktop / USB keyboard on a TV): printable keys type into the search box.
  // Registered before the intent router so letters mapped to intents (M, H, C, I) still type here.
  window.addEventListener('keydown', (e) => {
    if (state.view !== 'search' || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    e.preventDefault(); e.stopImmediatePropagation(); typeChar(e.key.toLowerCase());
  }, { capture: true });
  installKeyRouter(dispatch);
  portal.attachReadyListener();
  state.sources = await fetch('/api/sources').then((r) => r.json());
  await catalog.init();
  showView('home');
  try { const n = await catalog.sync(); if (n) { renderHome(); refreshFocus(); } } catch (e) { say(`Catalog sync failed: ${e.message}`); }
  setInterval(async () => { try { if (await catalog.sync() && state.view === 'home') { renderHome(); refreshFocus(); } } catch {} }, 60_000);
  addEventListener('resize', () => { portal.layout(); refreshFocus(); });
  let ringRaf = 0;
  const followScroll = () => { if (ringRaf) return; ringRaf = requestAnimationFrame(() => { ringRaf = 0; if (state.focus && state.view !== 'portal') drawRing(state.focus); }); };
  views.home.addEventListener('scroll', followScroll, { passive: true, capture: true });
  views.search.addEventListener('scroll', followScroll, { passive: true, capture: true });
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'hub:ready') return;
    if (state.goingBack) { state.goingBack = false; state.portalDepth = Math.max(1, state.portalDepth - 1); } else state.portalDepth++;
    setTimeout(refreshFocus, 50);
  });
  // Desktop convenience: mouse click on a tile focuses and selects it.
  for (const v of [views.home, views.search]) v.addEventListener('click', (e) => { const t = e.target.closest('[data-focusable]'); if (!t) return; const r = t.getBoundingClientRect(); setFocus({ el: t, x: r.left, y: r.top, w: r.width, h: r.height }); state.view === 'home' ? homeSelect() : searchSelect(); });
}
boot();
window.__app = { state, catalog, portal, player, dispatch, progress };
