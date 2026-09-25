/* ============================================================
   calls.test.js — api/calls.js (security slice 3, step (a)1: the tray call
   card's writers). Run: npm test   (node --test)

   The real requireUser runs against a stubbed global fetch that plays Supabase
   Auth and PostgREST, with an in-memory `calls` table that honours the
   `…=is.null` guards the endpoint puts on its PATCHes. Locks:
     • 401 with no token, a junk token, a KiKi-style user (valid session, NO
       employees row) and an inactive employee — and no call is read;
     • 405 / 400: a wrong method, an unknown action, a bad call id, any key or
       field outside the action's own list (noted_by_name, resolved_at, …);
     • note: writes only the fields sent; noted_at + noted_by_name are stamped by
       the SERVER for the signed-in employee, ONCE (a later save never moves it);
       a person picking the RO clears the robot's run tags; the single-match
       customer only goes into an EMPTY customer_id;
     • customer: only customer_id, no noted stamp; an unknown customer is 404;
     • auto_file_ro: exactly one open RO → filed, conditional on ro_id being empty
       IN THE WRITE; 2 open / already filed / lost the race → nothing written;
     • repair_orders and customers are only ever READ.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { parseBody, NOTE_FIELDS, MAX_NOTE } from './calls.js';
import { AUTO_ATTACH_LIVE_RUN_ID } from '../shared/call-auto-attach.js';

const EMP = { id: '44444444-4444-4444-8444-444444444444', name: 'ZZ Test Advisor', role: 'advisor' };
const CUST = '11111111-1111-4111-8111-111111111111';
const CUST2 = '22222222-2222-4222-8222-222222222222';
const RO1 = '33333333-3333-4333-8333-333333333333';
const RO2 = '55555555-5555-4555-8555-555555555555';
const NOPE = '99999999-9999-4999-8999-999999999999';

function world(rows = {}, ros = []) {
  const w = { reads: [], writes: [], calls: {} };
  for (const [id, r] of Object.entries(rows)) w.calls[id] = { id: Number(id), customer_id: null, ro_id: null, note: null, next_step: null,
    due_at: null, due_all_day: true, dropoff_key_box: false, noted_at: null, noted_by_name: null, started_at: '2026-09-25T14:00:00Z',
    auto_attached_at: null, auto_ro_filed_at: null, auto_attach_run_id: null, ...r };
  const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  w.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.endsWith('/auth/v1/user')) {
      const auth = opts.headers && opts.headers.Authorization;
      if (auth === 'Bearer staff-token') return json(200, { id: 'uid-staff' });
      if (auth === 'Bearer kiki-token') return json(200, { id: 'uid-kiki' });
      if (auth === 'Bearer inactive-token') return json(200, { id: 'uid-inactive' });
      return json(401, { msg: 'invalid JWT' });
    }
    if (url.includes('/rest/v1/employees?')) {
      if (url.includes('auth_user_id=eq.uid-staff') && url.includes('active=is.true')) return json(200, [EMP]);
      return json(200, []);
    }
    const q = new URL(url).searchParams;
    if (url.includes('/rest/v1/customers?')) {
      if (method !== 'GET') { w.writes.push({ url, method }); return json(500, {}); }
      w.reads.push(url);
      const id = (q.get('id') || '').replace(/^eq\./, '');
      return json(200, [CUST, CUST2].includes(id) ? [{ id }] : []);
    }
    if (url.includes('/rest/v1/repair_orders?')) {
      if (method !== 'GET') { w.writes.push({ url, method }); return json(500, {}); }
      w.reads.push(url);
      if (q.get('id')) { const id = q.get('id').replace(/^eq\./, ''); return json(200, ros.some((r) => r.id === id) || id === RO1 ? [{ id }] : []); }
      const cid = (q.get('customer_id') || '').replace(/^eq\./, '');
      return json(200, ros.filter((r) => r.customer_id === cid));
    }
    if (url.includes('/rest/v1/calls?')) {
      const id = (q.get('id') || '').replace(/^eq\./, '');
      const row = w.calls[id];
      if (method === 'GET') { w.reads.push(url); return json(200, row ? [{ ...row }] : []); }
      const body = JSON.parse(opts.body);
      w.writes.push({ url, method, body, table: 'calls' });
      // Honour the guards the endpoint puts on the write.
      for (const col of ['noted_at', 'customer_id', 'ro_id']) {
        if (q.get(col) === 'is.null' && row && row[col] != null) return json(200, []);
      }
      if (!row) return json(200, []);
      if (w.raceRoBeforeWrite && 'ro_id' in body && q.get('ro_id') === 'is.null') { row.ro_id = RO2; return json(200, []); }
      Object.assign(row, body);
      return json(200, [{ ...row }]);
    }
    throw new Error('unexpected fetch ' + url);
  };
  return w;
}

function mockRes() {
  return { statusCode: null, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function call(body, { token = 'staff-token', w = world({ 7: {} }), method = 'POST' } = {}) {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  const savedConsole = { error: console.error, warn: console.warn };
  Object.assign(process.env, { SUPABASE_URL: 'https://sandbox.example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' });
  globalThis.fetch = w.fetch;
  console.error = () => {}; console.warn = () => {};
  const res = mockRes();
  try {
    await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  } finally {
    globalThis.fetch = savedFetch;
    Object.assign(console, savedConsole);
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { res, w };
}

/* ── the gate ─────────────────────────────────────────────────────────── */

