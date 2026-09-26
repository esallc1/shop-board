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
   Step (a)2 — the Desk (outcome / undo / done / edit / reschedule):
     • 401 for every Desk action without a staff session; 400 for any key outside
       the action's list (resolved_at, resolved_by_name, outcome_prev_due_at, …);
     • the patches are desk-outcomes.js / desk-appointments.js's, with who/when
       from the server and Follow up's outcome_prev_due_at from the ROW;
     • a clear only lands on an open row (resolved_at=is.null) — else 409;
     • Undo restores the row EXACTLY as it was before the clear.
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

function world(rows = {}, ros = [], custs = null) {
  const w = { reads: [], writes: [], calls: {}, custs: custs || {
    [CUST]: { id: CUST, phone_primary: '2395550100', phone_secondary: null },
    [CUST2]: { id: CUST2, phone_primary: '2395550200', phone_secondary: '2395550299' },
  } };
  for (const [id, r] of Object.entries(rows)) w.calls[id] = { id: Number(id), customer_id: null, ro_id: null, note: null, next_step: null,
    due_at: null, due_all_day: true, dropoff_key_box: false, noted_at: null, noted_by_name: null, started_at: '2026-09-25T14:00:00Z',
    auto_attached_at: null, auto_ro_filed_at: null, auto_attach_run_id: null,
    caller_bare: '2395550777', attached_by_name: null, attached_at: null, learned_phone: false,
    not_a_customer_at: null, not_a_customer_by_name: null,
    resolved_at: null, resolved_by_name: null, outcome: null, outcome_note: null, outcome_prev_due_at: null, ...r };
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
      const id = (q.get('id') || '').replace(/^eq\./, '');
      const c = w.custs[id];
      if (method === 'GET') { w.reads.push(url); return json(200, c ? [{ ...c }] : []); }
      const body = JSON.parse(opts.body);
      w.writes.push({ url, method, body, table: 'customers' });
      if (!c) return json(200, []);
      const ps = q.get('phone_secondary');
      if (ps === 'is.null' && c.phone_secondary != null) return json(200, []);
      if (ps && ps.startsWith('eq.') && c.phone_secondary !== ps.slice(3)) return json(200, []);
      Object.assign(c, body);
      return json(200, [{ ...c }]);
    }
    if (url.includes('/rest/v1/repair_orders?')) {
      if (method !== 'GET') { w.writes.push({ url, method }); return json(500, {}); }
      w.reads.push(url);
      if (q.get('id')) {
        const id = q.get('id').replace(/^eq\./, '');
        const ro = ros.find((r) => r.id === id) || (id === RO1 ? { id: RO1, customer_id: CUST } : null);
        return json(200, ro ? [ro] : []);
      }
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
      for (const col of ['noted_at', 'customer_id', 'ro_id', 'resolved_at']) {
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

/* ── the Desk (step (a)2) ─────────────────────────────────────────────── */

const DROP = { next_step: 'dropping_off', due_at: '2026-09-28T04:00:00.000Z', due_all_day: true, dropoff_key_box: true, noted_at: '2026-09-20T10:00:00Z', noted_by_name: 'Josh' };

test('Desk: 401 for every action without a signed-in active employee — and nothing is read', async () => {
  const bodies = [
    { action: 'outcome', call_id: 7, outcome: 'arrived' },
    { action: 'undo', call_id: 7 },
    { action: 'done', call_id: 7 },
    { action: 'edit', call_id: 7, next_step: 'dropping_off', due_at: '2026-09-28T04:00:00Z', due_all_day: true },
    { action: 'reschedule', call_id: 7, due_at: '2026-09-28T14:00:00Z', due_all_day: false },
  ];
  for (const b of bodies) for (const token of [null, 'kiki-token', 'inactive-token']) {
    const w = world({ 7: DROP });
    const { res } = await call(b, { token, w });
    assert.equal(res.statusCode, 401, `${b.action} ${token}`);
    assert.equal(w.reads.length + w.writes.length, 0);
  }
});

test('Desk: 400 for any key outside the action\'s list, and for impossible values — nothing written', async () => {
  const bad = [
    { action: 'outcome', call_id: 7, outcome: 'arrived', resolved_at: '2020-01-01T00:00:00Z' },
    { action: 'outcome', call_id: 7, outcome: 'arrived', resolved_by_name: 'Me' },
    { action: 'outcome', call_id: 7, outcome: 'follow_up', callback_due_at: '2026-10-09T04:00:00Z', outcome_prev_due_at: null },
    { action: 'outcome', call_id: 7, outcome: 'fixed_elsewhere' },
    { action: 'outcome', call_id: 7, outcome: 'follow_up' },
    { action: 'outcome', call_id: 7, outcome: 'arrived', callback_due_at: '2026-10-09T04:00:00Z' },
    { action: 'undo', call_id: 7, resolved_at: null },
    { action: 'done', call_id: 7, resolved_by_name: 'Me' },
    { action: 'edit', call_id: 7, next_step: 'checking_on_car', due_at: '2026-09-28T04:00:00Z', due_all_day: true },
    { action: 'edit', call_id: 7, next_step: 'dropping_off', due_at: '2026-09-28T14:00:00Z', due_all_day: false, key_box: true },
    { action: 'edit', call_id: 7, next_step: 'dropping_off', due_at: '2026-09-28T04:00:00Z', due_all_day: true, noted_by_name: 'Me' },
    { action: 'edit', call_id: 7, next_step: 'dropping_off', due_at: 'soon', due_all_day: true },
    { action: 'reschedule', call_id: 7, due_at: '2026-09-28T14:00:00Z', due_all_day: false, dropoff_key_box: true },
    { action: 'reschedule', call_id: 7, due_at: '2026-09-28T14:00:00Z' },
  ];
  for (const b of bad) {
    const w = world({ 7: DROP });
    const { res } = await call(b, { w });
    assert.equal(res.statusCode, 400, JSON.stringify(b).slice(0, 90));
    assert.equal(w.writes.length, 0);
  }
});

test('Arrived / Not coming / Called: resolved_at + who from the SERVER, the outcome and reason — the lane and date untouched', async () => {
  const w = world({ 7: DROP });
  const { res } = await call({ action: 'outcome', call_id: 7, outcome: 'arrived' }, { w });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cleared, true);
  const wr = w.writes[0];
  assert.match(wr.url, /resolved_at=is\.null/, 'only an open row can be cleared');
  assert.deepEqual(Object.keys(wr.body).sort(), ['outcome', 'outcome_note', 'resolved_at', 'resolved_by_name']);
  assert.equal(wr.body.resolved_by_name, 'ZZ Test Advisor');
  assert.ok(Math.abs(Date.parse(wr.body.resolved_at) - Date.now()) < 5000);
  assert.equal(w.calls[7].next_step, 'dropping_off');
  assert.equal(w.calls[7].due_at, DROP.due_at);
  const w2 = world({ 7: DROP });
  await call({ action: 'outcome', call_id: 7, outcome: 'not_coming', note: '  sold the car  ' }, { w: w2 });
  assert.equal(w2.calls[7].outcome, 'not_coming');
  assert.equal(w2.calls[7].outcome_note, 'sold the car');
});

test('Follow up: moves to Callbacks with the new date; outcome_prev_due_at comes from the ROW; nothing is cleared', async () => {
  const w = world({ 7: DROP });
  const { res } = await call({ action: 'outcome', call_id: 7, outcome: 'follow_up', note: 'no money till the 1st', callback_due_at: '2026-10-09T04:00:00.000Z' }, { w });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cleared, false);
  const row = w.calls[7];
  assert.equal(row.next_step, 'quoted_callback');
  assert.equal(row.due_at, '2026-10-09T04:00:00.000Z');
  assert.equal(row.due_all_day, true);
  assert.equal(row.outcome, 'follow_up');
  assert.equal(row.outcome_prev_due_at, DROP.due_at, 'the drop-off date they missed');
  assert.equal(row.noted_by_name, 'ZZ Test Advisor');
  assert.equal(row.resolved_at, null, 'Follow up never clears');
});

