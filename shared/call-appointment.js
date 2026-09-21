/* ============================================================
   shared/call-appointment.js — what a call's Desk appointment looks like
   OUTSIDE the Desk: the Call Log row and the customer-record timeline.

   Until 2026-09-21 the appointment date and what came of it showed only on
   the Desk; the Call Log never selected `due_at`, and the customer record
   had it in memory but never drew it. This module owns the COMPOSITION of
   those lines only. The wording is borrowed, injected by the caller:
     • the date     → the Desk's own `dueLabel(dueAt, allDay)`
     • the outcome  → `DeskOutcomes.clearedLabel(call)` (shared/desk-outcomes.js)
   so a Call Log row and a Desk row can never describe the same call two ways.

   It also owns the customer record's "when was this call" rule: a manual
   "+Add" appointment (api/desk-appointment.js) has `started_at` NULL on
   purpose, so it falls back to `created_at` — for display AND for sorting.

   Pure, no DOM → shared/call-appointment.test.js.
   See docs/wiring/call-window-desk.md §10.
   ============================================================ */

// The verb for each Desk step. Other next_steps carry no appointment.
export const DUE_VERB = { dropping_off: 'Drop-off', quoted_callback: 'Call back' };

// Tag for a row made by "+Add" on the Desk rather than by a real phone call.
export const MANUAL_TAG = 'Added on the Desk';

// "→ Drop-off Tue, Sep 23 · 9:00 AM" / "→ Call back Tue, Sep 23" — or '' when
// the call has no (valid) appointment. All-day follows the calendar's rule:
// only an explicit `false` is timed.
export function dueLine(call, fmtDue) {
  const c = call || {};
  const verb = DUE_VERB[c.next_step];
  if (!verb || !c.due_at || typeof fmtDue !== 'function') return '';
  if (Number.isNaN(Date.parse(c.due_at))) return '';
  const when = fmtDue(c.due_at, c.due_all_day !== false);
  return when ? `→ ${verb} ${when}` : '';
}

// What came of it. A resolved row → "✓ <label> · by <name>" (a row cleared
// before outcomes existed reads "Done (before outcomes)" — clearedLabel's own
// words). `follow_up` never resolves — the lead is parked in Callbacks — so it
// shows its label without the tick. Anything else, or no outcome columns
// loaded (pre-migration fallback tier) → ''.
export function outcomeLine(call, labelOf) {
  const c = call || {};
  if (typeof labelOf !== 'function') return '';
  if (c.resolved_at) {
    const by = c.resolved_by_name ? ` · by ${c.resolved_by_name}` : '';
    return `✓ ${labelOf(c)}${by}`;
  }
  if (c.outcome === 'follow_up') return labelOf(c);
  return '';
}

// Made by "+Add", not by CTM: api/desk-appointment.js uses a synthetic
// NEGATIVE ctm_call_id (real CTM ids are positive).
export function isManualCall(call) {
  const id = call && call.ctm_call_id;
  return id != null && id !== '' && Number(id) < 0;
}

// The moment a call belongs to on a timeline: when it rang, or — for a manual
// row, which never rang — when it was added. null only if neither exists.
export function callWhen(call) {
  const c = call || {};
  return c.started_at || c.created_at || null;
}

// Oldest-first comparator on callWhen. A row with no time at all sorts first,
// as before (String(null||'') === '').
export function compareCallWhen(a, b) {
  return String(callWhen(a) || '').localeCompare(String(callWhen(b) || ''));
}
