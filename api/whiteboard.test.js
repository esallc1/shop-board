/* ============================================================
   whiteboard.test.js — api/whiteboard.js (add / clear / undo / called / uncalled).
   Run: npm test   (node --test)

   The real requireUser runs against a stubbed global fetch that plays Supabase
   Auth and PostgREST. Locks:
     • 401 with no token, a junk token, a KiKi-style user (valid session, NO
       employees row) and an inactive employee — and no whiteboard/RO data is read;
     • 405 / 400 on bad methods and fields;
     • who + when are stamped by the SERVER — a body's created_by/called_by/…
       is ignored — and each action writes only its own columns;
     • repair_orders is only ever READ (never PATCH/POST);
     • clear refuses an already-cleared line (409) and 'arrived' on a note (400);
       called refuses an RO that isn't status 'invoice' (409).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { parseBody, MAX_TEXT } from './whiteboard.js';

const RO = '11111111-1111-4111-8111-111111111111';
const RO_CLOSED = '22222222-2222-4222-8222-222222222222';
const RO_ACTIVE = '77777777-7777-4777-8777-777777777777';
const NOTE = '33333333-3333-4333-8333-333333333333';
const PARTS = '55555555-5555-4555-8555-555555555555';
const CLEARED = '66666666-6666-4666-8666-666666666666';
const EMP = { id: '44444444-4444-4444-8444-444444444444', name: 'ZZ Test Advisor', role: 'advisor' };
const FAKE = '99999999-9999-4999-8999-999999999999';

function world({ recent = [] } = {}) {
  const w = { calls: [], writes: [], recent, dupeChecks: [] };
  const items = {
    [NOTE]: { id: NOTE, kind: 'note', cleared_at: null },
    [PARTS]: { id: PARTS, kind: 'parts', cleared_at: null },
    [CLEARED]: { id: CLEARED, kind: 'note', cleared_at: '2026-09-24T12:00:00Z' },
  };
  w.fetch = async (url, opts = {}) => {
    w.calls.push({ url, opts });
    const method = opts.method || 'GET';
    const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
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
    if (url.includes('/rest/v1/repair_orders?')) {
      if (method !== 'GET') { w.writes.push({ url, method, body: opts.body }); return json(500, {}); }
      if (url.includes(`id=eq.${RO}`)) return json(200, [{ id: RO, status: 'invoice' }]);
      if (url.includes(`id=eq.${RO_CLOSED}`)) return json(200, [{ id: RO_CLOSED, status: 'closed' }]);
      if (url.includes(`id=eq.${RO_ACTIVE}`)) return json(200, [{ id: RO_ACTIVE, status: 'ro' }]);
      return json(200, []);
    }
    if (url.includes('/rest/v1/whiteboard_items?')) {
      if (method === 'GET' && url.includes('created_by=eq.')) {
        // The duplicate check: same person + kind + text + RO, still on the board, recent.
        const q = new URL(url).searchParams;
        const val = (k) => (q.get(k) || '').replace(/^eq\./, '');
        const hit = w.recent.filter((r) => r.created_by === val('created_by') && r.kind === val('kind') && r.text === val('text') &&
          (q.get('ro_id') === 'is.null' ? r.ro_id == null : r.ro_id === val('ro_id')) && r.cleared_at == null &&
          Date.parse(r.created_at) >= Date.parse(q.get('created_at').replace(/^gte\./, '')));
        w.dupeChecks.push(url);
        return json(200, hit.slice(0, 1));
      }
      if (method === 'GET') {
        const id = (url.match(/id=eq\.([0-9a-f-]+)/) || [])[1];
        return json(200, items[id] ? [items[id]] : []);
      }
      const body = JSON.parse(opts.body);
      w.writes.push({ url, method, body, prefer: opts.headers.Prefer });
      if (method === 'POST') return json(201, [{ id: 'new-item', ...body, created_at: '2026-09-24T13:00:00Z' }]);
      return json(200, [{ id: (url.match(/id=eq\.([0-9a-f-]+)/) || [])[1], ...body }]);
    }
    if (url.includes('/rest/v1/whiteboard_pickup_calls?')) {
      const body = JSON.parse(opts.body);
      w.writes.push({ url, method, body, prefer: opts.headers.Prefer });
      if (method === 'PATCH' && url.includes(`ro_id=eq.${FAKE}`)) return json(200, []);
      return json(200, [{ ro_id: body.ro_id || RO, ...body }]);
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

async function call(body, { token = 'staff-token', w = world(), method = 'POST' } = {}) {
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

/* ── 1. Who ─────────────────────────────────────────────────────────────── */
test('401 with no token, a junk token, a KiKi login (no employees row), an inactive employee — no data read', async () => {
  const bodies = [
    { action: 'add', kind: 'note', text: 'hi' }, { action: 'called', ro_id: RO },
    { action: 'clear', id: NOTE, reason: 'erased' },
  ];
  for (const token of [null, 'junk', 'kiki-token', 'inactive-token']) {
    for (const body of bodies) {
      const { res, w } = await call(body, { token });
      assert.equal(res.statusCode, 401, `token ${token}`);
      assert.deepEqual(res.body, { error: 'unauthorized' });
      assert.ok(!w.calls.some((c) => /whiteboard_|repair_orders/.test(c.url)), `token ${token} reached data`);
    }
  }
});

