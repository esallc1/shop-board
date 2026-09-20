/* Tests for the Desk "Coming in" / calendar display rules.

   The bug these lock down: a drop-off disappeared the moment its date passed,
   an undated one was never shown at all, the calendar never received past
   items (so "‹ Previous week" was always blank), and the overdue badge
   counted callbacks only. Prod audit 2026-09-20: 16 past-due + 3 undated rows
   invisible. See shared/desk-appointments.js.

   TIMEZONE. Every date here is built with the LOCAL Date constructor
   (new Date(y, m, d, ...)) and compared against a LOCAL `now`, so the suite
   gives the same answer in any TZ — the same frame the board renders in.
   The only shop-time (America/New_York) rule is the recovered cutoff, which
   goes through new-badge's shopToday; those cases use midday UTC stamps that
   land on the same calendar day in ET and UTC alike. */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RECOVERED_CUTOFF, RECOVERED_UNTIL, RECOVERED_TAG, RECOVERED_BANNER,
  isOverdueDue, splitComingIn, comingInOrder, calendarItems, overdueCount,
  isRecovered, recoveryNoticeVisible, showRecoveryBanner,
} from './desk-appointments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = readFileSync(join(root, 'advisor-board.html'), 'utf8');

// A local-time moment, so tests never depend on the runner's TZ.
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);
const iso = (...a) => at(...a).toISOString();

// now = Thursday 2026-09-24, 10:00 local.
const NOW = at(2026, 9, 24, 10, 0);

const drop = (o) => Object.assign({ id: 1, next_step: 'dropping_off', due_all_day: true, noted_at: iso(2026, 9, 1, 9, 0) }, o);
const callback = (o) => Object.assign({ id: 9, next_step: 'quoted_callback', due_all_day: true, noted_at: iso(2026, 9, 1, 9, 0) }, o);

// ── isOverdueDue: the ONE rule both lanes share ──────────────────────
test('all-day item is not late until its day is past', () => {
  assert.equal(isOverdueDue(iso(2026, 9, 24, 12), true, NOW), false, 'today');
  assert.equal(isOverdueDue(iso(2026, 9, 25, 12), true, NOW), false, 'tomorrow');
  assert.equal(isOverdueDue(iso(2026, 9, 23, 12), true, NOW), true, 'yesterday');
});

test('timed item uses the clock, not the day', () => {
  assert.equal(isOverdueDue(iso(2026, 9, 24, 9, 0), false, NOW), true, '9am, now 10am');
  assert.equal(isOverdueDue(iso(2026, 9, 24, 11, 0), false, NOW), false, '11am, now 10am');
});

test('no date and garbage dates are NOT overdue (they are undated)', () => {
  assert.equal(isOverdueDue(null, true, NOW), false);
  assert.equal(isOverdueDue(undefined, false, NOW), false);
  assert.equal(isOverdueDue('', true, NOW), false);
  assert.equal(isOverdueDue('not a date', true, NOW), false);
});

// ── splitComingIn / comingInOrder ────────────────────────────────────
test('past-due drop-offs are kept, not dropped — the whole bug', () => {
  const calls = [drop({ id: 1, due_at: iso(2026, 8, 4, 12) })];
  const { overdue, upcoming, undated } = splitComingIn(calls, NOW);
  assert.deepEqual(overdue.map(c => c.id), [1]);
  assert.deepEqual(upcoming, []);
  assert.deepEqual(undated, []);
});

test('undated drop-offs are kept too', () => {
  const { undated } = splitComingIn([drop({ id: 7, due_at: null })], NOW);
  assert.deepEqual(undated.map(c => c.id), [7]);
});

test('an unparseable due_at is treated as undated, never dropped', () => {
  const { undated, overdue, upcoming } = splitComingIn([drop({ id: 8, due_at: 'garbage' })], NOW);
  assert.deepEqual(undated.map(c => c.id), [8]);
  assert.deepEqual(overdue.concat(upcoming), []);
});

test('lane order: overdue (oldest first), then undated, then upcoming (soonest first)', () => {
  const calls = [
    drop({ id: 'up-late', due_at: iso(2026, 10, 5, 12) }),
    drop({ id: 'od-new', due_at: iso(2026, 9, 18, 12) }),
    drop({ id: 'undated-b', due_at: null, noted_at: iso(2026, 9, 12, 9) }),
    drop({ id: 'od-old', due_at: iso(2026, 8, 4, 12) }),
    drop({ id: 'up-soon', due_at: iso(2026, 9, 25, 12) }),
    drop({ id: 'undated-a', due_at: null, noted_at: iso(2026, 8, 6, 9) }),
  ];
  assert.deepEqual(
    comingInOrder(calls, NOW).map(c => c.id),
    ['od-old', 'od-new', 'undated-a', 'undated-b', 'up-soon', 'up-late'],
  );
});

