# How the staging database is wired

> Doc: `/docs/wiring/staging-db.md`
> Last updated: 2026-08-21 — §8 added (`app_env`, replacing the drifting run-id guard);
> §7 added: staging cannot verify ANY office-identity path (no `auth.users` rows + a
> phone/PIN collision). Verified vs commit `dc39a76`.
> Created 2026-08-12 for the staging-DB isolation build (branch
> `feat/staging-db-isolation`). Boards swapped to the switch; schema step revised to
> `pg_dump --schema-only` after the assembled-migrations file proved unusable (base
> tables `employees`/`chat_messages` predate the checked-in migrations).
> Status: 🟡 in progress — code side built & unit-tested (`shared/supabase-config.js`,
> the `/api/*` env-with-fallback change, the 12-board swap); the Supabase project +
> schema/data load + Vercel env are owner steps below.

## 0. In one line
`test.leetransmissionshop.com` (and every Vercel preview + localhost) talks to a
**separate staging Supabase project** with its **own database**; production keeps its
own DB, untouched. Same code on every branch — which DB a page uses is chosen **at
runtime by hostname**, so write-features (auto-attach, photos, intake) can be built and
tested on `test.*` without ever touching live customer data.

## 1. Which project is which
| | Production | Staging |
|---|---|---|
| Supabase project ref | `hygemiszxwmyrkmhbjub` | **(new — created in Step 1)** |
| Used by | apex / `www` / `board.leetransmissionshop.com`, prod Vercel aliases | `test.leetransmissionshop.com`, all `shop-board-git-*` previews, `localhost` |
| Vercel deployment | Production (branch `main`) | Preview (branch `staging` + feature branches) |
| Data | real customer data | a one-time COPY of prod (deletable anytime, never flows back) |

## 2. How a page picks its database (the switch)
Because the boards are **static HTML with the Supabase URL + anon key hardcoded**, and
`staging` is the *same code* as `main`, we can't select a DB with client env vars. Instead
**`shared/supabase-config.js`** ships identically on every branch and self-selects by
hostname (`window.cdSupabaseCreds()` → `{ url, key, env }`):
- **PROD** ← the apex or any `*.leetransmissionshop.com` **except `test.*`**, plus the known
  prod Vercel aliases (`shop-board-ten`, `shop-board-leetransmission-kiki`).
- **STAGING** ← everything else (so `test.*`, previews, and localhost are staging).

A brand-new prod subdomain is prod by default; only `test.` is carved out. The
anon/publishable keys are public (they already ship in the HTML), so embedding both is
fine. Logic is unit-tested in `shared/supabase-config.test.js` (paramount invariant: **no
prod hostname ever resolves to staging**).

**`/api/*` functions** read `process.env.SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY`, each **falling back to the prod value** when the env var is
unset. Vercel env is scoped: **Preview → staging**, **Production → prod**. Since `staging`
+ feature branches are Preview deployments and `main` is Production, api-side selection
lines up with the client-side hostname rule automatically. Prod is safe even if the env
vars are never set (fallback = prod).

## 3. RUNBOOK — exact steps (Cris in the console; Claude in the repo)

### Step 1 — Create the staging project *(Cris, Supabase dashboard)*
1. supabase.com → **New project** (same org). Name e.g. `crisdata-staging`. Pick a strong
   DB password and **save it** (needed in Step 3). Same region as prod is fine.
2. When it's up, open **Project Settings → API** and copy:
   - **Project URL** (`https://<newref>.supabase.co`) — *public, send to Claude.*
   - **anon / publishable key** (`sb_publishable_…`) — *public, send to Claude.*
   - **service_role key** — **SECRET. Do NOT paste in chat.** You'll put it straight into
     Vercel in Step 5.
3. **Project Settings → Database** → copy the **Connection string (URI)** — this is the
   staging `psql`/`pg_dump` target for Step 3.

