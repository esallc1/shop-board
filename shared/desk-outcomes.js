/* ============================================================
   desk-outcomes.js — what happens to a Desk item when someone finishes with it,
   and how to take it back. Decision logic only: no DOM, no DB, no Date.now() of
   its own (every entry point takes `now`).

   WHY THIS EXISTS. The Desk had exactly one way to clear a lane item — "Done" →
   `resolved_at` — with no confirm, no undo and no record of WHAT happened. A
   read-only audit of prod on 2026-09-20 found that of 40 resolved appointments,
   **22 were resolved within 60 seconds of being noted, by the person who noted
   them** (fastest 3s, 5s, 6s). That is a mis-click, not "the car came in". One
   live casualty: call id 755 (OMAR MADRID, due Sep 28) resolved 72 seconds after
   MANNY PAGAN booked it, invisible to everyone since.

   THE MODEL (Cris, 2026-09-20). The Desk is where LEADS live — people who called
   but have no RO yet. So "finished with it" is four different things, and only
   three of them mean the lead is over:

     arrived          the car showed up            → CLEARS (resolved)
     fixed_elsewhere  not coming, went elsewhere   → CLEARS (resolved), reason kept
     not_now          can't right now — money/time → **DOES NOT CLEAR**
     called           Callbacks lane: I made the call → CLEARS (resolved)

   `not_now` is the whole point. A lead who can't afford it this month is still a
   lead, so the row STAYS OPEN and moves lanes: `next_step` → `quoted_callback`,
   `due_at` → the call-back date (default 14 days out), `outcome_prev_due_at`
   keeps the drop-off date they missed so the callback row can say why it is
   there, and `resolved_at` is never touched. Resolving it would be the same bug
   in a new coat.

   Reschedule is deliberately NOT an outcome — nothing happened yet. It reuses the
   existing Edit modal, changes only the date, and the item stays on Coming in.

   Pure → shared/desk-outcomes.test.js drives it under `node --test`.
   Companion: shared/desk-appointments.js decides what the lanes SHOW.
   ============================================================ */

// ── the vocabulary (must match migrations/20260920_calls_outcome_*.sql) ──
export const OUTCOMES = ['arrived', 'fixed_elsewhere', 'not_now', 'called'];

// The outcomes a DROP-OFF row offers, in the order the buttons appear.
export const DROPOFF_OUTCOMES = ['arrived', 'fixed_elsewhere', 'not_now'];

// Full wording — used in "Recently cleared" and in confirms.
export const OUTCOME_LABEL = {
  arrived: 'Car arrived',
  fixed_elsewhere: 'Not coming — fixed elsewhere',
  not_now: 'Not coming — can’t right now',
  called: 'Called',
};

// Short wording — the lane buttons are ~90px wide; the full label is the tooltip.
export const OUTCOME_SHORT = {
  arrived: 'Arrived',
  fixed_elsewhere: 'Fixed elsewhere',
  not_now: 'Can’t right now',
  called: 'Done',
};

// How many days out the call-back date defaults to for `not_now`. The advisor can
// change it before saving — this is a starting point, not a rule.
export const NOT_NOW_DEFAULT_DAYS = 14;

// "Recently cleared" window. Anything cleared inside it can be undone; so can
// anything still due in the future, however long ago it was cleared (that is the
// id-755 case — cleared Sep 8, due Sep 28).
export const CLEARED_WINDOW_DAYS = 30;

const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const nowMs = (now) => (now instanceof Date ? now.getTime() : (now == null ? Date.now() : new Date(now).getTime()));

export function isOutcome(v) { return OUTCOMES.indexOf(v) !== -1; }

// Does this outcome end the lead? `not_now` is the one that does not.
export function clearsItem(outcome) {
  return outcome === 'arrived' || outcome === 'fixed_elsewhere' || outcome === 'called';
}

// ── the writes ────────────────────────────────────────────────
/* THE patch for finishing with an item. Returns null for anything invalid rather
   than a half-formed write.
     opts.now        ISO string stamped into resolved_at
     opts.byName     who did it (CHAT_IDENTITY.name)
     opts.note       optional short reason
     opts.call       the row (needed by not_now for the date it is leaving)
     opts.callbackDueAt  not_now only: ISO for the new call-back date
   A clearing outcome never touches next_step/due_at; `not_now` never touches
   resolved_at. Neither ever writes a field the other owns. */
