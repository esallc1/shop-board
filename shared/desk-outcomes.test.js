/* Tests for the Desk's four outcomes, the confirm, and undo.

   The bug being fixed: one destructive "Done" wrote resolved_at with no confirm,
   no undo and no record of what happened — 22 of 40 resolved prod appointments
   were cleared within 60s of being booked, by the booker. See desk-outcomes.js.

   The invariant these exist to defend: **follow_up must never resolve a row.** A
   lead who can't afford it this month is still a lead; resolving it is the same
   bug in a new coat.

   TIMEZONE: dates are built with the local Date constructor and compared against
   a local `now`, so the suite gives the same answer in any TZ — the frame the
   board renders in. */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OUTCOMES, DROPOFF_OUTCOMES, OUTCOME_LABEL, OUTCOME_SHORT, OUTCOME_NOTE_PLACEHOLDER,
  FOLLOW_UP_DEFAULT_DAYS, CLEARED_WINDOW_DAYS,
  isOutcome, clearsItem, outcomePatch, undoPatch,
  needsConfirm, confirmMessage,
  isRecentlyCleared, recentlyCleared, clearedLabel,
  callbackReason, defaultCallbackDate,
} from './desk-outcomes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = readFileSync(join(root, 'advisor-board.html'), 'utf8');
const SANDBOX_SQL = readFileSync(join(root, 'migrations/20260920_calls_outcome_SANDBOX.sql'), 'utf8');
const RENAME_SQL = readFileSync(join(root, 'migrations/20260920_calls_outcome_rename_SANDBOX.sql'), 'utf8');
const PROD_SQL = readFileSync(join(root, 'migrations/20260920_calls_outcome_PROD.sql'), 'utf8');

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);
const iso = (...a) => at(...a).toISOString();
const NOW = at(2026, 9, 24, 10, 0);            // Thu 2026-09-24, 10:00 local

const drop = (o) => Object.assign({ id: 1, next_step: 'dropping_off', due_all_day: true }, o);

// ── vocabulary ───────────────────────────────────────────────────────
test('exactly four outcomes, and the drop-off lane offers three of them', () => {
  assert.deepEqual(OUTCOMES, ['arrived', 'not_coming', 'follow_up', 'called']);
  assert.deepEqual(DROPOFF_OUTCOMES, ['arrived', 'not_coming', 'follow_up']);
  assert.ok(!DROPOFF_OUTCOMES.includes('called'), '"called" belongs to the Callbacks lane');
  for (const o of OUTCOMES) {
    assert.ok(OUTCOME_LABEL[o], `${o} needs a full label`);
    assert.ok(OUTCOME_SHORT[o], `${o} needs a button label`);
  }
  assert.equal(isOutcome('banana'), false);
  assert.equal(isOutcome(null), false);
});

test('THE INVARIANT: follow_up does not clear; the other three do', () => {
  assert.equal(clearsItem('follow_up'), false);
  assert.equal(clearsItem('arrived'), true);
  assert.equal(clearsItem('not_coming'), true);
  assert.equal(clearsItem('called'), true);
});

/* The names are the point, not decoration. 'fixed_elsewhere' and 'not_now' each
   named ONE reason, so the first car that fixed itself would have been filed as
   "fixed elsewhere" in every report from then on. These fail if a reason ever
   gets put back into the vocabulary. */
test('the values name an OUTCOME, never a reason', () => {
  for (const o of OUTCOMES) {
    assert.ok(!/elsewhere|money|dealer|sold|itself/i.test(o), `${o} names a reason, not an outcome`);
  }
  assert.equal(OUTCOME_SHORT.not_coming, 'Not coming');
  assert.equal(OUTCOME_SHORT.follow_up, 'Follow up');
  // the reasons live in the PLACEHOLDER, as examples the advisor types over
  assert.match(OUTCOME_NOTE_PLACEHOLDER.not_coming, /fixed elsewhere.*fixed itself.*sold the car/);
  assert.match(OUTCOME_NOTE_PLACEHOLDER.follow_up, /no money till the 1st.*out of town/);
});

