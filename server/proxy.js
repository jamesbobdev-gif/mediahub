// Rewriting reverse proxy. Every portal page is served from the hub's own origin
// under /p/<sourceId>/<path>, and cross-origin assets under /x/<sourceId>/<encoded-url>.
// That single-origin topology is what lets the shell read the portal DOM
// directly and lets us answer noise requests with placeholders on every TV OS,
// not only where a native request hook exists (Android's shouldInterceptRequest).

import { Readable } from 'node:stream';
import { classify, destinationFor, placeholderFor } from './filters.js';
import { createCache, cachePolicy, DEFAULT_MB } from './cache.js';

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];
// Request headers that name the TV or the hub rather than the page's request: not sent upstream.
const DROP_REQUEST = new Set([...HOP_BY_HOP, 'host', 'cookie', 'accept-encoding', 'content-length', 'origin', 'referer', 'user-agent', 'expect']);
const STRIP_RESPONSE = new Set([
  ...HOP_BY_HOP, 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'content-length', 'content-encoding', 'strict-transport-security',
  'alt-svc',   // would point the TV at the real host over QUIC
]);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 MediaHub/0.1';

/** Loopback, link-local and RFC1918 ranges, plus bare hostnames: a page must never be able to make
 *  the hub fetch from the home network. A source whose own origin is private (the local demo) is exempt. */
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

/** Cookie isolation: every portal shares the hub origin on the TV, so cookie names are prefixed per
 *  source on the way in and only that source's cookies are forwarded on the way out. */
