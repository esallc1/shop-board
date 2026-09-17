# How the employee roster is wired

> Doc: `/docs/wiring/employee-roster.md`
> ⚠ **2026-09-17 — Security Phase 2 on branch `security/phase2-pins` (UNMERGED; migrations M1/M2 NOT applied anywhere).** PINs move to `employee_secrets` (hashes) and
> `employees.pin` is dropped (§1c); the GM editor loses its PIN box (§1d); `employees_visible`
> gets an explicit column list (§1a). PIN values removed from this doc (it is served publicly).
> Until M1/M2 run, the LIVE databases are still as described in the older text.
> Previously: 2026-08-21 — §7 added (assignment-vs-role audit + the write-safety rule);
> slice COMPLETE: retirements + unique index applied.
> Verified vs commit `617b419` (live on prod).
> Status: 🟢 **fully live on both projects.** Flag + view + the five ZZ accounts applied
> 2026-08-21; code live on prod at `617b419`; the five departed rows retired (§6a) and
> `idx_employees_phone_active_digits` created and negative-tested on both projects (§5).
> Related: [[office-auth]] §1b/§1c, [[staging-db]] §7/§8, [[settings]], [[todo-list]].

## 0. In one line
`employees` is the shop's roster, and almost every screen reads it — so adding a hire,
retiring a leaver, or logging in as a test account must never silently break who-did-what.

## 1. Two tables, one rule

| Read it for… | Read | Why |
|---|---|---|
| Anything a human sees — pickers, tech lists, commission, chat, adoption, the GM editor | **`public.employees_visible`** | hides `is_test` rows |
| Login, identity resolution, anything that stamps a name on a write | **`public.employees`** | a test account must be able to log in |

```sql
-- LIVE today (both projects):
create or replace view public.employees_visible as
  select * from public.employees where not is_test;
-- After M2 (migrations/20260917_pin_off_public_M2_drop_pin.sql): same filter,
-- security_invoker = true, an EXPLICIT column list = every employees column (pin is gone).
```

`is_test boolean not null default false`. **It is not the same as `active`:**

- `active = false` → **retired staff.** Real person, gone. History stays attributed to them.
- `is_test = true` → **a QA login.** Never a person. Hidden from every roster, forever.

Conflating them would make a retired employee indistinguishable from a fake one.

### 1a. ⚠ The `select *` trap
The view's column list is **expanded when the view is created**, not at query time. Add a
column to `employees` and the view will not have it — quietly. **After M2 the list is written
out explicitly**, so this is no longer a trap but a rule: a new `employees` column is NOT on the
view until you add it to the list (`create or replace view` may append columns at the end; it
may not drop one — that needs drop + create + re-grant, as M2 does). **Never add a secret to
it.** Either way, after ANY `alter table public.employees add column`, check:

```sql
select
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='employees')         as base_cols,
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='employees_visible') as view_cols;
```

**These must match.** They were 14 = 14 on both projects on 2026-08-21.

### 1b. The anon grant is preserved, not endorsed
`grant select on public.employees_visible to anon` keeps today's posture: `employees` is
already anon-readable ([[settings]] §3) and every board depends on that with the publishable
key. **Read that grant as "unchanged", not as "reviewed and blessed."** Revisiting it is
tracked as its own security phase.

The view is declared `security_invoker = true` **specifically** so that when the roster is
locked down, this view is covered by that change instead of routing around it. Without it a
view runs with its owner's rights and would happily read past a new RLS policy — this
migration would have quietly opened the hole the security phase is meant to close.

### 1c. PINs are hashes in `employee_secrets` — nothing on the API can read them (Phase 2)
- `employee_secrets(employee_id pk → employees.id on delete cascade, pin_hash, failed_attempts,
  locked_until)`. RLS **on** with **no policies**; all grants revoked from anon / authenticated /
  public. Only SECURITY DEFINER functions touch it.
- `login_with_pin(p_phone, p_pin)` is the only reader ([[my-numbers]] §1). bcrypt
  (`gen_salt('bf', 8)`), 5 misses → locked 15 min, zero rows for every kind of failure.
