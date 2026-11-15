import { installKeyRouter, registerPlatformKeys, PLATFORM } from './keymap.js';
import { pickNext, refind } from './spatial.js';
import { VirtualCursor } from './cursor.js';
import { Player } from './player.js';
import { CatalogCache, ArtworkLru, featuredRows, mixBySource } from './catalog.js';
import { PortalFrame } from './portal.js';
import { progress, history } from './progress.js';
import { search, KEY_ROWS } from './search.js';
import { SettingsView } from './settings.js';
import { startRemote } from './remote.js';

const $ = (s) => document.querySelector(s);
const views = { home: $('#view-home'), search: $('#view-search'), settings: $('#view-settings'), portal: $('#view-portal') };
const ring = $('#focus-ring'), cursorEl = $('#cursor'), toast = $('#toast'), osd = $('#osd'), hud = $('#hud');

const state = {
  view: 'home',            // 'home' | 'search' | 'settings' | 'portal'
  mode: 'spatial',         // 'spatial' | 'cursor'
  focus: null,             // home/search: {el,x,y,w,h}; portal: {id,x,y,w,h}
  sources: [], env: null,
  portalDepth: 0, goingBack: false, portalSource: null, goodUrls: [], blockedRedirects: 0,
  playKey: null, playTitle: null, playItemId: null, autoplay: false, autoplayPath: null, viaHome: null,
  query: '', searchReturn: 'home',
  decisions: null, cache: null,
  metrics: { focus: [] },
};

const catalog = new CatalogCache();
const art = new ArtworkLru();
let portal, player, settings, remote;
const cursor = new VirtualCursor({ el: cursorEl, bounds: () => ({ w: innerWidth, h: innerHeight }) });
// The page sees the cursor as a mouse (hover menus, player controls), a few times a second.
let pointerSentAt = 0;
cursor.onMove = (x, y) => {
  const now = performance.now();
  if (state.view !== 'portal' || !portal?.ready || now - pointerSentAt < 50) return;
  pointerSentAt = now;
  const p = portal.toFrame(x, y);
  portal.send({ type: 'hub:pointer', x: p.x, y: p.y });
};