test('callbacks and resolved rows never enter the Coming-in lane', () => {
  const calls = [
    callback({ id: 'cb', due_at: iso(2026, 8, 1, 12) }),
    drop({ id: 'resolved', due_at: iso(2026, 8, 1, 12), resolved_at: iso(2026, 8, 2, 12) }),
    drop({ id: 'keep', due_at: iso(2026, 8, 1, 12) }),
  ];
  assert.deepEqual(comingInOrder(calls, NOW).map(c => c.id), ['keep']);
});

test('empty / null input is safe', () => {
  assert.deepEqual(comingInOrder(null, NOW), []);
  assert.deepEqual(comingInOrder([], NOW), []);
  assert.deepEqual(comingInOrder([null, undefined, {}], NOW), []);
});

// ── calendarItems ────────────────────────────────────────────────────
test('calendar receives PAST drop-offs, so previous weeks draw', () => {
  const calls = [
    drop({ id: 'past', due_at: iso(2026, 8, 4, 12) }),
    drop({ id: 'future', due_at: iso(2026, 9, 28, 12) }),
  ];
  assert.deepEqual(calendarItems(calls).map(c => c.id).sort(), ['future', 'past']);
});

test('calendar leaves out undated rows (no slot) and resolved rows', () => {
  const calls = [
    drop({ id: 'undated', due_at: null }),
    drop({ id: 'bad', due_at: 'garbage' }),
    drop({ id: 'resolved', due_at: iso(2026, 8, 4, 12), resolved_at: iso(2026, 8, 5, 12) }),
    drop({ id: 'ok', due_at: iso(2026, 8, 4, 12) }),
  ];
  assert.deepEqual(calendarItems(calls).map(c => c.id), ['ok']);
});

// ── overdueCount ─────────────────────────────────────────────────────
test('overdue count includes drop-offs, not just callbacks', () => {
  const calls = [
    callback({ id: 1, due_at: iso(2026, 9, 20, 12) }),   // late callback
    drop({ id: 2, due_at: iso(2026, 9, 18, 12) }),       // late drop-off
    drop({ id: 3, due_at: iso(2026, 9, 28, 12) }),       // upcoming
    drop({ id: 4, due_at: null }),                       // undated — not late
  ];
  assert.equal(overdueCount(calls, NOW), 2);
});

test('overdue count ignores resolved rows and other next_steps', () => {
  const calls = [
    drop({ id: 1, due_at: iso(2026, 9, 1, 12), resolved_at: iso(2026, 9, 2, 12) }),
    { id: 2, next_step: 'price_shopper', due_at: iso(2026, 9, 1, 12), due_all_day: true },
  ];
  assert.equal(overdueCount(calls, NOW), 0);
});

// ── the recovered rule ───────────────────────────────────────────────
// Midday UTC so the ET and UTC calendar days agree, keeping these TZ-proof.
const day = (s) => `${s}T15:00:00.000Z`;

test('booked before the cutoff and dated before it → recovered', () => {
  assert.equal(isRecovered(drop({ noted_at: day('2026-08-12'), due_at: day('2026-08-19') })), true);
});

test('booked before the cutoff with no date → recovered', () => {
  assert.equal(isRecovered(drop({ noted_at: day('2026-08-06'), due_at: null })), true);
});

test('booked AFTER the cutoff → just normally overdue, no tag', () => {
  assert.equal(isRecovered(drop({ noted_at: day('2026-09-22'), due_at: day('2026-09-23') })), false);
  assert.equal(isRecovered(drop({ noted_at: day('2026-09-22'), due_at: null })), false);
});

test('booked before the cutoff but dated after it → not recovered (it was always visible)', () => {
  assert.equal(isRecovered(drop({ noted_at: day('2026-09-08'), due_at: day('2026-09-28') })), false);
});

test('the cutoff day itself is not "before" it', () => {
  assert.equal(isRecovered(drop({ noted_at: day(RECOVERED_CUTOFF), due_at: null })), false);
});

