/* ============================================================
   recording-links.test.js — unit tests for the reader endpoint's PURE helpers.
   The security invariants (ids-only in, whitelist-only out) live here.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCallIds, publicRow, MAX_CALL_IDS } from './recording-links.js';

// ── sanitizeCallIds: ids only, nothing else ────────────────
test('sanitizeCallIds keeps positive integer ids only', () => {
  assert.deepEqual(sanitizeCallIds([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(sanitizeCallIds(['10', '11']), [10, 11]);   // numeric strings coerce
});

test('sanitizeCallIds drops non-ids: paths, floats, zero, negatives, junk', () => {
  // The whole point: a caller CANNOT smuggle a storage_path (or anything but ids)
  // through this endpoint.
  assert.deepEqual(
    sanitizeCallIds(['2026-07/4380799274.mp3', -1, 0, 1.5, 'abc', null, undefined, {}, [], NaN, 5]),
    [5],
  );
});

test('sanitizeCallIds dedupes', () => {
  assert.deepEqual(sanitizeCallIds([7, 7, '7', 8]), [7, 8]);
});

test('sanitizeCallIds caps the batch at MAX_CALL_IDS', () => {
  const many = Array.from({ length: MAX_CALL_IDS + 25 }, (_, i) => i + 1);
  assert.equal(sanitizeCallIds(many).length, MAX_CALL_IDS);
});

test('sanitizeCallIds returns [] for non-array / empty input', () => {
  assert.deepEqual(sanitizeCallIds(null), []);
  assert.deepEqual(sanitizeCallIds('42'), []);
  assert.deepEqual(sanitizeCallIds(undefined), []);
  assert.deepEqual(sanitizeCallIds([]), []);
});

// ── publicRow: whitelist-only output, no leaks EVER ─────────
const SECRET_FIELDS = ['remote_url', 'storage_path', 'last_error', 'fetch_attempts', 'ctm_call_id', 'id'];

function assertNoSecrets(out) {
  for (const f of SECRET_FIELDS) {
    assert.ok(!(f in out), `public payload must not contain ${f}`);
  }
  assert.deepEqual(
    Object.keys(out).sort(),
    ['call_id', 'duration_seconds', 'playback_url', 'status', 'vehicle_id'],
    'exactly the five whitelisted fields',
  );
}

test('publicRow (ready) ships the signed url + the five fields, nothing else', () => {
  const rec = {
    id: 'uuid-x', call_id: 500, ctm_call_id: 4380799274,
    fetch_status: 'ready', duration_seconds: 92,
    storage_path: '2026-07/4380799274.mp3', vehicle_id: 'veh-uuid',
    remote_url: 'https://ctm/secret', last_error: null, fetch_attempts: 1,
  };
  const out = publicRow(rec, 'https://signed/url?token=abc');
  assert.equal(out.call_id, 500);
  assert.equal(out.status, 'ready');
  assert.equal(out.duration_seconds, 92);
  assert.equal(out.playback_url, 'https://signed/url?token=abc');
  assert.equal(out.vehicle_id, 'veh-uuid', 'persisted assignment flows through');
  assertNoSecrets(out);
});

test('publicRow: a null/absent vehicle_id → null (nobody has assigned it)', () => {
  assert.equal(publicRow({ call_id: 1, fetch_status: 'ready' }, 'u').vehicle_id, null);
  assert.equal(publicRow({ call_id: 1, fetch_status: 'ready', vehicle_id: null }, 'u').vehicle_id, null);
});

test('publicRow (ready) with no minted url → playback_url null, still ready', () => {
  const rec = { call_id: 1, fetch_status: 'ready', storage_path: 'p', remote_url: 'x' };
  const out = publicRow(rec, null);
  assert.equal(out.status, 'ready');
  assert.equal(out.playback_url, null);
  assertNoSecrets(out);
});

test('publicRow (pending) never carries a url even if one is passed', () => {
  const rec = { call_id: 2, fetch_status: 'pending', storage_path: null, remote_url: 'x' };
  const out = publicRow(rec, 'https://should/not/appear');
  assert.equal(out.status, 'pending');
  assert.equal(out.playback_url, null);
  assertNoSecrets(out);
});

test('publicRow (failed) exposes no url and no last_error', () => {
  const rec = { call_id: 3, fetch_status: 'failed', storage_path: null, last_error: 'download 404', remote_url: 'x' };
  const out = publicRow(rec, 'https://nope');
  assert.equal(out.status, 'failed');
  assert.equal(out.playback_url, null);
  assertNoSecrets(out);
});

test('publicRow coerces an unknown/missing status to failed (never leaks a url)', () => {
  const out = publicRow({ call_id: 4, fetch_status: 'weird', storage_path: 'p', remote_url: 'x' }, 'https://nope');
  assert.equal(out.status, 'failed');
  assert.equal(out.playback_url, null);
  assertNoSecrets(out);
});

test('publicRow normalizes a missing duration to null', () => {
  const out = publicRow({ call_id: 5, fetch_status: 'ready', storage_path: 'p' }, 'u');
  assert.equal(out.duration_seconds, null);
  assert.equal(out.playback_url, 'u');
});