- **Who has a hash:** M1 backfills `Cristian Tech` on every project and `ZZ Test Tech` on
  non-PROD only (`app_env`). Nobody else can PIN-login — nobody else needs to (office staff use
  email; techs don't use My Numbers yet).
- **Setting / rotating / unlocking a PIN is hand-run SQL** — the snippets are at the bottom of
  `migrations/20260917_pin_off_public_M1_employee_secrets.sql`. No UI writes a PIN.
- **PIN values are never written in a doc** (these docs are served on the public origin).

### 1d. The GM editor has no PIN box (Phase 2)
Kevin uses GM board → Employees only to add / edit / remove people so they appear as Tech Board
columns; nobody he adds logs in. `saveEmployee` now requires **name, phone, role** and writes
`{ name, phone, role, active, photo_url }`. Add needs M1 (`employees.pin` DROP NOT NULL) until M2
removes the column. Edit and delete are otherwise unchanged. `set_employee_pin` was deliberately
**not** built.

## 2. Who reads what (verified 2026-08-21)

**21 occurrences across 19 sites read `employees_visible`:** the To-Do assignee menus on all
four office boards; the RO technician + service-writer dropdowns; the Tech Board dispatcher
roster; the GM Technicians / Shop Floor / Tech Status / Teardown / operate-as pickers; the GM
billed-hours id→name map; the GM Settings employee editor; `shared/adoption.js`;
`shared/commission-engine.js`; `shared/board-settings.js` advisor-pay editor; and both
`shared/team-chat.js` rosters.

**Stay on the base table:** the login doors (`crisdata.html` ×1 — its phone/PIN lookup was
deleted 2026-09-17 — and `office-login.html`), the three `shared/office-identity.js` reads
(auth, persisted id, legacy phone — the `?u/p` read was deleted 2026-09-17), both `my-numbers.html` lookups + its greeting,
`board-settings.js`'s own-profile read, and all nine writes (GM employee CRUD, own name /
background / avatar, advisor pay).

**Two cannot be moved and must not be:** the PostgREST FK embeds
`service_writer:employees!service_writer_id(name)` in `advisor-board.html` and
`bookkeeping-board.html`. Embeds resolve against the base table's foreign key; there is no
filter to add. This is correct — if a test advisor writes an RO, that RO should show the fake
name. **Test *accounts* are hidden; test *data* is not.** Anything a ZZ account creates —
ROs, photos, to-dos, calls — is ordinary data and needs cleaning up by hand.

## 3. The test accounts

Five rows, `is_test = true`, `active = true` (active is REQUIRED — every login path filters
it). Phones are in the reserved-for-fiction `555-01xx` range so they can never collide with a
real hire.

| Name | Phone | Role | Lands on |
|---|---|---|---|
| ZZ Test Tech | 5550100001 | `tech` | `my-numbers.html` (PIN — sandbox only, §1c) |
| ZZ Test Advisor | 5550100002 | `advisor` | `advisor-board.html` |
| ZZ Test GM | 5550100003 | `manager` | `gm-board.html` |
| ZZ Test Owner | 5550100004 | `owner` | `owner-board.html` |
| ZZ Test Bookkeeping | 5550100005 | `bookkeeping` | `bookkeeping-board.html` |

PINs are not listed here. An earlier version of this table printed them on a publicly served
page, so the sandbox ZZ Test Tech PIN is burned — rotate it with the M1 snippet if it matters.

Roles are the five `ROLE_DEST` keys (`crisdata.html`): **`manager`, not `gm`.** A role outside
that map produces an account that signs in and routes nowhere.

**`ZZ ` is a reserved prefix.** Every roster read is `.order('name')`, so if a filter is ever
missed the test rows sort **last** and read as obviously fake, rather than blending in among
real staff. Never name a real employee `ZZ …`.

**They no longer sign in by URL.** Until 2026-09-17 a ZZ phone + PIN in the query string
(`advisor-board.html?u=…&p=…`) resolved a full identity with no `auth.users` row. That
pass-through was **deleted** (a PIN in a URL is logged and kept in history), so on `test.*` the
office boards are exercised with the ZZ accounts' **email logins** on the front door, and the tech
account with its phone + PIN typed on `my-numbers.html`.

## 4. RETIRE AN EMPLOYEE — the procedure