### Step 2 — Recreate the schema *(Cris, terminal)*
**Why not an assembled-from-`/migrations` file:** `/migrations` is an *incremental* history
that assumes a pre-existing base schema — `public.employees` and `public.chat_messages` are
referenced by the migrations but **created by no migration** (they predate the checked-in
history). So no `/migrations`-only script can build the DB from empty. Prod's own `public`
schema is the complete source.

**Three things a plain `pg_dump --schema-only -n public` restore does NOT handle**, all fixed
by the procedure below: (1) prod (shared with KiKi) uses **pgvector** and a `--schema-only`
dump doesn't create extensions → `type public.vector does not exist`; (2) the dump emits
`CREATE SCHEMA public;` which already exists on a fresh project; (3) `--no-privileges` strips
the GRANTs `anon`/`authenticated` need, so PostgREST can't read the tables. The procedure
detects prod's extensions and enables them, resets `public` cleanly (idempotent), sets default
privileges + grants for the API roles, then applies the schema. Run from the repo root with
`$PROD_DB`/`$STG_DB` already set:
```bash
( set -euo pipefail
: "${PROD_DB:?PROD_DB not set}"; : "${STG_DB:?STG_DB not set}"

# 1) DETECT prod's extensions (READ-ONLY on prod) -> a CREATE EXTENSION script.
psql "$PROD_DB" -Atc "select format('create extension if not exists %I with schema %I;', e.extname, n.nspname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname<>'plpgsql' order by 1;" > /tmp/stg_ext.sql
echo '--- will enable on staging ---'; cat /tmp/stg_ext.sql

# 2) RESET staging public schema + restore grants (idempotent; WIPES staging). Default
#    privileges make every table the schema step creates readable by anon/authenticated.
psql "$STG_DB" -v ON_ERROR_STOP=1 <<'SQL'
drop schema if exists public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all   on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
SQL

# 3) ENABLE the extensions on staging (idempotent; present ones no-op). "vector" is the one
#    the schema needs. If it can't be created here, enable it once in Database -> Extensions.
psql "$STG_DB" -f /tmp/stg_ext.sql || true
echo '--- prod extensions still MISSING on staging (want: empty) ---'
comm -23 <(psql "$PROD_DB" -Atc "select extname from pg_extension order by 1") <(psql "$STG_DB" -Atc "select extname from pg_extension order by 1")

# 4) DUMP prod public schema (READ-ONLY) and APPLY (strip the dump's CREATE SCHEMA public).
pg_dump "$PROD_DB" --schema-only --no-owner --no-privileges -n public -f prod-schema.sql
grep -vE '^CREATE SCHEMA (IF NOT EXISTS )?public;' prod-schema.sql > prod-schema-fixed.sql
psql "$STG_DB" -v ON_ERROR_STOP=1 -f prod-schema-fixed.sql

# 5) Belt-and-suspenders grants on the objects just created.
psql "$STG_DB" -v ON_ERROR_STOP=1 <<'SQL'
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
SQL
echo "OK: schema + extensions + grants done." )
```
Re-runnable from scratch (step 2 drops `public` each time). Then run
**`staging/staging-rls-and-storage.sql`** against `$STG_DB` (both-roles RLS + storage policies),
then the data load (Step 3).

Sanity check: `select count(*) from pg_tables where schemaname='public';` ≈ 40, and every table
has anon + authenticated policies (`select tablename, count(*) filter (where 'anon'=any(roles))
anon, count(*) filter (where 'authenticated'=any(roles)) auth from pg_policies where
schemaname='public' group by 1 order by 1;`).

