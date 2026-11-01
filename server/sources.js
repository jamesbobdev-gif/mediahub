import { readFileSync, writeFileSync } from 'node:fs';

const RULE_DEFAULTS = { touch: false, css: [], removeOnMount: [], preserve: [], scrollRoot: null, player: 'video' };

function prepare(s) {
  if (!s.id || !s.origin) throw new Error(`source missing id/origin: ${JSON.stringify(s)}`);
  s.originUrl = new URL(s.origin);
  s.rules = Object.assign({}, RULE_DEFAULTS, s.rules || {});
  // Per-source exceptions to strict third-party blocking, e.g. the portal's CDN or API host.
  s.allowHostsRe = (s.allowHosts || []).map((p) => new RegExp(p, 'i'));
  return s;
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

/** Merge a rules patch ({css:[..], removeOnMount:[..], preserve:[..], scrollRoot, player, touch}) into the file on disk. */
export function patchSourceRules(path, sourceId, patch) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
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
  writeFileSync(path, JSON.stringify(list, null, 2) + '\n');
  return s.rules;
}
