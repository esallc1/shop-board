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
