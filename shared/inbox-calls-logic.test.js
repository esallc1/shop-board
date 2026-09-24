/* ============================================================
   inbox-calls-logic.test.js — incoming calls in the Inbox tray (slice 1).
   Run: npm test   (node --test)

   Locks: the 2-minute ringing window; which card gets the pinned ringing slot;
   row names + status; the strip count; and (static) that the floating card
   stack is GONE, the card is handed to the tray, the card's writes are
   untouched, the dry-run hook survives, and the tray never hides a call.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RING_MS, ringStartMs, isRinging, pickRinging, orderNewestFirst, orderNeedsHandling, callRowName, callRowStatus, stripCalls, callerGlance,
} from './inbox-calls-logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), 'utf8');
const NOW = Date.parse('2026-09-24T17:00:00Z');

test('ringing window: 2 minutes from the call start; a card with no real start rings from when it arrived', () => {
  assert.equal(RING_MS, 120000);
  assert.equal(ringStartMs({ started_at: '2026-09-24T16:59:30Z' }, NOW), NOW - 30000);
  assert.equal(ringStartMs({}, NOW), NOW, 'dry-run card');
  assert.equal(ringStartMs({ started_at: 'nope' }, NOW), NOW);
  assert.equal(ringStartMs({ started_at: '2026-09-24T17:30:00Z' }, NOW), NOW, 'a start far in the future is not trusted');
  assert.equal(isRinging(NOW - 119000, NOW), true);
  assert.equal(isRinging(NOW - 121000, NOW), false);
  assert.equal(isRinging(0, NOW), false);
  // A backfilled call from 10 minutes ago never rings — it's straight a row.
  assert.equal(isRinging(ringStartMs({ started_at: '2026-09-24T16:50:00Z' }, NOW), NOW), false);
});

test('the pinned slot = the NEWEST ringing call, never the one opened in the detail view', () => {
  const e = (id, agoS, inDetail = false) => ({ id, startMs: NOW - agoS * 1000, inDetail });
  assert.equal(pickRinging([e('a', 90), e('b', 10), e('c', 60)], NOW), 'b');
  assert.equal(pickRinging([e('a', 90), e('b', 10, true)], NOW), 'a');
  assert.equal(pickRinging([e('a', 300), e('b', 200)], NOW), null, 'nothing rings any more');
  assert.equal(pickRinging(null, NOW), null);
  assert.deepEqual(orderNewestFirst([e('a', 90), e('b', 10), e('c', 60)]).map((x) => x.id), ['b', 'c', 'a']);
});

test('rows: customer name > caller ID name > number; status says ringing / needs handling / noted', () => {
  assert.equal(callRowName({ customerName: ' JOSE RAMIREZ ', cnam: 'WIRELESS CALLER', number: '(239) 555-0112' }), 'JOSE RAMIREZ');
  assert.equal(callRowName({ cnam: 'SMITH DALE', number: '(239) 555-0112' }), 'SMITH DALE');
  assert.equal(callRowName({ number: '(239) 555-0112' }), '(239) 555-0112');
  assert.equal(callRowName({}), '(unknown number)');
  assert.equal(callRowStatus({ source: 'Direct', ringing: true }), 'Direct · ringing');
  assert.equal(callRowStatus({ source: 'Facebook' }), 'Facebook · no note yet');
  assert.equal(callRowStatus({ noted: true }), 'noted — close it when done');
  assert.deepEqual(stripCalls([{ startMs: NOW - 5000 }, { startMs: NOW - 500000 }], NOW), { count: 2, ringing: true });
  assert.deepEqual(stripCalls([], NOW), { count: 0, ringing: false });
});

test('static: the floating card stack is GONE; the card is handed to the tray; its writes and the dry-run hook are untouched', () => {
  const board = src('../advisor-board.html');
  assert.doesNotMatch(board, /<div id="callCardStack"/, 'no floating stack element');
  assert.doesNotMatch(board, /#callCardStack\s*\{/, 'no floating stack CSS');
  assert.doesNotMatch(board, /z-index:\s*4000/, 'nothing at z 4000 any more');
  const cc = board.slice(board.indexOf('(function callerCard()'), board.indexOf('window.cdBackfillCalls = backfillRecentCalls;'));
  assert.match(cc, /function placeCard\(card\) \{\s*if \(window\.cdCallInbox && typeof window\.cdCallInbox\.add === 'function'\) window\.cdCallInbox\.add\(card\);\s*else pendingCards\.push\(card\);/);
  assert.match(cc, /placeCard\(card\);/);
  assert.match(cc, /if \(hasCard\(call\.ctm_call_id\)\) return;/, 'still one card per call');
  assert.match(cc, /window\.cdHandleTestCall = handleNewCall;/, 'dry-run hook kept');
  // Same writes as before (temporary until the security slice): direct calls updates from saveNote / persistCustomer.
  assert.match(cc, /await db\.from\('calls'\)\.update\(p\)\.eq\('id', id\);/);
  assert.match(cc, /await db\.from\('calls'\)\.update\(\{ customer_id: customerId \}\)\.eq\('id', id\);/);
  assert.doesNotMatch(cc.replace(/\/\/.*$/gm, ''), /resolved_at\s*:/, 'the card still never WRITES resolved_at (it only reads it in the backfill)');
});

test('static: the tray mounts the calls area, takes queued cards, opens on a call and never hides one', () => {
  const tray = src('messenger-tray.js');
  assert.match(tray, /import \{ mountCallSlot \} from '\.\/inbox-calls\.js';/);
  assert.match(tray, /window\.cdCallInbox = \{ add: \(card\) => callSlot\.add\(card\)/);
  assert.match(tray, /window\.cdCallInboxPending\.splice\(0\)/);
  assert.match(tray, /if \(added\) setUi\('open'\);/, 'a new call opens the tray (from hidden or tucked)');
  assert.match(tray, /if \(calls\(\)\) \{ if \(st\.ui === 'hidden'\) setUi\('tucked'\); return; \}/, 'never hidden while a call is here');
  // Default = the folded strip; nothing waiting → fold back to it (never 'hidden' after the first load).
  assert.doesNotMatch(tray, /setUi\('hidden'\)/);
  assert.match(tray, /if \(!\(st\.ui === 'open' && st\.openThreadId\)\) setUi\('tucked'\);\s*\/\/ nothing waiting → fold to the strip/);
  assert.match(tray, /document\.body\.classList\.toggle\('mtray-tucked', ui === 'tucked'\)/, 'the strip pushes the board');
  assert.match(tray, /class="mtray-ph"/, 'phone badge on the strip');
  assert.match(tray, /<div class="mtray-title">Inbox<small><\/small><\/div>/);
  // The calls area is NOT inside the redrawn Facebook body (cards must never be re-drawn).
  assert.match(tray, /<div class="mtray-calls" hidden><\/div>\s*<div class="mtray-body"><\/div>/);
  const slot = src('inbox-calls.js');
  assert.doesNotMatch(slot.replace(/\/\*[\s\S]*?\*\//g, ''), /\bdb\b|\.from\(|fetch\(|cdAuthFetch/, 'the calls area reads and writes nothing');
  assert.match(slot, /if \(!e\.inDetail && e\.card\.parentElement !== store && !hasFocus\(e\.card\)\) store\.appendChild\(e\.card\);/, 'never moves a card someone is typing in');
  const css = src('messenger-tray.css');
  assert.doesNotMatch(css, /z-index:\s*(3\d{3}|[4-9]\d{3})/, 'the tray stays at 2900');
});

test('the pinned slot skips a call someone already opened (answered); "Needs handling" = NO NOTE YET on top, then noted', () => {
  const e = (id, agoS, extra = {}) => ({ id, startMs: NOW - agoS * 1000, ...extra });
  assert.equal(pickRinging([e('a', 30, { answered: true }), e('b', 60)], NOW), 'b');
  assert.equal(pickRinging([e('a', 30, { answered: true })], NOW), null);
  const order = orderNeedsHandling([e('n1', 100, { noted: true }), e('u1', 900), e('n2', 50, { noted: true }), e('u2', 300)]);
  assert.deepEqual(order.map((x) => x.id), ['u2', 'u1', 'n2', 'n1']);
});

test('the ringing glance (screen 1): name, phone, vehicle, In shop now, Last visit, one Heads-up line', () => {
  const ros = [
    { ro_number: 6089, status: 'ro', created_at: '2026-09-20', vehicles: { year: 2014, make: 'Ford', model: 'F-250' } },
    { ro_number: 5890, status: 'closed', created_at: '2026-03-01', closed_at: '2026-03-03T15:00:00Z', vehicles: { year: 2014, make: 'Ford', model: 'F-250' } },
    { ro_number: 6062, status: 'estimate', declined_at: '2026-09-01', created_at: '2026-09-01' },
  ];
  const g = callerGlance({ number: '(239) 555-0112', source: 'Direct', state: 'matched', customer: { id: 'c1', name: 'DALE HOOPER' },
    vehicles: [{ year: 2014, make: 'Ford', model: 'F-250' }], ros });
  assert.equal(g.who, 'DALE HOOPER');
  assert.equal(g.tag, 'Returning');
  assert.equal(g.vehicle, '2014 Ford F-250');
  assert.equal(g.inShop, 'RO #6089 · 2014 Ford F-250 · Active RO');
  assert.equal(g.lastVisit, 'Mar 3 · RO #5890 · 2014 Ford F-250');
  assert.equal(g.headsUp, 'Declined estimate #6062');
  assert.equal(g.customerId, 'c1');
  const n = callerGlance({ call: { cnam: 'WIRELESS CALLER' }, number: '(239) 555-0199', state: 'new' });
  assert.deepEqual([n.who, n.sub, n.tag, n.inShop], ['New caller', 'WIRELESS CALLER', 'New', '']);
  assert.equal(callerGlance({ number: 'x', state: 'loading' }).sub, 'Looking up…');
  assert.match(callerGlance({ number: 'x', state: 'multi' }).sub, /pick one/);
  const quiet = callerGlance({ state: 'matched', customer: { name: 'A', last_invoiced: '2026-08-02T12:00:00Z' }, ros: [] });
  assert.deepEqual([quiet.tag, quiet.inShop, quiet.lastVisit, quiet.headsUp], ['Customer', '', 'Aug 2', '']);
});

test('static: a call with no note can NOT be closed (× / Close); today\'s untouched calls come back after a reload', () => {
  const board = src('../advisor-board.html');
  const cc = board.slice(board.indexOf('(function callerCard()'), board.indexOf('window.cdBackfillCalls = backfillRecentCalls;'));
  assert.match(cc, /function tryClose\(card\) \{\s*if \(!card\._noted\) \{/);
  assert.match(cc, /querySelector\('\.call-card-x'\)\.addEventListener\('click', \(\) => tryClose\(card\)\)/);
  assert.match(cc, /saveIfChanged\(\); tryClose\(card\); \}\);/);
  assert.doesNotMatch(cc, /dismissedCardIds\.add\(card\.dataset\.callId\); card\.remove\(\); \}\);/, 'no unguarded close left');
  assert.match(cc, /const today = new Date\(\); today\.setHours\(0, 0, 0, 0\);/, 'backfill = today');
  assert.match(cc, /\.is\('noted_at', null\)/, 'untouched = never noted');
  assert.match(cc, /const BACKFILL_MAX = 25;/);
  // Next step: Call back · Coming in · Done (coming); the two old chips only when a call already has them.
  assert.match(cc, /\{ key: 'quoted_callback',\s+label: 'Call back' \}/);
  assert.match(cc, /\{ key: 'dropping_off',\s+label: 'Coming in' \}/);
  assert.match(cc, /data-legacy="1" hidden/);
  assert.match(cc, /class="cc-soon" disabled[^>]*>Done <small>coming<\/small>/);
  assert.match(cc, />Attach… <small>coming<\/small>/);
  assert.match(cc, />Start RO <small>coming<\/small>/);
  assert.match(cc, />Not a customer <small>coming<\/small>/);
  // The recording: through the signed-in endpoint, pending until ready.
  assert.match(cc, /cdAuthFetch\(db, '\/api\/recording-links'/);
  assert.match(cc, /arrives a few minutes after the call ends/);
});
