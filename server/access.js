// Client allowlist. The hub has no login, so on a shared network this is the way to make sure only
// the TV (and the machine running the hub) can browse through it or change its rules.

import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

export function loadAccess(path) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  return {
    allowClients: (raw.allowClients || []).map(String).map(normaliseIp).filter(Boolean),
    // controlToken: the word a controller (a local model, a script) must send to drive the TVs
    // (server/tv.js, docs/CONTROL.md). Empty: only the hub machine itself may.
    controlToken: String(raw.controlToken || '').trim(),
  };
}

export function normaliseIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);           // IPv4 mapped in an IPv6 socket
  return s;
}

export function isLoopback(ip) {
  const s = normaliseIp(ip);
  return s === '127.0.0.1' || s === '::1' || s.startsWith('127.');
}

/** True when a request may drive the TVs: the control token when one is set, else only the hub machine. */
export function controlAllowed(access, { header = '', query = '', ip = '' } = {}) {
  const token = access.controlToken || '';
  if (!token) return isLoopback(ip);
  const sent = String(header || '').replace(/^Bearer\s+/i, '').trim() || String(query || '').trim();
  if (!sent || sent.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(token));
}

/** True when the remote address may use the hub. */
export function clientAllowed(access, remoteAddress) {
  if (isLoopback(remoteAddress)) return true;
  if (!access.allowClients.length) return true;
  const ip = normaliseIp(remoteAddress);
  return access.allowClients.some((a) => a === ip || (a.endsWith('.') && ip.startsWith(a)) || (a.endsWith('*') && ip.startsWith(a.slice(0, -1))));
}
