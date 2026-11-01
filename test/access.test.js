import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAllowed } from '../server/access.js';

test('empty allowlist admits everyone; loopback is always admitted', () => {
  assert.ok(clientAllowed({ allowClients: [] }, '192.168.1.77'));
  assert.ok(clientAllowed({ allowClients: ['192.168.1.50'] }, '127.0.0.1'));
  assert.ok(clientAllowed({ allowClients: ['192.168.1.50'] }, '::1'));
  assert.ok(clientAllowed({ allowClients: ['192.168.1.50'] }, '::ffff:127.0.0.1'));
});

test('allowlist admits listed addresses only, including IPv4-mapped sockets and prefixes', () => {
  const a = { allowClients: ['192.168.1.50', '10.0.0.'] };
  assert.ok(clientAllowed(a, '192.168.1.50'));
  assert.ok(clientAllowed(a, '::ffff:192.168.1.50'));
  assert.ok(clientAllowed(a, '10.0.0.9'));
  assert.equal(clientAllowed(a, '192.168.1.51'), false);
  assert.equal(clientAllowed(a, '10.0.1.9'), false);
});
