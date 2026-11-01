// Title normalisation. Adapters map raw provider records into CatalogItem; this
// module owns the cleaning pipeline and the matching key used for dedup.

import { createHash } from 'node:crypto';

const TOKEN_LIST = [
  '2160p', '1080p', '720p', '480p', '4k', 'uhd', 'hd', 'sd', 'hdr', 'hdr10', 'dv',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'ac3', 'dts', 'atmos',
  'web', 'webrip', 'web-dl', 'webdl', 'dl', 'bluray', 'blu-ray', 'brrip', 'bdrip', 'dvdrip', 'hdtv', 'cam', 'ts',
  'dub', 'dubbed', 'sub', 'subbed', 'multi', 'dual', 'eng', 'ita', 'fre', 'ger', 'spa', 'vostfr', 'proper', 'repack',
].sort((a, b) => b.length - a.length);   // longest first so "web-dl" wins over "web"
const RELEASE_TOKENS = new RegExp('(^|[\\s-])(' + TOKEN_LIST.map((t) => t.replace('-', '\\-')).join('|') + ')(?=$|[\\s-])', 'gi');
const ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'el', 'los', 'las', 'der', 'die', 'das', 'il', 'lo', 'gli']);

export function stripDiacritics(s) {
  return s.normalize('NFKC').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Extract SxxEyy / Season N / Episode N patterns. Returns {season, episode, rest}. */
export function parseEpisode(title) {
  let season, episode, rest = title;
  let m = rest.match(/\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})\b/i);
  if (m) { season = +m[1]; episode = +m[2]; rest = rest.replace(m[0], ' '); }
  else {
    m = rest.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (m) { season = +m[1]; episode = +m[2]; rest = rest.replace(m[0], ' '); }
  }
  m = rest.match(/\bseason\s*(\d{1,2})\b/i);
  if (m) { season = season ?? +m[1]; rest = rest.replace(m[0], ' '); }
  m = rest.match(/\bepisode\s*(\d{1,3})\b/i);
  if (m) { episode = episode ?? +m[1]; rest = rest.replace(m[0], ' '); }
  return { season, episode, rest };
}

/** Clean a raw provider title into display title + structured fields. */
export function cleanTitle(raw) {
  let s = stripDiacritics(String(raw || ''));
  let year;
  // 1. Trailing (year) or [year] is meaningful; every other bracket group is a tag.
  s = s.replace(/[([{]\s*((?:19|20)\d{2})\s*[)\]}]/g, (m, y) => { year = year ?? +y; return ' '; });
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ');
  // 2. Dot/underscore separators become spaces before any token matching.
  s = s.replace(/[._]+/g, ' ');
  // 3. Episode markers.
  const ep = parseEpisode(s);
  s = ep.rest;
  // 4. Release-style tokens, then dangling hyphens and whitespace.
  s = s.replace(RELEASE_TOKENS, ' ');
  s = s.replace(/(^|\s)-+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  // Bare trailing year ("Title 2019").
  const ty = s.match(/\s((?:19|20)\d{2})$/);
  if (ty && !year) { year = +ty[1]; s = s.slice(0, ty.index).trim(); }
  // Strip orphan trailing punctuation.
  s = s.replace(/[\s\-:|,]+$/g, '').replace(/^[\s\-:|,]+/g, '');
  s = s.replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: s, year, season: ep.season, episode: ep.episode };
}

/** Matching key: lowercase, no articles, no punctuation. */
export function titleKey(title) {
  const words = stripDiacritics(title).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.join(' ');
}

export function canonicalId(key, year, kind) {
  return createHash('sha1').update(`${kind}|${key}|${year ?? ''}`).digest('hex').slice(0, 16);
}

/** Jaro-Winkler similarity in [0,1]. */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length) && a[i] === b[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function inferKind(raw, parsed) {
  const k = String(raw || '').toLowerCase();
  if (/episode/.test(k) || parsed.episode != null) return 'episode';
  if (/series|show|tv/.test(k) || parsed.season != null) return 'series';
  return 'movie';
}

/** Turn a mapped raw record into a CatalogItem candidate. */
export function normaliseRecord(rec, sourceId) {
  const parsed = cleanTitle(rec.title);
  const year = rec.year ? Number(String(rec.year).slice(0, 4)) || undefined : parsed.year;
  const kind = inferKind(rec.kind, parsed);
  const key = titleKey(parsed.title);
  return {
    id: canonicalId(key, year, kind),
    kind,
    title: parsed.title,
    titleKey: key,
    rawTitle: String(rec.title || ''),
    year,
    season: parsed.season,
    episode: parsed.episode,
    artwork: rec.image ? [{ url: rec.image }] : [],
    sources: [{ sourceId, itemUrl: rec.url, seenAt: Date.now() }],
  };
}