test('a clear on an already-cleared row is refused (409) — including a race between two boards', async () => {
  const w = world({ 7: { ...DROP, resolved_at: '2026-09-25T10:00:00Z', resolved_by_name: 'Josh', outcome: 'arrived' } });
  const r1 = await call({ action: 'outcome', call_id: 7, outcome: 'not_coming' }, { w });
  assert.equal(r1.res.statusCode, 409);
  assert.equal(w.writes.length, 0);
  assert.equal(w.calls[7].resolved_by_name, 'Josh');
  assert.equal((await call({ action: 'done', call_id: 7 }, { w })).res.statusCode, 409);
  // Race: open when read, cleared by someone else before our write.
  const w2 = world({ 7: DROP });
  const orig = w2.fetch;
  w2.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH') { w2.calls[7].resolved_at = '2026-09-25T10:00:00Z'; w2.calls[7].resolved_by_name = 'Josh'; }
    return orig(url, opts);
  };
  const r2 = await call({ action: 'outcome', call_id: 7, outcome: 'arrived' }, { w: w2 });
  assert.equal(r2.res.statusCode, 409);
  assert.equal(w2.calls[7].resolved_by_name, 'Josh', 'the first clear stands');
});

test('Undo restores the row EXACTLY as it was before the clear (and keeps a Follow up\'s missed date)', async () => {
  const w = world({ 7: DROP });
  const before = { ...w.calls[7] };
  await call({ action: 'outcome', call_id: 7, outcome: 'arrived' }, { w });
  assert.notEqual(w.calls[7].resolved_at, null);
  const u = await call({ action: 'undo', call_id: 7 }, { w });
  assert.equal(u.res.statusCode, 200);
  assert.deepEqual(w.calls[7], before, 'every column back');
  // follow_up → Called from the Callbacks lane → Undo: back on Callbacks, still knowing why.
  const w2 = world({ 7: DROP });
  await call({ action: 'outcome', call_id: 7, outcome: 'follow_up', callback_due_at: '2026-10-09T04:00:00.000Z' }, { w: w2 });
  const parked = { ...w2.calls[7] };
  await call({ action: 'outcome', call_id: 7, outcome: 'called' }, { w: w2 });
  await call({ action: 'undo', call_id: 7 }, { w: w2 });
  // undoPatch as it has always been (desk-outcomes.js): the clear's four columns are
  // nulled — `outcome` included — and outcome_prev_due_at is deliberately KEPT, so the
  // row is back on Callbacks, same date, still knowing the drop-off it missed.
  assert.deepEqual(w2.calls[7], { ...parked, outcome: null });
  assert.equal(w2.calls[7].outcome_prev_due_at, DROP.due_at);
  // Undo on an open row: nothing to do, nothing written.
  const w3 = world({ 7: DROP });
  const n = await call({ action: 'undo', call_id: 7 }, { w: w3 });
  assert.equal(n.res.body.unchanged, true);
  assert.equal(w3.writes.length, 0);
});

