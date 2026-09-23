/* ============================================================
   meta-webhook-autoreply.test.js — the after-hours auto-reply (meta-webhook.md §12).
   Run: npm test   (node --test)

   Locks, against a fake PostgREST + Graph: a closed-hours inbound sends ONE
   reply (Send API, RESPONSE, our metadata) and records it out + auto; a second
   inbound in the same stretch doesn't; a staff reply blocks it; open hours /
   switch off / settings unreadable send nothing; dry-run never calls Graph and
   is refused on production; a failed send is recorded failed and the claim
   released; the echo of our auto-reply is marked auto (not staff) and never
   stored twice; a typed phone lands on the thread; the waiting clock is
   untouched; every signed delivery still answers 200.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import handler, { parseMessagingEvents, storeRows, SHOP_PAGE_ID, CRISDATA_APP_ID } from './meta-webhook.js';

const PAGE = SHOP_PAGE_ID;
const HOUR = 3600e3;
const ENV = { SUPABASE_URL: 'https://sandbox.example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', META_PAGE_ACCESS_TOKEN: 'page-token' };

// Real-clock fixtures (the webhook decides by the message's own time, clamped
// to now, within Meta's 24 h window): a CLOSED minute with closed time 2 h
// either side (there is always one in the last 20 h — every night), and an
// OPEN minute if the last 20 h had one (not on a weekend run).
import { isShopOpen } from '../shared/shop-hours.js';
function recent(open) {
  const now = Date.now();
  const closedAround = (t) => [-2, -1, 0, 1, 2].every((h) => !isShopOpen(t + h * HOUR));
  for (let t = now - (open ? 5 * 60e3 : 2 * HOUR); t > now - 20 * HOUR; t -= 15 * 60e3)
    if (open ? isShopOpen(t) : closedAround(t)) return t;
  return null;
}
const CLOSED_AT = recent(false);

const inbound = (psid, mid, text, ts = CLOSED_AT) =>
  ({ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid, text } });
const echo = (psid, mid, text, { appId = CRISDATA_APP_ID, metadata, ts = CLOSED_AT + 60e3 } = {}) =>
  ({ sender: { id: PAGE }, recipient: { id: psid }, timestamp: ts,
     message: { mid, text, is_echo: true, app_id: Number(appId), ...(metadata ? { metadata } : {}) } });
const body = (...messaging) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging }] });
const rowsOf = (...m) => parseMessagingEvents(body(...m)).rows;

let graphN = 0;
function fakeDb({ settings = { fb_auto_reply_on: true, fb_auto_reply_text: null, shop_closed_on: null }, settingsFail = false,
  graph = (p) => ({ ok: true, status: 200, json: async () => ({ recipient_id: p.recipient.id, message_id: 'm_auto_' + (++graphN) }) }) } = {}) {
  graphN = 0;
  const threads = new Map();   // id → row
  const msgs = [];             // { mid, thread_id, direction, source, auto, send_status, sent_at, text }
  const sends = [];
  async function fetchImpl(url, opts = {}) {
    const ok = (data, status = 200) => ({ ok: true, status, json: async () => data });
    const method = opts.method || 'GET';
    if (url.includes('/rpc/social_record_message')) {
      const p = JSON.parse(opts.body);
      let t = [...threads.values()].find((x) => x.psid === p.p_psid);
      if (!t) { t = { id: 't_' + (threads.size + 1), psid: p.p_psid, last_auto_reply_at: null, detected_phone: null,
        last_inbound_received_at: null }; threads.set(t.id, t); }
      const dup = msgs.find((m) => m.mid === p.p_mid);
      if (!dup) {
        msgs.push({ mid: p.p_mid, thread_id: t.id, direction: p.p_direction, source: p.p_source, auto: false,
          send_status: p.p_send_status || null, sent_at: p.p_sent_at, text: p.p_text });
        if (p.p_direction === 'in') t.last_inbound_received_at = new Date().toISOString();
      }
      return ok([{ thread_id: t.id, message_id: 'x', inserted: !dup }]);
    }
    if (url.includes('/rest/v1/shop_settings?')) {
      if (settingsFail) return { ok: false, status: 400, json: async () => ({}) };
      return ok([settings]);
    }
    const idOf = () => decodeURIComponent(/id=eq\.([^&]+)/.exec(url)[1]);
    if (url.includes('/rest/v1/social_threads?') && method === 'GET') {
      const t = threads.get(idOf());
      return ok(t ? [{ ...t }] : []);
    }
    if (url.includes('/rest/v1/social_threads?') && method === 'PATCH') {
      const t = threads.get(idOf());
      const patch = JSON.parse(opts.body);
      if (url.includes('&or=')) {   // the atomic claim
        const orf = decodeURIComponent(/&or=([^&]+)/.exec(url)[1]);
        const bound = Date.parse(/lt\."([^"]+)"/.exec(orf)[1]);
        const free = t && (t.last_auto_reply_at == null || Date.parse(t.last_auto_reply_at) < bound);
        if (!free) return ok([]);
        Object.assign(t, patch);
        return ok([{ id: t.id }]);
      }
      if (t) Object.assign(t, patch);
      return ok(null, 204);
    }
    if (url.includes('/rest/v1/social_messages?') && method === 'GET') {
      const tid = decodeURIComponent(/thread_id=eq\.([^&]+)/.exec(url)[1]);
      const out = msgs.filter((m) => m.thread_id === tid && m.direction === 'out' && !m.auto)
        .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
      return ok(out.slice(0, 1).map((m) => ({ sent_at: m.sent_at })));
    }
    if (url.includes('/rest/v1/social_messages?') && method === 'PATCH') {
      const mid = decodeURIComponent(/mid=eq\.([^&]+)/.exec(url)[1]);
      for (const m of msgs) if (m.mid === mid) Object.assign(m, JSON.parse(opts.body));
      return ok(null, 204);
    }
    if (url.startsWith('https://graph.facebook.com/') && url.endsWith('/messages')) {
      const p = JSON.parse(opts.body);
      sends.push({ url, p, auth: opts.headers.Authorization });
      return graph(p);
    }
    if (url.startsWith('https://graph.facebook.com/')) return ok({ first_name: 'Ana', last_name: 'Diaz' });
    throw new Error('unexpected fetch ' + method + ' ' + url);
  }
  return { fetchImpl, threads, msgs, sends };
}
const store = (db, rows, env = ENV) => storeRows(rows, { fetchImpl: db.fetchImpl, env });
const autoMsgs = (db) => db.msgs.filter((m) => m.auto);

test('closed-hours inbound → ONE reply: Send API, RESPONSE, our metadata; recorded out + auto', async () => {
  const db = fakeDb();
  const out = await store(db, rowsOf(inbound('PSID_A', 'm_in_1', 'hello, are you open?')));
  assert.equal(out.autoSent, 1);
  assert.equal(db.sends.length, 1);
  const s = db.sends[0];
  assert.equal(s.url, `https://graph.facebook.com/v21.0/${PAGE}/messages`.replace('v21.0', s.url.split('/')[3]));
  assert.equal(s.p.messaging_type, 'RESPONSE');
  assert.equal(s.p.recipient.id, 'PSID_A');
  assert.equal(s.p.message.metadata, 'crisdata:auto');
  assert.ok(s.p.message.text.startsWith('Thanks for messaging Lee Transmission!'));
  assert.equal(s.auth, 'Bearer page-token');
  const a = autoMsgs(db);
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].mid, a[0].direction, a[0].source, a[0].send_status], ['m_auto_1', 'out', 'crisdata', 'sent']);
  assert.ok(db.threads.get('t_1').last_auto_reply_at);
});

test('a second inbound in the same stretch → no second reply', async () => {
  const db = fakeDb();
  await store(db, rowsOf(inbound('PSID_A', 'm_in_1', 'hi')));
  const out = await store(db, rowsOf(inbound('PSID_A', 'm_in_2', 'hello??', CLOSED_AT + 10 * 60e3)));
  assert.equal(out.autoSent, 0);
  assert.deepEqual(out.autoSkipped, { 'already-replied-this-stretch': 1 });
  assert.equal(db.sends.length, 1);
});

test('the same message delivered twice at once → the claim lets only one send', async () => {
  const db = fakeDb();
  await Promise.all([
    store(db, rowsOf(inbound('PSID_A', 'm_in_1', 'hi'))),
    store(db, rowsOf(inbound('PSID_A', 'm_in_2', 'hi again'))),
  ]);
  assert.equal(db.sends.length, 1);
});

test('staff replied (tray or Business Suite) in this stretch → then an inbound gets no auto-reply', async () => {
  const db = fakeDb();
  await store(db, rowsOf(echo('PSID_B', 'm_staff_1', 'We open at 8!', { appId: '263902037430900', ts: CLOSED_AT - 60e3 })));
  const out = await store(db, rowsOf(inbound('PSID_B', 'm_in_1', 'ok thanks')));
  assert.deepEqual(out.autoSkipped, { 'staff-replied-this-stretch': 1 });
  assert.equal(db.sends.length, 0);
});

test('the echo of our auto-reply: marked auto, stored once, and NOT counted as staff', async () => {
  const db = fakeDb();
  await store(db, rowsOf(inbound('PSID_C', 'm_in_1', 'hi')));
  const e = rowsOf(echo('PSID_C', 'm_auto_1', 'Thanks for messaging…', { metadata: 'crisdata:auto' }));
  assert.equal(e[0].auto, true);
  const out = await store(db, e);
  assert.equal(out.duplicate, 1);
  assert.equal(db.msgs.filter((m) => m.mid === 'm_auto_1').length, 1);
  assert.equal(autoMsgs(db).length, 1);
  // echo landing FIRST (before our record): the row is still marked auto
  const db2 = fakeDb();
  await store(db2, rowsOf(echo('PSID_D', 'm_x', 'Thanks…', { metadata: 'crisdata:auto' })));
  assert.equal(db2.msgs[0].auto, true);
  // next closed stretch: that auto echo did not block anything as "staff"
  db.threads.get('t_1').last_auto_reply_at = new Date(CLOSED_AT - 30 * HOUR).toISOString();
  const again = await store(db, rowsOf(inbound('PSID_C', 'm_in_2', 'still there?', CLOSED_AT + 60e3)));
  assert.equal(again.autoSkipped['staff-replied-this-stretch'], undefined);
});

test('an ordinary tray/Business Suite echo is NOT auto', () => {
  assert.equal(rowsOf(echo('P', 'm1', 'hi', { appId: CRISDATA_APP_ID }))[0].auto, undefined);
  assert.equal(rowsOf(echo('P', 'm2', 'hi', { appId: '263902037430900', metadata: 'something-else' }))[0].auto, undefined);
});

test('the auto-reply never touches the waiting clock (last_inbound_received_at)', async () => {
  const db = fakeDb();
  await store(db, rowsOf(inbound('PSID_E', 'm_in_1', 'hi')));
  const t = db.threads.get('t_1');
  assert.ok(t.last_inbound_received_at);
  assert.equal(autoMsgs(db).length, 1);
  assert.equal('last_inbound_received_at' in t, true);
  // the only thread PATCHes were the claim and nothing that clears waiting
  assert.equal(t.done_at, undefined);
});

test('open hours / switch off / settings unreadable → nothing sent', async () => {
  const openAt = recent(true);
  if (openAt) {
    const db = fakeDb();
    const out = await store(db, rowsOf(inbound('PSID_F', 'm1', 'hi', openAt)));
    assert.deepEqual(out.autoSkipped, { 'shop-open': 1 });
    assert.equal(db.sends.length, 0);
  }
  const off = fakeDb({ settings: { fb_auto_reply_on: false } });
  assert.deepEqual((await store(off, rowsOf(inbound('P', 'm1', 'hi')))).autoSkipped, { 'switched-off': 1 });
  const bad = fakeDb({ settingsFail: true });
  assert.deepEqual((await store(bad, rowsOf(inbound('P', 'm1', 'hi')))).autoSkipped, { 'settings-unavailable': 1 });
  assert.equal(off.sends.length + bad.sends.length, 0);
});

test('"Shop closed today" during open hours → auto-reply', async () => {
  const openAt = recent(true);
  if (!openAt) return;   // no open minute in the last 23 h (a weekend run) — covered by the pure tests
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(openAt));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const db = fakeDb({ settings: { fb_auto_reply_on: true, shop_closed_on: ymd } });
  const out = await store(db, rowsOf(inbound('PSID_G', 'm1', 'hi', openAt)));
  assert.equal(out.autoSent, ymd <= today ? 1 : 0);
});

test('the saved text is sent exactly as typed (accents, blank lines)', async () => {
  const text = 'Cerrado hoy — ¡llámenos mañana!\n\nñandú';
  const db = fakeDb({ settings: { fb_auto_reply_on: true, fb_auto_reply_text: text } });
  await store(db, rowsOf(inbound('P', 'm1', 'hi')));
  assert.equal(db.sends[0].p.message.text, text);
  assert.equal(autoMsgs(db)[0].text, text);
});

test('dry-run: no Graph call, a dryrun: mid recorded auto; refused outright on production', async () => {
  const db = fakeDb();
  const out = await store(db, rowsOf(inbound('P', 'm1', 'hi')), { ...ENV, META_SEND_MODE: 'dry-run', VERCEL_ENV: 'preview' });
  assert.equal(out.autoSent, 1);
  assert.equal(db.sends.length, 0);
  assert.match(autoMsgs(db)[0].mid, /^dryrun:/);
  const prod = fakeDb();
  const p = await store(prod, rowsOf(inbound('P', 'm1', 'hi')), { ...ENV, META_SEND_MODE: 'dry-run', VERCEL_ENV: 'production' });
  assert.deepEqual(p.autoSkipped, { misconfigured: 1 });
  assert.equal(prod.msgs.length, 1);
  assert.equal(prod.threads.get('t_1').last_auto_reply_at, null);   // claim released
});

test('no token → skipped quietly, claim released', async () => {
  const db = fakeDb();
  const { META_PAGE_ACCESS_TOKEN, ...noTok } = ENV;
  const out = await store(db, rowsOf(inbound('P', 'm1', 'hi')), noTok);
  assert.deepEqual(out.autoSkipped, { 'no-token': 1 });
  assert.equal(db.threads.get('t_1').last_auto_reply_at, null);
});

test('Meta refuses the send → recorded failed + auto, claim released, next message tries again', async () => {
  const db = fakeDb({ graph: () => ({ ok: false, status: 400, json: async () => ({ error: { code: 10, message: 'outside window' } }) }) });
  const out = await store(db, rowsOf(inbound('P', 'm1', 'hi')));
  assert.equal(out.autoFailed, 1);
  const a = autoMsgs(db);
  assert.equal(a.length, 1);
  assert.equal(a[0].send_status, 'failed');
  assert.match(a[0].mid, /^local:/);
  assert.equal(db.threads.get('t_1').last_auto_reply_at, null);
});

test('a message older than 24 h (a late re-delivery) never auto-replies', async () => {
  const db = fakeDb();
  const out = await store(db, rowsOf(inbound('P', 'm1', 'hi', Date.now() - 25 * HOUR)));
  assert.deepEqual(out.autoSkipped, { 'reply-window-closed': 1 });
});

test('a re-delivered inbound (duplicate mid) does nothing new', async () => {
  const db = fakeDb();
  await store(db, rowsOf(inbound('P', 'm1', 'hi 239-555-1234')));
  db.threads.get('t_1').last_auto_reply_at = null;   // even if the claim were free
  const out = await store(db, rowsOf(inbound('P', 'm1', 'hi 239-555-1234')));
  assert.equal(out.duplicate, 1);
  assert.equal(out.autoSent + out.phones, 0);
});

test('a typed US phone lands on the thread as 10 digits', async () => {
  const db = fakeDb();
  const out = await store(db, rowsOf(inbound('P', 'm1', 'Juan, (239) 887-8557, 2012 F150 slipping')));
  assert.equal(out.phones, 1);
  assert.equal(db.threads.get('t_1').detected_phone, '2398878557');
  const none = fakeDb();
  await store(none, rowsOf(inbound('P', 'm1', 'VIN 1FTFW1ET5DFC10312')));
  assert.equal(none.threads.get('t_1').detected_phone, null);
});

/* ── Through the handler: still 200, whatever the auto-reply does ──────── */
const SECRET = 'test-app-secret-not-the-real-one';
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(Buffer.from(raw, 'utf8')).digest('hex');
async function post(raw, fetchImpl) {
  const req = Readable.from([Buffer.from(raw, 'utf8')]);
  req.method = 'POST'; req.headers = { 'x-hub-signature-256': sign(raw) }; req.query = {};
  const res = { statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; }, end(b) { this.body = b; return this; } };
  const saved = { ...process.env };
  Object.assign(process.env, ENV, { META_APP_SECRET: SECRET });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { await handler(req, res); } finally { globalThis.fetch = realFetch; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  return res;
}
test('handler: 200 with a send, and 200 when the Send API throws', async () => {
  const db = fakeDb();
  const r1 = await post(JSON.stringify(body(inbound('P', 'm1', 'hi'))), db.fetchImpl);
  assert.equal(r1.statusCode, 200);
  const boom = fakeDb({ graph: () => { throw new Error('network down'); } });
  const r2 = await post(JSON.stringify(body(inbound('P', 'm1', 'hi'))), boom.fetchImpl);
  assert.equal(r2.statusCode, 200);
  assert.equal(autoMsgs(boom)[0].send_status, 'failed');
});
