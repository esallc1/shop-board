/* ============================================================
   inbox-list-logic.test.js — the Inbox tray's ONE "Needs handling" list
   (slice 2a, Cris 2026-09-25, option B) + the badge / fold / auto-open rules,
   locked so the merge changes nothing else. Wiring: docs/wiring/inbox-calls.md §3.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isStaffReply, lastStaffReplyByThread, fbNeedsFirstResponse, mergeNeedsHandling,
  waitingCount, stripBadges, uiAfterLoad, uiAfterCallChange, deferListRedraw,
} from './inbox-list-logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), 'utf8');
const NOW = Date.parse('2026-09-25T15:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

/* ── who spoke last ─────────────────────────────────────────────────────── */

test('a staff reply = outgoing, not the auto-reply, not a failed send (a reply from the Facebook app counts)', () => {
  assert.equal(isStaffReply({ direction: 'out', source: 'crisdata', send_status: 'sent' }), true);
  assert.equal(isStaffReply({ direction: 'out', source: 'page_inbox', send_status: null }), true);
  assert.equal(isStaffReply({ direction: 'out', auto: true, send_status: 'sent' }), false);
  assert.equal(isStaffReply({ direction: 'out', send_status: 'failed' }), false);
  assert.equal(isStaffReply({ direction: 'in' }), false);
  assert.equal(isStaffReply(null), false);
});

test('newest staff reply per thread; the customer spoke last when nothing answered their last ARRIVED message', () => {
  const last = lastStaffReplyByThread([
    { thread_id: 'a', direction: 'out', sent_at: iso(30) },
    { thread_id: 'a', direction: 'out', sent_at: iso(10) },
    { thread_id: 'a', direction: 'out', auto: true, sent_at: iso(1) },         // auto → ignored
    { thread_id: 'b', direction: 'in', sent_at: iso(5) },
    { thread_id: 'c', direction: 'out', send_status: 'failed', sent_at: iso(2) }, // failed → ignored
  ]);
  assert.deepEqual(last, { a: NOW - 10 * 60000 });
  assert.equal(fbNeedsFirstResponse({ last_inbound_at: iso(20) }, last.a), false, 'we replied after');
  assert.equal(fbNeedsFirstResponse({ last_inbound_at: iso(5) }, last.a), true, 'they wrote again after our reply');
  assert.equal(fbNeedsFirstResponse({ last_inbound_at: iso(5) }, undefined), true, 'never answered');
  // Arrival wins: sent before our reply (Meta clock), delivered after it → still unanswered.
  assert.equal(fbNeedsFirstResponse({ last_inbound_at: iso(15), last_inbound_received_at: iso(8) }, last.a), true);
  assert.equal(fbNeedsFirstResponse({ last_inbound_at: null }, null), false, 'nothing from them');
});

/* ── the mixed order (option B) ─────────────────────────────────────────── */

test('ONE list: nobody-answered-yet on top (no-note calls + customer-spoke-last threads), newest first; then the rest, newest first', () => {
  const calls = [
    { id: '11', startMs: NOW - 40 * 60000, noted: false },   // un-noted, 40 m
    { id: '12', startMs: NOW - 2 * 60000, noted: true },     // noted, 2 m
    { id: '13', startMs: NOW - 90 * 60000, noted: true },    // noted, 90 m
  ];
  const threads = [
    { id: 'fbQ', last_inbound_at: iso(10), last_inbound_received_at: iso(10), last_message_at: iso(10) }, // customer spoke last, 10 m
    { id: 'fbR', last_inbound_at: iso(60), last_inbound_received_at: iso(60), last_message_at: iso(1) },  // we replied 1 m ago
    { id: 'fbA', last_inbound_at: iso(5), last_message_at: iso(4) },                                      // only the auto-reply after
  ];
  const lastStaff = lastStaffReplyByThread([
    { thread_id: 'fbR', direction: 'out', sent_at: iso(1) },
    { thread_id: 'fbA', direction: 'out', auto: true, sent_at: iso(4) },
  ]);
  const order = mergeNeedsHandling({ calls, threads, lastStaff });
  assert.deepEqual(order.map((x) => `${x.kind}:${x.id}`), [
    'fb:fbA',   // unanswered, 5 m (the auto-reply is not an answer)
    'fb:fbQ',   // unanswered, 10 m
    'call:11',  // no note, 40 m
    'call:12',  // noted, 2 m
    'fb:fbR',   // answered — sorted by THEIR message (60 m), not our reply 1 m ago
    'call:13',  // noted, 90 m
  ]);
  assert.deepEqual(order.map((x) => x.fresh), [true, true, true, false, false, false]);
  assert.equal(order.find((x) => x.id === 'fbR').ms, NOW - 60 * 60000, 'our own reply never makes a thread newer');
  assert.equal(order[2].ref, calls[0], 'the call row object is passed through untouched (it carries its html)');
  assert.deepEqual(calls.map((c) => c.id), ['11', '12', '13'], 'input untouched');
});