test('Done (pre-migration fallback): resolved_at + who only', async () => {
  const w = world({ 7: DROP });
  await call({ action: 'done', call_id: 7 }, { w });
  assert.deepEqual(Object.keys(w.writes[0].body).sort(), ['resolved_at', 'resolved_by_name']);
  assert.equal(w.writes[0].body.resolved_by_name, 'ZZ Test Advisor');
});

test('Edit: lane + date + time or key box (key box only on an all-day drop-off); resolved_at never touched', async () => {
  const w = world({ 7: DROP });
  await call({ action: 'edit', call_id: 7, next_step: 'quoted_callback', due_at: '2026-10-01T04:00:00.000Z', due_all_day: true, key_box: true }, { w });
  assert.deepEqual(w.writes[0].body, { next_step: 'quoted_callback', due_at: '2026-10-01T04:00:00.000Z', due_all_day: true, dropoff_key_box: false }, 'a callback is never a key box');
  await call({ action: 'edit', call_id: 7, next_step: 'dropping_off', due_at: '2026-10-02T04:00:00.000Z', due_all_day: true, key_box: true }, { w });
  assert.equal(w.writes[1].body.dropoff_key_box, true);
  await call({ action: 'edit', call_id: 7, next_step: 'dropping_off', due_at: '2026-10-02T14:30:00.000Z', due_all_day: false }, { w });
  assert.deepEqual(w.writes[2].body, { next_step: 'dropping_off', due_at: '2026-10-02T14:30:00.000Z', due_all_day: false, dropoff_key_box: false });
  assert.ok(w.writes.every((x) => !('resolved_at' in x.body)));
});

