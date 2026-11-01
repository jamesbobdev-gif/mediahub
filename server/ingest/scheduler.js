// Runs adapters concurrently with per-source concurrency of one and a global
// pool, on jittered intervals, so one slow or failing source never delays the rest.

import { adapterFor } from './adapters.js';
import { ArtworkStore } from './artwork.js';

export class Scheduler {
  constructor({ sources, catalog, artwork, poolSize = 4, log = () => {} }) {
    this.sources = sources; this.catalog = catalog; this.artwork = artwork; this.poolSize = poolSize; this.log = log;
    this.running = new Map(); this.timers = new Map(); this.active = 0; this.waiting = [];
    this.status = new Map();
    if (artwork) artwork.onStored = (url, hash, w, h) => catalog.setArtworkHash(url, hash, w, h);
  }

  start() {
    for (const s of this.sources.values()) {
      if (!adapterFor(s)) continue;
      this.schedule(s, 0);
    }
  }

  schedule(source, delayMs) {
    clearTimeout(this.timers.get(source.id));
    this.timers.set(source.id, setTimeout(() => this.run(source.id), delayMs));
  }

  stop() { for (const t of this.timers.values()) clearTimeout(t); }

  /** After a config reload: schedule new sources, drop timers for removed ones. */
  refresh({ added = [], removed = [] } = {}) {
    for (const id of removed) { clearTimeout(this.timers.get(id)); this.timers.delete(id); this.status.delete(id); }
    for (const id of added) { const s = this.sources.get(id); if (s && adapterFor(s)) this.schedule(s, 1000); }
  }

  async acquire() {
    if (this.active < this.poolSize) { this.active++; return; }
    await new Promise((r) => this.waiting.push(r));
    this.active++;
  }
  release() { this.active--; const next = this.waiting.shift(); if (next) next(); }

  /** Run one source now. Returns a summary; safe to call while scheduled. */
  async run(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`unknown source ${sourceId}`);
    if (this.running.has(sourceId)) return this.running.get(sourceId);
    const p = this._run(source).finally(() => this.running.delete(sourceId));
    this.running.set(sourceId, p);
    return p;
  }

  async _run(source) {
    const adapter = adapterFor(source, { log: this.log });
    const summary = { sourceId: source.id, startedAt: Date.now(), pages: 0, items: 0, inserted: 0, merged: 0, error: null };
    this.status.set(source.id, { ...summary, state: 'running' });
    await this.acquire();
    const ctrl = new AbortController();
    let backoffFactor = 1;
    try {
      for await (const items of adapter.pages(ctrl.signal)) {
        summary.pages++; summary.items += items.length;
        const r = this.catalog.upsertMany(items);
        summary.inserted += r.inserted; summary.merged += r.merged;
        if (this.artwork) for (const url of this.catalog.pendingArtwork(200)) this.artwork.enqueue(url);
      }
    } catch (e) {
      summary.error = e.message; backoffFactor = 4;
      this.log('ingest-error', source.id, e.message);
    } finally {
      this.release();
      summary.finishedAt = Date.now();
      this.status.set(source.id, { ...summary, state: 'idle' });
      const base = (source.intervalSec || 600) * 1000 * backoffFactor;
      this.schedule(source, base * (0.8 + Math.random() * 0.4));
    }
    return summary;
  }
}

export { ArtworkStore };
