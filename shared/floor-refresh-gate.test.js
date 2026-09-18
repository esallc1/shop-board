/* ============================================================
   floor-refresh-gate.test.js — the RO detail floor controls' stale-reply guard.
   Run: npm test   (node --test)

   Locks: a reply paints only if it is the newest refresh, no write
   invalidated it, and the same RO is still open. Ids compare as strings.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFloorRefreshGate } from './floor-refresh-gate.js';

function setup(openId) {
  const state = { open: openId };
  const gate = createFloorRefreshGate(() => state.open);
  return { state, gate };
}

test('a lone refresh on the open RO is current', () => {
  const { gate } = setup('ro-1');
  const isCurrent = gate.begin('ro-1');
  assert.equal(isCurrent(), true);
  assert.equal(isCurrent(), true);   // asking twice doesn't consume it
});

test('a newer refresh retires the older one', () => {
  const { gate } = setup('ro-1');
  const older = gate.begin('ro-1');
  const newer = gate.begin('ro-1');
  assert.equal(older(), false);
  assert.equal(newer(), true);
});

test('switching RO retires a reply for the previous RO', () => {
  const { state, gate } = setup('ro-1');
  const forRo1 = gate.begin('ro-1');
  state.open = 'ro-2';                   // user opened another RO; no new refresh yet
  assert.equal(forRo1(), false);
});

test('closing the RO retires the reply', () => {
  const { state, gate } = setup('ro-1');
  const r = gate.begin('ro-1');
  state.open = null;
  assert.equal(r(), false);
});

test('invalidate() (a write started) retires every refresh in flight', () => {
  const { gate } = setup('ro-1');
  const a = gate.begin('ro-1');
  gate.invalidate();
  assert.equal(a(), false);
  assert.equal(gate.begin('ro-1')(), true);   // a refresh started after the write is fine
});

test('ids compare as strings; a null RO id is never current', () => {
  const { gate } = setup(42);
  assert.equal(gate.begin('42')(), true);
  assert.equal(gate.begin(null)(), false);
});
