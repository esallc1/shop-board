/* ============================================================
   meta-webhook-store.test.js — the webhook's STORAGE half (Messenger step 2).
   Run: npm test   (node --test)

   Locks: which Messenger events become rows (and which are only counted), how
   an echo is classified (our app → crisdata, anything else → page_inbox), that
   every signed delivery still answers 200 — DB down, fetch throwing, no key —
   that a bad signature writes nothing, that a re-delivered mid is written once,
   that the name lookup only runs for a NEW inbound with a token set, and that
   the log line never carries message text, a PSID or a name.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import handler, { parseMessagingEvents, storeRows, SHOP_PAGE_ID, CRISDATA_APP_ID } from './meta-webhook.js';

const SECRET = 'test-app-secret-not-the-real-one';
const PAGE = SHOP_PAGE_ID;
const INBOX_APP = '263902037430900'; // Meta's Page inbox app — any id but ours

const sign = (body, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

const inbound = (psid, mid, text, ts = 1758650000000, extra = {}) =>
  ({ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid, text, ...extra } });
const echo = (psid, mid, text, appId, ts = 1758650060000) =>
  ({ sender: { id: PAGE }, recipient: { id: psid }, timestamp: ts,
     message: { mid, text, is_echo: true, ...(appId ? { app_id: Number(appId) } : {}) } });
const body = (...messaging) => ({ object: 'page', entry: [{ id: PAGE, time: 1758650000000, messaging }] });

/* ── 1. The parser ──────────────────────────────────────────────────────── */

test('parse: a customer text → one inbound customer row', () => {
  const { rows, skipped } = parseMessagingEvents(body(inbound('PSID_1', 'm_1', 'is my truck ready?')));
  assert.deepEqual(skipped, {});
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    channel: 'facebook', page_id: PAGE, psid: 'PSID_1', mid: 'm_1', direction: 'in', is_echo: false,
    source: 'customer', app_id: null, text: 'is my truck ready?', attachments: [],
    sent_at: new Date(1758650000000).toISOString(),
  });
});

test('parse: an attachment keeps metadata only (type, url, sticker id, title)', () => {
  const { rows } = parseMessagingEvents(body(inbound('PSID_1', 'm_2', undefined, 1758650000000, {
    attachments: [
      { type: 'image', payload: { url: 'https://cdn.example/x.jpg', sticker_id: 369239263222822 } },
      { type: 'fallback', title: 'A link', payload: null },
      'junk',
    ],
  })));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, null);
  assert.deepEqual(rows[0].attachments, [
    { type: 'image', url: 'https://cdn.example/x.jpg', sticker_id: '369239263222822' },
    { type: 'fallback', title: 'A link' },
  ]);
});

test('parse: an echo of OUR app\'s send → out / crisdata, PSID taken from the recipient', () => {
  const { rows } = parseMessagingEvents(body(echo('PSID_1', 'm_3', 'Yes, ready at 4', CRISDATA_APP_ID)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].psid, 'PSID_1');
  assert.equal(rows[0].direction, 'out');
  assert.equal(rows[0].is_echo, true);
  assert.equal(rows[0].source, 'crisdata');
  assert.equal(rows[0].app_id, CRISDATA_APP_ID);
});

test('parse: an echo typed in Business Suite (other app id, or none) → page_inbox', () => {
  const a = parseMessagingEvents(body(echo('PSID_1', 'm_4', 'from Daiana', INBOX_APP))).rows[0];
  const b = parseMessagingEvents(body(echo('PSID_1', 'm_5', 'no app id', null))).rows[0];
  assert.equal(a.source, 'page_inbox');
  assert.equal(a.app_id, INBOX_APP);
  assert.equal(b.source, 'page_inbox');
  assert.equal(b.app_id, null);
});

test('parse: another Page\'s entry, or an event not addressed to our Page, is skipped', () => {
  const foreignEntry = { object: 'page', entry: [{ id: '999', messaging: [inbound('P', 'm_x', 'hi')] }] };
  assert.deepEqual(parseMessagingEvents(foreignEntry), { rows: [], skipped: { 'foreign-page': 1 } });
  const wrongRecipient = body({ sender: { id: 'P' }, recipient: { id: '999' }, message: { mid: 'm_y', text: 'hi' } });
  assert.deepEqual(parseMessagingEvents(wrongRecipient), { rows: [], skipped: { 'foreign-page': 1 } });
  const wrongEchoSender = body({ sender: { id: '999' }, recipient: { id: 'P' }, message: { mid: 'm_z', is_echo: true } });
  assert.deepEqual(parseMessagingEvents(wrongEchoSender).rows, []);
});

