// In-memory cache for proxied responses the TV can safely see again: scripts, stylesheets,
// images, fonts and small JSON/XML. The policy (what may be kept, for how long) is pure so the
// tests can drive it without a network; the store is an LRU with a byte budget.
//
// Never kept: HTML documents, HLS/DASH playlists, media, anything with a Set-Cookie, answers to
// Range requests, anything upstream marked no-store/private, and anything but a 200 to a GET.

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WEEK = 7 * DAY;

export const DEFAULT_MB = 256;
export const TTL = { script: HOUR, style: HOUR, image: DAY, font: DAY, data: 0, hashed: WEEK, max: WEEK };
const SMALL_DATA_BYTES = 256 * 1024;

const FONT_EXT = ['woff', 'woff2', 'ttf', 'otf', 'eot'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'];

/** What kind of thing a response is, from its content-type and then the URL's extension.
 *  Returns 'script' | 'style' | 'image' | 'font' | 'data' | null (not a kind we keep). */
export function cacheKind(ctype, url) {
  const t = String(ctype || '').toLowerCase().split(';')[0].trim();
  if (t.includes('html') || t.includes('mpegurl') || t.includes('dash+xml') || t.startsWith('video/') || t.startsWith('audio/')) return null;
  if (t.includes('javascript') || t.includes('ecmascript')) return 'script';
  if (t === 'text/css') return 'style';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('font/') || t.includes('font-woff') || t.includes('x-font') || t === 'application/vnd.ms-fontobject') return 'font';
  if (t === 'application/json' || t === 'text/json' || t.endsWith('+json') || t === 'application/xml' || t === 'text/xml') return 'data';
  let ext = '';
  try { ext = (new URL(url).pathname.split('/').pop().split('.').pop() || '').toLowerCase(); } catch { return null; }
  if (t && t !== 'application/octet-stream' && t !== 'text/plain' && t !== 'binary/octet-stream') return null;
  if (['js', 'mjs'].includes(ext)) return 'script';
  if (ext === 'css') return 'style';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (FONT_EXT.includes(ext)) return 'font';
  return null;
}

/** A file name or query with a content hash in it (main.3f9a1c2b.js, chunk-X7kQ9mLp2rTv.js, ?v=a1b2c3d4e5):
 *  the bytes can only change when the name does, so such a URL can be kept for a week. */
export function hasContentHash(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const name = u.pathname.split('/').pop() + ' ' + u.search;
  for (const tok of name.split(/[^a-z0-9]+/i)) {
    if (/^[a-f0-9]{8,}$/i.test(tok) && /\d/.test(tok)) return true;
    if (tok.length >= 12 && /\d/.test(tok) && /[a-z]/i.test(tok) && /^[a-z0-9]+$/i.test(tok)) return true;
  }
  return false;
}

/** Parse the upstream freshness headers. Returns {forbid: true} when upstream says not to keep it,
 *  {ttl: ms} when it gives a lifetime, or {} when it says nothing. */
export function upstreamFreshness(headers, now = Date.now()) {
  const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]) || '';
  const cc = get('cache-control').toLowerCase();
  if (/\b(no-store|private)\b/.test(cc)) return { forbid: true };
  const vary = get('vary').toLowerCase();
  if (vary === '*' || /\b(cookie|authorization)\b/.test(vary)) return { forbid: true };
  const m = cc.match(/\bs-maxage=(\d+)/) || cc.match(/\bmax-age=(\d+)/);
  if (m) {
    const ttl = Number(m[1]) * SECOND;
    return ttl > 0 ? { ttl } : { forbid: true };
  }
  if (/\bno-cache\b/.test(cc)) return { forbid: true };
  const exp = get('expires');
  if (exp) {
    const t = Date.parse(exp);
    if (!Number.isNaN(t)) return t > now ? { ttl: t - now } : { forbid: true };
  }
  return {};
}

/** Decide whether a response may be kept and for how long.
 *  req: {method, headers}; res: {status, headers (Headers or plain object)}; url: the upstream URL.
 *  Returns {ok: true, ttl, kind} or {ok: false, reason}. */
export function cachePolicy({ method = 'GET', reqHeaders = {}, status, resHeaders, url, ctype, size, now = Date.now() }) {
  if (method !== 'GET') return { ok: false, reason: 'method' };
  if (reqHeaders['range']) return { ok: false, reason: 'range' };
  if (reqHeaders['authorization']) return { ok: false, reason: 'authorization' };
  if (status !== 200) return { ok: false, reason: 'status' };
  const kind = cacheKind(ctype, url);
  if (!kind) return { ok: false, reason: 'kind' };
  const getSetCookie = typeof resHeaders?.getSetCookie === 'function' ? resHeaders.getSetCookie() : [].concat(resHeaders?.['set-cookie'] || []);
  if (getSetCookie.length) return { ok: false, reason: 'set-cookie' };
  const fresh = upstreamFreshness(resHeaders || {}, now);
  if (fresh.forbid) return { ok: false, reason: 'upstream' };
  if (kind === 'data') {
    if (!fresh.ttl) return { ok: false, reason: 'data-needs-upstream-ttl' };
    if (size != null && size > SMALL_DATA_BYTES) return { ok: false, reason: 'data-too-big' };
  }
  let ttl = fresh.ttl || (hasContentHash(url) ? TTL.hashed : TTL[kind]);
  if (!ttl) return { ok: false, reason: 'no-ttl' };
  ttl = Math.min(ttl, TTL.max);
  return { ok: true, ttl, kind };
}

/** An LRU byte-budgeted store. Entries: {status, headers, body (Buffer), expires}. */
export function createCache({ maxBytes = DEFAULT_MB * 1024 * 1024, now = Date.now } = {}) {
  const map = new Map();                                  // insertion order = least recently used first
  const stats = { entries: 0, bytes: 0, hits: 0, misses: 0, evictions: 0, maxBytes };
  const maxEntry = Math.min(16 * 1024 * 1024, Math.floor(maxBytes / 8));
  const enabled = maxBytes > 0;

  function drop(key) {
    const e = map.get(key);
    if (!e) return;
    map.delete(key);
    stats.bytes -= e.body.length; stats.entries--;
  }
  /** The entry for key, or null. An entry kept per source (rewritten CSS) answers only that source. */
  function get(key, sourceId) {
    if (!enabled) return null;
    const e = map.get(key);
    if (!e || (e.sourceId && e.sourceId !== sourceId)) { stats.misses++; return null; }
    if (e.expires <= now()) { drop(key); stats.misses++; return null; }
    map.delete(key); map.set(key, e);                     // most recent last
    stats.hits++;
    return e;
  }
  function set(key, { status = 200, headers = {}, body, ttl, sourceId }) {
    if (!enabled || !body || body.length > maxEntry || !(ttl > 0)) return false;
    drop(key);
    map.set(key, { status, headers, body, sourceId, expires: now() + ttl, stored: now() });
    stats.bytes += body.length; stats.entries++;
    while (stats.bytes > maxBytes && map.size) { drop(map.keys().next().value); stats.evictions++; }
    return true;
  }
  function clear() { map.clear(); stats.bytes = 0; stats.entries = 0; }
  const has = (key) => map.has(key);
  return { get, set, has, clear, stats, enabled, maxEntry };
}
