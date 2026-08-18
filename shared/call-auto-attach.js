/* ============================================================
   call-auto-attach.js — pure decision logic for the ROBOT half of call
   filing: match an inbound call to a customer by phone, and (only when it
   is unambiguous) file it to the RO that was open when the call came in.

   This is the SINGLE, TESTED source of truth for the auto-attach rules, and
   it is deliberately the SAME predicate the hand-run backfill SQL uses
   (migrations/ + docs/wiring/call-auto-attach.md §3). Live and backfill must
   never drift: if you change a rule here, change the SQL in the same commit.

   The invariants it inherits from shared/call-attach.js — no exceptions:
     • phone_primary is NEVER written — no code path here names it at all;
     • NO phone learning whatsoever — the robot never writes
       customers.phone_secondary and never sets learned_phone. A machine guess
       must not mutate a customer record;
     • attached_by_name / attached_at are NEVER written — those two columns
       mean "a human did this", and they are what makes the robot's work
       reversible without touching the crew's;
     • a row that already has customer_id or not_a_customer_at set is never
       touched (shouldAutoAttach is the gate).

   NEVER GUESS. pickCustomer and pickOpenRoAt both return null on 0 matches
   AND on 2+ — an ambiguous call stays in the pile where a human can see it.

   No DOM, no globals, no db. Loaded in the browser as an ES module that
   assigns window.CallAutoAttach (see advisor-board.html), imported directly
   by api/ctm-webhook.js, and by shared/call-auto-attach.test.js under
   `node --test`.
   ============================================================ */

// ── The run-id namespace ────────────────────────────────────────────────
// Every row the robot writes carries auto_attach_run_id. One id = one
// reversible batch. The two hand-run backfills used their own ids; LIVE is a
// fixed sentinel so day-to-day auto-attaches are reversible as a CLASS but
// are never swept up by a backfill undo (and vice versa).
export const AUTO_ATTACH_LIVE_RUN_ID = '00000000-0000-4000-8000-000000000000';

// Last-10-digits normalizer — the JS twin of the SQL
//   right(regexp_replace(coalesce(x,''), '\D', '', 'g'), 10)
// The browser passes window.cdLast10 (the ONE shared implementation) where it
// can; this exists so the module is self-contained under test and in the
// serverless function. Never mutates input.
export function last10Key(s) {
  return String(s == null ? '' : s).replace(/\D/g, '').slice(-10);
}

// Numbers that must never match anybody: anything that isn't a full 10 digits,
// the 1234567890 placeholder, and repeated-digit junk (0000000000, 1111111111…).
// SQL twin: length(k) = 10 and k <> '1234567890' and k !~ '^(.)\1{9}$'.
export function isJunkNumber(k) {
  const key = String(k == null ? '' : k);
  if (key.length !== 10) return true;
  if (!/^\d{10}$/.test(key)) return true;
  if (key === '1234567890') return true;
  return /^(.)\1{9}$/.test(key);              // all ten digits identical
}

// Whether this call row is eligible for the robot at all. PERSISTED columns
// only: an already-attached call and a human's "not a customer" are both
// off-limits, forever.
export function shouldAutoAttach(call) {
  if (!call) return false;
  if (call.customer_id != null) return false;
  if (call.not_a_customer_at != null) return false;
  return !isJunkNumber(last10Key(call.caller_bare));
}

// Timestamp → epoch ms, or NaN. ISO strings from PostgREST carry an offset
// ("+00:00") that plain string comparison gets wrong, so every time
// comparison in this module goes through Date.parse — never `<` on strings.
function ts(v) {
  if (v == null || v === '') return NaN;
  return Date.parse(String(v));
}