export function outcomePatch(outcome, opts) {
  const o = opts || {};
  if (!isOutcome(outcome)) return null;
  const note = (o.note == null ? '' : String(o.note)).trim().slice(0, 500) || null;

  if (outcome === 'not_now') {
    if (!o.callbackDueAt || ms(o.callbackDueAt) == null) return null;
    const call = o.call || {};
    return {
      next_step: 'quoted_callback',
      due_at: o.callbackDueAt,
      due_all_day: true,                    // callbacks are all-day; the lane has no time column
      outcome: 'not_now',
      outcome_note: note,
      // the drop-off date they could not make — due_at is about to be overwritten
      outcome_prev_due_at: call.due_at || null,
      noted_by_name: o.byName || null,
    };
  }
  return {
    resolved_at: o.now || new Date().toISOString(),
    resolved_by_name: o.byName || null,
    outcome,
    outcome_note: note,
  };
}

/* Undo — put a cleared item back exactly where it was. next_step and due_at were
   never changed by a clearing outcome, so nulling the four fields below restores
   the row completely. `outcome_prev_due_at` is deliberately NOT cleared: only
   `not_now` sets it, and if such a row was later cleared from the Callbacks lane,
   undoing should return it to that lane still knowing why it is there. */
export function undoPatch() {
  return { resolved_at: null, resolved_by_name: null, outcome: null, outcome_note: null };
}

// ── the confirm ───────────────────────────────────────────────
/* Ask before clearing something that has not come due yet — that is the shape of
   every real mis-click we found (id 755: cleared Sep 8, due Sep 28).

   Deliberately STRICTLY-FUTURE-DAY, not "any moment still ahead": a car arriving
   later today is the normal flow, and prompting on every ordinary arrival would
   just teach people to click through the dialog — which is how the confirm stops
   working the day it matters. An undated item has no date to be ahead of. */
export function needsConfirm(call, now) {
  if (!call || !call.due_at) return false;
  const due = ms(call.due_at);
  if (due == null) return false;
  const d = new Date(due); d.setHours(0, 0, 0, 0);
  const t = new Date(nowMs(now)); t.setHours(0, 0, 0, 0);
  return d.getTime() > t.getTime();
}

export function confirmMessage(call, whoLabel, whenLabel) {
  const who = (whoLabel || '').trim() || 'this lead';
  const when = (whenLabel || '').trim();
  return `This clears ${who}'s ${when ? when + ' ' : ''}drop-off from the Desk. Sure?`;
}

// ── "Recently cleared" ────────────────────────────────────────
/* What the undo list shows: resolved in the last 30 days, PLUS anything resolved
   whose date is still ahead however long ago it was cleared. The second half is
   not a nicety — it is the only reason id 755 is reachable. Newest cleared first. */
export function isRecentlyCleared(call, now, opts) {
  const o = opts || {};
  const days = o.days == null ? CLEARED_WINDOW_DAYS : o.days;
  if (!call || !call.resolved_at) return false;
  const res = ms(call.resolved_at);
  if (res == null) return false;
  const t = nowMs(now);
  if (res >= t - days * 86400000) return true;
  const due = call.due_at ? ms(call.due_at) : null;
  return due != null && due >= t;
}

export function recentlyCleared(calls, now, opts) {
  return (calls || [])
    .filter((c) => isRecentlyCleared(c, now, opts))
    .sort((a, b) => (ms(b.resolved_at) || 0) - (ms(a.resolved_at) || 0));
}

// How a cleared row reads in that list. An `outcome` of null is a row cleared
// before outcomes existed — say so plainly rather than inventing a reason.
export function clearedLabel(call) {
  const c = call || {};
  return isOutcome(c.outcome) ? OUTCOME_LABEL[c.outcome] : 'Done (before outcomes)';
}

// ── the callback row's "why am I here" line ───────────────────
/* A lead parked by `not_now` looks identical to an ordinary callback unless the
   row says what happened. `fmtDate` is injected so this stays DOM-free and the
   board can pass its own dueLabel. */
export function callbackReason(call, fmtDate) {
  const c = call || {};
  if (c.outcome !== 'not_now') return '';
  const when = (c.outcome_prev_due_at && typeof fmtDate === 'function')
    ? fmtDate(c.outcome_prev_due_at) : '';
  const head = when ? `Couldn’t make ${when} drop-off` : 'Couldn’t make the drop-off';
  const note = (c.outcome_note || '').trim();
  return note ? `${head} — ${note}` : head;
}

// The call-back date the not_now dialog opens on: N days out, local, as
// 'YYYY-MM-DD' for a date input.
export function defaultCallbackDate(now, days) {
  const d = new Date(nowMs(now));
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (days == null ? NOT_NOW_DEFAULT_DAYS : days));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
