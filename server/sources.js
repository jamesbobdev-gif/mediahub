import { readFileSync } from 'node:fs';

export function loadSources(path) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
  const byId = new Map();
  for (const s of list) {
    if (!s.id || !s.origin) throw new Error(`source missing id/origin: ${JSON.stringify(s)}`);
    s.originUrl = new URL(s.origin);
    s.rules = Object.assign({ touch: false, css: [], removeOnMount: [], preserve: [], scrollRoot: null, player: 'video' }, s.rules || {});
    byId.set(s.id, s);
  }
  return byId;
}
