# How call auto-attach is wired

> Doc: `/docs/wiring/call-auto-attach.md`
> Last updated: 2026-08-19 — **shipped to prod**: all three migrations run, both backfills run
> (pass 1 twice — see §3), and the run-id namespace now records both environments.
> Status: 🟢 **LIVE ON PROD** (`hygemiszxwmyrkmhbjub`). `migrations/20260818_customers_phone_l10.sql`
> and `20260818_call_auto_attach.sql` are applied and verified there, so the going-forward
> webhook path can match; the hand-run backfills are DONE on both projects. Calls carrying an
> `ro_id` on prod went 9 → 76 on 2026-08-19.
> ⚠ The prod DEPLOY of the board code is `c17db7e`; anything committed after that is not
> serving yet.
> Related: [[customer-record]], [[call-window-desk]], [[customer-dedupe]], [[staging-db]].

## 0. In one line
A call that matches **exactly one** customer by phone gets attached to them automatically,
and if that customer had **exactly one RO open at the moment the call came in**, the call is
filed to that RO too — with every machine-made link tagged so it can be reversed in one
statement without touching anything a human did.

## 1. The rule — and the two places it must never disagree
There is one rule, expressed twice: once as SQL (the hand-run backfills, §5) and once as
JavaScript (`shared/call-auto-attach.js`, used by both live call sites). **They are written to
be the same predicate.** If you change one, change the other in the same commit.

**RULE 1 — customer.** Normalize the caller's number to its **last 10 digits**
(`last10Key` ⇄ `right(regexp_replace(coalesce(x,''),'\D','','g'),10)`). Reject junk
(`isJunkNumber` ⇄ `length = 10 and k <> '1234567890' and k !~ '^(.)\1{9}$'`) — that is
anything not exactly 10 digits, the `1234567890` placeholder, and repeated-digit numbers like
`0000000000`. Match it against `customers.phone_primary` **or** `phone_secondary`, same
normalization on that side. **Exactly one customer → attach. Zero (a stranger) or two-plus
(ambiguous) → leave the call alone**, in the pile, where a human can see it.

**RULE 2 — RO (bonus).** For that customer, find the ROs that were open **at the time of the
call** — `created_at <= started_at`, not closed by then, not declined by then:

| Condition | SQL | JS (`isOpenRoAt`) |
|---|---|---|
| opened before the call | `r.created_at <= started_at` | `created <= t`, NaN → not open |
| not closed by then | `r.closed_at is null or r.closed_at > started_at` | finite `closed <= t` → not open |
| not declined by then | `r.declined_at is null or r.declined_at > started_at` | finite `declined <= t` → not open |
| closed but undated | `not (r.closed_at is null and r.status = 'closed')` | same |

**Exactly one → set `ro_id`. Zero or two-plus → leave `ro_id` null.** Never guess.

"At the time of the call" is the whole point: RO #5451 is closed today, but it was open when
the customer rang about it, so that call belongs to it.

⚠️ JS compares **instants** (`Date.parse`), never ISO strings — PostgREST returns
`+00:00` offsets and a string compare gets those wrong.

## 2. What it is allowed to write — the inherited invariants
The robot inherits these from [[call-window-desk]]'s `shared/call-attach.js`, no exceptions.
They are enforced by construction (no code path names the forbidden columns) **and** locked by
a test that walks every patch the module can produce:

- **never writes `phone_primary`** — no code path names it;
- **never does phone learning at all** — no `phone_secondary` write, no `learned_phone`. The
  human attach path learns a new number into an empty slot; a machine guess must not mutate a
  customer record;
- **never writes `attached_by_name` / `attached_at`** — those two columns mean *a human did
  this*, and keeping them clean is what makes the robot's work separable;
- **never touches a row that already has `customer_id` or `not_a_customer_at`** —
  `shouldAutoAttach` is the gate, and both live writes repeat it as a **database-side filter**
  so it holds even under a race (§4).

## 3. The undo tag
Three additive columns on `calls` (`migrations/20260818_call_auto_attach.sql`):

