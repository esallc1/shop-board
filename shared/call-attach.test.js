/* ============================================================
   call-attach.test.js — unit tests for the Desk call-log attach logic.
   Run: npm test   (node --test)

   These lock the invariants that matter: phone_primary is never written, a
   pre-existing phone_secondary can never be deleted by un-attaching, phone
   learning only fills an empty slot, and the unattached filter reads the
   persisted columns (so a phone-matched-but-unconfirmed call still shows up).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMissingColumn, phoneLearningPlan, attachCallPatch, unattachCallPatch,
  unattachClearsSecondary, notACustomerPatch, clearNotACustomerPatch, isUnattached,
} from './call-attach.js';

// ── attach writes customer_id + attribution ──────────────────
test('attachCallPatch writes customer_id + attribution + learned flag', () => {
  const p = attachCallPatch('cust-1', 'Josh', '2026-07-29T15:00:00.000Z', true);
  assert.deepEqual(p, {
    customer_id: 'cust-1',
    attached_by_name: 'Josh',
    attached_at: '2026-07-29T15:00:00.000Z',
    learned_phone: true,
  });
});

test('attachCallPatch coerces a missing name to null and learned to boolean', () => {
  const p = attachCallPatch('cust-1', null, 'now', undefined);
  assert.equal(p.attached_by_name, null);
  assert.equal(p.learned_phone, false);
});

// ── phone learning ───────────────────────────────────────────
test('phone learning: caller already matches phone_primary → no write, learned_phone false', () => {
  const plan = phoneLearningPlan('2396001971', { phone_primary: '(239) 600-1971', phone_secondary: null });
  assert.equal(plan.learnedPhone, false);
  assert.equal(plan.customerPatch, null);
});

test('phone learning: caller already matches phone_secondary → no write, learned_phone false', () => {
  const plan = phoneLearningPlan('2396001971', { phone_primary: '2395550000', phone_secondary: '239-600-1971' });
  assert.equal(plan.learnedPhone, false);
  assert.equal(plan.customerPatch, null);
});

test('phone learning: new number + EMPTY phone_secondary → written (10 digits), learned_phone true', () => {
  const plan = phoneLearningPlan('(239) 600-1971', { phone_primary: '2395550000', phone_secondary: null });
  assert.equal(plan.learnedPhone, true);
  assert.deepEqual(plan.customerPatch, { phone_secondary: '2396001971' });   // canonical 10 digits
  // blank string counts as empty too
  const plan2 = phoneLearningPlan('2396001971', { phone_primary: '2395550000', phone_secondary: '   ' });
  assert.equal(plan2.learnedPhone, true);
  assert.deepEqual(plan2.customerPatch, { phone_secondary: '2396001971' });
});

test('phone learning: new number + OCCUPIED phone_secondary → no write, learned_phone false, existing value intact', () => {
  const customer = { phone_primary: '2395550000', phone_secondary: '(305) 111-2222' };
  const before = { ...customer };
  const plan = phoneLearningPlan('2396001971', customer);
  assert.equal(plan.learnedPhone, false);
  assert.equal(plan.customerPatch, null);
  assert.deepEqual(customer, before, 'input customer not mutated');
});

test('phone learning: short/garbage caller → no write', () => {
  assert.equal(phoneLearningPlan('123', { phone_primary: null, phone_secondary: null }).customerPatch, null);
  assert.equal(phoneLearningPlan('2396001971', null).customerPatch, null);
});

test('phone learning NEVER targets phone_primary — customerPatch only ever names phone_secondary', () => {
  // Exhaustive over the branches: whatever the inputs, a produced patch touches
  // phone_secondary and nothing else.
  const cases = [
    ['2396001971', { phone_primary: null, phone_secondary: null }],
    ['2396001971', { phone_primary: '2395550000', phone_secondary: null }],
    ['2396001971', { phone_primary: '2396001971', phone_secondary: null }],
    ['2396001971', { phone_primary: '2395550000', phone_secondary: '3051112222' }],
  ];
  for (const [caller, cust] of cases) {
    const { customerPatch } = phoneLearningPlan(caller, cust);
    if (customerPatch) {
      assert.deepEqual(Object.keys(customerPatch), ['phone_secondary']);
      assert.ok(!('phone_primary' in customerPatch));
    }
  }
});

// ── un-attach ────────────────────────────────────────────────
test('unattachCallPatch clears the confirmation + attribution + learned flag', () => {
  assert.deepEqual(unattachCallPatch(), {
    customer_id: null, attached_by_name: null, attached_at: null, learned_phone: false,
  });
});

test('un-attach with learned_phone TRUE → clears phone_secondary', () => {
  assert.equal(unattachClearsSecondary({ learned_phone: true }), true);
});

test('un-attach with learned_phone FALSE → leaves customers untouched (pre-existing number safe)', () => {
  assert.equal(unattachClearsSecondary({ learned_phone: false }), false);
  assert.equal(unattachClearsSecondary({ learned_phone: null }), false);
  assert.equal(unattachClearsSecondary({}), false);
  assert.equal(unattachClearsSecondary(null), false);
});

// ── not a customer ───────────────────────────────────────────
test('notACustomerPatch sets the mark + attribution, does not touch customer_id', () => {
  const p = notACustomerPatch('Josh', '2026-07-29T15:00:00.000Z');
  assert.deepEqual(p, { not_a_customer_at: '2026-07-29T15:00:00.000Z', not_a_customer_by_name: 'Josh' });
  assert.ok(!('customer_id' in p));
});

test('clearNotACustomerPatch reverses the mark', () => {
  assert.deepEqual(clearNotACustomerPatch(), { not_a_customer_at: null, not_a_customer_by_name: null });
});

// ── unattached filter (persisted columns only) ───────────────
test('unattached filter includes a phone-matched-but-unconfirmed call', () => {
  // customer_id is NULL (nobody confirmed) even though this caller phone-matches
  // a customer live — it BELONGS in the unattached list.
  const phoneMatchedButUnconfirmed = { id: 1, caller_bare: '2396001971', customer_id: null, not_a_customer_at: null };
  assert.equal(isUnattached(phoneMatchedButUnconfirmed), true);
});

test('unattached filter excludes attached and not-a-customer calls', () => {
  assert.equal(isUnattached({ customer_id: 'cust-1', not_a_customer_at: null }), false);
  assert.equal(isUnattached({ customer_id: null, not_a_customer_at: '2026-07-29T00:00:00Z' }), false);
});

test('not_a_customer removes a row from the unattached list, and clearing restores it', () => {
  const call = { id: 7, customer_id: null, not_a_customer_at: null };
  assert.equal(isUnattached(call), true);                         // starts in the list
  Object.assign(call, notACustomerPatch('Josh', 'now'));
  assert.equal(isUnattached(call), false);                        // marked → leaves the list
  Object.assign(call, clearNotACustomerPatch());
  assert.equal(isUnattached(call), true);                         // reversible → back in the list
});

// ── pre-migration dormancy ───────────────────────────────────
test('isMissingColumn detects the pre-migration errors', () => {
  assert.ok(isMissingColumn({ code: '42703' }));
  assert.ok(isMissingColumn({ code: 'PGRST204' }));
  assert.ok(isMissingColumn({ message: 'column "learned_phone" does not exist' }));
  assert.ok(!isMissingColumn({ code: '23503' }));
  assert.ok(!isMissingColumn(null));
});