test('calls alone keep the slice-1 order (no note on top, newest first each); ties are deterministic', () => {
  const e = (id, agoS, noted) => ({ id, startMs: NOW - agoS * 1000, noted });
  const order = mergeNeedsHandling({ calls: [e('n1', 100, true), e('u1', 900, false), e('n2', 50, true), e('u2', 300, false)] });
  assert.deepEqual(order.map((x) => x.id), ['u2', 'u1', 'n2', 'n1']);
  const tie = mergeNeedsHandling({
    calls: [{ id: '9', startMs: NOW, noted: false }],
    threads: [{ id: 't', last_inbound_at: new Date(NOW).toISOString() }],
  });
  assert.deepEqual(tie.map((x) => x.kind), ['call', 'fb'], 'same minute → the call first');
  assert.deepEqual(mergeNeedsHandling({}), []);
  assert.deepEqual(mergeNeedsHandling({ calls: null, threads: [null] }), []);
});

/* ── badges + "N waiting" — exactly as slice 1 ──────────────────────────── */

test('badges: 📞 = every call card on this board (noted-not-closed included), pulses only for an unopened ring; f = threads you can still reply to', () => {
  const b = stripBadges({ mode: 'ok', fbActive: 2, calls: { count: 3, ringing: true } });
  assert.deepEqual(b.phone, { count: 3, ringing: true, missed: false, off: false, hidden: false, text: '3' });
  assert.deepEqual(b.fb, { text: '2', hidden: false, off: false, note: false });
  const none = stripBadges({ mode: 'ok', fbActive: 0, calls: { count: 0, ringing: false } });
  assert.deepEqual([none.phone.off, none.phone.hidden, none.fb.off, none.fb.hidden], [true, true, true, true]);
  // Facebook not readable → "!" and the f's grey state is left alone; calls still count.
  for (const mode of ['signin', 'notstaff', 'error', 'loading']) {
    const x = stripBadges({ mode, fbActive: 5, calls: { count: 1, ringing: false } });
    assert.deepEqual(x.fb, { text: '!', hidden: false, off: null, note: true }, mode);
    assert.equal(x.phone.count, 1);
  }
  assert.equal(waitingCount({ mode: 'ok', fbActive: 2, calls: 3 }), 5);
  assert.equal(waitingCount({ mode: 'error', fbActive: 2, calls: 3 }), 3, 'Facebook only counts when it loaded fine');
  assert.equal(waitingCount({ mode: 'signin', fbActive: 0, calls: 0 }), 0);
});

test('the tray feeds the badges the same numbers as slice 1: callSlot.strip() and the ACTIVE threads (past-24 h never)', () => {
  const tray = src('messenger-tray.js');
  assert.match(tray, /const c = callSlot \? callSlot\.strip\(\) : \{ count: 0, ringing: false \};\s*const b = stripBadges\(\{ mode: st\.mode, fbActive: st\.waiting\.length, calls: c \}\);/);
  assert.match(tray, /\(\{ active: st\.waiting, stale: st\.stale \} = splitWaiting\(st\.threads\)\);/);
  const slot = src('inbox-calls.js');
  assert.match(slot, /return \{ count: list\.length, ringing: stripCalls\(list\.filter\(\(e\) => !e\.answered\)\)\.ringing, missed: stripCalls\(list\)\.missed \};/, 'every card counts; only an unopened one pulses; a missed one turns it red');
});

/* ── fold / auto-open — exactly as slice 1 ──────────────────────────────── */

