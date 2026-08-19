/* ============================================================
   phone-lookup.js — finding a customer by phone number, SERVER-SIDE.

   WHY THIS EXISTS — the bug it fixes:
   The intake wizard's `lookupPhone` did an UNBOUNDED
   `db.from('customers').select(...)` and filtered the rows in JavaScript.
   PostgREST caps an unbounded select at 1,000 rows; the table has 2,717. So
   roughly 63% of existing customers could not be found by phone, and the
   advisor was walked straight into "create a new customer" — a duplicate
   generator running on every intake. `JOSE RAMIREZ` (813-590-9459), a real
   customer with an open RO, did not resolve.

   THE SHAPE OF THE FIX: narrow on the SERVER, confirm in the client.
   Pulling every customer into the browser to search them is the wrong shape and
   only gets worse as the shop grows, so the query filters server-side. But
   phone numbers are stored AS TYPED — three shapes live in the table today:

     "8135909459"        2750 rows
     "(786) 531-5419"      32 rows
     "786-531-5419"         1 row

   — so no equality filter can find them all. `ilikePatternFor` builds an
   end-anchored wildcard pattern from the last 10 digits (`*813*590*9459`) that
   matches every one of those shapes: the area code, exchange and line number
   are contiguous runs in any standard format, whatever sits between them.
   Verified against all 2,783 stored values: zero misses.

   DOES NOT USE `phone_primary_l10` / `phone_secondary_l10`, and does not need
   to. Those generated columns now exist on BOTH projects
   (`migrations/20260818_customers_phone_l10.sql` ran on the sandbox 2026-08-18
   and on prod 2026-08-19) — the original reason for avoiding them, that prod
   lacked the columns and a filter on them would silently return NOTHING, is
   gone. The ilike pattern is kept because it needs no migration to be correct
   and `matchesLast10` is the authority either way; switching to the indexed
   columns would be a performance change, not a correctness one. The auto-attach
   webhook does use them (`api/ctm-webhook.js`), because PostgREST cannot filter
   on a function expression and that path has no client-side re-check.

   ⚠️ ARCHIVED CUSTOMERS ARE NOT THIS MODULE'S JOB — AND IT IS NOT OPTIONAL.
   Nothing here filters merged-away rows: `phoneOrFilter` builds only the phone
   predicate, and `matchesLast10` / `confirmPhoneMatches` decide on digits alone.
   Since prod has archived customers (customer-merge slice 1, 2026-08-19),
   a caller that skips the archive filter will offer the advisor a dead row and
   quietly undo a merge. Every call site MUST pair this module with
   `shared/customer-archive.js`: filter `archived_at` server-side, fall back to
   an unfiltered read on a missing-column error, then run `filterActive()` on
   the result. `advisor-board.html` (the intake wizard's `lookupPhone`) is the
   worked example.

   The pattern is a NARROWING device, not the decision. `matchesLast10` is the
   authority: every row the server returns is re-checked on exact last-10
   digits, so an over-broad pattern can never produce a wrong match.

   No DOM, no db, no globals. Loaded in the browser as an ES module that assigns
   window.PhoneLookup, and imported directly by shared/phone-lookup.test.js
   under `node --test`.
   ============================================================ */

// Last-10-digits normalizer — the same rule as window.cdLast10.
export function last10(s) {
  return String(s == null ? '' : s).replace(/\D/g, '').slice(-10);
}

// The PostgREST ilike pattern for a phone key. `*` is PostgREST's wildcard (as
// used inside an `or=(...)` filter), NOT SQL's `%`.
//
// A full 10-digit key splits 3-3-4 — "8135909459" -> "*813*590*9459" — because
// every standard format keeps those three runs contiguous and only varies the
// punctuation between them. There is NO trailing wildcard: the pattern is
// anchored at the END, which is what "last 10 digits" means, so a longer number
// that merely CONTAINS the key elsewhere is not dragged in.
//
// A shorter key (the form gate allows 7+) can't split that way, so it is used
// whole and end-anchored. Such a lookup still finds nothing once matchesLast10
// runs — a 7-digit key can never equal a 10-digit last-10 — which is exactly the
// behaviour before this fix.
//
// Returns null when there is nothing usable to search for.
export function ilikePatternFor(key) {
  const k = String(key == null ? '' : key).replace(/\D/g, '');
  if (!k) return null;
  if (k.length !== 10) return '*' + k;
  return '*' + k.slice(0, 3) + '*' + k.slice(3, 6) + '*' + k.slice(6);
}

// The `or=` filter string for the two phone columns. Kept here so the column
// names and the pattern can never drift apart.
export function phoneOrFilter(key, columns) {
  const pat = ilikePatternFor(key);
  if (!pat) return null;
  const cols = (columns && columns.length) ? columns : ['phone_primary', 'phone_secondary'];
  return cols.map((c) => c + '.ilike.' + pat).join(',');
}

// THE AUTHORITY. The server pattern only narrows; this decides. A row matches
// when either phone column's last 10 digits equal the key exactly.
export function matchesLast10(customer, key) {
  const k = last10(key);
  if (k.length !== 10 || !customer) return false;
  return last10(customer.phone_primary) === k || last10(customer.phone_secondary) === k;
}

// Narrowed rows -> the customers to actually offer. Re-checks every row and
// de-dupes by id (the two ilike branches of the `or` can return the same row).
export function confirmPhoneMatches(rows, key) {
  const seen = new Set();
  const out = [];
  for (const c of rows || []) {
    if (!c || c.id == null) continue;
    const id = String(c.id);
    if (seen.has(id)) continue;
    if (!matchesLast10(c, key)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}