test('every button label is short enough for one row in the lane', () => {
  // The lane is 351px at 1440px and holds four buttons; anything longer wraps.
  for (const o of OUTCOMES) {
    assert.ok(OUTCOME_SHORT[o].length <= 12, `"${OUTCOME_SHORT[o]}" is too long for the row`);
  }
});

// ── the writes ───────────────────────────────────────────────────────
test('a clearing outcome resolves, and touches NOTHING about the lane or date', () => {
  const p = outcomePatch('arrived', { now: iso(2026, 9, 24, 10), byName: 'Josh' });
  assert.deepEqual(p, {
    resolved_at: iso(2026, 9, 24, 10),
    resolved_by_name: 'Josh',
    outcome: 'arrived',
    outcome_note: null,
  });
  for (const k of ['next_step', 'due_at', 'due_all_day', 'outcome_prev_due_at']) {
    assert.ok(!(k in p), `a clearing outcome must not write ${k}`);
  }
});

test('follow_up moves lanes and NEVER writes resolved_at', () => {
  const call = drop({ due_at: iso(2026, 9, 25, 12), due_all_day: true });
  const p = outcomePatch('follow_up', {
    call, byName: 'Josh', note: '  no money till the 1st  ',
    callbackDueAt: iso(2026, 10, 8, 12),
  });
  assert.equal(p.next_step, 'quoted_callback');
  assert.equal(p.due_at, iso(2026, 10, 8, 12));
  assert.equal(p.due_all_day, true);
  assert.equal(p.outcome, 'follow_up');
  assert.equal(p.outcome_note, 'no money till the 1st', 'note is trimmed');
  assert.equal(p.outcome_prev_due_at, call.due_at, 'keeps the date it could not make');
  assert.ok(!('resolved_at' in p), 'follow_up must never resolve — it is still a live lead');
  assert.ok(!('resolved_by_name' in p));
});

test('follow_up without a call-back date writes nothing at all', () => {
  assert.equal(outcomePatch('follow_up', { call: drop({}), callbackDueAt: null }), null);
  assert.equal(outcomePatch('follow_up', { call: drop({}), callbackDueAt: 'garbage' }), null);
});

test('an unknown outcome writes nothing', () => {
  assert.equal(outcomePatch('banana', { now: iso(2026, 9, 24) }), null);
  assert.equal(outcomePatch(null, {}), null);
  assert.equal(outcomePatch(undefined, {}), null);
});

test('a blank note is stored as null, not an empty string', () => {
  assert.equal(outcomePatch('not_coming', { note: '   ' }).outcome_note, null);
  assert.equal(outcomePatch('not_coming', {}).outcome_note, null);
});

test('undo clears exactly the four fields a clear wrote, and keeps prev_due_at', () => {
  const p = undoPatch();
  assert.deepEqual(p, { resolved_at: null, resolved_by_name: null, outcome: null, outcome_note: null });
  assert.ok(!('outcome_prev_due_at' in p), 'a row parked by follow_up must keep why it is in Callbacks');
  assert.ok(!('next_step' in p) && !('due_at' in p), 'a clear never changed these, so undo must not either');
});

// ── the confirm ──────────────────────────────────────────────────────
test('confirm fires for a date still ahead — the id-755 shape', () => {
  // OMAR MADRID: booked and cleared 2026-09-08, due 2026-09-28.
  assert.equal(needsConfirm(drop({ due_at: iso(2026, 9, 28, 12) }), at(2026, 9, 8, 14)), true);
});

test('confirm does NOT fire for today or the past — ordinary work must not nag', () => {
  assert.equal(needsConfirm(drop({ due_at: iso(2026, 9, 24, 16) }), NOW), false, 'later today');
  assert.equal(needsConfirm(drop({ due_at: iso(2026, 9, 24, 8) }), NOW), false, 'earlier today');
  assert.equal(needsConfirm(drop({ due_at: iso(2026, 9, 23, 12) }), NOW), false, 'yesterday');
});

