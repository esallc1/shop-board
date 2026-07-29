/* ============================================================
   core-invoice-view.test.js — unit tests for the Core Bank image-view decisions.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreIsViewable, resolveImageOpen, fullRecordModal } from './core-invoice-view.js';

// ── coreIsViewable: NULL invoice_queue_id is not viewable ────
test('coreIsViewable is true only when invoice_queue_id is set', () => {
  assert.equal(coreIsViewable({ invoice_queue_id: 'b9e47d45' }), true);
  assert.equal(coreIsViewable({ invoice_queue_id: null }), false);   // schema-permitted null
  assert.equal(coreIsViewable({ invoice_queue_id: '' }), false);
  assert.equal(coreIsViewable({}), false);
  assert.equal(coreIsViewable(null), false);
});

// ── resolveImageOpen: never open a blank overlay ────────────
test('resolveImageOpen opens only when a signed URL is present', () => {
  assert.deepEqual(
    resolveImageOpen({ image_path: 'o-reilly/2026-07/x.jpg' }, { signedUrl: 'https://signed/x' }),
    { open: true, url: 'https://signed/x', reason: 'ok' },
  );
});

test('resolveImageOpen does NOT open when the sign step fails (no blank overlay)', () => {
  assert.deepEqual(resolveImageOpen({ image_path: 'x.jpg' }, null), { open: false, url: null, reason: 'sign-failed' });
  assert.deepEqual(resolveImageOpen({ image_path: 'x.jpg' }, {}), { open: false, url: null, reason: 'sign-failed' });
  assert.deepEqual(resolveImageOpen({ image_path: 'x.jpg' }, { signedUrl: '' }), { open: false, url: null, reason: 'sign-failed' });
});

test('resolveImageOpen does NOT open when the invoice row / image_path is missing', () => {
  assert.deepEqual(resolveImageOpen(null, { signedUrl: 'u' }), { open: false, url: null, reason: 'no-image' });
  assert.deepEqual(resolveImageOpen({ image_path: null }, { signedUrl: 'u' }), { open: false, url: null, reason: 'no-image' });
  assert.deepEqual(resolveImageOpen({}, { signedUrl: 'u' }), { open: false, url: null, reason: 'no-image' });
});

// ── fullRecordModal: processed vs unprocessed routing ───────
test('fullRecordModal routes a PROCESSED invoice (a core parent) to the history modal', () => {
  // openInvoiceDetail only knows unprocessed rows, so a processed parent must
  // route to openHistoryEditModal — otherwise the link is a silent no-op.
  assert.equal(fullRecordModal({ status: 'processed' }), 'history');
});

test('fullRecordModal routes an UNPROCESSED invoice to the classify/detail modal', () => {
  assert.equal(fullRecordModal({ status: 'unprocessed' }), 'detail');
});

test('fullRecordModal returns null when there is no invoice row', () => {
  assert.equal(fullRecordModal(null), null);
});
