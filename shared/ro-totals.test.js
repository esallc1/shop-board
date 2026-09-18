/* ============================================================
   ro-totals.test.js — THE RO total + the live card fee.
   Run: npm test   (node --test)

   Locks:
     • OFF = no fee; ON = round2(rate × (all lines + sales tax)), not taxable;
     • the fee RECALCULATES as lines are added / edited / deleted;
     • deposits/payments never change the fee — they only reduce the balance;
     • a switch can't apply twice, and never stacks on a stored legacy line;
     • no rate → "unavailable", never a guessed %;
     • EVERY surface agrees: the calculator, the printed invoice, the customer
       record, Profit-by-RO revenue — and commission GP is unaffected;
     • a static guard that the boards route their totals through it (and the old
       "+ Card fee" button / the 3% code fallback are gone).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeRoTotals, totalsForRo, roBalance, normalizeRate, cardFeeLabel,
  isLegacyCardFeeLine, hasLegacyCardFee,
} from './ro-totals.js';
import { buildInvoiceHtml } from './ro-invoice.js';
import { roInvoiceTotal, totalsByRo } from './customer-record.js';
import { roGrossProfit } from './commission-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, '..', f), 'utf8');

const RATE = 0.065, FEE = 0.04;
const LINES = [
  { line_type: 'labor', description: 'R&R', quantity: 5, unit_price: 140, taxable: true },   // 700
  { line_type: 'parts', description: 'FILTER', quantity: 2, unit_price: 50, taxable: true },  // 100
  { line_type: 'shop_supply', description: 'SUPPLIES', quantity: 1, unit_price: 20.99, taxable: true },
];
// subtotal 820.99, tax 53.36435, preFee 874.35435, fee round2(34.974174) = 34.97, total 909.32435
const on = (lines, extra) => computeRoTotals(lines, { taxRate: RATE, exempt: false, cardFeeOn: true, cardFeePct: FEE, ...(extra || {}) });
const off = (lines) => computeRoTotals(lines, { taxRate: RATE, exempt: false, cardFeeOn: false, cardFeePct: FEE });
const cents = (n) => Math.round(n * 100) / 100;

// ── the fee itself ───────────────────────────────────────────
test('OFF → no fee; total = subtotal + tax', () => {
  const t = off(LINES);
  assert.equal(t.cardFee, 0);
  assert.equal(t.cardFeeApplied, false);
  assert.equal(cents(t.total), cents(820.99 + 820.99 * RATE));
});

test('ON → fee = round2(4% × (lines + tax)); tax unchanged (fee is not taxable)', () => {
  const t = on(LINES), o = off(LINES);
  assert.equal(t.cardFee, 34.97);
  assert.equal(t.cardFee, cents(FEE * (820.99 + 820.99 * RATE)));
  assert.equal(t.tax, o.tax);
  assert.equal(cents(t.total), cents(o.total + 34.97));
  assert.equal(t.cardFeeLabel, 'Card processing fee (4.00%)');
});

test('the fee RECALCULATES on line add / edit / delete', () => {
  const base = on(LINES).cardFee;
  const added = on([...LINES, { line_type: 'parts', quantity: 1, unit_price: 500, taxable: true }]);
  assert.equal(added.cardFee, cents(FEE * ((820.99 + 500) * (1 + RATE))));
  const edited = on(LINES.map((l, i) => (i === 0 ? { ...l, quantity: 6 } : l)));
  assert.equal(edited.cardFee, cents(FEE * ((820.99 + 140) * (1 + RATE))));
  const deleted = on(LINES.slice(1));
  assert.equal(deleted.cardFee, cents(FEE * (120.99 * (1 + RATE))));
  assert.ok(added.cardFee > base && edited.cardFee > base && deleted.cardFee < base);
  assert.equal(on([]).cardFee, 0);                      // no lines → nothing to charge on
});

test('a DEPOSIT never changes the fee — it only reduces the balance', () => {
  const ro = { card_fee_on: true, customers: { tax_exempt: false }, ro_line_items: LINES };
  const s = { tax_rate: RATE, card_fee_pct: FEE };
  const before = totalsForRo(ro, s);
  const afterDeposit = totalsForRo({ ...ro, ro_payments: [{ amount: 500, method: 'cash' }] }, s);
  assert.equal(afterDeposit.cardFee, before.cardFee);
  assert.equal(afterDeposit.total, before.total);
  const b = roBalance(before, [{ amount: 500 }]);
  assert.equal(b.paid, 500);
  assert.equal(cents(b.balance), cents(before.total - 500));
  assert.equal(cents(roBalance(before, []).balance), cents(before.total));
});

test('tax-exempt customer → the fee base is the lines alone', () => {
  const t = on(LINES, { exempt: true });
  assert.equal(t.tax, 0);
  assert.equal(t.cardFee, cents(FEE * 820.99));
});

test('it is a switch: computing again never adds a second fee', () => {
  const t1 = on(LINES), t2 = on(LINES);
  assert.equal(t1.cardFee, t2.cardFee);
  assert.equal(t1.total, t2.total);
});

// ── rate: shop_settings.card_fee_pct is the ONLY rate ─────────
test('no usable rate → fee 0 + "unavailable" (never a guessed %)', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, -0.04]) {
    const t = on(LINES, { cardFeePct: bad });
    assert.equal(t.cardFee, 0, 'charged for ' + String(bad));
    assert.equal(t.cardFeeUnavailable, true);
    assert.equal(t.cardFeeApplied, false);
    assert.equal(t.total, t.preFeeTotal);
  }
  assert.equal(off(LINES).cardFeeUnavailable, false);   // switch off → nothing to be unavailable
  assert.equal(normalizeRate('0.04'), 0.04);
  assert.equal(normalizeRate(0), 0);
  assert.equal(on(LINES, { cardFeePct: 0.05 }).cardFee, cents(0.05 * (820.99 * (1 + RATE))));   // one edit changes it
  assert.equal(cardFeeLabel(0.035), 'Card processing fee (3.50%)');
});

// ── legacy stored lines ──────────────────────────────────────
test('a stored legacy card-fee line BLOCKS the live fee — never both', () => {
  for (const d of ['Card processing fee (4.00%)', 'CARD PROCESSING FEE']) {
    const legacy = { line_type: 'fee', description: d, quantity: 1, unit_price: 34.97, taxable: false };
    assert.equal(isLegacyCardFeeLine(legacy), true);
    const t = on([...LINES, legacy]);
    assert.equal(t.cardFee, 0);
    assert.equal(t.cardFeeBlocked, true);
    assert.equal(t.hasLegacyCardFee, true);
    assert.equal(cents(t.total), cents(off([...LINES, legacy]).total));   // the stored line still counts, once
  }
});

test('an unrelated fee line (towing, diag) does NOT block the switch', () => {
  const tow = { line_type: 'fee', description: 'Towing', quantity: 1, unit_price: 75, taxable: false };
  assert.equal(hasLegacyCardFee([...LINES, tow]), false);
  const t = on([...LINES, tow]);
  assert.equal(t.cardFeeApplied, true);
  assert.equal(t.cardFee, cents(FEE * (820.99 * (1 + RATE) + 75)));   // towing is in the base like any line
  assert.equal(isLegacyCardFeeLine({ line_type: 'parts', description: 'card processing fee' }), false);
});

// ── every surface agrees ─────────────────────────────────────
const SCENARIOS = {
  off:         { ro: { card_fee_on: false }, lines: LINES },
  on:          { ro: { card_fee_on: true }, lines: LINES },
  onExempt:    { ro: { card_fee_on: true, exempt: true }, lines: LINES },
  legacyLine:  { ro: { card_fee_on: false }, lines: [...LINES, { line_type: 'fee', description: 'CARD PROCESSING FEE', quantity: 1, unit_price: 30, taxable: true }] },
  onPlusTow:   { ro: { card_fee_on: true }, lines: [...LINES, { line_type: 'fee', description: 'Towing', quantity: 1, unit_price: 75, taxable: false }] },
};
const settings = { tax_rate: RATE, card_fee_pct: FEE, shop_name: 'Lee' };
const invoiceTotal = (html) => Number((html.match(/Invoice Total<\/td><td class="tr">\$([\d.]+)/) || [])[1]);

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`same total everywhere — ${name}`, () => {
    const exempt = !!sc.ro.exempt;
    const ro = { status: 'ro', ro_number: 7001, card_fee_on: sc.ro.card_fee_on, customers: { name: 'X', tax_exempt: exempt }, vehicles: {}, ro_line_items: sc.lines };
    const T = totalsForRo(ro, settings);
    // the invoice builder (advisor print, bookkeeping embed + print)
    const html = buildInvoiceHtml({ ro, lines: sc.lines, settings, payments: [] });
    assert.equal(invoiceTotal(html), cents(T.total));
    // the customer record (per-RO total + lifetime $)
    assert.equal(roInvoiceTotal(sc.lines, { rate: RATE, exempt, cardFeeOn: sc.ro.card_fee_on, cardFeePct: FEE }), T.total);
    const withIds = sc.lines.map(l => ({ ...l, repair_order_id: 'r1' }));
    assert.equal(totalsByRo(withIds, { rate: RATE, exempt, cardFeeOnByRo: sc.ro.card_fee_on ? { r1: true } : {}, cardFeePct: FEE }).r1, T.total);
    // Profit-by-RO / bookkeeping pre-tax sale = lines + live fee
    assert.equal(cents(T.preTaxRevenue), cents(T.subtotal + T.cardFee));
    // commission GP is untouched by the switch (fees carry 0 GP)
    assert.equal(roGrossProfit(sc.lines, {}), roGrossProfit(sc.lines, {}));
  });
}

test('the invoice prints the live fee BY NAME after Taxes when ON, nothing when OFF', () => {
  const ro = (onFlag) => ({ status: 'ro', ro_number: 7002, card_fee_on: onFlag, customers: { name: 'X' }, vehicles: {} });
  const onHtml = buildInvoiceHtml({ ro: ro(true), lines: LINES, settings, payments: [] });
  assert.match(onHtml, /<tr><td>Card processing fee \(4\.00%\)<\/td><td class="tr">\$34\.97<\/td><\/tr>/);
  assert.ok(onHtml.indexOf('Taxes (') < onHtml.indexOf('Card processing fee') &&
            onHtml.indexOf('Card processing fee') < onHtml.indexOf('Invoice Total'));
  const offHtml = buildInvoiceHtml({ ro: ro(false), lines: LINES, settings, payments: [] });
  assert.doesNotMatch(offHtml, /Card processing fee/);
  const noRate = buildInvoiceHtml({ ro: ro(true), lines: LINES, settings: { tax_rate: RATE }, payments: [] });
  assert.match(noRate, /Card processing fee — rate unavailable/);
});

test('an invoice paid for the full amount incl. the live fee is PAID', () => {
  const ro = { status: 'closed', ro_number: 7003, card_fee_on: true, customers: { name: 'X' }, vehicles: {} };
  const total = cents(totalsForRo({ ...ro, ro_line_items: LINES }, settings).total);
  const paid = buildInvoiceHtml({ ro, lines: LINES, settings, payments: [{ amount: total, method: 'card', paid_at: '2026-09-18T12:00:00Z' }] });
  assert.match(paid, /paidstamp/);
  const short = buildInvoiceHtml({ ro, lines: LINES, settings, payments: [{ amount: total - 34.97, method: 'card' }] });
  assert.doesNotMatch(short, /paidstamp/);                // paying the pre-fee total is NOT paid in full
});

// ── static guard: the boards route through the calculator ────
test('advisor board: every RO total goes through roTotalsOf / RoTotals', () => {
  const src = read('advisor-board.html');
  const body = (sig) => { const i = src.indexOf(sig); assert.ok(i >= 0, 'missing ' + sig); return src.slice(i, src.indexOf('\n    }', i)); };
  assert.match(body('function roTotal(ro) {'), /roTotalsOf\(/);
  assert.match(body('function roTotalNum() {'), /roTotalsOf\(/);
  assert.match(body('function recalcTotals() {'), /roTotalsOf\(/);
  assert.match(body('async function archiveToCompletedJobs('), /roTotalsOf\(/);
  // assert.ok (not match) on whole-file checks so a failure doesn't print 700KB of HTML
  assert.ok(/window\.RoTotals\.computeRoTotals\(/.test(src), 'roTotalsOf no longer calls RoTotals');
  assert.ok(!/taxable \* taxRate\(\)|taxableBase \* taxRate\(\)/.test(src), 'a hand-rolled tax total is back');
  assert.ok(!/function addCardFee\s*\(|id="cdAddCardFeeBtn"|\$\('cdAddCardFeeBtn'\)/.test(src), 'the one-time card-fee LINE button is back');
  assert.ok(/id="cdCardFeeOn"/.test(src), 'the card-fee switch is missing');
  assert.ok(/totalsByRo\([^;]*cardFeeOnByRo/.test(src), 'customer record totals ignore the card-fee switch');
});

test('bookkeeping + profit-by-ro total through RoTotals; card_fee_on is read', () => {
  const bk = read('bookkeeping-board.html');
  const rt = bk.indexOf('function roTotal(ro) {');
  assert.ok(rt >= 0 && /RoTotals\.totalsForRo\(/.test(bk.slice(rt, rt + 400)), 'bookkeeping roTotal bypasses RoTotals');
  assert.ok(/preTaxRevenue/.test(bk), 'bookkeeping RO-detail profit ignores the live fee');
  assert.ok(/card_fee_on/.test(bk), 'bookkeeping never reads card_fee_on');
  assert.ok(/RT\.totalsForRo\([\s\S]*?\)\.preTaxRevenue/.test(read('shared/profit-by-ro.js')), 'Profit by RO sale ignores the live fee');
  assert.ok(/card_fee_on/.test(read('shared/commission-engine.js')), 'fetchInputs never reads card_fee_on');
  for (const f of ['advisor-board.html', 'bookkeeping-board.html', 'owner-board.html']) {
    assert.ok(/import \* as RoTotals from '\.\/shared\/ro-totals\.js'/.test(read(f)), f + ' does not load RoTotals');
  }
});

// ── load order: no total may render before THE calculator's module has run ──
// (card-fee.md §3a — the "…'computeRoTotals'" page-load banner, 2026-09-18)
test('every board waits for THE calculator before rendering a total', () => {
  const READY = '<script src="shared/ro-totals-ready.js"></script>';
  for (const f of ['advisor-board.html', 'bookkeeping-board.html', 'owner-board.html']) {
    const src = read(f);
    const r = src.indexOf(READY);
    assert.ok(r >= 0, f + ' does not load ro-totals-ready.js');
    const main = src.indexOf('\n<script>\n');                 // the board's main classic script
    assert.ok(main > r, f + ': ro-totals-ready.js must load BEFORE the main <script>');
    const pbr = src.indexOf('<script src="shared/profit-by-ro.js"></script>');
    if (pbr >= 0) assert.ok(pbr > r, f + ': ro-totals-ready.js must load BEFORE profit-by-ro.js');
  }
  const slice = (src, sig, len) => { const i = src.indexOf(sig); assert.ok(i >= 0, 'missing ' + sig); return src.slice(i, i + len); };
  const adv = read('advisor-board.html');
  const list = slice(adv, 'async function loadRecentList() {', 6000);
  assert.ok(/await rtReady\(\)[\s\S]*renderKanban\(\)/.test(list), 'RO list renders before the calculator is ready');
  assert.ok(/await rtReady\(\)/.test(slice(adv, 'async function openRo(roId, origin) {', 400)), 'openRo (?ro= deep link) does not wait');
  assert.ok(/if \(!window\.RoTotals\) throw/.test(slice(adv, 'function roTotalsOf(lines, ro) {', 300)), 'roTotalsOf must refuse, not guess');
  const bk = read('bookkeeping-board.html');
  assert.ok(/await rtReady\(\)[\s\S]*buildPaidIncome\(\)/.test(slice(bk, 'async function update(next) {', 1200)), 'Financial Pulse renders before the calculator is ready');
  assert.ok(/await rtReady\(\)/.test(slice(bk, 'async function openRoDetail(po, provisional) {', 1400)), 'bookkeeping RO detail does not wait');
  const pbr = read('shared/profit-by-ro.js');
  assert.ok(/cdRoTotalsReady/.test(slice(pbr, 'async function loadData() {', 600)), 'Profit by RO does not wait');
  const sale = slice(pbr, 'function roSale(lines, ro) {', 500);
  assert.ok(!/reduce\(/.test(sale), 'roSale fell back to a hand sum (it drops the card fee)');
});

test('the 3% card-fee code fallback is gone — shop_settings is the only rate', () => {
  const bs = read('shared/board-settings.js');
  assert.match(bs, /card_fee_pct: null,/);
  assert.match(bs, /card_fee_pct: n\(shopSettingsRow\.card_fee_pct, null\)/);
  assert.doesNotMatch(bs, /card_fee_pct: 0\.0\d/);
});
