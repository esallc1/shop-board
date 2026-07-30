# How the intake wizard (New RO flow) is wired

> Doc: `/docs/wiring/intake-wizard.md`
> Last updated: 2026-07-30 — verified vs commit `bea25cf`
> Status: ✅ verified vs commit `bea25cf` (claims below re-checked against `advisor-board.html`).
> Still partial — the customer/phone-match steps aren't fully documented yet.

## 0. In one line
The New RO wizard: phone → customer → vehicle → (comeback check, if the vehicle has history) → open the RO.

## 1. Steps (verified vs code)
- **Phone → customer → vehicle:** enter phone, pick/confirm customer, pick vehicle.
- **Comeback check (`cdStepComeback`, `advisor-board.html:3011`):** only appears when the
  chosen vehicle has a **prior RO on that exact `vehicle_id`**. `selectExistingVehicle` looks up
  the most-recent prior RO; if there is none it sets `parentRoId = null` and **skips straight to
  mint** (`advisor-board.html:3029-3033`). When a prior exists it asks "Back on the last job
  (#N), or something new?" — choosing Comeback sets `state.parentRoId` to that prior RO.
- **Mint step "Open the RO" (`cdStepMint`):** complaint/concern, odometer (optional), and an optional
  **"Use existing PO (legacy migration)"** box (`cdLegacyPoWrap`, `advisor-board.html:1720`) that
  reuses a v1-floor PO number as the RO# — `row.ro_number = legacyPo` (`advisor-board.html:3265`) —
  and marks the car checked-in automatically. This is legacy migration — **not** the comeback link.

## Known gaps & open questions (as of 2026-07-30)
- **RESOLVED (verified `bea25cf`):** the comeback question is gated on a **prior RO for that exact
  vehicle** existing — no prior → no question, by design (see step 2 above). Intended, not a bug.
  Corollary: a returning customer bringing a **new** vehicle gets no comeback question.
- **UX idea (parked):** the legacy-PO field is a plain number entry — a recent-RO picker
  would help.

## Where it lives in the code
- `advisor-board.html` — wizard steps array (~2837), `selectExistingVehicle` (~3011),
  `goToMint` (~3046), legacy-PO field (~1720) + mint write (~3265)

## Session change log
- 2026-07-30 — Stub created.
- 2026-07-30 — Verified vs `bea25cf`: documented the real step order (added the `cdStepComeback` step
  the stub omitted), confirmed the legacy-PO behavior, and resolved the comeback-question VERIFY
  (intended vehicle-scoped gating).
