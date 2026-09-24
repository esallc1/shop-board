/* ============================================================
   whiteboard-logic.test.js — the Whiteboard's rules (slice 2: read-only).
   Run: npm test   (node --test)

   Locks: "Ready → call for pickup" = status 'invoice' only (a closed RO never
   shows, a reopened one comes back — worked out fresh on every read); the line
   shape; and (static) the Whiteboard code NEVER writes and never goes through
   the RO detail's open/current-RO code, so drawing it can't re-save an RO.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import {
  READY_STATUS, READY_SELECT, readyLines, vehicleText, boardDate,
  callsByRo, noteLists, stamp, whenText, upsertRow, actionError, RECENT_DAYS, NOTE_MAX,
} from './whiteboard-logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), 'utf8');
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ro = (over = {}) => ({
  id: 'r1', ro_number: '6012', po: '6012', status: 'invoice', created_at: '2026-09-20T13:00:00Z',
  customers: { name: 'Juan Perez' }, vehicles: { year: 2015, make: 'Ford', model: 'F-150' }, ...over,
});

test("ready = status 'invoice' — the RO Board's Ready for pickup column", () => {
  assert.equal(READY_STATUS, 'invoice');
  const lines = readyLines([ro()]);
  assert.deepEqual(lines, [{
    id: 'r1', number: '#6012', roNumber: '6012', po: '6012',
    customer: 'Juan Perez', vehicle: '2015 Ford F-150', created: '2026-09-20T13:00:00Z',
  }]);
});

test('a closed RO never shows; reopening it to invoice brings it back (status only, never closed_at)', () => {
  const closed = ro({ status: 'closed', closed_at: '2026-09-24T15:00:00Z' });
  assert.deepEqual(readyLines([closed]), []);
  const reopened = ro({ status: 'invoice', closed_at: '2026-09-24T15:00:00Z' });   // closed_at is kept on a reopen
  assert.equal(readyLines([reopened]).length, 1);
  for (const s of ['estimate', 'ro', 'closed', '', null, undefined, 'INVOICE']) {
    assert.deepEqual(readyLines([ro({ status: s })]), [], String(s));
  }
});

test('oldest RO first; duplicates and junk dropped; missing names/vehicles are safe', () => {
  const lines = readyLines([
    ro({ id: 'b', po: '6020', ro_number: '6020', created_at: '2026-09-22T10:00:00Z' }),
    null, 'x', { status: 'invoice' },
    ro({ id: 'a', po: '6001', ro_number: '6001', created_at: '2026-09-18T10:00:00Z' }),
    ro({ id: 'a' }),
    ro({ id: 'c', po: null, ro_number: '6030', customers: null, vehicles: null, created_at: '2026-09-23T10:00:00Z' }),
  ]);
  assert.deepEqual(lines.map((l) => l.id), ['a', 'b', 'c']);
  assert.equal(lines[2].number, '#6030');
  assert.equal(lines[2].customer, '—');
  assert.equal(lines[2].vehicle, '');
  assert.deepEqual(readyLines(null), []);
  assert.equal(vehicleText({ year: 2011, make: 'Honda', model: '' }), '2011 Honda');
  assert.equal(vehicleText(null), '');
});

test('the Ready query: named columns, no closed_at, no book_hours; reads only the three tables, all SELECTs', () => {
  assert.doesNotMatch(READY_SELECT, /closed_at|book_hours|\*/);
  for (const col of ['id', 'ro_number', 'po', 'status', 'customers(name)', 'vehicles(year, make, model)']) {
    assert.ok(READY_SELECT.includes(col), col);
  }
  const ui = code('whiteboard.js');
  assert.match(ui, /\.from\('repair_orders'\)\.select\(READY_SELECT\)\s*\.eq\('status', READY_STATUS\)/);
  const tables = [...ui.matchAll(/\.from\('([a-z_]+)'\)\s*\.(\w+)\(/g)].map((m) => m[1] + '.' + m[2]);
  assert.deepEqual(tables.sort(), ['repair_orders.select', 'whiteboard_items.select', 'whiteboard_pickup_calls.select']);
  assert.equal((ui.match(/\.from\(/g) || []).length, 3);
});