### Step 3 — Load a one-time data COPY prod → staging *(Cris, terminal)*
This copy lives **only** in staging, never flows back to prod, and can be dropped anytime
with zero effect on prod. Needs a local Postgres client (`pg_dump`/`psql`, v15+).
```bash
# Connection strings from Supabase → Settings → Database (URI). Keep these out of chat.
PROD_DB="postgresql://postgres:<PROD_DB_PW>@db.hygemiszxwmyrkmhbjub.supabase.co:5432/postgres"
STG_DB="postgresql://postgres:<STAGING_DB_PW>@db.<newref>.supabase.co:5432/postgres"

# 1) Dump prod's public DATA only (schema already exists from Step 2). Read-only on prod.
pg_dump "$PROD_DB" --data-only --no-owner --no-privileges -n public -f prod-data.sql

# 2) Load into staging with FK checks + triggers disabled for the load (one session).
psql "$STG_DB" -v ON_ERROR_STOP=1 <<'SQL'
set session_replication_role = replica;
\i prod-data.sql
set session_replication_role = origin;
analyze;
SQL
```
Spot-check parity, e.g. `select count(*) from customers;` in each project's SQL editor.
`pg_dump --data-only` copies **only `public`** — it does **not** copy `auth.users` or
Storage objects (handled in Steps 4a/4b).

### Step 4a — Create the Storage buckets *(run one migration)*
**Run `migrations/20260819_storage_buckets.sql` against the staging project.** It creates all
six buckets with prod's exact public/private flags and all 22 `storage.objects` policies, is
idempotent, and is safe on any environment. That is the whole step.

> ⚠️ **This step used to say "create the buckets by hand in the dashboard", and that is what
> went wrong.** The sandbox was built on 2026-08-12 with **zero** buckets and nobody noticed
> until 2026-08-19, when RO photo upload tried to write. Every storage-dependent feature on
> `test.leetransmissionshop.com` was silently dead for a week — catch-moment, Capture Invoice,
> To-Do and chat attachments, Requests screenshots, diagnosis audio, employee photos. Two
> compounding reasons, both fixed above and in Step 6:
> 1. **A manual step that nothing verifies is a step that silently does not happen.** Step 6
>    checked table reads and writes and never once looked at storage.
> 2. **Step 2 creates storage POLICIES but not BUCKETS**, so this step reading "policies are
>    already created" implied storage was mostly handled. A policy naming a bucket that does
>    not exist does nothing at all.

The old instruction also asked you to mirror a bucket list that included **`attachments`** —
which is not a bucket in this system and never has been (see the note in §5 below). Mirroring
a list from memory is exactly the failure the migration removes.

(The recordings cron runs only on the Production deployment, so `call-recordings` stays
empty on staging unless you upload a test file.)

### Step 4b — Create a staging test login *(Cris, staging → Authentication)*
`auth.users` isn't copied, so make a fresh login: **Authentication → Users → Add user →
Create new user** (email + password of your choice; **Auto Confirm User ON** so
`signInWithPassword` works immediately). Then link that auth user to an employee row so the
boards recognize the session (`office-identity.js` / `office-login.html` resolve identity by
`employees.auth_user_id`, and `role` drives board access — `owner` gets the most). From the
terminal (matches the auth user by the email you chose; links exactly one `owner` row):
```bash
psql "$STG_DB" -v ON_ERROR_STOP=1 -c "
update public.employees
set auth_user_id = (select id from auth.users where lower(email) = lower('YOUR_TEST_EMAIL')),
    active = true
where id = (select id from public.employees where role = 'owner' order by id limit 1)
returning id, name, role, auth_user_id;"
```
`returning` prints the linked row (one row = success). The copied prod `employees` carry stale
prod `auth_user_id` values (prod's `auth.users` weren't copied, so they match nothing on
staging); this overwrites one of them. To log in as a different role, change `'owner'`.

> **Corrected 2026-08-21:** this step used to end "sign in at
> `test.leetransmissionshop.com/office-login.html`". That is wrong now.
> `office-login.html` is the **password-reset** page and deliberately does **not** redirect
> to a board — it signs you in, lets you set a password, and stops (see its header comment).
> The door that routes you to a board is **`crisdata.html`**, via `ROLE_DEST`.
> **Sign in at `test.leetransmissionshop.com/crisdata.html`.**
>
> **Link the `advisor` row, not `owner`, if you need the customer record.** `#view-customer`
> and the RO photo grid exist **only** in `advisor-board.html`; `ROLE_DEST` sends `owner` to
> `owner-board.html`, which has no customer record. See §7.3.

