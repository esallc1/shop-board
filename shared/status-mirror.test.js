/* ============================================================
   status-mirror.test.js — unit tests for the work-status floor mirror.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_OPTIONS, buildStatusOptions, findStatusFloorRow, mirrorStatus } from './status-mirror.js';

// supabase-js-shaped mock. `floor` = { table, row } that matches the po (or null).
// Records every write { table, method, payload } so a test can assert exactly
// which tables were touched and that ONLY `status` is ever written.
function mockDb(floor) {
  const writes = [];
  function qb(table) {
    const b = { _table: table, _payload: null };
    b.select = () => b;
    b.eq = () => b;
    b.limit = () => b;
    b.update = (payload) => { b._payload = payload; return b; };
    b.then = (resolve) => {
      if (b._payload) { writes.push({ table, method: 'update', payload: b._payload }); resolve({ error: null }); }
      else { resolve({ data: floor && floor.table === table ? [floor.row] : [], error: null }); }
    };
    return b;
  }
  return { writes, from: (t) => qb(t) };
}

// ── canonical option list ───────────────────────────────────
test('STATUS_OPTIONS is the 11-value canonical list, in order, unchanged', () => {
  assert.deepEqual(STATUS_OPTIONS.map((o) => o.value), [
    'empty', 'in-progress', 'waiting-part', 'waiting-tech', 'waiting-pull',
    'waiting-install', 'waiting-quote', 'waiting-auth', 'qc', 'delayed', 'done',
  ]);
  assert.equal(STATUS_OPTIONS[0].label, '- Unassigned -');
  assert.equal(STATUS_OPTIONS.find((o) => o.value === 'done').label, 'Done / Ready');
});

test('buildStatusOptions renders the canonical list verbatim and marks the current value', () => {
  const opts = buildStatusOptions('in-progress');
  assert.equal(opts.length, 11);
  assert.deepEqual(opts.map((o) => o.value), STATUS_OPTIONS.map((o) => o.value)); // no reorder
  assert.equal(opts.filter((o) => o.selected).length, 1);
  assert.equal(opts.find((o) => o.selected).value, 'in-progress');
});

test('buildStatusOptions appends an out-of-list current value at the END, selected', () => {
  // 'approved' is written by the advisor approval flow but not in the dropdown.
  const opts = buildStatusOptions('approved');
  assert.equal(opts.length, 12);
  assert.deepEqual(opts.slice(0, 11).map((o) => o.value), STATUS_OPTIONS.map((o) => o.value)); // canonical unchanged
  assert.equal(opts[11].value, 'approved');
  assert.equal(opts[11].selected, true);
});

// ── floor resolution ────────────────────────────────────────
for (const table of ['shopboard_parking', 'shopboard_lifts']) {
  test(`findStatusFloorRow resolves a car on ${table} with its status`, async () => {
    const floor = await findStatusFloorRow(mockDb({ table, row: { id: 'r1', status: 'waiting-tech' } }), '6001');
    assert.deepEqual(floor, { table, id: 'r1', status: 'waiting-tech', isPickup: false });
  });
}

test('findStatusFloorRow flags a car on pickup (no status column)', async () => {
  const floor = await findStatusFloorRow(mockDb({ table: 'shopboard_pickup', row: { id: 'k1' } }), '6001');
  assert.deepEqual(floor, { table: 'shopboard_pickup', id: 'k1', status: null, isPickup: true });
});

test('findStatusFloorRow returns null when the car is on no floor table / empty po', async () => {
  assert.equal(await findStatusFloorRow(mockDb(null), '6001'), null);
  assert.equal(await findStatusFloorRow(mockDb(null), ''), null);
});

// ── the write ───────────────────────────────────────────────
test('mirrorStatus writes ONLY { status } to the correct floor table (no *_at, no warranty, no repair_orders)', async () => {
  const db = mockDb({ table: 'shopboard_lifts', row: { id: 5, status: 'waiting-tech' } });
  const res = await mirrorStatus(db, '6001', 'in-progress');
  assert.equal(res.ok, true);
  assert.equal(res.table, 'shopboard_lifts');
  assert.deepEqual(db.writes, [{ table: 'shopboard_lifts', method: 'update', payload: { status: 'in-progress' } }]);
  // The payload key set is EXACTLY {status} — proves no *_at stamp is written.
  assert.deepEqual(Object.keys(db.writes[0].payload), ['status']);
  assert.ok(!db.writes.some((w) => w.table === 'repair_orders'), 'repair_orders never written');
});

test('mirrorStatus on a parking car writes shopboard_parking.status', async () => {
  const db = mockDb({ table: 'shopboard_parking', row: { id: 'p1', status: 'qc' } });
  const res = await mirrorStatus(db, '6001', 'delayed');
  assert.equal(res.table, 'shopboard_parking');
  assert.deepEqual(db.writes, [{ table: 'shopboard_parking', method: 'update', payload: { status: 'delayed' } }]);
});

test('car on pickup → { ok:false, reason:pickup }, NOTHING written', async () => {
  const db = mockDb({ table: 'shopboard_pickup', row: { id: 'k1' } });
  const res = await mirrorStatus(db, '6001', 'in-progress');
  assert.deepEqual(res, { ok: false, reason: 'pickup' });
  assert.equal(db.writes.length, 0);
});

test('no floor row → { ok:false, reason:no-floor-row }, NOTHING written (no row created)', async () => {
  const db = mockDb(null);
  const res = await mirrorStatus(db, '6001', 'in-progress');
  assert.deepEqual(res, { ok: false, reason: 'no-floor-row' });
  assert.equal(db.writes.length, 0);
});