test('405 for anything but POST; 400 for bad fields (after auth)', async () => {
  assert.equal((await call({ action: 'add', kind: 'note', text: 'x' }, { method: 'GET' })).res.statusCode, 405);
  const bad = [
    { action: 'nuke' }, {}, null,
    { action: 'add', kind: 'todo', text: 'x' },
    { action: 'add', kind: 'note', text: '   ' },
    { action: 'add', kind: 'note', text: 'x'.repeat(MAX_TEXT + 1) },
    { action: 'add', kind: 'parts', text: 'x', ro_id: 'RO-6012' },
    { action: 'clear', id: NOTE, reason: 'gone' },
    { action: 'clear', id: 'nope', reason: 'erased' },
    { action: 'undo', id: 42 },
    { action: 'called', ro_id: '' }, { action: 'uncalled' },
  ];
  for (const body of bad) {
    const { res, w } = await call(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(w.writes.length, 0);
  }
});

test('parseBody: trims text, 500 characters is fine, empty ro_id = no RO', () => {
  assert.deepEqual(parseBody({ action: 'add', kind: 'note', text: '  call Suncoast  ' }), { ok: true, action: 'add', kind: 'note', text: 'call Suncoast', roId: null });
  assert.equal(parseBody({ action: 'add', kind: 'note', text: 'x'.repeat(MAX_TEXT) }).ok, true);
  assert.equal(parseBody({ action: 'add', kind: 'parts', text: 'starter', ro_id: '' }).roId, null);
  assert.equal(parseBody({ action: 'add', kind: 'parts', text: 'starter', ro_id: RO }).roId, RO);
});

/* ── 2. Who + when come from the server ─────────────────────────────────── */
test('add: stamps created_by/_name from the signed-in employee; body stamps are ignored', async () => {
  const { res, w } = await call({ action: 'add', kind: 'note', text: ' order oil filters ', created_by: FAKE, created_by_name: 'Mallory', created_at: '1999-01-01' });
  assert.equal(res.statusCode, 200);
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].method, 'POST');
  assert.deepEqual(w.writes[0].body, { kind: 'note', text: 'order oil filters', ro_id: null, created_by: EMP.id, created_by_name: EMP.name });
});

test('add with an RO: the RO must exist (404 otherwise) — and repair_orders is only read', async () => {
  let r = await call({ action: 'add', kind: 'parts', text: 'starter bolts', ro_id: RO });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.w.writes[0].body.ro_id, RO);
  r = await call({ action: 'add', kind: 'parts', text: 'starter bolts', ro_id: FAKE });
  assert.equal(r.res.statusCode, 404);
  assert.equal(r.w.writes.length, 0);
});

test('clear: writes only the four cleared_* columns, stamped by the server; guarded on cleared_at is null', async () => {
  const before = Date.now();
  const { res, w } = await call({ action: 'clear', id: NOTE, reason: 'erased', cleared_by_name: 'Mallory', cleared_at: '1999-01-01' });
  assert.equal(res.statusCode, 200);
  const wr = w.writes[0];
  assert.equal(wr.method, 'PATCH');
  assert.match(wr.url, new RegExp(`id=eq\\.${NOTE}&cleared_at=is\\.null`));
  assert.deepEqual(Object.keys(wr.body).sort(), ['cleared_at', 'cleared_by', 'cleared_by_name', 'cleared_reason']);
  assert.equal(wr.body.cleared_by, EMP.id);
  assert.equal(wr.body.cleared_by_name, EMP.name);
  assert.equal(wr.body.cleared_reason, 'erased');
  assert.ok(Date.parse(wr.body.cleared_at) >= before - 1000, 'server clock, not the body');
});

