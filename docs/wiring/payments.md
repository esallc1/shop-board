# How RO payments (the `ro_payments` ledger) are wired

> Doc: `/docs/wiring/payments.md`
> Last updated: 2026-08-09 — verified vs commit `<pending>` (branch `feat/bookkeeping-ro-detail`)
> Status: ✅ Verified vs `advisor-board.html` (record/list/balance) + `bookkeeping-board.html`
> (Financial Pulse income) + `migrations/20260718_ro_payments.sql`. Record-only ledger; the
> app never processes cards.

## 0. In one line
Every payment a customer makes against an RO is **one row in `ro_payments`** — so deposits
and **split/combined payments (cash + card) are just multiple rows**; an RO's balance is the
RO total minus the sum of its rows, and it's "paid in full" when that reaches $0.

## 1. The table
`public.ro_payments` (`migrations/20260718_ro_payments.sql`) — one row **per payment**:
- `id`, `repair_order_id` (hard FK → `repair_orders`), `po` (mirror text key,
  `= repair_orders.po`), `amount` (numeric — the **cash tendered**, uncapped), `method`
  (text — a value from the editable `payment_methods` list), `note` (nullable), `paid_at`
  (timestamptz, default `now()`).
- **Anon-full-access RLS** (same posture as every CrisData ledger). No server endpoint —
  the advisor board reads/writes it directly with the anon key.

## 2. Recording a payment (advisor board)
- **`recordPayment()`** (`advisor-board.html`) inserts **one row** with the entered `amount`,
  the picked `method` (`#cdPayMethod`, from `activePaymentMethods()` → `BoardSettings
  .getPaymentMethods()` — cash/card/koalifi/snap/check, editable in Settings), and an
  optional note. `paid_at` defaults to now.
- **Split / combined = record more than one payment.** To take $2,000 cash + $3,294.10 card,
  the advisor taps **Record payment twice** — two rows, each its own method/amount. A deposit
  is the same mechanism (an early partial row). There is **no separate "split-entry" form** —
  the per-payment ledger already models it. `deletePayment(id)` removes a row.
- **`loadPayments()`** fetches the open RO's rows (`eq('repair_order_id', currentRo.id)`,
  ordered by `paid_at`); `renderPayments()` lists them (date · method · note · amount · ✕).

## 3. Balance & status
- **Balance = RO total − Σ payments.** `paidSum()` sums `ro_payments.amount`; the RO total is
  `roTotalNum()` (the same `Σ(qty×unit_price)+tax` the builder/print use). `renderPaymentsSummary()`
  paints Total / Paid / Balance and a badge.
- **`paymentStatusFor(total, paid)`** → `'unpaid'` (paid ≤ 0) · `'paid'` (paid ≥ total − 0.005)
  · `'partial'` (in between). Written to `completed_jobs` on close. **"Paid in full" ≠ picked
  up** — closing an RO is still a separate manual step.

## 4. Who reads it
- **Advisor RO detail** — the Payments card (record/list/balance) + the printed **PAID**
  invoice state (see [[ro-invoice]]: `isPaid = status∈{invoice,closed} && Σ payments ≥ total`,
  the PAID block shows each payment + combined method + $0 balance).
- **Bookkeeping Financial Pulse income** ([[financial-pulse]] §2/§7) — realized income is the
  **capped RO total** (never the tendered `amount`, so a customer's change can't book as
  revenue), recognized only when **paid in full**, bucketed by the closing `paid_at` (NY). The
  paid-RO modal shows the distinct `method`s joined with `+`.
- **Bookkeeping per-RO detail** ([[financial-pulse]] §9) — embeds the invoice (paid state and
  method(s)) via the shared builder.

## Known gaps & open questions (as of 2026-08-09)
- **`amount` is cash TENDERED, not applied** — a payment can exceed the invoice (change). Every
  reader that means "revenue" must cap at the RO total (income does; see [[financial-pulse]] §2).
- **No server enforcement** — anon can write `ro_payments` directly (same posture as all ledgers).
- **`po` mirror** is set by `recordPayment` (`currentRo.po || String(ro_number)`); readers that
  join by `po` (e.g. the bookkeeping RO-detail payments fetch) rely on it matching
  `repair_orders.po`. The hard FK is `repair_order_id`.

## Where it lives in the code / schema
- **Schema:** `ro_payments` (`migrations/20260718_ro_payments.sql`); `payment_methods`
  (editable list via `shared/board-settings.js`).
- **Record / list / balance:** `advisor-board.html` — `recordPayment`, `loadPayments`,
  `renderPayments`, `renderPaymentsSummary`, `paymentStatusFor`, `paidSum`, `deletePayment`,
  `populateMethodPicker` / `activePaymentMethods`; the shop-wide read-only ledger `loadPayLedger`.
- **Consumers:** [[financial-pulse]] (income + per-RO detail), [[ro-invoice]] (PAID state).
- **Related docs:** [[ro-invoice]], [[financial-pulse]], [[settings]] (`payment_methods`).

## Session change log
- 2026-08-09 — Created. Documented the `ro_payments` per-payment ledger (record-only, anon
  RLS), the **split/deposit = multiple rows** model (no separate combined-entry form), the
  balance/status math, and its readers (advisor Payments card + PAID invoice, bookkeeping
  income + per-RO detail). No code change in this doc's creation.
