/* ============================================================
   comeback-chain.js — PURE logic for the comeback chain: instance ordinal,
   chain ordering, and the close-gate validation.

   BACKGROUND (do not re-derive): repair_orders.parent_ro_id points at the
   IMMEDIATE parent RO, not the root. A comeback-of-a-comeback therefore links
   to the previous comeback. To label it "Comeback 2" we must walk parent links
   all the way to the ROOT (the original, parent_ro_id null) and count.

   The FK is `on delete set null`, so deleting an ancestor ORPHANS the chain —
   a row whose parent_ro_id points at an id that no longer exists. We render what
   is known and NEVER guess an ordinal for a broken chain: an orphan reads
   "Comeback (linked RO deleted)", not "Comeback 1". A bad parent link that loops
   must not spin forever — the walk guards against cycles and caps its depth.

   Pre-wizard / legacy ROs have parent_ro_id null: they are simply not comebacks.
   NULL means "nobody has said," never "no."

   No DOM, no db. The caller gathers the ROs into an id→row map (walking up to the
   root and down through children) and hands that map in; this module only reasons
   over it. Loaded in the browser as an ES module that assigns window.ComebackChain,
   and imported directly by shared/comeback-chain.test.js.
   ============================================================ */

// Hard cap on the parent walk — a backstop against a pathological/looping chain.
export const MAX_CHAIN_DEPTH = 50;

// Machine keys for the two fields that gate a comeback close (PART 4). The UI
// maps these to human labels at the point of blocking.
export const CLOSE_FIELDS = ['complaint', 'resolution'];

// Is this RO a comeback? Purely: does it link to a parent? (NULL = not a
// comeback, never "no repair".)
export function isComeback(ro) {
  return !!(ro && ro.parent_ro_id != null);
}

// Walk parent links from `currentId` up toward the root over an in-memory map
// { String(id) -> ro }. Pure + DB-free. Returns:
//   isComeback  — current has a non-null parent_ro_id
//   ordinal     — 1-based comeback number (count of ancestors up to & incl. root);
//                 0 for a non-comeback root; null when unknown (broken chain)
//   root        — the root ro object (parent_ro_id null), or null if unresolved
//   rootNumber  — root.ro_number, or null
//   broken      — the chain could not be fully resolved (orphan or cycle)
//   reason      — 'ok' | 'not-comeback' | 'orphan' | 'cycle' | 'unknown'
//   ancestors   — [immediate parent … root] as far as resolved (objects)
export function analyzeChain(roMap, currentId, opts) {
  const cap = (opts && opts.maxDepth) || MAX_CHAIN_DEPTH;
  const map = roMap || {};
  const cur = map[String(currentId)] || null;
  if (!cur) {
    // We don't even have the current row — cannot say anything honest.
    return { isComeback: false, ordinal: null, root: null, rootNumber: null, broken: true, reason: 'unknown', ancestors: [] };
  }
  if (cur.parent_ro_id == null) {
    return { isComeback: false, ordinal: 0, root: cur, rootNumber: cur.ro_number ?? null, broken: false, reason: 'not-comeback', ancestors: [] };
  }
  const ancestors = [];
  const seen = new Set([String(currentId)]);
  let node = cur;
  let steps = 0;
  while (node && node.parent_ro_id != null) {
    if (steps++ >= cap) {
      return { isComeback: true, ordinal: null, root: null, rootNumber: null, broken: true, reason: 'cycle', ancestors };
    }
    const pid = String(node.parent_ro_id);
    if (seen.has(pid)) {   // a parent link we've already visited → cycle
      return { isComeback: true, ordinal: null, root: null, rootNumber: null, broken: true, reason: 'cycle', ancestors };
    }
    seen.add(pid);
    const parent = map[pid];
    if (!parent) {         // link exists but the row is gone → orphan (deleted ancestor)
      return { isComeback: true, ordinal: null, root: null, rootNumber: null, broken: true, reason: 'orphan', ancestors };
    }
    ancestors.push(parent);
    node = parent;
  }
  // node now has parent_ro_id null → the root/original.
  return {
    isComeback: true,
    ordinal: ancestors.length,           // ancestors up to & incl. root = comeback instance number
    root: node,
    rootNumber: node.ro_number ?? null,
    broken: false,
    reason: 'ok',
    ancestors,
  };
}

// The RO-detail badge string. Context, not an identifier — the RO's own number
// is shown elsewhere. Empty string when the RO is not a comeback (no badge).
export function badgeLabel(analysis) {
  if (!analysis || !analysis.isComeback) return '';
  if (analysis.broken) {
    return analysis.reason === 'cycle'
      ? 'Comeback (chain error)'
      : 'Comeback (linked RO deleted)';
  }
  return `Comeback ${analysis.ordinal} of RO ${analysis.rootNumber}`;
}

// Order every RO in the map oldest → newest for the chain card (created_at asc,
// ro_number asc as a stable tiebreak). Pure — the caller gathers the map.
export function orderChain(roMap) {
  return Object.values(roMap || {}).slice().sort((a, b) => {
    const ta = String((a && a.created_at) || ''), tb = String((b && b.created_at) || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return ((a && a.ro_number) || 0) - ((b && b.ro_number) || 0);
  });
}

// A recorded value, or the honest "not recorded" marker — NEVER a blank for a
// chain row (a blank reads as broken software; "not recorded" is the true state
// and is exactly the gap this slice closes going forward).
export function recordedOr(value) {
  const s = value == null ? '' : String(value).trim();
  return s ? { recorded: true, text: s } : { recorded: false, text: 'not recorded' };
}

// Close-gate validation (PART 4). A comeback cannot close until BOTH the
// complaint and the comeback resolution are non-empty (non-whitespace). Pure;
// the caller only invokes it when the RO is a comeback and maps the returned
// keys to human labels. Returns { ok, missing: [<keys>] }.
export function validateComebackClose(input) {
  const complaint = (input && input.complaint != null ? String(input.complaint) : '').trim();
  const resolution = (input && input.resolution != null ? String(input.resolution) : '').trim();
  const missing = [];
  if (!complaint) missing.push('complaint');
  if (!resolution) missing.push('resolution');
  return { ok: missing.length === 0, missing };
}
