/* ============================================================
   ro-invoice.js — the ONE printable RO / estimate / invoice document builder.

   Extracted from advisor-board.html's printRo so BOTH consumers render the
   identical document:
     • advisor-board.html — printRo() wraps buildPrintDoc() → window.open + print.
     • bookkeeping-board.html — the per-RO detail LEFT pane embeds buildInvoiceHtml()
       (the fragment) under the scoped `.roinv .roinv-embed` CSS.

   PURE: no DOM, no `window`, no module globals — every input arrives via opts, so
   ro-invoice.test.js exercises it under `node --test`. The browser build also
   assigns window.RoInvoice (see the <script type="module"> in each board).

   Document identity is driven by RO status (ESTIMATE / REPAIR ORDER / INVOICE),
   with three bodies:
     • RECEIPT  — the quick diag-fee one-liner (opts.receipt).
     • PAID     — status ∈ {invoice, closed} AND Σ payments ≥ invoice total: the
                  work/totals tables + a PAID block (stamp, payment lines, balance
                  due $0, date paid), REPLACING the authorization/signature block.
     • INVOICE  — everything else (estimate / ro / unpaid invoice): the work/totals
                  tables + the authorization + customer-signature block (UNCHANGED
                  from the original printout).
   ============================================================ */

// ── pure local helpers (no globals) ─────────────────────────────────────────
function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
// Mirror of shared/format.js so the builder stays self-contained + testable.
function fmtPhone(v) {
  if (v == null || v === '') return '';
  const s = String(v), d = s.replace(/\D/g, '');
  if (/\D/.test(s) || d.length !== 10) return s;   // already formatted / not clean 10-digit → unchanged
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}
function serviceWriterName(ro) {
  const w = ro && ro.service_writer;
  const row = Array.isArray(w) ? w[0] : w;
  return (row && row.name) || '—';
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return String(d); }
}
const DOC_LABEL = { estimate: 'ESTIMATE', ro: 'REPAIR ORDER', invoice: 'INVOICE', closed: 'INVOICE', receipt: 'RECEIPT' };
const TAX_FALLBACK = 0.07;

