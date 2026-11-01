// Client allowlist. The hub has no login, so on a shared network this is the way to make sure only
// the TV (and the machine running the hub) can browse through it or change its rules.

import { readFileSync } from 'node:fs';

export function loadAccess(path) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  return { allowClients: (raw.allowClients || []).map(String).map(normaliseIp).filter(Boolean) };
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

/** True when the remote address may use the hub. */
export function clientAllowed(access, remoteAddress) {
  if (isLoopback(remoteAddress)) return true;
  if (!access.allowClients.length) return true;
  const ip = normaliseIp(remoteAddress);
  return access.allowClients.some((a) => a === ip || (a.endsWith('.') && ip.startsWith(a)) || (a.endsWith('*') && ip.startsWith(a.slice(0, -1))));
}
