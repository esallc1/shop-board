/* ============================================================
   ctm-webhook.test.js — unit tests for the header redaction step.
   Run: npm test   (node --test)

   Vercel injects x-vercel-oidc-token (a real signed project JWT) and
   x-vercel-proxy-signature onto the incoming request. redactHeaders must strip
   exactly those two (case-insensitively) and keep everything else verbatim
   before the headers object is persisted to ctm_webhook_log.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import handler, { redactHeaders, unixToIso, mapCallRow } from './ctm-webhook.js';

test('strips both Vercel credential headers, keeps everything else', () => {
  const incoming = {
    'x-ctm-signature': 'sig_abc',
    'x-ctm-time': '1722170000',
    'content-type': 'application/json',
    'user-agent': 'CTM/1.0',
    'x-vercel-oidc-token': 'eyJ.REAL.JWT',
    'x-vercel-proxy-signature': 'proxysig',
  };
  assert.deepEqual(redactHeaders(incoming), {
    'x-ctm-signature': 'sig_abc',
    'x-ctm-time': '1722170000',
    'content-type': 'application/json',
    'user-agent': 'CTM/1.0',
  });
});

test('redaction is case-insensitive on the header key', () => {
  const incoming = {
    'X-Vercel-OIDC-Token': 'eyJ.REAL.JWT',
    'X-Vercel-Proxy-Signature': 'proxysig',
    'X-CTM-Signature': 'sig_abc',
  };
  assert.deepEqual(redactHeaders(incoming), { 'X-CTM-Signature': 'sig_abc' });
});

test('does not over-redact other x-vercel-* headers', () => {
  const incoming = {
    'x-vercel-id': 'iad1::abc',
    'x-vercel-forwarded-for': '1.2.3.4',
    'x-vercel-oidc-token': 'eyJ.REAL.JWT',
  };
  assert.deepEqual(redactHeaders(incoming), {
    'x-vercel-id': 'iad1::abc',
    'x-vercel-forwarded-for': '1.2.3.4',
  });
});

test('null / undefined / empty input yields an empty object, never throws', () => {
  assert.deepEqual(redactHeaders(null), {});
  assert.deepEqual(redactHeaders(undefined), {});
  assert.deepEqual(redactHeaders({}), {});
});

// ── calls upsert mapping (slice 2) ──────────────────────────
// Locks the REAL CTM field names against a captured payload so they can't
// silently drift into plausible-looking alternatives.
test('mapCallRow maps the real CTM field names to calls columns', () => {
  const body = {
    id: 4379952365,
    caller_number_bare: '2396001971',
    caller_number_format: '(239) 600-1971',
    cnam: 'JANE DOE',
    tracking_number_bare: '2399335750',
    source: 'Direct',
    city: '',
    state: 'FL',
    is_new_caller: true,
    tag_list: [],
    dial_status: 'ringing',
    unix_time: 1722170000,
  };
  assert.deepEqual(mapCallRow(body), {
    ctm_call_id: 4379952365,
    caller_bare: '2396001971',
    caller_formatted: '(239) 600-1971',
    cnam: 'JANE DOE',
    tracking_bare: '2399335750',
    source: 'Direct',
    city: '',
    state: 'FL',
    is_new_caller: true,
    tags: [],
    status: 'ringing',
    started_at: '2024-07-28T12:33:20.000Z',
  });
});

test('mapCallRow returns null when body is null or has no id (parse failure / unkeyed)', () => {
  assert.equal(mapCallRow(null), null);
  assert.equal(mapCallRow(undefined), null);
  assert.equal(mapCallRow({ caller_number_bare: '2396001971' }), null);
});

test('mapCallRow fills missing optional fields with null, never undefined', () => {
  const row = mapCallRow({ id: 1 });
  assert.equal(row.ctm_call_id, 1);
  for (const k of ['caller_bare', 'caller_formatted', 'cnam', 'tracking_bare',
                   'source', 'city', 'state', 'is_new_caller', 'tags', 'status', 'started_at']) {
    assert.equal(row[k], null, `${k} should be null`);
  }
});

test('unixToIso converts epoch seconds and rejects bad input', () => {
  assert.equal(unixToIso(1722170000), '2024-07-28T12:33:20.000Z');
  assert.equal(unixToIso(null), null);
  assert.equal(unixToIso(undefined), null);
  assert.equal(unixToIso(0), null);
  assert.equal(unixToIso('nope'), null);
});

// ── recon-mode routing for CTM's end / end_immediate triggers ───────────────
// These drive the default-export handler with a mocked global.fetch and a
// mock req/res, then assert on WHICH Supabase endpoints were hit. The hard
// requirement: an end payload (any `?trigger=...`) must never reach the `calls`
// upsert, or it would null the advisor's typed notes on the shared ctm_call_id.

// A PostgREST endpoint is either the log table or the calls table.
const isLogUrl = (url) => String(url).includes('/rest/v1/ctm_webhook_log');
const isCallsUrl = (url) => String(url).includes('/rest/v1/calls');

// Build a mock request: a real readable stream (readRawBody consumes it) with
// method / url / headers attached, exactly like Vercel's Node request.
function mockReq({ url = '/api/ctm-webhook', body = '', headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.url = url;
  req.headers = headers;
  return req;
}

function mockRes() {
  return {
    statusCode: null,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

// A PostgREST-shaped response. `errBody` (when !ok) mimics the JSON error body
// PostgREST returns, e.g. { code: '42703', message: '...' }.
function fakeResponse({ ok = true, status = ok ? 201 : 400, json = [], errBody = '' } = {}) {
  return {
    ok,
    status,
    async json() { return json; },
    async text() { return typeof errBody === 'string' ? errBody : JSON.stringify(errBody); },
  };
}

// Run the handler with fetch stubbed. `handleFetch(url, init, callIndex)` returns
// a fakeResponse; every call is also recorded for assertions. Restores fetch and
// the service-role env var afterwards.
async function runHandler(reqOpts, handleFetch) {
  const savedFetch = global.fetch;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const calls = [];
  global.fetch = async (url, init) => {
    const idx = calls.length;
    let parsedBody;
    try { parsedBody = JSON.parse(init && init.body); } catch { parsedBody = undefined; }
    calls.push({ url: String(url), init, body: parsedBody });
    return handleFetch(String(url), init, idx);
  };
  const res = mockRes();
  try {
    await handler(mockReq(reqOpts), res);
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
  return { res, calls };
}

const START_BODY = JSON.stringify({
  id: 4379952365,
  caller_number_bare: '2396001971',
  source: 'Direct',
  tag_list: [],
  dial_status: 'ringing',
  unix_time: 1722170000,
});

test('recon mode (trigger param present): logs to ctm_webhook_log, never upserts calls', async () => {
  const { res, calls } = await runHandler(
    { url: '/api/ctm-webhook?trigger=end', body: START_BODY },
    () => fakeResponse({ ok: true, json: [{ id: 1 }] }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => isLogUrl(c.url)).length, 1, 'log insert should fire once');
  assert.equal(calls.filter((c) => isCallsUrl(c.url)).length, 0, 'calls upsert must NOT fire in recon mode');
});

test('start webhook (no trigger param): both log AND calls upsert fire, as today', async () => {
  const { res, calls } = await runHandler(
    { url: '/api/ctm-webhook', body: START_BODY },
    () => fakeResponse({ ok: true, json: [{ id: 1 }] }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => isLogUrl(c.url)).length, 1, 'log insert should fire');
  assert.equal(calls.filter((c) => isCallsUrl(c.url)).length, 1, 'calls upsert should fire on the start path');
});

test('trigger_hint carries the param value into the log payload (and is null without a param)', async () => {
  const withParam = await runHandler(
    { url: '/api/ctm-webhook?trigger=end_immediate', body: START_BODY },
    () => fakeResponse({ ok: true, json: [{ id: 1 }] }),
  );
  const loggedWith = withParam.calls.find((c) => isLogUrl(c.url));
  assert.equal(loggedWith.body.trigger_hint, 'end_immediate');

  const noParam = await runHandler(
    { url: '/api/ctm-webhook', body: START_BODY },
    () => fakeResponse({ ok: true, json: [{ id: 1 }] }),
  );
  const loggedWithout = noParam.calls.find((c) => isLogUrl(c.url));
  assert.equal(loggedWithout.body.trigger_hint, null, 'no-param path still writes trigger_hint: null');
});

test('42703 on the log insert: retries without trigger_hint, still returns 200', async () => {
  const { res, calls } = await runHandler(
    { url: '/api/ctm-webhook?trigger=end', body: START_BODY },
    (url, init, idx) => {
      if (isLogUrl(url) && idx === 0) {
        return fakeResponse({ ok: false, status: 400, errBody: { code: '42703', message: 'column "trigger_hint" of relation "ctm_webhook_log" does not exist' } });
      }
      return fakeResponse({ ok: true, json: [{ id: 1 }] });
    },
  );
  assert.equal(res.statusCode, 200);
  const logCalls = calls.filter((c) => isLogUrl(c.url));
  assert.equal(logCalls.length, 2, 'should retry the log insert exactly once');
  assert.ok('trigger_hint' in logCalls[0].body, 'first attempt includes trigger_hint');
  assert.ok(!('trigger_hint' in logCalls[1].body), 'retry drops trigger_hint');
  // Retry preserves the rest of the row verbatim.
  assert.equal(logCalls[1].body.body_raw, START_BODY);
  assert.equal(calls.filter((c) => isCallsUrl(c.url)).length, 0, 'still no calls upsert');
});

test('realistic end-shaped payload in recon mode never reaches the calls upsert', async () => {
  // Shaped like an end delivery: same ctm_call_id (id) but missing cnam / source
  // / tag_list. If this reached mapCallRow it would upsert and null those fields
  // over Josh's notes. The calls endpoint being untouched proves it did not.
  const END_SHAPED = JSON.stringify({
    id: 4379952365,
    dial_status: 'completed',
    duration: 214,
    unix_time: 1722170300,
  });
  const { res, calls } = await runHandler(
    { url: '/api/ctm-webhook?trigger=end', body: END_SHAPED },
    () => fakeResponse({ ok: true, json: [{ id: 1 }] }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => isCallsUrl(c.url)).length, 0, 'end payload must never hit the calls upsert');
  assert.equal(calls.filter((c) => isLogUrl(c.url)).length, 1, 'but it is still captured in ctm_webhook_log');
});
