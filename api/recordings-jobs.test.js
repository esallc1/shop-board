/* ============================================================
   recordings-jobs.test.js — unit tests for the fetch cron + backfill logic.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStoragePath, nextFetchState, MAX_FETCH_ATTEMPTS } from './fetch-recordings.js';
import { dedupeByCtmCallId, buildBackfillRows } from './backfill-recordings.js';

// ── storage path convention ─────────────────────────────────
test('computeStoragePath = <yyyy-mm>/<ctm_call_id>.mp3 from recorded_at (UTC)', () => {
  assert.equal(computeStoragePath(4380799274, '2026-07-29T18:33:20.000Z'), '2026-07/4380799274.mp3');
  assert.equal(computeStoragePath(42, '2026-12-01T00:00:00.000Z'), '2026-12/42.mp3');
});

test('computeStoragePath falls back to `now` when recorded_at is missing/invalid', () => {
  const now = new Date('2026-07-29T00:00:00.000Z');
  assert.equal(computeStoragePath(7, null, now), '2026-07/7.mp3');
  assert.equal(computeStoragePath(7, 'not-a-date', now), '2026-07/7.mp3');
});

// ── retry / failure ladder ──────────────────────────────────
test('nextFetchState: fetch success → ready + storage_path, error cleared', () => {
  assert.deepEqual(
    nextFetchState(0, true, { storagePath: '2026-07/1.mp3' }),
    { fetch_status: 'ready', storage_path: '2026-07/1.mp3', last_error: null },
  );
});

test('nextFetchState: failure → attempts incremented, still pending', () => {
  const s = nextFetchState(0, false, { error: 'download 500' });
  assert.equal(s.fetch_attempts, 1);
  assert.equal(s.fetch_status, 'pending');
  assert.equal(s.last_error, 'download 500');
});

test('nextFetchState: the 5th failure flips to failed', () => {
  // A row picked at attempts=4 (still < cap) that fails becomes attempts=5=failed.
  const s = nextFetchState(MAX_FETCH_ATTEMPTS - 1, false, { error: 'boom' });
  assert.equal(s.fetch_attempts, 5);
  assert.equal(s.fetch_status, 'failed');
});

test('nextFetchState: earlier failures stay pending (retriable)', () => {
  for (let a = 0; a < MAX_FETCH_ATTEMPTS - 1; a++) {
    assert.equal(nextFetchState(a, false, { error: 'x' }).fetch_status, 'pending', `attempts ${a}→pending`);
  }
});

// ── backfill transform ──────────────────────────────────────
test('dedupeByCtmCallId keeps the first body per id, drops idless', () => {
  const out = dedupeByCtmCallId([{ id: 1, audio: 'a' }, { id: 1, audio: 'b' }, { id: 2 }, { audio: 'c' }, null]);
  assert.deepEqual(out.map((b) => b.id), [1, 2]);
  assert.equal(out[0].audio, 'a', 'first occurrence wins');
});

test('buildBackfillRows: only audio-bearing, deduped, mapped with call_id from the map', () => {
  const logRows = [
    { body: { id: 10, audio: 'https://ctm/10', duration: 100, unix_time: 1722170300 } },
    { body: { id: 10, audio: 'https://ctm/10-again' } },   // duplicate delivery → dropped
    { body: { id: 11, audio: null } },                     // no audio → dropped
    { body: { id: 12, audio: 'https://ctm/12', unix_time: 1722170300 } },
    { body: null },                                        // junk → dropped
  ];
  const rows = buildBackfillRows(logRows, { 10: 500 });    // 10 → call_id 500; 12 unresolved → null
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.ctm_call_id), [10, 12]);
  assert.equal(rows[0].call_id, 500);
  assert.equal(rows[1].call_id, null);
  assert.ok(rows.every((r) => r.fetch_status === 'pending' && r.source === 'call'));
});

test('buildBackfillRows is deterministic/idempotent-friendly: same input → same rows', () => {
  const logRows = [{ body: { id: 10, audio: 'https://ctm/10' } }];
  assert.deepEqual(buildBackfillRows(logRows, {}), buildBackfillRows(logRows, {}));
});