test('static: the Whiteboard never writes through the client — every write is POST /api/whiteboard', () => {
  for (const f of ['whiteboard.js', 'whiteboard-logic.js', 'front-desk-drawer.js']) {
    const c = code(f);
    for (const w of ['.update(', '.insert(', '.upsert(', '.delete(', '.rpc(']) {
      assert.ok(!c.includes(w), `${f} contains ${w}`);
    }
    assert.doesNotMatch(c, /\bopenRo\b|\bcurrentRo\b|updateBookHoursAuto|book_hours/, f + ' reaches into the RO detail');
    assert.doesNotMatch(c, /(^|[^.\w])fetch\(|XMLHttpRequest/, f + ' calls the network directly');
  }
  const ui = code('whiteboard.js');
  assert.match(ui, /const API = '\/api\/whiteboard';/);
  assert.equal((ui.match(/cdAuthFetch\(db, API,/g) || []).length, 1, 'one door out: cdAuthFetch to /api/whiteboard');
  assert.doesNotMatch(ui, /\/api\/(?!whiteboard')/, 'no other endpoint');
  // Actions sent are exactly the endpoint's five; who/when are never sent from here.
  const sent = [...ui.matchAll(/action: '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sent)].sort(), ['add', 'called', 'clear', 'uncalled', 'undo']);
  assert.doesNotMatch(ui, /created_by(?!_name)|called_by(?!_name)|cleared_by(?!_name)|created_at:|called_at:|cleared_at:/,
    'who/when are stamped by the server, not sent');
  // Realtime on the two new tables, with the viewer's token first (staff-only tables).
  assert.match(ui, /db\.realtime\.setAuth\(token\)/);
  for (const t of ['repair_orders', 'whiteboard_items', 'whiteboard_pickup_calls']) {
    assert.match(ui, new RegExp(`table: '${t}' \\}, schedule\\)`), t + ' live');
  }
  // A click opens the RO the normal way — the same door global search uses.
  assert.match(ui, /window\.cdOpenRo\(/);
});

test('called stamps: only rows with called_at count; the stamp reads "name · time" in shop time', () => {
  const m = callsByRo([
    { ro_id: 'a', called_at: '2026-09-24T18:14:00Z', called_by_name: 'Kevin' },
    { ro_id: 'b', called_at: null, called_by_name: null },          // undone
    null, { called_at: 'x' },
  ]);
  assert.deepEqual([...m.keys()], ['a']);
  const now = new Date('2026-09-24T18:30:00Z');
  assert.equal(stamp('Kevin', '2026-09-24T18:14:00Z', now), 'Kevin · 2:14 PM');
  assert.equal(stamp('', '2026-09-22T14:00:00Z', now), 'someone · Tue 10:00 AM');
  assert.equal(whenText('2026-09-10T14:00:00Z', now), '9/10');
  assert.equal(whenText('nope', now), '');
});

test("Don't forget: open lines oldest first; recently erased = erased in the last 7 days, newest first", () => {
  const now = new Date('2026-09-24T18:00:00Z');
  const rows = [
    { id: '1', kind: 'note', text: 'b', created_at: '2026-09-24T10:00:00Z', cleared_at: null },
    { id: '2', kind: 'note', text: 'a', created_at: '2026-09-23T10:00:00Z', cleared_at: null },
    { id: '3', kind: 'note', text: 'gone', created_at: '2026-09-20T10:00:00Z', cleared_at: '2026-09-24T12:00:00Z', cleared_reason: 'erased' },
    { id: '4', kind: 'note', text: 'old', created_at: '2026-09-01T10:00:00Z', cleared_at: '2026-09-10T12:00:00Z', cleared_reason: 'erased' },
    { id: '5', kind: 'note', text: 'newer', created_at: '2026-09-20T10:00:00Z', cleared_at: '2026-09-24T15:00:00Z', cleared_reason: 'erased' },
    { id: '6', kind: 'parts', text: 'starter', created_at: '2026-09-24T09:00:00Z', cleared_at: null },
    { id: '2', kind: 'note', text: 'dup', created_at: '2026-09-23T10:00:00Z', cleared_at: null },
    null,
  ];
  const { open, erased } = noteLists(rows, now);
  assert.deepEqual(open.map((r) => r.id), ['2', '1']);
  assert.deepEqual(erased.map((r) => r.id), ['5', '3']);
  assert.deepEqual(noteLists(rows, now, 'parts').open.map((r) => r.id), ['6']);
  assert.equal(RECENT_DAYS, 7);
  assert.equal(NOTE_MAX, 500);
});

test('upsertRow folds a returned row in (replace by key, or add); errors read plainly', () => {
  const list = [{ id: 'a', text: 'x' }];
  assert.deepEqual(upsertRow(list, { id: 'a', cleared_at: 't' }), [{ id: 'a', text: 'x', cleared_at: 't' }]);
  assert.deepEqual(upsertRow(list, { id: 'b' }).map((r) => r.id), ['a', 'b']);
  assert.deepEqual(list, [{ id: 'a', text: 'x' }], 'input untouched');
  assert.deepEqual(upsertRow([{ ro_id: 'r', called_at: 't' }], { ro_id: 'r', called_at: null }, 'ro_id'), [{ ro_id: 'r', called_at: null }]);
  assert.match(actionError(401, null), /sign-in isn't active/);
  assert.equal(actionError(409, { message: "That RO isn't ready for pickup any more." }), "That RO isn't ready for pickup any more.");
  assert.match(actionError(0, null), /try again/);
});

test('static: one shared module mounts the drawer (no per-board copy)', () => {
  const fd = code('front-desk-drawer.js');
  assert.match(fd, /import \{ mountBottomDrawer \} from '\.\/bottom-drawer\.js';/);
  assert.match(fd, /createDeskPadPanel/);
  assert.match(fd, /createWhiteboardPanel\(ctx, \{ db \}\)/);
  for (const b of ['gm-board.html', 'owner-board.html', 'bookkeeping-board.html']) {
    const hit = /shared\/(whiteboard|bottom-drawer|front-desk-drawer)/.test(src('../' + b));
    assert.equal(hit, false, b + ' — advisor board only for now');
  }
});

test("the board's date: shop time, 'THU 9/24' (late evening UTC-wise is still the shop's day)", () => {
  assert.equal(boardDate(new Date('2026-09-24T14:00:00Z')), 'THU 9/24');
  assert.equal(boardDate(new Date('2026-09-25T03:30:00Z')), 'THU 9/24');   // 11:30 pm ET
  assert.equal(boardDate(new Date('2026-09-25T04:30:00Z')), 'FRI 9/25');
});

test('the look: self-hosted marker + handwriting fonts, no font CDN; the mockup pieces are there', () => {
  const css = src('whiteboard.css');
  assert.doesNotMatch(css, /googleapis|gstatic|@import|https?:\/\//, 'no external font / CSS');
  for (const f of ['permanent-marker-400.woff2', 'kalam-400.woff2', 'kalam-700.woff2']) {
    assert.match(css, new RegExp(`url\\('fonts/${f.replace('.', '\\.')}'\\)`), f + ' referenced');
    const path = join(here, 'fonts', f);
    assert.ok(existsSync(path) && statSync(path).size > 5000, f + ' present');
  }
  for (const lic of ['KALAM-OFL.txt', 'PERMANENT-MARKER-LICENSE.txt']) assert.ok(existsSync(join(here, 'fonts', lic)), lic);
  const ui = code('whiteboard.js');
  for (const piece of ['wb-frame', 'wb-board', 'FRONT OFFICE', 'wb-tray', 'WAITING ON PARTS', 'READY → CALL FOR PICKUP', "DON'T FORGET", '⚡ auto']) {
    assert.ok(ui.includes(piece), piece);
  }
  assert.doesNotMatch(ui, /is-soon|dashed/, 'no grey dashed placeholder boxes');
});
