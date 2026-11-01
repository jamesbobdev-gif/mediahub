// Rewriting reverse proxy. Every portal page is served from the hub's own origin
// under /p/<sourceId>/<path>, and cross-origin assets under /x/<sourceId>/<encoded-url>.
// That single-origin topology is what lets the shell read the portal DOM
// directly and lets us answer noise requests with placeholders on every TV OS,
// not only where a native request hook exists (Android's shouldInterceptRequest).

import { Readable } from 'node:stream';
import { classify, destinationFor, placeholderFor } from './filters.js';

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];
const STRIP_RESPONSE = new Set([
  ...HOP_BY_HOP, 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'content-length', 'content-encoding', 'strict-transport-security',
]);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 MediaHub/0.1';

export function createProxy({ sources, filters, log = () => {} }) {
  const stats = { requests: 0, blocked: 0, byReason: new Map() };

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

  function rewriteCssUrls(text, source, pageUrl) {
    return text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, val) => {
      if (/^(data|blob):/i.test(val) || val.startsWith('#')) return m;
      try { return `url(${q}${hubUrlFor(new URL(val, pageUrl).href, source)}${q})`; } catch { return m; }
    });
  }

  function rewriteHtml(html, source, pageUrl) {
    const rules = source.rules;
    const attr = /(\s(?:src|href|action|poster|data-src|data-lazy-src))=(["'])([^"']*)\2/gi;
    html = html.replace(attr, (m, name, q, val) => {
      if (!val || val.startsWith('#') || /^(javascript|data|blob|mailto):/i.test(val)) return m;
      let abs;
      try { abs = new URL(val, pageUrl).href; } catch { return m; }
      return `${name}=${q}${hubUrlFor(abs, source)}${q}`;
    });
    html = html.replace(/(\ssrcset=)(["'])([^"']*)\2/gi, (m, name, q, val) => {
      const out = val.split(',').map((part) => {
        const [u, d] = part.trim().split(/\s+/);
        try { return [hubUrlFor(new URL(u, pageUrl).href, source), d].filter(Boolean).join(' '); } catch { return part; }
      }).join(', ');
      return `${name}${q}${out}${q}`;
    });
    html = rewriteCssUrls(html, source, pageUrl);
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
      `<script>window.__HUB_RULES=${JSON.stringify({ sourceId: source.id, ...rules })};window.__HUB_ORIGIN=${JSON.stringify(source.originUrl.origin)};</script>`,
      '<script src="/shell/inject/content.js"></script>',
      '<link rel="stylesheet" href="/shell/inject/content.css">',
      rules.css.length ? `<style id="hub-source-css">${rules.css.join(',\n')}{display:none !important}</style>` : '',
    ].join('\n');
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
    else html = head + html;
    return html;
  }

  function record(result) {
    stats.requests++;
    if (result.block) {
      stats.blocked++;
      stats.byReason.set(result.reason, (stats.byReason.get(result.reason) || 0) + 1);
    }
  }

  /** Resolve a hub request path to {source, upstream, firstParty} or null. */
  function resolve(req) {
    const url = new URL(req.url, 'http://hub');
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
      return { source, upstream, firstParty: upstream.origin === source.originUrl.origin };
    }
    return null;
  }

  async function handle(req, res) {
    const r = resolve(req);
    if (!r) { res.writeHead(404).end('unknown source'); return; }
    const { source, upstream, firstParty } = r;
    const destination = destinationFor(req.headers, upstream.href);
    const verdict = classify(filters, upstream.href, { destination, firstParty });
    record(verdict);
    if (verdict.block) {
      const ph = placeholderFor(destination);
      log('blocked', destination, verdict.reason, upstream.href);
      res.writeHead(ph.status, { 'content-type': ph.type, 'cache-control': 'public, max-age=3600', 'x-hub-blocked': verdict.reason });
      res.end(ph.body);
      return;
    }

    const headers = {
      'user-agent': UA,
      'accept': req.headers['accept'] || '*/*',
      'accept-language': req.headers['accept-language'] || 'en',
      'referer': `${source.originUrl.origin}${source.originUrl.pathname}`,
    };
    for (const h of ['range', 'cookie', 'content-type', 'if-none-match', 'if-modified-since']) {
      if (req.headers[h]) headers[h] = req.headers[h];
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
    const cookies = up.headers.getSetCookie?.() || [];
    if (cookies.length) {
      out['set-cookie'] = cookies.map((c) => c.replace(/;\s*domain=[^;]*/i, '').replace(/;\s*secure/i, '').replace(/;\s*samesite=none/i, ''));
    }
    out['x-hub-source'] = source.id;

    const ctype = (up.headers.get('content-type') || '').toLowerCase();
    const isHtml = ctype.includes('text/html');
    const isCss = ctype.includes('text/css');
    if (isHtml || isCss) {
      const text = await up.text();
      const rewritten = isHtml ? rewriteHtml(text, source, upstream.href) : rewriteCssUrls(text, source, upstream.href);
      out['content-type'] = ctype;
      out['cache-control'] = 'no-store';
      if (isHtml) {
        // Everything the page loads must come from the hub origin (all URLs are rewritten to it, and
        // the content script rewrites script-made requests). Direct loads from any other host are refused.
        out['content-security-policy'] = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; frame-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'";
      }
      res.writeHead(up.status, out);
      res.end(rewritten);
      return;
    }
    res.writeHead(up.status, out);
    if (!up.body || req.method === 'HEAD') { res.end(); return; }
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  }

  return { handle, stats, hubUrlFor, rewriteHtml };
}
