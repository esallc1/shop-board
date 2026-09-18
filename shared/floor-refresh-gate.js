/* ============================================================
   floor-refresh-gate.js — "only paint the newest answer" for the RO detail's
   floor-backed controls (Warranty / Comeback toggle + work Status dropdown).
   See docs/wiring/comeback-warranty.md §6.

   Those two controls are painted from an async floor-row lookup. Since
   2026-09-18 the lookup re-runs after Check in / Arrived, after a tech
   assign, and on tab return — so replies can overlap. A reply may only paint
   if, when it lands, ALL of these still hold:
     • no newer refresh has started      (token is the latest),
     • nothing invalidated it            (a warranty/status WRITE began —
                                          the write's own result wins),
     • the same RO is still open          (currentRo id unchanged).

   Pure, no DOM — shared/floor-refresh-gate.test.js runs under node --test.
   ============================================================ */

// getCurrentRoId: () => the id of the RO open RIGHT NOW (or null/undefined).
export function createFloorRefreshGate(getCurrentRoId) {
  let seq = 0;
  return {
    // Start a refresh for `roId`. Returns isCurrent(): true only while this is
    // still the newest refresh, not invalidated, and `roId` is still open.
    begin(roId) {
      const token = ++seq;
      const key = roId == null ? null : String(roId);
      return () => {
        if (token !== seq || key == null) return false;
        const now = getCurrentRoId();
        return now != null && String(now) === key;
      };
    },
    // Retire every refresh in flight (call before a floor WRITE starts).
    invalidate() { seq++; },
  };
}
