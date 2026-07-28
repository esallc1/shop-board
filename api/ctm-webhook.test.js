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
import { redactHeaders } from './ctm-webhook.js';

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
