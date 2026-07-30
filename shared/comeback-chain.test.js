/* ============================================================
   comeback-chain.test.js — unit tests for the comeback chain logic.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHAIN_DEPTH, isComeback, analyzeChain, badgeLabel,
  orderChain, recordedOr, validateComebackClose,
} from './comeback-chain.js';

// Helper: build an id→ro map from a list of rows.
function mapOf(rows) {
  const m = {};
  for (const r of rows) m[String(r.id)] = r;
  return m;
}

// ── isComeback ──────────────────────────────────────────────
test('isComeback: parent_ro_id null → false, set → true', () => {
  assert.equal(isComeback({ parent_ro_id: null }), false);
  assert.equal(isComeback({ parent_ro_id: undefined }), false);
  assert.equal(isComeback({}), false);
  assert.equal(isComeback(null), false);
  assert.equal(isComeback({ parent_ro_id: 'abc' }), true);
});

// ── analyzeChain: ROOT ONLY (not a comeback) ────────────────
test('root only → not a comeback, ordinal 0, root is itself', () => {
  const map = mapOf([{ id: 'a', ro_number: 6014, parent_ro_id: null }]);
  const r = analyzeChain(map, 'a');
  assert.equal(r.isComeback, false);
  assert.equal(r.ordinal, 0);
  assert.equal(r.rootNumber, 6014);
  assert.equal(r.broken, false);
  assert.equal(r.reason, 'not-comeback');
  assert.equal(badgeLabel(r), '');   // no badge for a non-comeback
});

// ── analyzeChain: ONE comeback ──────────────────────────────
test('one comeback → ordinal 1, root is the original', () => {
  const map = mapOf([
    { id: 'a', ro_number: 6014, parent_ro_id: null },
    { id: 'b', ro_number: 6020, parent_ro_id: 'a' },
  ]);
  const r = analyzeChain(map, 'b');
  assert.equal(r.isComeback, true);
  assert.equal(r.ordinal, 1);
  assert.equal(r.rootNumber, 6014);
  assert.equal(r.broken, false);
  assert.equal(badgeLabel(r), 'Comeback 1 of RO 6014');
});

// ── analyzeChain: COMEBACK-OF-COMEBACK (the point of walking to root) ──
test('comeback-of-comeback → ordinal 2, root still the original (not the immediate parent)', () => {
  const map = mapOf([
    { id: 'a', ro_number: 6014, parent_ro_id: null },
    { id: 'b', ro_number: 6020, parent_ro_id: 'a' },   // immediate parent of c
    { id: 'c', ro_number: 6031, parent_ro_id: 'b' },
  ]);
  const r = analyzeChain(map, 'c');
  assert.equal(r.ordinal, 2, 'reads "Comeback 2", not "Comeback 1"');
  assert.equal(r.rootNumber, 6014, 'root is the ORIGINAL, not the immediate parent 6020');
  assert.equal(badgeLabel(r), 'Comeback 2 of RO 6014');
  // the middle RO is itself Comeback 1
  assert.equal(analyzeChain(map, 'b').ordinal, 1);
});

// ── analyzeChain: ORPHAN (deleted ancestor → parent_ro_id dangles) ──
test('orphan → broken, no ordinal guessed, honest badge', () => {
  // c points at b, but b was deleted (on delete set null would null it, but a
  // stale/dangling pointer is the failure we must survive): b is absent.
  const map = mapOf([
    { id: 'c', ro_number: 6031, parent_ro_id: 'b' },   // 'b' not in the map
  ]);
  const r = analyzeChain(map, 'c');
  assert.equal(r.isComeback, true);
  assert.equal(r.ordinal, null, 'never guess an ordinal for a broken chain');
  assert.equal(r.root, null);
  assert.equal(r.broken, true);
  assert.equal(r.reason, 'orphan');
  assert.equal(badgeLabel(r), 'Comeback (linked RO deleted)');
});

// ── analyzeChain: CYCLE (bad parent link must not loop forever) ──
test('cycle → broken, terminates, no ordinal', () => {
  const map = mapOf([
    { id: 'a', ro_number: 1, parent_ro_id: 'b' },
    { id: 'b', ro_number: 2, parent_ro_id: 'a' },   // a→b→a
  ]);
  const r = analyzeChain(map, 'a');
  assert.equal(r.broken, true);
  assert.equal(r.reason, 'cycle');
  assert.equal(r.ordinal, null);
  assert.equal(badgeLabel(r), 'Comeback (chain error)');
});

test('cycle: a self-parent link terminates', () => {
  const map = mapOf([{ id: 'a', ro_number: 1, parent_ro_id: 'a' }]);
  const r = analyzeChain(map, 'a');
  assert.equal(r.broken, true);
  assert.equal(r.reason, 'cycle');
});

test('a long chain past the depth cap is treated as broken (cycle backstop), not hung', () => {
  const rows = [];
  for (let i = 0; i <= MAX_CHAIN_DEPTH + 5; i++) {
    rows.push({ id: String(i), ro_number: 6000 + i, parent_ro_id: i === 0 ? null : String(i - 1) });
  }
  const r = analyzeChain(mapOf(rows), String(MAX_CHAIN_DEPTH + 5));
  assert.equal(r.broken, true);
  assert.equal(r.reason, 'cycle');
});

test('analyzeChain: current row absent from the map → unknown/broken, no crash', () => {
  const r = analyzeChain(mapOf([]), 'missing');
  assert.equal(r.broken, true);
  assert.equal(r.reason, 'unknown');
  assert.equal(r.ordinal, null);
});

// ── orderChain ──────────────────────────────────────────────
test('orderChain sorts oldest → newest by created_at, ro_number tiebreak', () => {
  const map = mapOf([
    { id: 'c', ro_number: 6031, created_at: '2026-03-01T00:00:00Z' },
    { id: 'a', ro_number: 6014, created_at: '2026-01-01T00:00:00Z' },
    { id: 'b', ro_number: 6020, created_at: '2026-02-01T00:00:00Z' },
  ]);
  assert.deepEqual(orderChain(map).map(r => r.ro_number), [6014, 6020, 6031]);
});

test('orderChain tiebreaks equal timestamps by ro_number', () => {
  const map = mapOf([
    { id: 'y', ro_number: 6020, created_at: 'T' },
    { id: 'x', ro_number: 6014, created_at: 'T' },
  ]);
  assert.deepEqual(orderChain(map).map(r => r.ro_number), [6014, 6020]);
});

// ── recordedOr ──────────────────────────────────────────────
test('recordedOr: value → recorded; blank/whitespace/null → "not recorded"', () => {
  assert.deepEqual(recordedOr('shifts hard'), { recorded: true, text: 'shifts hard' });
  assert.deepEqual(recordedOr('  trimmed  '), { recorded: true, text: 'trimmed' });
  for (const v of ['', '   ', null, undefined]) {
    assert.deepEqual(recordedOr(v), { recorded: false, text: 'not recorded' }, `${JSON.stringify(v)} → not recorded`);
  }
});

// ── validateComebackClose ───────────────────────────────────
test('close blocked until BOTH complaint and resolution are non-empty', () => {
  assert.deepEqual(validateComebackClose({ complaint: '', resolution: '' }).missing, ['complaint', 'resolution']);
  assert.deepEqual(validateComebackClose({ complaint: 'x', resolution: '' }).missing, ['resolution']);
  assert.deepEqual(validateComebackClose({ complaint: '', resolution: 'y' }).missing, ['complaint']);
  const ok = validateComebackClose({ complaint: 'x', resolution: 'y' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.missing, []);
});

test('validateComebackClose treats whitespace-only as empty', () => {
  const r = validateComebackClose({ complaint: '   ', resolution: '\n\t ' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['complaint', 'resolution']);
});

test('validateComebackClose tolerates missing/nullish input', () => {
  assert.deepEqual(validateComebackClose(null).missing, ['complaint', 'resolution']);
  assert.deepEqual(validateComebackClose({}).missing, ['complaint', 'resolution']);
});