test('Reschedule (a calendar drag): onto a timed slot clears the key box in the SAME write; onto the all-day strip keeps it', async () => {
  const w = world({ 7: DROP });
  await call({ action: 'reschedule', call_id: 7, due_at: '2026-09-29T15:00:00.000Z', due_all_day: false }, { w });
  assert.deepEqual(w.writes[0].body, { due_at: '2026-09-29T15:00:00.000Z', due_all_day: false, dropoff_key_box: false });
  const w2 = world({ 7: DROP });
  await call({ action: 'reschedule', call_id: 7, due_at: '2026-09-30T04:00:00.000Z', due_all_day: true }, { w: w2 });
  assert.deepEqual(w2.writes[0].body, { due_at: '2026-09-30T04:00:00.000Z', due_all_day: true });
  assert.equal(w2.calls[7].dropoff_key_box, true, 'the key box stays');
});

test('static: the six Desk writers go through api/calls.js — none writes `calls` directly', async () => {
  const { readFileSync } = await import('node:fs');
  const board = readFileSync(new URL('../advisor-board.html', import.meta.url), 'utf8');
  const body = (name) => {
    const i = board.indexOf(`async function ${name}(`);
    assert.ok(i > 0, name);
    const j = board.indexOf('\n    }\n', i);
    return board.slice(i, j);
  };
  const expect = { applyOutcome: "action: 'outcome'", undoCleared: "action: 'undo'", resolveCall: "action: 'done'",
    saveNotNow: "action: 'outcome'", deskEditSave: "action: 'edit'", rescheduleCall: "action: 'reschedule'" };
  for (const [fn, act] of Object.entries(expect)) {
    const src = body(fn);
    assert.doesNotMatch(src, /from\('calls'\)/, `${fn} still writes calls directly`);
    assert.ok(src.includes('cdCallsWrite(') && src.includes(act), `${fn} → ${act}`);
  }
});

/* ── the Call Log + customer record (step (a)3) ───────────────────────── */