// Was this RO open AT THE MOMENT `at`? The JS twin of the backfill's join:
//     r.created_at <= at
//     and (r.closed_at   is null or r.closed_at   > at)
//     and (r.declined_at is null or r.declined_at > at)
//     and not (r.closed_at is null and r.status = 'closed')
// An unparseable/absent created_at means we cannot prove it was open yet, so
// it is NOT open — the SQL join drops that row for the same reason (a NULL
// comparison is not true). The last clause covers a row closed before
// closed_at existed: status says closed but there is no timestamp to date it,
// so it is never treated as open.
export function isOpenRoAt(ro, at) {
  if (!ro) return false;
  const t = ts(at);
  if (!Number.isFinite(t)) return false;

  const created = ts(ro.created_at);
  if (!Number.isFinite(created) || created > t) return false;   // not opened yet

  const closed = ts(ro.closed_at);
  if (Number.isFinite(closed) && closed <= t) return false;     // closed by then

  const declined = ts(ro.declined_at);
  if (Number.isFinite(declined) && declined <= t) return false; // declined by then

  if (!Number.isFinite(closed) && ro.status === 'closed') return false; // closed, undated
  return true;
}

// RULE 1 — exactly one customer, or nothing. `matches` is whatever the phone
// lookup returned (customer rows, or bare ids). Deduped by id first, because
// a customer whose primary AND secondary both hold the number must still
// count once — the SQL says count(DISTINCT customer_id) = 1.
// Returns the id, or null on 0 matches and on 2+.
export function pickCustomer(matches) {
  const ids = new Set();
  for (const m of matches || []) {
    if (m == null) continue;
    const id = (typeof m === 'object') ? m.id : m;
    if (id != null && id !== '') ids.add(String(id));
  }
  if (ids.size !== 1) return null;              // 0 → stranger, 2+ → ambiguous
  return [...ids][0];
}

// RULE 2 — exactly one RO open at the time of the call, or nothing.
// Returns the RO id, or null on 0 open and on 2+ open. Never guesses which of
// two open ROs the customer meant.
export function pickOpenRoAt(ros, at) {
  const open = (ros || []).filter((r) => isOpenRoAt(r, at));
  if (open.length !== 1) return null;           // 0 → nothing to file to, 2+ → ambiguous
  const id = open[0].id;
  return (id == null || id === '') ? null : id;
}

// ── The patches ─────────────────────────────────────────────────────────
// Deliberately narrow. Note what is ABSENT from all of them: phone_primary,
// phone_secondary, learned_phone, attached_by_name, attached_at. Those belong
// to the human path (shared/call-attach.js) and the robot never writes them.

// The `calls` patch when the ROBOT attaches a customer. auto_attached_at is
// the mark that says "a machine did this, not the crew".
export function autoAttachCallPatch(customerId, nowISO, runId) {
  return {
    customer_id: customerId,
    auto_attached_at: nowISO,
    auto_attach_run_id: runId || AUTO_ATTACH_LIVE_RUN_ID,
  };
}

// The `calls` patch when the robot files an RO. Used on its own after a HUMAN
// attach (there is no auto_attached_at in it — a human attached that customer,
// and the row must keep saying so), and merged into the patch above when the
// robot does both at once.
export function autoFileRoPatch(roId, nowISO, runId) {
  return {
    ro_id: roId,
    auto_ro_filed_at: nowISO,
    auto_attach_run_id: runId || AUTO_ATTACH_LIVE_RUN_ID,
  };
}

// Everything the robot ever stamped, cleared. Folded into a human's UN-ATTACH:
// the call is no longer this person, so nothing the machine derived from that
// link survives.
export function clearAutoTagsPatch() {
  return { auto_attached_at: null, auto_ro_filed_at: null, auto_attach_run_id: null };
}

// What a MANUAL RE-FILE clears. A person has chosen the RO, so the row leaves
// the robot's namespace entirely — dropping auto_attach_run_id detaches it from
// every batch undo, which is the point: no reverse statement can revoke a human
// decision. `auto_attached_at` deliberately SURVIVES: it is a factual record
// that the machine picked the customer, and with the run id gone it is no
// longer an undo key, just history (and what the "auto" chip reads).
//
// The trade this makes, on purpose: once a human re-files, that row's ORIGINAL
// machine attach is no longer reversible as part of a batch either. Un-attach
// still clears it by hand. Safety beats completeness here.
export function clearAutoFileTagsPatch() {
  return { auto_ro_filed_at: null, auto_attach_run_id: null };
}

// True when the robot — not a person — put this customer on the call. Drives
// the "auto" chip in the UI.
export function isAutoAttached(call) {
  return !!(call && call.auto_attached_at != null);
}