test('parse: delivery / read / reaction / postback / deleted / no-mid are counted, not stored', () => {
  const { rows, skipped } = parseMessagingEvents(body(
    { sender: { id: 'P' }, recipient: { id: PAGE }, delivery: { mids: ['m_1'], watermark: 1 } },
    { sender: { id: 'P' }, recipient: { id: PAGE }, read: { watermark: 1 } },
    { sender: { id: 'P' }, recipient: { id: PAGE }, reaction: { mid: 'm_1', action: 'react', emoji: '👍' } },
    { sender: { id: 'P' }, recipient: { id: PAGE }, postback: { payload: 'X' } },
    { sender: { id: 'P' }, recipient: { id: PAGE }, message: { mid: 'm_d', is_deleted: true } },
    { sender: { id: 'P' }, recipient: { id: PAGE }, message: { text: 'no mid' } },
  ));
  assert.deepEqual(rows, []);
  assert.deepEqual(skipped, { delivery: 1, read: 1, reaction: 1, postback: 1, deleted: 1, 'no-mid': 1 });
});

test('parse: a batch keeps delivery order across events and entries', () => {
  const b = {
    object: 'page',
    entry: [
      { id: PAGE, messaging: [inbound('A', 'm_a1', 'one'), echo('A', 'm_a2', 'two', INBOX_APP)] },
      { id: '999', messaging: [inbound('Z', 'm_z1', 'foreign')] },
      { id: PAGE, messaging: [inbound('B', 'm_b1', 'three')] },
    ],
  };
  const { rows, skipped } = parseMessagingEvents(b);
  assert.deepEqual(rows.map((r) => r.mid), ['m_a1', 'm_a2', 'm_b1']);
  assert.deepEqual(skipped, { 'foreign-page': 1 });
});

test('parse: junk never throws', () => {
  for (const junk of [null, undefined, 'x', 42, {}, { object: 'instagram' }, { object: 'page', entry: 'x' }, { object: 'page', entry: [null, 5] }]) {
    assert.doesNotThrow(() => parseMessagingEvents(junk));
  }
  assert.deepEqual(parseMessagingEvents({ object: 'user' }).skipped, { 'not-page-object': 1 });
});

/* ── 2. A fake PostgREST: social_record_message with a unique mid ───────── */

function fakeDb({ failRpc = false, throwRpc = false, graphName = { first_name: 'Maria', last_name: 'Lopez' } } = {}) {
  const threads = new Map();   // key → { id, display_name }
  const mids = new Set();
  const calls = [];
  async function fetchImpl(url, opts = {}) {
    calls.push({ url, opts });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.includes('/rest/v1/rpc/social_record_message')) {
      if (throwRpc) throw new Error('network down');
      if (failRpc) return { ok: false, status: 500, json: async () => ({}) };
      const p = JSON.parse(opts.body);
      const key = `${p.p_channel}|${p.p_page_id}|${p.p_psid}`;
      if (!threads.has(key)) threads.set(key, { id: `t_${threads.size + 1}`, display_name: null });
      const t = threads.get(key);
      const inserted = !mids.has(p.p_mid);
      mids.add(p.p_mid);
      return ok([{ thread_id: t.id, message_id: `msg_${p.p_mid}`, inserted }]);
    }
    if (url.includes('/rest/v1/social_threads?') && (!opts.method || opts.method === 'GET')) {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]);
      const t = [...threads.values()].find((x) => x.id === id);
      return ok(t ? [{ display_name: t.display_name }] : []);
    }
    if (url.includes('/rest/v1/social_threads?') && opts.method === 'PATCH') {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]);
      const t = [...threads.values()].find((x) => x.id === id);
      if (t && t.display_name == null && url.includes('display_name=is.null')) t.display_name = JSON.parse(opts.body).display_name;
      return { ok: true, status: 204, json: async () => null };
    }
    if (url.startsWith('https://graph.facebook.com/')) return ok(graphName);
    throw new Error('unexpected fetch ' + url);
  }
  return { fetchImpl, threads, mids, calls };
}

