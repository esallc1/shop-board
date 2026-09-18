/* ============================================================
   customer-edit.js — the customer record's Edit form: what it writes, and
   the duplicate-phone check it runs before writing.

   WHY THE PHONE CHECK EXISTS: a phone number is how this shop finds a person
   (the wizard's lookupPhone, the Desk's call matching, auto-attach). Typing
   someone ELSE's number onto a customer quietly makes two people answer to
   one phone, and every later lookup has to ask "which one?". Sometimes that is
   right — families share phones — so this module only FINDS the other
   customers; the page warns, names them, and lets the advisor "Save anyway".
   It never merges and never blocks.

   WHAT COUNTS AS A CONFLICT:
     • only a NEW or CHANGED number — one this customer did not already carry
       in either phone field (`newPhoneKeys`). Re-saving a record whose number
       was already shared must not nag every time; neither must swapping
       primary and secondary.
     • matched on the LAST 10 DIGITS (`last10` / `matchesLast10` from
       shared/phone-lookup.js — the same rule as the wizard and the Desk), in
       EITHER phone field of the other customer.
     • never the customer being edited (self is excluded by id).
     • never an ARCHIVED (merged-away) customer — `filterActive` from
       shared/customer-archive.js. Warning about a row a merge already retired
       would send the advisor to a dead record.

   The server query only NARROWS (`conflictOrFilter` reuses phoneOrFilter's
   end-anchored ilike pattern); `findPhoneConflicts` is the authority and
   re-checks every row, so an over-broad pattern cannot produce a false warning.

   No DOM, no db, no globals. Loaded in the browser as an ES module that
   assigns window.CustomerEdit, and imported directly by
   shared/customer-edit.test.js under `node --test`.
   ============================================================ */
import { last10, phoneOrFilter, matchesLast10 } from './phone-lookup.js';
import { filterActive } from './customer-archive.js';

// The columns the Edit form owns — and the ONLY columns it ever writes.
// Deliberately absent: tax_exempt, delivery_preference, country (not this
// form's job), and the generated phone_*_l10 columns (Postgres owns those).
export const EDIT_FIELDS = [
  'name', 'business_name',
  'phone_primary', 'phone_secondary',
  'email',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code',
];

export const PHONE_FIELDS = ['phone_primary', 'phone_secondary'];

// Form values -> the UPDATE patch. Every field is trimmed; a blank becomes
// NULL (not ''), so a cleared field reads as "not on file" everywhere the
// record skips blank rows. Only `name` is required (the column is NOT NULL);
// a blank primary phone is allowed — 18 ALLDATA imports have none and must
// still be editable.
export function buildCustomerPatch(raw) {
  const patch = {};
  for (const f of EDIT_FIELDS) {
    const v = String(raw == null || raw[f] == null ? '' : raw[f]).trim();
    patch[f] = v === '' ? null : v;
  }
  if (!patch.name) return { patch: null, error: 'Name is required.' };
  return { patch, error: null };
}

// The 10-digit keys in `patch` that `before` did not already carry in EITHER
// phone field. Short/junk numbers (fewer than 10 digits) are never keys — they
// can't be matched on last-10 by anyone, so there is nothing to warn about.
export function newPhoneKeys(before, patch) {
  const had = new Set(
    PHONE_FIELDS.map((f) => last10(before && before[f])).filter((k) => k.length === 10));
  const out = [];
  for (const f of PHONE_FIELDS) {
    const k = last10(patch && patch[f]);
    if (k.length === 10 && !had.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

// The PostgREST `or=` filter that narrows the server read to rows carrying any
// of `keys` in either phone column. null when there is nothing to look for.
export function conflictOrFilter(keys) {
  const parts = (keys || []).map((k) => phoneOrFilter(k)).filter(Boolean);
  return parts.length ? parts.join(',') : null;
}

// THE AUTHORITY. Narrowed rows -> the OTHER, LIVE customers that carry one of
// `keys`, each with the keys it matched. De-duped by id, input order kept.
export function findPhoneConflicts(rows, opts) {
  const selfId = opts && opts.selfId != null ? String(opts.selfId) : null;
  const keys = ((opts && opts.keys) || []).map(last10).filter((k) => k.length === 10);
  if (!keys.length) return [];
  const seen = new Set();
  const out = [];
  for (const c of filterActive(rows)) {
    if (!c || c.id == null) continue;
    const id = String(c.id);
    if (id === selfId || seen.has(id)) continue;
    const matched = keys.filter((k) => matchesLast10(c, k));
    if (!matched.length) continue;
    seen.add(id);
    out.push({ customer: c, keys: matched });
  }
  return out;
}
