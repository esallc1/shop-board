/* ============================================================
   recording-player.test.js — unit tests for the recording render-state logic.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORDING_STATES, normalizeStatus, formatDuration,
  describeEntry, indexResults, describeCallId,
} from './recording-player.js';

// ── normalizeStatus ─────────────────────────────────────────
test('normalizeStatus passes the three known states through', () => {
  for (const s of RECORDING_STATES) assert.equal(normalizeStatus(s), s);
});
test('normalizeStatus is case-insensitive', () => {
  assert.equal(normalizeStatus('READY'), 'ready');
  assert.equal(normalizeStatus('Pending'), 'pending');
});
test('normalizeStatus coerces anything unknown/empty/null to failed', () => {
  for (const s of ['weird', '', null, undefined, 'processing']) {
    assert.equal(normalizeStatus(s), 'failed', `status ${JSON.stringify(s)} → failed`);
  }
});

// ── formatDuration ──────────────────────────────────────────
test('formatDuration = m:ss', () => {
  assert.equal(formatDuration(0), '');          // 0 is "no duration", not "0:00"
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(59.6), '1:00');   // rounds
});
test('formatDuration returns "" for missing/invalid/negative', () => {
  for (const v of [null, undefined, -3, NaN, 'abc']) assert.equal(formatDuration(v), '');
});

// ── describeEntry: THE three distinct states ────────────────
test('no entry → render:false (no recording exists for this call)', () => {
  assert.deepEqual(describeEntry(null), { render: false, state: 'none' });
  assert.deepEqual(describeEntry(undefined), { render: false, state: 'none' });
});

test('ready → playable play button, carries the (re-mintable) url + duration', () => {
  const d = describeEntry({ call_id: 1, status: 'ready', duration_seconds: 92, playback_url: 'https://x/signed?token=abc' });
  assert.equal(d.render, true);
  assert.equal(d.state, 'ready');
  assert.equal(d.playable, true);
  assert.equal(d.durationLabel, '1:32');
  assert.match(d.label, /Play/);
  assert.match(d.label, /1:32/);
  assert.equal(d.playbackUrl, 'https://x/signed?token=abc');
});

test('ready with no duration → still playable, no duration in the label', () => {
  const d = describeEntry({ call_id: 1, status: 'ready', playback_url: 'https://x/s' });
  assert.equal(d.playable, true);
  assert.equal(d.durationLabel, '');
  assert.equal(d.label, '▶ Play');
});

test('pending → renders, DISABLED, not absent (the ~90s gap must not look broken)', () => {
  const d = describeEntry({ call_id: 2, status: 'pending', duration_seconds: null, playback_url: null });
  assert.equal(d.render, true);
  assert.equal(d.state, 'pending');
  assert.equal(d.playable, false);
  assert.match(d.label, /Recording/i);
  assert.equal(d.playbackUrl, null);
});

test('failed → renders a quiet marker, never playable, never a url', () => {
  const d = describeEntry({ call_id: 3, status: 'failed', playback_url: null });
  assert.equal(d.render, true);
  assert.equal(d.state, 'failed');
  assert.equal(d.playable, false);
  assert.match(d.label, /unavailable/i);
  assert.equal(d.playbackUrl, null);
});

test('unknown status is treated as failed, never as playable or pending', () => {
  const d = describeEntry({ call_id: 4, status: 'garbage', playback_url: 'should-be-ignored' });
  assert.equal(d.state, 'failed');
  assert.equal(d.playable, false);
  assert.equal(d.playbackUrl, null);
});

// A ready row must never be silently dropped just because the server couldn't
// mint a url — the button still shows; the UI re-mints at click.
test('ready with null playback_url still renders a playable button (url re-mint at click)', () => {
  const d = describeEntry({ call_id: 5, status: 'ready', duration_seconds: 30, playback_url: null });
  assert.equal(d.playable, true);
  assert.equal(d.playbackUrl, null);
});

// ── indexResults ────────────────────────────────────────────
test('indexResults handles a bare array and a { results } envelope, keyed by STRING id', () => {
  const arr = [{ call_id: 10, status: 'ready' }, { call_id: 11, status: 'pending' }];
  const a = indexResults(arr);
  const b = indexResults({ results: arr });
  assert.deepEqual(Object.keys(a).sort(), ['10', '11']);
  assert.deepEqual(Object.keys(b).sort(), ['10', '11']);
  assert.equal(a['10'].status, 'ready');
});

test('indexResults skips null/idless entries and tolerates junk input', () => {
  const idx = indexResults([null, { status: 'ready' }, { call_id: 7, status: 'ready' }]);
  assert.deepEqual(Object.keys(idx), ['7']);
  assert.deepEqual(indexResults(null), {});
  assert.deepEqual(indexResults({}), {});
  assert.deepEqual(indexResults('nonsense'), {});
});

test('indexResults: later duplicate id wins', () => {
  const idx = indexResults([{ call_id: 1, status: 'pending' }, { call_id: 1, status: 'ready' }]);
  assert.equal(idx['1'].status, 'ready');
});

// ── describeCallId (bigint vs string key parity) ────────────
test('describeCallId matches a numeric id against a string-keyed index', () => {
  const idx = indexResults([{ call_id: 42, status: 'ready', playback_url: 'u' }]);
  assert.equal(describeCallId(idx, 42).state, 'ready');    // number in
  assert.equal(describeCallId(idx, '42').state, 'ready');  // string in
  assert.equal(describeCallId(idx, 999).render, false);    // absent → no recording
});
