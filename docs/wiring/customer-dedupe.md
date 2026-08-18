# Customer duplicates & multi-phone (investigation + design)

> Doc: `/docs/wiring/customer-dedupe.md`
> Last updated: 2026-08-19 — verified vs branch `feat/customer-merge-slice1` (base `85ffc5b`)
> (§3 re-measured; §6 corrected — the FK list and the `is_primary` collision were both wrong;
> §7 corrected — **Phase A HAS been run, on sandbox AND prod**; §8 added — the merge as built.)
> Status: 🟡 **Phase A RUN (sandbox + prod). Phase C DONE (both intake guards + the phone-lookup
> fix). Phase B NOT built. Phase D slice 1 written + the app-side archive filtering built —
> the SQL is hand-run and NOT yet applied.**
> §1–§3 (today's wiring + the live dupe scope) verified against `migrations/*.sql`,
> `advisor-board.html`, `shared/*.js`, and **live rows** (anon read, 2026-07-31). §4–§7 are the
> approved design; Phase A is `migrations/20260731_customer_phones.sql` (additive, inert — nothing
> reads it yet). Phases B–D not built. Related: [[customer-record]], [[call-window-desk]],
> [[intake-wizard]], [[office-auth]] (§7 Step 1½ widen now includes `customer_phones`).

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

## 3. The live dupe scope
> ⚠️ **The 2026-07-31 figures below are superseded.** Re-measured 2026-08-19 on the sandbox:
> **2,717 customers** (2,666 ALLDATA + **51** CrisData) and **3,251 vehicles**.
> **59** high-confidence clusters (123 rows), not 61/126. Vehicle VIN clusters are now
> **25 same-customer + 35 cross-customer**. And the 7/31 claim that the high-confidence set was
> **"all within the ALLDATA import (0 mix import+call-in)" is NO LONGER TRUE** — there are now
> 3 CrisData-only clusters and 2 mixed. See §8 for the current classification and why that
> matters.

_(original 2026-07-31 reading, kept for the record:)_
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

## 5b. VEHICLE duplicates — the other half of the leak ✅ GUARD SHIPPED
This doc's §5 designs the intake guard for **customers**. Vehicles have the same leak and it was
never written down anywhere until now.

### The leak (fixed 2026-08-18)
`saveVehicle` inserted **unconditionally** — re-typing a truck on "+ Add a different vehicle"
minted a second row. The guard is now built and lives in [[intake-wizard]] §3: customer-scoped
matching on VIN → plate → make+model, the insert gated on a VIN or plate hit, and a make+model-only
match saving silently (the fleet failure mode). `saveVehicle` is the **only** vehicle insert site
in the codebase — verified 2026-08-18.

### The backlog (measured live 2026-08-18, NOT cleaned)
| Signal, same customer | Groups | Rows |
|---|---:|---:|
| Same normalized VIN | 25 | 50 |
| Same normalized plate (trailing `" 00"` removed) | 27 | 54 |
| Same make+model with ≥1 row missing the year — **raw** | 165 | 371 |
| …of which genuinely different vehicles (conflicting VINs/plates — fleets) | 140 | 321 |
| …of which real duplicate candidates | 25 | 50 |
| **Union of all signals** | **29** | **58** |

⚠️ The raw make+model count is **85% noise** — the biggest "group" is eleven Ford Transit
Connects at one fleet customer with ten distinct VINs. Any rule keyed on make+model alone would
flag fleets constantly. This is why the guard never prompts on it.

**Two findings that change the priority:**
1. **History is never actually split.** In all 29 groups the ROs and recordings sit on **exactly
   one** row; the twin is always empty. So the damage is a confusing phantom row, not lost
   history — and every cleanup is a clean repoint with **nothing to reconcile**.
2. **Every existing duplicate is an IMPORT COLLISION, not advisor re-typing.** 27 of the 58 rows
   were typed into CrisData during the 07-16→07-27 pilot and 31 arrived with the import on 07-28;
   **zero** were created after it. 18 vehicles have been added since and not one duplicates an
   existing row. The code leak was real but had not fired in three weeks of live use.

### VIN is NOT globally unique — 35 VINs under 2+ customers
| What they actually are | VINs |
|---|---:|
| Same normalized customer name → duplicate CUSTOMER | 9 |
| Different name but shared phone → almost certainly also a dup customer | 14 |
| Genuinely different people → resale, or a harder dup | 12 |

Even the last bucket is mostly dup customers on inspection (`Guardian Hurricane Protection` /
`GUARDIAN HURRRICANE PROTECTION`; `Aristocrat Plumbing` / `Aristocrat Plumbing Inc.`). True
resales are likely 3–5 VINs in the whole table. **Never scope a vehicle rule globally.**

### Cleanup order
**Run the customer merge (§6) FIRST.** ~23 of the 35 cross-customer VIN collisions are duplicate
customers, and §6 step 2 already collapses same-VIN vehicles *within* the keeper — so merging
customers first collapses a chunk of the vehicle duplicates for free, and shrinks the standalone
vehicle cleanup to whatever is left.

## 5a. ⚠️ The BIGGEST leak was not the one this doc describes — FIXED 2026-08-18
§3's leak analysis ("a caller from a new number spawns a duplicate") was right about the
mechanism but understated the scale, because it assumed the wizard could FIND an existing
customer by phone. It could not.

`lookupPhone` did an unbounded `db.from('customers').select(...)`, which PostgREST caps at 1,000
rows against a 2,717-row table. **1,700 customers — 62.6% — were invisible to the intake wizard**,
so the advisor was walked into *create a new customer* for most of the shop's book, on every
intake. That is very likely a larger source of the 64 duplicate clusters than the ALLDATA import.
`JOSE RAMIREZ` is the last row in the table and did not resolve.

Fixed in [[intake-wizard]] §4 (server-side filtering, no migration needed). **The §5 intake
dedupe guard below is still worth building** — it catches near-misses that an exact phone match
never will — but the single highest-value fix was making the exact match actually work.

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
  1. Repoint the FK children to K. ⚠️ **There are FIVE, not four** (re-verified 2026-08-19):
     `vehicles`, `repair_orders`, `calls`, `interactions`, **`customer_phones`** — the last one
     added by Phase A after this section was written. `interactions` exists but is **empty
     (0 rows)**, so it is a no-op in practice. Repoint ROs **before** archiving (RESTRICT).
     ⚠️ **`customer_phones` has a partial-unique index `(customer_id) where is_primary`.**
     Merging two customers who each have a primary row **violates it**. The loser's primary must
     be demoted BEFORE the repoint — see §8.
  2. **Collapse duplicate vehicles** within K (same VIN): pick a survivor `vehicle_id`, repoint
     `repair_orders.vehicle_id` + `recordings.vehicle_id` to it, then archive/remove the dup vehicle
     rows. (Handles the 24 same-customer VIN dups.)
  3. ~~Fill blank K fields from losers~~ — **DROPPED 2026-08-19.** The merge log records which
     ROWS moved; it cannot record that a field used to be blank, so this step is not reversible.
     Revisit only if it turns out to matter. (Phone rows still move — they are a repoint, §8.)
  4. ~~Best-effort reconcile `completed_jobs.customer/.customer_phone`~~ — **DROPPED
     2026-08-19.** It is free text, nothing joins on it, and every edit is an unreversible guess.
     Leave it alone.
  5. Set `merged_into = K, archived_at = now()` on each loser.
- **Delivered as reviewable SQL per cluster**, run by hand, each with a matching **rollback**
  (repoint back + un-archive — feasible because nothing is deleted).
- **Surfacing clusters for confirmation:** a read-only **dupe-review report** (a SQL query now; a
  small owner-board "Duplicates" panel later) listing each candidate cluster with a suggested keeper
  (heuristic: most ROs / most-recent activity / has calls) and the child-row counts per record. **Cris
  confirms the keeper per cluster before I generate that cluster's SQL** — no blind bulk merge.

## 7. Phasing + risk
- **Phase A — ✅ RUN, on SANDBOX *and* PROD** (`migrations/20260731_customer_phones.sql`).
  ⚠️ This doc said "hand-run pending" until 2026-08-19; that was wrong. `customer_phones` holds
  **2,766 rows** (2,682 `backfill_primary` + 84 `backfill_secondary`, zero `callin`/`attach`).
  Since the sandbox was built from a prod schema dump + data copy, its presence there proves it
  is on prod too. It is still **inert** — nothing in the codebase reads it, so Phase B really is
  unbuilt. What it was: the `customer_phones` table + indexes + one-primary partial-unique + anon RLS
  (mirrors `customers`) + the two backfills + verify/rollback. **Inert — nothing reads it yet.**
  Sync during transition: **no trigger** (by decision) — the backfill is a snapshot; at the Phase B
  cutover we re-run the idempotent insert-missing backfill and Phase B dual-writes so the legacy
  columns and the table stay in lockstep. `customer_phones` is added to [[office-auth]] §7's Step 1½
  widen arrays so a logged-in office session isn't blinded to it. *(The `merged_into`/`archived_at`
  columns are a later, Phase-D concern — NOT in this migration.)*
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

