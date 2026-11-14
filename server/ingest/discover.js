// Feed finder. A source added from the TV has only a name and an address; this works out what
// the hub can pull from that site so its titles reach the home screen. It tries, in order, what
// sites publish for exactly this purpose: structured data on the page (JSON-LD lists of videos or
// films), the data a page embeds for its own tiles (Next.js and similar apps ship their carousels
// as JSON in the page), an RSS or Atom feed the page points at or one at a usual path, the video
// sitemaps listed in robots.txt, and last the plain page lists in those sitemaps, where titles come
// from the page addresses and posters from the pages themselves, a few at a time.
// Nothing here is site-specific: it is the same questions for every site.

import { gunzipSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 MediaHub/0.1';
export const ENOUGH = 5;          // fewer titles than this is not a catalog, it is a menu
export const ITEMS_PER_FILE = 300; // titles taken from one sitemap file or one page of data
export const SITEMAP_FILES = 4;   // sitemap files a source pulls per run
const SITEMAP_LOOKS = 8;          // child sitemaps the finder opens when judging an index
const SITEMAP_BYTES = 48 * 1024 ** 2;
const FEED_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/feeds/videos.xml', '/index.xml'];
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemaps/sitemap.xml'];
const VIDEO_WORDS = /video|movie|film|show|series|title|watch|episode|program|content/i;
const CONTENT_PATH = /\/(video|videos|movie|movies|film|films|show|shows|series|episode|episodes|watch|title|titles|tv-shows|tv|program|programs)\//i;

const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' })[k])
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*\\s${a}=["']([^"']+)["']`, 'i')); return m ? decode(m[1]) : ''; };
const abs = (u, base) => { if (!u) return undefined; try { return new URL(u, base).href; } catch { return undefined; } };
const isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);

/** A hint about what a page is, from its path: series and episode pages are usually named as such. */
export function kindFromUrl(url) {
  const p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (/\/(episode|episodes)\b|\/s\d{1,2}e\d{1,3}\b/.test(p)) return 'episode';
  if (/\/(series|show|shows|tv|tv-shows|tvshows|season|seasons)\b/.test(p)) return 'series';
  if (/\/(movie|movies|film|films)\b/.test(p)) return 'movie';
  return undefined;
}

/** A title from a page address: the last meaningful path segment, dashes to spaces, ids dropped. */
export function titleFromUrl(url) {
  let p; try { p = new URL(url).pathname; } catch { return ''; }
  const segs = p.split('/').filter(Boolean).filter((s) => !/^\d+$/.test(s) && !/^(video|videos|movie|movies|film|films|show|shows|series|episode|episodes|watch|title|titles|details|tv|tv-shows)$/i.test(s));
  let s = decodeURIComponent(segs[segs.length - 1] || '').replace(/\.(html?|php|aspx?)$/i, '');
  s = s.replace(/[-_]+[a-z0-9]{6,8}$/i, (m) => (/\d/.test(m) ? '' : m));   // trailing short ids like -whnx1k
  s = s.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  // An identifier is not a title: a long unbroken token, or hardly any letters.
  if (s.length < 3 || s.split(' ').some((w) => w.length > 15) || s.replace(/[^a-z]/gi, '').length < 3) return '';
  return s;
}

export async function fetchText(url, { signal, accept = 'text/html,application/xml,application/rss+xml,application/json;q=0.9,*/*;q=0.5', maxBytes = 8 * 1024 ** 2, log = () => {} } = {}) {
  const res = await fetch(url, { signal, headers: { 'user-agent': UA, accept, 'accept-language': 'en' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`too large: ${url}`);
  if (/\.gz(\?|$)/i.test(url) || type.includes('gzip')) { try { buf = gunzipSync(buf); } catch {} }
  log('discover-fetch', url, res.status, buf.length);
  return { text: buf.toString('utf8'), type, url: res.url || url };
}

// ---------- parsers (pure; tested on fixtures) ----------

/** JSON-LD on a page: ItemList entries and any VideoObject / Movie / TVSeries / Episode with a url. */
export function parseJsonLd(html, pageUrl) {
  const out = [], seen = new Set();
  const push = (o) => {
    if (!o || typeof o !== 'object') return;
    const name = o.name || o.headline, url = abs(o.url || o['@id'] || o.contentUrl, pageUrl);
    if (!name || !url || seen.has(url)) return;
    const img = o.thumbnailUrl || o.image?.url || o.image?.contentUrl || (Array.isArray(o.image) ? o.image[0]?.url || o.image[0] : o.image);
    const t = [].concat(o['@type'] || []).join(' ');
    const kind = /Episode/i.test(t) ? 'episode' : /Series|Show/i.test(t) ? 'series' : /Movie|Video/i.test(t) ? 'movie' : kindFromUrl(url);
    seen.add(url);
    out.push({ title: String(name), url, image: typeof img === 'string' ? abs(img, pageUrl) : undefined, kind, year: (o.datePublished || o.dateCreated || '').slice(0, 4) || undefined });
  };
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    const t = [].concat(node['@type'] || []).join(' ');
    if (/ItemList/i.test(t)) for (const e of node.itemListElement || []) { const item = e?.item || e; push(item && typeof item === 'object' ? item : e); }
    else if (/^(VideoObject|Movie|TVSeries|TVEpisode|Episode|Clip)$/i.test(t)) push(node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch {}
  }
  return out;
}

const TITLE_KEY = /^(title|name|headline|displayName)$/i;
const URL_KEY = /^(href|url|link|path|canonicalUrl|permalink|webUrl|pageUrl|slug)$/i;
const IMAGE_KEY = /(thumb|thumbnail|image|poster|artwork|cover|keyart|still|img|art)/i;
const KIND_KEY = /^(contentType|type|kind|mediaType|category)$/i;

/** The JSON a page embeds for its own tiles (Next.js props, state dumps, data islands): every list
 *  of five or more records that carry a title, a link and, for most of them, a picture. */
export function parsePageData(html, pageUrl, { limit = ITEMS_PER_FILE } = {}) {
  const out = [], seen = new Set();
  const imageOf = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (!IMAGE_KEY.test(k)) continue;
      if (isHttp(v) || (typeof v === 'string' && v.startsWith('/'))) return v;
      if (v && typeof v === 'object') { const u = v.url || v.src || v.href || v.path || (Array.isArray(v) ? (v[0]?.url || v[0]?.src || v[0]) : null); if (typeof u === 'string') return u; }
    }
    return undefined;
  };
  const record = (o) => {
    const tk = Object.keys(o).find((k) => TITLE_KEY.test(k) && typeof o[k] === 'string' && o[k].trim());
    const uk = Object.keys(o).find((k) => URL_KEY.test(k) && typeof o[k] === 'string' && o[k].trim());
    if (!tk || !uk) return null;
    const raw = o[uk];
    const url = /^slug$/i.test(uk) && !raw.startsWith('/') && !isHttp(raw) ? abs(`./${raw}`, pageUrl) : abs(raw, pageUrl);
    if (!url || !/^https?:/.test(url)) return null;
    const img = imageOf(o);
    const kk = Object.keys(o).find((k) => KIND_KEY.test(k) && typeof o[k] === 'string');
    const y = Object.keys(o).find((k) => /^(year|releaseYear|productionYear|datePublished|releaseDate)$/i.test(k));
    return { title: o[tk].trim(), url, image: img ? abs(img, pageUrl) : undefined, kind: kk ? o[kk] : kindFromUrl(url), year: y ? String(o[y]).match(/(19|20)\d{2}/)?.[0] : undefined };
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 14 || out.length >= limit) return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= ENOUGH) {
        const recs = objs.map(record).filter(Boolean);
        const pictured = recs.filter((r) => r.image).length;
        if (recs.length >= ENOUGH && pictured * 2 >= recs.length) {
          for (const r of recs) { if (seen.has(r.url) || out.length >= limit) continue; seen.add(r.url); out.push(r); }
        }
      }
      for (const x of node) walk(x, depth + 1);
      return;
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const txt = m[1].trim();
    if (!txt || /type=["']application\/ld\+json/i.test(m[0])) continue;
    const blobs = [];
    if (/^[\[{]/.test(txt)) blobs.push(txt);
    for (const b of txt.matchAll(/=\s*(\{[\s\S]{200,}?\})\s*;?\s*$/gm)) blobs.push(b[1]);
    for (const b of txt.matchAll(/JSON\.parse\((["'])([\s\S]*?)\1\)/g)) { try { blobs.push(JSON.parse(b[1] + b[2] + b[1])); } catch {} }
    for (const b of blobs) { try { walk(JSON.parse(b), 0); } catch {} if (out.length >= limit) break; }
    if (out.length >= limit) break;
  }
  return out;
}

/** RSS 2.0 or Atom: one item per entry, artwork from media:thumbnail, media:content, enclosure, or an img in the description. */
export function parseRss(xml, feedUrl) {
  const out = [];
  const entries = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>|<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1] ?? m[2]);
  for (const e of entries) {
    const title = tag(e, 'title') || tag(e, 'media:title');
    let url = tag(e, 'link') || attr(e, 'link', 'href') || tag(e, 'guid');
    url = abs(url, feedUrl);
    if (!title || !url) continue;
    const image = attr(e, 'media:thumbnail', 'url') || attr(e, 'itunes:image', 'href') || (attr(e, 'media:content', 'type').startsWith('image') ? attr(e, 'media:content', 'url') : '')
      || (attr(e, 'enclosure', 'type').startsWith('image') ? attr(e, 'enclosure', 'url') : '')
      || ((e.match(/<description[^>]*>([\s\S]*?)<\/description>|<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&quot;/g, '"').match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || '';
    const date = tag(e, 'pubDate') || tag(e, 'published') || tag(e, 'updated');
    const y = date.match(/(19|20)\d{2}/)?.[0];
    out.push({ title, url, image: image ? abs(image, feedUrl) : undefined, kind: kindFromUrl(url), year: y });
  }
  return out;
}

/** A sitemap: either an index (child sitemap urls) or a url set. Video entries carry a title and a
 *  thumbnail; plain entries under a content path are kept as pages, titled from their address. */
export function parseSitemap(xml, sitemapUrl, { limit = ITEMS_PER_FILE } = {}) {
  const children = [...xml.matchAll(/<sitemap(?:\s[^>]*)?>([\s\S]*?)<\/sitemap>/gi)].map((m) => abs(tag(m[1], 'loc'), sitemapUrl)).filter(Boolean);
  const items = [], pages = [];
  for (const m of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi)) {
    if (items.length >= limit && pages.length >= limit) break;
    const u = m[1];
    const url = abs(tag(u, 'loc'), sitemapUrl);
    if (!url) continue;
    const vid = u.match(/<video:video>([\s\S]*?)<\/video:video>/i);
    if (vid) {
      const title = tag(vid[1], 'video:title');
      if (!title || items.length >= limit) continue;
      const date = tag(vid[1], 'video:publication_date');
      items.push({ title, url, image: abs(tag(vid[1], 'video:thumbnail_loc'), sitemapUrl), kind: kindFromUrl(url), year: date.match(/(19|20)\d{2}/)?.[0] });
    } else if (pages.length < limit && CONTENT_PATH.test(new URL(url).pathname + '/')) {
      const title = titleFromUrl(url);
      const image = abs(tag(u, 'image:loc'), sitemapUrl);
      if (title) pages.push({ title, url, image, kind: kindFromUrl(url) });
    }
  }
  return { children, items, pages };
}

/** Open Graph tags of one page: the real title and poster behind a page address. */
export function parseOpenGraph(html, pageUrl) {
  const meta = (name) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'))?.[0]?.match(/content=["']([^"']*)["']/i)?.[1];
  const title = decode(meta('og:title') || meta('twitter:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const image = abs(decode(meta('og:image') || meta('og:image:secure_url') || meta('twitter:image') || ''), pageUrl);
  const type = (meta('og:type') || '').toLowerCase();
  const kind = /episode/.test(type) ? 'episode' : /tv_show|series/.test(type) ? 'series' : /movie|video/.test(type) ? 'movie' : undefined;
  return { title: title.replace(/\s*[|·-]\s*[^|·-]{0,40}$/u, (m) => (title.length - m.length >= 3 ? '' : m)).trim() || title, image, kind };
}

/** Feed urls a page declares, plus the usual paths. */
export function feedCandidates(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const l = m[0];
    if (!/rel=["'][^"']*alternate/i.test(l) || !/type=["']application\/(rss|atom)\+xml/i.test(l)) continue;
    const href = l.match(/href=["']([^"']+)["']/i)?.[1];
    const u = href && abs(decode(href), pageUrl);
    if (u && !out.includes(u)) out.push(u);
  }
  const origin = new URL(pageUrl).origin;
  for (const p of FEED_PATHS) { const u = origin + p; if (!out.includes(u)) out.push(u); }
  return out;
}

export function sitemapCandidates(robotsTxt, origin) {
  const out = [];
  for (const m of String(robotsTxt || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) { const u = abs(m[1], origin); if (u && !out.includes(u)) out.push(u); }
  for (const p of SITEMAP_PATHS) { const u = origin + p; if (!out.includes(u)) out.push(u); }
  return out;
}

/** Child sitemaps worth opening first: the ones named after what they list. */
export const rankSitemaps = (urls) => [...urls].sort((a, b) => (VIDEO_WORDS.test(b) ? 1 : 0) - (VIDEO_WORDS.test(a) ? 1 : 0));

// ---------- the search ----------

/**
 * Look for something the hub can pull titles from. Returns {feed, items, how, intervalSec} or null.
 * `feed` is ready to store in the source entry; `items` is the sample it was judged on.
 */
export async function discoverFeed(origin, home = '/', { timeoutMs = 25000, log = () => {}, fetchText: ft = fetchText } = {}) {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1000, deadline - Date.now());
  const get = async (url, accept, maxBytes) => ft(url, { signal: AbortSignal.timeout(Math.min(10000, left())), accept, maxBytes, log });
  const base = new URL(origin).origin;
  const homeUrl = abs(home || '/', base) || base;

  // 1. The page itself: structured data, then the data it embeds for its tiles, then feeds it links to.
  let html = '';
  try { html = (await get(homeUrl)).text; } catch (e) { log('discover', 'home page failed', e.message); }
  if (html) {
    let items = parseJsonLd(html, homeUrl);
    if (items.length >= ENOUGH) return { feed: { type: 'jsonld', url: homeUrl }, items, how: 'structured data on the page', intervalSec: 3600 };
    items = parsePageData(html, homeUrl);
    if (items.length >= ENOUGH) return { feed: { type: 'pagedata', url: homeUrl }, items, how: 'the lists on its page', intervalSec: 3600 };
  }
  for (const url of feedCandidates(html, homeUrl)) {
    if (Date.now() > deadline) break;
    try {
      const r = await get(url, 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5');
      if (!/<(rss|feed|rdf:RDF)\b/i.test(r.text.slice(0, 2000))) continue;
      const items = parseRss(r.text, r.url);
      if (items.length >= ENOUGH) return { feed: { type: 'rss', url: r.url }, items, how: 'an RSS feed', intervalSec: 3600 };
    } catch {}
  }

  // 2. Sitemaps from robots.txt: video entries, else plain page lists under content paths.
  let robots = '';
  try { robots = (await get(base + '/robots.txt', 'text/plain')).text; } catch {}
  let pagesFound = null;
  for (const url of sitemapCandidates(robots, base)) {
    if (Date.now() > deadline) break;
    let r;
    try { r = await get(url, 'application/xml,text/xml;q=0.9,*/*;q=0.5', SITEMAP_BYTES); } catch { continue; }
    if (!/<(sitemapindex|urlset)\b/i.test(r.text.slice(0, 4000))) continue;
    const top = parseSitemap(r.text, r.url);
    if (top.items.length >= ENOUGH) return { feed: { type: 'sitemap', url: r.url, files: [r.url] }, items: top.items, how: 'its video sitemap', intervalSec: 86400 };
    if (top.pages.length >= ENOUGH && !pagesFound) pagesFound = { feed: { type: 'pages', url: r.url, files: [r.url] }, items: top.pages };
    const kids = rankSitemaps(top.children);
    const videoFiles = [], pageFiles = [];
    let looked = 0;
    for (const kid of kids) {
      if (looked++ >= SITEMAP_LOOKS || Date.now() > deadline) break;
      try {
        const k = await get(kid, 'application/xml,text/xml;q=0.9,*/*;q=0.5', SITEMAP_BYTES);
        const parsed = parseSitemap(k.text, k.url);
        if (parsed.items.length >= ENOUGH) videoFiles.push({ url: k.url, items: parsed.items });
        else if (parsed.pages.length >= ENOUGH) pageFiles.push({ url: k.url, items: parsed.pages });
        if (videoFiles.length >= SITEMAP_FILES) break;
      } catch (e) { log('discover', 'sitemap skipped', kid, e.message); }
    }
    if (videoFiles.length) {
      // The files that hold videos are the feed; the rest of the index is never fetched again.
      const files = [...videoFiles.map((f) => f.url), ...kids.filter((k) => VIDEO_WORDS.test(k) && !videoFiles.some((f) => f.url === k))].slice(0, SITEMAP_FILES);
      return { feed: { type: 'sitemap', url: r.url, files }, items: videoFiles[0].items, how: 'its video sitemap', intervalSec: 86400 };
    }
    if (pageFiles.length && !pagesFound) pagesFound = { feed: { type: 'pages', url: r.url, files: pageFiles.map((f) => f.url).slice(0, SITEMAP_FILES) }, items: pageFiles[0].items };
  }
  // Page lists are pulled hourly: each run opens a few more pages for real titles and posters.
  if (pagesFound) return { ...pagesFound, how: 'the list of its pages', intervalSec: 3600 };
  return null;
}
