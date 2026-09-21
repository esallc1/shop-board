import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DUE_VERB, MANUAL_TAG, dueLine, outcomeLine, isManualCall, callWhen, compareCallWhen,
} from './call-appointment.js';
import { clearedLabel } from './desk-outcomes.js';

// Stand-in for the Desk's dueLabel — records what it was asked.
const fmt = (iso, allDay) => `${iso.slice(0, 10)}${allDay ? '' : ' · T'}`;

test('dueLine: drop-off timed / all-day, callback wording', () => {
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: '2026-09-23T13:00:00Z', due_all_day: false }, fmt),
    '→ Drop-off 2026-09-23 · T');
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: '2026-09-23T16:00:00Z', due_all_day: true }, fmt),
    '→ Drop-off 2026-09-23');
  assert.equal(dueLine({ next_step: 'quoted_callback', due_at: '2026-09-23T16:00:00Z', due_all_day: true }, fmt),
    '→ Call back 2026-09-23');
});

test('dueLine: null due_all_day counts as all-day (the calendar rule)', () => {
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: '2026-09-23T16:00:00Z', due_all_day: null }, fmt),
    '→ Drop-off 2026-09-23');
});

test('dueLine: a key-box drop-off says so; a callback with a stale flag does not', () => {
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: '2026-09-23T16:00:00Z', due_all_day: true, dropoff_key_box: true }, fmt),
    '→ Drop-off 2026-09-23 · 🔑 Key box');
  assert.equal(dueLine({ next_step: 'quoted_callback', due_at: '2026-09-23T16:00:00Z', due_all_day: true, dropoff_key_box: true }, fmt),
    '→ Call back 2026-09-23');
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: '2026-09-23T16:00:00Z', due_all_day: false, dropoff_key_box: true }, fmt),
    '→ Drop-off 2026-09-23 · T');
});

test('dueLine: nothing without a Desk step, a valid date, or a formatter', () => {
  assert.equal(dueLine({ next_step: 'price_shopper', due_at: '2026-09-23T16:00:00Z' }, fmt), '');
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: null }, fmt), '');
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: 'garbage' }, fmt), '');
  assert.equal(dueLine({ next_step: 'dropping_off', due_at: '2026-09-23T16:00:00Z' }, null), '');
  assert.equal(dueLine(null, fmt), '');
  assert.deepEqual(Object.keys(DUE_VERB).sort(), ['dropping_off', 'quoted_callback']);
});

test('outcomeLine: resolved rows use clearedLabel, with who', () => {
  assert.equal(outcomeLine({ resolved_at: 't', outcome: 'arrived', resolved_by_name: 'Ana' }, clearedLabel),
    '✓ Car arrived · by Ana');
  assert.equal(outcomeLine({ resolved_at: 't', outcome: 'not_coming' }, clearedLabel), '✓ Not coming');
  assert.equal(outcomeLine({ resolved_at: 't', outcome: 'called', resolved_by_name: 'Jo' }, clearedLabel),
    '✓ Called · by Jo');
});

test('outcomeLine: a row cleared before outcomes existed says so', () => {
  assert.equal(outcomeLine({ resolved_at: 't', outcome: null }, clearedLabel), '✓ Done (before outcomes)');
});

test('outcomeLine: follow_up is open (never resolves) and shows without a tick', () => {
  assert.equal(outcomeLine({ resolved_at: null, outcome: 'follow_up' }, clearedLabel), 'Follow up later');
});

test('outcomeLine: open row, undone row, or no outcome columns loaded → nothing', () => {
  assert.equal(outcomeLine({ resolved_at: null, outcome: null }, clearedLabel), '');
  assert.equal(outcomeLine({}, clearedLabel), '');                     // fallback tier: columns absent
  assert.equal(outcomeLine({ resolved_at: 't' }, null), '');
});

test('isManualCall: negative synthetic ctm id only', () => {
  assert.equal(isManualCall({ ctm_call_id: -1726912345678123 }), true);
  assert.equal(isManualCall({ ctm_call_id: '-5' }), true);
  assert.equal(isManualCall({ ctm_call_id: 98765 }), false);
  assert.equal(isManualCall({ ctm_call_id: null }), false);
  assert.equal(isManualCall({}), false);
  assert.equal(isManualCall(null), false);
  assert.equal(MANUAL_TAG, 'Added on the Desk');
});

test('callWhen: started_at, else created_at, else null', () => {
  assert.equal(callWhen({ started_at: 'S', created_at: 'C' }), 'S');
  assert.equal(callWhen({ started_at: null, created_at: 'C' }), 'C');
  assert.equal(callWhen({}), null);
});

test('compareCallWhen: a manual row sorts by when it was added, not to the top', () => {
  const rows = [
    { id: 'real-late', started_at: '2026-09-10T15:00:00Z' },
    { id: 'manual', started_at: null, created_at: '2026-09-05T12:00:00Z' },
    { id: 'real-early', started_at: '2026-09-01T15:00:00Z' },
  ];
  assert.deepEqual(rows.slice().sort(compareCallWhen).map(r => r.id), ['real-early', 'manual', 'real-late']);
});

// ── board wiring — the customer-record path must not read started_at raw ──
test('board: customer-record call paths go through callWhen', () => {
  const html = readFileSync(new URL('../advisor-board.html', import.meta.url), 'utf8');
  const cr = readFileSync(new URL('./customer-record.js', import.meta.url), 'utf8');
  assert.match(cr, /compareCallWhen/);
  assert.doesNotMatch(cr, /a\.started_at \|\| ''/);
  // callEntryHtml's time, the timeline sort, last-activity, vehicle activity
  assert.match(html, /custFmtWhen\(cdCallWhen\(c\)\)/);
  assert.doesNotMatch(html, /custRecCallsAll\.forEach\(c => consider\(c\.started_at\)\)/);
  assert.doesNotMatch(html, /consider\(c\.started_at \|\| c\.noted_at\)/);
  // the Call Log selects the appointment, and has an outcome tier
  assert.match(html, /const LOG_COLS = '[^']*due_at, due_all_day/);
  assert.match(html, /LOG_COLS_OUTCOME = LOG_COLS_AUTO \+ ', outcome, resolved_at, resolved_by_name'/);
});
