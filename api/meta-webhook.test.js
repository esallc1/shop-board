/* ============================================================
   meta-webhook.test.js — unit tests for the Meta/Facebook webhook receiver.
   Run: npm test   (node --test 'api/*.test.js' 'shared/*.test.js')

   Two things are under test, and they are the only two things the endpoint
   does: the GET subscription handshake, and POST signature ENFORCEMENT.

   The signature half matters more than it looks. api/ctm-webhook.js computes a
   signature and never rejects on it; this file exists partly to pin, in
   executable form, that meta-webhook is NOT that — a tampered body must 403,
   and a missing secret must 403 rather than fall through to "no check".
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import handler, { verifyMetaSignature, verifyHandshake, summarizeMetaPayload } from './meta-webhook.js';

const SECRET = 'test-app-secret-not-the-real-one';
const TOKEN  = 'test-verify-token-not-the-real-one';

const sign = (body, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

// A realistic Page webhook envelope (Messenger delivery).
const PAGE_BODY = JSON.stringify({
  object: 'page',
  entry: [{
    id: '111222333444555',
    time: 1757700000000,
    messaging: [{ sender: { id: 'PSID_ABC' }, recipient: { id: '111222333444555' }, message: { text: 'is my truck ready?' } }],
  }],
});

// Vercel-shaped mock req/res. GET never touches the stream; POST reads it.
function mockReq({ method = 'POST', url = '/api/meta-webhook', body = '', headers = {}, query } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (query) req.query = query;
  return req;
}

function mockRes() {
  return {
    statusCode: null,
    body: undefined,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Run the handler with the env vars we choose, then restore them.
async function run(reqOpts, env = {}) {
  const saved = { s: process.env.META_APP_SECRET, t: process.env.META_VERIFY_TOKEN };
  if ('secret' in env) { if (env.secret === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = env.secret; }
  else process.env.META_APP_SECRET = SECRET;
  if ('token' in env) { if (env.token === undefined) delete process.env.META_VERIFY_TOKEN; else process.env.META_VERIFY_TOKEN = env.token; }
  else process.env.META_VERIFY_TOKEN = TOKEN;
  const res = mockRes();
  try {
    await handler(mockReq(reqOpts), res);
  } finally {
    if (saved.s === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = saved.s;
    if (saved.t === undefined) delete process.env.META_VERIFY_TOKEN; else process.env.META_VERIFY_TOKEN = saved.t;
  }
  return res;
}

/* ── 1. GET — the subscription handshake ──────────────────────────────────
   Meta string-compares the response body to the challenge it sent, so "200
   with the challenge somewhere in it" is a FAILED handshake. The body has to
   be the challenge and nothing else.
   ──────────────────────────────────────────────────────────────────────── */

