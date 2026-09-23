/* ============================================================
   messenger.test.js — api/messenger.js (reply / link / done).
   Run: npm test   (node --test)

   The real requireUser runs against a stubbed global fetch that plays
   Supabase Auth, PostgREST and the Graph Send API. Locks:
     • 401 with no token, a junk token, a KiKi-style user (valid session, NO
       employees row) and an inactive employee — and nothing else is read;
     • reply: 409 when the 24h window is closed, BEFORE Meta is called;
       dry-run writes a dryrun: mid and never calls Meta (and is refused on a
       Production deployment); no token → 503, nothing stored; a Meta refusal
       is stored as failed under a local: mid; code 190 → "connection expired";
     • link / unlink / done PATCH exactly their own columns.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { replyWindow, parseBody, metaErrorMessage, WINDOW_MS } from './messenger.js';

const THREAD = '11111111-1111-4111-8111-111111111111';
const CUST = '22222222-2222-4222-8222-222222222222';
const MERGED = '33333333-3333-4333-8333-333333333333';
const EMP = { id: '44444444-4444-4444-8444-444444444444', name: 'ZZ Test Advisor', role: 'advisor' };
const HOUR = 60 * 60 * 1000;

/* ── A fake world behind fetch ─────────────────────────────────────────── */
function world({ lastInboundAgoMs = HOUR, graph = { ok: true, body: { recipient_id: 'PSID_1', message_id: 'm_meta_1' } }, rpcOk = true } = {}) {
  const calls = [];
  const w = { calls, rpc: [], patches: [], graphCalls: [] };
  w.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (url.endsWith('/auth/v1/user')) {
      const auth = opts.headers && opts.headers.Authorization;
      if (auth === 'Bearer staff-token') return json(200, { id: 'uid-staff' });
      if (auth === 'Bearer kiki-token') return json(200, { id: 'uid-kiki' });
      if (auth === 'Bearer inactive-token') return json(200, { id: 'uid-inactive' });
      return json(401, { msg: 'invalid JWT' });
    }
    if (url.includes('/rest/v1/employees?')) {
      // require-user filters active=is.true server-side; the inactive user's row is filtered out.
      if (url.includes('auth_user_id=eq.uid-staff') && url.includes('active=is.true')) return json(200, [EMP]);
      return json(200, []);
    }
    if (url.includes('/rest/v1/social_threads?') && (!opts.method || opts.method === 'GET')) {
      if (!url.includes(`id=eq.${THREAD}`)) return json(200, []);
      return json(200, [{ id: THREAD, channel: 'facebook', page_id: '821690607890680', psid: 'PSID_1',
        last_inbound_at: lastInboundAgoMs == null ? null : new Date(Date.now() - lastInboundAgoMs).toISOString() }]);
    }
    if (url.includes('/rest/v1/social_threads?') && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      w.patches.push({ url, body });
      return json(200, [{ id: THREAD, ...body }]);
    }
    if (url.includes('/rest/v1/customers?')) {
      if (url.includes(`id=eq.${CUST}`)) return json(200, [{ id: CUST, name: 'Maria Lopez', archived_at: null, merged_into: null }]);
      if (url.includes(`id=eq.${MERGED}`)) return json(200, [{ id: MERGED, name: 'Maria L', archived_at: '2026-09-01T00:00:00Z', merged_into: CUST }]);
      return json(200, []);
    }
    if (url.endsWith('/rest/v1/rpc/social_record_message')) {
      const p = JSON.parse(opts.body);
      w.rpc.push(p);
      if (!rpcOk) return json(500, {});
      return json(200, [{ thread_id: THREAD, message_id: 'msg-row-1', inserted: true }]);
    }
    if (url.startsWith('https://graph.facebook.com/')) {
      w.graphCalls.push({ url, opts });
      if (graph.throws) throw new Error('timeout');
      return json(graph.ok ? 200 : 400, graph.body);
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

async function call(body, { token = 'staff-token', w = world(), env = {}, method = 'POST' } = {}) {
  const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'META_PAGE_ACCESS_TOKEN', 'META_SEND_MODE', 'VERCEL_ENV'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  const savedConsole = { error: console.error, warn: console.warn };
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { SUPABASE_URL: 'https://sandbox.example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' }, env);
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

const reply = (text = 'Your truck is ready at 4') => ({ action: 'reply', thread_id: THREAD, text });
const TOKEN_ENV = { META_PAGE_ACCESS_TOKEN: 'page-token' };

/* ── 1. Who ─────────────────────────────────────────────────────────────── */

test('401 with no token, a junk token, a KiKi login (no employees row), an inactive employee — nothing read', async () => {
  for (const token of [null, 'junk', 'kiki-token', 'inactive-token']) {
    const { res, w } = await call(reply(), { token, env: TOKEN_ENV });
    assert.equal(res.statusCode, 401, `token ${token}`);
    assert.deepEqual(res.body, { error: 'unauthorized' });
    assert.ok(!w.calls.some((c) => c.url.includes('social_') || c.url.includes('customers') || c.url.includes('graph.facebook')), `token ${token} reached data`);
  }
});

test('405 for anything but POST; 400 for a bad body (after auth)', async () => {
  assert.equal((await call(reply(), { method: 'GET' })).res.statusCode, 405);
  assert.equal((await call({ action: 'nuke', thread_id: THREAD })).res.statusCode, 400);
  assert.equal((await call({ action: 'done', thread_id: 'not-a-uuid' })).res.statusCode, 400);
});

test('404 for a thread that does not exist', async () => {
  const { res } = await call({ action: 'done', thread_id: '99999999-9999-4999-8999-999999999999' });
  assert.equal(res.statusCode, 404);
});

/* ── 2. Reply ───────────────────────────────────────────────────────────── */

test('reply: window closed (25h) → 409 plain-English reason, Meta never called, nothing stored', async () => {
  const w = world({ lastInboundAgoMs: 25 * HOUR });
  const { res } = await call(reply(), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'window_closed');
  assert.match(res.body.message, /within 24 hours/);
  assert.equal(w.graphCalls.length, 0);
  assert.equal(w.rpc.length, 0);
});

test('reply: no customer message at all → 409', async () => {
  const w = world({ lastInboundAgoMs: null });
  const { res } = await call(reply(), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 409);
  assert.equal(w.graphCalls.length, 0);
});

test('reply: sent → Send API with RESPONSE + token in the header, stored as crisdata / sent / sent_by', async () => {
  const w = world();
  const { res } = await call(reply('  Ready at 4  '), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 200);
  assert.equal(w.graphCalls.length, 1);
  const g = w.graphCalls[0];
  assert.equal(g.url, 'https://graph.facebook.com/v26.0/821690607890680/messages');
  assert.ok(!g.url.includes('page-token'));
  assert.equal(g.opts.headers.Authorization, 'Bearer page-token');
  assert.deepEqual(JSON.parse(g.opts.body), { recipient: { id: 'PSID_1' }, messaging_type: 'RESPONSE', message: { text: 'Ready at 4' } });
  assert.equal(w.rpc.length, 1);
  const p = w.rpc[0];
  assert.equal(p.p_mid, 'm_meta_1');
  assert.equal(p.p_direction, 'out');
  assert.equal(p.p_is_echo, false);
  assert.equal(p.p_source, 'crisdata');
  assert.equal(p.p_sent_by, EMP.id);
  assert.equal(p.p_send_status, 'sent');
  assert.equal(res.body.message.mid, 'm_meta_1');
  assert.equal(w.patches.length, 0, 'reply must not touch the thread row');
});

test('reply: dry-run → full path with a dryrun: mid, Meta NEVER called (even with a token)', async () => {
  const w = world();
  const { res } = await call(reply(), { w, env: { META_SEND_MODE: 'dry-run', VERCEL_ENV: 'preview', ...TOKEN_ENV } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dry_run, true);
  assert.equal(w.graphCalls.length, 0);
  assert.equal(w.rpc.length, 1);
  assert.match(w.rpc[0].p_mid, /^dryrun:[0-9a-f-]{36}$/);
  assert.equal(w.rpc[0].p_send_status, 'sent');
  assert.equal(w.rpc[0].p_sent_by, EMP.id);
});

test('reply: dry-run still enforces the window', async () => {
  const w = world({ lastInboundAgoMs: 30 * HOUR });
  const { res } = await call(reply(), { w, env: { META_SEND_MODE: 'dry-run', VERCEL_ENV: 'preview' } });
  assert.equal(res.statusCode, 409);
  assert.equal(w.rpc.length, 0);
});

test('reply: dry-run on a PRODUCTION deployment is refused — nothing stored, nothing sent', async () => {
  const w = world();
  const { res } = await call(reply(), { w, env: { META_SEND_MODE: 'dry-run', VERCEL_ENV: 'production', ...TOKEN_ENV } });
  assert.equal(res.statusCode, 500);
  assert.equal(w.rpc.length, 0);
  assert.equal(w.graphCalls.length, 0);
});

test('reply: no META_PAGE_ACCESS_TOKEN → 503 "not connected", nothing stored', async () => {
  const w = world();
  const { res } = await call(reply(), { w });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'not_connected');
  assert.match(res.body.message, /isn't connected/);
  assert.equal(w.rpc.length, 0);
});

test('reply: Meta refuses → stored as FAILED under a local: mid with Meta\'s message, error returned, no retry', async () => {
  const w = world({ graph: { ok: false, body: { error: { message: '(#100) Something odd', code: 100 } } } });
  const { res } = await call(reply(), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'send_failed');
  assert.match(res.body.message, /Something odd/);
  assert.equal(w.graphCalls.length, 1, 'no automatic retry');
  assert.equal(w.rpc.length, 1);
  assert.match(w.rpc[0].p_mid, /^local:[0-9a-f-]{36}$/);
  assert.equal(w.rpc[0].p_send_status, 'failed');
  assert.match(w.rpc[0].p_send_error, /Something odd/);
  assert.equal(res.body.message_row.send_status, 'failed');
});

test('reply: code 190 → "Facebook connection expired", stored as failed', async () => {
  const w = world({ graph: { ok: false, body: { error: { message: 'Error validating access token', code: 190, error_subcode: 463 } } } });
  const { res } = await call(reply(), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'token_expired');
  assert.match(res.body.message, /Facebook connection expired/);
  assert.equal(w.rpc[0].p_send_status, 'failed');
});

test('reply: Facebook unreachable → failed, with a "may not have been sent" warning', async () => {
  const w = world({ graph: { throws: true } });
  const { res } = await call(reply(), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.message, /may not have been sent/);
  assert.equal(w.rpc[0].p_send_status, 'failed');
});

test('reply: sent but the store failed → still 200, with a warning (the echo will fill it in)', async () => {
  const w = world({ rpcOk: false });
  const { res } = await call(reply(), { w, env: TOKEN_ENV });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.warning, /Sent to Facebook/);
});

/* ── 3. Link / Done touch only their own columns ───────────────────────── */

test('link: an active customer → PATCH exactly customer_id / linked_at / linked_by', async () => {
  const w = world();
  const { res } = await call({ action: 'link', thread_id: THREAD, customer_id: CUST }, { w });
  assert.equal(res.statusCode, 200);
  assert.equal(w.patches.length, 1);
  assert.deepEqual(Object.keys(w.patches[0].body).sort(), ['customer_id', 'linked_at', 'linked_by']);
  assert.equal(w.patches[0].body.customer_id, CUST);
  assert.equal(w.patches[0].body.linked_by, EMP.id);
  assert.ok(w.patches[0].url.includes(`id=eq.${THREAD}`));
  assert.equal(res.body.customer.name, 'Maria Lopez');
  assert.equal(w.rpc.length, 0);
});

test('link: a merged / archived customer → 409 with the survivor, nothing written', async () => {
  const w = world();
  const { res } = await call({ action: 'link', thread_id: THREAD, customer_id: MERGED }, { w });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'customer_archived');
  assert.equal(res.body.merged_into, CUST);
  assert.equal(w.patches.length, 0);
});

test('link: an unknown customer → 404, nothing written; customer_id missing → 400', async () => {
  const w = world();
  const { res } = await call({ action: 'link', thread_id: THREAD, customer_id: '55555555-5555-4555-8555-555555555555' }, { w });
  assert.equal(res.statusCode, 404);
  assert.equal(w.patches.length, 0);
  assert.equal((await call({ action: 'link', thread_id: THREAD })).res.statusCode, 400);
});

test('unlink: customer_id null → PATCH the three link columns to null, nothing else', async () => {
  const w = world();
  const { res } = await call({ action: 'link', thread_id: THREAD, customer_id: null }, { w });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.patches[0].body, { customer_id: null, linked_at: null, linked_by: null });
});