**Where we actually are (2026-08-19):** **A done.** **C done** — the vehicle guard
([[intake-wizard]] §3) and, far more importantly, the phone-lookup row-cap fix
([[intake-wizard]] §4) which was the real leak. **B still not built.** **D slice 1 written**
(§8). B was skipped ahead of D deliberately: the leak is plugged without it, and dual-read
matching is easier to reason about once the duplicates are gone.

## 8. The merge as BUILT — slice 1 (2026-08-19)

### The clusters, re-measured 2026-08-19
| Bucket | Clusters | Rows | History on >1 row |
|---|---:|---:|---:|
| **A. High-confidence** — same phone **and** same normalized name | **59** | 123 | **2** |
| **B. Same phone, names differ but same party** | 40 | 90 | 0 |
| **C. Families / shared lines — NEVER merge** | 6 | 12 | 0 |
| **D. Same phone, truly ambiguous** | 28 | 56 | 0 |
| **E. Same name, different phones** | 31 | 72 | 0 |

⚠️ **A single name-similarity threshold is NOT a family/duplicate discriminator.** It files
`JUAN CARRILLO-LOPEZ / Juan Carrillo` and `STANS COFFEE / Stan's Coffee Service` as families.
Four independent signals, in priority order: **shared VIN** (definitive, 14) → **token subset**,
one name's words ⊆ the other's (15) → **whole-string edit distance ≤15%** (24) → **same surname,
different first name = FAMILY** (6). Anything else is human adjudication (28). Even the family
rule needs eyes: it caught `Maira Contino / MYRA CONTINO`, almost certainly one person.