const ENV = { SUPABASE_URL: 'https://sandbox.example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

test('store: each row is one RPC with the service key; a re-delivered mid is a duplicate', async () => {
  const db = fakeDb();
  const { rows } = parseMessagingEvents(body(inbound('PSID_1', 'm_1', 'hi'), inbound('PSID_1', 'm_2', 'again')));
  const first = await storeRows(rows, { fetchImpl: db.fetchImpl, env: ENV });
  const five = (o) => ({ inserted: o.inserted, duplicate: o.duplicate, errors: o.errors, named: o.named, nameErrors: o.nameErrors });
  assert.deepEqual(five(first), { inserted: 2, duplicate: 0, errors: 0, named: 0, nameErrors: 0 });
  const rpc = db.calls.filter((c) => c.url.endsWith('/rest/v1/rpc/social_record_message'));
  assert.equal(rpc.length, 2);
  assert.equal(rpc[0].url, 'https://sandbox.example.supabase.co/rest/v1/rpc/social_record_message');
  assert.equal(rpc[0].opts.headers.Authorization, 'Bearer service-key');
  assert.equal(JSON.parse(rpc[0].opts.body).p_mid, 'm_1');

  const again = await storeRows(rows, { fetchImpl: db.fetchImpl, env: ENV });
  assert.deepEqual(five(again), { inserted: 0, duplicate: 2, errors: 0, named: 0, nameErrors: 0 });
  assert.equal(db.mids.size, 2);
  assert.equal(db.threads.size, 1);
});

test('store: no service key → nothing fetched, counted as errors, never throws', async () => {
  const db = fakeDb();
  const { rows } = parseMessagingEvents(body(inbound('P', 'm_1', 'hi')));
  const out = await storeRows(rows, { fetchImpl: db.fetchImpl, env: { SUPABASE_URL: ENV.SUPABASE_URL } });
  assert.equal(out.errors, 1);
  assert.equal(db.calls.length, 0);
});

test('store: an RPC error or a thrown fetch is counted, never thrown', async () => {
  const { rows } = parseMessagingEvents(body(inbound('P', 'm_1', 'hi'), inbound('P', 'm_2', 'yo')));
  const a = await storeRows(rows, { fetchImpl: fakeDb({ failRpc: true }).fetchImpl, env: ENV });
  assert.equal(a.errors, 2);
  const b = await storeRows(rows, { fetchImpl: fakeDb({ throwRpc: true }).fetchImpl, env: ENV });
  assert.equal(b.errors, 2);
});

test('name: no META_PAGE_ACCESS_TOKEN → no Graph call and no name', async () => {
  const db = fakeDb();
  const { rows } = parseMessagingEvents(body(inbound('PSID_1', 'm_1', 'hi')));
  const out = await storeRows(rows, { fetchImpl: db.fetchImpl, env: ENV });
  assert.equal(out.named, 0);
  assert.ok(!db.calls.some((c) => c.url.includes('graph.facebook.com')));
  assert.equal([...db.threads.values()][0].display_name, null);
});

test('name: with a token, a NEW inbound fills an empty name once — bearer header, fill-if-null PATCH', async () => {
  const db = fakeDb();
  const env = { ...ENV, META_PAGE_ACCESS_TOKEN: 'page-token' };
  const { rows } = parseMessagingEvents(body(inbound('PSID_1', 'm_1', 'hi'), inbound('PSID_1', 'm_2', 'again')));
  const out = await storeRows(rows, { fetchImpl: db.fetchImpl, env });
  assert.equal(out.named, 1);
  assert.equal([...db.threads.values()][0].display_name, 'Maria Lopez');
  const graph = db.calls.filter((c) => c.url.includes('graph.facebook.com'));
  assert.equal(graph.length, 1);                                   // 2nd message: name already there
  assert.ok(!graph[0].url.includes('page-token'), 'token must not be in the URL');
  assert.equal(graph[0].opts.headers.Authorization, 'Bearer page-token');
  const patch = db.calls.find((c) => c.opts.method === 'PATCH');
  assert.ok(patch.url.includes('display_name=is.null'));
});

test('name: never looked up for an echo or a duplicate', async () => {
  const db = fakeDb();
  const env = { ...ENV, META_PAGE_ACCESS_TOKEN: 'page-token' };
  await storeRows(parseMessagingEvents(body(echo('PSID_9', 'm_e', 'hello', INBOX_APP))).rows, { fetchImpl: db.fetchImpl, env });
  assert.ok(!db.calls.some((c) => c.url.includes('graph.facebook.com')));
  db.mids.add('m_dup');
  await storeRows(parseMessagingEvents(body(inbound('PSID_9', 'm_dup', 'x'))).rows, { fetchImpl: db.fetchImpl, env });
  assert.ok(!db.calls.some((c) => c.url.includes('graph.facebook.com')));
});

/* ── 3. The handler end to end (global fetch stubbed) ───────────────────── */

function mockReq(raw, headers) {
  const req = Readable.from([Buffer.from(raw, 'utf8')]);
  req.method = 'POST'; req.url = '/api/meta-webhook'; req.headers = headers;
  return req;
}
function mockRes() {
  return { statusCode: null, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; } };
}