test('(a)3: 401 without a staff session and 400 for any key outside the action — nothing written', async () => {
  const bodies = [
    { action: 'attach', call_id: 7, customer_id: CUST }, { action: 'learn_phone', call_id: 7 }, { action: 'unattach', call_id: 7 },
    { action: 'not_a_customer', call_id: 7 }, { action: 'clear_not_a_customer', call_id: 7 }, { action: 'file_ro', call_id: 7, ro_id: RO1 },
  ];
  for (const b of bodies) for (const token of [null, 'kiki-token', 'inactive-token']) {
    const w = world({ 7: {} });
    const { res } = await call(b, { token, w });
    assert.equal(res.statusCode, 401, `${b.action} ${token}`);
    assert.equal(w.reads.length + w.writes.length, 0);
  }
  const bad = [
    { action: 'attach', call_id: 7, customer_id: CUST, attached_by_name: 'Me' },
    { action: 'attach', call_id: 7, customer_id: CUST, learned_phone: true },
    { action: 'attach', call_id: 7 },
    { action: 'learn_phone', call_id: 7, phone_secondary: '2395550777' },
    { action: 'learn_phone', call_id: 7, customer_id: CUST },
    { action: 'unattach', call_id: 7, learned_phone: true },
    { action: 'not_a_customer', call_id: 7, not_a_customer_by_name: 'Me' },
    { action: 'clear_not_a_customer', call_id: 7, not_a_customer_at: null },
    { action: 'file_ro', call_id: 7 },
    { action: 'file_ro', call_id: 7, ro_id: 'nope' },
    { action: 'file_ro', call_id: 7, ro_id: RO1, noted_by_name: 'Me' },
  ];
  for (const b of bad) {
    const w = world({ 7: {} });
    assert.equal((await call(b, { w })).res.statusCode, 400, JSON.stringify(b).slice(0, 80));
    assert.equal(w.writes.length, 0);
  }
});

test('attach: the confirmed customer + who/when from the SERVER, learned_phone false; then the robot only fills an EMPTY ro_id', async () => {
  const w = world({ 7: {} }, [openRo(RO1)]);
  const a = await call({ action: 'attach', call_id: 7, customer_id: CUST }, { w });
  assert.equal(a.res.statusCode, 200);
  assert.deepEqual(Object.keys(w.writes[0].body).sort(), ['attached_at', 'attached_by_name', 'customer_id', 'learned_phone']);
  assert.equal(w.calls[7].attached_by_name, 'ZZ Test Advisor');
  assert.equal(w.calls[7].learned_phone, false);
  assert.equal((await call({ action: 'attach', call_id: 7, customer_id: NOPE }, { w: world({ 7: {} }) })).res.statusCode, 404);
  // The board's follow-up: auto_file_ro — fills the empty slot…
  const f = await call({ action: 'auto_file_ro', call_id: 7 }, { w });
  assert.equal(f.res.body.ro_id, RO1);
  // …but never a filled one.
  const w2 = world({ 7: { ro_id: RO2 } }, [openRo(RO1)]);
  await call({ action: 'attach', call_id: 7, customer_id: CUST }, { w: w2 });
  assert.equal((await call({ action: 'auto_file_ro', call_id: 7 }, { w: w2 })).res.body.ro_id, null);
  assert.equal(w2.calls[7].ro_id, RO2);
});

test('learn_phone: the caller\'s number into the customer\'s EMPTY phone_secondary (the database decides), and only then learned_phone', async () => {
  const w = world({ 7: { customer_id: CUST, caller_bare: '2395550777' } });
  const r = await call({ action: 'learn_phone', call_id: 7 }, { w });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.body.learned, true);
  const cw = w.writes.find((x) => x.table === 'customers');
  assert.match(cw.url, /phone_secondary=is\.null/, 'the empty-slot guard lives in the write (July 29 fix)');
  assert.deepEqual(cw.body, { phone_secondary: '2395550777' });
  assert.equal(w.custs[CUST].phone_secondary, '2395550777');
  assert.equal(w.calls[7].learned_phone, true);
  // Occupied slot → nothing written, learned false.
  const w2 = world({ 7: { customer_id: CUST2, caller_bare: '2395550777' } });
  const r2 = await call({ action: 'learn_phone', call_id: 7 }, { w: w2 });
  assert.equal(r2.res.body.learned, false);
  assert.equal(w2.custs[CUST2].phone_secondary, '2395550299', 'never overwritten');
  assert.equal(w2.calls[7].learned_phone, false);
  // The number is already the customer's primary → nothing.
  const w3 = world({ 7: { customer_id: CUST, caller_bare: '2395550100' } });
  assert.equal((await call({ action: 'learn_phone', call_id: 7 }, { w: w3 })).res.body.learned, false);
  assert.ok(!w3.writes.some((x) => x.table === 'customers'));
  // Stale snapshot: the slot was filled between our read and our write → the guard matches nothing.
  const w4 = world({ 7: { customer_id: CUST, caller_bare: '2395550777' } });
  const orig = w4.fetch;
  w4.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH' && url.includes('/customers?')) w4.custs[CUST].phone_secondary = '2395550888';
    return orig(url, opts);
  };
  const r4 = await call({ action: 'learn_phone', call_id: 7 }, { w: w4 });
  assert.equal(r4.res.body.learned, false);
  assert.equal(w4.custs[CUST].phone_secondary, '2395550888');
  assert.equal(w4.calls[7].learned_phone, false, 'never claims a number it did not write');
  // Not attached any more → 409.
  assert.equal((await call({ action: 'learn_phone', call_id: 7 }, { w: world({ 7: {} }) })).res.statusCode, 409);
});

