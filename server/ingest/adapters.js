// Source adapters. Each is an async generator of pages with its own retry and
// rate-limit policy. The generic JSON adapter is driven entirely by the source
// manifest (feed.url, feed.items, feed.map) so a new provider is config, not code.

import { normaliseRecord } from './normalise.js';

export function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithBackoff(url, { retries = 4, baseMs = 500, signal, log = () => {} } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    } catch (e) {
      if (attempt++ >= retries) throw e;
      await sleep(baseMs * 2 ** attempt + Math.random() * 250);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt++ >= retries) throw new Error(`HTTP ${res.status} from ${url}`);
      const ra = Number(res.headers.get('retry-after'));
      const wait = ra ? ra * 1000 : baseMs * 2 ** attempt + Math.random() * 250;
      log('backoff', url, res.status, wait);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }
}

/** Generic JSON feed adapter: yields arrays of normalised CatalogItem candidates. */
export function jsonFeedAdapter(source, { minIntervalMs = 250, log = () => {} } = {}) {
  const feed = source.feed;
  return {
    id: source.id,
    async *pages(signal) {
      let page = 1, cursorUrl = feed.url, lastAt = 0, seen = 0;
      while (cursorUrl) {
        const wait = minIntervalMs - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
        lastAt = Date.now();
        const data = await fetchWithBackoff(cursorUrl, { signal, log });
        const rows = getPath(data, feed.items) || [];
        const items = [];
        for (const raw of rows) {
          const rec = {};
          for (const [field, path] of Object.entries(feed.map || {})) rec[field] = getPath(raw, path);
          if (rec.url) { try { rec.url = new URL(rec.url, feed.url).href; } catch {} }
          if (rec.image) { try { rec.image = new URL(rec.image, feed.url).href; } catch {} }
          if (!rec.title) continue;
          items.push(normaliseRecord(rec, source.id));
        }
        seen += items.length;
        yield items;
        const next = getPath(data, feed.next);
        if (next) cursorUrl = new URL(String(next), feed.url).href;
        else if (feed.pageParam && rows.length && feed.maxPages && page < feed.maxPages) {
          page++;
          const u = new URL(feed.url); u.searchParams.set(feed.pageParam, String(page)); cursorUrl = u.href;
        } else cursorUrl = null;
      }
      log('adapter-done', source.id, seen);
    },
  };
}

export function adapterFor(source, opts) {
  if (source.feed?.url) return jsonFeedAdapter(source, opts);
  return null;
}