test('after a Facebook load: never opens on the first load, opens for a newly arrived message, folds when the last item is handled', () => {
  const base = { mode: 'ok', loadedOnce: true, loadedOnceBefore: true, ui: 'tucked', count: 1, before: 1, newInbound: false, threadOpen: false, staleOpen: false };
  // First load (page load / new tab): folded, even with things waiting or a "new" message.
  assert.equal(uiAfterLoad({ ...base, ui: 'hidden', loadedOnceBefore: false, count: 4, newInbound: true }), 'tucked');
  assert.equal(uiAfterLoad({ ...base, ui: 'tucked', loadedOnceBefore: false, newInbound: true }), null);
  // Sign-in / permission / first-load error → the strip, never open.
  for (const mode of ['signin', 'notstaff']) {
    assert.equal(uiAfterLoad({ ...base, mode, ui: 'hidden' }), 'tucked');
    assert.equal(uiAfterLoad({ ...base, mode, newInbound: true }), null);
  }
  assert.equal(uiAfterLoad({ ...base, mode: 'error', loadedOnce: false, ui: 'hidden' }), 'tucked');
  // A message that just arrived → open (from the strip).
  assert.equal(uiAfterLoad({ ...base, newInbound: true }), 'open');
  // Count dropped to 0 while open → fold; not while a conversation or "Can't reply anymore" is open.
  assert.equal(uiAfterLoad({ ...base, ui: 'open', count: 0, before: 2 }), 'tucked');
  assert.equal(uiAfterLoad({ ...base, ui: 'open', count: 0, before: 2, threadOpen: true }), null);
  assert.equal(uiAfterLoad({ ...base, ui: 'open', count: 0, before: 2, staleOpen: true }), null);
  // Opened from the strip with nothing waiting (0 → 0) → stays open. No change otherwise (no flicker).
  assert.equal(uiAfterLoad({ ...base, ui: 'open', count: 0, before: 0 }), null);
  assert.equal(uiAfterLoad({ ...base, ui: 'open', count: 3, before: 2 }), null);
  assert.equal(uiAfterLoad({ ...base, ui: 'tucked', count: 3, before: 2 }), null);
});

test('after the calls area changed: only a call ringing NOW opens; the last call leaving folds only when nothing else waits', () => {
  const base = { added: false, ringing: false, calls: 0, ui: 'open', threadOpen: false, staleOpen: false, mode: 'ok', fbWaiting: 0 };
  assert.equal(uiAfterCallChange({ ...base, ui: 'tucked', added: true, ringing: true, calls: 1 }), 'open');
  assert.equal(uiAfterCallChange({ ...base, ui: 'tucked', added: true, ringing: false, calls: 1 }), null, 'a backfilled call joins quietly');
  assert.equal(uiAfterCallChange(base), 'tucked');
  assert.equal(uiAfterCallChange({ ...base, fbWaiting: 1 }), null);
  assert.equal(uiAfterCallChange({ ...base, threadOpen: true }), null);
  assert.equal(uiAfterCallChange({ ...base, staleOpen: true }), null);
  assert.equal(uiAfterCallChange({ ...base, mode: 'signin' }), null);
  assert.equal(uiAfterCallChange({ ...base, calls: 1 }), null);
  assert.equal(uiAfterCallChange({ ...base, ui: 'tucked' }), null, 'already folded → nothing to do (no flicker on the 5 s tick)');
});

/* ── one draw path; keyboard focus holds a background redraw ────────────── */

test('a background redraw waits only while a row has KEYBOARD focus', () => {
  assert.equal(deferListRedraw({ background: true, focusInList: true, focusVisible: true }), true);
  assert.equal(deferListRedraw({ background: true, focusInList: true, focusVisible: false }), false, 'a mouse click leaves no hold');
  assert.equal(deferListRedraw({ background: false, focusInList: true, focusVisible: true }), false, 'a tap always draws');
  assert.equal(deferListRedraw({ background: true, focusInList: false, focusVisible: false }), false);
});

