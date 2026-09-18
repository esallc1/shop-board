/* ============================================================
   ro-totals.js — THE one RO total calculator (+ the live card fee).

   WHY THIS EXISTS: an RO's total used to be re-derived in nine places (the RO
   detail totals, the payments balance, the RO-board cards, the close archive,
   the printed invoice, bookkeeping's Financial Pulse + RO-detail profit, the
   customer record, Profit by RO) — each its own copy of Σ qty×price + tax. A
   live card fee has to land in ALL of them or they disagree (and Financial
   Pulse would stop counting card jobs as paid). So the math lives here once and
   every surface calls it. See docs/wiring/card-fee.md.

   THE CARD FEE (repair_orders.card_fee_on):
     • An ON/OFF switch per RO, OFF by default. When ON the fee is
         round2( card_fee_pct × (all lines + sales tax) )
       — the SAME base the old "+ Card fee" button used — computed LIVE, so it
       follows every line add/edit/delete, exactly like Tax. Not taxable.
     • Payments/deposits never enter this function: they only reduce the
       balance (see roBalance). The fee cannot move because someone paid.
     • It is a switch, not a line, so it cannot be applied twice.
     • The rate is shop_settings.card_fee_pct — the ONLY rate. There is no code
       fallback: an unreadable rate returns cardFee 0 with
       cardFeeUnavailable=true so every surface can say "rate unavailable"
       instead of silently charging a guessed percentage.
     • LEGACY: ROs from before the switch may carry a stored card-fee LINE
       (line_type 'fee', description "Card processing fee (4.00%)" or the old
       "CARD PROCESSING FEE"). Those lines stay part of the lines sum as they
       always were. If such a line exists the live fee is FORCED to 0 even when
       the switch says ON — the two can never stack (cardFeeBlocked=true).

   No DOM, no db, no globals. Loaded in the browser as an ES module that
   assigns window.RoTotals; imported by shared/ro-invoice.js and
   shared/customer-record.js, and by shared/ro-totals.test.js under node --test.
   ============================================================ */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;

// A usable fee rate: a finite number ≥ 0 (a fraction, 0.04 = 4%). Anything
// else — null, '', NaN, negative — is "unavailable", never a default.
export function normalizeRate(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// "Card processing fee (4.00%)" — the same wording the old button stored, so
// printed invoices read the same before and after the switch.
export function cardFeeLabel(rate) {
  const r = normalizeRate(rate);
  return r == null ? 'Card processing fee' : `Card processing fee (${(r * 100).toFixed(2)}%)`;
}

// A stored card-fee line from before the switch existed.
export function isLegacyCardFeeLine(l) {
  return !!l && l.line_type === 'fee' && /card processing fee/i.test(String(l.description || ''));
}
export function hasLegacyCardFee(lines) {
  return (lines || []).some(isLegacyCardFeeLine);
}

const lineAmount = (l) => num(l.quantity) * num(l.unit_price);

// THE calculator. opts: { taxRate, exempt, cardFeeOn, cardFeePct }.
export function computeRoTotals(lines, opts) {
  const o = opts || {};
  const L = lines || [];
  const subtotal = L.reduce((s, l) => s + lineAmount(l), 0);
  const taxableBase = L.reduce((s, l) => s + (l.taxable ? lineAmount(l) : 0), 0);
  const exempt = !!o.exempt;
  const tax = exempt ? 0 : taxableBase * num(o.taxRate);
  const preFeeTotal = subtotal + tax;                  // the fee's base: all lines + sales tax

  const switchOn = !!o.cardFeeOn;
  const legacy = hasLegacyCardFee(L);
  const rate = normalizeRate(o.cardFeePct);
  const cardFeeBlocked = switchOn && legacy;           // never stack live + stored
  const cardFeeUnavailable = switchOn && !legacy && rate == null;
  const cardFeeApplied = switchOn && !legacy && rate != null;
  const cardFee = cardFeeApplied ? round2(rate * preFeeTotal) : 0;

  return {
    subtotal, taxableBase, tax, exempt,
    preFeeTotal,
    cardFeeOn: switchOn,
    cardFeeApplied,          // true → show the fee row with its amount
    cardFeeUnavailable,      // true → show "rate unavailable", fee excluded
    cardFeeBlocked,          // true → switch ON but a legacy line exists; fee 0
    hasLegacyCardFee: legacy,
    cardFeeRate: rate,
    cardFeeLabel: cardFeeLabel(rate),
    cardFee,
    total: preFeeTotal + cardFee,
    preTaxRevenue: subtotal + cardFee,                 // for profit: pre-tax sale incl. the live fee
  };
}

// Balance due = total − Σ payments. Payments only ever SUBTRACT; they are not
// an input to the fee (computeRoTotals never sees them).
export function roBalance(totals, payments) {
  const paid = (payments || []).reduce((s, p) => s + num(p.amount), 0);
  return { paid, balance: num(totals && totals.total) - paid };
}

// Convenience for surfaces that hold a repair_orders row with embedded
// customers + ro_line_items. `settings` = shop_settings (tax_rate, card_fee_pct).
// taxFallback: the caller's existing tax fallback, unchanged by this slice.
export function totalsForRo(ro, settings, taxFallback) {
  const r = ro || {};
  const s = settings || {};
  const taxRate = (s.tax_rate != null && Number.isFinite(Number(s.tax_rate))) ? Number(s.tax_rate) : num(taxFallback);
  return computeRoTotals(r.ro_line_items || [], {
    taxRate,
    exempt: !!(r.customers && r.customers.tax_exempt),
    cardFeeOn: !!r.card_fee_on,
    cardFeePct: s.card_fee_pct,
  });
}
