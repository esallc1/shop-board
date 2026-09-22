/* ============================================================
   shared/desk-names.js — WHO a Desk row is, for every Desk lane (Coming in,
   Callbacks, Recently cleared) and the calendar chips.

   WHY. Until 2026-09-22 the lanes named a row ONLY through calls.customer_id,
   and Recently cleared never even looked its customers up — so on prod all 12
   linked cleared rows, every "+Add" walk-in with a typed name, and every
   unlinked caller showed a bare phone number. Cris couldn't find Omar Madrid.

   THE ORDER (Cris, final — call-window-desk.md §6d):
     1. calls.customer_id → that customer            CONFIRMED
     2. a "+Add" row's typed name (cnam)              CONFIRMED
     3. the phone matches EXACTLY ONE customer        GUESS
     4. the phone matches 2+ customers → "N customers on this number"  GUESS
     5. the formatted phone                           (today's fallback)
   CTM's caller-ID cnam is IGNORED on purpose: 14 of 46 on prod are a city
   ("FORT MYERS   FL"), not a person. An archived / merged-away customer is
   never a guess and never counted in N. A call a human marked "not a
   customer" is never guessed. A linked call whose customer didn't load shows
   the phone — never a phone guess that could name someone else.

   A GUESS is only ever DRAWN. Confirming it is the July 29 attach write
   (performAttach / CallAttach.attachCallPatch) — this module writes nothing.

   Pure → shared/desk-names.test.js.
   ============================================================ */

import { isArchived } from './customer-archive.js';
import { isManualCall } from './call-appointment.js';

export const GUESS_TOOLTIP = 'Matched by phone — not confirmed';

const defaultLast10 = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-10);

// Same wording the board has always used for a customer.
export function custDisplayName(c) {
  return (c && (c.business_name || c.name)) || '(no name)';
}

// last-10 phone → active customers on it (primary OR secondary), each once.
export function buildPhoneIndex(customers, last10) {
  const l10 = last10 || defaultLast10;
  const idx = {};
  for (const c of customers || []) {
    if (!c || c.id == null || isArchived(c)) continue;
    for (const p of [c.phone_primary, c.phone_secondary]) {
      const k = l10(p);
      if (k.length !== 10) continue;
      const list = idx[k] || (idx[k] = []);
      if (!list.some((x) => String(x.id) === String(c.id))) list.push(c);
    }
  }
  return idx;
}

// The customer ids a Desk load must look up by id: open rows AND cleared rows.
// (Leaving the cleared ones out is the bug that blanked Recently cleared.)
export function customerIdsToLoad(...lists) {
  const ids = new Set();
  for (const list of lists) for (const c of list || []) if (c && c.customer_id) ids.add(String(c.customer_id));
  return [...ids];
}

/* → { kind, label, confirmed, customer, candidates }
     kind: 'linked' | 'typed' | 'guess' | 'multi' | 'phone'
   opts: { byId: {id: customer}, byPhone: buildPhoneIndex(...) | null,
           phoneLabel: (call) => string, last10 } */
export function deskName(call, opts) {
  const c = call || {};
  const o = opts || {};
  const byId = o.byId || {};
  const phone = () => (typeof o.phoneLabel === 'function' ? o.phoneLabel(c) : (c.caller_formatted || c.caller_bare || '(unknown number)'));
  const none = { customer: null, candidates: [] };

  // 1. a human linked this call
  if (c.customer_id) {
    const cust = byId[c.customer_id] || byId[String(c.customer_id)];
    if (cust) return { ...none, kind: 'linked', label: custDisplayName(cust), confirmed: true, customer: cust };
    return { ...none, kind: 'phone', label: phone(), confirmed: false };   // linked, not loaded: never guess over it
  }
  // 2. staff typed the name in "+Add"
  const typed = String(c.cnam == null ? '' : c.cnam).trim();
  if (typed && isManualCall(c)) return { ...none, kind: 'typed', label: typed, confirmed: true };

  // 3/4. phone match — a guess, unless a human already said "not a customer"
  if (o.byPhone && !c.not_a_customer_at) {
    const key = (o.last10 || defaultLast10)(c.caller_bare);
    const hits = (key.length === 10 && o.byPhone[key]) ? o.byPhone[key].filter((x) => !isArchived(x)) : [];
    if (hits.length === 1) {
      return { kind: 'guess', label: custDisplayName(hits[0]), confirmed: false, customer: hits[0], candidates: hits };
    }
    if (hits.length > 1) {
      return { kind: 'multi', label: `${hits.length} customers on this number`, confirmed: false, customer: null, candidates: hits };
    }
  }
  // 5. the number
  return { ...none, kind: 'phone', label: phone(), confirmed: false };
}

// A guess is anything the confirm box can act on.
export function isGuess(r) { return !!r && (r.kind === 'guess' || r.kind === 'multi'); }

// Plain-text form for confirms / tooltips / chips: a guess carries a "?".
export function textLabel(r) { return r ? (isGuess(r) ? `${r.label} ?` : r.label) : ''; }
