/* ============================================================
   line-qty.test.js — strict number parsing for the Add/Edit-Line pop-up.
   Run: npm test   (node --test)

   Locks: the accepted shapes (14 · 14.5 · .5 · "14,5"), that everything else
   is REJECTED rather than half-read (the old number input turned "14,5" into
   145), 2-dp half-up rounding, qty > 0, money >= 0 with the old blank
   defaults, the >24 h confirm threshold, and the live math line's wording.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOURS_CONFIRM_ABOVE, round2, parseDecimal, parseQty, parseMoney,
  needsHoursConfirm, formatQty, formatMoney, formatRate, laborMathLine,
} from './line-qty.js';

const val = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
const bad = (r) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.ok(r.error); return r.error; };

test('accepted shapes', () => {
  assert.equal(val(parseQty('14')), 14);
  assert.equal(val(parseQty('14.5')), 14.5);
  assert.equal(val(parseQty('14.25')), 14.25);
  assert.equal(val(parseQty('.5')), 0.5);
  assert.equal(val(parseQty('14.')), 14);
  assert.equal(val(parseQty('  14.5  ')), 14.5);
  assert.equal(val(parseQty('0.5')), 0.5);
});

test('decimal comma: 1–2 digits after it', () => {
  assert.equal(val(parseQty('14,5')), 14.5);
  assert.equal(val(parseQty('14,25')), 14.25);
  assert.equal(val(parseQty(',5')), 0.5);
});

test('everything else is rejected, never half-read', () => {
  for (const s of ['1,250', '1,250.00', '$140', '14 hrs', '14h', '-2', '+2', '1e3', '1.2.3',
                   '14,5,0', '14,', ',', '.', 'abc', '١٤', '14 5', '0x10', 'Infinity', 'NaN']) {
    bad(parseDecimal(s));
  }
});

test('thousands comma gets its own hint', () => {
  assert.match(bad(parseMoney('1,250')), /thousands/);
  assert.match(bad(parseMoney('12,500.00')), /thousands/);
  assert.match(bad(parseQty('14 hrs')), /numbers only/);
});

test('rounds to 2 dp, half-up, no float drift', () => {
  assert.equal(val(parseQty('14.125')), 14.13);
  assert.equal(val(parseQty('1.005')), 1.01);
  assert.equal(val(parseQty('2.675')), 2.68);
  assert.equal(val(parseQty('14.124')), 14.12);
  assert.equal(round2(1e-7), 0);
});

test('qty: blank and zero are errors', () => {
  bad(parseQty(''));
  bad(parseQty('   '));
  bad(parseQty(null));
  assert.match(bad(parseQty('0')), /more than 0/);
  assert.match(bad(parseQty('0.004')), /more than 0/);   // rounds to 0
});

test('money: >= 0, blank keeps the old default', () => {
  assert.equal(val(parseMoney('140')), 140);
  assert.equal(val(parseMoney('0')), 0);
  assert.equal(val(parseMoney('139,99')), 139.99);
  assert.equal(val(parseMoney('')), 0);            // Rate / Sell / Price / Amount
  assert.equal(val(parseMoney('', null)), null);   // optional parts Cost
  bad(parseMoney('-5'));
});

test('hours confirm above 24 only', () => {
  assert.equal(HOURS_CONFIRM_ABOVE, 24);
  assert.equal(needsHoursConfirm(24), false);
  assert.equal(needsHoursConfirm(22), false);
  assert.equal(needsHoursConfirm(24.01), true);
  assert.equal(needsHoursConfirm(114), true);
});

test('formatting', () => {
  assert.equal(formatQty(14), '14');
  assert.equal(formatQty(14.5), '14.5');
  assert.equal(formatQty(14.25), '14.25');
  assert.equal(formatMoney(1960), '$1,960.00');
  assert.equal(formatMoney(1994.8575), '$1,994.86');
  assert.equal(formatRate(140), '$140');
  assert.equal(formatRate(139.5), '$139.50');
  assert.equal(formatRate(1250), '$1,250');
});

test('labor math line', () => {
  assert.equal(laborMathLine('14', '140'), '14 h × $140 = $1,960.00');
  assert.equal(laborMathLine('14.25', '140'), '14.25 h × $140 = $1,995.00');
  assert.equal(laborMathLine('14,5', '139.99'), '14.5 h × $139.99 = $2,029.86');
  assert.equal(laborMathLine('14', '140', ''), '14 × $140 = $1,960.00');   // Book Hours OFF → "Qty"
  assert.equal(laborMathLine('14', ''), '14 h × $0 = $0.00');
  assert.equal(laborMathLine('14,5,0', '140'), null);
  assert.equal(laborMathLine('', '140'), null);
  assert.equal(laborMathLine('14', '$140'), null);
});