test('confirm does not fire on an undated or unparseable row', () => {
  assert.equal(needsConfirm(drop({ due_at: null }), NOW), false);
  assert.equal(needsConfirm(drop({ due_at: 'garbage' }), NOW), false);
  assert.equal(needsConfirm(null, NOW), false);
});

test('the confirm names who and when', () => {
  const m = confirmMessage({}, 'OMAR MADRID', 'Mon, Sep 28');
  assert.equal(m, "This clears OMAR MADRID's Mon, Sep 28 drop-off from the Desk. Sure?");
  assert.match(confirmMessage({}, '', ''), /this lead/);
});

// ── recently cleared / undo list ─────────────────────────────────────
test('id 755 is reachable: cleared 20 days ago but still due in the future', () => {
  const omar = { id: 755, resolved_at: iso(2026, 9, 8, 14), due_at: iso(2026, 9, 28, 12) };
  assert.equal(isRecentlyCleared(omar, NOW), true);
  // and still reachable even once the 30-day window has passed, because it is still due
  assert.equal(isRecentlyCleared(omar, at(2026, 9, 27, 9)), true, 'the whole point of the second rule');
});

test('an old clear with an old date drops out of the list', () => {
  const stale = { resolved_at: iso(2026, 7, 1, 12), due_at: iso(2026, 7, 2, 12) };
  assert.equal(isRecentlyCleared(stale, NOW), false);
  assert.equal(isRecentlyCleared(stale, NOW, { days: 365 }), true, 'window is configurable');
});

test('a cleared row inside the 30-day window is listed whatever its date', () => {
  assert.equal(isRecentlyCleared({ resolved_at: iso(2026, 9, 20, 12), due_at: iso(2026, 8, 1, 12) }, NOW), true);
  assert.equal(CLEARED_WINDOW_DAYS, 30);
});

test('open rows are never in the cleared list', () => {
  assert.equal(isRecentlyCleared({ resolved_at: null, due_at: iso(2026, 9, 28) }, NOW), false);
  assert.equal(isRecentlyCleared({ resolved_at: 'garbage' }, NOW), false);
});

test('the list is newest-cleared first', () => {
  const rows = [
    { id: 'a', resolved_at: iso(2026, 9, 10, 9) },
    { id: 'c', resolved_at: iso(2026, 9, 23, 9) },
    { id: 'b', resolved_at: iso(2026, 9, 18, 9) },
  ];
  assert.deepEqual(recentlyCleared(rows, NOW).map(r => r.id), ['c', 'b', 'a']);
  assert.deepEqual(recentlyCleared(null, NOW), []);
});

test('a row cleared before outcomes existed says so instead of inventing a reason', () => {
  assert.equal(clearedLabel({ outcome: null }), 'Done (before outcomes)');
  assert.equal(clearedLabel({ outcome: 'banana' }), 'Done (before outcomes)');
  assert.equal(clearedLabel({ outcome: 'arrived' }), 'Car arrived');
  assert.equal(clearedLabel({ outcome: 'called' }), 'Called');
});

// ── the callback row's reason ────────────────────────────────────────
test('a parked lead says why it is in Callbacks', () => {
  const fmt = () => 'Fri, Sep 25';
  const c = { outcome: 'follow_up', outcome_prev_due_at: iso(2026, 9, 25, 12), outcome_note: 'no money' };
  assert.equal(callbackReason(c, fmt), 'Couldn’t make Fri, Sep 25 drop-off — no money');
  assert.equal(callbackReason({ ...c, outcome_note: '' }, fmt), 'Couldn’t make Fri, Sep 25 drop-off');
  assert.equal(callbackReason({ ...c, outcome_prev_due_at: null }, fmt),
    'Couldn’t make the drop-off — no money', 'no stored date, note still shown');
  assert.equal(callbackReason({ outcome: 'follow_up' }, fmt), 'Couldn’t make the drop-off');
});

