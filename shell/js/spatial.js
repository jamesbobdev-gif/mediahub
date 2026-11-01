// Spatial navigation: pick the best candidate in a direction from the current
// focus rect. Score = primary-axis distance + off-axis penalty, with a bonus for
// overlap along the secondary axis (prefer the tile directly below over one
// slightly closer but diagonal).

export function pickNext(current, candidates, dir) {
  if (!current) return nearestToOrigin(candidates);
  const cx = current.x + current.w / 2, cy = current.y + current.h / 2;
  let best = null, bestScore = Infinity;
  for (const c of candidates) {
    if (c.el === current.el) continue;
    const ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
    let primary, secondary, overlap;
    switch (dir) {
      case 'up':    primary = cy - ccy; secondary = Math.abs(ccx - cx); overlap = overlap1d(current.x, current.w, c.x, c.w); if (c.y + c.h > current.y + 1) continue; break;
      case 'down':  primary = ccy - cy; secondary = Math.abs(ccx - cx); overlap = overlap1d(current.x, current.w, c.x, c.w); if (c.y < current.y + current.h - 1) continue; break;
      case 'left':  primary = cx - ccx; secondary = Math.abs(ccy - cy); overlap = overlap1d(current.y, current.h, c.y, c.h); if (c.x + c.w > current.x + 1) continue; break;
      case 'right': primary = ccx - cx; secondary = Math.abs(ccy - cy); overlap = overlap1d(current.y, current.h, c.y, c.h); if (c.x < current.x + current.w - 1) continue; break;
      default: continue;
    }
    if (primary <= 0) continue;
    const score = primary + secondary * 2 - overlap * 0.5;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function overlap1d(a, aw, b, bw) {
  return Math.max(0, Math.min(a + aw, b + bw) - Math.max(a, b));
}

export function nearestToOrigin(candidates) {
  let best = null, d = Infinity;
  for (const c of candidates) {
    if (c.y < 0) continue;
    const dist = Math.hypot(c.x, c.y);
    if (dist < d) { d = dist; best = c; }
  }
  return best || candidates[0] || null;
}

/** Find the candidate whose element matches, after rects were recomputed. */
export function refind(candidates, el) {
  return candidates.find((c) => c.el === el) || null;
}
