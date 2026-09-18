/* ============================================================
   ro-totals-ready.js — "wait for THE RO calculator before any total renders".
   CLASSIC script (not a module) so a board's main <script> can use it
   synchronously. See docs/wiring/card-fee.md §3a.

   THE RACE IT CLOSES. shared/ro-totals.js is an ES module, loaded by an
   inline <script type="module"> that sets window.RoTotals. Module scripts
   are DEFERRED: they run only after the whole page has been parsed. A board's
   main classic <script> runs DURING parsing and starts its data loads at once
   (the advisor board's RO list, a ?ro= deep link, bookkeeping's Financial
   Pulse, Profit by RO). When one of those reads comes back before the module
   has run, the render hit `window.RoTotals` === undefined — the
   "Something failed in the background: … 'computeRoTotals'" banner on the RO
   Board (regression from 68ae803, card fee).

   THE RULE. cdRoTotalsReady() → Promise that resolves with window.RoTotals as
   soon as it exists, or with null if it never will. "Never" is knowable:
   the browser fires DOMContentLoaded only AFTER every deferred and module
   script has run (or failed), so if window.RoTotals is still missing then,
   the calculator failed to load. Callers must then show a clear message —
   never a total computed some other way (it would silently drop the card
   fee). Nothing here computes a total.

   Must load BEFORE the board's main <script>, as a classic <script src>.
   Tested by shared/ro-totals-ready.test.js (node --test, vm sandbox).
   ============================================================ */
(function (root) {
  var domLoaded = false;
  var waiters = [];

  function settle() {
    var rt = root.RoTotals || null;
    while (waiters.length) waiters.shift()(rt);
  }

  if (root.document && root.document.addEventListener) {
    // readyState 'complete' = DOMContentLoaded already fired (late include).
    // NOT 'interactive': that is set BEFORE deferred/module scripts run.
    if (root.document.readyState === 'complete') domLoaded = true;
    else root.document.addEventListener('DOMContentLoaded', function () { domLoaded = true; settle(); }, { once: true });
  }

  root.cdRoTotalsReady = function () {
    if (root.RoTotals) return Promise.resolve(root.RoTotals);
    if (domLoaded) return Promise.resolve(null);   // every module has run; this one failed
    return new Promise(function (resolve) { waiters.push(resolve); });
  };

  // The message every surface shows when the calculator failed to load.
  root.cdRoTotalsMissingText =
    "RO totals couldn't load, so no totals are shown (they'd be missing the card fee). Reload the page.";
})(typeof window !== 'undefined' ? window : this);
