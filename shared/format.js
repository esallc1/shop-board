/* ============================================================
   format.js — shared display helpers (currently: formatPhone).

   Storage is canonical, display is derived. Imported ALLDATA customer
   phones are stored as 10 raw digits; this renders them as (239) 565-3158.
   The pre-existing customers are stored already-formatted, so a value that
   already contains non-digits is passed through UNCHANGED. Never mutates
   storage — display only.

   One-line include:  <script src="shared/format.js"></script>
   Global:            formatPhone(value) -> string
   ============================================================ */
(function () {
  if (window.formatPhone) return;   // idempotent — safe to include twice
  window.formatPhone = function (v) {
    if (v == null || v === '') return '';
    var s = String(v);
    var d = s.replace(/\D/g, '');
    // already formatted (has non-digits), or not a clean 10-digit → pass through unchanged
    if (/\D/.test(s) || d.length !== 10) return s;
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  };
})();