test('static: one list, one draw path — the calls area no longer paints rows; the tray merges and draws them', () => {
  const slot = src('inbox-calls.js');
  const tray = src('messenger-tray.js');
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(slot, /mtray-callrows/, 'no second list inside the calls area');
  assert.doesNotMatch(code(slot), /Needs handling/);
  assert.match(slot, /\.filter\(\(e\) => !e\.inDetail && e\.id !== pinnedId\)/, 'rows = not the pinned glance, not the opened card');
  assert.match(slot, /if \(html !== ringShown\) \{ ring\.innerHTML = html; ringShown = html; \}/, 'the glance is only re-painted when it changed');
  // The call cards are only ever MOVED (store / detail) — a row is a button that opens one.
  assert.match(slot, /class="mtray-row mtray-callrow[^"]*" data-call-row=/);
  assert.match(tray, /if \(callRow && body\.contains\(callRow\)\) \{ callSlot\.open\(callRow\.dataset\.callRow\); return; \}/);
  assert.match(tray, /const items = mergeNeedsHandling\(\{\s*calls: callSlot \? callSlot\.rows\(now\) : \[\],\s*threads: fbReady \? st\.waiting : \[\],/);
  assert.equal((code(tray).match(/<div class="mtray-sec">Needs handling<\/div>/g) || []).length, 1, 'one heading');
  // Only drawList and drawThread paint the body; the list only when it changed.
  assert.equal((code(tray).match(/body\.innerHTML\s*=/g) || []).length, 2);
  assert.match(tray, /if \(html !== st\.listShown \|\| body\.dataset\.thread\) \{ body\.innerHTML = html; st\.listShown = html; \}/);
  // Background sources: the Facebook load (realtime + catch-up) and the calls area (5 s tick, mutations); taps draw at once.
  assert.match(tray, /decideUi\(prevNewest\);\s*draw\(\{ background: true \}\);/);
  assert.match(tray, /draw\(\{ background: !user \}\);/);
  assert.match(slot, /onChange\(\{ user: true \}\)/);
  assert.match(tray, /if \(deferListRedraw\(\{ background, focusInList: f\.inList, focusVisible: f\.visible \}\)\) \{ st\.listDirty = true; return; \}/);
  assert.match(tray, /if \(st\.listDirty && !listFocusHeld\(\)\.inList\) draw\(\);/, 'the held redraw runs when focus leaves');
  // "Can't reply anymore" stays under the list and outside the merge (uncounted).
  assert.match(tray, /return html \+ staleHtml\(\);/);
  assert.doesNotMatch(tray, /threads: [^\n]*st\.stale/);
  // The old hide rules for a separate call list are gone.
  assert.doesNotMatch(src('messenger-tray.css'), /mtray-callrows/);
});

test('static: slice 2a adds no DB access and no write — the rules are pure; the calls area still reads/writes nothing', () => {
  const logic = src('inbox-list-logic.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(logic, /\bdb\b|\.from\(|fetch\(|document\.|window\./);
  const slot = src('inbox-calls.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(slot, /\bdb\b|\.from\(|fetch\(|cdAuthFetch/);
  const tray = src('messenger-tray.js');
  assert.match(tray, /\.select\('id, thread_id, direction, source, text, attachments, send_status, sent_at, auto'\)/, 'the same message read as before (who spoke last comes from it)');
});

/* ── Slice 4: order A — a missed call with no note above EVERYTHING ─────── */
test('order A: missed calls with no note on the very top (above unanswered FB threads), then the rest of the top group, then the rest', () => {
  const calls = [
    { id: 'm1', startMs: NOW - 50 * 60000, noted: false, missed: true },   // missed, 50 m ago
    { id: 'u1', startMs: NOW - 2 * 60000, noted: false, missed: false },   // answered, no note, 2 m
    { id: 'mN', startMs: NOW - 1 * 60000, noted: true, missed: true },     // missed but NOTED → normal noted group
    { id: 'm2', startMs: NOW - 90 * 60000, noted: false, missed: true },   // missed, 90 m
  ];
  const threads = [{ id: 'fbQ', last_inbound_at: iso(1), last_inbound_received_at: iso(1) }];   // customer spoke last, 1 m
  const order = mergeNeedsHandling({ calls, threads, lastStaff: {} });
  assert.deepEqual(order.map((x) => `${x.kind}:${x.id}`), [
    'call:m1', 'call:m2',         // missed + no note, newest first — above everything
    'fb:fbQ', 'call:u1',          // the rest of "nobody answered yet", newest first
    'call:mN',                    // noted
  ]);
  assert.deepEqual(order.map((x) => x.missed), [true, true, false, false, false]);
});

test('the 📞 badge turns red while a missed call has no note', () => {
  assert.equal(stripBadges({ mode: 'ok', fbActive: 0, calls: { count: 2, ringing: false, missed: true } }).phone.missed, true);
  assert.equal(stripBadges({ mode: 'ok', fbActive: 0, calls: { count: 2, ringing: false } }).phone.missed, false);
  assert.match(src('messenger-tray.js'), /strip\.classList\.toggle\('has-missed', b\.phone\.missed\);/);
  assert.match(src('messenger-tray.css'), /\.mtray-strip\.has-missed \.mtray-pcount \{ background: #dc2626;/);
});
