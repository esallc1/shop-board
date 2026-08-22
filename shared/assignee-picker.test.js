/* ============================================================
   assignee-picker.test.js — locks the WRITE-SAFETY rule.
   Run: npm test   (node --test)

   The thing under test is not cosmetic. A <select> whose value matches no
   <option> displays option[0] instead, so an omitted assignee becomes a
   silent deletion on the next save. These tests exist so that can never
   regress unnoticed.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNASSIGNED_SENTINELS, isUnassignedValue,
  appendCurrentIfMissing, buildAssigneeOptions,
} from './assignee-picker.js';

const ROSTER = ['Alnardier', 'Capote', 'Jay Tech'];
const sel = (opts) => opts.filter((o) => o.selected);
const vals = (opts) => opts.map((o) => o.value);

// ── THE RULE ─────────────────────────────────────────────────
test('a current assignee ABSENT from the roster is still present and selected', () => {
  const opts = buildAssigneeOptions(ROSTER, 'ZZ Test Owner');
  assert.ok(vals(opts).includes('ZZ Test Owner'), 'the assigned name must survive');
  assert.equal(sel(opts).length, 1);
  assert.equal(sel(opts)[0].value, 'ZZ Test Owner');
});

test('a RETIRED assignee is preserved — retiring must not blank live assignments', () => {
  const opts = buildAssigneeOptions(['Capote'], 'Cory');   // Cory retired
  assert.deepEqual(vals(opts), ['', 'Capote', 'Cory']);
  assert.equal(sel(opts)[0].value, 'Cory');
});

test('exactly one option is selected in every case (the silent-deletion guard)', () => {
  const cases = [undefined, null, '', 'Unassigned', 'Capote', 'Nobody Known', '  Capote  '];
  cases.forEach((cur) => {
    const opts = buildAssigneeOptions(ROSTER, cur, { unassignedValue: '' });
    assert.equal(sel(opts).length, 1, 'exactly one selected for current=' + JSON.stringify(cur));
  });
});

test('an on-roster assignee is NOT duplicated', () => {
  const opts = buildAssigneeOptions(ROSTER, 'Capote');
  assert.equal(vals(opts).filter((v) => v === 'Capote').length, 1);
  assert.equal(sel(opts)[0].value, 'Capote');
});

// ── the two floor sentinels, which disagree on purpose ───────
test('lifts keep unassignedValue "" — changing it would rewrite live rows', () => {
  const opts = buildAssigneeOptions(ROSTER, '', { unassignedValue: '' });
  assert.equal(opts[0].value, '');
  assert.equal(opts[0].label, 'Unassigned');
  assert.ok(opts[0].selected);
});

test('parking keeps unassignedValue "Unassigned" — the literal string is stored', () => {
  const opts = buildAssigneeOptions(ROSTER, 'Unassigned', { unassignedValue: 'Unassigned' });
  assert.equal(opts[0].value, 'Unassigned');
  assert.ok(opts[0].selected);
  assert.equal(vals(opts).filter((v) => v === 'Unassigned').length, 1, 'sentinel not duplicated');
});

test('both sentinels count as nobody, whichever the caller stores', () => {
  UNASSIGNED_SENTINELS.forEach((s) => {
    assert.ok(isUnassignedValue(s));
    const opts = buildAssigneeOptions(ROSTER, s, { unassignedValue: s });
    assert.ok(opts[0].selected, 'sentinel ' + JSON.stringify(s) + ' selects the unassigned row');
    assert.equal(sel(opts).length, 1);
  });
});

// ── hygiene ──────────────────────────────────────────────────
test('roster entries that are objects, blank, or the sentinel are handled', () => {
  const opts = buildAssigneeOptions(
    [{ name: 'Capote' }, '', null, 'Unassigned', '  Alnardier  '], 'Capote');
  assert.deepEqual(vals(opts), ['', 'Capote', 'Alnardier']);
});

test('a duplicated roster name yields ONE option, never two selected', () => {
  const opts = buildAssigneeOptions(['Capote', 'Capote'], 'Capote');
  assert.equal(vals(opts).filter((v) => v === 'Capote').length, 1);
  assert.equal(sel(opts).length, 1);
});

test('an empty roster still offers the current assignee', () => {
  const opts = buildAssigneeOptions([], 'ZZ Test Owner');
  assert.deepEqual(vals(opts), ['', 'ZZ Test Owner']);
  assert.equal(sel(opts).length, 1);
});

// ── the generic primitive, shared with ro-writer ─────────────
test('appendCurrentIfMissing appends only when nothing is selected', () => {
  const built = [{ id: 'a', selected: false }];
  assert.equal(appendCurrentIfMissing(built, true, () => ({ id: 'x', selected: true })).length, 2);
  assert.equal(appendCurrentIfMissing([{ id: 'a', selected: true }], true, () => {
    throw new Error('must not be called when something is already selected');
  }).length, 1);
  assert.equal(appendCurrentIfMissing(built, false, () => {
    throw new Error('must not be called when nothing is assigned');
  }).length, 1);
});