test('401 without a signed-in ACTIVE employee — no token, junk, a KiKi login, an inactive employee — and no call is read', async () => {
  for (const token of [null, 'junk', 'kiki-token', 'inactive-token']) {
    const w = world({ 7: {} });
    const { res } = await call({ action: 'note', call_id: 7, fields: { note: 'x' } }, { token, w });
    assert.equal(res.statusCode, 401, String(token));
    assert.deepEqual(res.body, { error: 'unauthorized' });
    assert.equal(w.reads.length + w.writes.length, 0, 'nothing touched');
  }
});

test('405 on GET; 400 on an unknown action, a bad call id, and any key or field outside the action\'s own list', async () => {
  assert.equal((await call({}, { method: 'GET' })).res.statusCode, 405);
  const bad = [
    { action: 'resolve', call_id: 7 },
    { action: 'note', call_id: 'x', fields: { note: 'a' } },
    { action: 'note', call_id: -1, fields: { note: 'a' } },
    { action: 'note', call_id: 7, fields: {} },
    { action: 'note', call_id: 7, fields: { noted_by_name: 'Me' } },
    { action: 'note', call_id: 7, fields: { noted_at: '2020-01-01T00:00:00Z' } },
    { action: 'note', call_id: 7, fields: { resolved_at: '2020-01-01T00:00:00Z' } },
    { action: 'note', call_id: 7, fields: { customer_id: CUST } },
    { action: 'note', call_id: 7, fields: { auto_attach_run_id: null } },
    { action: 'note', call_id: 7, fields: { next_step: 'teleport' } },
    { action: 'note', call_id: 7, fields: { due_at: 'tomorrowish' } },
    { action: 'note', call_id: 7, fields: { due_all_day: 'yes' } },
    { action: 'note', call_id: 7, fields: { ro_id: 'not-a-uuid' } },
    { action: 'note', call_id: 7, fields: { note: 'x'.repeat(MAX_NOTE + 1) } },
    { action: 'note', call_id: 7, fields: { note: 'a' }, noted_by_name: 'Me' },
    { action: 'note', call_id: 7, fields: { note: 'a' }, fold_customer_id: 'nope' },
    { action: 'customer', call_id: 7, customer_id: 'nope' },
    { action: 'customer', call_id: 7, customer_id: CUST, resolved_at: 'x' },
    { action: 'auto_file_ro', call_id: 7, ro_id: RO1 },
  ];
  for (const b of bad) {
    const w = world({ 7: {} });
    const { res } = await call(b, { w });
    assert.equal(res.statusCode, 400, JSON.stringify(b).slice(0, 80));
    assert.equal(w.writes.length, 0);
  }
  assert.deepEqual(NOTE_FIELDS, ['note', 'next_step', 'due_at', 'due_all_day', 'ro_id', 'dropoff_key_box']);
  assert.equal(parseBody({ action: 'note', call_id: 7, fields: { note: null, next_step: null, due_at: null } }).ok, true, 'clearing is allowed');
});