| Column | Meaning |
|---|---|
| `auto_attached_at` | the robot set `customer_id`. Null on every human attach. |
| `auto_ro_filed_at` | the robot set `ro_id`. Cleared the moment a human re-files. |
| `auto_attach_run_id` | which batch did it — **the undo key**. One id = one reversible batch. |

**The run-id namespace.** Each backfill got its own id so the two undo independently; live
attaches share a fixed sentinel so they are reversible as a class but are never swept up by a
backfill undo:

| Run | Id | Env | What it did |
|---|---|---|---|
| Backfill pass 1 | `11111111-2222-4333-8444-555555555555` | **sandbox** `efhmefpaijjncwgbvwki` (2026-08-18) | attached 64 calls, filed 25 |
| Backfill pass 2 | `22222222-3333-4444-8555-666666666666` | **sandbox** (2026-08-18) | filed 17 ROs on **human**-attached calls |
| Backfill pass 1 | `11111111-2222-4333-8444-555555555555` | **prod** `hygemiszxwmyrkmhbjub` (2026-08-19) | attached 87 calls, filed 36 |
| Backfill pass 2 | `22222222-3333-4444-8555-666666666666` | **prod** (2026-08-19) | filed 20 ROs on **human**-attached calls |
| Backfill pass 1 **re-run** | `33333333-4444-4555-8666-777777777777` | **prod** (2026-08-19, after the merges) | attached 11 more, filed 6 |
| **Live** | `00000000-0000-4000-8000-000000000000` (`AUTO_ATTACH_LIVE_RUN_ID`) | both | everything from here on |

**The ids are per-run, not per-environment.** Passes 1 and 2 reuse the same two ids on prod
that they used on the sandbox — harmless, because the two projects are separate databases and
an undo is always scoped to one of them. The id that had to be *new* is the prod pass-1
**re-run**: reusing `1111…` would have fused 87 rows and 11 rows into a single undo unit, so
reversing either would have reversed both. One batch = one id = one reversible unit.

**Why a second pass 1 on prod.** Ian Gequelin's and Kevin Cruz's calls were being skipped by
RULE 1: two customer rows shared each phone number, so `count(distinct customer_id) = 1` never
held and the robot correctly refused to guess. Customer-merge slice 1 (run
`bbbbbbbb-0001-4b01-8b01-000000000001`, three clusters — see [[customer-dedupe]]) archived the
duplicates, removing the ambiguity, and the re-run picked the calls up. Re-running pass 1 is
safe by construction: it only ever fills columns that are still `NULL`, so it cannot disturb
rows an earlier batch already stamped.

**The archived filter that had to land with it.** The backfill's `cust_keys` had no
`archived_at` filter. That was harmless while nothing was archived — it is how the 87 were
attached — but the merge turned it into a silent trap: a keeper and its archived loser still
share a phone key, so RULE 1 would see two customers and skip exactly the calls the merge was
performed to unblock, with no error. `and cu.archived_at is null` was added to
`migrations/20260818_call_auto_attach_backfill.sql` and is what the re-run used. The live path
never had this bug — `api/ctm-webhook.js` has always filtered `&archived_at=is.null`.

Net effect on prod across 2026-08-19: calls carrying an `ro_id` went **9 → 76**. The three
backfill batches account for 36 + 20 + 6 = 62 of that; the remainder is the live path
(`0000…`) working the same day.

**A human's touch takes the row out of the robot's namespace** — this is what stops an undo
from revoking a person's decision:
- **un-attach** clears all three tags, and clears `ro_id` **only if `auto_ro_filed_at` was set**
  (an `ro_id` a human filed stays);
- **manual re-file** of `ro_id` (the `checking_on_car` picker) clears **`auto_ro_filed_at`
  only** — if the robot attached the *customer*, `auto_attached_at` stays true, because it is
  still true.

