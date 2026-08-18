/* ============================================================
   call-attach.js — pure decision logic for attaching / un-attaching a call to
   a customer on the Desk call log, plus the "not a customer" mark and the
   unattached-filter predicate.

   This is the SINGLE, TESTED source of truth for the data operations. It holds
   the invariants the task cares most about:
     • phone_primary is NEVER written — no code path here even names it as a
       write target;
     • customers.phone_secondary is only WRITTEN when the caller's number is new
       AND the slot is empty (learnedPhone=true), and only DELETED on un-attach
       when learnedPhone was true — i.e. only the number this attach itself
       wrote, so a pre-existing number can never be lost;
     • the unattached filter reads the PERSISTED columns only (customer_id /
       not_a_customer_at), never a live phone match — so a phone-matched-but-
       unconfirmed call still counts as unattached and stays in the list.

   No DOM, no globals, no db. Loaded in the browser as an ES module that assigns
   window.CallAttach (see advisor-board.html) and imported directly by
   shared/call-attach.test.js under `node --test`.
   ============================================================ */

// Last-10-digits normalizer. The browser passes window.cdLast10 (the ONE shared
// implementation); this default exists only so the module is self-contained
// under test. Never mutates input.
const last10Default = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-10);

// PostgREST "column/relationship missing" — the pre-migration state. 42703 =
// Postgres undefined_column; PGRST204 = PostgREST schema-cache miss on write.
export function isMissingColumn(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = err.message || '';
  return code === '42703' || code === 'PGRST204' ||
    /column .* does not exist/i.test(msg) ||
    /could not find the .* column/i.test(msg);
}

// Decide what (if anything) to write to the CUSTOMER row when attaching a call.
// Returns { learnedPhone, customerPatch } where customerPatch is either null
// (write nothing to customers) or exactly { phone_secondary: <10 digits> }.
//
// Rules (in order), comparing on last-10 digits:
//   1. caller already matches phone_primary OR phone_secondary → write nothing.
//   2. else phone_secondary is empty → learn it: write the caller's 10 digits
//      into phone_secondary, learnedPhone = true.
//   3. else (phone_secondary occupied by a different number) → write nothing,
//      never overwrite.
// phone_primary is NEVER a write target in any branch.
export function phoneLearningPlan(callerBare, customer, last10) {
  const l10 = last10 || last10Default;
  const noop = { learnedPhone: false, customerPatch: null };
  const key = l10(callerBare);
  if (key.length !== 10 || !customer) return noop;

  const primKey = l10(customer.phone_primary);
  const secKey = l10(customer.phone_secondary);
  if (key === primKey || key === secKey) return noop;             // already known

  const secHasValue = !!(customer.phone_secondary && String(customer.phone_secondary).trim());
  if (!secHasValue) {
    return { learnedPhone: true, customerPatch: { phone_secondary: key } };  // learn into empty slot
  }
  return noop;                                                    // occupied → never overwrite
}

// Perform the phone-learning step of an attach against a LIVE, ATOMIC writer,
// returning whether THIS attach actually learned the number. This is the
// browser entry point — NOT phoneLearningPlan directly — because the empty-vs-
// occupied decision must be the database's, made at write time, not read from a
// (possibly stale) customer snapshot.
//
// `setSecondaryIfNull(customerId, value)` MUST perform an atomic
//   UPDATE customers SET phone_secondary = value
//    WHERE id = customerId AND phone_secondary IS NULL
// and resolve to the NUMBER OF ROWS written (1 = we claimed an empty slot,
// 0 = the slot was already occupied). Because the "IS NULL" guard lives in the
// DB, a stale snapshot that still reads "empty" can never overwrite an occupied
// slot: the write simply matches zero rows. learned_phone is derived from that
// row count — never from the snapshot — so two attaches to the same customer
// can never both claim to have learned the number.
//
// phoneLearningPlan is still used as the INTENT gate (never duplicate the
// primary number, skip an already-known number), but it is not the authority on
// whether a write happened — the atomic result is.
export async function attachPhoneLearn({ callerBare, customer, last10, setSecondaryIfNull }) {
  const l10 = last10 || last10Default;
  const plan = phoneLearningPlan(callerBare, customer, l10);
  if (!plan.customerPatch) return { learnedPhone: false, wrote: null };
  const value = plan.customerPatch.phone_secondary;
  const rows = await setSecondaryIfNull(customer.id, value);
  const learnedPhone = rows === 1;
  return { learnedPhone, wrote: learnedPhone ? value : null };
}

// The `calls` patch written on ATTACH: the confirmed customer + attribution +
// the learned-phone flag (so un-attach knows whether it may clear the number).
export function attachCallPatch(customerId, byName, nowISO, learnedPhone) {
  return {
    customer_id: customerId,
    attached_by_name: byName || null,
    attached_at: nowISO,
    learned_phone: !!learnedPhone,
  };
}

// The `calls` patch written on UN-ATTACH: clears the confirmation + attribution
// and resets learned_phone. (Whether the customer's phone_secondary is also
// cleared is decided separately by unattachClearsSecondary — customers is only
// touched when this attach is what wrote the number.)
export function unattachCallPatch() {
  return { customer_id: null, attached_by_name: null, attached_at: null, learned_phone: false };
}

