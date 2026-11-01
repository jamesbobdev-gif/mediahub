// Request classifier. Decides whether an outbound request from a portal page is
// "noise" (ad, tracker, popup network) and, if so, what neutral placeholder to
// answer with. Hard-blocking (connection refused / 4xx) tends to trip a portal's
// error branch; a well-formed empty response of the expected type does not.

import { readFileSync } from 'node:fs';

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export function loadFilters(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return compileFilters(raw);
}

export function compileFilters(raw) {
  return {
    hosts: (raw.hosts || []).map((p) => new RegExp(p, 'i')),
    paths: (raw.paths || []).map((p) => new RegExp(p, 'i')),
    adSizes: new Set((raw.adSizes || []).map(([w, h]) => `${w}x${h}`)),
    // Strict mode: third-party scripts, frames and data calls are blocked unless the host is allowed.
    strict: raw.strict !== false,
    allowHosts: (raw.allowHosts || []).map((p) => new RegExp(p, 'i')),
  };
}

const STRICT_DESTINATIONS = new Set(['script', 'iframe', 'xhr', 'other', 'document']);

// destination: 'document' | 'script' | 'style' | 'image' | 'iframe' | 'xhr' | 'media' | 'font' | 'other'
export function destinationFor(headers, url) {
  const dest = (headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest && dest !== 'empty') return dest;
  const accept = (headers['accept'] || '').toLowerCase();
  if (accept.includes('text/html')) return 'document';
  if (accept.startsWith('image/')) return 'image';
  if (accept.includes('text/css')) return 'style';
  if (accept.includes('javascript')) return 'script';
  const ext = (new URL(url).pathname.split('.').pop() || '').toLowerCase();
  if (['js', 'mjs'].includes(ext)) return 'script';
  if (['css'].includes(ext)) return 'style';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'm3u8', 'ts', 'mp3', 'm4s'].includes(ext)) return 'media';
  if (['woff', 'woff2', 'ttf'].includes(ext)) return 'font';
  if (dest === 'empty') return 'xhr';
  return 'other';
}

/**
 * @returns {{block: boolean, reason?: string, destination: string}}
 */
export function classify(filters, url, { destination = 'other', firstParty = true, allowHosts = [] } = {}) {
  let u;
  try { u = new URL(url); } catch { return { block: false, destination }; }
  const host = u.hostname;
  const full = u.pathname + u.search;

  for (const re of filters.hosts) if (re.test(host)) return { block: true, reason: `host:${re.source}`, destination };
  for (const re of filters.paths) if (re.test(full)) return { block: true, reason: `path:${re.source}`, destination };

  // Strict mode: code and data from any other domain is blocked unless that domain is allowed for
  // this source (its CDN, its API). Images, media, fonts and stylesheets from CDNs stay allowed.
  if (!firstParty && STRICT_DESTINATIONS.has(destination)) {
    const allowed = [...(filters.allowHosts || []), ...allowHosts].some((re) => re.test(host));
    if (filters.strict && !allowed) return { block: true, reason: `third-party-${destination}:${host}`, destination };
    if (destination === 'iframe' && !allowed) return { block: true, reason: 'third-party-iframe', destination };
  }
  const w = u.searchParams.get('w') || u.searchParams.get('width');
  const h = u.searchParams.get('h') || u.searchParams.get('height');
  if (w && h && filters.adSizes.has(`${w}x${h}`)) return { block: true, reason: `ad-size:${w}x${h}`, destination };
  const sizeInPath = full.match(/(\d{3,4})x(\d{2,4})/);
  if (sizeInPath && filters.adSizes.has(`${sizeInPath[1]}x${sizeInPath[2]}`)) {
    return { block: true, reason: `ad-size:${sizeInPath[0]}`, destination };
  }
  return { block: false, destination };
}

/** Neutral placeholder response for a blocked request of a given destination. */
export function placeholderFor(destination) {
  switch (destination) {
    case 'script':
      return { status: 200, type: 'application/javascript; charset=utf-8', body: '/* hub: neutralised */\n' };
    case 'style':
      return { status: 200, type: 'text/css; charset=utf-8', body: '/* hub: neutralised */\n' };
    case 'image':
      return { status: 200, type: 'image/png', body: TRANSPARENT_PNG };
    case 'iframe':
    case 'document':
      return { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' };
    case 'xhr':
    case 'other':
    default:
      return { status: 204, type: 'text/plain', body: '' };
  }
}