test('an ordinary callback gets no reason line', () => {
  assert.equal(callbackReason({ outcome: null }, () => 'x'), '');
  assert.equal(callbackReason({ outcome: 'called' }, () => 'x'), '');
  assert.equal(callbackReason(null, () => 'x'), '');
});

test('the call-back date defaults to 14 days out and is overridable', () => {
  assert.equal(FOLLOW_UP_DEFAULT_DAYS, 14);
  assert.equal(defaultCallbackDate(at(2026, 9, 24, 10)), '2026-10-08');
  assert.equal(defaultCallbackDate(at(2026, 9, 24, 10), 7), '2026-10-01');
  assert.equal(defaultCallbackDate(at(2026, 12, 28, 10)), '2027-01-11', 'crosses the year');
});

// ── the migration agrees with the code ───────────────────────────────
test('both migrations CHECK exactly the four outcomes this module defines', () => {
  for (const [name, sql] of [['SANDBOX', SANDBOX_SQL], ['PROD', PROD_SQL]]) {
    const m = /check \(outcome is null or outcome in \(([^)]+)\)\)/.exec(sql);
    assert.ok(m, `${name}: CHECK not found`);
    const listed = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(listed, OUTCOMES, `${name}: CHECK list has drifted from OUTCOMES`);
    assert.match(sql, /add column if not exists outcome_prev_due_at timestamptz/, `${name}: prev_due_at`);
    assert.match(sql, /create index if not exists idx_calls_resolved_at/, `${name}: cleared-list index`);
  }
});

test('the two migration files differ ONLY in the environment guard', () => {
  assert.match(SANDBOX_SQL, /if v like 'PROD%' then/, 'sandbox file refuses on prod');
  assert.match(PROD_SQL, /if v not like 'PROD%' then/, 'prod file refuses elsewhere');
  const body = (s) => s.slice(s.indexOf('-- Three nullable columns'));
  assert.equal(body(SANDBOX_SQL), body(PROD_SQL), 'the bodies must stay identical');
});

test('neither migration backfills or touches RLS', () => {
  for (const [name, sql] of [['SANDBOX', SANDBOX_SQL], ['PROD', PROD_SQL]]) {
    const live = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/\bupdate\s+public\.calls\b/i.test(live), `${name}: must not backfill`);
    assert.ok(!/create policy|drop policy|enable row level security/i.test(live), `${name}: must not touch RLS`);
  }
});

// ── the board is wired to all of it ──────────────────────────────────
test('board loads the module and exposes it as window.DeskOutcomes', () => {
  assert.match(BOARD, /import \* as DeskOutcomes from '\.\/shared\/desk-outcomes\.js'/);
  assert.match(BOARD, /window\.DeskOutcomes = DeskOutcomes/);
});

test('the call window no longer has "Mark done"', () => {
  // It appeared next to "Close" the instant a step was picked, and caused 22 of
  // the 40 wipes. Clearing now happens only from the lanes.
  assert.ok(!/cc-done/.test(BOARD), 'the cc-done button/handler/CSS must be gone');
  assert.ok(!/>Mark done</.test(BOARD), 'no button labelled "Mark done"');
  assert.ok(!/resolveCallCard/.test(BOARD), 'its resolve helper must be gone too');
  // the phrase may survive ONLY in the comment explaining why it was removed
  const mentions = BOARD.split('Mark done').length - 1;
  assert.equal(mentions, 1, 'exactly one mention left: the explanatory comment');
  // and the call window must not WRITE resolved_at by any other route. Comments
  // are stripped first — one explains that Close deliberately leaves it null.
  const cc = BOARD.slice(BOARD.indexOf('function wireForm('), BOARD.indexOf('async function handleNewCall('))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/resolved_at/.test(cc), 'the call window must not write resolved_at at all');
});