test('done: PATCH exactly done_at / done_by', async () => {
  const w = world();
  const { res } = await call({ action: 'done', thread_id: THREAD }, { w });
  assert.equal(res.statusCode, 200);
  assert.equal(w.patches.length, 1);
  assert.deepEqual(Object.keys(w.patches[0].body).sort(), ['done_at', 'done_by']);
  assert.equal(w.patches[0].body.done_by, EMP.id);
  assert.equal(w.rpc.length, 0);
  assert.equal(w.graphCalls.length, 0);
});

/* ── 4. Pure helpers ────────────────────────────────────────────────────── */

test('replyWindow: open just inside 24h, closed just past it', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  assert.equal(replyWindow(new Date(now - WINDOW_MS + 60_000).toISOString(), now).open, true);
  assert.equal(replyWindow(new Date(now - WINDOW_MS - 60_000).toISOString(), now).open, false);
  assert.equal(replyWindow(null, now).open, false);
  assert.equal(replyWindow('garbage', now).open, false);
});

test('parseBody: trims, caps at 2000 characters, rejects empty text', () => {
  assert.equal(parseBody({ action: 'reply', thread_id: THREAD, text: '  hi  ' }).text, 'hi');
  assert.equal(parseBody({ action: 'reply', thread_id: THREAD, text: '   ' }).ok, false);
  assert.equal(parseBody({ action: 'reply', thread_id: THREAD, text: 'x'.repeat(2001) }).ok, false);
  assert.equal(parseBody({ action: 'link', thread_id: THREAD, customer_id: 'nope' }).ok, false);
  assert.equal(parseBody(null).ok, false);
});

test('metaErrorMessage: 190, outside-window, unavailable, generic, junk', () => {
  assert.match(metaErrorMessage({ error: { code: 190 } }).message, /connection expired/);
  assert.match(metaErrorMessage({ error: { code: 10, error_subcode: 2018278 } }).message, /24 hours/);
  assert.match(metaErrorMessage({ error: { code: 551 } }).message, /isn't available/);
  assert.match(metaErrorMessage({ error: { code: 100, message: 'Bad param' } }).message, /Bad param/);
  assert.doesNotThrow(() => metaErrorMessage(null));
  assert.doesNotThrow(() => metaErrorMessage('x'));
});