1. Find the row: `select id, name, role, phone, active from public.employees where …`
2. Retire it with a **self-guarding** UPDATE ([[staging-db]] §8.2) — the environment check goes
   INSIDE the statement, so the wrong project changes zero rows instead of the wrong rows:
   ```sql
   update public.employees
   set active = false
   where id in ('<id>')
     and (select env from public.app_env) like 'PROD%'
   returning id, name, role, phone, active;
   ```
   The expected row count in `returning` is the pass. An empty result means wrong project (or
   wrong id) — not "done".
4. **Never `delete`.** Deleting breaks the `service_writer_id` FK and orphans every historical
   `technician` / `noted_by_name` / `uploaded_by` string. Retiring preserves attribution; that
   is the entire point.
5. **Do not clear `phone`.** The partial index (§5) already frees it for reuse by a new hire,
   and clearing it destroys the audit trail.
6. **Do not clear `auth_user_id`.** Disable the auth user in the Supabase dashboard instead.
7. Verify no active duplicates remain:
   ```sql
   select regexp_replace(phone,'\D','','g') as digits, count(*),
          string_agg(name || ' (' || role || ')', ' | ' order by name) as who
   from public.employees
   where active and phone is not null and trim(phone) <> ''
   group by 1 having count(*) > 1;
   ```
   **Zero rows.**
8. If they were an advisor, confirm open ROs still resolve a service writer.

## 5. ADD A NEW HIRE — what to check before saving

1. **Know your project** — `select env from public.app_env;`, and prefer a self-guarding
   statement ([[staging-db]] §8.2) over remembering to check.
2. **Phone digits not already held by an ACTIVE employee.** The index enforces it; check first
   so the failure is a sentence, not a constraint violation.
3. **Role is one of** `tech` · `advisor` · `manager` · `owner` · `bookkeeping`.
4. **`is_test` stays false.** The GM editor cannot set it — SQL only, by design.
5. **Name does not start with `ZZ `** (reserved, §3).
6. **One row per human.** See §6.
7. Reusing a departed employee's phone is fine **once that row is `active = false`** — that is
   exactly what the partial index allows.

### The constraint (✅ APPLIED to both projects 2026-08-21)
```sql
create unique index if not exists idx_employees_phone_active_digits
  on public.employees ((regexp_replace(phone, '\D', '', 'g')))
  where active and phone is not null and phone <> '';
```
Digits-normalized so `239-600-1971` and `2396001971` cannot both exist. Partial on `active` so
retired rows keep their history and a phone becomes reusable after retirement.

**Proven by a NEGATIVE test, not by existing.** On both projects, inserting a duplicate active
phone inside a rolled-back transaction raised **`23505 duplicate key`**. An index that exists
but never fires is indistinguishable from no index — the same failure shape as the retired
run-id guard ([[staging-db]] §8.1). Re-run the negative test after any restore:
```sql
begin;
-- needs M1 (pin nullable) — before M1 this raises 23502 not-null instead, proving nothing
insert into public.employees (id, name, phone, role, active, is_test)
values (gen_random_uuid(), 'ZZ Dup Probe', '5550100002', 'tech', true, true);
rollback;    -- expect: ERROR 23505 before this line is reached
```

## 6. ⚠ Why this doc exists: Josh

**Josh / Joshua / Jay Tech is ONE person with TWO employee rows**, sharing phone `9416260382`
**and** the same PIN. Cristian and "Cristian Tech" share `2396001971` with different PINs.

`employees.phone` was never unique, and every phone lookup ended in `.maybeSingle()`, which
**errors on a multi-row match instead of picking one**. Two rows sharing a phone therefore
resolved to **nobody** — and because identity is passive by design, the board loaded normally
and showed nothing. No greeting, no To-Do, no commission card, and every `CHAT_IDENTITY.name`
write landed `NULL`.

The Cristian case is the nastier shape: the then-existing `?u/p` URL login (deleted 2026-09-17)
disambiguated on the PIN, so the **first** login worked; only the phone was persisted, so **every return visit failed**. Works once, then stops.

Fixed 2026-08-21 in three layers, so no single one has to be perfect:
- **Structural** — the §5 index makes two active rows sharing a phone impossible.
- **Identity** — `shared/office-identity.js` persists the employee **UUID**, not the phone
  (same storage key; a legacy phone value resolves once and rewrites itself as the id). A phone
  is mutable, reusable and non-unique; an id is none of those.
