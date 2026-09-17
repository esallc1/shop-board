/* ============================================================
   gate.test.js — every service-role office endpoint REFUSES AN UNKNOWN CALLER
   BEFORE IT DOES ANYTHING (Security Phase 3).

   One table-driven suite over all six gated handlers, because the rule is the
   same rule and it should be stated once: no token / junk token / a valid
   session that is not an active employee → 401, with no Supabase write, no
   storage signing and no Anthropic call attempted. The stubbed fetch THROWS on
   anything except the auth check, so a regression that moves a gate below the
   work fails here instead of in production.

   Each endpoint's own *.test.js still covers its input parsing; this file only
   owns the gate.
   Run: npm test   (node --test)
   ============================================================ */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import announcement from '../announcement.js';
import changeRequest from '../change-request.js';
import deskAppointment from '../desk-appointment.js';
import recordingLinks from '../recording-links.js';
import recordingAssign from '../recording-assign.js';
import extractInvoice from '../extract-invoice.js';

const UID = '11111111-2222-4333-8444-555555555555';

// Bodies that WOULD be valid work if the caller were allowed through — so a
// 401 here proves the gate fired, not that the payload was rejected.
const ENDPOINTS = [
  { name: 'announcement',     handler: announcement,     body: { action: 'post', message: 'Shop closes at 3 today', style: 'info', posted_by_name: 'Cristian' } },
  { name: 'change-request',   handler: changeRequest,    body: { type: 'bug', body: 'Something is off on the RO board', submitted_by_name: 'Kevin' } },
  { name: 'desk-appointment', handler: deskAppointment,  body: { next_step: 'appointment', due_at: '2026-09-18T15:00:00Z', caller_bare: '2395550101' } },
  { name: 'recording-links',  handler: recordingLinks,   body: { call_ids: [1, 2, 3] } },
  { name: 'recording-assign', handler: recordingAssign,  body: { call_id: 1, vehicle_id: null } },
  { name: 'extract-invoice',  handler: extractInvoice,    body: { imageUrl: 'https://example.test/invoice.jpg' } },
];

function fakeRes() {
  const out = { statusCode: null, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return this; },
  };
}

let savedFetch, savedKeys, seen;
// Any call that is NOT the token check means the handler did real work.
function stubFetch(authAnswer) {
  return async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/auth/v1/user')) return authAnswer;
    if (u.includes('/rest/v1/employees')) return { ok: true, status: 200, json: async () => [] };
    throw new Error('WORK DONE FOR AN UNAUTHORIZED CALLER: ' + u);
  };
}
beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedKeys = { svc: process.env.SUPABASE_SERVICE_ROLE_KEY, anth: process.env.ANTHROPIC_API_KEY };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  seen = [];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of [['SUPABASE_SERVICE_ROLE_KEY', savedKeys.svc], ['ANTHROPIC_API_KEY', savedKeys.anth]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

for (const ep of ENDPOINTS) {
  test(`${ep.name}: no Authorization header → 401, nothing fetched`, async () => {
    globalThis.fetch = stubFetch({ ok: false, status: 401, json: async () => ({}) });
    const res = fakeRes();
    await ep.handler({ method: 'POST', headers: {}, body: ep.body }, res);
    assert.equal(res.out.statusCode, 401);
    assert.deepEqual(res.out.body, { error: 'unauthorized' });
    assert.deepEqual(seen, []);
  });

  test(`${ep.name}: junk bearer token → 401, only the token check ran`, async () => {
    globalThis.fetch = stubFetch({ ok: false, status: 401, json: async () => ({}) });
    const res = fakeRes();
    await ep.handler({ method: 'POST', headers: { authorization: 'Bearer junk.token.here' }, body: ep.body }, res);
    assert.equal(res.out.statusCode, 401);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /\/auth\/v1\/user$/);
  });

  test(`${ep.name}: valid session that is not an active employee → 401 (the KiKi case)`, async () => {
    globalThis.fetch = stubFetch({ ok: true, status: 200, json: async () => ({ id: UID }) });
    const res = fakeRes();
    await ep.handler({ method: 'POST', headers: { authorization: 'Bearer valid.kiki.token' }, body: ep.body }, res);
    assert.equal(res.out.statusCode, 401);
    assert.equal(seen.length, 2);                       // token check + roster read, then stop
    assert.match(seen[1], /\/rest\/v1\/employees\?/);
  });

  test(`${ep.name}: a non-POST is still refused by the method check first`, async () => {
    globalThis.fetch = stubFetch({ ok: false, status: 401, json: async () => ({}) });
    const res = fakeRes();
    await ep.handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.out.statusCode, 405);
    assert.deepEqual(seen, []);
  });
}

test('recording-links no longer answers an unauthenticated empty POST with 200', async () => {
  globalThis.fetch = stubFetch({ ok: false, status: 401, json: async () => ({}) });
  const res = fakeRes();
  await recordingLinks({ method: 'POST', headers: {}, body: {} }, res);
  assert.equal(res.out.statusCode, 401);               // was: 200 {results: []}
  assert.notDeepEqual(res.out.body, { results: [] });
});
