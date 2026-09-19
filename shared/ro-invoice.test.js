/* ============================================================
   ro-invoice.test.js — unit tests for the shared RO/invoice builder.
   Run: npm test  (node --test)

   Locks the document-identity + body-selection rules both consumers rely on:
   estimate/ro/unpaid → the authorization + signature block (unchanged); paid
   invoice → the PAID block (stamp, payment lines, $0 balance, combined method)
   REPLACING the auth/signature; receipt mode → the diag-fee one-liner. Also
   locks the totals math (package folds into Parts; tax fallback; exempt).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceHtml, buildPrintDoc, INVOICE_CSS } from './ro-invoice.js';

const SETTINGS = { tax_rate: 0.07, shop_name: 'Lee Transmission', show_tech_on_ro: false };
const LINES = [
  { line_type: 'labor', description: 'R&R TRANS', quantity: 5, unit_price: 140, taxable: true },   // 700
  { line_type: 'parts', description: 'FILTER', part_number: 'F1', quantity: 2, unit_price: 50, taxable: true }, // 100
  { line_type: 'package', description: '6L80', quantity: 1, unit_price: 900, taxable: true },       // 900 → Parts
  { line_type: 'shop_supply', description: 'SUPPLIES', quantity: 1, unit_price: 20, taxable: true },  // 20
];
// subtotal = 1720 taxable; tax 7% = 120.40; invoice total = 1840.40
const roBase = (status) => ({
  status, ro_number: 6001, complaint: 'noise', customers: { name: 'JANE DOE', tax_exempt: false },
  vehicles: { year: 2015, make: 'Nissan', model: 'Rogue' }, service_writer: { name: 'Josh' },
});

// ── document identity ────────────────────────────────────────
test('estimate status → ESTIMATE label + auth/signature block, no PAID', () => {
  const html = buildInvoiceHtml({ ro: roBase('estimate'), lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(html, /ESTIMATE #6001/);
  assert.match(html, /Original estimate total/);
  assert.match(html, /Customer signature/);
  assert.doesNotMatch(html, /class="paidstamp"/);
});

test('unpaid invoice → INVOICE label + auth/signature (unchanged), no PAID', () => {
  const html = buildInvoiceHtml({ ro: roBase('invoice'), lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(html, /INVOICE #6001/);
  assert.match(html, /Customer signature/);
  assert.doesNotMatch(html, /class="paidstamp"/);
});

// ── PAID state (B) ───────────────────────────────────────────
test('closed + fully paid → PAID block REPLACES auth/signature', () => {
  const pays = [
    { amount: 2000, method: 'cash', paid_at: '2026-08-04T15:00:00Z' },
    { amount: 3294.10, method: 'card', paid_at: '2026-08-05T16:00:00Z' },   // Σ = 5294.10 ≥ 1840.40
  ];
  const html = buildInvoiceHtml({ ro: roBase('closed'), lines: LINES, settings: SETTINGS, payments: pays });
  assert.match(html, /class="paidstamp">PAID/);
  assert.match(html, /Balance Due/);
  assert.match(html, /Paid — Cash/);
  assert.match(html, /Paid — Card/);
  assert.match(html, /Cash \+ Card/);            // combined method summary
  assert.doesNotMatch(html, /Customer signature/); // auth/signature gone
  assert.doesNotMatch(html, /Original estimate total/);
});

test('invoice with a PARTIAL payment is NOT paid (keeps auth block)', () => {
  const html = buildInvoiceHtml({ ro: roBase('invoice'), lines: LINES, settings: SETTINGS,
    payments: [{ amount: 100, method: 'cash', paid_at: '2026-08-04T15:00:00Z' }] });
  assert.doesNotMatch(html, /class="paidstamp"/);
  assert.match(html, /Customer signature/);
});

test('estimate is NEVER paid even if payments exist (status gate)', () => {
  const html = buildInvoiceHtml({ ro: roBase('estimate'), lines: LINES, settings: SETTINGS,
    payments: [{ amount: 99999, method: 'cash', paid_at: '2026-08-04T15:00:00Z' }] });
  assert.doesNotMatch(html, /class="paidstamp"/);
});

test('paid block honors a custom methodLabel', () => {
  const html = buildInvoiceHtml({ ro: roBase('closed'), lines: LINES, settings: SETTINGS,
    payments: [{ amount: 5294.10, method: 'koalifi', paid_at: '2026-08-05T16:00:00Z' }],
    methodLabel: (v) => ({ koalifi: 'Koalifi Financing' }[v] || v) });
  assert.match(html, /Paid — Koalifi Financing/);
});

// ── receipt mode ─────────────────────────────────────────────
test('receipt mode → RECEIPT label + diag one-liner, no work sections', () => {
  const html = buildInvoiceHtml({ ro: roBase('closed'), lines: LINES, settings: SETTINGS,
    receipt: { amount: 150, description: 'Diagnostic fee', method: 'card', receiptNumber: 'R-6001', estimateNumber: 6001 } });
  assert.match(html, /RECEIPT R-6001/);
  assert.match(html, /Diagnostic fee/);
  assert.match(html, /Paid — Card/);
  assert.doesNotMatch(html, /Work Performed/);
});

// ── totals math ──────────────────────────────────────────────
test('package folds into Parts; tax + total correct', () => {
  const html = buildInvoiceHtml({ ro: roBase('invoice'), lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(html, /Parts<\/td><td class="tr">\$1000\.00/);   // 100 parts + 900 package
  assert.match(html, /Taxes \(7\.00%\)<\/td><td class="tr">\$120\.40/);
  assert.match(html, /Invoice Total<\/td><td class="tr">\$1840\.40/);
});

test('tax_exempt customer → no tax; missing tax_rate → 7% fallback', () => {
  const exemptHtml = buildInvoiceHtml({ ro: { ...roBase('invoice'), customers: { name: 'X', tax_exempt: true } }, lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(exemptHtml, /Taxes \(exempt\)<\/td><td class="tr">\$0\.00/);
  const noRate = buildInvoiceHtml({ ro: roBase('invoice'), lines: LINES, settings: { shop_name: 'Lee' }, payments: [] });
  assert.match(noRate, /Taxes \(7\.00%\)/);   // fallback 0.07
});

// ── print doc wrapper ────────────────────────────────────────
test('buildPrintDoc wraps the fragment in a standalone doc with scoped CSS + print onload', () => {
  const doc = buildPrintDoc({ ro: roBase('invoice'), lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /window\.print\(\)/);
  assert.match(doc, /<div class="roinv">/);
  assert.match(doc, /@page \{ size: letter/);
});

test('INVOICE_CSS is fully scoped under .roinv (safe to inject into a board)', () => {
  // every non-empty, non-@ rule selector must start with .roinv
  const rules = INVOICE_CSS.split('}').map(s => s.split('{')[0].trim()).filter(Boolean);
  for (const sel of rules) {
    if (sel.startsWith('@')) continue;
    assert.ok(sel.startsWith('.roinv'), `unscoped selector leaked: "${sel}"`);
  }
});

// ── fee lines print BY NAME (display only) ───────────────────
// Base LINES total 1840.40 (subtotal 1720 taxable, tax 120.40). A non-taxable
// card fee of 73.62 (4% of 1840.40) must add exactly 73.62 to the total.
const CARD_FEE = { line_type: 'fee', description: 'Card processing fee (4.00%)', quantity: 1, unit_price: 73.62, taxable: false };
const totalOf = (html) => (html.match(/Invoice Total<\/td><td class="tr">\$([\d.]+)/) || [])[1];

test('a card fee prints as its own totals row with its stored description — not "Fees"', () => {
  const html = buildInvoiceHtml({ ro: roBase('invoice'), lines: [...LINES, CARD_FEE], settings: SETTINGS, payments: [] });
  assert.match(html, /<tr><td>Card processing fee \(4\.00%\)<\/td><td class="tr">\$73\.62<\/td><\/tr>/);
  assert.doesNotMatch(html, />Fees</);
  // it sits in the totals box, between Shop Supplies and Taxes, where "Fees" was
  assert.ok(html.indexOf('Shop Supplies') < html.indexOf('Card processing fee') &&
            html.indexOf('Card processing fee') < html.indexOf('Taxes ('));
});

test('totals are unchanged by the fee display: fee added once, tax untouched', () => {
  const without = buildInvoiceHtml({ ro: roBase('invoice'), lines: LINES, settings: SETTINGS, payments: [] });
  const withFee = buildInvoiceHtml({ ro: roBase('invoice'), lines: [...LINES, CARD_FEE], settings: SETTINGS, payments: [] });
  assert.equal(totalOf(without), '1840.40');
  assert.equal(totalOf(withFee), '1914.02');                     // 1840.40 + 73.62, to the cent
  assert.match(withFee, /Taxes \(7\.00%\)<\/td><td class="tr">\$120\.40/);   // non-taxable fee adds no tax
  assert.match(withFee, /Original estimate total: <b>\$1914\.02/);
});

test('an RO with no fee line shows no fee row and no "Fees"', () => {
  const html = buildInvoiceHtml({ ro: roBase('estimate'), lines: LINES, settings: SETTINGS, payments: [] });
  assert.doesNotMatch(html, /Fees|[Pp]rocessing fee|<tr><td>Fee<\/td>/);
});

test('old stored wording is printed exactly as written, and a TAXABLE fee is still taxed', () => {
  const oldFee = { line_type: 'fee', description: 'CARD PROCESSING FEE', quantity: 1, unit_price: 100, taxable: true };
  const html = buildInvoiceHtml({ ro: roBase('closed'), lines: [...LINES, oldFee], settings: SETTINGS, payments: [] });
  assert.match(html, /<tr><td>CARD PROCESSING FEE<\/td><td class="tr">\$100\.00<\/td><\/tr>/);
  assert.match(html, /Taxes \(7\.00%\)<\/td><td class="tr">\$127\.40/);   // (1720 + 100) × 7%
  assert.equal(totalOf(html), '1947.40');                                 // 1820 + 127.40
});

test('several fee lines → one row each; blank description → "Fee"; description is escaped', () => {
  const fees = [
    { line_type: 'fee', description: 'Card processing fee (4.00%)', quantity: 1, unit_price: 10, taxable: false },
    { line_type: 'fee', description: '   ', quantity: 1, unit_price: 5, taxable: false },
    { line_type: 'fee', description: 'Tow <b>& storage</b>', quantity: 2, unit_price: 7.5, taxable: false },
  ];
  const html = buildInvoiceHtml({ ro: roBase('ro'), lines: [...LINES, ...fees], settings: SETTINGS, payments: [] });
  assert.match(html, /<tr><td>Card processing fee \(4\.00%\)<\/td><td class="tr">\$10\.00/);
  assert.match(html, /<tr><td>Fee<\/td><td class="tr">\$5\.00/);
  assert.match(html, /<tr><td>Tow &lt;b&gt;&amp; storage&lt;\/b&gt;<\/td><td class="tr">\$15\.00/);
  assert.equal(totalOf(html), '1870.40');                        // 1840.40 + 10 + 5 + 15
});

test('a paid invoice with a card fee is still PAID against the same total', () => {
  const html = buildInvoiceHtml({ ro: roBase('closed'), lines: [...LINES, CARD_FEE], settings: SETTINGS,
    payments: [{ amount: 1914.02, method: 'card', paid_at: '2026-09-01T12:00:00Z' }] });
  assert.match(html, /PAID/);
  assert.match(html, /Balance Due<\/td><td class="tr">\$0\.00/);
  assert.match(html, /<tr><td>Card processing fee \(4\.00%\)<\/td>/);
});

// ── "Warranty given" block + line breaks (ro-invoice.md §5) ─────
const W1 = 'Transmission Rebuild — 1 year or 12,000 miles parts & labor warranty, whichever comes first.';
const W2 = 'Customer-provided parts — no warranty can be given on this repair.';
const PAID = [{ amount: 1840.40, method: 'cash', paid_at: '2026-09-19T15:00:00Z' }];
const withW = (status, extra) => ({ ...roBase(status), warranty_terms: W1 + '\n' + W2, ...(extra || {}) });
const idx = (html, re) => { const m = html.match(re); return m ? m.index : -1; };

test('warranty: on estimate / RO / unpaid invoice it prints after the totals, just ABOVE the authorization + signature', () => {
  for (const status of ['estimate', 'ro', 'invoice']) {
    const html = buildInvoiceHtml({ ro: withW(status), lines: LINES, settings: SETTINGS, payments: [] });
    const w = idx(html, /<div class="warranty">/), total = idx(html, /Invoice Total/), auth = idx(html, /<div class="auth">/);
    assert.ok(w > 0, status + ': block present');
    assert.ok(total < w && w < auth, status + ': totals → warranty → authorization');
    assert.match(html, /<h2>Warranty<\/h2>/);
  }
});

test('warranty: on a PAID invoice it prints just ABOVE the PAID block', () => {
  const html = buildInvoiceHtml({ ro: withW('closed'), lines: LINES, settings: SETTINGS, payments: PAID });
  assert.match(html, /class="paidstamp">PAID/);
  const w = idx(html, /<div class="warranty">/), total = idx(html, /Invoice Total/), paid = idx(html, /<div class="paid">/);
  assert.ok(total < w && w < paid, 'totals → warranty → PAID');
  assert.doesNotMatch(html, /Customer signature/);
});

test('warranty: blank / whitespace / missing → NO block at all', () => {
  for (const v of [null, undefined, '', '   \n ']) {
    const html = buildInvoiceHtml({ ro: { ...roBase('invoice'), warranty_terms: v }, lines: LINES, settings: SETTINGS, payments: [] });
    assert.doesNotMatch(html, /class="warranty"/, JSON.stringify(v));
    assert.doesNotMatch(html, /<h2>Warranty<\/h2>/);
  }
});

test('warranty: NEVER on the diag-fee receipt', () => {
  const html = buildInvoiceHtml({ ro: withW('closed'), lines: LINES, settings: SETTINGS,
    receipt: { amount: 150, description: 'Diagnostic fee', method: 'cash', receiptNumber: 'R-6001', estimateNumber: 6001 } });
  assert.doesNotMatch(html, /class="warranty"/);
});

test('warranty: printed as saved — escaped, line breaks KEPT (pre-line), text between the lines intact', () => {
  const html = buildInvoiceHtml({ ro: withW('invoice', { warranty_terms: W1 + '\n<b>x</b> & more' }), lines: LINES, settings: SETTINGS, payments: [] });
  const block = html.slice(idx(html, /<div class="warranty">/), idx(html, /<div class="auth">/));
  assert.match(block, /<div class="wtext">Transmission Rebuild — 1 year or 12,000 miles parts &amp; labor warranty, whichever comes first\.\n&lt;b&gt;x&lt;\/b&gt; &amp; more<\/div>/);
  assert.match(INVOICE_CSS, /\.roinv \.warranty \.wtext \{ white-space: pre-line; \}/);
});

test('advisory notes: line breaks KEPT — wrapped in .ml (pre-line); "—" when blank', () => {
  const html = buildInvoiceHtml({ ro: { ...roBase('invoice'), advisory_notes: 'LEAK AT PAN\nCHECK MOUNTS' }, lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(html, /<b>Advisory notes<\/b> <span class="ml">LEAK AT PAN\nCHECK MOUNTS<\/span>/);
  assert.match(INVOICE_CSS, /\.roinv \.kv \.ml \{[^}]*white-space: pre-line;[^}]*\}/);
  const blank = buildInvoiceHtml({ ro: roBase('invoice'), lines: LINES, settings: SETTINGS, payments: [] });
  assert.match(blank, /<b>Advisory notes<\/b> <span class="ml">—<\/span>/);
});

test('warranty block ONLY adds itself: totals, PAID decision and every other byte unchanged', () => {
  const a = buildInvoiceHtml({ ro: roBase('closed'), lines: LINES, settings: SETTINGS, payments: PAID });
  const b = buildInvoiceHtml({ ro: withW('closed'), lines: LINES, settings: SETTINGS, payments: PAID });
  assert.equal(totalOf(a), totalOf(b));
  assert.equal(/class="paidstamp"/.test(a), /class="paidstamp"/.test(b));
  // Strip the one warranty block → byte-identical to the same RO without a warranty.
  assert.equal(b.replace(/\n  <div class="warranty">[\s\S]*?\n  <\/div>/, ''), a);
});
