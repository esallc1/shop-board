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
import { redactHeaders, unixToIso, mapCallRow } from './ctm-webhook.js';

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
