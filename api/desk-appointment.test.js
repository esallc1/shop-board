/* ============================================================
   desk-appointment.test.js — unit tests for the manual-add endpoint's PURE
   helpers. The invariants (Desk-lane steps only, identity required, synthetic
   ctm_call_id always negative) live here.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApptBody, syntheticCtmId, APPT_STEPS } from './desk-appointment.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const DUE = '2026-08-04T16:00:00.000Z';

// ── parseApptBody: happy paths ──────────────────────────────
test('accepts a drop-off with a 10-digit phone', () => {
  const r = parseApptBody({ next_step: 'dropping_off', due_at: DUE, caller_bare: '(239) 555-0123' });
  assert.equal(r.ok, true);
  assert.equal(r.row.next_step, 'dropping_off');
  assert.equal(r.row.caller_bare, '2395550123');   // normalized to digits
  assert.equal(r.row.due_all_day, true);           // default
  assert.equal(r.row.customer_id, null);
});

test('accepts a callback linked to a customer with no phone', () => {
  const r = parseApptBody({ next_step: 'quoted_callback', due_at: DUE, customer_id: UUID });
  assert.equal(r.ok, true);
  assert.equal(r.row.customer_id, UUID);
  assert.equal(r.row.caller_bare, null);
});

test('a specific time is an explicit due_all_day:false', () => {
  const r = parseApptBody({ next_step: 'dropping_off', due_at: DUE, caller_bare: '2395550123', due_all_day: false });
  assert.equal(r.row.due_all_day, false);
});

// ── parseApptBody: rejections ───────────────────────────────
test('rejects a non-Desk step (checking_on_car / price_shopper)', () => {
  assert.equal(parseApptBody({ next_step: 'checking_on_car', due_at: DUE, caller_bare: '2395550123' }).ok, false);
  assert.equal(parseApptBody({ next_step: 'price_shopper', due_at: DUE, caller_bare: '2395550123' }).ok, false);
  assert.equal(parseApptBody({ due_at: DUE, caller_bare: '2395550123' }).ok, false);
});

test('rejects a bad / missing due_at', () => {
  assert.equal(parseApptBody({ next_step: 'dropping_off', caller_bare: '2395550123' }).ok, false);
  assert.equal(parseApptBody({ next_step: 'dropping_off', due_at: 'not-a-date', caller_bare: '2395550123' }).ok, false);
});

test('rejects when there is no identity (no 10-digit phone AND no customer)', () => {
  assert.equal(parseApptBody({ next_step: 'dropping_off', due_at: DUE }).ok, false);
  assert.equal(parseApptBody({ next_step: 'dropping_off', due_at: DUE, caller_bare: '555' }).ok, false);  // too short
});

test('rejects a non-uuid customer_id', () => {
  assert.equal(parseApptBody({ next_step: 'dropping_off', due_at: DUE, customer_id: 'nope' }).ok, false);
});

test('APPT_STEPS excludes the non-schedulable steps', () => {
  assert.deepEqual(APPT_STEPS, ['quoted_callback', 'dropping_off']);
});

// ── syntheticCtmId: always negative, distinct ───────────────
test('syntheticCtmId is always negative (never collides with a positive CTM id)', () => {
  assert.ok(syntheticCtmId(1_700_000_000_000, 0.5) < 0);
  assert.ok(syntheticCtmId(0, 0) <= 0);
  assert.ok(Number.isSafeInteger(syntheticCtmId(1_700_000_000_000, 0.999)));
});

test('syntheticCtmId separates two same-ms adds by the random component', () => {
  const a = syntheticCtmId(1_700_000_000_000, 0.1);
  const b = syntheticCtmId(1_700_000_000_000, 0.9);
  assert.notEqual(a, b);
});