## 4. Where it runs — the two call sites
**Call site 1 — on arrival (`api/ctm-webhook.js`, `autoAttachCall`).** Runs right after the
`calls` upsert, on the row the upsert returned (`Prefer: return=representation`). Service-role,
so no RLS involved. **Strictly best effort:** it is wrapped so it can never throw into the
handler, and every early return leaves the call in the pile. *A call is never lost because
attach failed.* If the customer lookup 4xxs it logs the likely cause — the §6 migration not
having been run on that project.

**Call site 2 — when a HUMAN attaches (`autoFileRoForCall` in `advisor-board.html`).** Rule 2
cannot be a one-shot at arrival: a call is usually matched to its customer minutes or days
later, and at arrival there may have been no customer to check ROs for. So the open-RO check
**re-runs at the moment a person attaches** — which is exactly what the pass-2 backfill did for
the backlog (17 rows). It fires from all three human attach paths:
- Desk `performAttach` (attach button / suggestion / picker),
- caller-card `persistCustomer` (picking from a multi-match),
- caller-card `saveNote` — but **only** when that save is what first folded in `customer_id`,
  and **only** when the save didn't itself set `ro_id` (a human's explicit pick always wins).

**Both writes are atomic in the database, not in JS.** The webhook PATCHes with
`?id=eq.<id>&customer_id=is.null&not_a_customer_at=is.null`; the board updates with
`.is('ro_id', null)`. If a human got there first, the write matches **zero rows** and the robot
loses the race harmlessly. This is the same seam as `setSecondaryIfNull` in
`shared/call-attach.js`: the decision belongs to the DB, not to a possibly-stale snapshot.

## 5. The backfills (done, on the sandbox only)
Both were written out, reviewed, and run **by hand** against `efhmefpaijjncwgbvwki`.

- **Pass 1** — `customer_id is null`: applied rules 1 and 2. **64 attached, 25 filed.**
- **Pass 2** — `customer_id is not null and ro_id is null and auto_attach_run_id is null`:
  rule 2 only, on calls a **human** had attached but never filed. **17 filed.** It sets
  `auto_ro_filed_at` and its run id but **never `auto_attached_at`** (a human attached those
  customers), and its reverse never names `customer_id` at all — structurally unable to undo a
  human attach.
  ⚠️ The `auto_attach_run_id is null` clause is load-bearing: without it pass 2 would have
  overwritten pass 1's run id on 39 rows and orphaned them from pass 1's undo.

Net effect on the sandbox: calls carrying an `ro_id` went **4 → 46**.

## 6. What still has to be run by hand
1. `migrations/20260818_call_auto_attach.sql` — the three undo columns. **Done on sandbox.**
2. `migrations/20260818_customers_phone_l10.sql` — **not yet run anywhere.** Two GENERATED
   `text` columns (`phone_primary_l10`, `phone_secondary_l10`) plus partial indexes.
   **Why it is required, not an optimization:** phones are stored as typed — `(786) 531-5419`
   sits next to `8135909459` — and **PostgREST cannot filter on a function expression**, so a
   bare functional index would be unusable from the webhook. Making the key a real stored
   column also moves its *definition* into the database, in the same expression the backfill
   SQL and `last10Key` use — so live and backfill cannot drift by accident.
   **Until it runs, call site 1 matches nobody** (it logs the reason). Call site 2 is
   unaffected — it queries `repair_orders`, not phones.

No new RLS is needed for any of it: `public.calls` already carries SELECT + UPDATE for **both**
`anon` and `authenticated` (`20260728_calls.sql`, `20260728_calls_notes.sql`,
`20260801_office_auth_widen_step1_5.sql`), and those policies are table-level `using (true)`,
so new columns are covered automatically.

## Known gaps & open questions (as of 2026-08-18)
- **~69% of the pile is strangers** — 162 of 236 unattached sandbox calls match no customer at
  all. No rule fixes that; the "needs filing" section stays the biggest section on most records.
- **Ambiguity is the duplicate backlog.** Every one of the 9 ambiguous sandbox calls is the
  *same* person on two rows (`IAN GEQUELIN` / `ian gequelin`). They unlock for free when
  [[customer-dedupe]] phases B–D run. Auto-attach and dedupe are the same 9 calls.