test('unattach restores the row: link + robot marks off (an ro_id the robot filed too); the learned number cleared ONLY if it is still exactly that number', async () => {
  const w = world({ 7: { customer_id: CUST, caller_bare: '2395550777' } }, [openRo(RO1)]);
  const before = { ...w.calls[7] };
  const custBefore = { ...w.custs[CUST] };
  await call({ action: 'attach', call_id: 7, customer_id: CUST }, { w });
  await call({ action: 'learn_phone', call_id: 7 }, { w });
  await call({ action: 'auto_file_ro', call_id: 7 }, { w });
  assert.equal(w.calls[7].ro_id, RO1);
  const u = await call({ action: 'unattach', call_id: 7 }, { w });
  assert.equal(u.res.statusCode, 200);
  assert.equal(u.res.body.unlearned, true);
  assert.deepEqual(w.custs[CUST], custBefore, 'the learned number is gone again');
  const row = w.calls[7];
  for (const k of ['customer_id', 'attached_by_name', 'attached_at', 'ro_id', 'auto_attached_at', 'auto_ro_filed_at', 'auto_attach_run_id']) assert.equal(row[k], null, k);
  assert.equal(row.learned_phone, false);
  assert.deepEqual({ ...row, customer_id: before.customer_id }, before, 'otherwise exactly as before');
  // A PERSON's ro_id stays; a number that changed since is never touched; a number never learned is never touched.
  const w2 = world({ 7: { customer_id: CUST, caller_bare: '2395550777', learned_phone: true, ro_id: RO2 } },
    [], { [CUST]: { id: CUST, phone_primary: '2395550100', phone_secondary: '2395550999' } });
  const u2 = await call({ action: 'unattach', call_id: 7 }, { w: w2 });
  assert.equal(u2.res.body.unlearned, false);
  assert.equal(w2.custs[CUST].phone_secondary, '2395550999');
  assert.equal(w2.calls[7].ro_id, RO2, 'a person filed it — it stays');
  const w3 = world({ 7: { customer_id: CUST2, caller_bare: '2395550299', learned_phone: false } });
  await call({ action: 'unattach', call_id: 7 }, { w: w3 });
  assert.ok(!w3.writes.some((x) => x.table === 'customers'), 'learned_phone false → customers never touched');
  assert.equal(w3.custs[CUST2].phone_secondary, '2395550299');
});

test('not a customer + clear: the mark with who/when from the server, and back', async () => {
  const w = world({ 7: {} });
  await call({ action: 'not_a_customer', call_id: 7 }, { w });
  assert.deepEqual(Object.keys(w.writes[0].body).sort(), ['not_a_customer_at', 'not_a_customer_by_name']);
  assert.equal(w.calls[7].not_a_customer_by_name, 'ZZ Test Advisor');
  assert.equal(w.calls[7].customer_id, null, 'never touches customer_id');
  await call({ action: 'clear_not_a_customer', call_id: 7 }, { w });
  assert.equal(w.calls[7].not_a_customer_at, null);
  assert.equal(w.calls[7].not_a_customer_by_name, null);
});

