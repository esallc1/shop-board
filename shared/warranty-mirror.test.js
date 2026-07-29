/* ============================================================
   warranty-mirror.test.js — unit tests for the warranty floor-mirror decision.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warrantyStampPayload, FLOOR_TABLES, findFloorRow, mirrorWarranty } from './warranty-mirror.js';

// A supabase-js-shaped mock. `floor` maps table → the single row that matches
// the po (or nothing). Records every write as { table, method, payload } so a
// test can assert exactly which tables were touched — and that repair_orders
// never is.
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
      else { const row = floor && floor.table === table ? [floor.row] : []; resolve({ data: row, error: null }); }
    };
    return b;
  }
  return { writes, from: (t) => qb(t) };
}

test('FLOOR_TABLES covers all three floor tables', () => {
  assert.deepEqual([...FLOOR_TABLES].sort(), ['shopboard_lifts', 'shopboard_parking', 'shopboard_pickup']);
});

test('toggle ON with no existing stamp → warranty true + comeback_flagged_at stamped now', () => {
  assert.deepEqual(
    warrantyStampPayload(null, true, '2026-07-29T15:00:00.000Z'),
    { warranty: true, comeback_flagged_at: '2026-07-29T15:00:00.000Z' },
  );
});

test('toggle ON reuses an existing stamp (never moves the historical date)', () => {
  assert.deepEqual(
    warrantyStampPayload('2026-07-01T09:00:00.000Z', true, '2026-07-29T15:00:00.000Z'),
    { warranty: true, comeback_flagged_at: '2026-07-01T09:00:00.000Z' },
  );
});

test('toggle OFF → warranty false ONLY, comeback_flagged_at left untouched', () => {
  const off = warrantyStampPayload(null, false, '2026-07-29T15:00:00.000Z');
  assert.deepEqual(off, { warranty: false });
  assert.ok(!('comeback_flagged_at' in off), 'OFF must not write comeback_flagged_at');
});

test('toggle OFF when a stamp already exists → still does not touch it (survives)', () => {
  const off = warrantyStampPayload('2026-07-01T09:00:00.000Z', false, '2026-07-29T15:00:00.000Z');
  assert.deepEqual(off, { warranty: false });
  assert.ok(!('comeback_flagged_at' in off), 'un-toggling can never erase the historical stamp');
});

test('coerces truthy/falsy on into a real boolean', () => {
  assert.equal(warrantyStampPayload(null, 1, 'now').warranty, true);
  assert.equal(warrantyStampPayload(null, 0, 'now').warranty, false);
  assert.equal(warrantyStampPayload(null, '', 'now').warranty, false);
});

// ── findFloorRow / mirrorWarranty against a mock db ─────────
for (const table of FLOOR_TABLES) {
  test(`findFloorRow resolves a car on ${table}`, async () => {
    const db = mockDb({ table, row: { id: 'r1', warranty: false, comeback_flagged_at: null } });
    const floor = await findFloorRow(db, '6001');
    assert.equal(floor.table, table);
    assert.equal(floor.id, 'r1');
  });
}

test('findFloorRow returns null when the car is on no floor table', async () => {
  assert.equal(await findFloorRow(mockDb(null), '6001'), null);
  assert.equal(await findFloorRow(mockDb(null), ''), null);   // empty po → null, no query
});

test('mirror ON: warranty=true + comeback_flagged_at written to the CORRECT floor table only', async () => {
  const db = mockDb({ table: 'shopboard_lifts', row: { id: 5, warranty: false, comeback_flagged_at: null } });
  const res = await mirrorWarranty(db, '6001', true, '2026-07-29T15:00:00.000Z');
  assert.equal(res.ok, true);
  assert.equal(res.table, 'shopboard_lifts');
  assert.deepEqual(db.writes, [{ table: 'shopboard_lifts', method: 'update', payload: { warranty: true, comeback_flagged_at: '2026-07-29T15:00:00.000Z' } }]);
  // repair_orders is NEVER written.
  assert.ok(!db.writes.some((w) => w.table === 'repair_orders'), 'repair_orders must not be written');
});

test('mirror OFF: warranty=false ONLY; comeback_flagged_at not in the write (stamp survives)', async () => {
  const db = mockDb({ table: 'shopboard_parking', row: { id: 'p1', warranty: true, comeback_flagged_at: '2026-07-01T09:00:00.000Z' } });
  const res = await mirrorWarranty(db, '6001', false, '2026-07-29T15:00:00.000Z');
  assert.equal(res.ok, true);
  assert.deepEqual(db.writes, [{ table: 'shopboard_parking', method: 'update', payload: { warranty: false } }]);
  assert.ok(!('comeback_flagged_at' in db.writes[0].payload), 'OFF leaves the historical stamp untouched');
});

test('mirror ON reuses an existing stamp (does not move the date)', async () => {
  const db = mockDb({ table: 'shopboard_pickup', row: { id: 'k1', warranty: false, comeback_flagged_at: '2026-07-01T09:00:00.000Z' } });
  await mirrorWarranty(db, '6001', true, '2026-07-29T15:00:00.000Z');
  assert.equal(db.writes[0].payload.comeback_flagged_at, '2026-07-01T09:00:00.000Z');
});

test('no floor row → { ok:false, reason:no-floor-row }, NOTHING written (no row created, no repair_orders)', async () => {
  const db = mockDb(null);
  const res = await mirrorWarranty(db, '6001', true, '2026-07-29T15:00:00.000Z');
  assert.deepEqual(res, { ok: false, reason: 'no-floor-row' });
  assert.equal(db.writes.length, 0, 'no write of any kind — no floor row created, repair_orders untouched');
});