test('recovered needs a noted_at, and never applies to callbacks or resolved rows', () => {
  assert.equal(isRecovered(drop({ noted_at: null, due_at: day('2026-08-01') })), false);
  assert.equal(isRecovered(callback({ noted_at: day('2026-08-01'), due_at: day('2026-08-02') })), false);
  assert.equal(isRecovered(drop({ noted_at: day('2026-08-01'), due_at: day('2026-08-02'), resolved_at: day('2026-08-03') })), false);
  assert.equal(isRecovered(null), false);
});

// ── expiry + banner ──────────────────────────────────────────────────
test('the notice is visible before RECOVERED_UNTIL and gone on/after it', () => {
  assert.equal(recoveryNoticeVisible(new Date('2026-09-21T16:00:00Z')), true);
  assert.equal(recoveryNoticeVisible(new Date('2026-10-04T16:00:00Z')), true, 'last day');
  assert.equal(recoveryNoticeVisible(new Date(`${RECOVERED_UNTIL}T16:00:00Z`)), false, 'the until day itself');
  assert.equal(recoveryNoticeVisible(new Date('2026-11-01T16:00:00Z')), false);
});

test('banner shows only while a recovered row is still sitting unresolved', () => {
  const inWindow = new Date('2026-09-24T16:00:00Z');
  const recovered = drop({ noted_at: day('2026-08-12'), due_at: day('2026-08-19') });
  const fresh = drop({ id: 2, noted_at: day('2026-09-23'), due_at: day('2026-09-23') });

  assert.equal(showRecoveryBanner([recovered], inWindow), true);
  assert.equal(showRecoveryBanner([fresh], inWindow), false, 'only post-cutoff rows left');
  assert.equal(showRecoveryBanner([], inWindow), false, 'pile cleared → banner gone early');
  assert.equal(showRecoveryBanner([recovered], new Date('2026-11-01T16:00:00Z')), false, 'window closed');
});

test('the notice wording is the agreed copy and says nothing new broke', () => {
  assert.match(RECOVERED_TAG, /^Recovered — this was hidden by a display bug\./);
  assert.match(RECOVERED_BANNER, /nothing new broke/);
  assert.match(RECOVERED_BANNER, /^Old drop-offs are back\./);
});

// ── the board is actually wired to these rules ───────────────────────
test('board loads the module and exposes it as window.DeskAppointments', () => {
  assert.match(BOARD, /import \* as DeskAppointments from '\.\/shared\/desk-appointments\.js'/);
  assert.match(BOARD, /window\.DeskAppointments = DeskAppointments/);
});

test('board has NO copy of the old today-onward drop-off filter left', () => {
  // The lane and all three week-nav handlers inlined this same filter; every
  // one of them is why a past drop-off vanished. Only the two explicit
  // no-module fallbacks may still contain it.
  const hits = BOARD.match(/next_step === 'dropping_off' && c\.due_at && new Date\(c\.due_at\) >= (startOfToday\(\)|today)/g) || [];
  assert.equal(hits.length, 2, `expected only the 2 fallbacks, found ${hits.length}`);
  assert.ok(!/renderCalendar\(lastData\.calls\.filter\(/.test(BOARD), 'a week-nav handler still filters before the calendar');
});

test('board renders the lane, the badge and the calendar through the shared rules', () => {
  assert.match(BOARD, /mod\.comingInOrder\(calls, new Date\(\)\)/, 'lane order');
  assert.match(BOARD, /mod\.overdueCount\(calls, new Date\(\)\)/, 'overdue badge counts drop-offs');
  assert.match(BOARD, /renderCalendar\(calendarFeed\(\)\)/, 'calendar fed past + future');
  assert.match(BOARD, /mod\.calendarItems\(calls\)/, 'calendarFeed uses the shared rule');
  assert.equal((BOARD.match(/renderCalendar\(calendarFeed\(\)\)/g) || []).length, 4, 'all 4 call sites');
});

test('board shows the recovered banner + per-row tag and marks past chips', () => {
  assert.match(BOARD, /mod\.showRecoveryBanner\(calls, new Date\(\)\)/);
  assert.match(BOARD, /desk-recovered-banner/);
  assert.match(BOARD, /desk-recovered-tag/);
  assert.match(BOARD, /mod\.isRecovered\(c\)/);
  assert.match(BOARD, /\.desk-row\.is-overdue \{[^}]*var\(--red\)/, 'overdue rows get the red edge');
  assert.match(BOARD, /\.desk-chip\.is-past \{[^}]*var\(--red\)/, 'past chips look overdue');
});