// The invoice CSS, SCOPED under `.roinv` so it is safe to inject into any board
// (the print doc wraps content in `.roinv`; the embed adds `.roinv-embed`). The
// print-only bits (@page, body reset) live in buildPrintDoc, not here.
export const INVOICE_CSS = `
.roinv { font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: #111; font-size: 10px; line-height: 1.35; }
.roinv .inv { width: 100%; max-width: 7.5in; margin: 0 auto; }
.roinv.roinv-embed { padding: 2px; }
.roinv.roinv-embed .inv { max-width: 100%; }
.roinv .inv.inv-receipt { padding-top: 0.5in; }
.roinv .tr { text-align: right; } .roinv .tc { text-align: center; } .roinv .muted { color: #888; }
.roinv .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 8px; }
.roinv .top .shop { display: flex; gap: 10px; align-items: flex-start; }
.roinv .logo { max-height: 54px; max-width: 130px; object-fit: contain; }
.roinv .shopname { font-size: 15px; font-weight: 800; }
.roinv .shopmeta { color: #333; }
.roinv .doc-meta { text-align: right; font-size: 10px; }
.roinv .doc-meta .num { font-size: 17px; font-weight: 800; }
.roinv .doc-meta .paid-tag { display: inline-block; margin-top: 3px; border: 2px solid #15803d; color: #15803d; font-weight: 800; letter-spacing: 1px; padding: 1px 8px; border-radius: 5px; font-size: 11px; }
.roinv h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.7px; color: #555; margin: 10px 0 3px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
.roinv .grid2 { display: flex; gap: 22px; } .roinv .grid2 > div { flex: 1; }
.roinv .kv { margin: 1px 0; } .roinv .kv b { display: inline-block; min-width: 92px; color: #444; font-weight: 600; }
.roinv table.lt { width: 100%; border-collapse: collapse; margin-top: 3px; }
.roinv table.lt th, .roinv table.lt td { border-bottom: 1px solid #ddd; padding: 3px 5px; text-align: left; }
.roinv table.lt th { background: #f2f2f4; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.4px; color: #555; }
.roinv .totals { width: 250px; margin-left: auto; margin-top: 8px; }
.roinv .totals table { width: 100%; border-collapse: collapse; }
.roinv .totals td { padding: 2px 5px; } .roinv .totals tr:last-child td { border-top: 2px solid #111; font-weight: 800; font-size: 12px; }
.roinv .foot-note { font-size: 8px; color: #777; margin-top: 3px; }
.roinv .auth { border: 1px solid #bbb; border-radius: 4px; padding: 8px; margin-top: 10px; font-size: 9px; break-inside: avoid; page-break-inside: avoid; }
.roinv .auth .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline; }
.roinv .auth .box { border: 1px solid #666; width: 10px; height: 10px; display: inline-block; margin-right: 3px; vertical-align: middle; }
.roinv .sigblock { margin-top: 16px; width: 100%; break-inside: avoid; page-break-inside: avoid; }
.roinv .sigline { height: 0.6in; border-bottom: 1px solid #111; }
.roinv .siglabel { margin-top: 3px; font-size: 9px; color: #333; }
.roinv .paid { border: 1px solid #bbb; border-radius: 4px; padding: 10px 12px; margin-top: 10px; font-size: 9px; break-inside: avoid; page-break-inside: avoid; display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
.roinv .paidstamp { border: 2px solid #15803d; color: #15803d; font-weight: 800; font-size: 18px; letter-spacing: 3px; padding: 4px 14px; border-radius: 7px; transform: rotate(-4deg); flex: 0 0 auto; }
.roinv .paid .lines { flex: 1; min-width: 200px; }
.roinv .paid table { width: 100%; max-width: 300px; border-collapse: collapse; }
.roinv .paid td { padding: 2px 5px; } .roinv .paid tr.bal td { border-top: 2px solid #111; font-weight: 800; }
.roinv .paid .note { margin-top: 6px; color: #333; }
.roinv .legal { font-size: 7px; color: #555; line-height: 1.3; margin-top: 10px; border-top: 1px solid #ccc; padding-top: 5px; }
.roinv .mv { font-size: 8px; color: #333; margin-top: 3px; font-weight: 700; }
`;