**Only 2 clusters in the whole set have history on more than one row** — `ANTHONY` (1 RO vs
2 ROs) and `ANDREA RUIZ` (an RO on one row, a call + recording on another). Every other merge is
a clean repoint. Those two are hand-adjudicated last.

### Where they came from — and why the phone-lookup fix mattered
88 of the 93 mergeable clusters are pure ALLDATA-import collisions. But normalize by volume:
**only 22 customers have been created since the import, and 7 of them (32%) landed in a
duplicate cluster.** `KEVIN CRUZ` and `IAN GEQUELIN` were each created **twice on the same day**
— the signature of an advisor looking a number up, getting nothing because of the 1,000-row cap
([[intake-wizard]] §4), and creating the customer. The import contributed the bulk; the wizard
was out-producing it per-customer.

### The survivor rule
`most history (ROs + calls + recordings)` → `most vehicles` → **`richest record`** → `oldest row`.
Rule 3 sits **above** rule 4 on purpose, so a fuller name beats an older stub
(`Jessie Capper` over `Jessie .`).

### What a merge touches — re-verified against the live schema
**Direct `customer_id` FKs (five):** `vehicles` (CASCADE — why a loser is never deleted),
`repair_orders` (RESTRICT), `calls`, `interactions` (**empty**), `customer_phones` (**new**).
**Indirect, moves for free:** `ro_line_items`, `ro_payments`, `ro_diagnostic_codes` (keyed by
`repair_order_id`); `recordings` (keyed by `vehicle_id`/`call_id`/`ro_id`). RO and vehicle ids
don't change, so these follow silently.
**NOT linked to customers — removed from the plan:** `invoice_queue`, `parts_orders`,
`core_charges` (keyed by free-text `po`), `marketing_content` (no customer column at all), and
`comeback_capture` (**does not exist**).
**`attachments`** is polymorphic (`entity_type` + `entity_id`), currently 2 rows, both
`repair_order`. A customer merge cannot orphan them — but nothing *enforces* that, so every
merge transaction **asserts zero `entity_type='customer'` rows** before touching anything.

### Reversibility — `customer_merge_log`
`customers` gains `merged_into` / `archived_at` / `merge_run_id`, and every repointed row is
logged to **`customer_merge_log`** (`run_id`, `cluster_id`, `table_name`, `row_id`,
`from_customer_id`, `to_customer_id`, `demoted_primary`).
- **Why a log and not run-id columns on the four hot tables:** `merged_into` records *that* a
  merge happened, not *which rows moved* — without that you cannot un-merge a loser who already
  shared a vehicle with the keeper. The log also buys **per-cluster** undo, which a run-id column
  cannot: one bad cluster reverses without touching the other two in the same run.
- ⚠️ `row_id` is **text**, not uuid: `calls.id` is a BIGSERIAL while everything else is uuid, and
  one log table has to hold both. The reverse casts (`l.row_id = t.id::text`).
- **The `is_primary` collision** (a real bug in the old §6): the loser's primary is demoted
  **only if the keeper already has one**, and the demotion is logged in `demoted_primary` so the
  reverse restores it. Unconditional demotion would needlessly leave a keeper with no primary —
  which is exactly what would have happened to `Shanika Brimmer`, whose keeper has no phone row.