test("clear: 'arrived' only for a parts line; an already-cleared line → 409; unknown → 404", async () => {
  assert.equal((await call({ action: 'clear', id: NOTE, reason: 'arrived' })).res.statusCode, 400);
  assert.equal((await call({ action: 'clear', id: PARTS, reason: 'arrived' })).res.statusCode, 200);
  const r = await call({ action: 'clear', id: CLEARED, reason: 'erased' });
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.w.writes.length, 0);
  assert.equal((await call({ action: 'clear', id: FAKE, reason: 'erased' })).res.statusCode, 404);
});

test('undo: puts the four cleared_* columns back to null; a line that is not cleared is left alone', async () => {
  const { res, w } = await call({ action: 'undo', id: CLEARED });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.writes[0].body, { cleared_at: null, cleared_by: null, cleared_by_name: null, cleared_reason: null });
  const r2 = await call({ action: 'undo', id: NOTE });
  assert.equal(r2.res.statusCode, 200);
  assert.equal(r2.w.writes.length, 0);
});

test("called: only for an 'invoice' RO; upsert by ro_id; stamped by the server", async () => {
  const { res, w } = await call({ action: 'called', ro_id: RO, called_by_name: 'Mallory' });
  assert.equal(res.statusCode, 200);
  const wr = w.writes[0];
  assert.equal(wr.method, 'POST');
  assert.match(wr.url, /whiteboard_pickup_calls\?on_conflict=ro_id/);
  assert.match(wr.prefer, /resolution=merge-duplicates/);
  assert.deepEqual(Object.keys(wr.body).sort(), ['called_at', 'called_by', 'called_by_name', 'ro_id', 'updated_at']);
  assert.equal(wr.body.called_by, EMP.id);
  assert.equal(wr.body.called_by_name, EMP.name);
  const closed = await call({ action: 'called', ro_id: RO_CLOSED });
  assert.equal(closed.res.statusCode, 409);
  assert.equal(closed.w.writes.length, 0);
  assert.equal((await call({ action: 'called', ro_id: FAKE })).res.statusCode, 404);
});

test('uncalled: stamp back to null (row kept — PATCH, never DELETE); never called → 200, nothing to undo', async () => {
  const { res, w } = await call({ action: 'uncalled', ro_id: RO });
  assert.equal(res.statusCode, 200);
  assert.equal(w.writes[0].method, 'PATCH');
  assert.deepEqual(Object.keys(w.writes[0].body).sort(), ['called_at', 'called_by', 'called_by_name', 'updated_at']);
  assert.equal(w.writes[0].body.called_at, null);
  const r2 = await call({ action: 'uncalled', ro_id: FAKE });
  assert.equal(r2.res.statusCode, 200);
  assert.equal(r2.res.body.call.called_at, null);
});

test('nothing ever writes repair_orders, and nothing is ever DELETEd', async () => {
  const all = [
    { action: 'add', kind: 'parts', text: 'x', ro_id: RO }, { action: 'clear', id: PARTS, reason: 'arrived' },
    { action: 'undo', id: CLEARED }, { action: 'called', ro_id: RO }, { action: 'uncalled', ro_id: RO },
  ];
  for (const body of all) {
    const { w } = await call(body);
    assert.ok(!w.writes.some((x) => x.url.includes('repair_orders')), body.action + ' wrote repair_orders');
    assert.ok(!w.calls.some((c) => c.opts.method === 'DELETE'), body.action + ' deleted');
  }
});

/* ── Slice 5: Waiting on parts ─────────────────────────────────────────── */
test('parts: add with an open RO, and with no RO at all (free text) — both stamped by the server', async () => {
  let r = await call({ action: 'add', kind: 'parts', text: 'torque converter · Transtar · ETA Fri', ro_id: RO_ACTIVE, created_by_name: 'Mallory' });
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.w.writes[0].body, { kind: 'parts', text: 'torque converter · Transtar · ETA Fri', ro_id: RO_ACTIVE, created_by: EMP.id, created_by_name: EMP.name });
  r = await call({ action: 'add', kind: 'parts', text: 'shop order: 10 qts ATF' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.w.writes[0].body.ro_id, null);
  assert.ok(!r.w.calls.some((c) => c.url.includes('repair_orders')), 'no RO → no RO read');
  r = await call({ action: 'add', kind: 'parts', text: 'x', ro_id: '' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.w.writes[0].body.ro_id, null);
});

test('parts: a bad ro_id → 400; an unknown RO → 404; a CLOSED RO → 409 — nothing written', async () => {
  for (const bad of ['6089', 'RO-6089', 42, { id: RO }]) {
    const r = await call({ action: 'add', kind: 'parts', text: 'starter', ro_id: bad });
    assert.equal(r.res.statusCode, 400, JSON.stringify(bad));
    assert.equal(r.w.writes.length, 0);
  }
  let r = await call({ action: 'add', kind: 'parts', text: 'starter', ro_id: FAKE });
  assert.equal(r.res.statusCode, 404);
  r = await call({ action: 'add', kind: 'parts', text: 'starter', ro_id: RO_CLOSED });
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.res.body.error, 'ro_closed');
  assert.equal(r.w.writes.length, 0);
});