test('board asks before clearing a future-dated item, and offers undo', () => {
  assert.match(BOARD, /\bneedsConfirm\(call, new Date\(\)\)/, 'confirm on future clears');
  assert.match(BOARD, /\bconfirmMessage\(call,/, 'the confirm names who and when');
  // Security slice 3 (a)2: undo runs undoPatch() on the SERVER (api/calls.js `undo`).
  assert.match(BOARD, /cdCallsWrite\(\{ action: 'undo', call_id: Number\(id\) \}\)/, 'undo path');
  assert.match(readFileSync(join(root, 'api/calls.js'), 'utf8'), /patchCall\(db, row\.id, '', undoPatch\(\)\)/, 'the server restores with undoPatch');
  assert.match(BOARD, /data-undo=/, 'an Undo control per cleared row');
  assert.match(BOARD, /\brecentlyCleared\(rows, new Date\(\)\)/, 'the Recently cleared list');
  assert.match(BOARD, /function applyOutcome\(/, 'one write path for all four outcomes');
  assert.match(BOARD, /openOutcomeModal\(call, outcome\)/, 'the two note-taking outcomes');
  // "Fixed elsewhere" keeps a typed reason, so it goes through the modal too —
  // and because it CLEARS, the future-date confirm fires there, on Save.
  assert.match(BOARD, /outcome === 'follow_up' \|\| outcome === 'not_coming'/, 'both take a note');
  assert.match(BOARD, /const parking = outcome === 'follow_up'/, 'only follow_up shows a call-back date');
  assert.match(BOARD, /if \(!parking && M\.needsConfirm\(call, new Date\(\)\)\)/, 'confirm on the clearing one');
});

test('board survives the columns not existing yet (the 42703 tier)', () => {
  assert.match(BOARD, /const CALL_COLS_OUTCOME/, 'a wider select tier');
  assert.match(BOARD, /outcomeColsAvailable/, 'a flag that hides the outcome UI');
});

test('the group-1 recovered banner no longer says "mark done"', () => {
  const banner = readFileSync(join(root, 'shared/desk-appointments.js'), 'utf8');
  const m = /export const RECOVERED_BANNER =([\s\S]*?);\n/.exec(banner);
  assert.ok(m, 'RECOVERED_BANNER not found');
  assert.ok(!/mark done/i.test(m[1]), 'it must name the new buttons instead');
  assert.match(m[1], /Arrived/);
  assert.match(m[1], /Not coming/);
  assert.match(m[1], /Follow up/);
  assert.ok(!/Fixed elsewhere|right now/i.test(m[1]), 'the old button names must be gone');
});

// ── the sandbox rename file ──────────────────────────────────────────
test('the rename file remaps both old values and swaps the CHECK', () => {
  assert.match(RENAME_SQL, /set outcome = 'not_coming' where outcome = 'fixed_elsewhere'/);
  assert.match(RENAME_SQL, /set outcome = 'follow_up'  where outcome = 'not_now'/);
  // drop BEFORE the remap, or the old CHECK rejects the new strings
  const dropAt = RENAME_SQL.indexOf('drop constraint if exists calls_outcome_check');
  const updAt = RENAME_SQL.indexOf("set outcome = 'not_coming'");
  const addAt = RENAME_SQL.indexOf('add constraint calls_outcome_check');
  assert.ok(dropAt > -1 && dropAt < updAt && updAt < addAt, 'drop -> remap -> add');
  const m = /check \(outcome is null or outcome in \(([^)]+)\)\)/.exec(RENAME_SQL.slice(addAt));
  assert.deepEqual(m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')), OUTCOMES);
});

test('the rename file is SANDBOX-ONLY and has no prod twin', () => {
  assert.match(RENAME_SQL, /if v like 'PROD%' then/, 'must refuse to run on prod');
  assert.ok(!existsSync(join(root, 'migrations/20260920_calls_outcome_rename_PROD.sql')),
    'prod never ran the old values, so a prod twin would be wrong');
});

test('the rename file never touches the reasons people typed', () => {
  const live = RENAME_SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/outcome_note\s*=/.test(live), 'outcome_note must be left exactly as typed');
  assert.ok(!/outcome_prev_due_at\s*=/.test(live));
  assert.ok(!/resolved_at\s*=/.test(live), 'the remap must not clear or set anything');
});