- **Unconfirmed calls can't be filed to an RO.** The Customer Record's "File to RO…" is offered
  on **confirmed** calls only (§7). A phone-matched unconfirmed call has to be attached to the
  customer first — correct, but it means the calls that arrive on a record via a *learned*
  secondary number (see the warning in §8) can't be filed straight from the record.
- **`noted_by_name` is "who handled the call", not "who filed it".** A manual re-file stamps it
  only when the call was never noted; re-filing a call someone else noted leaves their name.
  There is no separate filed-by column and this build did not invent one.
- **Call site 1 is unverified against a real CTM call** — it can only be exercised by an actual
  inbound call after the §6 migration runs.

## Where it lives in the code
- **Rules (pure, tested):** `shared/call-auto-attach.js` — `last10Key`, `isJunkNumber`,
  `shouldAutoAttach`, `isOpenRoAt`, `pickCustomer`, `pickOpenRoAt`, the patch builders
  (`autoAttachCallPatch` / `autoFileRoPatch` / `clearAutoTagsPatch`), `isAutoAttached`,
  `AUTO_ATTACH_LIVE_RUN_ID`. Tested by `shared/call-auto-attach.test.js` (23 tests).
- **Call site 1:** `api/ctm-webhook.js` — `autoAttachCall`, called from the `trigger === null`
  branch after `upsertCall` (which now returns the upserted row).
- **Call site 2:** `advisor-board.html` — `autoFileRoForCall` (script top level, shared by both
  IIFEs); wired into `performAttach`, `persistCustomer`, `saveNote`. Tag clearing in
  `performUnattach` and in `saveNote`'s `ro_id` branch. `LOG_COLS_AUTO` is the third select
  tier that loads the auto columns.
- **Migrations (hand-run):** `migrations/20260818_call_auto_attach.sql` (undo tag),
  `migrations/20260818_customers_phone_l10.sql` (lookup key + indexes).
- **Consumer:** the Customer Record's `computeCallGroups` — every call this fills moves from
  `unfiled` up into `byRo`. See [[customer-record]] §5.

## 7. The manual re-file — two controls, one rule
Auto-attach can only ever file to an RO that was **open at the time of the call**. Everything
else is a human's job, so both surfaces where a call is visible got a picker. Both reuse
`RoCalls.buildRoPickerOptions` **untouched** — already status-agnostic, already stage-labelled,
so **closed ROs are listed**, which is precisely the case the robot cannot handle.

| | Call card (`.cc-filed`, `renderFiledRo`) | Customer Record (`fileCallToRo`) |
|---|---|---|
| Where | a persistent **"Filed to RO"** row on the popup | a `<select>` on each **needs-filing** entry |
| When | any disposition, or none | **confirmed** calls only |
| Writes via | `saveNote({ ro_id })` | direct `calls` update |
| After | picker re-renders | `rerenderCustBody()` — the entry jumps out of needs-filing |

**The rule both obey (non-negotiable): a human's touch clears the robot's file tags.**
`clearAutoFileTagsPatch()` sets `auto_ro_filed_at = null` **and `auto_attach_run_id = null`.
Dropping the run id is the point** — it detaches the row from every batch undo, so no reverse
statement can revoke a decision a person made. `auto_attached_at` deliberately survives: it is
a factual record that the machine picked the customer, and with the run id gone it is no longer
an undo key, just history (and what the `auto` chip reads).

⚠️ **The trade this makes, on purpose:** once a human re-files a call, that row's *original*
machine attach is no longer reversible as part of a batch either — the live-undo statement will
skip it. Un-attaching by hand still clears it. Safety beats completeness.

**Un-attach is different** and still clears everything (`clearAutoTagsPatch`), plus `ro_id`
itself when `auto_ro_filed_at` was set: the call is no longer that person, so nothing the
machine derived from that link survives.

## 8. Attaching a call can teach a customer a phone number — and now it ASKS FIRST
Not part of auto-attach — the robot never learns phones (§2) — but it is the blast radius a
manual attach has, and it interacts with this subsystem, so it is recorded here.