const cookiePrefix = (source) => `s_${source.id}__`;
export function scopeSetCookie(header, source) {
  return header.replace(/^\s*([^=;\s]+)=/, (m, name) => `${cookiePrefix(source)}${name}=`)
    .replace(/;\s*domain=[^;]*/i, '').replace(/;\s*secure/i, '').replace(/;\s*samesite=none/i, '');
}
export function unscopeCookieHeader(header, source) {
  const p = cookiePrefix(source);
  const out = [];
  for (const part of String(header || '').split(/;\s*/)) {
    if (part.startsWith(p)) out.push(part.slice(p.length));
  }
  return out.join('; ');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** The named and numeric character references an attribute value can carry. */
export function decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BLOCKED_HOSTS_KEPT = 60;

/** Remember a strict third-party block per source and host. Ad-list and ad-size blocks are not
 *  kept: allowing a host does not lift those, so the TV has nothing to offer for them. */
export function noteBlockedHost(map, sourceId, host, verdict) {
  if (!verdict.block || !String(verdict.reason || '').startsWith('third-party-')) return;
  let m = map.get(sourceId);
  if (!m) map.set(sourceId, m = new Map());
  const e = m.get(host) || { host, count: 0, kinds: new Set(), last: 0 };
  e.count++; e.kinds.add(verdict.destination); e.last = Date.now();
  m.delete(host); m.set(host, e);                       // most recent last
  while (m.size > BLOCKED_HOSTS_KEPT) m.delete(m.keys().next().value);
}

export function blockedHostsFor(map, sourceId) {
  const m = map.get(sourceId);
  if (!m) return [];
  return [...m.values()].map((e) => ({ host: e.host, count: e.count, kinds: [...e.kinds], last: e.last })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

const SOURCE_COOKIE = 'hub_source';

/** The source behind a portal-port request that carries no /p/ or /x/ prefix: the hub's own cookie
 *  set with the last page, else the page in the Referer. Null when neither names a known source. */
export function sourceFromHeaders(headers, sources) {
  const fromCookie = String(headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SOURCE_COOKIE}=([^;]+)`))?.[1];
  const fromReferer = String(headers.referer || '').match(/\/p\/([^/?#]+)/)?.[1];
  for (const id of [fromCookie, fromReferer]) {
    if (!id) continue;
    try { const s = sources.get(decodeURIComponent(id)); if (s) return s; } catch {}
  }
  return null;
}

export function createProxy({ sources, filters, log = () => {}, cacheMb = DEFAULT_MB }) {
  // blockedHosts: sourceId -> Map(host -> {host, count, kinds, last}) for the third-party blocks a
  // source's pages ran into, which is what the Settings screen offers to allow.
  const stats = { requests: 0, blocked: 0, byReason: new Map(), blockedHosts: new Map() };
  // Scripts, styles, images and fonts the TV asked for before are answered from memory, so a
  // portal's second open does not fetch its hundreds of files from the internet again.
  // Rewritten CSS is kept per source (its URLs are rewritten with the source id); everything
  // else is keyed by the upstream URL alone, since the bytes are the same whoever asked.
  const cache = createCache({ maxBytes: Math.max(0, Number(cacheMb) || 0) * 1024 * 1024 });

  /** Map an absolute upstream URL to a hub-origin path. */
  function hubUrlFor(absolute, source) {
    let u;
    try { u = new URL(absolute); } catch { return absolute; }
    if (!/^https?:$/.test(u.protocol)) return absolute;
    if (u.origin === source.originUrl.origin) {
      const base = source.originUrl.pathname.replace(/\/$/, '');
      const rel = base && u.pathname.startsWith(base) ? u.pathname.slice(base.length) : u.pathname;
      return `/p/${source.id}${rel || '/'}${u.search}${u.hash}`;
    }
    return `/x/${source.id}/${encodeURIComponent(u.href)}`;
  }

  /** HLS playlists: every non-comment line is a URI; KEY/MAP/MEDIA tags carry URI="...". */
  function rewriteM3u8(text, source, playlistUrl) {
    return text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (m, u) => { try { return `URI="${hubUrlFor(new URL(u, playlistUrl).href, source)}"`; } catch { return m; } });
      }
      try { return hubUrlFor(new URL(t, playlistUrl).href, source); } catch { return line; }
    }).join('\n');
  }
  /** DASH manifests: BaseURL elements and media/initialization/sourceURL attributes. */
  function rewriteMpd(text, source, manifestUrl) {
    const abs = (u) => { try { return hubUrlFor(new URL(u, manifestUrl).href, source); } catch { return u; } };
    return text
      .replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/g, (m, u) => m.replace(u, abs(u.trim())))
      .replace(/\b(media|initialization|sourceURL|xlink:href)="([^"]+)"/g, (m, k, u) => `${k}="${abs(u)}"`);
  }
  const isHls = (ctype, url) => /mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(url);
  const isDash = (ctype, url) => /dash\+xml/i.test(ctype) || /\.mpd(\?|$)/i.test(url);

  function rewriteCssUrls(text, source, pageUrl) {
    return text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, val) => {
      if (/^(data|blob):/i.test(val) || val.startsWith('#')) return m;
      try { return `url(${q}${hubUrlFor(new URL(val, pageUrl).href, source)}${q})`; } catch { return m; }
    });
  }

  /** Script URLs written out in full inside JavaScript or JSON ("https://cdn/player.module.js", also
   *  with JSON's escaped slashes). A module a page loads with import(url) cannot be routed at run
   *  time the way fetch and script.src are, so the address is routed in the text instead. */
  function rewriteJsUrls(text, source) {
    return text.replace(/(["'])(https?:(?:\/\/|\\\/\\\/)(?:[^"'\s<>\\]|\\\/)+?\.m?js(?:\?(?:[^"'\s<>\\]|\\\/)*)?)\1/g, (m, q, raw) => {
      const escaped = raw.includes('\\/');
      const url = escaped ? raw.replace(/\\\//g, '/') : raw;
      const routed = hubUrlFor(url, source);
      if (routed === url) return m;
      return `${q}${escaped ? routed.replace(/\//g, '\\/') : routed}${q}`;
    });
  }

  function rewriteHtml(html, source, pageUrl, shellOrigin = '') {
    const rules = source.rules;
    // Attribute values arrive HTML-escaped ("?a=1&amp;b=2"): decode before resolving, so the
    // upstream URL gets "&" and not a parameter named "amp;b", and escape again on the way out.
    const attr = /(\s(?:src|href|action|poster|data-src|data-lazy-src))=(["'])([^"']*)\2/gi;
    html = html.replace(attr, (m, name, q, raw) => {
      const val = decodeEntities(raw);
      if (!val || val.startsWith('#') || /^(javascript|data|blob|mailto):/i.test(val)) return m;
      let abs;
      try { abs = new URL(val, pageUrl).href; } catch { return m; }
      return `${name}=${q}${escapeAttr(hubUrlFor(abs, source))}${q}`;
    });
    html = html.replace(/(\ssrcset=)(["'])([^"']*)\2/gi, (m, name, q, raw) => {
      const out = decodeEntities(raw).split(',').map((part) => {
        const [u, d] = part.trim().split(/\s+/);
        try { return [hubUrlFor(new URL(u, pageUrl).href, source), d].filter(Boolean).join(' '); } catch { return part; }
      }).join(', ');
      return `${name}${q}${escapeAttr(out)}${q}`;
    });
    // CSS url() only where CSS lives: <style> blocks and style attributes. Scripts are left alone
    // (a page's own "new URL(x)" is not a stylesheet, and rewriting it broke the script).
    html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => open + rewriteCssUrls(css, source, pageUrl) + close);
    html = html.replace(/(\sstyle=)(["'])([^"']*)\2/gi, (m, name, q, raw) => `${name}${q}${escapeAttr(rewriteCssUrls(decodeEntities(raw), source, pageUrl))}${q}`);
    html = html.replace(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, js, close) => open + rewriteJsUrls(js, source) + close);
    // Force the desktop layout width the portal was designed for; the shell scales the frame.
    html = html.replace(/<meta[^>]+name=["']viewport["'][^>]*>/gi, '');
    html = html.replace(/<base\s[^>]*>/gi, '');
    // <meta http-equiv="refresh" content="0;url=..."> is a classic redirect vector: route it or drop it.
    html = html.replace(/<meta([^>]+http-equiv=["']refresh["'][^>]*)>/gi, (m, attrs) => {
      const u = attrs.match(/url\s*=\s*['"]?([^'">\s]+)/i);
      if (!u) return m;
      try { return m.replace(u[1], hubUrlFor(new URL(u[1], pageUrl).href, source)); } catch { return ''; }
    });
    const head = [
      '<meta name="viewport" content="width=1280">',
      `<script>window.__HUB_RULES=${JSON.stringify({ sourceId: source.id, ...rules })};window.__HUB_ORIGIN=${JSON.stringify(source.originUrl.origin)};window.__HUB_SHELL=${JSON.stringify(shellOrigin)};</script>`,
      '<script src="/shell/inject/content.js"></script>',
      '<link rel="stylesheet" href="/shell/inject/content.css">',
      rules.css.length ? `<style id="hub-source-css">${rules.css.join(',\n')}{display:none !important}</style>` : '',
    ].join('\n');
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
    else html = head + html;
    return html;
  }

  function record(result, source, upstream) {
    stats.requests++;
    if (result.block) {
      stats.blocked++;
      stats.byReason.set(result.reason, (stats.byReason.get(result.reason) || 0) + 1);
      noteBlockedHost(stats.blockedHosts, source.id, upstream.hostname, result);
    }
  }

  /** Resolve a hub request path to {source, upstream, firstParty} or null. */
  function resolve(req) {
    const url = new URL(req.url, 'http://hub');
    const bare = url.pathname.startsWith('/p/') || url.pathname.startsWith('/x/') ? null : sourceFromHeaders(req.headers, sources);
    if (bare) {
      // The page's own path, without the hub prefix (its script navigated, or a worker asked):
      // the source is the one whose page was served last, from the hub's own cookie.
      const base = bare.originUrl.pathname.replace(/\/$/, '');
      return { source: bare, upstream: new URL(`${bare.originUrl.origin}${base}${url.pathname}${url.search}`), firstParty: true };
    }
    let m = url.pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (m) {
      const source = sources.get(m[1]);
      if (!source) return null;
      const base = source.originUrl.pathname.replace(/\/$/, '');
      const upstream = new URL(`${source.originUrl.origin}${base}${m[2] || '/'}${url.search}`);
      return { source, upstream, firstParty: true };
    }
    m = url.pathname.match(/^\/x\/([^/]+)\/(.+)$/);
    if (m) {
      const source = sources.get(m[1]);
      if (!source) return null;
      let upstream;
      try { upstream = new URL(decodeURIComponent(m[2]) + url.search); } catch { return null; }
      if (!/^https?:$/.test(upstream.protocol)) return null;
      // A page on an https portal asking for plain http (a protocol-relative URL resolved against the
      // hub's address) would be mixed content on the real site; its CDN serves https anyway.
      if (upstream.protocol === 'http:' && source.originUrl.protocol === 'https:') upstream.protocol = 'https:';
      // Third-party fetches may not reach the home network (unless the source itself lives there).
      if (isPrivateHost(upstream.hostname) && upstream.hostname !== source.originUrl.hostname) return { forbidden: `private host ${upstream.hostname}` };
      return { source, upstream, firstParty: upstream.origin === source.originUrl.origin };
    }
    return null;
  }

  async function handle(req, res) {
    const r = resolve(req);
    if (!r) { res.writeHead(404).end('unknown source'); return; }
    if (r.forbidden) { stats.blocked++; log('forbidden', r.forbidden, req.url); res.writeHead(403, { 'x-hub-blocked': r.forbidden }).end(); return; }
    const { source, upstream, firstParty } = r;
    const destination = destinationFor(req.headers, upstream.href);
    const verdict = classify(filters, upstream.href, { destination, firstParty, allowHosts: source.allowHostsRe || [] });
    record(verdict, source, upstream);
    if (verdict.block) {
      const ph = placeholderFor(destination);
      log('blocked', destination, verdict.reason, upstream.href);
      // Never cacheable: once the host is allowed from Settings, the next load must reach the hub.
      res.writeHead(ph.status, { 'content-type': ph.type, 'cache-control': 'no-store', 'x-hub-blocked': verdict.reason });
      res.end(ph.body);
      return;
    }

    // A cached copy answers without touching the internet. Only plain GETs look: a Range request
    // wants part of a file, and HEAD/POST are never kept.
    const looks = cache.enabled && req.method === 'GET' && !req.headers['range'];
    const hit = looks ? cache.get(upstream.href, source.id) : null;
    if (hit) {
      const now = Date.now();
      res.writeHead(hit.status, {
        ...hit.headers, 'x-hub-source': source.id, 'x-hub-cache': 'hit',
        'cache-control': `public, max-age=${Math.max(1, Math.ceil((hit.expires - now) / 1000))}`,
        'age': String(Math.max(0, Math.floor((now - hit.stored) / 1000))),
        'content-length': String(hit.body.length),
      });
      res.end(hit.body);
      return;
    }
    const cacheTag = cache.enabled ? 'miss' : 'off';

    // The page's own request headers go upstream: an app's API calls carry their tokens and
    // content types in them. What names the TV or the hub is replaced: the agent and referer are
    // the portal's, cookies are scoped below, and encoding, length and fetch metadata are the hub's.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP_REQUEST.has(k) || k.startsWith('sec-') || k.startsWith('x-hub-') || k.startsWith(':')) continue;
      headers[k] = v;
    }
    headers['user-agent'] = UA;
    headers['accept'] = req.headers['accept'] || '*/*';
    headers['accept-language'] = req.headers['accept-language'] || 'en';
    headers['referer'] = `${source.originUrl.origin}${source.originUrl.pathname}`;
    if (req.headers['origin']) headers['origin'] = source.originUrl.origin;
    // Cookies: only this source's own cookies, and only to the portal itself, never to third parties.
    if (firstParty && req.headers['cookie']) {
      const scoped = unscopeCookieHeader(req.headers['cookie'], source);
      if (scoped) headers['cookie'] = scoped;
    }

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) body = Readable.toWeb(req);

    let up;
    try {
      up = await fetch(upstream, { method: req.method, headers, body, redirect: 'manual', duplex: body ? 'half' : undefined });
    } catch (e) {
      log('upstream-error', upstream.href, e.message);
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`upstream error: ${e.message}`);
      return;
    }

    const out = {};
    for (const [k, v] of up.headers) {
      if (STRIP_RESPONSE.has(k) || k === 'set-cookie') continue;
      if (k === 'location') { out[k] = hubUrlFor(new URL(v, upstream).href, source); continue; }
      out[k] = v;
    }
    const cookies = firstParty ? (up.headers.getSetCookie?.() || []) : [];   // third parties set no cookies on the TV
    if (cookies.length) out['set-cookie'] = cookies.map((c) => scopeSetCookie(c, source));
    out['x-hub-source'] = source.id;
    out['x-hub-cache'] = cacheTag;

    const ctype = (up.headers.get('content-type') || '').toLowerCase();
    const isHtml = ctype.includes('text/html');
    // A page remembers its source for requests it makes without the hub prefix (never sent upstream).
    if (isHtml && firstParty) out['set-cookie'] = [...(out['set-cookie'] || []), `${SOURCE_COOKIE}=${encodeURIComponent(source.id)}; Path=/; SameSite=Lax`];
    const isCss = ctype.includes('text/css');
    const hls = !isHtml && isHls(ctype, upstream.href), dash = !isHtml && isDash(ctype, upstream.href);
    const declared = Number(up.headers.get('content-length'));
    const policy = looks && !isHtml && !hls && !dash
      ? cachePolicy({ method: req.method, reqHeaders: req.headers, status: up.status, resHeaders: up.headers, url: upstream.href, ctype, size: declared > 0 ? declared : undefined })
      : { ok: false, reason: 'kind' };
    // The TV's own browser may keep the file for the same lifetime; pages themselves never.
    if (policy.ok) out['cache-control'] = `public, max-age=${Math.ceil(policy.ttl / 1000)}`;
    /** Keep a finished body under the upstream URL (CSS under the source too, as its URLs are rewritten per source). */
    const keep = (body, perSource) => {
      if (!policy.ok) return;
      const headers = { ...out };
      delete headers['x-hub-source']; delete headers['x-hub-cache']; delete headers['set-cookie']; delete headers['cache-control'];
      cache.set(upstream.href, { status: up.status, headers, body, ttl: policy.ttl, sourceId: perSource ? source.id : undefined });
    };

    const isJs = !isHtml && /javascript|ecmascript/.test(ctype);
    if (isHtml || isCss || isJs || hls || dash) {
      const text = await up.text();
      const rewritten = isHtml ? rewriteHtml(text, source, upstream.href, req.hubShellOrigin)
        : isCss ? rewriteCssUrls(text, source, upstream.href)
        : isJs ? rewriteJsUrls(text, source)
        : hls ? rewriteM3u8(text, source, upstream.href)
        : rewriteMpd(text, source, upstream.href);
      out['content-type'] = hls ? 'application/vnd.apple.mpegurl' : dash ? 'application/dash+xml' : ctype;
      if (!policy.ok) out['cache-control'] = 'no-store';
      if (isCss || isJs) keep(Buffer.from(rewritten), true);       // rewritten per source
      if (isHtml) {
        // Everything the page loads must come from the hub origin (all URLs are rewritten to it, and
        // the content script rewrites script-made requests). Direct loads from any other host are refused.
        // Only the shell may frame portal pages; portal pages are on their own origin and cannot touch the shell.
        // 'self' too: a portal page may embed another hub page (a site's player lives in an iframe).
        const ancestors = req.hubShellOrigin ? `frame-ancestors ${req.hubShellOrigin} 'self'; ` : '';
        out['content-security-policy'] = `${ancestors}default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; frame-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'`;
      }
      res.writeHead(up.status, out);
      res.end(rewritten);
      return;
    }
    if (policy.ok && up.body && !(declared > cache.maxEntry)) {
      // Small enough to keep: read it whole, send it, remember it.
      let body;
      try { body = Buffer.from(await up.arrayBuffer()); } catch (e) { log('upstream-error', upstream.href, e.message); res.destroy(); return; }
      out['content-length'] = String(body.length);
      res.writeHead(up.status, out);
      res.end(body);
      keep(body, false);
      return;
    }
    res.writeHead(up.status, out);
    if (!up.body || req.method === 'HEAD') { res.end(); return; }
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  }

  /** Blocked third-party hosts for a source, most blocked first. */
  const blockedHosts = (sourceId) => blockedHostsFor(stats.blockedHosts, sourceId);
  /** Forget recorded blocks a new allow pattern now covers, so the Settings screen stops offering them. */
  const forgetBlocked = (sourceId, re) => { const m = stats.blockedHosts.get(sourceId); if (m) for (const h of [...m.keys()]) if (re.test(h)) m.delete(h); };

  return { handle, stats, cache, hubUrlFor, resolve, rewriteHtml, rewriteM3u8, rewriteMpd, blockedHosts, forgetBlocked };
}