test('file_ro: only an RO of the call\'s OWN customer; robot tags cleared; noted stamp only if none yet; un-file with null', async () => {
  const ros = [{ id: RO1, customer_id: CUST }, { id: RO2, customer_id: CUST2 }];
  const w = world({ 7: { customer_id: CUST, auto_attach_run_id: AUTO_ATTACH_LIVE_RUN_ID, auto_ro_filed_at: '2026-09-25T09:00:00Z' } }, ros);
  const ok = await call({ action: 'file_ro', call_id: 7, ro_id: RO1 }, { w });
  assert.equal(ok.res.statusCode, 200);
  assert.deepEqual(w.writes[0].body, { ro_id: RO1, auto_ro_filed_at: null, auto_attach_run_id: null });
  assert.equal(w.calls[7].noted_by_name, 'ZZ Test Advisor', 'never noted → stamped');
  assert.match(w.writes[1].url, /noted_at=is\.null/);
  const wrong = await call({ action: 'file_ro', call_id: 7, ro_id: RO2 }, { w });
  assert.equal(wrong.res.statusCode, 409);
  assert.equal(wrong.res.body.error, 'wrong_customer');
  assert.equal(w.calls[7].ro_id, RO1, 'unchanged');
  // Already noted → no second stamp.
  const w2 = world({ 7: { customer_id: CUST, noted_at: '2026-09-20T10:00:00Z', noted_by_name: 'Josh' } }, ros);
  await call({ action: 'file_ro', call_id: 7, ro_id: RO1 }, { w: w2 });
  assert.equal(w2.writes.length, 1);
  assert.equal(w2.calls[7].noted_by_name, 'Josh');
  // Un-file.
  await call({ action: 'file_ro', call_id: 7, ro_id: null }, { w: w2 });
  assert.equal(w2.calls[7].ro_id, null);
  // No customer on the call → can't file to anyone's RO.
  assert.equal((await call({ action: 'file_ro', call_id: 7, ro_id: RO1 }, { w: world({ 7: {} }, ros) })).res.statusCode, 409);
});

test('static: ZERO direct calls writes left in the browser code (all 15 writers moved); these paths never write customers', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith('.html')),
    ...readdirSync(new URL('../shared/', import.meta.url)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => 'shared/' + f),
  ];
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(new URL(f, root), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\.from\((['"`])calls\1\)/.test(line)) return;
      if (/\.(insert|update|upsert|delete)\(/.test(lines.slice(i, i + 3).join(' '))) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'every calls write goes through api/calls.js');
  const board = readFileSync(new URL('advisor-board.html', root), 'utf8');
  const body = (name, next) => board.slice(board.indexOf(`async function ${name}(`), board.indexOf(next));
  const paths = {
    fileCallToRo: ['file_ro', '// ── Unfiled calls'], answerPhoneLearn: ['learn_phone', 'async function performAttach('],
    performAttach: ['attach', 'async function performUnattach('], performUnattach: ['unattach', '// Not a customer (spam'],
    performNotACustomer: ['not_a_customer', 'async function performClearNotACustomer('], performClearNotACustomer: ['clear_not_a_customer', '// ── attach customer picker'],
  };
  for (const [fn, [act, next]] of Object.entries(paths)) {
    const src = body(fn, next);
    assert.ok(src.length > 50, fn);
    assert.doesNotMatch(src, /from\('customers'\)|from\('calls'\)/, `${fn} writes directly`);
    assert.ok(src.includes(`action: '${act}'`), `${fn} → ${act}`);
  }
  assert.doesNotMatch(board, /setSecondaryIfNull = async/, 'the browser phone writer is gone');
});
