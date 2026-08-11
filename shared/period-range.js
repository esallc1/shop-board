/* ============================================================================
   shared/period-range.js — the ONE copy of the office-board period-selector date
   math. Presets mirror the Bookkeeping "Financial Pulse" selector EXACTLY, so any
   screen that offers the same This week / Last week / … / Custom control resolves
   an identical window and the two never disagree on what "last week" means.

   Conventions (identical to Financial Pulse):
     • WEEK  = CALENDAR week, Sunday 00:00 → Saturday 23:59, containing the anchor
               day (not clipped to today). "Last week" = the prior Sun–Sat week.
     • MONTH / QUARTER = calendar month / quarter; "this" is month/quarter-to-date
               (start-of-period → today), "last" is the whole previous period.
     • Dates are LOCAL Date objects; ymd() serialises as 'YYYY-MM-DD' to match the
               'YYYY-MM-DD' date strings the boards compare against.

   Pure + framework-free → assigned to window.PeriodRange. Consumed by:
     • Financial Pulse   (bookkeeping-board.html — delegates its date helpers here)
     • Profit by RO      (shared/profit-by-ro.js)
   ========================================================================== */
window.PeriodRange = (function () {
  'use strict';

  // Selector order + labels (drives the preset buttons on every consumer).
  const PRESETS = [
    { key: 'this_week',    label: 'This week' },
    { key: 'last_week',    label: 'Last week' },
    { key: 'this_month',   label: 'This month' },
    { key: 'last_month',   label: 'Last month' },
    { key: 'this_quarter', label: 'This quarter' },
    { key: 'last_quarter', label: 'Last quarter' },
    { key: 'custom',       label: 'Custom' },
  ];
  const labelFor = (key) => { const p = PRESETS.find(x => x.key === key); return p ? p.label : ''; };

  // ── date helpers — LOCAL dates as 'YYYY-MM-DD' ──
  function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function parseYmd(s) { return s ? new Date(s + 'T00:00:00') : null; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

  // preset → [startDate, endDate] (inclusive, local Date objects).
  // opts: { customFrom, customTo, now } — customFrom/To are 'YYYY-MM-DD' strings
  // (used only for 'custom'); now overrides "today" for testing (Date or ISO).
  function rangeFor(p, opts) {
    const o = opts || {};
    const now = o.now ? new Date(o.now) : new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const q = Math.floor(today.getMonth() / 3);
    switch (p) {
      case 'this_week':  { const s = startOfWeek(today); return [s, addDays(s, 6)]; }        // Sun–Sat week containing today
      case 'last_week':  { const s = addDays(startOfWeek(today), -7); return [s, addDays(s, 6)]; } // the prior Sun–Sat week
      case 'this_month': return [new Date(today.getFullYear(), today.getMonth(), 1), today];
      case 'last_month': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)];
      case 'this_quarter': return [new Date(today.getFullYear(), q * 3, 1), today];
      case 'last_quarter': { let y = today.getFullYear(), lq = q - 1; if (lq < 0) { lq = 3; y -= 1; } return [new Date(y, lq * 3, 1), new Date(y, lq * 3 + 3, 0)]; }
      case 'custom': {
        const f = parseYmd(o.customFrom) || addDays(today, -6);
        const t = parseYmd(o.customTo) || today;
        return f <= t ? [f, t] : [t, f];
      }
      default: return [addDays(today, -6), today];
    }
  }

  // Convenience: the range plus its 'YYYY-MM-DD' string bounds in one object.
  function currentRange(p, opts) {
    const [s, e] = rangeFor(p, opts);
    return { start: s, end: e, fromStr: ymd(s), toStr: ymd(e) };
  }

  // "Aug 2 – 8" / "Dec 28 – Jan 3, 2026" (year shown only when it isn't this year).
  function fmtRangeLabel(s, e) {
    const y = new Date().getFullYear();
    const yr = (s.getFullYear() !== y || e.getFullYear() !== y) ? `, ${e.getFullYear()}` : '';
    return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${yr}`;
  }

  // A timestamptz → 'YYYY-MM-DD' in the shop's timezone (America/New_York), so a
  // row is bucketed by the shop's calendar day, not the browser's. Mirrors the
  // Financial Pulse income-bucketing helper of the same name.
  function nyDate(ts) {
    if (!ts) return null;
    try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
    catch (e) { return ymd(new Date(ts)); }
  }

  return { PRESETS, labelFor, ymd, parseYmd, addDays, startOfWeek, daysBetween, rangeFor, currentRange, fmtRangeLabel, nyDate };
})();
