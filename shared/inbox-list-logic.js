/* ============================================================
   inbox-list-logic.js — the Inbox tray's ONE "Needs handling" list (slice 2a),
   plus the badge / fold / auto-open rules, with no DOM and no database.
   Wiring: docs/wiring/inbox-calls.md §3 + docs/wiring/messenger-tray.md §2.

   Calls and Facebook threads are one mixed list (Cris, 2026-09-25, option B):
     1. on top — anything nobody has answered yet, newest first:
          a call with NO NOTE yet (noted_at null), or
          a Facebook thread where the CUSTOMER spoke last (no staff reply since
          their last message arrived — the after-hours auto-reply and a failed
          send don't count as a reply);
     2. then everything else, newest first.
   Slice 4 (Cris, 2026-09-26, order A): a MISSED call with no note goes above
   everything — above the rest of the top group, unanswered Facebook threads included.
   "Newest" = when the customer reached out: a call's start, or the ARRIVAL of
   the customer's last Facebook message — never our own reply, so a thread we
   just answered doesn't jump to the top.
   The ringing call (pinned above the list) and the opened call are not rows.
   "Can't reply anymore" threads are not rows either (below the list, uncounted).
   ============================================================ */
import { inboundArrivedMs } from './messenger-tray-logic.js';

const ms = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

// Is this message a reply by the shop's staff? Outgoing, not the auto-reply,
// not a send Facebook refused. A reply typed in Facebook's own app counts.
export function isStaffReply(msg) {
  return !!msg && msg.direction === 'out' && !msg.auto && msg.send_status !== 'failed';
}

// The newest staff reply per thread (ms), from a list of messages (any order).
export function lastStaffReplyByThread(messages) {
  const out = {};
  for (const m of messages || []) {
    if (!m || !m.thread_id || !isStaffReply(m)) continue;
    const t = ms(m.sent_at);
    if (t !== null && (out[m.thread_id] == null || t > out[m.thread_id])) out[m.thread_id] = t;
  }
  return out;
}

// Did the customer speak last — no staff reply since their last message ARRIVED?
export function fbNeedsFirstResponse(thread, lastStaffMs) {
  const arrived = inboundArrivedMs(thread);
  if (arrived === null) return false;
  return lastStaffMs == null || lastStaffMs < arrived;
}

// calls:   [{ id, startMs, noted, ... }] — the call rows (not the pinned one, not the opened one)
// threads: the active waiting Facebook threads (splitWaiting().active)
// lastStaff: { [threadId]: ms } from lastStaffReplyByThread
// → [{ kind: 'call' | 'fb', id, ms, fresh, ref }] in list order. Inputs never mutated.
export function mergeNeedsHandling({ calls = [], threads = [], lastStaff = {} } = {}) {
  const items = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c) continue;
    items.push({ kind: 'call', id: String(c.id), ms: Number(c.startMs) || 0, fresh: !c.noted, missed: !!c.missed && !c.noted, ref: c });
  }
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t) continue;
    const last = lastStaff ? lastStaff[t.id] : null;
    items.push({ kind: 'fb', id: String(t.id), ms: inboundArrivedMs(t) || 0, fresh: fbNeedsFirstResponse(t, last), missed: false, ref: t });
  }
  // rank 0 = a missed call with no note, 1 = the rest of "nobody answered yet", 2 = everything else.
  const rank = (x) => (x.missed ? 0 : x.fresh ? 1 : 2);
  // Stable, fully deterministic: by rank, newest first, then calls before threads, then id.
  return items.sort((a, b) => (rank(a) - rank(b)) || (b.ms - a.ms)
    || (a.kind === b.kind ? 0 : a.kind === 'call' ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ── Counts, badges, fold / auto-open (unchanged from slice 1 — only moved here to lock them) ── */

// "Inbox · N waiting" and the fold decision: Facebook threads you can still reply
// to (only when Facebook loaded fine) + every call card on this board.
export function waitingCount({ mode, fbActive = 0, calls = 0 } = {}) {
  return (mode === 'ok' ? fbActive : 0) + calls;
}

// The strip's two badges. calls = { count, ringing } (count = every call card on
// this board, noted-not-closed included; ringing = a not-yet-opened call rings).
// fbActive = threads you can still reply to (past-24 h ones never count).
// fb.off === null → leave the f greyed-or-not as it was (a sign-in / load problem).
export function stripBadges({ mode, fbActive = 0, calls = { count: 0, ringing: false } } = {}) {
  const c = calls || { count: 0, ringing: false };
  const phone = { count: c.count || 0, ringing: !!c.ringing, missed: !!c.missed, off: !c.count, hidden: !c.count, text: String(c.count || 0) };
  const fb = mode === 'ok'
    ? { text: String(fbActive), hidden: !fbActive, off: !fbActive, note: false }
    : { text: '!', hidden: false, off: null, note: true };
  return { phone, fb };
}

// After a Facebook load. → the new look ('open' | 'tucked') or null (leave it).
//   newInbound = a customer message arrived since the last load AND a thread waits.
export function uiAfterLoad({ mode, loadedOnce, loadedOnceBefore, ui, count, before, newInbound, threadOpen, staleOpen } = {}) {
  if (mode === 'signin' || mode === 'notstaff' || (mode === 'error' && !loadedOnce)) return ui === 'hidden' ? 'tucked' : null;
  // Page load / new tab: stay folded — the badges show what's waiting. Never opens here.
  if (!loadedOnceBefore) return ui === 'hidden' ? 'tucked' : null;
  // Something NEW while the page is open: a customer message that just arrived.
  if (newInbound) return 'open';
  // The last waiting item was just handled (count dropped to 0) → fold back to the strip,
  // unless someone is reading a conversation or the "Can't reply anymore" list.
  if (count === 0 && before > 0 && ui === 'open' && !threadOpen && !staleOpen) return 'tucked';
  return ui === 'hidden' ? 'tucked' : null;
}

// After the calls area changed. → 'open' | 'tucked' | null.
//   Only a call ringing NOW opens the tray (a backfilled one joins quietly); the last
//   call going away folds it when nothing else waits and nothing is being read.
export function uiAfterCallChange({ added, ringing, calls, ui, threadOpen, staleOpen, mode, fbWaiting } = {}) {
  if (added && ringing) return 'open';
  if (!calls && ui === 'open' && !threadOpen && !staleOpen && mode === 'ok' && !fbWaiting) return 'tucked';
  return null;
}

// A background redraw (realtime, the catch-up load, the 5 s call tick) waits while
// someone has KEYBOARD focus on a row — a click's focus doesn't hold it.
export function deferListRedraw({ background, focusInList, focusVisible } = {}) {
  return !!(background && focusInList && focusVisible);
}
