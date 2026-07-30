/* ============================================================
   customer-record.test.js — unit tests for the customer record logic.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_VEHICLES, buildRecordingCalls, isSecondaryLearned, filterByVehicle,
  filterRecordingsByVehicle, canAssignRecording,
  customerCounts, openRosOf, sortNewestFirst, roInvoiceTotal, totalsByRo,
} from './customer-record.js';

const last10 = (s) => String(s == null ? '' : s).replace(/\D/g, '').slice(-10);

// ── buildRecordingCalls: confirmed / unconfirmed / exclusions / order ──
test('confirmed = attached to THIS customer; unconfirmed = unattached phone match', () => {
  const idCalls = [{ id: 1, customer_id: 'C', started_at: '2026-02-01' }];
  const phoneCalls = [{ id: 2, customer_id: null, started_at: '2026-01-01' }];  // unattached phone match
  const out = buildRecordingCalls(idCalls, phoneCalls, { customerId: 'C' });
  assert.equal(out.length, 2);
  // OLDEST first — call 2 (Jan) before call 1 (Feb)
  assert.deepEqual(out.map((c) => c.id), [2, 1]);
  assert.equal(out.find((c) => c.id === 1).confirmed, true);
  assert.equal(out.find((c) => c.id === 2).confirmed, false);
});

test('a call attached to a DIFFERENT customer is excluded even if the phone matches', () => {
  const phoneCalls = [{ id: 9, customer_id: 'OTHER', started_at: '2026-01-01' }];
  const out = buildRecordingCalls([], phoneCalls, { customerId: 'C' });
  assert.equal(out.length, 0, 'never show another customer\'s confirmed call');
});

test('not_a_customer_at rows are excluded from both sources', () => {
  const idCalls = [{ id: 1, customer_id: 'C', started_at: 't', not_a_customer_at: '2026-05-01' }];
  const phoneCalls = [{ id: 2, customer_id: null, started_at: 't', not_a_customer_at: '2026-05-01' }];
  assert.equal(buildRecordingCalls(idCalls, phoneCalls, { customerId: 'C' }).length, 0);
});

test('a call in BOTH sources is deduped once (confirmed)', () => {
  const c = { id: 5, customer_id: 'C', started_at: 't' };
  const out = buildRecordingCalls([c], [c], { customerId: 'C' });
  assert.equal(out.length, 1);
  assert.equal(out[0].confirmed, true);
});

test('buildRecordingCalls tolerates empty / missing input', () => {
  assert.deepEqual(buildRecordingCalls(null, null, { customerId: 'C' }), []);
  assert.deepEqual(buildRecordingCalls([], [], {}), []);
});

// ── isSecondaryLearned ──────────────────────────────────────
test('secondary is "learned" when a learned_phone call matches it', () => {
  const calls = [{ caller_bare: '3055550148', learned_phone: true }];
  assert.equal(isSecondaryLearned({ phoneSecondary: '(305) 555-0148', calls, last10 }), true);
});
test('secondary NOT learned without a matching learned_phone call', () => {
  assert.equal(isSecondaryLearned({ phoneSecondary: '3055550148', calls: [{ caller_bare: '3055550148', learned_phone: false }], last10 }), false);
  assert.equal(isSecondaryLearned({ phoneSecondary: '3055550148', calls: [{ caller_bare: '9999999999', learned_phone: true }], last10 }), false);
  assert.equal(isSecondaryLearned({ phoneSecondary: null, calls: [], last10 }), false);
});

// ── filterByVehicle ─────────────────────────────────────────
test('filterByVehicle: "all"/null → everything; specific id → only that vehicle', () => {
  const items = [{ v: 'x' }, { v: 'y' }, { v: null }];
  const get = (i) => i.v;
  assert.equal(filterByVehicle(items, ALL_VEHICLES, get).length, 3);
  assert.equal(filterByVehicle(items, null, get).length, 3);
  assert.deepEqual(filterByVehicle(items, 'x', get).map((i) => i.v), ['x']);
});
test('filterByVehicle: a null vehicle id never matches a specific chip', () => {
  const items = [{ v: null }, { v: 'x' }];
  assert.equal(filterByVehicle(items, 'x', (i) => i.v).length, 1);
});
test('filterByVehicle survives 1 vehicle and a 31-vehicle fleet', () => {
  const one = [{ v: 'solo' }];
  assert.equal(filterByVehicle(one, 'solo', (i) => i.v).length, 1);
  const fleet = Array.from({ length: 31 }, (_, i) => ({ v: 'f' + i }));
  assert.equal(filterByVehicle(fleet, 'f17', (i) => i.v).length, 1);
  assert.equal(filterByVehicle(fleet, ALL_VEHICLES, (i) => i.v).length, 31);
});

// ── filterRecordingsByVehicle: unknown shows under EVERY chip ──
test('filterRecordingsByVehicle: "all"/null → everything', () => {
  const items = [{ v: 'x' }, { v: null }, { v: 'y' }];
  const get = (i) => i.v;
  assert.equal(filterRecordingsByVehicle(items, ALL_VEHICLES, get).length, 3);
  assert.equal(filterRecordingsByVehicle(items, null, get).length, 3);
});
test('filterRecordingsByVehicle: specific chip keeps its vehicle AND all unknowns', () => {
  const items = [{ id: 1, v: 'x' }, { id: 2, v: null }, { id: 3, v: 'y' }, { id: 4, v: null }];
  const out = filterRecordingsByVehicle(items, 'x', (i) => i.v);
  // x (matching) + both unknowns; y (a DIFFERENT vehicle) filtered out
  assert.deepEqual(out.map((i) => i.id).sort(), [1, 2, 4]);
});
test('filterRecordingsByVehicle: the original-complaint (no vehicle) survives every chip', () => {
  const orig = { id: 'orig', v: null };
  const items = [orig, { id: 'a', v: 'truckA' }, { id: 'b', v: 'truckB' }];
  for (const chip of ['truckA', 'truckB']) {
    assert.ok(filterRecordingsByVehicle(items, chip, (i) => i.v).some((i) => i.id === 'orig'),
      `original-complaint must appear under ${chip}`);
  }
});

// ── canAssignRecording: confirmed only ──────────────────────
test('canAssignRecording: only confirmed rows are assignable', () => {
  assert.equal(canAssignRecording({ confirmed: true }), true);
  assert.equal(canAssignRecording({ confirmed: false }), false);
  assert.equal(canAssignRecording({}), false);
  assert.equal(canAssignRecording(null), false);
});

// ── customerCounts ──────────────────────────────────────────
test('customerCounts: visits = RO count; since = earliest RO created_at', () => {
  const ros = [
    { created_at: '2026-03-01' }, { created_at: '2026-01-15' }, { created_at: '2026-02-10' },
  ];
  const r = customerCounts(ros);
  assert.equal(r.visits, 3);
  assert.equal(r.sinceIso, '2026-01-15');
});
test('customerCounts: no ROs → 0 visits, null since', () => {
  assert.deepEqual(customerCounts([]), { visits: 0, sinceIso: null });
});

// ── openRosOf ───────────────────────────────────────────────
test('openRosOf: excludes closed + declined; newest first', () => {
  const ros = [
    { id: 1, status: 'closed', created_at: '2026-05-01' },
    { id: 2, status: 'ro', created_at: '2026-04-01' },
    { id: 3, status: 'estimate', declined_at: '2026-03-02', created_at: '2026-03-01' },
    { id: 4, status: 'invoice', created_at: '2026-06-01' },
  ];
  assert.deepEqual(openRosOf(ros).map((r) => r.id), [4, 2]);
});

// ── sortNewestFirst ─────────────────────────────────────────
test('sortNewestFirst: history newest first', () => {
  const ros = [{ id: 1, created_at: '2026-01-01' }, { id: 2, created_at: '2026-03-01' }, { id: 3, created_at: '2026-02-01' }];
  assert.deepEqual(sortNewestFirst(ros).map((r) => r.id), [2, 3, 1]);
});

// ── roInvoiceTotal / totalsByRo ─────────────────────────────
test('roInvoiceTotal: Σ qty·price + tax on taxable lines', () => {
  const lines = [
    { quantity: 2, unit_price: 100, taxable: false },  // 200 labor, not taxed
    { quantity: 1, unit_price: 50, taxable: true },    // 50 parts, taxed
  ];
  assert.equal(roInvoiceTotal(lines, { rate: 0.07, exempt: false }), 200 + 50 + 50 * 0.07);
});
test('roInvoiceTotal: exempt customer pays no tax', () => {
  const lines = [{ quantity: 1, unit_price: 100, taxable: true }];
  assert.equal(roInvoiceTotal(lines, { rate: 0.07, exempt: true }), 100);
});
test('roInvoiceTotal: empty lines → 0', () => {
  assert.equal(roInvoiceTotal([], { rate: 0.07 }), 0);
});
test('totalsByRo groups lines by repair_order_id', () => {
  const lines = [
    { repair_order_id: 'A', quantity: 1, unit_price: 10, taxable: false },
    { repair_order_id: 'A', quantity: 2, unit_price: 5, taxable: false },
    { repair_order_id: 'B', quantity: 1, unit_price: 99, taxable: false },
  ];
  const t = totalsByRo(lines, { rate: 0, exempt: false });
  assert.equal(t.A, 20);
  assert.equal(t.B, 99);
});
