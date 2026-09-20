/* ============================================================
   desk-appointments.js — what the Desk's "Coming in" lane and the drop-off
   calendar are allowed to SHOW. Display rules only: nothing here writes, and
   nothing here decides what a drop-off IS.

   WHY THIS EXISTS. The Desk only ever modelled the future. The lane filtered
   `due_at >= today` and the calendar was handed that same already-filtered
   array, so:
     • a drop-off whose date had passed vanished from the lane overnight,
     • it vanished from the calendar too — and because the filter ran BEFORE
       renderCalendar, "‹ Previous week" drew an empty grid no matter what had
       been booked,
     • the overdue badge counted callbacks only, so a missed drop-off wasn't
       merely hidden, it was uncounted,
     • a drop-off with no date at all was dropped by both (they required
       `c.due_at`), even though dueLabel already renders "No date".
   Read-only audit of prod on 2026-09-20 found 16 unresolved past-due drop-offs
   and 3 undated ones sitting invisible. See docs/wiring/call-window-desk.md.

   RESOLVED ROWS ARE STILL HIDDEN. deskLoad's query keeps `.is('resolved_at',
   null)`; un-resolve / undo is a separate job. Every function here takes rows
   that are already unresolved and only guards defensively.

   THE RECOVERED NOTE. When those rows reappear the team must not read it as a
   new bug, so a drop-off booked BEFORE the fix shipped carries a short tag and
   the lane carries one banner. Both switch themselves off after
   RECOVERED_UNTIL, reusing the shop-time date rule from new-badge.js — so the
   notice can never get stuck on forever and nobody has to remember to remove
   it. A drop-off booked after the cutoff is just a normal overdue item.

   Pure — no DOM, no Date.now() of its own (every entry point takes `now`), so
   shared/desk-appointments.test.js drives it directly under `node --test`.
   ============================================================ */

import { shopToday, isNewBadgeVisible } from './new-badge.js';

// A drop-off booked before this date was booked while the display bug was
// live, so it gets the "recovered" note. ISO 'YYYY-MM-DD', shop time.
export const RECOVERED_CUTOFF = '2026-09-21';

// The tag + banner stop showing on/after this date (same rule as a NEW badge:
// visible while shop-today < until). Two weeks is long enough for everyone to
// have worked the pile.
export const RECOVERED_UNTIL = '2026-10-05';

export const RECOVERED_TAG =
  'Recovered — this was hidden by a display bug. Clear it if it’s no longer needed.';

export const RECOVERED_BANNER =
  'Old drop-offs are back. A display bug was hiding drop-offs once their date passed — '
  + 'nothing new broke. Go through the red ones and say what happened: Arrived, Reschedule, '
  + 'Fixed elsewhere, or Can’t right now.';

// ── the one overdue rule ──────────────────────────────────────
// Local midnight of whatever moment `now` names. The board renders in shop-
// local time, so an all-day item is not late until the DAY is past.
function startOfDay(now) {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now == null ? Date.now() : now);
  d.setHours(0, 0, 0, 0);
  return d;
}

// THE overdue definition for both lanes — the advisor board's local isOverdue
// delegates here so callbacks and drop-offs can never drift apart. An all-day
// item is late once its day is behind us; a timed item uses the clock. No date
// is NOT overdue (it's undated — a different bucket entirely).
export function isOverdueDue(dueAt, allDay, now) {
  if (!dueAt) return false;
  const due = new Date(dueAt);
  if (isNaN(due.getTime())) return false;
  if (allDay) {
    const d = new Date(due.getTime());
    d.setHours(0, 0, 0, 0);
    return d < startOfDay(now);
  }
  return due < (now instanceof Date ? now : new Date(now == null ? Date.now() : now));
}

// ── bucketing + order ─────────────────────────────────────────
const isDrop = (c) => !!c && c.next_step === 'dropping_off' && !c.resolved_at;
const parsed = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const byDueAsc = (a, b) => (parsed(a.due_at) || 0) - (parsed(b.due_at) || 0);
// Undated rows have no date to sort on, so oldest-booked first; a row with no
// noted_at either sinks to the bottom rather than shuffling unpredictably.
const byNotedAsc = (a, b) => (parsed(a.noted_at) || Infinity) - (parsed(b.noted_at) || Infinity);

// Split the unresolved drop-offs into the three things the lane shows. An
// unparseable due_at counts as undated — it has no slot and no order, but it
// must never disappear (that is the whole bug this fixes).
export function splitComingIn(calls, now) {
  const overdue = [], undated = [], upcoming = [];
  (calls || []).filter(isDrop).forEach((c) => {
    if (!c.due_at || parsed(c.due_at) == null) { undated.push(c); return; }
    (isOverdueDue(c.due_at, c.due_all_day, now) ? overdue : upcoming).push(c);
  });
  overdue.sort(byDueAsc);     // oldest miss first — the one that has waited longest
  upcoming.sort(byDueAsc);    // soonest first (unchanged from before)
  undated.sort(byNotedAsc);
  return { overdue, undated, upcoming };
}

// Lane order: overdue at the top (oldest first), then undated, then upcoming.
// Undated sits above upcoming on purpose — it was invisible too, and burying it
// under next month's bookings would just hide it a second way.
export function comingInOrder(calls, now) {
  const { overdue, undated, upcoming } = splitComingIn(calls, now);
  return overdue.concat(undated, upcoming);
}

// What the week calendar may draw: every unresolved drop-off that HAS a usable
// date, past and future alike. The week window itself does the date filtering,
// which is what makes "‹ Previous week" mean something. Undated rows are left
// out — there is no slot to draw them in; the lane carries them.
export function calendarItems(calls) {
  return (calls || []).filter((c) => isDrop(c) && c.due_at && parsed(c.due_at) != null);
}

// The header pill + sidebar badge: overdue callbacks AND overdue drop-offs.
// Undated rows are not late, so they are not counted here.
export function overdueCount(calls, now) {
  return (calls || []).filter((c) =>
    c && !c.resolved_at
    && (c.next_step === 'quoted_callback' || c.next_step === 'dropping_off')
    && isOverdueDue(c.due_at, c.due_all_day, now)
  ).length;
}

// ── the recovered note ────────────────────────────────────────
// Shop-time calendar day of a timestamp, or null if it isn't one.
function shopDay(iso) {
  return iso ? shopToday(iso) : null;
}

// A row that was booked while the bug was live AND was hidden by it: noted
// before the cutoff, and either undated or dated before the cutoff. A drop-off
// booked after the fix shipped is just normally overdue and gets no tag.
export function isRecovered(call, cutoff) {
  const until = cutoff || RECOVERED_CUTOFF;
  if (!isDrop(call)) return false;
  const noted = shopDay(call.noted_at);
  if (!noted || !(noted < until)) return false;
  if (!call.due_at || parsed(call.due_at) == null) return true;
  const due = shopDay(call.due_at);
  return !!due && due < until;
}

// Tag + banner expire together, on the NEW-badge rule: visible while shop-today
// is strictly before `until`. A malformed date is never visible.
export function recoveryNoticeVisible(now, until) {
  return isNewBadgeVisible(until || RECOVERED_UNTIL, now);
}

// The one lane banner: only while the notice window is open AND at least one
// recovered row is still sitting there unresolved. Once the team has cleared
// them the banner goes away on its own, without waiting for the date.
export function showRecoveryBanner(calls, now, opts) {
  const o = opts || {};
  if (!recoveryNoticeVisible(now, o.until)) return false;
  return (calls || []).some((c) => isRecovered(c, o.cutoff));
}
