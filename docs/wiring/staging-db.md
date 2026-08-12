# How the staging database is wired

> Doc: `/docs/wiring/staging-db.md`
> Last updated: 2026-08-12 — created for the staging-DB isolation build (branch
> `feat/staging-db-isolation`). Console steps NOT yet run — this is the runbook +
> the code side that's already wired.
> Status: 🟡 in progress — code side built & unit-tested (`shared/supabase-config.js`,
> the `/api/*` env-with-fallback change, `staging/staging-schema.sql`); the Supabase
> project + data snapshot + Vercel env are owner steps below, then the board swap.

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

### Step 2 — Recreate the schema *(Cris, staging SQL editor)*
1. Open **`staging/staging-schema.sql`** from the repo. It's the **entire** `/migrations`
   history assembled in order — every table, index, function, trigger, and RLS policy —
   with data inserts removed (data comes in Step 3) and **both `anon` and `authenticated`
   full-access policies guaranteed on every table**.
2. Paste it into the staging project's **SQL editor** and **Run**. It's wrapped in one
   transaction: if anything fails it rolls back cleanly — fix the cause (usually **enable a
   Postgres extension**: Database → Extensions, e.g. `pgcrypto` is created by the script but
   any other referenced extension must be on) and re-run the whole file.
3. Sanity check (SQL editor): `select count(*) from pg_tables where schemaname='public';`
   should be ~40, and every table should have anon + authenticated policies:
   `select tablename, count(*) filter (where 'anon'=any(roles)) anon,
    count(*) filter (where 'authenticated'=any(roles)) auth
    from pg_policies where schemaname='public' group by 1 order by 1;`

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

### Step 4a — Create the Storage buckets *(Cris, staging → Storage)*
The bucket **policies** are already created by Step 2; create the **buckets** themselves
(empty is fine). Mirror prod's bucket list + public/private flags (prod's are private):
`crisdata-attachments`, `attachments`, `employee-photos`, `board-backgrounds`,
`call-recordings`, `invoice-images`, `marketing-content`.
(The recordings cron runs only on the Production deployment, so `call-recordings` stays
empty on staging unless you upload a test file.)

### Step 4b — Create a staging test login *(Cris, staging → Authentication)*
`auth.users` isn't copied, so make a fresh login: **Authentication → Users → Add user**
(email + password, "auto-confirm"). Then, because the boards map a session to an employee
via `employees.auth_user_id` (see [[office-auth]]), point one employee row at the new user
in the **staging** SQL editor:
```sql
update public.employees set auth_user_id = '<new-staging-user-uuid>'
where lower(email) = lower('<that-email>');
```

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
1. On `test.leetransmissionshop.com`, open DevTools console: `window.CD_SUPABASE` → `env:
   "staging"`, url = the new ref. On `board.leetransmissionshop.com`: `env: "production"`.
2. Make a **harmless write on `test.*`** (e.g. add a To-Do) → it appears in the **staging**
   project's table and **not** in prod. Do the reverse on prod → not in staging.
3. Confirm a prod row count is unchanged before/after staging write-testing.

## 4. Tear down / refresh the staging DB later
- **Refresh data** (re-snapshot prod): truncate staging public tables (or re-run Step 2 on a
  fresh project), then re-run Step 3.
- **Throw it away:** delete the staging Supabase project (Settings → General → Delete). Zero
  effect on prod. Remove the Preview-scoped Vercel env vars if you want previews back on prod
  (not recommended — previews-on-staging is safer).
- The **code switch stays** either way; with no staging project, `test.*`/previews simply
  fail to reach a DB (loud, not a silent prod fall-through) until a new project's creds are
  pasted into `shared/supabase-config.js`.

## Known gaps & open questions (as of 2026-08-12)
- **Auth users aren't copied** (Step 4b creates a fresh staging login). If more staff logins
  are needed on staging, repeat 4b per user.
- **`pg_dump --data-only` fidelity:** if a table has an unusual FK cycle the
  `session_replication_role = replica` wrap handles it; if a specific table errors, load it
  last or `--exclude-table-data` it and copy by hand.
- **Storage objects aren't copied** — buckets start empty. Fine for testing uploads; if you
  need real recording/photo bytes on staging, copy them separately.
- **Crons** (`/api/fetch-recordings`) run only on the Production deployment, so CTM audio
  won't auto-flow into staging.

## Where it lives in the code
- **Client switch:** `shared/supabase-config.js` (+ `shared/supabase-config.test.js`). Loaded
  by every board via `<script src>`; boards read `window.cdSupabaseCreds()`.
- **API switch:** every `api/*.js` — `SUPABASE_URL = process.env.SUPABASE_URL || '<prod>'`
  (and `SUPABASE_ANON_KEY` in `api/send-push.js`); `SUPABASE_SERVICE_ROLE_KEY` already from
  env.
- **Assembled schema:** `staging/staging-schema.sql` (generated from `/migrations`; regenerate
  with the script recorded in this build's commit if migrations change).
- **Vercel env scoping + domain→branch binding:** see [[hosting-domains]] §3.5 and §5.
- **Employee ↔ auth mapping:** see [[office-auth]].

## Session change log
- 2026-08-12 — Created. Built the runtime creds switch (`shared/supabase-config.js`, hostname
  rule, unit-tested), moved every `/api/*` Supabase URL/anon/service key to env-with-prod-
  fallback, and generated `staging/staging-schema.sql` (full schema + RLS, data-free, both
  anon+authenticated policies). Wrote this runbook. Console steps (create project, run schema,
  snapshot data, buckets, login, Vercel env) + the 12-board swap are pending owner action /
  the staging creds.
