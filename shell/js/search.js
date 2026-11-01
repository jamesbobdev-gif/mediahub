// Local catalog search. Runs on every key press against the IndexedDB mirror, so
// results are instant. Ranking: title prefix > word prefix > substring > fuzzy
// (Jaro-Winkler on the whole title, for D-pad typos like "harbor").

export const KEY_ROWS = [
  '1 2 3 4 5 6 7 8 9 0'.split(' '),
  'q w e r t y u i o p'.split(' '),
  'a s d f g h j k l'.split(' '),
  'z x c v b n m'.split(' '),
  ['space', 'back', 'clear'],
];

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function search(items, query, { limit = 24 } = {}) {
  const q = norm(query);
  if (!q) return [];
  const scored = [];
  for (const it of items) {
    const t = it._n ?? (it._n = norm(it.title));
    let score = 0;
    if (t.startsWith(q)) score = 100;
    else if (t.split(' ').some((w) => w.startsWith(q))) score = 80;
    else if (t.includes(q)) score = 60;
    else if (q.length >= 3) {
      const jw = Math.max(jaroWinkler(q, t), ...t.split(' ').map((w) => jaroWinkler(q, w)));
      if (jw >= 0.85) score = 40 * jw;
    }
    if (!score) continue;
    score -= Math.min(10, Math.abs(t.length - q.length) / 10);   // shorter titles first on ties
    scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || a.it.title.localeCompare(b.it.title));
  return scored.slice(0, limit).map((s) => s.it);
}

export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; matches++; break; }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) { if (!am[i]) continue; while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length) && a[i] === b[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}