// ── the document fragment (the `.inv` div) ──────────────────────────────────
// opts = { ro, lines, settings, payments, receipt, methodLabel }
//   ro        — repair_orders row (+ embedded customers, vehicles, service_writer)
//   lines     — ro_line_items[]
//   settings  — shop_settings (tax_rate, show_tech_on_ro, shop profile fields)
//   payments  — ro_payments[] (amount, method, paid_at) — drives the PAID state
//   receipt   — { amount, description, method, receiptNumber, estimateNumber } → receipt mode
//   methodLabel(value) — optional; maps a payment method value to its label
export function buildInvoiceHtml(opts) {
  const o = opts || {};
  const ro = o.ro || {};
  const lines = o.lines || [];
  const cfg = o.settings || {};
  const payments = o.payments || [];
  const receipt = o.receipt || null;
  const methodLabel = typeof o.methodLabel === 'function'
    ? o.methodLabel
    : (v) => (v == null ? '—' : String(v).charAt(0).toUpperCase() + String(v).slice(1));

  const isReceipt = !!(receipt && receipt.amount != null) || o.mode === 'receipt';
  const c = ro.customers || {}, v = ro.vehicles || {};
  const showTech = !!cfg.show_tech_on_ro;
  const advisor = serviceWriterName(ro);
  const P = esc, M = money;

  const docLabel = isReceipt ? DOC_LABEL.receipt : (DOC_LABEL[ro.status] || 'INVOICE');
  const docTitle = docLabel.charAt(0) + docLabel.slice(1).toLowerCase();
  const numShown = isReceipt ? ((receipt && receipt.receiptNumber) || ('R-' + ro.ro_number)) : ('#' + ro.ro_number);
  const rAmt = isReceipt ? (Number(receipt && receipt.amount) || 0) : 0;
  const rDesc = isReceipt ? ((receipt && receipt.description) || 'Diagnostic fee') : '';
  const rMethod = isReceipt ? ((receipt && receipt.method) === 'card' ? 'Card' : 'Cash') : '';
  const rEstNum = isReceipt ? (receipt && receipt.estimateNumber != null ? receipt.estimateNumber : ro.ro_number) : '';

  // category totals
  const catSum = (t) => lines.filter(l => l.line_type === t).reduce((s, l) => s + num(l.quantity) * num(l.unit_price), 0);
  const laborTotal = catSum('labor');
  const partsTotal = catSum('parts') + catSum('package');   // package folds into Parts
  const hazmatTotal = catSum('hazmat'), suppliesTotal = catSum('shop_supply'), feesTotal = catSum('fee');
  const taxableBase = lines.reduce((s, l) => s + (l.taxable ? num(l.quantity) * num(l.unit_price) : 0), 0);
  const exempt = !!c.tax_exempt;
  const rate = (cfg.tax_rate != null && Number.isFinite(Number(cfg.tax_rate))) ? Number(cfg.tax_rate) : TAX_FALLBACK;
  const taxTotal = exempt ? 0 : taxableBase * rate;
  const invoiceTotal = laborTotal + partsTotal + hazmatTotal + suppliesTotal + feesTotal + taxTotal;

  // PAID state — invoice/closed and fully paid off (Σ payments ≥ total)
  const paidSum = payments.reduce((s, p) => s + num(p.amount), 0);
  const isPaid = !isReceipt && ['invoice', 'closed'].includes(ro.status) && invoiceTotal > 0 && paidSum >= invoiceTotal - 0.005;
  const balance = Math.max(0, invoiceTotal - paidSum);

  const laborLines = lines.filter(l => l.line_type === 'labor');
  const partsLines = lines.filter(l => l.line_type === 'parts' || l.line_type === 'package');
  const laborRows = laborLines.length ? laborLines.map(l => `
        <tr><td>${P(l.description)}</td><td class="tc">${showTech ? P(ro.technician) : ''}</td>
        <td class="tr">${num(l.quantity)}</td><td class="tr">${M(l.unit_price)}</td>
        <td class="tr">${M(num(l.quantity) * num(l.unit_price))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">—</td></tr>';
  const partsRows = partsLines.length ? partsLines.map(l => `
        <tr><td>${P(l.description)}</td><td>${P(l.part_number)}</td>
        <td class="tr">${num(l.quantity)}</td><td class="tr">${M(l.unit_price)}</td>
        <td class="tr">${M(num(l.quantity) * num(l.unit_price))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">—</td></tr>';
  const totalRow = (label, val, note) => `<tr><td>${label}${note ? ' <sup>*</sup>' : ''}</td><td class="tr">${M(val)}</td></tr>`;

  const dateStr = fmtDate(new Date());
  const logo = cfg.logo_url ? `<img class="logo" src="${P(cfg.logo_url)}" alt="">` : '';

  // shared work + totals (identical for INVOICE and PAID bodies)
  const workAndTotals = `
  <h2>Customer Issues &amp; Advisories</h2>
  <div class="kv"><b>Symptoms / DTC</b> ${P(ro.complaint) || '—'}</div>
  <div class="kv"><b>Advisory notes</b> ${P(ro.advisory_notes) || '—'}</div>

  <h2>Work Performed — Labor</h2>
  <table class="lt"><thead><tr><th>Description</th><th class="tc">Tech</th><th class="tr">Hrs</th><th class="tr">Price</th><th class="tr">Total</th></tr></thead><tbody>${laborRows}</tbody></table>

  <h2>Work Performed — Parts</h2>
  <table class="lt"><thead><tr><th>Description</th><th>Part No</th><th class="tr">Qty</th><th class="tr">Price</th><th class="tr">Total</th></tr></thead><tbody>${partsRows}</tbody></table>

  <div class="totals">
    <table>
      ${totalRow('Labor', laborTotal)}
      ${totalRow('Parts', partsTotal)}
      ${totalRow('Hazmat', hazmatTotal, true)}
      ${totalRow('Shop Supplies', suppliesTotal, true)}
      ${feesTotal > 0 ? totalRow('Fees', feesTotal) : ''}
      ${totalRow(exempt ? 'Taxes (exempt)' : 'Taxes (' + (rate * 100).toFixed(2) + '%)', taxTotal)}
      <tr><td>Invoice Total</td><td class="tr">${M(invoiceTotal)}</td></tr>
    </table>
    <div class="foot-note">* Shop supplies &amp; hazmat are flat shop charges, not per-part.</div>
  </div>`;

  // UNPAID authorization + signature (unchanged from the original printout)
  const authBlock = `
  <div class="auth">
    <div class="row"><div><b>Authorization</b></div><div>Original estimate total: <b>${M(invoiceTotal)}</b></div></div>
    <div class="row" style="margin-top:5px">
      <span>Method:</span>
      <span><span class="box"></span>Email</span>
      <span><span class="box"></span>Text</span>
      <span><span class="box"></span>Phone</span>
      <span><span class="box"></span>Fax</span>
      <span><span class="box"></span>In person</span>
    </div>
    <div class="row" style="margin-top:5px">
      <span>Date: ______________</span>
      <span>Contact: ______________________</span>
      <span>Authorized by: ______________________</span>
    </div>
    <div class="sigblock">
      <div class="sigline"></div>
      <div class="siglabel">X — Customer signature</div>
    </div>
  </div>`;

  // PAID block — replaces the auth/signature once the invoice is paid in full
  const sortedPays = payments.slice().sort((a, b) => new Date(a.paid_at || 0) - new Date(b.paid_at || 0));
  const closing = sortedPays[sortedPays.length - 1];
  const paidDate = fmtDate((closing && closing.paid_at) || ro.closed_at);
  const methodSummary = [...new Set(sortedPays.map(p => methodLabel(p.method)).filter(Boolean))].join(' + ') || '—';
  const payRows = sortedPays.length
    ? sortedPays.map(p => `<tr><td>Paid — ${P(methodLabel(p.method))}${p.paid_at ? ' (' + P(fmtDate(p.paid_at)) + ')' : ''}</td><td class="tr">${M(p.amount)}</td></tr>`).join('')
    : '';
  const paidBlock = `
  <div class="paid">
    <div class="paidstamp">PAID</div>
    <div class="lines">
      <table>
        ${payRows}
        <tr class="bal"><td>Balance Due</td><td class="tr">${M(balance)}</td></tr>
      </table>
      <div class="note">Paid in full${paidDate ? ' on ' + P(paidDate) : ''} · ${P(methodSummary)}. No signature required.</div>
    </div>
  </div>`;

  const receiptBody = `
  <table class="lt"><thead><tr><th>Description</th><th class="tr">Amount</th></tr></thead>
    <tbody><tr><td>${P(rDesc)}</td><td class="tr">${M(rAmt)}</td></tr></tbody></table>
  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td class="tr">${M(rAmt)}</td></tr>
      <tr><td>Balance Due</td><td class="tr">${M(0)}</td></tr>
      <tr><td>Paid — ${P(rMethod)}</td><td class="tr">${M(rAmt)}</td></tr>
    </table>
  </div>
  <div class="foot-note" style="margin-top:6px">Diagnostic fee for the declined estimate above. The estimate itself remains unbilled — no repair was authorized.</div>`;

  const bodyHtml = isReceipt ? receiptBody : (isPaid ? (workAndTotals + paidBlock) : (workAndTotals + authBlock));

  return `<div class="inv${isReceipt ? ' inv-receipt' : ''}">
  <div class="top">
    <div class="shop">
      ${logo}
      <div>
        <div class="shopname">${P(cfg.shop_name || 'Lee Transmission')}</div>
        <div class="shopmeta">${P(cfg.address_line)}${cfg.city_state_zip ? ', ' + P(cfg.city_state_zip) : ''}</div>
        <div class="shopmeta">${P(cfg.phone)}${cfg.email ? '  ·  ' + P(cfg.email) : ''}</div>
        <div class="shopmeta">${P(cfg.website)}</div>
      </div>
    </div>
    <div class="doc-meta">
      <div class="num">${P(docLabel)} ${isReceipt ? P(numShown) : '#' + P(ro.ro_number)}</div>
      <div>Date: ${P(dateStr)}</div>
      ${isReceipt ? `<div><b>Re: Estimate #${P(rEstNum)}</b></div>` : ''}
      <div>Service Advisor: ${P(advisor) || '—'}</div>
      ${showTech && ro.technician ? `<div>Technician: ${P(ro.technician)}</div>` : ''}
      ${isPaid ? '<div class="paid-tag">PAID</div>' : ''}
    </div>
  </div>

  <div class="grid2">
    <div>
      <h2>Customer</h2>
      <div class="kv"><b>Name</b> ${P(c.name)}</div>
      <div class="kv"><b>Cell</b> ${P(fmtPhone(c.phone_primary))}</div>
      <div class="kv"><b>Email</b> ${P(c.email)}</div>
    </div>
    <div>
      <h2>Vehicle</h2>
      <div class="kv"><b>Vehicle</b> ${P([v.year, v.make, v.model].filter(Boolean).join(' '))}</div>
      <div class="kv"><b>Engine</b> ${P(v.engine)}</div>
      <div class="kv"><b>Trans code</b> ${P(v.transmission_code)}</div>
      <div class="kv"><b>VIN</b> ${P(v.vin)}</div>
      <div class="kv"><b>Plate</b> ${P(v.plate)}${v.plate_state ? ' ' + P(v.plate_state) : ''}</div>
      <div class="kv"><b>Miles</b> in ${P(ro.odometer_in != null ? ro.odometer_in : '—')} / out ${P(ro.miles_out != null ? ro.miles_out : '—')}</div>
    </div>
  </div>

  ${bodyHtml}

  ${cfg.legal_terms ? `<div class="legal">${P(cfg.legal_terms)}</div>` : ''}
  ${cfg.mv_number ? `<div class="mv">MV# ${P(cfg.mv_number)}</div>` : ''}
</div>`;
}

// Full standalone print document (advisor-board printRo → window.open).
export function buildPrintDoc(opts) {
  const o = opts || {};
  const cfg = o.settings || {};
  const ro = o.ro || {};
  const isReceipt = !!(o.receipt && o.receipt.amount != null) || o.mode === 'receipt';
  const docLabel = isReceipt ? DOC_LABEL.receipt : (DOC_LABEL[ro.status] || 'INVOICE');
  const docTitle = docLabel.charAt(0) + docLabel.slice(1).toLowerCase();
  const numShown = isReceipt ? ((o.receipt && o.receipt.receiptNumber) || ('R-' + ro.ro_number)) : ('#' + ro.ro_number);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(docTitle)} ${esc(numShown)} — ${esc(cfg.shop_name || 'Lee Transmission')}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
${INVOICE_CSS}
</style></head><body onload="window.focus();window.print();">
<div class="roinv">${buildInvoiceHtml(o)}</div>
</body></html>`;
}
