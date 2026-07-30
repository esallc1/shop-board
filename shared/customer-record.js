/* ============================================================
   customer-record.js — PURE logic for the customer record view.

   The board fetches (customer row, vehicles by customer_id, repair_orders by
   customer_id, line items, and calls by two sources); this module does the
   reasoning that has to be right and testable: the confirmed/unconfirmed
   recording classification, the vehicle filter, the CrisData-only counts, the
   "open RO now" set, the learned-secondary detection, and RO invoice totals.

   Deliberate rules encoded here (do not "fix"):
   - Recordings are OLDEST FIRST — the value is the first time he called.
   - Two sources unioned: calls.customer_id == this customer (CONFIRMED) and
     caller_bare last-10 == phone_primary/secondary (UNCONFIRMED). A call a human
     attached to a DIFFERENT customer is NOT ours — excluded. not_a_customer_at
     set → excluded.
   - completed_jobs is NOT used for counts (no customer_id); repair_orders only.
   - customers.created_at is NOT "customer since" (bulk ALLDATA import); we use
     min(repair_orders.created_at) and the UI labels it CrisData-only.

   No DOM, no db. Loaded in the browser as an ES module that assigns
   window.CustomerRecord, and imported directly by shared/customer-record.test.js.
   ============================================================ */

export const ALL_VEHICLES = 'all';

// last-10 normalizer fallback (the board passes window.cdLast10, but the module
// stays self-contained for tests).
function l10(s, last10) {
  if (last10) return last10(s);
  return String(s == null ? '' : s).replace(/\D/g, '').slice(-10);
}

// Union the two call sources into the recordings list for this customer.
//   customerIdCalls — calls where calls.customer_id === this customer (CONFIRMED)
//   phoneMatchCalls — calls whose caller_bare last-10 matched a phone (candidate
//                     UNCONFIRMED; may include calls a human attached elsewhere)
// Rules: dedupe by id; drop not_a_customer_at; drop calls attached to a DIFFERENT
// customer; confirmed = attached to THIS customer, else unconfirmed. Oldest first.
export function buildRecordingCalls(customerIdCalls, phoneMatchCalls, opts) {
  const customerId = String((opts && opts.customerId) != null ? opts.customerId : '');
  const byId = new Map();
  const addAll = (arr) => { for (const c of (arr || [])) { if (c && c.id != null && !byId.has(String(c.id))) byId.set(String(c.id), c); } };
  addAll(customerIdCalls);
  addAll(phoneMatchCalls);
  const out = [];
  for (const c of byId.values()) {
    if (c.not_a_customer_at) continue;                       // a human said "not a customer"
    const cid = c.customer_id == null ? null : String(c.customer_id);
    if (cid && cid !== customerId) continue;                 // attached to someone else → not ours
    out.push({ ...c, confirmed: cid === customerId && cid !== null });
  }
  out.sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));  // OLDEST first
  return out;
}

// Is the customer's phone_secondary a LEARNED number (added by an attach), vs an
// original? Derived from the calls we already have: a learned_phone call whose
// caller matches the secondary. Pure.
export function isSecondaryLearned(opts) {
  const o = opts || {};
  const key = l10(o.phoneSecondary, o.last10);
  if (!key || key.length < 10) return false;
  return (o.calls || []).some((c) => c && c.learned_phone && l10(c.caller_bare, o.last10) === key);
}

// Vehicle filter for HISTORY (ROs, which always have a vehicle_id). 'all'/null →
// everything. A null vehicle id never matches a specific chip.
export function filterByVehicle(items, vehicleId, getVehId) {
  if (!vehicleId || vehicleId === ALL_VEHICLES) return (items || []).slice();
  const key = String(vehicleId);
  return (items || []).filter((it) => {
    const v = getVehId(it);
    return v != null && String(v) === key;
  });
}

// Vehicle filter for RECORDINGS — differs on purpose: an UNKNOWN-vehicle
// recording (getVehId null → nobody has assigned it) shows under EVERY chip, not
// only "All". The original-complaint call comes in before the RO exists, so it
// has no vehicle; filtering it out of a truck's view would hide exactly the
// recording this section was built to surface. A recording assigned to a
// DIFFERENT vehicle still filters out normally.
export function filterRecordingsByVehicle(items, vehicleId, getVehId) {
  if (!vehicleId || vehicleId === ALL_VEHICLES) return (items || []).slice();
  const key = String(vehicleId);
  return (items || []).filter((it) => {
    const v = getVehId(it);
    if (v == null) return true;               // unassigned → shows everywhere
    return String(v) === key;
  });
}

// Can this recording row be assigned to a vehicle? Only CONFIRMED rows (a human
// has linked the call to this customer). Assigning a vehicle to an unconfirmed
// call would implicitly assert a person link no human made — the person link
// comes before the vehicle link. The server enforces this too.
export function canAssignRecording(row) {
  return !!(row && row.confirmed);
}

// CrisData-only counts. visits = number of ROs; sinceIso = earliest RO created_at
// (NOT customers.created_at). Never derived from completed_jobs.
export function customerCounts(ros) {
  const list = ros || [];
  let since = null;
  for (const r of list) {
    const c = r && r.created_at ? String(r.created_at) : '';
    if (c && (since === null || c < since)) since = c;
  }
  return { visits: list.length, sinceIso: since };
}

// The customer's currently-OPEN ROs (not closed, not a declined estimate),
// newest first. Empty array when nothing is open.
export function openRosOf(ros) {
  return (ros || [])
    .filter((r) => r && r.status !== 'closed' && !r.declined_at)
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

// History order — newest first (latest job on top).
export function sortNewestFirst(ros) {
  return (ros || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

// Invoice total for one RO from its line items (Σ qty·price + tax on taxable
// lines unless the customer is exempt). Mirrors printRo / the close archive.
export function roInvoiceTotal(lines, opts) {
  const rate = (opts && Number(opts.rate)) || 0;
  const exempt = !!(opts && opts.exempt);
  let sub = 0, taxable = 0;
  for (const l of (lines || [])) {
    const amt = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
    sub += amt;
    if (l.taxable) taxable += amt;
  }
  return sub + (exempt ? 0 : taxable * rate);
}

// Group line items by repair_order_id → totals map { roId: total }. Pure helper
// so the board can batch-fetch lines with one .in() query and total them here.
export function totalsByRo(lines, opts) {
  const byRo = {};
  for (const l of (lines || [])) {
    const k = String(l.repair_order_id);
    (byRo[k] = byRo[k] || []).push(l);
  }
  const out = {};
  for (const k of Object.keys(byRo)) out[k] = roInvoiceTotal(byRo[k], opts);
  return out;
}
