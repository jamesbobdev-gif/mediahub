// Catalog store on node:sqlite (WAL, synchronous=NORMAL): sequential appends,
// one delta query for the TV. Fuzzy merge happens here so adapters stay dumb.

import { DatabaseSync } from 'node:sqlite';
import { jaroWinkler } from './normalise.js';

const FUZZY_THRESHOLD = 0.92;

export class Catalog {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, title_key TEXT NOT NULL,
        year INTEGER, season INTEGER, episode INTEGER, raw_title TEXT, seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_seq ON items(seq);
      CREATE INDEX IF NOT EXISTS items_key ON items(kind, year, title_key);
      CREATE TABLE IF NOT EXISTS item_sources (
        item_id TEXT NOT NULL, source_id TEXT NOT NULL, item_url TEXT, seen_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS artwork (
        item_id TEXT NOT NULL, url TEXT NOT NULL, hash TEXT, w INTEGER, h INTEGER,
        PRIMARY KEY (item_id, url)
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this.q = {
      byId: this.db.prepare('SELECT * FROM items WHERE id = ?'),
      candidates: this.db.prepare('SELECT id, title_key FROM items WHERE kind = ? AND (year = ? OR year IS NULL OR ? IS NULL)'),
      insert: this.db.prepare('INSERT INTO items (id, kind, title, title_key, year, season, episode, raw_title, seq) VALUES (?,?,?,?,?,?,?,?,?)'),
      touch: this.db.prepare('UPDATE items SET seq = ? WHERE id = ?'),
      upsertSource: this.db.prepare('INSERT INTO item_sources (item_id, source_id, item_url, seen_at) VALUES (?,?,?,?) ON CONFLICT(item_id, source_id) DO UPDATE SET item_url = excluded.item_url, seen_at = excluded.seen_at'),
      upsertArt: this.db.prepare('INSERT OR IGNORE INTO artwork (item_id, url) VALUES (?,?)'),
      setArtHash: this.db.prepare('UPDATE artwork SET hash = ?, w = ?, h = ? WHERE url = ?'),
      maxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM items'),
      since: this.db.prepare('SELECT * FROM items WHERE seq > ? ORDER BY seq LIMIT ?'),
      sourcesFor: this.db.prepare('SELECT source_id, item_url, seen_at FROM item_sources WHERE item_id = ?'),
      artFor: this.db.prepare('SELECT url, hash, w, h FROM artwork WHERE item_id = ?'),
      pendingArt: this.db.prepare('SELECT url FROM artwork WHERE hash IS NULL LIMIT ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM items'),
    };
    this.seq = this.q.maxSeq.get().seq;
  }

  /** Find an existing item id for a normalised candidate: exact key, then fuzzy within same kind/year. */
  match(item) {
    if (this.q.byId.get(item.id)) return item.id;
    let best = null, bestScore = 0;
    for (const row of this.q.candidates.all(item.kind, item.year ?? null, item.year ?? null)) {
      const s = jaroWinkler(item.titleKey, row.title_key);
      if (s > bestScore) { bestScore = s; best = row.id; }
    }
    return bestScore >= FUZZY_THRESHOLD ? best : null;
  }

  /** Upsert a batch in one transaction. Returns {inserted, merged}. */
  upsertMany(items) {
    const res = { inserted: 0, merged: 0 };
    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        const existing = this.match(item);
        const id = existing || item.id;
        this.seq++;
        if (existing) { this.q.touch.run(this.seq, id); res.merged++; }
        else {
          this.q.insert.run(id, item.kind, item.title, item.titleKey, item.year ?? null, item.season ?? null, item.episode ?? null, item.rawTitle, this.seq);
          res.inserted++;
        }
        for (const s of item.sources) this.q.upsertSource.run(id, s.sourceId, s.itemUrl ?? null, s.seenAt);
        for (const a of item.artwork) this.q.upsertArt.run(id, a.url);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return res;
  }

  /** Delta since cursor. The TV passes its last cursor; unchanged catalog = empty items. */
  since(cursor = 0, limit = 500) {
    const rows = this.q.since.all(cursor, limit);
    const items = rows.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, year: r.year, season: r.season, episode: r.episode,
      sources: this.q.sourcesFor.all(r.id).map((s) => ({ sourceId: s.source_id, itemUrl: s.item_url, seenAt: s.seen_at })),
      artwork: this.q.artFor.all(r.id).map((a) => ({ url: a.url, hash: a.hash, w: a.w, h: a.h })),
      seq: r.seq,
    }));
    return { cursor: rows.length ? rows[rows.length - 1].seq : cursor, head: this.seq, items };
  }

  pendingArtwork(limit = 50) { return this.q.pendingArt.all(limit).map((r) => r.url); }
  setArtworkHash(url, hash, w, h) { this.q.setArtHash.run(hash, w ?? null, h ?? null, url); }
  count() { return this.q.count.get().n; }
  close() { this.db.close(); }
}