async function post(raw, { sig = sign(raw), db = fakeDb(), env = ENV } = {}) {
  const keys = ['META_APP_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'META_PAGE_ACCESS_TOKEN', 'META_PAGE_ID'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  const logs = [];
  const savedLog = { log: console.log, error: console.error, warn: console.warn };
  for (const k of keys) delete process.env[k];
  process.env.META_APP_SECRET = SECRET;
  Object.assign(process.env, env);
  globalThis.fetch = db.fetchImpl;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  const res = mockRes();
  try {
    await handler(mockReq(raw, sig ? { 'x-hub-signature-256': sig } : {}), res);
  } finally {
    globalThis.fetch = savedFetch;
    Object.assign(console, savedLog);
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { res, db, logs };
}

test('handler: a BAD signature → 403 and nothing is written', async () => {
  const raw = JSON.stringify(body(inbound('PSID_1', 'm_1', 'hi')));
  const { res, db } = await post(raw, { sig: sign(raw, 'wrong-secret') });
  assert.equal(res.statusCode, 403);
  assert.equal(db.calls.length, 0);
});

test('handler: a signed delivery is stored and answered 200; the same delivery again writes no new mid', async () => {
  const db = fakeDb();
  const raw = JSON.stringify(body(inbound('PSID_1', 'm_1', 'hi'), echo('PSID_1', 'm_2', 'hey', INBOX_APP)));
  const first = await post(raw, { db });
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.res.body, 'EVENT_RECEIVED');
  const second = await post(raw, { db });
  assert.equal(second.res.statusCode, 200);
  assert.equal(db.mids.size, 2);
  const line = second.logs.find((l) => l.startsWith('[meta-webhook] {'));
  const j = JSON.parse(line.slice('[meta-webhook] '.length));
  assert.equal(j.rows, 2);
  assert.equal(j.inserted, 0);
  assert.equal(j.duplicate, 2);
});

test('handler: the database failing still answers 200 (logged, never 500)', async () => {
  const raw = JSON.stringify(body(inbound('PSID_1', 'm_1', 'hi')));
  const a = await post(raw, { db: fakeDb({ failRpc: true }) });
  assert.equal(a.res.statusCode, 200);
  const b = await post(raw, { db: fakeDb({ throwRpc: true }) });
  assert.equal(b.res.statusCode, 200);
  const c = await post(raw, { env: { SUPABASE_URL: ENV.SUPABASE_URL } }); // no service key
  assert.equal(c.res.statusCode, 200);
});

test('handler: foreign page / receipts only → 200, no write, reasons counted', async () => {
  const raw = JSON.stringify({ object: 'page', entry: [
    { id: '999', messaging: [inbound('Z', 'm_z', 'x')] },
    { id: PAGE, messaging: [{ sender: { id: 'P' }, recipient: { id: PAGE }, read: { watermark: 1 } }] },
  ] });
  const { res, db, logs } = await post(raw);
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.length, 0);
  const j = JSON.parse(logs.find((l) => l.startsWith('[meta-webhook] {')).slice(15));
  assert.deepEqual(j.skipped, { 'foreign-page': 1, read: 1 });
});

test('handler: the log never carries message text, PSIDs, names or attachment URLs', async () => {
  const raw = JSON.stringify(body(
    inbound('PSID_SECRET_123', 'm_1', 'my card is 4111 1111', 1758650000000,
      { attachments: [{ type: 'image', payload: { url: 'https://cdn.example/private.jpg' } }] }),
  ));
  const { logs } = await post(raw, { env: { ...ENV, META_PAGE_ACCESS_TOKEN: 'page-token' } });
  const all = logs.join('\n');
  for (const secret of ['4111', 'PSID_SECRET_123', 'Maria', 'Lopez', 'private.jpg', 'page-token']) {
    assert.ok(!all.includes(secret), `log leaked ${secret}`);
  }
});
