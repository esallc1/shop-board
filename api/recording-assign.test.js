/* ============================================================
   recording-assign.test.js — unit tests for the assign endpoint's PURE helpers.
   The security invariants (ids-only in, ownership required) live here.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssignBody, ownershipOk } from './recording-assign.js';

const UUID = '11111111-2222-3333-4444-555555555555';

// ── parseAssignBody: ids only ───────────────────────────────
test('parseAssignBody accepts a positive int call_id + uuid vehicle_id', () => {
  assert.deepEqual(parseAssignBody({ call_id: 42, vehicle_id: UUID }), { ok: true, call_id: 42, vehicle_id: UUID });
  assert.deepEqual(parseAssignBody({ call_id: '42', vehicle_id: UUID }), { ok: true, call_id: 42, vehicle_id: UUID });
});

test('parseAssignBody accepts vehicle_id null (clear)', () => {
  assert.deepEqual(parseAssignBody({ call_id: 7, vehicle_id: null }), { ok: true, call_id: 7, vehicle_id: null });
});

test('parseAssignBody rejects a missing / bad call_id', () => {
  assert.equal(parseAssignBody({ vehicle_id: UUID }).ok, false);
  assert.equal(parseAssignBody({ call_id: 0, vehicle_id: UUID }).ok, false);
  assert.equal(parseAssignBody({ call_id: -1, vehicle_id: UUID }).ok, false);
  assert.equal(parseAssignBody({ call_id: 1.5, vehicle_id: UUID }).ok, false);
  assert.equal(parseAssignBody({ call_id: 'abc', vehicle_id: UUID }).ok, false);
});

test('parseAssignBody requires vehicle_id to be present (null must be explicit)', () => {
  assert.equal(parseAssignBody({ call_id: 1 }).ok, false);
});

test('parseAssignBody rejects a non-uuid vehicle_id — no smuggling a path/row field', () => {
  assert.equal(parseAssignBody({ call_id: 1, vehicle_id: '2026-07/4380799274.mp3' }).ok, false);
  assert.equal(parseAssignBody({ call_id: 1, vehicle_id: 'not-a-uuid' }).ok, false);
  assert.equal(parseAssignBody({ call_id: 1, vehicle_id: 5 }).ok, false);
});

test('parseAssignBody ignores extra fields (storage_path/remote_url never read)', () => {
  const r = parseAssignBody({ call_id: 9, vehicle_id: UUID, storage_path: 'x', remote_url: 'y', fetch_status: 'ready' });
  assert.deepEqual(r, { ok: true, call_id: 9, vehicle_id: UUID });   // only the two ids survive
});

test('parseAssignBody tolerates junk input', () => {
  assert.equal(parseAssignBody(null).ok, false);
  assert.equal(parseAssignBody(undefined).ok, false);
  assert.equal(parseAssignBody('nope').ok, false);
});

// ── ownershipOk: vehicle must belong to the call's confirmed customer ──
test('ownershipOk: same customer → true', () => {
  assert.equal(ownershipOk('cust-A', 'cust-A'), true);
});
test('ownershipOk: different customer → false', () => {
  assert.equal(ownershipOk('cust-A', 'cust-B'), false);
});
test('ownershipOk: no confirmed call customer → false (person link comes first)', () => {
  assert.equal(ownershipOk(null, 'cust-A'), false);
  assert.equal(ownershipOk(undefined, 'cust-A'), false);
});
test('ownershipOk: vehicle with no customer → false', () => {
  assert.equal(ownershipOk('cust-A', null), false);
});
