// Sources: loading and hot-reloading config/sources.json, and the writers the TV uses to change
// it from the couch (rules from the inspector; add, remove and allow-host from the Settings screen).

import { readFileSync, writeFileSync } from 'node:fs';

const RULE_DEFAULTS = { touch: false, css: [], removeOnMount: [], preserve: [], scrollRoot: null, player: 'video', dark: false };

function prepare(s) {
  if (!s.id || !s.origin) throw new Error(`source missing id/origin: ${JSON.stringify(s)}`);
  s.originUrl = new URL(s.origin);
  s.rules = Object.assign({}, RULE_DEFAULTS, s.rules || {});
  // Per-source exceptions to strict third-party blocking, e.g. the portal's CDN or API host,
  // plus the hosts that carry the site's own name (see ownHostPatterns).
  s.allowHostsRe = [...(s.allowHosts || []).map((p) => new RegExp(p, 'i')), ...ownHostPatterns(s.originUrl.hostname)];
  return s;
}

const OWN_TLDS = 'com|net|org|io|tv|co|cc|app|dev|cdn|direct|me|us|uk|ca|de|fr|es|it|nl|se|jp|in|au|nz|ch|at|be|co\\.uk|com\\.au|co\\.nz';

/** The name a site is known by: the first label of its site ("vimeo" for www.vimeo.com, "tubi" for
 *  tubitv.com, a trailing "tv" dropped). Null for short names and address literals. */
export function brandOf(host) {
  const site = siteOf(host);
  const label = site.split('.')[0];
  if (!/^[a-z][a-z0-9]*$/.test(label)) return null;
  const stem = label.length > 5 && label.endsWith('tv') ? label.slice(0, -2) : label;
  return stem.length >= 4 ? stem : null;
}

/** A site's own hosts, allowed without being listed: the site itself, and a sibling site whose name
 *  starts with the site's name (vimeo.com loads its app from vimeocdn.com, tubitv.com from tubi.io).
 *  Ad and tracking hosts rarely carry the site's name, so this lifts strict blocking only where the
 *  site's own code lives. Only letters and digits may follow the name, so vimeo-ads.example is out. */
export function ownHostPatterns(host) {
  const out = [new RegExp(hostPattern(siteOf(host)), 'i')];
  const brand = brandOf(host);
  if (brand) out.push(new RegExp(`(^|\\.)${brand}[a-z0-9]*\\.(${OWN_TLDS})$`, 'i'));
  return out;
}

export function loadSources(path) {
  const byId = new Map();
  for (const s of JSON.parse(readFileSync(path, 'utf8'))) byId.set(s.id, prepare(s));
  return byId;
}

/** Reload into an existing Map so every holder (proxy, scheduler) sees the new set. Returns {added, removed}. */
export function reloadSources(path, into) {
  const fresh = loadSources(path);
  const added = [...fresh.keys()].filter((id) => !into.has(id));
  const removed = [...into.keys()].filter((id) => !fresh.has(id));
  into.clear();
  for (const [id, s] of fresh) into.set(id, s);
  return { added, removed };
}

const readList = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeList = (path, list) => writeFileSync(path, JSON.stringify(list, null, 2) + '\n');

/** Merge a rules patch ({css:[..], removeOnMount:[..], preserve:[..], scrollRoot, player, touch}) into the file on disk. */
export function patchSourceRules(path, sourceId, patch) {
  const list = readList(path);
  const s = list.find((x) => x.id === sourceId);
  if (!s) throw new Error(`unknown source ${sourceId}`);
  s.rules = s.rules || {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in RULE_DEFAULTS)) continue;
    if (Array.isArray(RULE_DEFAULTS[k])) {
      const add = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.trim());
      s.rules[k] = [...new Set([...(s.rules[k] || []), ...add])];
    } else s.rules[k] = v;
  }
  writeList(path, list);
  return s.rules;
}

/** A short id from a name: letters, digits and dashes, made unique among the ids already in use. */
export function sourceIdFor(name, existing = new Set()) {
  const base = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'source';
  let id = base, n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

const isIpLiteral = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** The site a host belongs to, for an allow pattern: its last two labels, or three under a
 *  two-part public suffix such as co.uk or com.au. An address literal is itself. */
export function siteOf(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || isIpLiteral(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const second = labels[labels.length - 2], tld = labels[labels.length - 1];
  const twoPart = tld.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|nom|web)$/.test(second);
  return labels.slice(twoPart ? -3 : -2).join('.');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The allowHosts pattern for a site: the site itself and every host under it. */
export function hostPattern(site) {
  return isIpLiteral(site) ? `^${escapeRe(site)}$` : `(^|\\.)${escapeRe(site)}$`;
}

/** Turn an address typed on the TV ("tubitv.com", "https://pluto.tv/us/on-demand") into {origin, home}. */
export function parseAddress(text) {
  let s = String(text || '').trim();
  if (!s) throw new Error('The address is empty.');
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That is not a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The address must start with http:// or https://.');
  if (!u.hostname) throw new Error('That is not a web address.');
  return { origin: u.origin, home: `${u.pathname || '/'}${u.search}` };
}

/** Add a source from a name and an address. The site's own hosts are allowed from the start,
 *  since nearly every site loads its app from a sibling host (static.example.com, api.example.com). */
export function addSource(path, { name, address, allowHosts } = {}) {
  const list = readList(path);
  name = String(name || '').trim();
  if (!name) throw new Error('The name is empty.');
  const { origin, home } = parseAddress(address);
  const site = siteOf(new URL(origin).hostname);
  const entry = { id: sourceIdFor(name, new Set(list.map((x) => x.id))), name, origin, home, allowHosts: [hostPattern(site)] };
  for (const p of allowHosts || []) if (typeof p === 'string' && p.trim() && !entry.allowHosts.includes(p)) entry.allowHosts.push(p);
  list.push(entry);
  writeList(path, list);
  return entry;
}

/** Remove a source from the file. Returns the removed entry. */
export function removeSource(path, sourceId) {
  const list = readList(path);
  const i = list.findIndex((x) => x.id === sourceId);
  if (i < 0) throw new Error(`unknown source ${sourceId}`);
  const [removed] = list.splice(i, 1);
  writeList(path, list);
  return removed;
}

/** Allow a blocked host for a source: the whole site the host belongs to is added to its allowHosts.
 *  Returns {site, pattern, added}; added is false when the pattern was already there. */
export function allowHost(path, sourceId, host) {
  const site = siteOf(host);
  if (!site || !/^[a-z0-9.:\-\[\]]+$/i.test(site)) throw new Error('That is not a host name.');
  const list = readList(path);
  const s = list.find((x) => x.id === sourceId);
  if (!s) throw new Error(`unknown source ${sourceId}`);
  const pattern = hostPattern(site);
  s.allowHosts = s.allowHosts || [];
  const added = !s.allowHosts.includes(pattern);
  if (added) { s.allowHosts.push(pattern); writeList(path, list); }
  return { site, pattern, added };
}

/** Store (or clear, with null) the feed block the finder worked out for a source, and how often to pull it. */
export function setSourceFeed(path, sourceId, feed, { intervalSec } = {}) {
  const list = readList(path);
  const s = list.find((x) => x.id === sourceId);
  if (!s) throw new Error(`unknown source ${sourceId}`);
  if (feed) s.feed = feed; else delete s.feed;
  if (feed && intervalSec) s.intervalSec = intervalSec;
  writeList(path, list);
  return s;
}