// ---------- focus ring ----------
function setFocus(c, { scroll = true } = {}) {
  state.focus = c;
  for (const e of document.querySelectorAll('.focused')) if (e !== c?.el) e.classList.remove('focused');
  if (!c) { ring.hidden = true; return; }
  if (state.view !== 'portal') { c.el.classList.add('focused'); if (scroll) c.el.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  else if (scroll) portal.send({ type: 'hub:anchor', id: c.id });
  drawRing(c);
  if (state.view === 'settings') settings.onFocus(c.el);
}
const focusEl = (el) => { const r = el.getBoundingClientRect(); setFocus({ el, x: r.left, y: r.top, w: r.width, h: r.height }); };
function drawRing(c) {
  if (c.el?.classList?.contains('key')) { ring.hidden = true; return; }
  let { x, y, w, h } = c;
  if (state.view !== 'portal') { const r = c.el.getBoundingClientRect(); x = r.left; y = r.top; w = r.width; h = r.height; }
  else { const fresh = refind(portal.candidates(), c); if (fresh) ({ x, y, w, h } = fresh); }
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
  const same = refind(cands, state.focus);
  if (same) setFocus(same, { scroll: false });
  else if (cands.length) setFocus(pickNext(null, cands, null), { scroll: false });
  else setFocus(null);
}
function move(dir) {
  const t0 = performance.now();
  const cands = currentCandidates();
  const cur = refind(cands, state.focus) || state.focus;
  const next = pickNext(cur, cands, dir);
  if (next) setFocus(next);
  else if (state.view === 'portal' && (dir === 'down' || dir === 'up')) portal.send({ type: 'hub:scrollBy', dy: dir === 'down' ? 300 : -300 });
  requestAnimationFrame(() => { state.metrics.focus.push(performance.now() - t0); if (state.metrics.focus.length > 200) state.metrics.focus.shift(); });
}

// ---------- home view: rows ----------
const hueOf = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
function tile({ id, title, sub, portal: portalUrl, key, pct, icon, online }) {
  const t = document.createElement('div');
  t.className = 'tile' + (icon ? ' wide' : ''); t.dataset.focusable = '';
  if (id) t.dataset.id = id; if (portalUrl) t.dataset.portal = portalUrl; if (key) t.dataset.key = key;
  t.style.setProperty('--hue', hueOf(title));
  const initial = !icon ? `<span class="initial">${(title || '?').trim()[0].toUpperCase()}</span>` : '';
  t.innerHTML = `<div class="poster">${icon ? `<span>${icon}</span>` : initial}${online ? '<span class="dot"></span>' : ''}${pct != null ? '<div class="bar"><i></i></div>' : ''}</div><div class="meta"><div class="title"></div><div class="sub"></div></div>`;
  t.querySelector('.title').textContent = title; t.querySelector('.sub').textContent = sub || '';
  if (pct != null) t.querySelector('.bar i').style.width = `${Math.round(pct * 100)}%`;
  return t;
}
function row(title, tiles) {
  if (!tiles.length) return null;
  const s = document.createElement('section'); s.className = 'row';
  s.innerHTML = `<h2></h2><div class="row-tiles"></div>`;
  s.querySelector('h2').textContent = title;
  s.querySelector('h2').insertAdjacentHTML('beforeend', `<small>${tiles.length}</small>`);
  const wrap = s.querySelector('.row-tiles'); for (const t of tiles) wrap.appendChild(t);
  return s;
}
/** Catalog items from a source that still exists; a removed source's titles linger in the mirror. */
function visibleItems() {
  const known = new Set(state.sources.map((s) => s.id));
  return catalog.list().filter((it) => it.sources.some((s) => known.has(s.sourceId)));
}
function renderHome() {
  const rows = $('#rows'); rows.innerHTML = '';
  const items = visibleItems();
  $('#home-count').textContent = `${items.length} titles · ${state.sources.length} sources`;
  const sub = (it) => [it.year, it.kind === 'episode' && it.season != null ? `S${it.season}E${it.episode ?? '?'}` : null, it.sources.map((s) => s.sourceId).join(', ')].filter(Boolean).join(' · ');
  // What each source shows on its own front page comes first, one row per source, in the page's order.
  const front = featuredRows(items, state.sources);
  const onFront = new Set(front.flatMap((f) => f.items.map((it) => it.id)));
  const frontRows = front.map((f) => row(`${f.source.name} front page`, f.items.map((it) => tile({ id: it.id, title: it.title, sub: sub(it) }))));
  // Movies and Series take titles in turns across sources, so one big feed does not fill the row.
  const byKind = (k) => mixBySource(items.filter((i) => i.kind === k && !onFront.has(i.id))).map((it) => tile({ id: it.id, title: it.title, sub: sub(it) }));
  const cont = progress.list().map((p) => tile({ key: p.key, id: p.itemId, portal: p.portalUrl, title: p.title, sub: `${fmtMin(p.d - p.t)} left`, pct: p.t / p.d }));
  // What was opened lately, across every source, after what is still in progress.
  const inProgress = new Set(progress.list().map((p) => p.key));
  const known = new Set(state.sources.map((s) => s.id));
  const recent = history.list().filter((h) => !inProgress.has(h.key) && (!h.sourceId || known.has(h.sourceId)))
    .map((h) => tile(h.kind === 'source' ? { key: h.key, portal: h.portalUrl, title: h.title, sub: 'opened lately', icon: '⌂' } : { key: h.key, id: h.itemId, portal: h.portalUrl, title: h.title, sub: h.sourceId || '', recent: true }));
  const countFor = (id) => items.filter((i) => i.sources.some((s) => s.sourceId === id)).length;
  const srcs = state.sources.map((s) => { const t = tile({ portal: s.home, title: s.name, sub: `${countFor(s.id)} titles · open portal`, icon: '⌂', online: true }); t.dataset.source = s.id; return t; });
  const searchTile = tile({ title: 'Search', sub: `${items.length} titles across ${state.sources.length} sources`, icon: '⌕' }); searchTile.dataset.search = '';
  const settingsTile = tile({ title: 'Settings', sub: 'Add or remove sources, allow what they need', icon: '⚙' }); settingsTile.dataset.settings = '';
  for (const r of [row('Continue watching', cont), row('Recently watched', recent), row('Sources', [searchTile, ...srcs, settingsTile]), ...frontRows, row('Movies', byKind('movie')), row('Series', byKind('series')), row('Episodes', byKind('episode'))]) if (r) rows.appendChild(r);
  lazyArtwork($('#rows'));
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
      art.get(url).then((obj) => { const p = t.querySelector('.poster'); p.style.backgroundImage = `url(${obj})`; p.querySelector('.initial')?.remove(); }).catch(() => {});
    }
  }, { root: container.closest('section'), rootMargin: '400px 600px' });
  for (const t of container.querySelectorAll('.tile[data-id]')) artObserver.observe(t);
}
function tickClock() {
  const el = $('#clock'); if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
  const results = search(visibleItems(), state.query);
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

// ---------- opening things ----------
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
  if ('settings' in el.dataset) return openSettings();
  if (el.dataset.key) {
    const p = progress.get(el.dataset.key);
    if (p) return openPortal(p.portalUrl, { key: el.dataset.key, title: p.title, itemId: p.itemId, autoplay: true });
    const h = history.list().find((x) => x.key === el.dataset.key);
    if (h) return h.kind === 'source' ? openPortal(h.portalUrl) : openPortal(h.portalUrl, { key: h.key, title: h.title, itemId: h.itemId, autoplay: true });
  }
  if (el.dataset.portal) {
    if (el.dataset.source) history.add({ key: `source:${el.dataset.source}`, title: el.querySelector('.title')?.textContent || el.dataset.source, portalUrl: el.dataset.portal, sourceId: el.dataset.source, kind: 'source' });
    return openPortal(el.dataset.portal);
  }
  openItem(el.dataset.id);
}
function openItem(id) {
  const it = catalog.items.get(id);
  const src = it?.sources.find((s) => s.itemUrl);
  if (!src) return say('No source URL for this title');
  const path = portalPathFor(src.sourceId, src.itemUrl);
  history.add({ key: it.id, title: it.title, portalUrl: path, itemId: it.id, sourceId: src.sourceId });
  openPortal(path, { key: it.id, title: it.title, itemId: it.id, autoplay: true });
}

