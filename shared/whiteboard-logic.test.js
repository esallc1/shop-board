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
import { READY_STATUS, READY_SELECT, readyLines, vehicleText, boardDate } from './whiteboard-logic.js';

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

test('the one query: named columns, no closed_at, no book_hours', () => {
  assert.doesNotMatch(READY_SELECT, /closed_at|book_hours|\*/);
  for (const col of ['id', 'ro_number', 'po', 'status', 'customers(name)', 'vehicles(year, make, model)']) {
    assert.ok(READY_SELECT.includes(col), col);
  }
  const ui = code('whiteboard.js');
  assert.match(ui, /\.from\('repair_orders'\)\.select\(READY_SELECT\)\s*\.eq\('status', READY_STATUS\)/);
  assert.equal((ui.match(/\.from\(/g) || []).length, 1, 'exactly one table read');
});

test('static: the Whiteboard never writes and never touches the RO detail code', () => {
  for (const f of ['whiteboard.js', 'whiteboard-logic.js', 'front-desk-drawer.js']) {
    const c = code(f);
    for (const w of ['.update(', '.insert(', '.upsert(', '.delete(', '.rpc(']) {
      assert.ok(!c.includes(w), `${f} contains ${w}`);
    }
    assert.doesNotMatch(c, /\bopenRo\b|\bcurrentRo\b|updateBookHoursAuto|book_hours/, f + ' reaches into the RO detail');
    assert.doesNotMatch(c, /\bfetch\(|cdAuthFetch|\/api\//, f + ' calls an endpoint (slice 2 is read-only)');
  }
  // A click opens the RO the normal way — the same door global search uses.
  assert.match(code('whiteboard.js'), /window\.cdOpenRo\(/);
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