### Step 5 — Point staging at the new project *(Claude wires code; Cris sets Vercel env)*
- **Claude (once you send the staging Project URL + anon key from Step 1):** fill those two
  values into `shared/supabase-config.js` (`STAGING.url` / `STAGING.key`, replacing the
  `__STAGING_*__` placeholders), and swap each of the 12 boards from its two hardcoded
  `SUPABASE_URL`/`SUPABASE_KEY` constants to:
  ```html
  <script src="shared/supabase-config.js"></script>   <!-- before the board's own script -->
  ```
  ```js
  const { url: SUPABASE_URL, key: SUPABASE_KEY } = window.cdSupabaseCreds();
  ```
  Boards: `advisor-board`, `gm-board`, `bookkeeping-board`, `owner-board`, `crisdata`,
  `office-login`, `my-numbers`, `shop-board`, `tech-board`, `teardown`, `crisdata-floor`,
  `crisdata-techboard`. Then merge to `staging` (never a bare `staging → main` that would
  carry nothing dangerous — the file is identical either way, that's the point).
- **Cris (Vercel → shop-board → Settings → Environment Variables):** add, scoped to
  **Preview** only, pointing at STAGING:
  `SUPABASE_URL = https://<newref>.supabase.co`,
  `SUPABASE_ANON_KEY = sb_publishable_<staging>`,
  `SUPABASE_SERVICE_ROLE_KEY = <staging service_role>`.
  Optionally set the same three at **Production** scope = the **prod** values (documents
  intent; behavior is unchanged because the code already falls back to prod). **Never** set
  Preview to prod values. Redeploy `staging` after saving.

### Step 6 — Verify isolation *(Cris + Claude)*
0. **`select env from public.app_env;`** in each project's SQL editor — the definitive
   which-database-am-I check. See §8; do not substitute a row count.
1. On `test.leetransmissionshop.com`, open DevTools console: `window.CD_SUPABASE` → `env:
   "staging"`, url = the new ref. On `board.leetransmissionshop.com`: `env: "production"`.
2. Make a **harmless write on `test.*`** (e.g. add a To-Do) → it appears in the **staging**
   project's table and **not** in prod. Do the reverse on prod → not in staging.
3. Confirm a prod row count is unchanged before/after staging write-testing.
4. **STORAGE EXISTS — do not skip this one.** Tables can be perfect while storage is empty,
   and that combination looks completely healthy until a feature tries to upload:
   ```sql
   select count(*) as buckets from storage.buckets;          -- must be >= 6, NEVER 0
   select id, public from storage.buckets order by id;       -- flags must match prod
   ```
   Then prove it end to end in the browser, because a bucket can exist while its policies
   don't: on `test.*`, open any board and use **📸 Catch this moment** to save one photo. It
   should appear in the Owner board's Marketing Content tab. If the bucket row exists but the
   upload 400s, the `storage.objects` policies are missing — re-run
   `migrations/20260819_storage_buckets.sql` and read its NOTICEs (it is best-effort per
   policy, because `storage.objects` is owned by `supabase_storage_admin` and some projects
   refuse policy DDL from the SQL editor).

## 4. Tear down / refresh the staging DB later
- **Refresh data** (re-snapshot prod): truncate staging public tables (or re-run Step 2 on a
  fresh project), then re-run Step 3.
- **Throw it away:** delete the staging Supabase project (Settings → General → Delete). Zero
  effect on prod. Remove the Preview-scoped Vercel env vars if you want previews back on prod
  (not recommended — previews-on-staging is safer).
- The **code switch stays** either way; with no staging project, `test.*`/previews simply
  fail to reach a DB (loud, not a silent prod fall-through) until a new project's creds are
  pasted into `shared/supabase-config.js`.

## Known gaps & open questions (as of 2026-08-21)
- **⚠ Staging cannot verify any office-identity path — see §7.** This is the big one: it
  silently voids "test on staging first" for a whole class of bug.
- **Auth users aren't copied** (Step 4b creates a fresh staging login). If more staff logins
  are needed on staging, repeat 4b per user. **Nobody has run 4b**, which is §7's root cause.
- **`pg_dump --data-only` fidelity:** if a table has an unusual FK cycle the
  `session_replication_role = replica` wrap handles it; if a specific table errors, load it
  last or `--exclude-table-data` it and copy by hand.
- **Storage objects aren't copied** — buckets start empty. Fine for testing uploads; if you
  need real recording/photo bytes on staging, copy them separately.
- **Crons** (`/api/fetch-recordings`) run only on the Production deployment, so CTM audio
  won't auto-flow into staging.

## 7. ⚠ FINDING (2026-08-21): staging cannot verify ANY office-identity path

**On 2026-08-21, `test.leetransmissionshop.com` could not exercise a single identity-dependent
screen.** `OfficeIdentity.resolve()` returns `null` there for every user, by both of its
branches. A board with no identity still loads — that is the design — so this fails *quietly*:
no greeting, no To-Do, no commission card, no customer record, and every `CHAT_IDENTITY.name`
write lands `NULL`. It looks like an empty board, not a broken one.

### 7.1 Why the auth branch returns null
Step 4b was never run. `pg_dump --data-only` copies `public` only, so the sandbox has **zero
`auth.users` rows**. The copied `employees` rows carry **prod's** `auth_user_id` values, which
match nothing in the sandbox's own `auth` schema. `db.auth.getSession()` finds no session, and
even a hand-made session would fail the `.eq('auth_user_id', user.id)` lookup.

### 7.2 Why the phone branch also returns null — a duplicate-phone collision
The fallback cannot rescue it, because `employees` has **two rows per person** for at least two
people (reported from the sandbox data 2026-08-21; the code behaviour below is verified, the
row contents are not independently confirmed here):

| Phone | Rows sharing it | PINs |
|---|---|---|
| `9416260382` | Josh (`advisor`) + Jay Tech (`tech`) | **the same** — `1738` both |
| `2396001971` | Cristian (`owner`) + Cristian Tech (`tech`) | different |

Both branches of `resolvePhone` end at the same statement in `shared/office-identity.js`:

```js
var p = await db.from('employees').select(EMP_COLS).eq('phone', phone).maybeSingle();
if (p.data) { return {...}; }
```

`.maybeSingle()` **errors when more than one row matches** — it does not pick one. `p.data` is
`null`, and `resolve()` falls through to `return null`. So:

- **Josh / Jay Tech share phone AND pin**, so even the fresh `?u=…&p=…` passthrough is
  ambiguous (`.eq(phone).eq(pin).maybeSingle()` → two rows → error). Josh cannot resolve by
  phone at all, on first login or any later one.
- **Cristian / Cristian Tech share only the phone.** The `?u/p` passthrough *does*
  disambiguate, because the PINs differ — so the **first** login works. But it persists only
  the **phone** under `advisorBoardPhone`, and every **return** visit reads that phone alone →
  two rows → `null`. Works once, then silently stops.

**`expectedRole` does not save this.** It is applied only inside the fresh-`?u/p` branch, never
to the persisted-phone branch nor to the final `employees` lookup above — and only
`owner-board.html` passes it at all (the advisor, gm and bookkeeping boards do not).

### 7.3 What this cost us, concretely
**The `CHAT_IDENTITY` fix (`3278d68` + `dbc9f9a`) shipped straight to prod, untested on
staging, because staging could not reach the screen the bug was on.** The four
`window.CHAT_IDENTITY` sites all live behind the customer record, which needs an identity to
render. The same gap then blocked browser-verifying the lightbox fix (`88be4ff` + `dc39a76`),
which also shipped to prod on reasoning alone.

That is the real cost: **"test on staging first" is currently unenforceable for every
identity-dependent feature**, and nothing announces that — it presents as a board that loads
fine and shows nothing. Note the shape is identical to the storage-bucket failure in §4a: a
manual setup step that nothing verifies is a step that silently did not happen.

Also note `#view-customer` and the RO photo grid exist **only in `advisor-board.html`**, so
Step 4b's default of linking the `owner` row lands you on `owner-board.html`, which has no
customer record. Link the **advisor** row to test that screen.

### 7.4 What would fix it
1. **Run Step 4b** (create one `auth.users` row, link it to the advisor `employees` row). This
   alone restores the auth branch and unblocks staging. Nothing else on this list is required.
2. **De-duplicate the phones** in the sandbox, and decide what prod should do — see below.
3. **Make the ambiguity loud rather than silent** (code change, not yet made): `maybeSingle()`
   swallowing a multi-row match into `null` is what turns a data problem into an invisible one.

> **⚠ This is not staging-only.** The same duplicate rows are reported on prod, and the same
> `resolvePhone` code runs there. Any prod user whose board still holds a persisted
> `advisorBoardPhone`/`gmBoardPhone`/etc. from before the email door shipped would hit the same
> ambiguous lookup and silently lose their identity — including the `CHAT_IDENTITY.name`
> attribution the 2026-08-20 fix was about. Not investigated on prod yet. See
> [[office-auth]] §1c.

## 8. Which database am I on? — `public.app_env` (the ONLY guard)

```sql
select env from public.app_env;
```

`PROD — KiKi hygemiszxwmyrkmhbjub` = production. The sandbox row names the sandbox. One row,
one column, no interpretation:

```sql
create table if not exists public.app_env (env text primary key);
insert into public.app_env (env) values ('PROD — KiKi hygemiszxwmyrkmhbjub')
on conflict do nothing;
```

Run it before any hand-run SQL that writes. `select env from public.app_env;` costs nothing and
is the difference between a test write and a prod write.

### 8.1 Why the old guard was retired — a stale guard and a correct guard look identical

**The previous guard was "count the calls carrying `auto_attach_run_id
33333333-4444-4555-8666-777777777777` — prod returns 11, sandbox returns 0." Do not use it.
It now returns 10 on prod**, because filing Kevin Cruz's call 227 to RO #6032 on 2026-08-21
cleared that call's `auto_attach_run_id` — which is exactly what `clearAutoFileTagsPatch()` is
*supposed* to do when a human overrides the robot (§ [[call-auto-attach]], `customer-record.md`).

Nothing broke. Ordinary work moved the number, and it will keep moving every time someone
re-files a backfilled call.

That is the whole problem: **the guard's expected value was a side effect of ordinary work, so
a correct answer and a stale answer were indistinguishable.** When a guard drifts, people learn
that "wrong" means "out of date again" — and then it cannot do the one job a guard has, which
is to be believed the day it really is telling you you are on the wrong database.

**Same lesson as the `CHAT_IDENTITY` bug** ([[office-auth]] §1b): *a check that cannot fail
loudly is not a check.* There it was a guard whose first operand was always `undefined`, so it
silently short-circuited to `null`; here it is a guard whose expected value silently moves. In
both cases the mechanism looked healthy while telling you nothing. `app_env` is an explicit,
inert stamp — nothing in the application writes it, so no feature work can ever move it.

**When you add a new environment, add its `app_env` row in the same session you create it.** An
environment with no stamp is worse than no guard at all, because `select env from
public.app_env;` returning zero rows reads like a broken query rather than an unlabelled DB.

## Where it lives in the code
- **Client switch:** `shared/supabase-config.js` (+ `shared/supabase-config.test.js`). Loaded
  by every board via `<script src>`; boards read `window.cdSupabaseCreds()`.
- **API switch:** every `api/*.js` — `SUPABASE_URL = process.env.SUPABASE_URL || '<prod>'`
  (and `SUPABASE_ANON_KEY` in `api/send-push.js`); `SUPABASE_SERVICE_ROLE_KEY` already from
  env.
- **Schema source:** prod's `public` schema via `pg_dump --schema-only -n public` (the
  `/migrations` history is incremental and assumes base tables `employees`/`chat_messages`
  that it never creates, so it can't build from empty). **Staging RLS + storage tail:**
  `staging/staging-rls-and-storage.sql`.
- **Vercel env scoping + domain→branch binding:** see [[hosting-domains]] §3.5 and §5.
- **Employee ↔ auth mapping:** see [[office-auth]].

## Session change log
- 2026-08-21 — **§8 added: `app_env` replaces the run-id count as the environment guard.** The
  old guard (calls carrying `auto_attach_run_id 3333…`; "prod 11, sandbox 0") now returns 10 on
  prod because a human re-filed one of those calls, which correctly clears the tag. Its expected
  value was a side effect of ordinary work, so stale and correct looked identical. Replaced with
  an inert one-row stamp no feature writes. Also: `is_test` + `employees_visible` applied to both
  projects (base_cols 14 = view_cols 14, anon grant t|t, security_invoker=true, live anon read
  10 of 15), and the five ZZ Test accounts inserted — which restored staging as a testable
  environment WITHOUT the Step 4b auth user, since the ZZ phones are unique and collision-free.
  §7's blocker is worked around, not yet fixed.
- 2026-08-21 — **§7 added: staging can't verify any office-identity path.** Found while
  planning bucket management: `test.*` has zero `auth.users` rows (Step 4b never run) AND a
  duplicate-phone collision that makes the phone fallback ambiguous, so `resolve()` returns
  `null` by both branches and every identity-dependent screen is unreachable. Documented why
  the CHAT_IDENTITY and lightbox fixes both shipped to prod unverified. Also corrected Step
  4b, which told you to sign in at `office-login.html` — that page is password-reset only and
  never routes to a board; the door is `crisdata.html`. Added the advisor-vs-owner note (the
  customer record is advisor-board only). No code changed.
- 2026-08-12 — Created. Built the runtime creds switch (`shared/supabase-config.js`, hostname
  rule, unit-tested), moved every `/api/*` Supabase URL/anon/service key to env-with-prod-
  fallback. Wrote this runbook.
- 2026-08-12 — **Swapped all 12 boards** to `window.cdSupabaseCreds()`; verified in-browser
  (localhost → staging, prod host → production). Filled the staging project's URL + anon key
  into `shared/supabase-config.js`.
- 2026-08-12 — **Schema step revised.** The assembled `staging/staging-schema.sql` failed on
  an empty DB (`relation "public.customers" does not exist`): (a) my preamble ordered the
  `customers` column re-adds before `customers` is created, (b) intra-day alphabetical file
  ordering put `phase3_print_fields`/`chat_conversations`/`planning_items`/
  `costlayer_parts_library` before the migrations that create the tables they touch, and —
  the real blocker — (c) `employees` + `chat_messages` are referenced by the migrations but
  created by none (they predate the checked-in history). Deleted the assembled file; schema
  now comes from `pg_dump --schema-only -n public` (complete + correctly ordered), with
  `staging/staging-rls-and-storage.sql` as the both-roles-RLS + storage-policy tail.
- 2026-08-12 — **Schema restore procedure hardened (Step 2).** A bare `--schema-only` restore
  hit three Supabase gotchas: pgvector (prod is shared with KiKi → `type public.vector does
  not exist`; `--schema-only` doesn't create extensions), the dump's `CREATE SCHEMA public;`
  colliding with the fresh project, and `--no-privileges` stripping the `anon`/`authenticated`
  GRANTs. Step 2 now: detects prod's extensions from `pg_extension` and enables them, resets
  `public` cleanly (drop+create → idempotent), sets default privileges + grants for the API
  roles, strips the dump's `CREATE SCHEMA public`, then applies the schema.