test('404 for a call that does not exist', async () => {
  const { res, w } = await call({ action: 'note', call_id: 8, fields: { note: 'a' } });
  assert.equal(res.statusCode, 404);
  assert.equal(w.writes.length, 0);
});

/* ── note ─────────────────────────────────────────────────────────────── */

test('note: writes only the fields sent; the SERVER stamps noted_at + noted_by_name for the signed-in employee — ONCE', async () => {
  const w = world({ 7: {} });
  const first = await call({ action: 'note', call_id: 7, fields: { note: 'wants a quote', next_step: 'quoted_callback', due_at: '2026-09-26T04:00:00.000Z', due_all_day: true } }, { w });
  assert.equal(first.res.statusCode, 200);
  assert.deepEqual(w.writes[0].body, { note: 'wants a quote', next_step: 'quoted_callback', due_at: '2026-09-26T04:00:00.000Z', due_all_day: true });
  const stamp = w.writes[1];
  assert.match(stamp.url, /noted_at=is\.null/, 'the stamp only lands on an un-noted row');
  assert.deepEqual(Object.keys(stamp.body).sort(), ['noted_at', 'noted_by_name']);
  assert.equal(stamp.body.noted_by_name, 'ZZ Test Advisor', 'from the signed-in employee, not the browser');
  assert.ok(Math.abs(Date.parse(stamp.body.noted_at) - Date.now()) < 5000, 'server clock');
  assert.equal(first.res.body.call.noted_by_name, 'ZZ Test Advisor');
  const notedAt = w.calls[7].noted_at;
  // A later save: no second stamp, noted_at unchanged.
  const second = await call({ action: 'note', call_id: 7, fields: { note: 'wants a quote — call after 3' } }, { w });
  assert.equal(second.res.statusCode, 200);
  assert.equal(w.writes.length, 3, 'just the field write — no stamp');
  assert.equal(w.calls[7].noted_at, notedAt);
  // Even a race (row noted between our read and our stamp): the guard matches nothing.
  const w2 = world({ 7: {} });
  const orig = w2.fetch;
  w2.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH' && url.includes('noted_at=is.null')) { w2.calls[7].noted_at = '2026-09-25T10:00:00Z'; w2.calls[7].noted_by_name = 'Josh'; }
    return orig(url, opts);
  };
  const raced = await call({ action: 'note', call_id: 7, fields: { note: 'x' } }, { w: w2 });
  assert.equal(raced.res.statusCode, 200);
  assert.equal(w2.calls[7].noted_by_name, 'Josh', 'the first stamp stands');
});

test('note: a person picking the RO clears the robot\'s run tags; an unknown RO is 404 and nothing is written', async () => {
  const w = world({ 7: { noted_at: '2026-09-25T10:00:00Z', ro_id: RO2, auto_ro_filed_at: '2026-09-25T09:00:00Z', auto_attach_run_id: AUTO_ATTACH_LIVE_RUN_ID, auto_attached_at: '2026-09-25T09:00:00Z' } });
  const { res } = await call({ action: 'note', call_id: 7, fields: { ro_id: RO1 } }, { w });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.writes[0].body, { ro_id: RO1, auto_ro_filed_at: null, auto_attach_run_id: null });
  assert.equal(w.calls[7].auto_attached_at, '2026-09-25T09:00:00Z', 'the machine\'s customer pick stays as history');
  const w2 = world({ 7: {} });
  const nf = await call({ action: 'note', call_id: 7, fields: { ro_id: NOPE } }, { w: w2 });
  assert.equal(nf.res.statusCode, 404);
  assert.equal(w2.writes.length, 0);
});

test('note: the card\'s single-match customer only goes into an EMPTY customer_id', async () => {
  const w = world({ 7: {} });
  const a = await call({ action: 'note', call_id: 7, fields: { note: 'a' }, fold_customer_id: CUST }, { w });
  assert.equal(a.res.body.customer_folded, true);
  assert.equal(w.calls[7].customer_id, CUST);
  const fold = w.writes.find((x) => 'customer_id' in x.body);
  assert.match(fold.url, /customer_id=is\.null/);
  // Someone already attached a different customer → left alone.
  const w2 = world({ 7: { customer_id: CUST2 } });
  const b = await call({ action: 'note', call_id: 7, fields: { note: 'a' }, fold_customer_id: CUST }, { w: w2 });
  assert.equal(b.res.body.customer_folded, false);
  assert.equal(w2.calls[7].customer_id, CUST2);
  assert.ok(!w2.writes.some((x) => 'customer_id' in x.body));
});