- **Audible** — every phone lookup filters `active`, uses `.limit(2)`, and on a multi-row match
  logs `AMBIGUOUS phone …` and shows a visible line instead of returning a silent `null`.
  `my-numbers.html` does the same, with an alert that says it is not the tech's PIN.

**The lesson, which is the same one as `CHAT_IDENTITY` ([[office-auth]] §1b) and the retired
run-id guard ([[staging-db]] §8.1): a check that cannot fail loudly is not a check.** All three
looked healthy while telling you nothing.

## 6a. The retirement that closed it — the worked example (2026-08-21)

Five rows retired on **both** projects. Cristian (owner) untouched.

| Retired | Why |
|---|---|
| Cory | left the shop — the byline that was being borrowed to test |
| Josh | left; one of his two rows |
| Jay Tech | left; Josh's other row, same phone `9416260382`, same PIN |
| Cristian Tech | no longer needed once ZZ Test Tech existed |
| Alex | left the shop |

Retiring **Cristian Tech** cleared the `2396001971` collision; retiring **Josh + Jay Tech**
cleared `9416260382` outright. That is what unblocked the §5 index.

### Verify with counts, NOT with an empty result
The obvious check — "duplicates query returns zero rows" — cannot tell a passing check from a
typo'd one. Both look like nothing. Ask instead for the duplicate phones **with their active
counts**, so rows appearing proves the query ran and `active_rows <= 1` proves the fix:

```sql
select regexp_replace(phone,'\D','','g') as digits,
       count(*) filter (where active) as active_rows,
       count(*)                       as total_rows,
       string_agg(name || ' (' || role || case when active then '' else ', RETIRED' end || ')',
                  ' | ' order by name) as who
from public.employees
where phone is not null and trim(phone) <> ''
group by 1 having count(*) > 1
order by 1;
```

Actual result on both projects:

| digits | active_rows | total_rows |
|---|---|---|
| `2396001971` | **1** | 2 (Cristian active, Cristian Tech retired) |
| `9416260382` | **0** | 2 (both retired) |

### What retiring did NOT break — and why that is by design
`employees_visible` filters **`is_test` only, never `active`.** Retired staff are still in the
view. That is deliberate: the GM billed-hours id→name map (`gm-board.html`, `renderTechnicians`)
reads the view with **no** active filter, so a labour line credited to a retired tech still
resolves their name. Pickers filter `active` themselves and correctly stop offering them.

**Retiring removes someone from the future, never from the past.** Any change that makes a
retired employee's name stop resolving in a historical report is a bug, not a cleanup.

## 7. Assignment is not role — the audit, and the rule

Attribution is a **stamp, not a live link.** `repair_orders.technician`,
`attachments.uploaded_by`, `calls.noted_by_name` and friends are denormalized strings written at
the moment, the same way a part number is written onto an RO line. Nothing resolves them through
a live join to `employees`, which is why retiring five people on 2026-08-21 left every historical
byline intact.

So only two things need to be live: **who can log in**, and **what a picker offers**. Everything
else is a frozen copy and was already correct. A full audit of all `employees` reads on
2026-08-21 found **5 of 12** asking the wrong question — all keying off `role` as a proxy for
assignment. All five are fixed.

### 7a. THE WRITE-SAFETY RULE — `shared/assignee-picker.js`
**A picker must always contain whoever is CURRENTLY assigned, even when they would no longer be
offered.**

This is not cosmetic. A `<select>` whose value matches no `<option>` does not render blank — it
displays `option[0]`. The next person to open the row sees "Unassigned", saves something
unrelated, and the assignment is gone with no error. **The control turns an ordinary save into a
deletion.** Broken and healthy look identical, which is the recurring shape in [[office-auth]]
§1b and [[staging-db]] §8.1.

`buildAssigneeOptions(roster, current, opts)` guarantees **exactly one selected option, always**,
and appends the current assignee when the roster lacks them. `shared/ro-writer.js` delegates its
union to the same primitive (`appendCurrentIfMissing`), so the service-writer dropdown and the
floor pickers cannot drift apart. 11 tests in `shared/assignee-picker.test.js`.

