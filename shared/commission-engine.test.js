/* ============================================================
   commission-engine.test.js — unit tests for the advisor GP + commission engine.
   Run: npm test   (node --test)

   Locks the pay-critical behavior: the locked GP formula (labor + parts markup +
   package margin; fees excluded), the real-cost-overrides-assumed-margin rule,
   per-advisor plans with code defaults, the weekly-final commission math, and the
   Sun–Sat / America/New_York bucketing by the stable closed_at that both cards read.
   Dates are pinned via an injected nowIso so the run is deterministic.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASE_WEEKLY, DEFAULT_GP_PCT, DEFAULT_PARTS_MARGIN, DEFAULT_PACKAGE_MARGIN,
  lineGrossProfit, roGrossProfit, advisorPlan, commissionOf,
  weekWindow, monthWindows, weeksInMonthToDate, compute,
} from './commission-engine.js';

// A Wednesday: 2026-08-05T16:00:00Z = 12:00 EDT Wed → NY week Sun Aug 2 .. Sat Aug 8.
const NOW = '2026-08-05T16:00:00Z';

// ── line-level GP ────────────────────────────────────────────
test('labor line GP is full revenue (labor ≈ pure margin)', () => {
  assert.equal(lineGrossProfit({ line_type: 'labor', quantity: 4, unit_price: 150 }, {}), 600);
});

test('parts line GP = markup when a real unit_cost is present (overrides assumed %)', () => {
  const gp = lineGrossProfit({ line_type: 'parts', quantity: 2, unit_price: 100, unit_cost: 60 }, { partsMarginPct: 0.9 });
  assert.equal(gp, 80);   // (100-60)*2, NOT 200*0.9
});

test('parts line GP falls back to assumed margin when unit_cost is null', () => {
  const gp = lineGrossProfit({ line_type: 'parts', quantity: 2, unit_price: 100, unit_cost: null }, { partsMarginPct: 0.40 });
  assert.equal(gp, 80);   // 200 * 0.40
});

test('parts fallback uses the DEFAULT margin when none supplied', () => {
  const gp = lineGrossProfit({ line_type: 'parts', quantity: 1, unit_price: 100 }, {});
  assert.equal(gp, 100 * DEFAULT_PARTS_MARGIN);
});

test('package line GP = price − per-unit cost when the unit cost is known', () => {
  const gp = lineGrossProfit(
    { line_type: 'package', quantity: 1, unit_price: 4950, package_unit_id: 'u1' },
    { packageCostById: { u1: 3000 } });
  assert.equal(gp, 1950);
});

test('package line GP falls back to assumed package margin when no unit cost', () => {
  const gp = lineGrossProfit(
    { line_type: 'package', quantity: 1, unit_price: 5000, package_unit_id: 'uX' },
    { packageMarginPct: 0.55, packageCostById: {} });
  assert.equal(gp, 2750);
});

test('fee / shop_supply / hazmat lines contribute ZERO GP (excluded)', () => {
  assert.equal(lineGrossProfit({ line_type: 'fee', quantity: 1, unit_price: 50 }, {}), 0);
  assert.equal(lineGrossProfit({ line_type: 'shop_supply', quantity: 1, unit_price: 30 }, {}), 0);
  assert.equal(lineGrossProfit({ line_type: 'hazmat', quantity: 1, unit_price: 20 }, {}), 0);
});

test('roGrossProfit sums the lines under the locked formula', () => {
  const lines = [
    { line_type: 'labor', quantity: 5, unit_price: 150 },              // 750
    { line_type: 'parts', quantity: 1, unit_price: 200, unit_cost: 120 }, // 80
    { line_type: 'shop_supply', quantity: 1, unit_price: 40 },         // 0
  ];
  assert.equal(roGrossProfit(lines, {}), 830);
});

// ── plans + commission ───────────────────────────────────────
test('advisorPlan applies code defaults for null base/pct (Manny = the default)', () => {
  assert.deepEqual(advisorPlan({}), { baseWeekly: DEFAULT_BASE_WEEKLY, gpPct: DEFAULT_GP_PCT });
  assert.deepEqual(advisorPlan(null), { baseWeekly: DEFAULT_BASE_WEEKLY, gpPct: DEFAULT_GP_PCT });
});

test('advisorPlan reads per-advisor overrides when set', () => {
  assert.deepEqual(advisorPlan({ commission_base_weekly: 1200, commission_gp_pct: 3 }), { baseWeekly: 1200, gpPct: 3 });
});

test('commissionOf is gpPct% of GP (weekly-final)', () => {
  assert.equal(commissionOf(10000, { gpPct: 2.5 }), 250);
  assert.equal(commissionOf(10000, {}), 10000 * DEFAULT_GP_PCT / 100);
});

// ── date windows ─────────────────────────────────────────────
test('weekWindow is the Sun–Sat NY week containing NOW', () => {
  assert.deepEqual(weekWindow(NOW), { startYmd: '2026-08-02', endYmd: '2026-08-08' });
});

test('monthWindows gives month-to-date and the prior full month', () => {
  const w = monthWindows(NOW);
  assert.equal(w.monthKey, '2026-08');
  assert.deepEqual(w.thisMonth, { startYmd: '2026-08-01', endYmd: '2026-08-05' });
  assert.deepEqual(w.lastMonth, { startYmd: '2026-07-01', endYmd: '2026-07-31' });
});

test('weeksInMonthToDate counts the Sun–Sat weeks overlapping the month so far', () => {
  // Aug 2026: weeks starting Jul 26, Aug 2 overlap [Aug 1 .. Aug 5] → 2.
  assert.equal(weeksInMonthToDate(NOW), 2);
});

// ── the full rollup both cards read ──────────────────────────
const EMPLOYEES = [
  { id: 'josh', name: 'Josh', role: 'advisor', active: true, commission_base_weekly: null, commission_gp_pct: null },
  { id: 'manny', name: 'Manny', role: 'advisor', active: true, commission_base_weekly: 1000, commission_gp_pct: 2.5 },
];
const PKG_UNITS = [{ id: 'u1', unit_cost: 3000 }];

function roLines() {
  return {
    ros: [
      // Josh, this week (closed Aug 4)
      { id: 'ro1', service_writer_id: 'josh', status: 'closed', closed_at: '2026-08-04T15:00:00Z' },
      // Manny, this week (invoice Aug 6)
      { id: 'ro2', service_writer_id: 'manny', status: 'invoice', closed_at: '2026-08-06T18:00:00Z' },
      // Josh, earlier this month but not this week (Aug 1)
      { id: 'ro3', service_writer_id: 'josh', status: 'closed', closed_at: '2026-08-01T15:00:00Z' },
      // No writer — must be credited to NO ONE
      { id: 'ro4', service_writer_id: null, status: 'closed', closed_at: '2026-08-04T15:00:00Z' },
      // Wrong status — must be ignored
      { id: 'ro5', service_writer_id: 'josh', status: 'estimate', closed_at: '2026-08-04T15:00:00Z' },
    ],
    lines: [
      { repair_order_id: 'ro1', line_type: 'labor', quantity: 10, unit_price: 150 },  // 1500
      { repair_order_id: 'ro1', line_type: 'parts', quantity: 1, unit_price: 500, unit_cost: 300 }, // 200
      { repair_order_id: 'ro2', line_type: 'package', quantity: 1, unit_price: 4950, package_unit_id: 'u1' }, // 1950
      { repair_order_id: 'ro3', line_type: 'labor', quantity: 4, unit_price: 150 },   // 600
      { repair_order_id: 'ro4', line_type: 'labor', quantity: 8, unit_price: 150 },   // 1200 (unassigned)
      { repair_order_id: 'ro5', line_type: 'labor', quantity: 99, unit_price: 150 },  // ignored (estimate)
    ],
  };
}

test('compute buckets GP per advisor for the week and credits no-writer ROs to no one', () => {
  const { ros, lines } = roLines();
  const r = compute({ ros, lines, employees: EMPLOYEES, packageUnits: PKG_UNITS, settings: {}, nowIso: NOW });

  // Josh this week = ro1 only (ro3 is earlier in the month, ro5 ignored) = 1500+200 = 1700
  assert.equal(r.advisors.Josh.week.gp, 1700);
  assert.equal(r.advisors.Josh.week.roCount, 1);
  assert.equal(r.advisors.Josh.week.commission, 42.5);            // 2.5% of 1700
  assert.equal(r.advisors.Josh.week.base, 1000);
  assert.equal(r.advisors.Josh.week.pay, 1042.5);                 // the check for the week

  // Manny this week = ro2 package = 1950 → 48.75 commission
  assert.equal(r.advisors.Manny.week.gp, 1950);
  assert.equal(r.advisors.Manny.week.commission, 48.75);
  assert.equal(r.advisors.Manny.week.pay, 1048.75);

  // Josh this month = ro1 (1700) + ro3 (600) = 2300
  assert.equal(r.advisors.Josh.month.gp, 2300);
  assert.equal(r.advisors.Josh.month.roCount, 2);
  assert.equal(r.advisors.Josh.month.commission, 57.5);           // 2.5% of 2300
  assert.equal(r.advisors.Josh.month.baseAccrued, 2000);          // 1000 × 2 weeks MTD

  // no-writer RO4's 1200 is credited to no one, never paid
  assert.equal(r.unassigned.week.gp, 1200);
  assert.equal(r.advisors.Unassigned, undefined);
});

test('compute totals sum the advisors for the owner "Pay this week" line', () => {
  const { ros, lines } = roLines();
  const r = compute({ ros, lines, employees: EMPLOYEES, packageUnits: PKG_UNITS, settings: {}, nowIso: NOW });
  assert.equal(r.totals.week.gp, 1700 + 1950);                    // 3650
  assert.equal(r.totals.week.roCount, 2);
  assert.equal(r.totals.week.commission, 42.5 + 48.75);           // 91.25
  assert.equal(r.totals.week.pay, 1042.5 + 1048.75);              // 2091.25 (2 advisors × base + comm)
});

test('compute does NOT pay a non-advisor writer (manager/owner) — GP goes to unassigned', () => {
  const employees = [
    { id: 'kev', name: 'Kevin', role: 'manager', active: true },
    { id: 'josh', name: 'Josh', role: 'advisor', active: true },
  ];
  const ros = [
    { id: 'a', service_writer_id: 'kev', status: 'closed', closed_at: '2026-08-04T15:00:00Z' },   // manager wrote it
    { id: 'b', service_writer_id: 'josh', status: 'closed', closed_at: '2026-08-04T15:00:00Z' },
  ];
  const lines = [
    { repair_order_id: 'a', line_type: 'labor', quantity: 10, unit_price: 150 },   // 1500 → unassigned
    { repair_order_id: 'b', line_type: 'labor', quantity: 2, unit_price: 150 },     // 300 → Josh
  ];
  const r = compute({ ros, lines, employees, packageUnits: [], settings: {}, nowIso: NOW });
  assert.equal(r.advisors.Kevin, undefined);          // manager not paid
  assert.equal(r.advisors.Josh.week.gp, 300);
  assert.equal(r.unassigned.week.gp, 1500);           // manager's GP parked, unpaid
});

test('compute honors shop-wide assumed margins for cost-less parts/packages', () => {
  const ros = [{ id: 'r', service_writer_id: 'josh', status: 'closed', closed_at: '2026-08-04T15:00:00Z' }];
  const lines = [
    { repair_order_id: 'r', line_type: 'parts', quantity: 1, unit_price: 1000 },              // no cost
    { repair_order_id: 'r', line_type: 'package', quantity: 1, unit_price: 2000, package_unit_id: 'zzz' }, // no cost
  ];
  const r = compute({ ros, lines, employees: EMPLOYEES, packageUnits: [], settings: { parts_margin_pct: 0.40, package_margin_pct: 0.55 }, nowIso: NOW });
  assert.equal(r.advisors.Josh.week.gp, 1000 * 0.40 + 2000 * 0.55);   // 400 + 1100 = 1500
});