test('GET with the correct verify token → 200 and the body is EXACTLY the challenge', async () => {
  const res = await run({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '1158201444');          // no JSON, no quotes...
  assert.equal(res.body.endsWith('\n'), false);  // ...and no trailing newline
  assert.match(res.headers['content-type'], /^text\/plain/);
});

test('GET reads the params off the raw URL too (no Vercel req.query)', async () => {
  const res = await run({ method: 'GET', url: '/api/meta-webhook?hub.mode=subscribe&hub.verify_token=' + TOKEN + '&hub.challenge=9876' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '9876');
});

test('GET with the WRONG verify token → 403, empty body, challenge never echoed', async () => {
  const res = await run({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1158201444' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '');
});

test('GET with hub.mode !== subscribe → 403 even when the token is right', async () => {
  const res = await run({ method: 'GET', query: { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '');
});

test('GET with META_VERIFY_TOKEN unset → 403 (fail closed, no default token)', async () => {
  const res = await run(
    { method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1158201444' } },
    { token: undefined },
  );
  assert.equal(res.statusCode, 403);
});

// The pure handshake function, directly.
test('verifyHandshake: right token + subscribe → ok, with the challenge', () => {
  const r = verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': 'abc' }, TOKEN);
  assert.deepEqual(r, { ok: true, reason: 'ok', challenge: 'abc' });
});

test('verifyHandshake: an unset token can never be satisfied', () => {
  assert.equal(verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'abc' }, undefined).ok, false);
  assert.equal(verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': 'abc' }, '').ok, false);
});

test('verifyHandshake: a missing challenge is not a handshake', () => {
  assert.equal(verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }, TOKEN).ok, false);
});

/* ── 2. POST — signature enforcement (the point of the slice) ─────────────── */

test('POST with a correctly computed signature → 200', async () => {
  const res = await run({ body: PAGE_BODY, headers: { 'x-hub-signature-256': sign(PAGE_BODY) } });
  assert.equal(res.statusCode, 200);
});

test('POST with a TAMPERED body (valid-looking sig, one byte changed) → 403', async () => {
  const good = sign(PAGE_BODY);
  const tampered = PAGE_BODY.replace('is my truck ready?', 'is my truck ready!');
  assert.equal(tampered.length, PAGE_BODY.length);       // same length: only the bytes differ
  const res = await run({ body: tampered, headers: { 'x-hub-signature-256': good } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '');
});

test('POST with NO X-Hub-Signature-256 header → 403', async () => {
  const res = await run({ body: PAGE_BODY, headers: {} });
  assert.equal(res.statusCode, 403);
});

test('POST with a malformed header (no sha256= prefix) → 403', async () => {
  const hex = crypto.createHmac('sha256', SECRET).update(PAGE_BODY).digest('hex');
  for (const h of [hex, 'sha1=' + hex, 'sha256:' + hex, 'sha256=', 'sha256=nothex!!', '']) {
    const res = await run({ body: PAGE_BODY, headers: { 'x-hub-signature-256': h } });
    assert.equal(res.statusCode, 403, 'should reject header: ' + JSON.stringify(h));
  }
});

test('POST with META_APP_SECRET unset → 403, even with a self-consistent signature', async () => {
  const res = await run({ body: PAGE_BODY, headers: { 'x-hub-signature-256': sign(PAGE_BODY) } }, { secret: undefined });
  assert.equal(res.statusCode, 403);
});

test('POST signed with a DIFFERENT secret → 403', async () => {
  const res = await run({ body: PAGE_BODY, headers: { 'x-hub-signature-256': sign(PAGE_BODY, 'some-other-secret') } });
  assert.equal(res.statusCode, 403);
});

// Response discipline: an authentic delivery in a shape we don't handle yet is
// still a 200. A 403 or 500 here would make Meta retry and then unsubscribe us.
test('POST of an AUTHENTIC but unrecognised payload → still 200 (never retried away)', async () => {
  for (const body of ['{}', '{"object":"whatsapp_business_account","entry":[]}', '[]', 'not json at all', '']) {
    const res = await run({ body, headers: { 'x-hub-signature-256': sign(body) } });
    assert.equal(res.statusCode, 200, 'should 200 on authentic body: ' + JSON.stringify(body));
  }
});

test('a method that is neither GET nor POST → 405, and never 500', async () => {
  const res = await run({ method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});

/* ── 3. verifyMetaSignature, directly ───────────────────────────────────── */

test('verifyMetaSignature: the happy path over the exact bytes', () => {
  const raw = Buffer.from(PAGE_BODY, 'utf8');
  assert.deepEqual(verifyMetaSignature(sign(PAGE_BODY), raw, SECRET), { ok: true, reason: 'ok' });
});

test('verifyMetaSignature: the hex compare is CASE-INSENSITIVE', () => {
  const raw = Buffer.from(PAGE_BODY, 'utf8');
  const lower = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.notEqual(lower, lower.toUpperCase());                                  // there ARE letters in it
  assert.equal(verifyMetaSignature('sha256=' + lower, raw, SECRET).ok, true);
  assert.equal(verifyMetaSignature('sha256=' + lower.toUpperCase(), raw, SECRET).ok, true);
  assert.equal(verifyMetaSignature('sha256=' + lower.slice(0, 10).toUpperCase() + lower.slice(10), raw, SECRET).ok, true);  // mixed
});

test('verifyMetaSignature: every rejection is a REASON, never a throw', () => {
  const raw = Buffer.from(PAGE_BODY, 'utf8');
  const good = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(verifyMetaSignature('sha256=' + good, raw, undefined).reason, 'no-app-secret');
  assert.equal(verifyMetaSignature('sha256=' + good, raw, '').reason, 'no-app-secret');
  assert.equal(verifyMetaSignature(undefined, raw, SECRET).reason, 'no-signature-header');
  assert.equal(verifyMetaSignature(good, raw, SECRET).reason, 'malformed-signature-header');
  assert.equal(verifyMetaSignature('sha256=zz', raw, SECRET).reason, 'malformed-signature-header');
  assert.equal(verifyMetaSignature('sha256=' + good.slice(0, 62), raw, SECRET).reason, 'length-mismatch');
  assert.equal(verifyMetaSignature('sha256=' + good + '00', raw, SECRET).reason, 'length-mismatch');
  assert.equal(verifyMetaSignature('sha256=' + good.slice(0, 63), raw, SECRET).reason, 'length-mismatch');  // ODD length
  assert.equal(verifyMetaSignature('sha256=' + '0'.repeat(64), raw, SECRET).reason, 'signature-mismatch');
});

// A short hex would THROW inside timingSafeEqual without the length guard —
// this is the assertion that keeps the guard in place.
test('verifyMetaSignature: a short/odd hex is rejected, not thrown', () => {
  assert.doesNotThrow(() => verifyMetaSignature('sha256=ab', Buffer.from('x'), SECRET));
  assert.doesNotThrow(() => verifyMetaSignature('sha256=abc', Buffer.from('x'), SECRET));
});

test('verifyMetaSignature: signing an EMPTY body still works both ways', () => {
  const raw = Buffer.alloc(0);
  const hex = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(verifyMetaSignature('sha256=' + hex, raw, SECRET).ok, true);
  assert.equal(verifyMetaSignature('sha256=' + hex, Buffer.from('x'), SECRET).ok, false);
});

test('verifyMetaSignature: bytes are compared, not a utf8 round-trip', () => {
  const raw = Buffer.from([0x7b, 0x22, 0xf0, 0x9f, 0x9a, 0x97, 0x22, 0x7d]);  // {"🚗"}
  const hex = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  assert.equal(verifyMetaSignature('sha256=' + hex, raw, SECRET).ok, true);
});

/* ── 4. What gets logged ────────────────────────────────────────────────── */

test('summarizeMetaPayload: a Messenger delivery names its page and event', () => {
  const s = summarizeMetaPayload(JSON.parse(PAGE_BODY));
  assert.equal(s.object, 'page');
  assert.equal(s.entries, 1);
  assert.deepEqual(s.events, ['messaging']);
  assert.deepEqual(s.pageIds, ['111222333444555']);
});

test('summarizeMetaPayload: a `changes` entry is labelled by its field', () => {
  const s = summarizeMetaPayload({ object: 'page', entry: [{ id: '9', changes: [{ field: 'leadgen', value: {} }, { field: 'feed', value: {} }] }] });
  assert.deepEqual(s.events, ['changes:leadgen', 'changes:feed']);
});

test('summarizeMetaPayload: never throws on junk, and carries no message text', () => {
  for (const junk of [null, undefined, 'string', 42, [], {}, { entry: 'nope' }, { entry: [null, 7] }]) {
    assert.doesNotThrow(() => summarizeMetaPayload(junk));
  }
  assert.equal(JSON.stringify(summarizeMetaPayload(JSON.parse(PAGE_BODY))).includes('truck'), false);
});