**The two floor sentinels are deliberately NOT unified:** lifts store `''` for unassigned,
parking stores the literal string `'Unassigned'`. Both are live data; normalising either would
rewrite rows. Each caller passes its own `unassignedValue`, and two tests pin it.

### 7b. Which reads key off what

| Keys off ASSIGNMENT (correct) | Keys off ROLE (correct — identity or pay) |
|---|---|
| Tech Status columns, dispatcher columns ([[tech-board]] §2a) | **Advisor commission** — only advisors are on the plan (`commission-engine.js:195`) |
| Technicians page + Billed Hrs ([[manager-board]] §1, §3) | Adoption panel grouping (office vs techs) |
| My Numbers job list *and* its login gate (no role filter at all) | `ROLE_DEST` — which board you land on |
| All assignee pickers (§7a) | Operate-as picker (a role-scoped admin tool) |

**Pay that depends on who someone *is* keys off role. Credit for work that *happened* keys off
the assignment stamped on it.** That line is the whole audit in one sentence.

### 7c. ⚠ Scope of the defect — measured, not assumed
The bug **would** hide any job assigned outside `role='tech'`. Demonstrated on the **sandbox**,
where 5 floor rows held retired names and a test owner-role account held one more: the dispatcher
showed 2 columns covering 2 of 8 assigned jobs before the fix, 5 columns covering 8 of 8 after.

**On PROD the impact was nil, and this doc says so on purpose.** Verified 2026-08-21 against
`hygemiszxwmyrkmhbjub`: `shopboard_lifts`, `shopboard_parking` and `shopboard_pickup` return
**zero** rows assigned to any retired name. The sandbox rows are stale clone data from 08-12 that
prod has since moved past. The one prod row carrying a retired name is **RO #6010** (Belky Arcia,
2016 Ford Explorer Interceptor, `status = 'estimate'` since 2026-07-27, `technician = 'Cory'`) —
confirmed the *only* non-closed RO with a retired technician; the other 14 are `closed`. **That
is a stale estimate, not hidden work.**

Recorded this way after a first draft of this section reported the sandbox figure as six live
jobs hidden from the shop. It was caught in review. **A doc that overstates an incident fails the
same way as one that understates it** — both leave the next reader with a wrong model, and an
inflated one also burns the credibility the honest entries depend on. Measure the environment you
are claiming about.

## Known gaps & open questions (as of 2026-08-21)
- **FOLLOW-UP: `loadTodoAssignees` finds "me" by searching the roster.** It reads the roster,
  then looks `CURRENT_EMPLOYEE_ID` up *inside that list* to build the "(me)" option. A test
  account is not in `employees_visible`, so a ZZ login gets **no "(me)" option** — it cannot
  create a personal to-do. Found while verifying this slice.
  **The fix is NOT to put the viewer back into the view** — the view staying a plain static
  filter (`where not is_test`, nothing conditional, nothing viewer-dependent) is exactly what
  makes it easy to reason about, and a view whose contents depend on who is asking is a much
  harder thing to hold in your head. The fix is that "(me)" should be built from the identity
  **already resolved in `applyIdentity`** (`CURRENT_EMPLOYEE_ID` + `CHAT_IDENTITY.name`) rather
  than rediscovered by searching a list. That is more robust for real staff too: **if the
  roster read fails, "me" still works.** Same shape applies to any other feature that locates
  the current user inside a roster response. Owner's call, 2026-08-21; deferred, not forgotten.
- **Test accounts cannot exercise every self-referential feature** until the above lands. Know
  this before concluding a feature is broken because a ZZ login could not use it.
- **`my-numbers.html` still uses the phone AS the tech id** (`findEmployee` returns
  `{ id: data.phone }`). Deliberately deferred to its own slice; the guard above makes the
  failure loud in the meantime.
- **Test data is not cleaned up.** `is_test` hides the person, not the ROs, photos, to-dos or
  calls they create. No tooling for that yet.
- **The anon grant** (§1b) is preserved pending a security phase.
- **No UI can create or edit a test account.** SQL only — a deliberate choice. PINs for anyone
  are SQL only too (§1c).