// ---------- settings view ----------
function openSettings() { if (state.view !== 'settings') showView('settings'); }
async function reloadSources() {
  try { state.sources = await fetch('/api/sources').then((r) => r.json()); } catch (e) { say(`Could not reload sources: ${e.message}`); }
}

// ---------- portal view ----------
// Sites whose title pages throw out a direct visit (Tubi sends one to its 404 screen) but build the
// same page when reached from their own front page. Learned on the first bounce, kept on the TV.
const FRONT_DOOR_KEY = 'hub.frontDoor';
const frontDoor = { list() { try { return JSON.parse(localStorage.getItem(FRONT_DOOR_KEY) || '[]'); } catch { return []; } },
  has(id) { return this.list().includes(id); },
  add(id) { if (!id || this.has(id)) return; try { localStorage.setItem(FRONT_DOOR_KEY, JSON.stringify([...this.list(), id])); } catch {} } };

function openPortal(path, { key = null, title = null, itemId = null, autoplay = false } = {}) {
  if (state.view === 'settings') state.searchReturn = 'settings';
  state.playKey = key; state.playTitle = title; state.playItemId = itemId; state.autoplay = autoplay;
  state.autoplayPath = autoplay ? path : null; state.viaHome = null;
  state.portalDepth = 0; state.goingBack = false; state.goodUrls = [path]; state.blockedRedirects = 0;
  state.portalSource = (path.match(/^\/p\/([^/]+)/) || [])[1] || null;
  const src = (state.sources || []).find((s) => s.id === state.portalSource);
  // A dark source's frame is dark between pages too, so a navigation never flashes white.
  portal.frame.style.background = src?.rules?.dark ? '#0b0d12' : '#fff';
  let start = path;
  if (autoplay && src?.home && frontDoor.has(src.id)) { start = src.home; state.viaHome = 'loading'; state.goodUrls = [start]; }
  showView('portal');
  portal.load(start);
  say(state.viaHome ? `Opening ${title || 'it'} through ${src.name}...` : 'Loading portal…');
}
function wirePortal() {
  portal.onTrace = (m) => trace('frame:' + (m.step || '?'), m.data || {});
  portal.onReady = (m) => {
    if (state.view !== 'portal') return;
    trace('ready', { href: m.href, viaHome: state.viaHome, autoplay: state.autoplay, depth: state.portalDepth });
    say('');
    state.blockedRedirects = 0;
    if (state.goodUrls[state.goodUrls.length - 1] !== m.href) state.goodUrls.push(m.href);
    if (state.goodUrls.length > 20) state.goodUrls.shift();
    if (state.goingBack) { state.goingBack = false; state.portalDepth = Math.max(1, state.portalDepth - 1); } else state.portalDepth++;
    setTimeout(refreshFocus, 50);
    // Through the front door: the site's own page is up. Move to the title inside its app once the
    // page has gone quiet (an app still booting takes the nudge the wrong way), eight seconds at most.
    if (state.viaHome === 'loading') { state.viaHome = 'armed'; armGo(); return; }
    // A title chosen on the home screen plays at once: the page presses its own play control and
    // hands the video over. Only the first page of the visit; a later page is the user's own doing.
    if (state.autoplay && state.portalDepth === 1) {
      state.autoplay = false;
      say(`Starting ${state.playTitle || 'playback'}...`);
      setTimeout(startChosenTitle, 600);
    }
  };
  portal.onCandidates = () => { if (state.viaHome === 'armed') scheduleGo(); if (state.view === 'portal' && !player.active) refreshFocus(); };
  portal.onBlocked = () => {
    if (state.view !== 'portal') return;
    trace('blocked', { href: portal.href, src: portal.frame.src, missed: portal.missed, viaHome: state.viaHome, count: state.blockedRedirects });
    // Some sites throw out a title page opened directly (Tubi sends it to its 404 screen) but build
    // the same page fine when reached from their own front page. Go in that way once.
    if (state.autoplayPath && !state.viaHome) {
      const src = state.sources.find((s) => s.id === state.portalSource);
      if (src?.home) {
        frontDoor.add(src.id);
        state.viaHome = 'loading'; state.goodUrls = [src.home]; state.goingBack = false;
        player.state = { ...player.state, active: false }; osd.hidden = true;   // whatever the thrown-out page reported
        say(`Opening ${state.playTitle || 'it'} through ${src.name}...`);
        portal.recreate(); portal.load(src.home);
        return;
      }
    }
    state.blockedRedirects++;
    state.autoplay = false; state.autoplayPath = null;   // the page that bounced is not the chosen title any more
    say('Blocked a redirect to another site');
    // The page that escaped is not a good page to return to: drop it and go to the one before.
    if (state.goodUrls[state.goodUrls.length - 1] === portal.href) state.goodUrls.pop();
    const url = state.goodUrls[state.goodUrls.length - 1];
    if (url && state.blockedRedirects < 4) { state.goingBack = true; portal.recreate(); portal.load(url); }
    else leavePortal();
  };
  portal.onHidden = async (selector) => {
    refreshFocus();
    try {
      const r = await fetch(`/api/sources/${encodeURIComponent(state.portalSource)}/rules`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ css: [selector] }) });
      say(r.ok ? `Hidden and saved: ${selector}` : `Hidden (save failed: HTTP ${r.status})`);
    } catch (e) { say(`Hidden (save failed: ${e.message})`); }
  };
  portal.onNoPlayer = () => { trace('noplayer', { href: portal.href }); say('No player found on this page. Pick it with the remote.'); refreshFocus(); };
  portal.onDecisions = (d) => { state.decisions = d; if (!hud.hidden) renderHud(); };
  player.onEnd = () => stopPlayback();
  player.onChange = (s) => trace(s.active ? 'player-on' : 'player-off', { t: Math.round(s.t || 0), d: Math.round(s.d || 0) });
  player.onProgress = (t, d) => {
    const key = playbackKey(); if (!key) return;
    progress.save(key, { t, d, title: state.playTitle || portal.title, portalUrl: portal.href, itemId: state.playItemId });
  };
}
function portalSelect() {
  if (state.mode === 'cursor') { const p = portal.toFrame(cursor.x, cursor.y); portal.send({ type: 'hub:elementAt', x: p.x, y: p.y, then: 'activate', resumeAt: resumeFor() }); return; }
  const c = state.focus; if (!c || c.id == null) return;
  if (c.tag === 'VIDEO') return startPlayback(c.id);
  portal.send({ type: 'hub:activate', id: c.id });
}
/** Ask the page to start the chosen title: press its play control and hand the video over. */
function startChosenTitle() { if (state.view !== 'portal' || player.active) return; trace('autoplay-sent', { href: portal.href }); portal.send({ type: 'hub:autoplay', resumeAt: resumeFor() }); }
let goTimer = null, goDeadline = 0;
function armGo() { goDeadline = performance.now() + 8000; scheduleGo(); }
function scheduleGo() {
  clearTimeout(goTimer);
  goTimer = setTimeout(sendGo, Math.min(1500, Math.max(50, goDeadline - performance.now())));
}
function sendGo() {
  if (state.viaHome !== 'armed' || state.view !== 'portal') return;
  state.viaHome = 'went';
  trace('go-sent', { path: state.autoplayPath, title: state.playTitle });
  portal.send({ type: 'hub:go', path: state.autoplayPath, then: 'autoplay', title: state.playTitle, resumeAt: resumeFor() });
}
function playbackKey() {
  if (state.playKey) return state.playKey;
  return portal.href ? `${state.portalSource}:${portal.href}` : null;
}
function resumeFor() { const key = playbackKey(); const saved = key && progress.get(key); return saved ? saved.t : 0; }
function startPlayback(id = null) {
  const resumeAt = resumeFor();
  player.attach({ id, resumeAt });
  ring.hidden = true;
  if (resumeAt) say(`Resuming at ${fmtTime(resumeAt)}`);
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function stopPlayback() { player.detach(); setTimeout(refreshFocus, 100); }

/** Rule inspector: hide the element under the cursor (or the focused one); the frame answers with a selector. */
function inspectHide() {
  if (!state.portalSource) return;
  if (state.mode === 'cursor') { const p = portal.toFrame(cursor.x, cursor.y); portal.send({ type: 'hub:elementAt', x: p.x, y: p.y, then: 'hide' }); return; }
  const c = state.focus; if (!c || c.id == null) return say('Nothing focused');
  portal.send({ type: 'hub:hide', id: c.id });
}

function showView(name) {
  state.view = name;
  for (const [k, v] of Object.entries(views)) v.hidden = k !== name;
  if (name !== 'portal') { portal.stopHeartbeat(); portal.frame.src = 'about:blank'; portal.ready = false; portal.cands = []; cursor.hide(); state.mode = 'spatial'; player.state = { ...player.state, active: false }; osd.hidden = true; }
  if (name === 'home') renderHome();
  if (name === 'search') renderSearch();
  if (name === 'settings') settings.open(); else settings?.close();
  refreshFocus();
}
function leavePortal() { showView(['search', 'settings'].includes(state.searchReturn) ? state.searchReturn : 'home'); state.searchReturn = 'home'; }
function setMode(mode) {
  state.mode = mode;
  if (mode === 'cursor') { cursor.show(); ring.hidden = true; say('Cursor mode'); }
  else { cursor.hide(); refreshFocus(); say('Navigation mode'); }
}
/** A step of a visit, kept by the hub (/api/trace) so a page that will not play can be looked into from a PC. */
function trace(event, data = {}) {
  try { fetch('/api/trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, view: state.view, source: state.portalSource, ...data }) }).catch(() => {}); } catch {}
}
function say(msg) { toast.textContent = msg; toast.hidden = !msg; clearTimeout(say.t); if (msg) say.t = setTimeout(() => { toast.hidden = true; }, 2500); }

// ---------- driven from the hub (shell/js/remote.js, docs/CONTROL.md) ----------
/** What this TV is showing, for a controller to read. */
function remoteSnapshot() {
  const s = player?.state || {};
  const focusText = state.view !== 'portal' ? (state.focus?.el?.querySelector?.('.title')?.textContent || state.focus?.el?.textContent || '').trim().slice(0, 80) : null;
  return {
    view: state.view, source: state.portalSource, href: state.view === 'portal' ? portal?.href || null : null,
    title: state.view === 'portal' ? state.playTitle || portal?.title || null : null,
    query: state.view === 'search' ? state.query : undefined, focus: focusText || null, mode: state.mode,
    playing: { active: !!s.active, paused: !!s.paused, t: Math.round(s.t || 0), d: Math.round(s.d || 0) },
    sources: state.sources.length, titles: catalog.items.size,
  };
}
const waitFor = (test, ms) => new Promise((resolve) => { const t0 = performance.now(); (function tick() { if (test()) return resolve(true); if (performance.now() - t0 > ms) return resolve(false); setTimeout(tick, 250); })(); });
/** One command from the hub, carried out the way a key press would be. The answer is the controller's result. */
async function runRemote(cmd) {
  const sourceOf = (id) => state.sources.find((s) => s.id === id);
  switch (cmd.type) {
    case 'status': return { ok: true, state: remoteSnapshot() };
    case 'say': say(String(cmd.text || '').slice(0, 120)); return { ok: true };
    case 'home': showView('home'); return { ok: true };
    case 'back': dispatch('back', { repeat: false, phase: 'down' }); return { ok: true, view: state.view };
    case 'key': dispatch(cmd.intent, { repeat: false, phase: 'down' }); dispatch(cmd.intent, { repeat: false, phase: 'up' }); return { ok: true, view: state.view, focus: remoteSnapshot().focus };
    case 'search': {
      if (state.view !== 'search') openSearch();
      setQuery(String(cmd.query || '').toLowerCase().slice(0, 40));
      return { ok: true, results: search(visibleItems(), state.query, { limit: 10 }).map((it) => ({ id: it.id, title: it.title, year: it.year, kind: it.kind })) };
    }
    case 'open_source': {
      const src = sourceOf(cmd.source); if (!src) return { ok: false, error: `unknown source "${cmd.source}"` };
      history.add({ key: `source:${src.id}`, title: src.name, portalUrl: src.home, sourceId: src.id, kind: 'source' });
      openPortal(src.home);
      const up = await waitFor(() => portal.ready, 8000);
      return { ok: true, opened: src.name, loaded: up };
    }
    case 'open_url': {
      const src = sourceOf(cmd.source); if (!src) return { ok: false, error: `unknown source "${cmd.source}"` };
      openPortal(`/p/${src.id}${cmd.path}`);
      const up = await waitFor(() => portal.ready, 8000);
      return { ok: true, opened: src.name, loaded: up };
    }
    case 'play': {
      const it = catalog.items.get(cmd.item); if (!it) return { ok: false, error: 'unknown title id: find one with /api/catalog/search' };
      openItem(it.id);
      const started = await waitFor(() => player.active, 8000);
      return { ok: true, title: it.title, started, note: started ? undefined : 'the page is open but the video has not started yet; read the TV state again in a few seconds' };
    }
    case 'pause': if (!player.active) return { ok: false, error: 'nothing is playing' }; if (!player.state.paused) player.togglePlay(); return { ok: true };
    case 'resume': if (!player.active) return { ok: false, error: 'nothing is playing' }; if (player.state.paused) player.togglePlay(); return { ok: true };
    case 'toggle_play':
      if (player.active) { player.togglePlay(); return { ok: true }; }
      if (state.view === 'portal') { startPlayback(); return { ok: true, started: await waitFor(() => player.active, 5000) }; }
      return { ok: false, error: 'no page is open' };
    case 'stop': if (player.active) stopPlayback(); else if (state.view === 'portal') leavePortal(); else return { ok: false, error: 'nothing to stop' }; return { ok: true, view: state.view };
    default: return { ok: false, error: `unknown command "${cmd.type}"` };
  }
}

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
    case 'select': return state.view === 'home' ? homeSelect() : state.view === 'search' ? searchSelect() : state.view === 'settings' ? settings.select(state.focus?.el) : portalSelect();
    case 'search': if (state.view !== 'search') openSearch(); return;
    case 'back':
      if (repeat) return;
      if (state.view === 'search') { if (state.query) setQuery(state.query.slice(0, -1)); else showView('home'); return; }
      if (state.view === 'settings') { if (!settings.back()) showView('home'); return; }
      if (state.view !== 'portal') return;
      if (state.portalDepth > 1) { state.goingBack = true; portal.send({ type: 'hub:back' }); }
      else leavePortal();
      return;
    case 'mode': case 'cursor': if (state.view === 'portal') setMode(state.mode === 'cursor' ? 'spatial' : 'cursor'); return;
    case 'play': case 'playpause': if (state.view === 'portal') startPlayback(); return;
    case 'menu': if (state.view === 'portal') inspectHide(); else if (state.view === 'home') openSettings(); return;
    case 'info': return toggleHud();
    default: return;
  }
}
function toggleHud() {
  hud.hidden = !hud.hidden;
  if (hud.hidden) return;
  if (state.view === 'portal') portal.send({ type: 'hub:decisions' });
  renderHud();
  fetch('/api/status').then((r) => r.json()).then((s) => { state.cache = s.cache; if (!hud.hidden) renderHud(); }).catch(() => {});
}
function renderHud() {
  const p = (arr) => arr.length ? [50, 95].map((q) => `p${q}=${arr.slice().sort((a, b) => a - b)[Math.floor((q / 100) * (arr.length - 1))].toFixed(1)}ms`).join(' ') : 'n/a';
  const d = state.decisions, c = state.cache;
  const cacheLine = !c ? '' : !c.maxBytes ? 'hub cache: off\n'
    : `hub cache: ${c.entries} files, ${(c.bytes / 1048576).toFixed(1)} of ${Math.round(c.maxBytes / 1048576)} MB, ${c.hits} hits / ${c.misses} misses\n`;
  hud.textContent = `platform=${PLATFORM} view=${state.view} mode=${state.mode} depth=${state.portalDepth}\nportal origin: ${portal?.origin || '-'}\nfocus latency ${p(state.metrics.focus)}\n${cacheLine}`
    + (d ? `portal decisions: ${d.total} (${d.hidden} hidden, ${d.total - d.hidden} popups/links blocked)\n` + d.recent.map((x) => `  ${x.kind} ${x.reason || ''} ${x.tag || ''} ${x.cls || x.url || ''}`).join('\n') : '');
}

// ---------- boot ----------
async function boot() {
  registerPlatformKeys();
  tickClock(); setInterval(tickClock, 15_000);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (state.view === 'search') { e.preventDefault(); e.stopImmediatePropagation(); typeChar(e.key.toLowerCase()); }
    else if (state.view === 'settings' && settings.typing()) { e.preventDefault(); e.stopImmediatePropagation(); settings.typeChar(e.key); }
  }, { capture: true });
  installKeyRouter(dispatch);
  state.env = await fetch('/api/env').then((r) => r.json());
  portal = new PortalFrame({ frame: $('#portal-frame'), wrap: $('#portal-wrap'), origin: state.env.portalOrigin });
  player = new Player({ osd, portal });
  settings = new SettingsView({ root: views.settings, say, focusEl, refocus: refreshFocus, openPortal, onSourcesChanged: reloadSources, focusKey: () => state.focus?.el?.dataset?.fkey });
  wirePortal();
  state.sources = await fetch('/api/sources').then((r) => r.json());
  await catalog.init();
  showView('home');
  remote = startRemote({ snapshot: remoteSnapshot, run: runRemote });
  try { const n = await catalog.sync(); if (n) { renderHome(); refreshFocus(); } } catch (e) { say(`Catalog sync failed: ${e.message}`); }
  setInterval(async () => { try { if (await catalog.sync() && state.view === 'home') { renderHome(); refreshFocus(); } } catch {} }, 60_000);
  addEventListener('resize', () => { portal.layout(); refreshFocus(); });
  let ringRaf = 0;
  const followScroll = () => { if (ringRaf) return; ringRaf = requestAnimationFrame(() => { ringRaf = 0; if (state.focus && state.view !== 'portal') drawRing(state.focus); }); };
  views.home.addEventListener('scroll', followScroll, { passive: true, capture: true });
  views.search.addEventListener('scroll', followScroll, { passive: true, capture: true });
  views.settings.addEventListener('scroll', followScroll, { passive: true, capture: true });
  for (const v of [views.home, views.search, views.settings]) v.addEventListener('click', (e) => { const t = e.target.closest('[data-focusable]'); if (!t) return; focusEl(t); state.view === 'home' ? homeSelect() : state.view === 'search' ? searchSelect() : settings.select(t); });
  window.__app = { state, catalog, portal, player, dispatch, progress, remote };
}
boot();