**What it used to do (the incident, 2026-08-18).** `performAttach` ran `attachPhoneLearn`
unconditionally: if the caller's number was new and the customer's `phone_secondary` slot was
**empty**, the attach silently wrote it there. Because the Customer Record unions
**phone-matched** calls ([[customer-record]] §2), every other call from that number then
appeared on that customer's record as **unconfirmed**. Attaching one call from `305-393-9103`
to `JOSE RAMIREZ` wrote that number into his empty slot and **six** calls surfaced on his
record. Reversing the *call* by raw SQL did **not** undo it — only the in-app un-attach does.

**What it does now.** The learning is still wanted; the silence was the bug. When an attach
*would* learn a number, the Desk call log asks inline first — see [[call-window-desk]] §2c for
the full behaviour. The parts that matter here:
- **the attach is never gated on the answer** — the call is linked first, `learned_phone` false;
- the question **defaults to NO** when other calls from that number aren't this customer's,
  which is exactly the Hector/Jose shape;
- un-attach still clears a learned number, unchanged (`unattachClearsSecondary`).

This does not change anything the robot does: auto-attach still never writes a phone under any
circumstances, so no prompt ever appears for a machine attach.

## Session change log
- 2026-08-19 — **Shipped to prod, and pass 1 had to run twice.** Migrations applied and verified
  on `hygemiszxwmyrkmhbjub`; pass 1 attached 87 (36 filed), pass 2 filed 20. Customer-merge
  slice 1 then archived three duplicate customers, which unblocked calls RULE 1 had been
  correctly refusing to guess on (two customers per phone), and a pass-1 re-run under a NEW run
  id `33333333-4444-4555-8666-777777777777` picked up 11 more (6 filed). §3 rewritten: the
  run-id table now carries an Env column with both projects, plus why the re-run needed its own
  id (reusing `1111…` would have fused two batches into one undo unit). Prod `ro_id` coverage
  9 → 76 across the day. Also added the load-bearing `and cu.archived_at is null` to `cust_keys`
  in the backfill — without it the merge would have made RULE 1 skip, silently, the very calls
  the merge existed to unblock. Audited every other customer-by-phone path for the same gap;
  all were already filtering (see below).
- 2026-08-18 — **Confirm-before-learning** (§8 rewritten). The silent phone write on attach is
  gone: the Desk call log now asks inline, defaulting to NO when the number has other calls that
  aren't this customer's. The attach itself is never blocked by the question. Rules +
  11 tests in `shared/call-attach.js`; see [[call-window-desk]] §2c.
- 2026-08-18 — **Built the manual re-file (§7) and the auto chip.** Decoupled `ro_id` from
  `next_step` on the call card — the RO picker is now its own persistent "Filed to RO" row
  under every disposition, and the chip handler no longer wipes the link
  ([[call-window-desk]] §2b/§3). Added "File to RO…" to the Customer Record's needs-filing
  section ([[customer-record]] §6b) and an `auto` chip to timeline entries (§6c). Added
  `clearAutoFileTagsPatch` so both controls take a re-filed row out of the robot's namespace.
  Documented the phone-learning blast radius in §8. Verified in-browser against the sandbox
  with the writes intercepted — nothing was mutated.
- 2026-08-18 — **Created. Built the going-forward path.** Added the pure rules module +
  23 tests; wired call site 1 (CTM webhook, best-effort, atomic DB-side guard) and call site 2
  (re-run rule 2 on every human attach, from all three attach paths); added the LIVE run-id
  sentinel; made un-attach and manual RO re-file clear the robot's tags so an undo can never
  revoke a human decision; added the third `LOG_COLS_AUTO` select tier so a project without the
  auto columns keeps the existing attach UI. Wrote `migrations/20260818_customers_phone_l10.sql`
  (generated last-10 columns + partial indexes) — **not run**. Both backfills (§5) were run by
  hand on the sandbox earlier the same day: 64 attached, 25 + 17 = 42 filed, `ro_id` coverage
  4 → 46.