/* ── customer ─────────────────────────────────────────────────────────── */

test('customer: only customer_id — no noted stamp; an unknown customer is 404', async () => {
  const w = world({ 7: {} });
  const { res } = await call({ action: 'customer', call_id: 7, customer_id: CUST }, { w });
  assert.equal(res.statusCode, 200);
  assert.equal(w.writes.length, 1);
  assert.deepEqual(w.writes[0].body, { customer_id: CUST });
  assert.equal(w.calls[7].noted_at, null, 'picking a name is not noting the call');
  const w2 = world({ 7: {} });
  assert.equal((await call({ action: 'customer', call_id: 7, customer_id: NOPE }, { w: w2 })).res.statusCode, 404);
  assert.equal(w2.writes.length, 0);
});

/* ── auto_file_ro (the robot) ─────────────────────────────────────────── */

const openRo = (id) => ({ id, customer_id: CUST, status: 'ro', created_at: '2026-09-20T12:00:00Z', closed_at: null, declined_at: null });

test('auto_file_ro: exactly one RO open when the call came in → filed, ONLY into an empty ro_id', async () => {
  const w = world({ 7: { customer_id: CUST } }, [openRo(RO1)]);
  const { res } = await call({ action: 'auto_file_ro', call_id: 7 }, { w });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ro_id, RO1);
  assert.equal(w.writes.length, 1);
  assert.match(w.writes[0].url, /ro_id=is\.null/, 'the write itself refuses a filled slot');
  assert.equal(w.writes[0].body.ro_id, RO1);
  assert.equal(w.writes[0].body.auto_attach_run_id, AUTO_ATTACH_LIVE_RUN_ID);
  assert.ok(!('auto_attached_at' in w.writes[0].body), 'a human attached that customer — the robot only filed the RO');
});

test('auto_file_ro never guesses and never overwrites: 2 open, already filed, no customer, lost the race → nothing (or nothing changed)', async () => {
  const two = world({ 7: { customer_id: CUST } }, [openRo(RO1), openRo(RO2)]);
  assert.equal((await call({ action: 'auto_file_ro', call_id: 7 }, { w: two })).res.body.ro_id, null);
  assert.equal(two.writes.length, 0);
  const filed = world({ 7: { customer_id: CUST, ro_id: RO2 } }, [openRo(RO1)]);
  assert.equal((await call({ action: 'auto_file_ro', call_id: 7 }, { w: filed })).res.body.ro_id, null);
  assert.equal(filed.writes.length, 0);
  assert.equal(filed.calls[7].ro_id, RO2, 'a person\'s pick stands');
  const nocust = world({ 7: {} }, [openRo(RO1)]);
  assert.equal((await call({ action: 'auto_file_ro', call_id: 7 }, { w: nocust })).res.body.ro_id, null);
  assert.equal(nocust.writes.length, 0);
  const race = world({ 7: { customer_id: CUST } }, [openRo(RO1)]);
  race.raceRoBeforeWrite = true;        // a person files RO2 between our read and our write
  const r = await call({ action: 'auto_file_ro', call_id: 7 }, { w: race });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.body.ro_id, null);
  assert.equal(race.calls[7].ro_id, RO2, 'the person\'s RO survives');
});

test('repair_orders and customers are only ever READ', async () => {
  const w = world({ 7: { customer_id: CUST } }, [openRo(RO1)]);
  await call({ action: 'auto_file_ro', call_id: 7 }, { w });
  await call({ action: 'note', call_id: 7, fields: { ro_id: RO1 }, fold_customer_id: CUST }, { w });
  await call({ action: 'customer', call_id: 7, customer_id: CUST2 }, { w });
  assert.ok(w.writes.every((x) => x.table === 'calls'), 'every write is to calls');
});
