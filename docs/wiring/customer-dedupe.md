# Customer duplicates & multi-phone (investigation + design)

> Doc: `/docs/wiring/customer-dedupe.md`
> Last updated: 2026-07-31 — verified vs commit `c2a180d`
> Status: ⚠ INVESTIGATION + PROPOSAL — **read-only; nothing built, no migration, no writes.**
> §1–§3 (today's wiring + the live dupe scope) verified against `migrations/*.sql`,
> `advisor-board.html`, `shared/*.js`, and **live rows** (anon read, 2026-07-31). §4–§7 are a
> proposed design to approve before any build. Related: [[customer-record]], [[call-window-desk]],
> [[intake-wizard]].

## 0. In one line
Customers are stored with **two phone slots and no unique constraint**, matched **by phone only**,
and a caller from a **new number spawns a duplicate** — on top of ~60 duplicate clusters the
ALLDATA import already brought in. Proposal: a **multi-phone table**, an **intake dedupe guard**
(stop the leak), and a **reviewed, off-hours merge** (clean the backlog).

---

# PART A — How it works today (verified)

## 1. The customer model
- **`customers`** (`migrations/20260716_ro_foundation.sql:127-163`): `id uuid` PK, **`name` is the
  only required field**, `business_name`, `phone_primary`, `phone_secondary`, `email`, address
  fields, `tax_exempt`, `lead_source`. Later add (`20260727_alldata_import.sql:30-32`):
  `alldata_code` (the import's natural key), **`source`** (`'alldata'` vs null=CrisData-created),
  `last_invoiced`.
- **Phone = two scalar `text` columns only** — `phone_primary` + `phone_secondary`. **No array, no
  phones table.** `phone_secondary` is a single "learned" slot: `shared/call-attach.js:44-49` fills
  it once if empty and **never writes `phone_primary`**. A third number has nowhere to go.
- **No unique/dedupe constraint anywhere.** Only plain indexes
  (`idx_customers_phone_primary/name/email`, `ro_foundation.sql:156-158`). Nothing at the DB level
  stops duplicate people. RLS = **anon full access** (`:396-407`) — the board key inserts/updates
  customers directly.

### 1a. Every `customer_id` reference a merge must repoint (verified from migrations)
| Table | Column | ON DELETE | Note |
|---|---|---|---|
| `vehicles` | `customer_id` not null | **CASCADE** | `ro_foundation.sql:173` — delete-customer would delete vehicles → **never delete a loser; repoint then archive** |
| `repair_orders` | `customer_id` not null | **RESTRICT** | `:221` — blocks deleting a customer who has ROs (a useful guardrail) |
| `interactions` | `customer_id` not null | **CASCADE** | `:341` |
| `calls` | `customer_id` **nullable** | none | `20260728_calls_notes.sql:19` — the human-confirmed "this call is this person" link |

- **Indirect (no `customer_id`; hang off `repair_orders`, so they follow automatically when the RO
  is repointed):** `invoice_queue`, `ro_payments`, `ro_line_items`, `parts_orders`, `core_charges`,
  `marketing_content`, `comeback_capture`, `recordings` (via `calls`/`ro`). No direct repoint needed.
- **Non-FK, free-text (can't repoint by id):** `completed_jobs.customer` + `.customer_phone`
  (`20260711_completed_jobs.sql:21-22`) — historical strings; reconcile best-effort, accept imperfect.
- **No server path touches `customers`** (`grep customers api/` = nothing) — all customer writes are
  client-side (anon key).

## 2. Match + creation (how dupes are minted)
- **Caller popup match** (`advisor-board.html:6134` `matchCustomers`): **last-10 digits, phone only**
  — `last10(phone_primary)===key || last10(phone_secondary)===key`. **Name is never used.** The Desk
  index (`ensureCustIndex:7169`) builds the same `byPhone[last10]`. (A third, **known-buggy**
  full-digit-string lookup `cdOpenCustomerByPhone` is flagged in-code at `:6115-6116` — retire it.)
- **Customer SEARCH** (`:6077` `renderCustSearch`): client-side JS **substring** over the cached
  list — name/business OR (≥3 digits) phone. Not exact, not SQL.
- **The ONE dupe-minting insert** — `createCustomer` (`advisor-board.html:3331`) is the **only
  `customers` INSERT in the entire codebase.** Reached from the intake wizard's `lookupPhone`
  (`:3116`) **only when the phone-last-10 match count is 0**. So there IS a pre-check, but:
  1. it dedupes on **phone only, never name/business** — a known person calling from a **new number**
     (wife's phone, second cell) always falls through to "create";
  2. `createCustomer` does **no re-check** of its own before inserting (trusts the wizard's cached
     scan — which can be stale → the live "ANTHONY" minted twice, §3);
  3. there's no DB unique constraint behind it.
- **No standalone "add customer"** exists; the Desk "new appointment" never inserts a customer
  (phone-only walk-in or a matched `customer_id`). So the leak is exactly this one path.
- **Normalization** is consistent everywhere: last-10 digits (`window.cdLast10` at `:6162`,
  `shared/call-attach.js:26`, `shared/format.js:18`) — read-only on both sides; **stored values are
  never normalized in place.**

## 3. The live dupe scope (anon read, 2026-07-31)
- **2,700 customers** — **2,666 ALLDATA import**, **34 CrisData-created** (null `source`). **3,238 vehicles.**
- **Phone-sharing:** 130 clusters / **277 records** share a phone. Includes a junk **`1234567890`
  placeholder** (5 records) — must be excluded as a match key.
- **High-confidence customer dupes (same normalized name + same real phone): 61 clusters / 126
  records** — the core merge set. **All within the ALLDATA import** (0 mix import+call-in), i.e. the
  import brought its own dupes.
- **Name-dupe clusters:** 87 / 187 records (a superset — includes both *same person / two phones*
  and *different people / same name*; e.g. "JOSE RAMIREZ" ×4).
- **Shared-phone / different-name: 72 clusters** — **families / shared lines, NOT dupes.** Must be
  excluded from any auto-merge; they drive multi-match disambiguation.
- **Junk names (vehicle text in the name field): ~5–6** — "KEVIN F150", "AUSTIN F350", "OMIE F250",
  "JOSE RAM3500", "BMW 530I". (18 customers have no usable phone.)
- **Vehicle VIN dups: 58 clusters** — **24 same-customer** (pure dup rows to collapse, e.g. the two
  C1500s on the Jose case) + **34 cross-customer** (same VIN under two customers → a dupe-customer or
  a resold-vehicle signal to adjudicate).
- **The ongoing call-in leak so far:** of the 34 CrisData records, **3 already collide by phone and 2
  by name** with an existing record (incl. "ANTHONY" 239-225-5924 created **twice**). Small today
  (young system) but grows with every new-number call until the guard lands.

---

# PART B — PROPOSED (approve before any build)

## 4. Multi-phone model — a `customer_phones` table (additive, backward-compatible)
- New table: `customer_phones(id, customer_id → customers ON DELETE CASCADE, phone_norm text
  [last-10, for matching], phone_display text, label text [mobile/home/wife/work…], is_primary
  bool, source text, created_at)`. **Index on `phone_norm` (NOT unique — families share lines);
  partial-unique `(customer_id) where is_primary`.**
- **Backfill** each customer's `phone_primary` (→ `is_primary=true`) and `phone_secondary`
  (→ `is_primary=false`) into rows. **Keep the `customers.phone_primary/secondary` columns** during
  transition (dual-read/write): reads match against the new table; the current writers keep setting
  `phone_primary`. Later, `phone_primary` becomes a denormalized mirror of the primary row.
- **Matching widens** to "any of a customer's numbers": caller popup + search query
  `customer_phones.phone_norm == last10(incoming)`. A number matching **multiple** customers (a
  household) shows a small picker instead of guessing. This is what makes "wife's number" resolve to
  the husband's record instead of minting a dupe.

## 5. Intake dedupe guard — stop the leak (client-side, no schema change beyond §4)
At the single insert (`createCustomer`, `advisor-board.html:3331`) and its wizard pre-check
(`lookupPhone:3116`):
- **Widen the pre-check** beyond exact phone: match on **any `customer_phones` number** AND a **fuzzy
  name** signal (normalized/trigram on `name` + `business_name`). If any candidate exists, surface
  **"This looks like <name> — <vehicle> — use that record?"** with **[Use existing]** / **[It's a new
  customer]** — instead of silently inserting.
- **Re-check immediately before insert** inside `createCustomer` (defense-in-depth; the cached scan
  can be stale — this closes the "ANTHONY twice" self-dupe).
- Retire the known-buggy `cdOpenCustomerByPhone` full-string lookup; unify on `cdLast10` +
  `customer_phones`. All client-side + reversible; **do this early — it stops future growth so the
  cleanup is one-time.**

## 6. Safe merge / cleanup — reviewed, per-cluster, off-hours, reversible
- **Archive, never delete.** Add (additive) `customers.merged_into uuid` + `archived_at timestamptz`;
  a merged loser is repointed then archived (its row survives → rollback + audit; and
  `repair_orders`'s RESTRICT means a delete would fail anyway). Search/match filter out archived.
- **Per-cluster merge** {keeper K, losers L…}, in order:
  1. Repoint the 4 FK children to K: `vehicles`, `repair_orders`, `interactions`, `calls`
     (`update … set customer_id = K where customer_id in (L)`). Repoint ROs **before** archiving
     (RESTRICT).
  2. **Collapse duplicate vehicles** within K (same VIN): pick a survivor `vehicle_id`, repoint
     `repair_orders.vehicle_id` + `recordings.vehicle_id` to it, then archive/remove the dup vehicle
     rows. (Handles the 24 same-customer VIN dups.)
  3. Merge phones/data into K: add losers' numbers to `customer_phones`; keep K's primary; fill blank
     K fields from losers.
  4. Best-effort reconcile `completed_jobs.customer/.customer_phone` (free-text; informational).
  5. Set `merged_into = K, archived_at = now()` on each loser.
- **Delivered as reviewable SQL per cluster**, run by hand, each with a matching **rollback**
  (repoint back + un-archive — feasible because nothing is deleted).
- **Surfacing clusters for confirmation:** a read-only **dupe-review report** (a SQL query now; a
  small owner-board "Duplicates" panel later) listing each candidate cluster with a suggested keeper
  (heuristic: most ROs / most-recent activity / has calls) and the child-row counts per record. **Cris
  confirms the keeper per cluster before I generate that cluster's SQL** — no blind bulk merge.

## 7. Phasing + risk
- **Phase A (additive, safe, anytime):** `customer_phones` table + backfill; `customers.merged_into`
  / `archived_at` columns. No behavior change. *(hand-run migration)*
- **Phase B (additive, safe):** dual-read matching (caller popup + search also hit `customer_phones`);
  the attach flow learns **unlimited** numbers (not just the one `phone_secondary` slot). No dupes
  created; retire the buggy lookup.
- **Phase C (additive, safe, HIGH VALUE):** the **intake dedupe guard** (§5) — stops the leak.
  Client-side. **Do this before the big cleanup.**
- **Phase D (delicate, OFF-HOURS):** the merge/cleanup (§6), per-cluster, reviewed, reversible.
  Order: **24 same-customer vehicle collapses** (safest) → **61 high-confidence customer dupes** →
  **adjudicate** the 34 cross-customer VINs + 72 shared-line clusters (many are NOT dupes).
- **Risks:** `vehicles`/`interactions` **CASCADE** → deleting a loser would delete their data →
  **archive, never delete**; `repair_orders` **RESTRICT** enforces that. **Family/shared-line clusters
  are not dupes** — the review step is mandatory. Exclude **placeholder phones** as match keys.
  `completed_jobs` is free-text → imperfect reconcile. Merges touch `customer_id`/`vehicle_id` across
  ROs/calls → **off-hours only**, never mid-day (a concurrent RO write could race).

**Recommended order: A → B → C (stop the leak) → D (clean up, off-hours).**

## Known gaps & open questions (as of 2026-07-31)
- Are the 72 shared-phone/different-name clusters all families (keep separate), or do some hide a
  real dupe? → the review report surfaces them; Cris adjudicates.
- 34 cross-customer VIN clusters: dup customers vs a vehicle resold between two real customers →
  per-cluster decision.
- Fuzzy-name threshold (trigram similarity) needs tuning against these names to avoid false "use
  existing" prompts.

## Where it lives in the code (today)
- Model + FKs: `migrations/20260716_ro_foundation.sql` (customers `:127`, vehicles `:173`,
  repair_orders `:221`, interactions `:341`); `20260728_calls_notes.sql:19` (calls.customer_id);
  `20260727_alldata_import.sql` (source/alldata_code).
- Match: `advisor-board.html` `matchCustomers` (`:6134`), `ensureCustIndex` (`:7169`),
  `renderCustSearch` (`:6077`); `window.cdLast10` (`:6162`).
- The dupe-minting insert: `advisor-board.html` `createCustomer` (`:3331`) via `lookupPhone` (`:3116`).
- Attach/learn-a-number: `shared/call-attach.js` (`phone_secondary` single slot).

## Session change log
- 2026-07-31 — Created during the "customer duplicates & multi-phone" investigation. Verified the
  two-phone-slot model + no-unique-constraint, the 4 `customer_id` FK child tables (vehicles/ROs/
  interactions/calls) + their ON DELETE, the phone-only match + the single dupe-minting insert
  (`createCustomer`), and scoped the live dupes (2,700 customers / 2,666 import; 61 high-confidence
  clusters; 72 shared-line non-dupes; 58 VIN-dup vehicle clusters; the small live call-in leak).
  Proposed a `customer_phones` table, an intake dedupe guard, and a reviewed off-hours merge, in an
  A→B→C→D phasing. **Investigation only — no code, migration, or writes.**
