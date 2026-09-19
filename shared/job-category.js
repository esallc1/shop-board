/* ============================================================
   job-category.js — THE job-category list for an RO. One file, one list.

   repair_orders.job_category (migrations/20260919_ro_job_category_*.sql) holds
   one of these values, or NULL = "not decided yet". The database CHECK allows
   exactly these strings; shared/job-category.test.js reads both migration files
   and fails if their CHECK and this list ever disagree.

   Lives on the RO ONLY. It is never copied to the floor rows (shopboard_*). The
   one other place it lands is the close archive: archiveToCompletedJobs copies
   the RO's final value into completed_jobs.job_category (archiveJobCategory).

   Not required anywhere — blank never blocks a save, a stage change or a close.
   The RO detail just shows "Pick a category" in red until one is chosen.

   No DOM. Loaded in the browser as an ES module that assigns window.JobCategory
   and imported directly by shared/job-category.test.js.
   See docs/wiring/ro-checkin-tech.md §7.
   ============================================================ */

// The stored value IS the label Kevin sees. Order = dropdown order.
export const JOB_CATEGORIES = Object.freeze(['Transmission rebuild', 'General repair']);

// What the dropdown says while the RO has no category (value '' → saved as NULL).
export const UNSET_LABEL = 'Pick a category';

// A stored/selected value → the canonical value, or null for blank/unknown.
// Exact match only (after trimming): 'transmission rebuild' is NOT accepted, so
// nothing can slip past the database CHECK by case.
export function normalizeJobCategory(value) {
  if (value == null) return null;
  const v = String(value).trim();
  return JOB_CATEGORIES.includes(v) ? v : null;
}

// True while the RO has no category yet → the dropdown gets its red outline.
export function isJobCategoryUnset(value) {
  return value == null || String(value).trim() === '';
}

// <option> data for the RO detail dropdown: the "Pick a category" blank first,
// then the list, with the current value selected. A stored value that is NOT in
// the list (impossible once the CHECK is on; kept so the screen never lies) is
// appended and selected, the same rule shared/status-mirror.js uses.
export function buildJobCategoryOptions(current) {
  const cur = current == null ? '' : String(current).trim();
  const opts = [{ value: '', label: UNSET_LABEL, selected: cur === '' }]
    .concat(JOB_CATEGORIES.map((c) => ({ value: c, label: c, selected: c === cur })));
  if (cur && !JOB_CATEGORIES.includes(cur)) opts.push({ value: cur, label: cur, selected: true });
  return opts;
}

// The dropdown's value → what is written to repair_orders.job_category.
// '' (Pick a category) → NULL. Anything not on the list → NULL too, never a
// value the CHECK would reject.
export function jobCategoryForSave(selectValue) {
  return normalizeJobCategory(selectValue);
}

// At close: the value archiveToCompletedJobs puts in completed_jobs.job_category.
// Read from the RO row (never the floor row — the Off-lot path has already
// removed the car from the floor by the time the archive is written).
// Blank → NULL.
export function archiveJobCategory(ro) {
  return normalizeJobCategory(ro && ro.job_category);
}
