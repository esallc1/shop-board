/* ============================================================
   extract-invoice.test.js — the endpoint REFUSES BEFORE IT SPENDS.

   The money rule: an unauthenticated (or badly authenticated) caller must get
   a 401 without the handler ever fetching the image or calling Anthropic. The
   stubbed global fetch THROWS on any Anthropic URL, so a regression that moves
   the gate below the model call fails loudly here instead of on the invoice.
   Run: npm test   (node --test)
   ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from './extract-invoice.js';

function fakeRes() {
  const out = { statusCode: null, body: null };
  return {
    out,
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return this; },
  };
}
const post = (headers = {}) => ({ method: 'POST', headers, body: { imageUrl: 'https://example.test/invoice.jpg' } });

let savedFetch, savedKey, savedAnthropic, seen;
beforeEach(() => {
  savedFetch = globalThis.fetch; savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY; savedAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('anthropic.com')) throw new Error('SPENT MONEY: Anthropic was called for an unauthorized request');
    if (u.includes('example.test')) throw new Error('FETCHED THE IMAGE for an unauthorized request');
    if (u.includes('/auth/v1/user')) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [] };
  };
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedAnthropic;
});

test('no Authorization header → 401, nothing fetched at all', async () => {
  const res = fakeRes();
  await handler(post(), res);
  assert.equal(res.out.statusCode, 401);
  assert.deepEqual(res.out.body, { error: 'unauthorized' });
  assert.deepEqual(seen, []);
});

test('junk bearer token → 401, and Anthropic is never reached', async () => {
  const res = fakeRes();
  await handler(post({ authorization: 'Bearer junk.token.here' }), res);
  assert.equal(res.out.statusCode, 401);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\/auth\/v1\/user$/);
});

test('a valid session that is not an active employee → 401 before any spend', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('anthropic.com') || u.includes('example.test')) throw new Error('SPENT MONEY');
    if (u.includes('/auth/v1/user')) return { ok: true, status: 200, json: async () => ({ id: '11111111-2222-4333-8444-555555555555' }) };
    return { ok: true, status: 200, json: async () => [] };     // no employee row
  };
  const res = fakeRes();
  await handler(post({ authorization: 'Bearer valid.kiki.token' }), res);
  assert.equal(res.out.statusCode, 401);
  assert.equal(seen.length, 2);
});

test('the method check still runs first', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.statusCode, 405);
  assert.deepEqual(seen, []);
});

test('the gate sits ABOVE input validation — no payload shape is leaked', async () => {
  const res = fakeRes();
  await handler({ method: 'POST', headers: {}, body: {} }, res);   // missing imageUrl
  assert.equal(res.out.statusCode, 401);                           // not 400
});
