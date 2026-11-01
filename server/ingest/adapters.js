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

/**
 * Extract items from an HTML list page with a regex that uses named groups
 * (title, url, image, year, kind). Dependency-free; for portals with no JSON feed.
 */
export function extractHtmlItems(html, feed, pageUrl) {
  const re = new RegExp(feed.itemRegex, feed.itemFlags || 'gs');
  const out = [];
  for (const m of html.matchAll(re)) {
    const g = m.groups || {};
    if (!g.title) continue;
    const rec = { title: decodeEntities(g.title.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), year: g.year, kind: g.kind };
    if (g.url) { try { rec.url = new URL(decodeEntities(g.url), pageUrl).href; } catch {} }
    if (g.image) { try { rec.image = new URL(decodeEntities(g.image), pageUrl).href; } catch {} }
    out.push(rec);
  }
  let next = null;
  if (feed.nextRegex) {
    const m = html.match(new RegExp(feed.nextRegex, feed.nextFlags || 's'));
    if (m?.groups?.url) { try { next = new URL(decodeEntities(m.groups.url), pageUrl).href; } catch {} }
  }
  return { items: out, next };
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[k]);
}

async function fetchTextWithBackoff(url, { retries = 4, baseMs = 500, signal, log = () => {} } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try { res = await fetch(url, { signal, headers: { accept: 'text/html' } }); }
    catch (e) { if (attempt++ >= retries) throw e; await sleep(baseMs * 2 ** attempt); continue; }
    if (res.status === 429 || res.status >= 500) {
      if (attempt++ >= retries) throw new Error(`HTTP ${res.status} from ${url}`);
      await sleep(baseMs * 2 ** attempt + Math.random() * 250); log('backoff', url, res.status); continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.text();
  }
}

export function htmlListAdapter(source, { minIntervalMs = 500, log = () => {} } = {}) {
  const feed = source.feed;
  return {
    id: source.id,
    async *pages(signal) {
      let url = feed.url, page = 1, lastAt = 0;
      while (url) {
        const wait = minIntervalMs - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
        lastAt = Date.now();
        const html = await fetchTextWithBackoff(url, { signal, log });
        const { items, next } = extractHtmlItems(html, feed, url);
        yield items.map((rec) => normaliseRecord(rec, source.id));
        page++;
        url = next && (!feed.maxPages || page <= feed.maxPages) ? next : null;
      }
      log('adapter-done', source.id);
    },
  };
}

export function adapterFor(source, opts) {
  if (!source.feed?.url) return null;
  if (source.feed.type === 'html' || source.feed.itemRegex) return htmlListAdapter(source, opts);
  return jsonFeedAdapter(source, opts);
}
