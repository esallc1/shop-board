/* ============================================================
   core-invoice-view.js — pure decisions for opening a Core Bank row's original
   invoice image in the read-only lightbox (bookkeeping board only).

   No DOM, no db. Loaded in the browser as an ES module that assigns
   window.CoreInvoiceView, and imported directly by
   shared/core-invoice-view.test.js under `node --test`.

   Three decisions live here so they can't drift:
     • coreIsViewable  — a core row can open an image ONLY when it has a linked
       parent invoice. NULL invoice_queue_id (schema-permitted) is NOT viewable
       and must render a plain "no invoice attached" state, never a broken viewer.
     • resolveImageOpen — the lightbox is opened ONLY when we actually hold a
       signed URL, so a lookup/sign failure can never leave a blank overlay.
     • fullRecordModal — route the "full invoice record" link to the correct
       EXISTING modal. A core's parent invoice is processed, and openInvoiceDetail
       only knows UNPROCESSED rows, so a processed parent must route to the
       history-edit modal instead.
   ============================================================ */

// A Core Bank row can open its invoice image only when a parent invoice is
// linked. NULL invoice_queue_id → not viewable (render the no-invoice state).
export function coreIsViewable(core) {
  return !!(core && core.invoice_queue_id);
}

// Decide the outcome of an image-open attempt from the two DB results. The
// lightbox is opened ONLY when a real signed URL exists — so a missing image
// path or a failed sign never opens a blank overlay.
//   invoiceRow: the invoice_queue row read at click time (source of image_path)
//   signResult: the createSignedUrl result ({ signedUrl } | null)
// → { open, url, reason }  reason ∈ 'ok' | 'no-image' | 'sign-failed'
export function resolveImageOpen(invoiceRow, signResult) {
  if (!invoiceRow || !invoiceRow.image_path) return { open: false, url: null, reason: 'no-image' };
  const url = signResult && signResult.signedUrl;
  if (!url) return { open: false, url: null, reason: 'sign-failed' };
  return { open: true, url, reason: 'ok' };
}

// Route the "full invoice record" link to the correct existing modal:
//   'history' → openHistoryEditModal (processed invoices — the realistic case
//               for a core's parent, since cores are created at process time)
//   'detail'  → openInvoiceDetail    (unprocessed invoices)
// Returns null when there is no invoice row to open.
export function fullRecordModal(invoiceRow) {
  if (!invoiceRow) return null;
  return invoiceRow.status === 'processed' ? 'history' : 'detail';
}