- **Phase 2 is not live** until M1 → code → M2 run in order (sandbox, then prod). If the
  gm-board code ships before M1, **Add Employee fails** (`pin` still NOT NULL).
- **M2's explicit column list comes from the repo, not the live schema.** §1a recorded 14
  columns on 2026-08-21; the repo's migrations only name 13 (incl. `pin`). M2's post-check refuses
  on any mismatch — fill the list from `…_PREFLIGHT_READONLY.sql` query 2 first.

## Where it lives in the code
- Schema: `is_test` + `employees_visible` (applied by hand to both projects 2026-08-21; the
  §5 index is still pending).
- Resolver: `shared/office-identity.js` (`resolve`, `resolvePhone`, `employeeByPhone`,
  `reportAmbiguous`).
- Tech login: `my-numbers.html` (`findEmployee` → `shared/pin-login.js` → `login_with_pin`;
  `findEmployeeByPhone`, `reportAmbiguousTech`).
- PIN storage: `employee_secrets` + `login_with_pin` —
  `migrations/20260917_pin_off_public_{PREFLIGHT_READONLY,M1_employee_secrets,M1_ROLLBACK,M2_drop_pin,M2_ROLLBACK}.sql`.
- Doors: `crisdata.html` (`doLogin`, `doorRouteOrExplain`, `ROLE_DEST`), `office-login.html`.
- Roster consumers: the four office boards, `crisdata-techboard.html`, `shared/adoption.js`,
  `shared/commission-engine.js`, `shared/board-settings.js`, `shared/team-chat.js`.
- Employee CRUD UI: `gm-board.html` (`loadEmployees`, `saveEmployee`, the delete confirm).

## Session change log
- 2026-09-17 — **Security Phase 2 (branch `security/phase2-pins` (UNMERGED; migrations M1/M2 NOT applied anywhere)):** §1c/§1d added, §1/§1a rewritten for the explicit view list; PIN values scrubbed from §3/§6/§6a; §5 negative test no longer inserts a `pin`. Gaps + code map updated.
- 2026-09-17 — §2 base-table readers and §3 "restored staging" updated: the `?u=&p=` URL login and `crisdata.html`'s phone/PIN lookup are deleted. Rest (incl. counts elsewhere) not re-verified.
- 2026-08-21 — **§7 added: assignment is not role.** Audited every `employees` read; 5 of 12
  keyed off role as a proxy for assignment. Fixed: three pickers now use the shared write-safety
  rule (`shared/assignee-picker.js` + 11 tests), and Tech Status + the dispatcher render the
  roster UNION whoever is assigned. Left alone: advisor commission, adoption grouping,
  `ROLE_DEST`, operate-as. The proposed "can be assigned tech work" flag was **cancelled** — the
  audit showed nothing needed it. §7c records the measured prod impact (nil; one stale estimate,
  RO #6010) after a draft overstated it from sandbox data.
- 2026-08-21 — **Slice complete: retirements + the unique index.** Cory, Josh, Jay Tech,
  Cristian Tech and Alex retired on both projects (Cristian/owner untouched);
  `idx_employees_phone_active_digits` created on both and proven with a negative test that
  raised `23505` — an index that exists but never fires is indistinguishable from no index.
  Verified with active-counts rather than an empty result (§6a), because an empty result cannot
  distinguish a passing check from a typo'd one. Both destructive steps were made
  **self-guarding** on `app_env` rather than relying on a remembered pre-flight — pattern
  recorded in [[staging-db]] §8.2. Status moved to 🟢 fully live.
- 2026-08-21 — **Created with the test-account slice.** Added `is_test` + `employees_visible`
  to both projects and inserted the five ZZ accounts (verified: base_cols 14 = view_cols 14,
  anon grant t|t, `security_invoker=true`, live anon read 10 of 15). Pointed 21 display reads
  at the view — including the GM Settings editor, so test rows are SQL-managed. Rewrote the
  identity resolver to persist the employee UUID instead of the phone and to make an ambiguous
  phone audible instead of a silent null; same guard added to My Numbers. Wrote §4/§5 as
  standing procedures because the roster changing is normal and must stop being dangerous.
  The §5 unique index and the retirement of the departed rows are NOT done yet.
