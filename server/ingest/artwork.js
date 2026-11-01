// Content-addressed artwork store tuned for flash/USB class storage: batched
// sequential writes, fixed byte budget, LRU sweep only when idle. Resizing uses
// `sharp` if it happens to be installed; otherwise originals are stored as-is.

import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

export class ArtworkStore {
  constructor({ dir, budgetBytes = 2 * 1024 ** 3, batchSize = 32, idleFlushMs = 5000, log = () => {} }) {
    this.dir = dir; this.budget = budgetBytes; this.batchSize = batchSize; this.idleFlushMs = idleFlushMs; this.log = log;
    this.queue = []; this.timer = null; this.flushing = false; this.onStored = () => {};
    this.sizes = [[300, 450], [600, 900]];
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try { this.sharp = (await import('sharp')).default; } catch { this.sharp = null; }
  }

  static hashFor(url) { return createHash('sha1').update(url).digest('hex'); }
  fileFor(hash, size) { return path.join(this.dir, size ? `${hash}_${size}.webp` : `${hash}.bin`); }

  enqueue(url) {
    this.queue.push(url);
    if (this.queue.length >= this.batchSize) this.flush();
    else { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), this.idleFlushMs); }
  }

  /** Download a batch, then write all files in one burst (flash controllers prefer this over trickle writes). */
  async flush() {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.batchSize);
    const writes = [];
    await Promise.all(batch.map(async (url) => {
      try {
        const res = await fetch(url, { headers: { accept: 'image/*' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const hash = ArtworkStore.hashFor(url);
        if (this.sharp) {
          for (const [w, h] of this.sizes) {
            const out = await this.sharp(buf).resize(w, h, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
            writes.push({ file: this.fileFor(hash, `${w}x${h}`), data: out, url, hash, w, h });
          }
        } else {
          const ext = EXT_BY_TYPE[(res.headers.get('content-type') || '').split(';')[0].trim()] || 'bin';
          writes.push({ file: path.join(this.dir, `${hash}.${ext}`), data: buf, url, hash });
        }
      } catch (e) { this.log('artwork-fail', url, e.message); }
    }));
    for (const w of writes) {
      await writeFile(w.file, w.data);
      this.onStored(w.url, w.hash, w.w, w.h);
    }
    this.log('artwork-batch', batch.length, writes.length);
    this.flushing = false;
    if (this.queue.length >= this.batchSize) this.flush();
  }

  /** Resolve a hash to a file path for the API; prefer the requested size, fall back to the stored original. */
  async resolve(hash, size) {
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    for (const f of [size && this.fileFor(hash, size), this.fileFor(hash, '300x450')]) {
      if (!f) continue;
      try { await stat(f); return f; } catch {}
    }
    const orig = (await readdir(this.dir)).find((n) => n.startsWith(hash + '.'));
    return orig ? path.join(this.dir, orig) : null;
  }

  /** LRU sweep by mtime down to the budget. Caller runs this only when idle. */
  async sweep() {
    const entries = [];
    for (const name of await readdir(this.dir)) {
      const f = path.join(this.dir, name);
      try { const s = await stat(f); entries.push({ f, size: s.size, t: s.mtimeMs }); } catch {}
    }
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= this.budget) return { removed: 0, total };
    entries.sort((a, b) => a.t - b.t);
    let removed = 0;
    for (const e of entries) {
      if (total <= this.budget) break;
      try { await unlink(e.f); total -= e.size; removed++; } catch {}
    }
    this.log('artwork-sweep', removed, total);
    return { removed, total };
  }
}
