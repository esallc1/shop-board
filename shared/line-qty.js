/* ============================================================
   line-qty.js — strict number parsing for the RO Add/Edit-Line pop-up.
   See docs/wiring/ro-line-items.md §2a.

   WHY THIS EXISTS. The pop-up's Qty/Hours and money fields used to be
   <input type="number">. A number input changes its own value when the mouse
   wheel scrolls over it or an arrow key is pressed — silently. Reproduced
   2026-09-18: Hours 14 → 13.5 from scrolling the pop-up toward Save; Parts
   Qty 14 → 14.01 from one wheel tick (prod RO 6022 carries a 1.01 PAN FILTER
   line from exactly that); a typed "14,5" had its comma dropped → 145. The
   fields are now type="text" inputmode="decimal" (no spinner, no wheel, no
   arrows, still the decimal keypad on phones) and EVERY value goes through
   the parsers below before Save. A value they reject blocks Save.

   THE RULES (pure, no DOM — shared/line-qty.test.js runs under node --test):
   • Accepted: digits with an optional decimal point — 14, 14.5, 14., .5 —
     or a decimal COMMA with 1–2 digits after it — "14,5" → 14.5,
     "14,25" → 14.25. Surrounding spaces are ignored.
   • Rejected: everything else. "1,250" (a thousands comma, or a decimal with
     3 places? — ambiguous, so neither), "$140", "14 hrs", "-2", "1e3",
     "1.2.3", "14,5,0".
   • Rounded to 2 decimal places, half-up (storage is numeric(10,2)).
   • parseQty: must be > 0 after rounding. Blank is an error.
   • parseMoney: must be >= 0. Blank → `blankValue` (0 for Rate / Sell /
     Price / Amount, null for the optional parts Cost) — same as before.
   ============================================================ */

// Hours above this ask "Is N hours right?" before saving (largest real labor
// line seen on prod as of 2026-09-18: 22 h).
export const HOURS_CONFIRM_ABOVE = 24;

const DOT_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;   // 14 · 14.5 · 14. · .5
const COMMA_RE = /^(\d*),(\d{1,2})$/;          // 14,5 · 14,25 · ,5

// Half-up to 2 dp without binary-float surprises (1.005 → 1.01, not 1.00).
export function round2(n) {
  const v = Number(Math.round(Number(n + 'e2')) + 'e-2');
  return Number.isFinite(v) ? v : Math.round(Number(n) * 100) / 100;   // e.g. n = 1e-7
}

// Low-level: raw text → { ok, value, blank } or { ok:false, error }.
export function parseDecimal(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, blank: true, value: null };
  let norm = null;
  if (DOT_RE.test(s)) norm = s;
  else {
    const m = COMMA_RE.exec(s);
    if (m) norm = (m[1] || '0') + '.' + m[2];
  }
  if (norm == null) {
    const why = /^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)
      ? 'no thousands commas — type 1250, not 1,250'
      : 'numbers only, like 14 or 14.5';
    return { ok: false, error: why };
  }
  const n = Number(norm);
  if (!Number.isFinite(n)) return { ok: false, error: 'numbers only, like 14 or 14.5' };
  return { ok: true, blank: false, value: round2(n) };
}

// Qty / Hours: required, > 0.
export function parseQty(raw) {
  const r = parseDecimal(raw);
  if (!r.ok) return r;
  if (r.blank) return { ok: false, error: 'enter a number, like 14 or 14.5' };
  if (!(r.value > 0)) return { ok: false, error: 'must be more than 0' };
  return { ok: true, value: r.value };
}

// Money: >= 0 (the parser has no minus sign, so that is structural). Blank
// keeps the old behaviour: `blankValue` (0, or null for an optional field).
export function parseMoney(raw, blankValue = 0) {
  const r = parseDecimal(raw);
  if (!r.ok) return r;
  if (r.blank) return { ok: true, value: blankValue };
  return { ok: true, value: r.value };
}

export function needsHoursConfirm(hours) {
  return Number(hours) > HOURS_CONFIRM_ABOVE;
}

// 14 → "14", 14.5 → "14.5", 14.25 → "14.25" (no trailing zeros).
export function formatQty(n) {
  return String(round2(n));
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Always cents: 1960 → "$1,960.00".
export function formatMoney(n) { return USD.format(round2(n)); }
// Cents only when there are some: 140 → "$140", 139.5 → "$139.50".
export function formatRate(n) {
  const v = round2(n);
  return Number.isInteger(v) ? '$' + v.toLocaleString('en-US') : USD.format(v);
}

// The live check under a labor line's Sell: "14 h × $140 = $1,960.00".
// `unit` is 'h' (Book Hours ON, field labelled Hours) or '' (labelled Qty →
// "14 × $140 = …"). Returns null when either side doesn't parse, so the page
// shows nothing rather than a wrong sum.
export function laborMathLine(qtyRaw, rateRaw, unit = 'h') {
  const q = parseQty(qtyRaw);
  const r = parseMoney(rateRaw, 0);
  if (!q.ok || !r.ok) return null;
  const left = formatQty(q.value) + (unit ? ' ' + unit : '');
  return `${left} × ${formatRate(r.value)} = ${formatMoney(q.value * r.value)}`;
}