// Whether un-attaching this call should clear the customer's phone_secondary.
// TRUE only when this attach learned the number (learned_phone). This is the
// guard that makes it impossible to delete a pre-existing phone_secondary by
// undoing a link.
export function unattachClearsSecondary(call) {
  return !!(call && call.learned_phone === true);
}

// The `calls` patch for marking / un-marking "not a customer" (spam, wrong
// number). Reversible; does NOT touch customer_id.
export function notACustomerPatch(byName, nowISO) {
  return { not_a_customer_at: nowISO, not_a_customer_by_name: byName || null };
}
export function clearNotACustomerPatch() {
  return { not_a_customer_at: null, not_a_customer_by_name: null };
}

// Unattached-filter predicate. PERSISTED columns ONLY: a call is unattached
// when no human has confirmed a customer (customer_id null) AND it hasn't been
// marked not-a-customer. A live phone match does NOT count as attached — those
// calls are exactly the ones worth confirming, so they stay in the list.
export function isUnattached(call) {
  return !!call && call.customer_id == null && call.not_a_customer_at == null;
}

// ── CONFIRM BEFORE LEARNING ─────────────────────────────────────────────
// Attaching a call used to perform a SECOND, SILENT write to a different
// table: it saved the caller's number into the customer's empty
// phone_secondary slot with nothing on screen to say so. Because the customer
// record unions phone-matched calls, a wrong attach then retroactively pulled
// every call from that number onto that customer's record — and un-doing the
// call did not undo the phone.
//
// The learning itself is wanted (the shop really does collect second numbers).
// What was wrong was that it was invisible. So: when an attach WOULD learn a
// number, ask first. Everything below is the decision logic for that prompt.
//
// NOTE what this does NOT change: the write itself is still the atomic
// setSecondaryIfNull in attachPhoneLearn, and un-attach still clears a learned
// number via unattachClearsSecondary. This layer only decides whether to ask.

// Would attaching this call to this customer actually learn a number? True only
// when a write would really happen — the caller's number isn't already on the
// customer AND the phone_secondary slot is empty. When this is false there is
// nothing to confirm and the attach proceeds silently, exactly as before.
export function wouldLearnPhone(callerBare, customer, last10) {
  return !!phoneLearningPlan(callerBare, customer, last10).customerPatch;
}

// Other calls from this number that are NOT this customer's. Both kinds count:
// a call attached to a DIFFERENT customer (obvious), and an UNATTACHED call
// (customer_id null) — which is the case that actually bit us. Six unattached
// calls from Hector's number were sitting in the table when one of them was
// attached to Jose; "nobody has claimed these yet" is still evidence the number
// may not be Jose's.
//
// `others` must already EXCLUDE the call being attached — the caller filters by
// id, because that one call is about to belong to this customer by definition.
export function countForeignCalls(others, customerId) {
  const mine = customerId == null ? '' : String(customerId);
  return (others || []).filter((c) => {
    if (!c) return false;
    return c.customer_id == null || String(c.customer_id) !== mine;
  }).length;
}

// Which way the prompt is pre-answered. NO when this number already has other
// calls that aren't this customer's — the signal that it's someone else's
// phone. YES otherwise (a genuinely new number the customer just rang from).
//
// It is only a DEFAULT: the advisor can always answer the other way. Erring
// toward NO is deliberate — declining costs a number nobody typed, accepting
// wrongly rewrites a customer record and drags in a stranger's call history.
export function phoneLearnDefaultYes(others, customerId) {
  return countForeignCalls(others, customerId) === 0;
}

// Memo key for a decline. Scoped to the (customer, number) PAIR: declining
// "this is not Jose's phone" must not suppress the question for a different
// customer, or for Jose on a different number.
export function phoneLearnDeclineKey(customerId, callerBare, last10) {
  const key = (last10 || last10Default)(callerBare);
  if (!customerId || key.length !== 10) return null;
  return String(customerId) + '|' + key;
}

// Has this exact question already been declined? `declined` is any array/Set of
// keys (the board persists them in localStorage — see the cost note in
// docs/wiring/call-window-desk.md §2c: per-browser, not shop-wide, because a
// durable shop-wide decline would need a new table and a hand-run migration).
export function isPhoneLearnDeclined(declined, customerId, callerBare, last10) {
  const k = phoneLearnDeclineKey(customerId, callerBare, last10);
  if (!k || !declined) return false;
  if (typeof declined.has === 'function') return declined.has(k);
  return Array.prototype.indexOf.call(declined, k) !== -1;
}

// Add a decline to the memo, newest last, capped so the list can't grow without
// bound. Returns a NEW array (never mutates the one handed in).
export const PHONE_LEARN_DECLINE_CAP = 200;
export function rememberPhoneLearnDecline(declined, key, cap) {
  const limit = cap || PHONE_LEARN_DECLINE_CAP;
  const list = (declined ? Array.from(declined) : []).filter((k) => k !== key);
  if (!key) return list;
  list.push(key);
  return list.slice(-limit);
}