test("parts: 'Arrived ✓' clears with reason 'arrived' (server-stamped); a note can't be 'arrived'; Undo brings a parts line back", async () => {
  let r = await call({ action: 'clear', id: PARTS, reason: 'arrived' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.w.writes[0].body.cleared_reason, 'arrived');
  assert.equal(r.w.writes[0].body.cleared_by, EMP.id);
  r = await call({ action: 'clear', id: PARTS, reason: 'erased' });
  assert.equal(r.res.statusCode, 200, 'a parts line can be erased too');
  r = await call({ action: 'clear', id: NOTE, reason: 'arrived' });
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.w.writes.length, 0);
});

/* ── No doubles (Cris 2026-09-24: one 📌 → three lines) ─────────────────── */
const mins = (m) => new Date(Date.now() - m * 60000).toISOString();
const mine = (extra) => ({ id: 'old-line', kind: 'note', text: 'call Suncoast about the 4L60 core', ro_id: null,
  created_by: EMP.id, created_by_name: EMP.name, created_at: mins(1), cleared_at: null, ...extra });

test('add: the same person + kind + text (+ RO) still on the board within 10 minutes → that line comes back, NOTHING written', async () => {
  const w = world({ recent: [mine()] });
  const r = await call({ action: 'add', kind: 'note', text: '  call Suncoast about the 4L60 core ' }, { w });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.body.duplicate, true);
  assert.equal(r.res.body.item.id, 'old-line');
  assert.equal(r.w.writes.length, 0);
  assert.equal(r.w.dupeChecks.length, 1);
  assert.match(r.w.dupeChecks[0], /cleared_at=is\.null/);
  assert.match(r.w.dupeChecks[0], /ro_id=is\.null/);
});

test('add: NOT a duplicate → written — different text, erased earlier, older than 10 min, another person, another RO, another kind', async () => {
  const cases = [
    ['different text', [mine()], { action: 'add', kind: 'note', text: 'call Suncoast about the 4L80 core' }],
    ['erased earlier', [mine({ cleared_at: mins(0.5) })], { action: 'add', kind: 'note', text: 'call Suncoast about the 4L60 core' }],
    ['11 minutes old', [mine({ created_at: mins(11) })], { action: 'add', kind: 'note', text: 'call Suncoast about the 4L60 core' }],
    ['another person', [mine({ created_by: FAKE })], { action: 'add', kind: 'note', text: 'call Suncoast about the 4L60 core' }],
    ['another RO', [mine({ kind: 'parts', ro_id: RO_ACTIVE, text: 'starter' })], { action: 'add', kind: 'parts', text: 'starter', ro_id: RO }],
    ['no RO vs an RO', [mine({ kind: 'parts', ro_id: null, text: 'starter' })], { action: 'add', kind: 'parts', text: 'starter', ro_id: RO }],
    ['another kind', [mine({ kind: 'parts' })], { action: 'add', kind: 'note', text: 'call Suncoast about the 4L60 core' }],
  ];
  for (const [name, recent, body] of cases) {
    const r = await call(body, { w: world({ recent }) });
    assert.equal(r.res.statusCode, 200, name);
    assert.equal(r.res.body.duplicate, undefined, name);
    assert.equal(r.w.writes.length, 1, name + ': written');
  }
});

test('add: a parts line with the SAME RO + text from the same person is a duplicate too', async () => {
  const r = await call({ action: 'add', kind: 'parts', text: 'starter', ro_id: RO_ACTIVE },
    { w: world({ recent: [mine({ kind: 'parts', ro_id: RO_ACTIVE, text: 'starter' })] }) });
  assert.equal(r.res.body.duplicate, true);
  assert.equal(r.w.writes.length, 0);
});
