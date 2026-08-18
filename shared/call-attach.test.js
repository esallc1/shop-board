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
  wouldLearnPhone, countForeignCalls, phoneLearnDefaultYes, phoneLearnDeclineKey,
  isPhoneLearnDeclined, rememberPhoneLearnDecline, PHONE_LEARN_DECLINE_CAP,
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

// ── CONFIRM BEFORE LEARNING ──────────────────────────────────
// The real incident these lock in: attaching one call from 305-393-9103
// (Hector's number, 6 unattached calls already in the table) to JOSE RAMIREZ
// silently wrote it into Jose's empty phone_secondary, and every one of those
// calls then surfaced on Jose's record as "unconfirmed".
const JOSE = { id: 'jose', name: 'JOSE RAMIREZ', phone_primary: '8135909459', phone_secondary: null };
const HECTOR_NUM = '3053939103';

// ── wouldLearnPhone: ask ONLY when a write would really happen ──
test('wouldLearnPhone is true only when a number would actually be saved', () => {
  assert.equal(wouldLearnPhone(HECTOR_NUM, JOSE), true);                       // new number, empty slot
  assert.equal(wouldLearnPhone('8135909459', JOSE), false);                    // already the primary
  assert.equal(wouldLearnPhone('(813) 590-9459', JOSE), false);                // same number, formatted
  assert.equal(wouldLearnPhone(HECTOR_NUM, { ...JOSE, phone_secondary: HECTOR_NUM }), false);  // already the secondary
  assert.equal(wouldLearnPhone(HECTOR_NUM, { ...JOSE, phone_secondary: '2395551234' }), false); // slot occupied — never overwrite
  assert.equal(wouldLearnPhone('12345', JOSE), false);                         // not 10 digits
  assert.equal(wouldLearnPhone(null, JOSE), false);
  assert.equal(wouldLearnPhone(HECTOR_NUM, null), false);
});

test('wouldLearnPhone agrees with phoneLearningPlan — one source of truth', () => {
  // The prompt must never appear when the writer would decline to write, and
  // never be skipped when it would write. Same gate, asserted together.
  const cases = [
    [HECTOR_NUM, JOSE], ['8135909459', JOSE], [HECTOR_NUM, { ...JOSE, phone_secondary: '2395551234' }],
    ['', JOSE], [HECTOR_NUM, {}],
  ];
  for (const [num, cust] of cases) {
    assert.equal(wouldLearnPhone(num, cust), !!phoneLearningPlan(num, cust).customerPatch);
  }
});

// ── countForeignCalls / phoneLearnDefaultYes: which way the prompt starts ──
test('UNATTACHED calls from the number count as foreign — the case that bit us', () => {
  // Hector's other 5 calls are all customer_id null. "Nobody has claimed these"
  // is still evidence the number may not be Jose's.
  const others = [{ customer_id: null }, { customer_id: null }, { customer_id: null }, { customer_id: null }, { customer_id: null }];
  assert.equal(countForeignCalls(others, 'jose'), 5);
  assert.equal(phoneLearnDefaultYes(others, 'jose'), false, 'must default to NO');
});

test('calls attached to a DIFFERENT customer count as foreign', () => {
  assert.equal(countForeignCalls([{ customer_id: 'someone-else' }], 'jose'), 1);
  assert.equal(phoneLearnDefaultYes([{ customer_id: 'someone-else' }], 'jose'), false);
});

test('calls already belonging to THIS customer are not foreign', () => {
  const others = [{ customer_id: 'jose' }, { customer_id: 'jose' }];
  assert.equal(countForeignCalls(others, 'jose'), 0);
  assert.equal(phoneLearnDefaultYes(others, 'jose'), true, 'a number they already call from → default YES');
});

test('no other calls at all → default YES (a genuinely new number)', () => {
  assert.equal(phoneLearnDefaultYes([], 'jose'), true);
  assert.equal(phoneLearnDefaultYes(null, 'jose'), true);
  assert.equal(countForeignCalls(null, 'jose'), 0);
});

test('one foreign call among this customer\'s own is enough to default NO', () => {
  const others = [{ customer_id: 'jose' }, { customer_id: 'jose' }, { customer_id: null }];
  assert.equal(countForeignCalls(others, 'jose'), 1);
  assert.equal(phoneLearnDefaultYes(others, 'jose'), false);
});

test('countForeignCalls ignores junk rows and compares ids as strings', () => {
  assert.equal(countForeignCalls([null, undefined, { customer_id: 'jose' }], 'jose'), 0);
  assert.equal(countForeignCalls([{ customer_id: 7 }], 7), 0);      // number vs number
  assert.equal(countForeignCalls([{ customer_id: '7' }], 7), 0);    // string vs number id
});

// ── the decline memo ──
test('phoneLearnDeclineKey scopes a decline to the (customer, number) PAIR', () => {
  const k = phoneLearnDeclineKey('jose', '(305) 393-9103');
  assert.equal(k, 'jose|3053939103');                               // normalized to last-10
  assert.notEqual(k, phoneLearnDeclineKey('other-cust', HECTOR_NUM), 'a different customer is a different question');
  assert.notEqual(k, phoneLearnDeclineKey('jose', '2395551234'), 'a different number is a different question');
  assert.equal(phoneLearnDeclineKey(null, HECTOR_NUM), null);
  assert.equal(phoneLearnDeclineKey('jose', '12345'), null);        // not a usable number
});

test('isPhoneLearnDeclined works with an Array or a Set, and is false when unknown', () => {
  const k = phoneLearnDeclineKey('jose', HECTOR_NUM);
  assert.equal(isPhoneLearnDeclined([k], 'jose', HECTOR_NUM), true);
  assert.equal(isPhoneLearnDeclined(new Set([k]), 'jose', HECTOR_NUM), true);
  assert.equal(isPhoneLearnDeclined([], 'jose', HECTOR_NUM), false);
  assert.equal(isPhoneLearnDeclined(null, 'jose', HECTOR_NUM), false);
  assert.equal(isPhoneLearnDeclined([k], 'other-cust', HECTOR_NUM), false);
  assert.equal(isPhoneLearnDeclined([k], 'jose', '2395551234'), false);
});

test('rememberPhoneLearnDecline appends, de-dupes, caps, and never mutates', () => {
  const k1 = 'jose|3053939103', k2 = 'jose|2395551234';
  const start = [k1];
  const out = rememberPhoneLearnDecline(start, k2);
  assert.deepEqual(out, [k1, k2]);
  assert.deepEqual(start, [k1], 'input must not be mutated');
  assert.deepEqual(rememberPhoneLearnDecline([k1, k2], k1), [k2, k1], 're-declining moves it to newest, no duplicate');
  const many = Array.from({ length: 5 }, (_, i) => 'c|' + i);
  assert.deepEqual(rememberPhoneLearnDecline(many, 'c|new', 3), ['c|3', 'c|4', 'c|new'], 'capped to the newest N');
  assert.equal(PHONE_LEARN_DECLINE_CAP, 200);
});

test('a decline is remembered but NEVER blocks the attach itself', () => {
  // The memo only suppresses the QUESTION. attachCallPatch — the thing that
  // actually links the call — has no knowledge of it and no learned flag set.
  const p = attachCallPatch('jose', 'Josh', '2026-08-18T00:00:00.000Z', false);
  assert.equal(p.customer_id, 'jose');
  assert.equal(p.learned_phone, false);
});
