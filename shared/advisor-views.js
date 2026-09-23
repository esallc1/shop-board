/* ============================================================
   advisor-views.js — which advisor-board tab to reopen after a refresh.

   The board remembers the open tab in sessionStorage['advisorBoardActiveView']
   and re-clicks it on load. Three tabs were REMOVED (Front Desk redesign, Cris
   2026-09-16): Parts, Payments, Customer Log. A browser that had one of them
   open would otherwise keep a dead key and land on whatever the default is,
   with the stale value sitting there forever. This decides, in one place:

     • a removed tab   → its natural replacement (Payments / Parts → RO Board,
                         Customer Log → Desk, My Commission — disabled
                         2026-09-23 — → RO Board), and the stale key is cleared;
     • an unknown tab  → nothing to open (the board's default stays), key cleared;
     • a live tab      → reopen it.

   Classic script (no module) so the board's inline code can call it
   synchronously on load; tested under node via vm (advisor-views.test.js).
   ============================================================ */
(function (global) {
  // mycommission: the tab still exists in the markup but is disabled for good
  // (2026-09-23, no commission pay plan) — a saved one lands on the RO Board.
  var REMOVED_ADVISOR_VIEWS = { parts: 'cdros', payments: 'cdros', 'customer-log': 'desk', mycommission: 'cdros' };

  /**
   * @param {string|null} saved      the value in sessionStorage (may be null)
   * @param {string[]} availableKeys  data-view keys of the sidebar items that exist now
   * @returns {{ view: string|null, clear: boolean }}
   */
  function cdResolveSavedView(saved, availableKeys) {
    var keys = Array.isArray(availableKeys) ? availableKeys : [];
    if (!saved || typeof saved !== 'string') return { view: null, clear: false };
    if (Object.prototype.hasOwnProperty.call(REMOVED_ADVISOR_VIEWS, saved)) {
      var to = REMOVED_ADVISOR_VIEWS[saved];
      return { view: keys.indexOf(to) !== -1 ? to : null, clear: true };
    }
    if (keys.indexOf(saved) === -1) return { view: null, clear: true };
    return { view: saved, clear: false };
  }

  global.cdResolveSavedView = cdResolveSavedView;
  global.CD_REMOVED_ADVISOR_VIEWS = REMOVED_ADVISOR_VIEWS;
})(typeof window !== 'undefined' ? window : globalThis);
