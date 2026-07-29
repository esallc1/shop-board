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
  isMissingColumn, phoneLearningPlan, attachPhoneLearn, attachCallPatch, unattachCallPatch,
  unattachClearsSecondary, notACustomerPatch, clearNotACustomerPatch, isUnattached,
} from './call-attach.js';

// A fake `customers` table backed by one row, with an ATOMIC setSecondaryIfNull
// that mirrors `UPDATE ... SET phone_secondary = v WHERE id = ? AND
// phone_secondary IS NULL` returning the affected row count. This is the seam
// that makes the decision the DB's, not the caller's snapshot.
function fakeCustomerStore(initialRow) {
  const row = { ...initialRow };
  return {
    row,
    setSecondaryIfNull: async (id, value) => {
      if (id !== row.id) return 0;
      if (row.phone_secondary == null) { row.phone_secondary = value; return 1; }  // claimed empty slot
      return 0;                                                                     // occupied → no write
    },
  };
}

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

// ── attachPhoneLearn: race-proof against a stale customer snapshot ───────────
test('attachPhoneLearn learns a new number into an empty slot (learned_phone true)', async () => {
  const store = fakeCustomerStore({ id: 'c1', phone_primary: '2032122374', phone_secondary: null });
  const cust = { id: 'c1', phone_primary: '2032122374', phone_secondary: null };
  const res = await attachPhoneLearn({ callerBare: '2392725177', customer: cust, setSecondaryIfNull: store.setSecondaryIfNull });
  assert.deepEqual(res, { learnedPhone: true, wrote: '2392725177' });
  assert.equal(store.row.phone_secondary, '2392725177');
});

// THE REPRODUCED BUG: ALEX PELLOT. Two DIFFERENT numbers attached to the SAME
// customer in sequence; the second attach decides against a STALE snapshot that
// still shows phone_secondary empty. The atomic writer must refuse the second.
test('two different numbers to the SAME customer: second writes nothing, learned_phone false (stale snapshot)', async () => {
  const store = fakeCustomerStore({ id: 'alex', phone_primary: '2032122374', phone_secondary: null });

  // Attach #1 — call 4381075115 / caller 2392725177. Slot empty → learns it.
  const snap1 = { id: 'alex', phone_primary: '2032122374', phone_secondary: null };
  const first = await attachPhoneLearn({ callerBare: '2392725177', customer: snap1, setSecondaryIfNull: store.setSecondaryIfNull });
  assert.deepEqual(first, { learnedPhone: true, wrote: '2392725177' });
  assert.equal(store.row.phone_secondary, '2392725177');

  // Attach #2 — call 4380799274 / caller 2396003735, 16s later. The snapshot is
  // STALE: it still reads phone_secondary = null (the exact bug condition).
  const staleSnap = { id: 'alex', phone_primary: '2032122374', phone_secondary: null };
  const second = await attachPhoneLearn({ callerBare: '2396003735', customer: staleSnap, setSecondaryIfNull: store.setSecondaryIfNull });
  assert.deepEqual(second, { learnedPhone: false, wrote: null }, 'second attach must NOT claim to have learned');
  assert.equal(store.row.phone_secondary, '2392725177', 'first number is preserved — no overwrite');
});

test('attachPhoneLearn never duplicates the primary number (no writer call)', async () => {
  let called = 0;
  const setSecondaryIfNull = async () => { called++; return 1; };
  const cust = { id: 'c1', phone_primary: '(239) 272-5177', phone_secondary: null };
  const res = await attachPhoneLearn({ callerBare: '2392725177', customer: cust, setSecondaryIfNull });
  assert.deepEqual(res, { learnedPhone: false, wrote: null });
  assert.equal(called, 0, 'must not even attempt a write when caller is the primary');
});

test('attachPhoneLearn: caller already equals the (already-learned) secondary → no re-claim', async () => {
  // snapshot shows the number already in secondary → intent gate skips the write
  const cust = { id: 'c1', phone_primary: '2032122374', phone_secondary: '2392725177' };
  let called = 0;
  const res = await attachPhoneLearn({ callerBare: '2392725177', customer: cust, setSecondaryIfNull: async () => { called++; return 0; } });
  assert.deepEqual(res, { learnedPhone: false, wrote: null });
  assert.equal(called, 0);
});

test('attachPhoneLearn: intent says write but the DB reports the slot occupied → learned_phone false', async () => {
  // snapshot says empty, but the atomic writer returns 0 rows (occupied at write
  // time). learned_phone follows the DB, not the snapshot.
  const cust = { id: 'c1', phone_primary: '2032122374', phone_secondary: null };
  const res = await attachPhoneLearn({ callerBare: '2396003735', customer: cust, setSecondaryIfNull: async () => 0 });
  assert.deepEqual(res, { learnedPhone: false, wrote: null });
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
