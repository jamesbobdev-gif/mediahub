// Resume positions, per viewer, in localStorage. Keyed by catalog item id when
// playback started from the home grid, else by the portal page path.

const KEY = 'hub:progress';
const MAX = 50;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
function store(map) { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {} }

export const progress = {
  get(key) { return load()[key] || null; },
  save(key, { t, d, title, portalUrl, itemId }) {
    if (!key || !isFinite(t) || !isFinite(d) || d < 60) return;          // ignore clips and unknown durations
    const map = load();
    if (t > d - 15) { delete map[key]; store(map); return; }              // finished: drop from the row
    map[key] = { t: Math.floor(t), d: Math.floor(d), title, portalUrl, itemId, at: Date.now() };
    const keys = Object.keys(map).sort((a, b) => map[b].at - map[a].at);
    for (const k of keys.slice(MAX)) delete map[k];
    store(map);
  },
  remove(key) { const map = load(); delete map[key]; store(map); },
  list() { const map = load(); return Object.entries(map).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.at - a.at); },
};

// What was opened lately, across every source: titles from the home screen and source pages
// opened from their cards. Newest first, a short list, in localStorage like the positions.
const HIST = 'hub:history', HIST_MAX = 30;
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch { return []; } }
export const history = {
  add({ key, title, portalUrl, itemId = null, sourceId = null, kind = 'title' }) {
    if (!key || !portalUrl) return;
    const list = loadHist().filter((h) => h.key !== key);
    list.unshift({ key, title, portalUrl, itemId, sourceId, kind, at: Date.now() });
    try { localStorage.setItem(HIST, JSON.stringify(list.slice(0, HIST_MAX))); } catch {}
  },
  list() { return loadHist(); },
  remove(key) { try { localStorage.setItem(HIST, JSON.stringify(loadHist().filter((h) => h.key !== key))); } catch {} },
};
