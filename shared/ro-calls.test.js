/* ============================================================
   ro-calls.test.js — unit tests for the RO call-history + picker helpers.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roStageLabel, roPickerRank, sortRosForPicker, buildRoPickerOptions, sortCallsNewestFirst } from './ro-calls.js';

// ── labels ──────────────────────────────────────────────────
test('roStageLabel names each stage, and declined estimates read as declined', () => {
  assert.equal(roStageLabel({ status: 'ro' }), 'Active RO');
  assert.equal(roStageLabel({ status: 'estimate' }), 'Estimate');
  assert.equal(roStageLabel({ status: 'estimate', declined_at: '2026-07-01T00:00:00Z' }), 'Declined estimate');
  assert.equal(roStageLabel({ status: 'invoice' }), 'Invoice');
  assert.equal(roStageLabel({ status: 'closed' }), 'Closed');
});

// ── picker ordering ─────────────────────────────────────────
test('roPickerRank orders active → invoice → closed → declined', () => {
  assert.equal(roPickerRank({ status: 'ro' }), 0);
  assert.equal(roPickerRank({ status: 'estimate' }), 1);
  assert.equal(roPickerRank({ status: 'invoice' }), 2);
  assert.equal(roPickerRank({ status: 'closed' }), 3);
  assert.equal(roPickerRank({ status: 'estimate', declined_at: 'x' }), 4);
});

test('sortRosForPicker groups by stage and is newest-first within a group', () => {
  const ros = [
    { id: 'c1', ro_number: 5000, status: 'closed',   created_at: '2026-01-01' },
    { id: 'e1', ro_number: 6001, status: 'estimate', created_at: '2026-07-01' },
    { id: 'r1', ro_number: 6009, status: 'ro',       created_at: '2026-07-10' },
    { id: 'i1', ro_number: 5473, status: 'invoice',  created_at: '2026-06-01' },
    { id: 'c2', ro_number: 5100, status: 'closed',   created_at: '2026-05-01' }, // newer closed
    { id: 'd1', ro_number: 5999, status: 'estimate', declined_at: 'x', created_at: '2026-07-05' },
  ];
  assert.deepEqual(sortRosForPicker(ros).map(r => r.id), ['r1', 'e1', 'i1', 'c2', 'c1', 'd1']);
  // ↑ ro, estimate(live), invoice, then two closed newest-first (c2 before c1), then declined last
});

test('buildRoPickerOptions labels every stage and marks the selection; stores the id', () => {
  const ros = [
    { id: 'r1', ro_number: 6009, status: 'ro',      created_at: '2026-07-10' },
    { id: 'c1', ro_number: 5473, status: 'closed',  created_at: '2026-01-01' },
  ];
  const opts = buildRoPickerOptions(ros, 'c1');
  assert.deepEqual(opts.map(o => o.label), ['#6009 · Active RO', '#5473 · Closed']);
  assert.equal(opts.find(o => o.selected).id, 'c1');
  assert.equal(opts.filter(o => o.selected).length, 1);
  // includes ro AND closed — the picker is no longer active-only
  assert.ok(opts.some(o => /Active RO/.test(o.label)) && opts.some(o => /Closed/.test(o.label)));
});

test('buildRoPickerOptions handles a null ro_number and no selection', () => {
  const opts = buildRoPickerOptions([{ id: 'x', ro_number: null, status: 'invoice' }], null);
  assert.equal(opts[0].label, '#? · Invoice');
  assert.equal(opts[0].selected, false);
});

// ── call-history ordering ───────────────────────────────────
test('sortCallsNewestFirst orders by started_at desc, falling back to noted_at', () => {
  const calls = [
    { id: 1, started_at: '2026-07-29T14:00:00Z' },
    { id: 2, started_at: '2026-07-29T16:00:00Z' },
    { id: 3, noted_at: '2026-07-29T15:00:00Z' },   // no started_at → uses noted_at
  ];
  assert.deepEqual(sortCallsNewestFirst(calls).map(c => c.id), [2, 3, 1]);
});

test('sortCallsNewestFirst does not mutate its input and tolerates empties', () => {
  const input = [{ id: 1, started_at: 'a' }, { id: 2, started_at: 'b' }];
  const before = [...input];
  sortCallsNewestFirst(input);
  assert.deepEqual(input, before);
  assert.deepEqual(sortCallsNewestFirst([]), []);
  assert.deepEqual(sortCallsNewestFirst(null), []);
});
