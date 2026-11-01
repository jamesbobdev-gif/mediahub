// TV-side catalog: IndexedDB mirror pulled as deltas (If-None-Match on the
// cursor, so an unchanged catalog costs one request and zero writes), plus an
// in-memory LRU for decoded artwork keyed by last-focus time.

const DB = 'mediahub', STORE = 'items', META = 'meta';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const s = db.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('title', 'title');
      s.createIndex('kind', 'kind');
      db.createObjectStore(META, { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(store, mode); const r = fn(t.objectStore(store));
  t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : r); t.onerror = () => reject(t.error);
});

export class CatalogCache {
  constructor({ api = '/api' } = {}) { this.api = api; this.db = null; this.items = new Map(); this.cursor = 0; }

  async init() {
    try { this.db = await open(); } catch (e) { console.warn('IndexedDB unavailable, memory only', e); }
    if (this.db) {
      const all = await new Promise((res, rej) => { const r = this.db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const it of all) this.items.set(it.id, it);
      const m = await new Promise((res) => { const r = this.db.transaction(META).objectStore(META).get('cursor'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      this.cursor = m?.v || 0;
    }
  }

  /** Pull deltas until caught up. Returns number of changed items. */
  async sync() {
    let changed = 0;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${this.api}/catalog?since=${this.cursor}&limit=500`, { headers: { 'if-none-match': `"${this.cursor}"` } });
      if (res.status === 304) break;
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const delta = await res.json();
      if (!delta.items.length) break;
      if (this.db) {
        await tx(this.db, STORE, 'readwrite', (s) => { for (const it of delta.items) s.put(it); });
        await tx(this.db, META, 'readwrite', (s) => s.put({ k: 'cursor', v: delta.cursor }));
      }
      for (const it of delta.items) this.items.set(it.id, it);
      changed += delta.items.length; this.cursor = delta.cursor;
      if (delta.cursor >= delta.head) break;
    }
    return changed;
  }

  list({ kind, query } = {}) {
    let out = [...this.items.values()];
    if (kind) out = out.filter((i) => i.kind === kind);
    if (query) { const q = query.toLowerCase(); out = out.filter((i) => i.title.toLowerCase().includes(q)); }
    out.sort((a, b) => b.seq - a.seq);
    return out;
  }

  artworkUrl(item, size = '300x450') {
    const a = item.artwork?.find((x) => x.hash) || item.artwork?.[0];
    if (!a) return null;
    return a.hash ? `${this.api}/artwork/${a.hash}/${size}` : a.url;
  }
}

/** Memory LRU for artwork object URLs; eviction by last-focus time so the row being scanned never thrashes. */
export class ArtworkLru {
  constructor({ budgetBytes = 64 * 1024 * 1024 } = {}) { this.budget = budgetBytes; this.map = new Map(); this.size = 0; }
  async get(url) {
    const hit = this.map.get(url);
    if (hit) { hit.t = performance.now(); return hit.obj; }
    const res = await fetch(url); if (!res.ok) throw new Error(`artwork ${res.status}`);
    const blob = await res.blob(); const obj = URL.createObjectURL(blob);
    this.map.set(url, { obj, bytes: blob.size, t: performance.now() }); this.size += blob.size;
    this.evict(); return obj;
  }
  touch(url) { const h = this.map.get(url); if (h) h.t = performance.now(); }
  evict() {
    if (this.size <= this.budget) return;
    const entries = [...this.map.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [url, e] of entries) { if (this.size <= this.budget * 0.8) break; URL.revokeObjectURL(e.obj); this.map.delete(url); this.size -= e.bytes; }
  }
}
