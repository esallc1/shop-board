/* ============================================================
   call-auto-attach.test.js — unit tests for the ROBOT half of call filing.
   Run: npm test   (node --test)

   These lock the things that would hurt if they broke:
     • NEVER GUESS — 0 matches and 2+ matches both return null, for the
       customer rule and the open-RO rule alike;
     • the open-at-time predicate matches the backfill SQL exactly, including
       its boundaries and its NULL handling;
     • no patch this module produces can write phone_primary, phone_secondary,
       learned_phone, attached_by_name or attached_at;
     • a human's row (customer_id set, or not-a-customer) is never eligible.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_ATTACH_LIVE_RUN_ID, last10Key, isJunkNumber, shouldAutoAttach, isOpenRoAt,
  pickCustomer, pickOpenRoAt, autoAttachCallPatch, autoFileRoPatch,
  clearAutoTagsPatch, clearAutoFileTagsPatch, isAutoAttached,
} from './call-auto-attach.js';

// The columns the robot must never write, in any patch, ever.
const HUMAN_ONLY = ['phone_primary', 'phone_secondary', 'learned_phone', 'attached_by_name', 'attached_at'];

// ── last10Key ────────────────────────────────────────────────
test('last10Key strips formatting and keeps the last 10 digits', () => {
  assert.equal(last10Key('(786) 531-5419'), '7865315419');
  assert.equal(last10Key('+1 813-590-9459'), '8135909459');
  assert.equal(last10Key('8135909459'), '8135909459');
  assert.equal(last10Key(null), '');
  assert.equal(last10Key(''), '');
  assert.equal(last10Key('12345'), '12345');            // short: returned as-is, junk gate rejects it
});

// ── isJunkNumber — the SQL twin ──────────────────────────────
test('isJunkNumber rejects short, placeholder and repeated-digit numbers', () => {
  assert.equal(isJunkNumber('8135909459'), false);
  assert.equal(isJunkNumber('1234567890'), true);       // the placeholder
  assert.equal(isJunkNumber('0000000000'), true);       // repeated-digit junk
  assert.equal(isJunkNumber('1111111111'), true);
  assert.equal(isJunkNumber('9999999999'), true);
  assert.equal(isJunkNumber('786531541'), true);        // 9 digits
  assert.equal(isJunkNumber('78653154199'), true);      // 11 digits
  assert.equal(isJunkNumber(''), true);
  assert.equal(isJunkNumber(null), true);
});

// ── shouldAutoAttach — the eligibility gate ──────────────────
test('shouldAutoAttach never touches an attached or not-a-customer row', () => {
  assert.equal(shouldAutoAttach({ caller_bare: '8135909459' }), true);
  assert.equal(shouldAutoAttach({ caller_bare: '8135909459', customer_id: 'c1' }), false);
  assert.equal(shouldAutoAttach({ caller_bare: '8135909459', not_a_customer_at: '2026-08-01T00:00:00Z' }), false);
  assert.equal(shouldAutoAttach({ caller_bare: '1234567890' }), false);
  assert.equal(shouldAutoAttach({ caller_bare: null }), false);
  assert.equal(shouldAutoAttach(null), false);
});

// ── pickCustomer — RULE 1, never guess ───────────────────────
test('pickCustomer returns the id on exactly one match', () => {
  assert.equal(pickCustomer([{ id: 'cust-1' }]), 'cust-1');
  assert.equal(pickCustomer(['cust-1']), 'cust-1');
});

test('pickCustomer returns null on 0 matches (stranger) and 2+ (ambiguous)', () => {
  assert.equal(pickCustomer([]), null);
  assert.equal(pickCustomer(null), null);
  assert.equal(pickCustomer([{ id: 'cust-1' }, { id: 'cust-2' }]), null);
  assert.equal(pickCustomer([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), null);
});

test('pickCustomer dedupes one customer matched on BOTH phone columns', () => {
  // count(DISTINCT customer_id) = 1 in the SQL — the same person twice is
  // still one person, not an ambiguous pair.
  assert.equal(pickCustomer([{ id: 'cust-1' }, { id: 'cust-1' }]), 'cust-1');
});

// ── isOpenRoAt — the SQL twin, boundaries included ───────────
const AT = '2026-07-31T12:30:17Z';

test('isOpenRoAt: created before, never closed or declined → open', () => {
  assert.equal(isOpenRoAt({ id: 'r1', status: 'ro', created_at: '2026-07-27T15:55:37Z' }, AT), true);
});

test('isOpenRoAt: created AFTER the call → not open', () => {
  assert.equal(isOpenRoAt({ id: 'r1', status: 'ro', created_at: '2026-08-01T00:00:00Z' }, AT), false);
});

test('isOpenRoAt: closed or declined BEFORE the call → not open', () => {
  const base = { id: 'r1', status: 'closed', created_at: '2026-07-01T00:00:00Z' };
  assert.equal(isOpenRoAt({ ...base, closed_at: '2026-07-30T00:00:00Z' }, AT), false);
  assert.equal(isOpenRoAt({ ...base, status: 'estimate', declined_at: '2026-07-30T00:00:00Z' }, AT), false);
});

test('isOpenRoAt: closed or declined AFTER the call → still open at call time', () => {
  // The whole point of "open AT THE TIME OF THE CALL": RO #5451 is closed
  // today, but it was open when the customer rang.
  const base = { id: 'r1', created_at: '2026-07-01T00:00:00Z' };
  assert.equal(isOpenRoAt({ ...base, status: 'closed', closed_at: '2026-08-15T00:00:00Z' }, AT), true);
  assert.equal(isOpenRoAt({ ...base, status: 'estimate', declined_at: '2026-08-15T00:00:00Z' }, AT), true);
});

test('isOpenRoAt boundaries: created_at == call time is open; closed_at == call time is closed', () => {
  // SQL: created_at <= at  (inclusive) and closed_at > at (exclusive).
  assert.equal(isOpenRoAt({ id: 'r1', status: 'ro', created_at: AT }, AT), true);
  assert.equal(isOpenRoAt({ id: 'r1', status: 'closed', created_at: '2026-07-01T00:00:00Z', closed_at: AT }, AT), false);
});

test('isOpenRoAt: status closed with NO closed_at is never open', () => {
  // The undated-close case the SQL guards with
  //   not (closed_at is null and status = 'closed')
  assert.equal(isOpenRoAt({ id: 'r1', status: 'closed', created_at: '2026-07-01T00:00:00Z', closed_at: null }, AT), false);
});

test('isOpenRoAt: unusable timestamps are NOT open (cannot prove it, so no)', () => {
  assert.equal(isOpenRoAt({ id: 'r1', status: 'ro', created_at: null }, AT), false);
  assert.equal(isOpenRoAt({ id: 'r1', status: 'ro', created_at: 'not a date' }, AT), false);
  assert.equal(isOpenRoAt({ id: 'r1', status: 'ro', created_at: '2026-07-01T00:00:00Z' }, null), false);
  assert.equal(isOpenRoAt(null, AT), false);
});

test('isOpenRoAt compares instants, not strings (offset forms must agree)', () => {
  // PostgREST returns "+00:00"; a naive string compare would get this wrong.
  const ro = { id: 'r1', status: 'ro', created_at: '2026-07-27T15:55:37.94745+00:00' };
  assert.equal(isOpenRoAt(ro, '2026-07-31T12:30:17+00:00'), true);
  assert.equal(isOpenRoAt(ro, '2026-07-27T11:55:37-05:00'), true);   // same instant as created_at
  assert.equal(isOpenRoAt(ro, '2026-07-27T10:55:37-05:00'), false);  // one hour earlier
});

// ── pickOpenRoAt — RULE 2, never guess ───────────────────────
test('pickOpenRoAt returns the id when exactly one RO was open', () => {
  const ros = [
    { id: 'ro-open', status: 'ro', created_at: '2026-07-27T00:00:00Z' },
    { id: 'ro-old', status: 'closed', created_at: '2026-06-01T00:00:00Z', closed_at: '2026-06-20T00:00:00Z' },
    { id: 'ro-future', status: 'ro', created_at: '2026-08-20T00:00:00Z' },
  ];
  assert.equal(pickOpenRoAt(ros, AT), 'ro-open');
});

test('pickOpenRoAt returns null on zero open and on 2+ open', () => {
  assert.equal(pickOpenRoAt([], AT), null);
  assert.equal(pickOpenRoAt(null, AT), null);
  assert.equal(pickOpenRoAt([{ id: 'a', status: 'closed', created_at: '2026-06-01T00:00:00Z', closed_at: '2026-06-02T00:00:00Z' }], AT), null);
  assert.equal(pickOpenRoAt([
    { id: 'a', status: 'ro', created_at: '2026-07-01T00:00:00Z' },
    { id: 'b', status: 'estimate', created_at: '2026-07-02T00:00:00Z' },
  ], AT), null);
});

// ── the patches ──────────────────────────────────────────────
test('autoAttachCallPatch writes customer_id + the machine mark + the run id', () => {
  const p = autoAttachCallPatch('cust-1', '2026-08-18T15:00:00.000Z');
  assert.deepEqual(p, {
    customer_id: 'cust-1',
    auto_attached_at: '2026-08-18T15:00:00.000Z',
    auto_attach_run_id: AUTO_ATTACH_LIVE_RUN_ID,
  });
});

test('autoFileRoPatch never carries auto_attached_at — a human attached that customer', () => {
  // This is the pass-2 shape: file the RO, leave the human's attach alone.
  const p = autoFileRoPatch('ro-1', '2026-08-18T15:00:00.000Z');
  assert.deepEqual(p, {
    ro_id: 'ro-1',
    auto_ro_filed_at: '2026-08-18T15:00:00.000Z',
    auto_attach_run_id: AUTO_ATTACH_LIVE_RUN_ID,
  });
  assert.ok(!('auto_attached_at' in p));
  assert.ok(!('customer_id' in p));
});

test('a custom run id overrides the LIVE sentinel (backfills use their own)', () => {
  const run = '11111111-2222-4333-8444-555555555555';
  assert.equal(autoAttachCallPatch('c', 'now', run).auto_attach_run_id, run);
  assert.equal(autoFileRoPatch('r', 'now', run).auto_attach_run_id, run);
});

test('NO robot patch can write a human-only column', () => {
  const patches = [
    autoAttachCallPatch('cust-1', 'now'),
    autoFileRoPatch('ro-1', 'now'),
    clearAutoTagsPatch(),
    clearAutoFileTagsPatch(),
  ];
  for (const p of patches) {
    for (const col of HUMAN_ONLY) {
      assert.ok(!(col in p), `${col} must never appear in a robot patch`);
    }
  }
});

test('clearAutoTagsPatch clears every robot mark and nothing else', () => {
  const p = clearAutoTagsPatch();
  assert.deepEqual(p, { auto_attached_at: null, auto_ro_filed_at: null, auto_attach_run_id: null });
  assert.ok(!('customer_id' in p), 'clearing robot tags must never null a customer attach');
  assert.ok(!('ro_id' in p), 'ro_id is cleared explicitly by the caller, not implied here');
});

test('clearAutoFileTagsPatch detaches a manually re-filed row from every batch undo', () => {
  const p = clearAutoFileTagsPatch();
  assert.deepEqual(p, { auto_ro_filed_at: null, auto_attach_run_id: null });
  // The run id is the undo key. Dropping it is what makes a human's re-file
  // unreachable by any reverse statement — that is the whole point.
  assert.equal(p.auto_attach_run_id, null);
  // auto_attached_at SURVIVES a re-file: it stays true because it is true.
  assert.ok(!('auto_attached_at' in p), 'a re-file must not erase the record that the machine picked the customer');
  assert.ok(!('customer_id' in p), 're-filing an RO must never touch the customer');
  assert.ok(!('ro_id' in p), 'ro_id is set by the caller alongside this patch');
});

test('isAutoAttached distinguishes the robot from the crew', () => {
  assert.equal(isAutoAttached({ auto_attached_at: '2026-08-18T00:00:00Z' }), true);
  assert.equal(isAutoAttached({ attached_by_name: 'Josh', attached_at: '2026-08-18T00:00:00Z' }), false);
  assert.equal(isAutoAttached({ auto_ro_filed_at: '2026-08-18T00:00:00Z' }), false); // RO filed, human attached
  assert.equal(isAutoAttached({}), false);
  assert.equal(isAutoAttached(null), false);
});

// ── the LIVE sentinel must never collide with a backfill batch ──
test('the LIVE run id is distinct from both hand-run backfill ids', () => {
  assert.notEqual(AUTO_ATTACH_LIVE_RUN_ID, '11111111-2222-4333-8444-555555555555');
  assert.notEqual(AUTO_ATTACH_LIVE_RUN_ID, '22222222-3333-4444-8555-666666666666');
  assert.match(AUTO_ATTACH_LIVE_RUN_ID, /^[0-9a-f-]{36}$/);
});