### Archiving only means something if the app stops returning the row
This is the half that isn't SQL. **Every read that SEARCHES or MATCHES excludes archived rows;
every read BY ID does not.**

| Surface | Where | How |
|---|---|---|
| A–Z Customers list, `matchCustomers` (caller card), Desk attach picker, `cdOpenCustomerByPhone` | `fetchAllCustomers` | one function covers all four |
| New RO wizard phone match | `lookupPhone` | `.is('archived_at', null)` |
| Auto-attach on call arrival | `api/ctm-webhook.js` | `&archived_at=is.null` |
| **Customer Record opened by id** | `loadCustomerRecord` | **NOT filtered** — renders with a "merged into …" banner + a button to the survivor |

Every one of those degrades safely: the server-side filter is tried first, and on a
missing-column error (`42703`, a project where the merge migration hasn't run) it retries
unfiltered and `CustomerArchive.filterActive` becomes a no-op. One shape, both projects.

### Slice 1 — three clusters
`IAN GEQUELIN` · `KEVIN CRUZ` · `Shanika Brimmer`. All three are wizard-minted duplicates from
the last two weeks with history on exactly one row. SQL:
`migrations/20260819_customer_merge.sql` (schema) + `migrations/20260819_customer_merge_slice1.sql`
(preview → 3 per-cluster transactions → both reverses → verify). **Hand-run, not yet applied.**
Then: the 54 zero-history high-confidence clusters, then bucket B, then the 2 risky ones by hand.

## Known gaps & open questions (as of 2026-08-19)
- **Phase B is still unbuilt** — nothing reads `customer_phones`, so the "learn unlimited
  numbers" half of the design isn't live and `phone_secondary` is still a single slot.
- The 28 truly-ambiguous shared-phone clusters have no automatic answer and are parked.
- A merge does not de-duplicate the resulting `customer_phones` rows (no unique on
  `(customer_id, phone_norm)`), so a keeper can end up with the same number twice. Harmless, and
  left alone so the log stays a faithful record of what moved.

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
- 2026-08-19 — **Slice 1 of the merge built (§8), and four stale claims corrected.** §7's
  "Phase A hand-run pending" was **wrong — it has been run on sandbox AND prod** (2,766 rows).
  §3's counts and its "0 mix import+call-in" claim were stale. §6's FK list was missing
  `customer_phones` and missed the `is_primary` partial-unique collision entirely; its "fill
  blank keeper fields" and `completed_jobs` reconcile steps are dropped as unreversible. Added
  the app-side archive filtering — without it archiving changes nothing a human can see.
- 2026-08-18 — **Added §5a.** The intake wizard's phone lookup was blind to 62.6% of customers
  (the 1,000-row API cap), so the "call-in leak" this doc modelled was running far hotter than
  §3 estimated. Fixed; recorded here because it changes the read on where the 64 clusters came
  from.
- 2026-08-18 — **Added §5b, the vehicle half.** This doc only ever covered customer duplicates;
  the vehicle equivalent existed nowhere. Recorded the `saveVehicle` leak (now guarded — see
  [[intake-wizard]] §3), the re-measured backlog (29 groups / 58 rows, union of VIN + plate +
  consistent make/model), the two findings that de-prioritize it (history is never split; every
  existing duplicate is an import collision and none post-date it), the 35 cross-customer VIN
  breakdown, and the cleanup order (customers first — it collapses vehicle dups for free).
- 2026-07-31 — Created during the "customer duplicates & multi-phone" investigation. Verified the
  two-phone-slot model + no-unique-constraint, the 4 `customer_id` FK child tables (vehicles/ROs/
  interactions/calls) + their ON DELETE, the phone-only match + the single dupe-minting insert
  (`createCustomer`), and scoped the live dupes (2,700 customers / 2,666 import; 61 high-confidence
  clusters; 72 shared-line non-dupes; 58 VIN-dup vehicle clusters; the small live call-in leak).
  Proposed a `customer_phones` table, an intake dedupe guard, and a reviewed off-hours merge, in an
  A→B→C→D phasing. **Investigation only — no code, migration, or writes.**
- 2026-07-31 — Design approved. **Wrote Phase A** — `migrations/20260731_customer_phones.sql`
  (the `customer_phones` table + indexes + one-primary partial-unique + anon RLS mirroring
  `customers` + primary/secondary backfills + verify/rollback). Additive + **inert** (nothing reads
  it yet; `customers` untouched). No sync trigger (decision) — re-backfill at the Phase B cutover.
  Added `customer_phones` to [[office-auth]] §7 Step 1½ widen. **Migration is hand-run — not yet
  applied.** Phases B–D not built; A/B/C deploy in a calm window; D off-hours per-cluster.
