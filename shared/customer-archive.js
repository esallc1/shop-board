/* ============================================================
   customer-archive.js — what "archived" means to the app after a merge.

   WHY THIS EXISTS: a merge ARCHIVES the loser, it never deletes it
   (`vehicles`/`customer_phones` cascade, and `repair_orders` RESTRICTs, so a
   delete would either destroy data or fail outright). But archiving is only a
   flag — **if the app still returns the archived row, the merge accomplished
   nothing.** A duplicate that still shows up in the A–Z list, still matches a
   phone lookup, or still gets offered by the attach picker is still a
   duplicate, whatever the database says.

   So every read that SEARCHES or MATCHES customers has to exclude archived
   rows. Reads that fetch ONE customer BY ID must NOT — an archived record
   opened directly still renders, with a pointer to the survivor, because a
   404 on a URL that worked yesterday is worse than a stale page.

   ── The migration-safety problem this module exists to solve ──
   `archived_at` / `merged_into` come from a HAND-RUN migration. On a project
   where it hasn't been run yet, a server-side `.is('archived_at', null)` filter
   is a 42703 and the query FAILS — which would break the customer list and the
   phone lookup on prod. So every call site does:

       filter server-side  ->  on a missing-column error, retry unfiltered
                           ->  then run filterActive() on whatever came back

   `filterActive` is a no-op when the column doesn't exist (no row has
   `archived_at`, so nothing is dropped), which makes the fallback path behave
   exactly as it did before the migration. One shape, both projects.

   No DOM, no db, no globals. Loaded in the browser as an ES module that
   assigns window.CustomerArchive, and imported directly by
   shared/customer-archive.test.js under `node --test`.
   ============================================================ */

// The server-side filter column. Named once so a call site can't typo it.
export const ARCHIVED_COL = 'archived_at';

// The columns a search/match read needs in order to filter and explain.
// Appended to a select list only where the caller can tolerate the fallback.
export const MERGE_COLS = 'archived_at, merged_into';

// Is this customer archived (merged away)? Tolerates a row loaded from a
// project where the column doesn't exist yet — undefined is NOT archived.
export function isArchived(c) {
  return !!(c && c.archived_at != null);
}

// Drop archived rows. Order preserved; input never mutated. On a pre-migration
// project no row has archived_at, so this returns everything — which is exactly
// the behaviour before the merge feature existed.
export function filterActive(rows) {
  return (rows || []).filter((c) => c && !isArchived(c));
}

// Was this row merged into another customer, and which one? Returns the keeper
// id or null. A row can in principle be archived WITHOUT being merged (a future
// "archive this customer" action), so these two are asked separately.
export function mergedIntoId(c) {
  return (c && c.merged_into != null && c.merged_into !== '') ? String(c.merged_into) : null;
}

// Should the record page show the "this was merged" banner? Only when we can
// actually point somewhere — an archived row with no keeper gets no pointer.
export function shouldShowMergedBanner(c) {
  return isArchived(c) && !!mergedIntoId(c);
}

// The banner wording. Kept here so the record page and any future surface say
// the same thing. `keeperName` may be null if the keeper couldn't be loaded.
export function mergedBannerText(keeperName) {
  const who = (keeperName && String(keeperName).trim()) ? String(keeperName).trim() : 'another customer';
  return 'This record was merged into ' + who + '. Its vehicles, repair orders and calls now live there.';
}
