# How office login could adopt Supabase Auth (investigation + lockout-safe plan)

> Doc: `/docs/wiring/office-auth.md`
> Last updated: 2026-08-01 — verified vs commit `6cb6be9`
> Status: 🟢 STEP 1½ SHIPPED (anon→authenticated read+write widen applied & live-verified at the
> DB layer, 2026-08-01 — see §7 / §7.8). Step 0–1 login foothold live @ `dc782b3` — **nothing
> enforced**; owner (Cristian) linked via `auth_user_id` and signing in on `office-login.html`.
> §5 Steps 2–5 still proposed; **Step 2 build in progress — the `shared/office-identity.js` dual
> reader is wired into OWNER (§8.6a), plus MANAGER + BOOKKEEPING (§8.6b); ADVISOR is HELD behind
> in-flight book-hours work.** §1 (CrisData today) and §2 (KiKi's auth) are verified against
> the live code (`crisdata.html`, the four boards, `api/*`, the embedded `kiki/` repo). Extends
> [[settings]] §6 — which left two identity paths (an HMAC token OR "a Supabase Auth session if
> we adopt GoTrue later"); this adopts the **Supabase Auth** path using KiKi's proven implementation.

## 0. In one line
Give the **four office users** (Cristian / Kevin / Josh / Bookkeeping) a real,
server-verifiable login (Supabase Auth) so owner-only settings can finally be enforced —
**added alongside** today's phone+PIN, migrated **one person at a time**, with enforcement
flipped **last**, so a Friday rollout can't lock anyone out. **Techs on the floor keep PIN.**

---

# PART A — How it works today (verified)

## 1. CrisData identity today — a UX hint, not a boundary ([[settings]] §3)
- **Login = `crisdata.html`.** Phone + 4-digit PIN are checked **client-side with the anon key**:
  `db.from('employees').select('name, phone, pin, role').eq('phone', …).eq('pin', …)`
  (`crisdata.html:149-151`), then it redirects to the role's board (`ROLE_DEST`, `:93`) carrying
  **`?u=phone&p=pin`** in the URL (`:170-172`).
- **Per-board session resolution** (identity known client-side once resolved):
  - **advisor / gm / owner** — a passive `captureSessionAndGreet()` (advisor `:2888`, gm `:4375`,
    owner `:938`): reads `?u/p` or a persisted phone, looks up `employees` **by phone (anon key)**,
    sets `CHAT_IDENTITY = { name, role }` + `CURRENT_EMPLOYEE_ID`. It **never blocks** load.
  - **bookkeeping** — a hard `gateAndBoot()` (`:3352`): same lookup, but **redirects to
    `crisdata.html`** if unresolved or `role !== 'bookkeeping'` (`:3382-3394`). The one real gate.
  - **tech** — `my-numbers.html` uses the same phone session (techs stay here — see §4).
- **What's persisted:** only the **phone** (`advisorBoardPhone` / `gmBoardPhone` / `ownerBoardPhone`
  / `bookkeepingBoardPhone` in `localStorage`). **No PIN, no token, no Supabase Auth session.** The
  PIN only ever transits the `?u/p` URL. `db.auth.signOut()` is already called on logout (advisor
  `:2954`, gm `:4443`, bookkeeping `:3327`) — **defensive only; nothing ever signs in.**
- **The security crux:** `employees` is **anon-readable AND anon-updatable** (`20260721_employee_avatar.sql:17`
  — "anon-updatable"; the login proves anon SELECT of `pin`). So the public publishable key
  (`sb_publishable_…`, embedded in every page) can **read every phone/PIN/role and edit employee
  rows.** Client `role` is a display hint; nothing stops opening another board's URL or calling the
  DB directly. This is what auth would fix.
- **Server-role already exists.** Every `/api/*` function uses `SUPABASE_SERVICE_ROLE_KEY`
  (announcement, desk-appointment, change-request, ctm-webhook, recording-*, fetch/backfill). But
  **none verify WHO calls** — protected by "anon can't write the table," not by identity
  ([[settings]] §8). No `@supabase/ssr`, no `signInWithPassword`, no roles-in-JWT anywhere in CrisData.
- **CrisData is static HTML + `@supabase/supabase-js` (UMD)** on Vercel — **not** Next.js. No
  middleware, no server components. (Matters for §4: KiKi's SSR/cookie/middleware pattern does not
  port directly.)

### 1a. Every place that needs to know "who is logged in"
Login/redirect (`crisdata.html`); each board's `captureSessionAndGreet` / `gateAndBoot`; and the
consumers of `CHAT_IDENTITY` / `CURRENT_EMPLOYEE_ID`: **BoardSettings** money-gate (hardcoded per
board today), **To-Do** (`created_by`/`assigned_to`), **Team Chat** (sender), **Announcements**
(`posted_by_name`) + the **Requests/Feedback** intake (`submitted_by_*`), **Marketing** (`captured_by`),
**calls/recordings/comeback** (`noted_by_name`), **Roadmap** (`owner_employee_id`), **Planner**
(`owner_employee_id`), and the **bookkeeping role gate**. All read identity **client-side**; only the
bookkeeping gate and (future) owner-only settings are true boundaries.

## 2. How KiKi does Supabase Auth (verified against `kiki/`)
KiKi is Next.js 16 (App Router). **Email/password only — no phone/SMS/OTP anywhere.**
- **Clients** (`kiki/src/lib/supabase/`): user-facing clients use **`@supabase/ssr`** — a
  `createBrowserClient` (`client.ts`) and a cookie-bound `createServerClient` (`server.ts`), both
  with `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`. A **separate service-role admin
  client** (`admin-client.ts`) uses plain `@supabase/supabase-js` + `SUPABASE_SERVICE_ROLE_KEY`
  (`autoRefreshToken:false, persistSession:false`) — **server-only**, for user management.
- **Session refresh / route protection = middleware** at `kiki/src/proxy.ts` (Next 16 renamed
  `middleware`→`proxy`): calls `supabase.auth.getUser()` to refresh cookies, redirects unauth users
  to `/login`, and authed users away from `/login`. Matcher excludes `_next` + `/api`.
- **Login** (`src/app/login/page.tsx`): `supabase.auth.signInWithPassword({ email, password })` →
  `/dashboard`. The page also catches invite/recovery **hash tokens** landing on `/login#access_token=…`,
  `setSession(...)`, then routes to `/auth/set-password`.
- **Invite / create user** (`src/app/admin/users/actions.ts`, `'use server'`, admin-gated): the
  **service-role** admin client calls `auth.admin.generateLink({ type:'invite', email, options:{ redirectTo:'…/auth/set-password', data:{ full_name } } })`; **if the email already exists it falls
  back to `type:'recovery'`**. The `action_link` is emailed via the **Resend HTTP API** (NOT Supabase's
  built-in SMTP). `removeUser` → `auth.admin.deleteUser`; the list page uses `auth.admin.listUsers`.
- **Set password** (`src/app/auth/set-password/page.tsx`): waits for the session (`onAuthStateChange`/
  `getSession`), then `supabase.auth.updateUser({ password })` → `/dashboard`. Endpoint of both invite
  and recovery.
- **Roles = email-vs-env-var, NO roles table** (`src/lib/roles.ts`): `isAdminEmail` (`=== ADMIN_EMAIL`)
  and `isStaffEmail` (membership in `STAFF_EMAILS`). Checked **server-side per page** (`if (user.email
  !== process.env.ADMIN_EMAIL) redirect('/dashboard')`, repeated on every admin route). Name lives in
  `user_metadata.full_name`.
- **RLS is deliberately coarse:** most tables are `TO authenticated USING (true) WITH CHECK (true)`
  ("admin check is done in app"); real row-scoping only where it matters via `user_id = auth.uid()`
  (`favorites`, `order_lists`, `user_sessions`); a couple of ingestion tables reserve writes `TO
  service_role`; a public "shop board" table re-opens SELECT `TO anon`. FKs go straight to
  `auth.users(id)` — **no `profiles` table.**
- **Sign-out**: `supabase.auth.signOut()` then redirect to `/login`.
- **⚠ Anti-patterns NOT to copy:** KiKi commits **plaintext Supabase secrets** into the repo
  (`KIKI_MEMORY.md`, and a hardcoded service-role literal in `kiki/scripts/*.js`). Those keys need
  rotating; never replicate committed secrets or a browser-exposed service-role key.

---

# PART B — PROPOSED (approve before any build)

## 3. Map KiKi's pattern onto CrisData's OFFICE login
Reuse the **auth mechanics** (invite → set-password → password login → signOut), **adapt** the
delivery and role model to CrisData's stack and existing data.

| Piece | KiKi | CrisData office login |
|---|---|---|
| Client library | `@supabase/ssr` (cookies) + middleware | **Adapt:** plain `@supabase/supabase-js` browser client with `persistSession:true` + `detectSessionInUrl:true` (session in `localStorage`; no middleware — each static board checks `db.auth.getSession()` / `onAuthStateChange`). Simpler than KiKi. |
| Login call | `signInWithPassword` | **Reuse as-is.** |
| Invite a user | admin `generateLink({invite})` → Resend | **Adapt:** for **4 users**, use the **Supabase dashboard "Invite user"** (built-in email) — no endpoint, no Resend. (Optionally, later, a tiny service-role `api/invite.js` mirroring an existing `/api/*`.) |
| Set-password landing | `/auth/set-password` page | **Reuse (as a static page):** a small `office-set-password.html` that lets the auto-detected session `updateUser({ password })`. Add its URL to Supabase's redirect allowlist. |
| Role after login | `email === ADMIN_EMAIL` env check, no table | **Adapt / improve:** CrisData already has `employees.role`. **Link `auth.users` → `employees`** (a nullable `employees.auth_user_id`, or match on a new `employees.email`) and read role from the DB — which enables **real RLS** via `auth.uid()`→employees (KiKi can't do owner-only in the DB). |
| Server-side enforcement | app-code email checks; coarse RLS | **Adapt:** route owner-only **writes** through a service-role endpoint that **verifies the caller's JWT** + re-checks role from `employees` ([[settings]] §8), and add `auth.uid()`→role RLS on owner-only tables. |
| Sign-out | `signOut()` → `/login` | **Reuse:** the boards **already call `db.auth.signOut()`** on logout — it just becomes real. |
| Techs | (n/a) | **Keep PIN.** Techs (`my-numbers.html`) stay on phone+PIN entirely; only the 4 office users get auth. The identity reader supports **both** (§5, Step 2). |

## 4. Phone/SMS OTP vs. email invite — recommendation
**Recommend: email invite + password** (KiKi's proven pattern), with phone OTP a defensible
alternative if passwordless UX for non-technical staff is the priority.

| | Email invite + password | Phone SMS OTP |
|---|---|---|
| Supabase setup | Built-in; **dashboard "Invite user"** covers 4 users. Custom SMTP only needed at volume (not here). | Must configure an **SMS provider** (Twilio / Twilio Verify / MessageBird / Vonage) in Auth settings **and fund it**. |
| Ongoing cost | **$0.** | ~**sub-cent per SMS** + ~$1–2/mo number (trivial for 4 users, but a real paid account to keep funded). |
| External dependency | One-time invite email; **none after** (password logins, persistent session). | **Every login sends an SMS** — depends on Twilio uptime + carrier deliverability (can lag/filter). |
| Lockout-safety | Self-serve password reset; minimal login events. **Safer.** | A lapsed/misconfigured SMS account = no login on a busy Friday. |
| Fit to shop | Users need an email + to set a password once (mild friction for non-technical staff). | **Passwordless**, phone-native, aligns with the `employees.phone` key — friendliest for non-technical staff. |
| Reuse | **Copy-adapt KiKi's working flow.** | New ground; nothing built. |

**Why email wins here:** the goal is a *server-verifiable identity* for owner-only settings, and
KiKi already has a working email-invite implementation to copy — zero new external service, zero
per-login cost, and the fewest ways to fail on a live shop day. Phone OTP's real appeal (no
passwords, phone-native) is nice for 4 non-technical users, but it adds a funded Twilio dependency
and an SMS on every login for marginal benefit. **Not mutually exclusive** — Supabase can add phone
later, and identity still links to the `employees.phone` key either way. If Cris strongly prefers
passwordless, phone OTP is acceptable **provided** the Twilio account is set up and funded before
any migration and PIN stays as the fallback throughout.

## 5. The lockout-safe, one-by-one rollout
**Cardinal rule:** today nothing is enforced (role is a hint), so **auth changes nothing until we
choose to enforce.** Keep phone+PIN fully working the entire time; flip enforcement **last**; and the
**`employees` RLS flip is the very last step of all** (login *and* every board read `employees` with
the anon key — tighten it only after login + all boards resolve identity from the auth session).

- **Step 0 — Groundwork (invisible, reversible). ✅ BUILT (migration hand-run pending).**
  `migrations/20260731_employees_auth_user_id.sql` adds a nullable `employees.auth_user_id uuid`
  + a partial unique index. **No FK, no RLS change** — `employees` keeps its exact current posture;
  nothing reads the column yet. *Rollback:* the drop SQL in the migration's footer.
- **Step 1 — Auth + ONE test account (Cristian). ✅ BUILT (page) — dashboard steps are Cris's.**
  `office-login.html` — a **standalone** page using plain `@supabase/supabase-js`
  (`persistSession` / `autoRefreshToken` / `detectSessionInUrl`) and CrisData's **own publishable
  key** (no service-role): `signInWithPassword`, a role display (resolves the employee by
  `auth_user_id`, reads **`name, role` only** — never `pin`), set/change password
  (`updateUser({password})`), and `signOut`. It **folds set-password into the same page** (refining
  §3's separate `office-set-password.html`) so **Path A needs no Site-URL/redirect change at all**.
  It is a **dead-end**: no redirect to a board; boards and `crisdata.html` untouched; phone/PIN
  unchanged. **Path A (recommended):** dashboard → Users → *Add user → Create new user* (email +
  temp password, **Auto Confirm**) → copy the UID → `update employees set auth_user_id='<uid>' …`
  (SQL in the migration footer) → Cristian signs in on `office-login.html`, sets his real password,
  reloads (session persists), signs out/in. **Path B** (preview the invite email) needs the
  redirect allowlist + Site URL — do it off-hours, only before Step 3. *Rollback:* delete the auth
  user, null the link, delete the page. **← FIRST SAFE STOPPING POINT** (working auth foothold,
  zero enforcement).
- **Step 1½ — widen anon-only reads + writes (✅ SHIPPED 2026-08-01).** Applied via
  `migrations/20260801_office_auth_widen_step1_5.sql` and live-verified at the DB layer: an
  office-login (`authenticated`) session now reads and writes every board object exactly like the
  anon/PIN session. **Full audit, applied object list, reconciliations, and live-verify findings
  in §7 / §7.8.** The interim "sign out before using a board" rule is **retired** for the
  read/write layer — but per-viewer features (chat, to-do, "who's viewing") still need the Step 2
  dual-identity reader (§8) when a board is opened directly under an auth session.
- **Step 2 — Dual-identity reader (additive).** A shared `office-identity.js` that resolves the
  user by an **auth session if present, else the phone session** (today's path). Wire the **owner
  board first** (only Cristian is on auth). Boards become auth-*aware* without dropping phone/PIN.
  *Rollback:* helper falls back to phone; remove the auth branch. **← comfortable stopping point.**
- **Step 3 — Migrate people ONE BY ONE.** Invite Kevin (dashboard) → set his `auth_user_id` → he
  logs in → gm-board recognizes him via auth. **If anything is off, he still has phone/PIN.** Verify,
  then Josh, then Bookkeeping — one at a time, each a stopping point. *Rollback per person:* they
  revert to phone/PIN (untouched).
- **Step 4 — Build enforcement, DON'T enable.** Write (do not apply) the owner-only settings
  endpoint that **verifies the JWT** + re-checks `employees.role` ([[settings]] §8), and the
  `auth.uid()`→role RLS policies for owner-only tables. Nothing enforced. *Rollback:* don't apply.
- **Step 5 — Flip enforcement LAST, per-table, lowest-risk first (off-hours).**
  - **5a** New owner-only table (e.g. settings grants) born auth-RLS-protected — nothing depends on
    it, so no lockout risk. Verify owner writes / others can't.
  - **5b** Move settings **writes** behind the endpoint; flip **that table's** RLS to auth-only.
    Verify owner money-edit works via auth, advisor can't. *Rollback:* re-open the table to anon
    (settings keep working as today).
  - **5c** (**very last, off-hours**) Tighten **`employees`**: first move the **login** off the
    anon PIN read (an auth login endpoint or the auth session) **and** every board's identity
    resolution onto the auth session; **only then** drop anon SELECT of `pin` + anon UPDATE. This
    closes the "anyone can read all PINs" hole. *Rollback:* re-add the anon SELECT policy.
    **→ Full investigation + proposal (findings, SQL, PART 0, tests, rollback) in §9.** Key results:
    the only safe-now step is locking `auth_user_id` writes (§9.5a); the real close needs the
    `api/login` + `api/staff` endpoints first; a naive owner-only flip breaks manager staff-mgmt +
    PIN login + self-service and is anon-key-bypassable.
- **Never mid-day:** any `employees`/operational-table RLS tightening; toggling "confirm email";
  changing the Site URL / redirect allowlist (breaks in-flight sessions). Do §5 off-hours, team notified.

## 6. What this touches · migrations · risks
- **Touched by Step 0–1 (built):** new — `office-login.html`,
  `migrations/20260731_employees_auth_user_id.sql`; edits — `shared/file-cabinet.js` (DOCS row),
  this doc. **Boards, `crisdata.html`, and all RLS untouched.**
- **Still to come (Steps 2–5, not built):** `shared/office-identity.js` (dual reader), later
  `api/settings.js` (+ maybe `api/invite.js`); edits to the four boards + eventually `crisdata.html`;
  RLS on owner-only tables + finally `employees`.
- **Migrations (additive, hand-run):** `employees.auth_user_id` (Step 0 — **written, run by hand**);
  later the owner-only RLS policies + the `employees` tightening (Step 5).
- **Risks / open questions:** (a) the `employees` RLS flip is the single highest-risk action — it
  underpins login and every board; sequence it dead last with a tested rollback. (b) The `?u=phone&p=pin`
  URL passthrough should be retired once auth lands (PIN-in-URL is weak). (c) Redirect-allowlist +
  Site-URL settings must include the set-password page before inviting. (d) Techs stay on PIN — the
  dual reader is permanent, not transitional, for the floor. (e) Rotate any keys that were ever
  committed (KiKi's lesson) — do not browser-expose the service-role key.

## 7. Step 1½ — anon→authenticated read+write widen (✅ SHIPPED 2026-08-01)
**Applied and live-verified at the DB layer.** The authoritative applied SQL is
`migrations/20260801_office_auth_widen_step1_5.sql`. §7.2–7.7 below are the **parked audit draft**,
kept for history — a re-audit before apply caught objects §7.2 missed, and the live 0a/0b verify
trimmed a few over-widens. **See §7.8 for the final applied object list, the reconciliations, and
the live-verify findings.**

### 7.0 Why it exists, and why we widen reads AND writes together
The schema was built **anon-only, no auth**. A browser that logs into `office-login.html` carries
an `authenticated` Supabase session in `localStorage`, **shared across every board tab on the
origin** — so those clients stop being `anon`. Every object whose policy grants only `anon` then
returns **zero rows / permission-denied** to `authenticated`. Confirmed live: after an office-login,
`change_requests` vanished from the owner triage + "My requests" until sign-out.
- A **reads-only** widen is a **silent-write trap**: a logged-in browser would *see* everything but
  its **direct writes fail quietly** (add a to-do, send a chat, save a setting, edit an RO…). So the
  resume does **reads AND writes together** — either widen both to `authenticated`, **or** move the
  affected writes behind auth-checked endpoints (the enforcement-aligned option; decide at resume).
- **Service-role writes are unaffected** (they run server-side): announcements, change-request
  submit/triage, and desk appointments keep working regardless of the browser's role.

### 7.1 Interim rule (until Step 1½ is applied)
- **Sign out of `office-login.html` before using a board.** The boards' logout already clears the
  session; simplest is to just not stay signed in. Only **Cristian** has an account and office-login
  is a **dead-end** page, so this is easy to avoid today. Boards run normally on **phone+PIN**
  (no auth session → `anon` → everything reads/writes as always).
- **Current state:** Step 1 foothold live (`dc782b3`); nothing enforced; phone+PIN untouched.

### 7.2 The audit (board-read objects by read role)
- **Anon-only reads — tables (28) that BREAK for `authenticated`:** `repair_orders`, `calls`,
  `change_requests`, `announcements`, `todos`, `invoice_queue`, `core_charges`, `customers`,
  `vehicles`, `ro_line_items`, `attachments`, `completed_jobs`, `chat_conversations`, `chat_members`,
  `chat_reads`, `ro_payments`, `ro_diagnostic_codes`, `rebuild_book_hours`, `projects`,
  `planning_items`, `parts_orders`, `marketing_content`, `invoice_types`, `expense_categories`,
  `invoice_po_lines`, `payment_methods`, `shop_settings`, `dashboard_preferences`.
- **Anon-only — a view + 3 private storage buckets (BREAK):** `feature_adoption` (VIEW, `grant
  select … to anon` only) · `crisdata-attachments`, `invoice-images`, `marketing-content`
  (`for select to anon` on `storage.objects`; `createSignedUrl` fails for `authenticated`).
- **VERIFY LIVE — no policy in any migration (created ad-hoc in the console):** `employees` (read by
  all 11 surfaces — highest risk), `chat_messages`, `tech_whiteboard`, `shopboard_tables`,
  `transmissions`, `punches`, and the `employee-photos` bucket. The additive widen is safe for these
  regardless of their live state; the verification query (§7.3) shows their real roles.
- **Already fine (skip):** `shopboard_parking` / `shopboard_lifts` / `shopboard_pickup` (policy has
  no `TO` clause → `public`, includes `authenticated`); `board-backgrounds` + `employee-photos`
  (public buckets via `getPublicUrl`).
- **Direct-anon-WRITE tables (writes ALSO break for `authenticated` — the reason we widen writes
  too):** `todos`, all `chat_*`, `marketing_content`, `shop_settings`, `dashboard_preferences`,
  `projects`, `planning_items`, `parts_orders`, `core_charges`, `customers`, `vehicles`,
  `ro_line_items`, `attachments`, `completed_jobs`, `ro_payments`, `ro_diagnostic_codes`,
  `rebuild_book_hours`, `invoice_queue`, `invoice_types`, `expense_categories`, `invoice_po_lines`,
  `payment_methods` (all `for all to anon`), plus `repair_orders` (anon insert/update) and `calls`
  (anon update). *Not* direct-anon-write (service-role): `change_requests`, `announcements`.
- Note: also fixes a Step-1 gotcha — office-login's own role display reads `employees`, so it returns
  null ("not linked") for a *real* logged-in session until `employees` is widened.

### 7.3 Verification SQL (run FIRST at resume — confirms the audit + the 7 unknowns, live)
```sql
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where (schemaname='public' and tablename in (
        'employees','repair_orders','calls','change_requests','announcements','todos',
        'invoice_queue','core_charges','customers','vehicles','ro_line_items','attachments',
        'completed_jobs','chat_conversations','chat_messages','chat_members','chat_reads',
        'ro_payments','ro_diagnostic_codes','rebuild_book_hours','projects','planning_items',
        'parts_orders','marketing_content','invoice_types','expense_categories','invoice_po_lines',
        'payment_methods','shop_settings','dashboard_preferences','tech_whiteboard',
        'shopboard_tables','transmissions','punches','customer_phones',
        'shopboard_parking','shopboard_lifts','shopboard_pickup'))
    or (schemaname='storage' and tablename='objects')
 order by schemaname, tablename, cmd, policyname;
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name='feature_adoption';
select id, public from storage.buckets order by id;
```

### 7.4 READS widen SQL (ready — additive `for select to authenticated`; touches no write policy)
```sql
-- Additive + READ-ONLY: adds `for select to authenticated` alongside the anon policies.
-- Does NOT edit anon policies and does NOT touch any write/`for all` grant. Idempotent.
do $$
declare t text;
begin
  foreach t in array array[
    'employees','repair_orders','calls','change_requests','announcements','todos',
    'invoice_queue','core_charges','customers','vehicles','ro_line_items','attachments',
    'completed_jobs','chat_conversations','chat_messages','chat_members','chat_reads',
    'ro_payments','ro_diagnostic_codes','rebuild_book_hours','projects','planning_items',
    'parts_orders','marketing_content','invoice_types','expense_categories','invoice_po_lines',
    'payment_methods','shop_settings','dashboard_preferences','tech_whiteboard',
    'shopboard_tables','transmissions','punches','customer_phones'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth read '||t, t);
      execute format('create policy %I on public.%I for select to authenticated using (true)', 'auth read '||t, t);
    end if;
  end loop;
end $$;
do $$
declare b text;
begin
  foreach b in array array['crisdata-attachments','invoice-images','marketing-content'] loop
    execute format('drop policy if exists %I on storage.objects', 'Allow authenticated read '||b);
    execute format('create policy %I on storage.objects for select to authenticated using (bucket_id = %L)',
                   'Allow authenticated read '||b, b);
  end loop;
end $$;
grant select on public.feature_adoption to authenticated;
```

### 7.5 WRITES widen SQL (ready — the "widen together" option; the alternative is auth-checked endpoints)
At resume, run this **with** §7.4 (or instead move these writes behind endpoints). This gives
`authenticated` the *same* full access `anon` already has on the direct-anon-write tables (additive;
nothing tightened). `repair_orders` / `calls` get only the commands their anon policies grant.
```sql
-- Direct-anon-write tables → full access for authenticated (mirrors the existing `for all to anon`).
do $$
declare t text;
begin
  foreach t in array array[
    'todos','chat_conversations','chat_messages','chat_members','chat_reads','marketing_content',
    'shop_settings','dashboard_preferences','projects','planning_items','parts_orders','core_charges',
    'customers','vehicles','ro_line_items','attachments','completed_jobs','ro_payments',
    'ro_diagnostic_codes','rebuild_book_hours','invoice_queue','invoice_types','expense_categories',
    'invoice_po_lines','payment_methods','customer_phones'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth write '||t, t);
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', 'auth write '||t, t);
    end if;
  end loop;
end $$;
-- repair_orders: anon has insert + update (no delete). Mirror for authenticated.
drop policy if exists "auth insert repair_orders" on public.repair_orders;
create policy "auth insert repair_orders" on public.repair_orders for insert to authenticated with check (true);
drop policy if exists "auth update repair_orders" on public.repair_orders;
create policy "auth update repair_orders" on public.repair_orders for update to authenticated using (true) with check (true);
-- calls: anon has update only (rows arrive via CTM webhook / service role).
drop policy if exists "auth update calls" on public.calls;
create policy "auth update calls" on public.calls for update to authenticated using (true) with check (true);
-- NOTE: with 7.5's `for all to authenticated`, the matching `auth read <t>` from 7.4 is redundant
-- (for-all covers select) but harmless — leave both, or skip 7.4 for these tables at resume.
```

### 7.6 Rollback (removes only what §7.4/§7.5 add)
```sql
do $$
declare t text;
begin
  foreach t in array array[
    'employees','repair_orders','calls','change_requests','announcements','todos','invoice_queue',
    'core_charges','customers','vehicles','ro_line_items','attachments','completed_jobs',
    'chat_conversations','chat_messages','chat_members','chat_reads','ro_payments','ro_diagnostic_codes',
    'rebuild_book_hours','projects','planning_items','parts_orders','marketing_content','invoice_types',
    'expense_categories','invoice_po_lines','payment_methods','shop_settings','dashboard_preferences',
    'tech_whiteboard','shopboard_tables','transmissions','punches','customer_phones'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth read '||t, t);
      execute format('drop policy if exists %I on public.%I', 'auth write '||t, t);
    end if;
  end loop;
end $$;
drop policy if exists "auth insert repair_orders" on public.repair_orders;
drop policy if exists "auth update repair_orders" on public.repair_orders;
drop policy if exists "auth update calls" on public.calls;
do $$
declare b text;
begin
  foreach b in array array['crisdata-attachments','invoice-images','marketing-content'] loop
    execute format('drop policy if exists %I on storage.objects', 'Allow authenticated read '||b);
  end loop;
end $$;
revoke select on public.feature_adoption from authenticated;
```

### 7.7 Resume checklist (the calm window)
1. Run §7.3 verification; reconcile the 7 "VERIFY LIVE" objects with the audit.
2. Decide writes: run §7.5 **or** route those writes through auth-checked endpoints.
3. Apply §7.4 (+ §7.5 if chosen), off-hours.
4. Test **with an office-login session active**: every board reads AND writes normally
   (to-dos, chat, settings, RO edits, triage + My requests, signed-URL screenshots) — **and**
   phone+PIN with no session still works. Then retire the interim sign-out rule.

### 7.8 SHIPPED — final applied object list, reconciliations & live-verify (2026-08-01)
**Applied by hand in Supabase from `migrations/20260801_office_auth_widen_step1_5.sql`** — add-only:
no anon/public policy dropped or narrowed, no RLS enabled/forced, enforces nothing.

**Final applied set:**
- **Reads → authenticated (32 tables):** the §7.4 set **minus** `employees`, `chat_messages`,
  `core_charges`, `transmissions` (already `{public}` or carrying their own authenticated policy),
  **plus** `push_subscriptions`.
- **Writes → authenticated:** 27 `for all` tables (§7.5 set + re-audit gaps `push_subscriptions`,
  `tech_whiteboard`, `shopboard_tables`; minus `employees`, `chat_messages`, `core_charges`), plus
  `repair_orders` (insert+update), `calls` (update), and `punches` (**insert only** — anon is
  append-and-read for time-clock integrity).
- **Storage reads → authenticated:** `crisdata-attachments`, `invoice-images`, `marketing-content`.
- **Storage writes → authenticated** (mirroring anon's real 0b posture): `crisdata-attachments`
  insert · `marketing-content` insert+delete · `invoice-images` insert+update+delete ·
  `board-backgrounds` insert. (`employee-photos` bucket is `ALL {public}` → already open, skipped.)
- **`feature_adoption`** view → grant select to authenticated.

**Reconciliations vs the parked §7.2–7.5 draft (why they differ):**
- `employees` is live-scoped **`{public}`**, so `authenticated` already has full read+write — the
  migration touches it **zero**. ⚠ **Consequence:** the widen currently empowers only the OWNER
  (only Cristian has an auth account). The **§5c `employees` RLS lockdown MUST land BEFORE
  Kevin/Josh/Daiana get auth accounts in Step 3** — otherwise their auth sessions inherit `{public}`
  employees read/write. Tracked as a hard sequencing constraint on §8's plan.
- Storage: anon has **no delete** on `crisdata-attachments` and **no update** on `board-backgrounds`,
  so those two were dropped from the widen (mirror-not-exceed).
- `chat_messages` / `core_charges` / `transmissions` were already `{public}` / self-authenticated →
  dropped as redundant.

**Live-verify (task step 7 — signed in as `esallc1` / Owner, opening board URLs directly):**
- **Owner board — full data + writes. ✅** Confirms authenticated read+write is live.
- **Manager board — reads work** (announcement banner + nav load under `authenticated`), **but Team
  Chat stalls at "Loading…" and To-Do shows "Could not identify you on this board yet."**
  **Root cause = the viewer-identity layer, NOT an RLS trap.** `captureSessionAndGreet()`
  (`gm-board.html:4375`) resolves the viewer **only** by phone (URL `?u/p` passthrough or
  `localStorage['gmBoardPhone']`); a board opened directly under an auth session has neither, so
  `CURRENT_EMPLOYEE_ID` / `CHAT_IDENTITY` stay null. To-Do gates on `!CURRENT_EMPLOYEE_ID`
  (`gm-board.html:2472`); Team Chat renders `me.name ? '…' : 'Loading…'` (`team-chat.js:699`) and
  bails at `if (!me.name) return` (`:749`). The `chat_*` / `todos` policies are authenticated-widened
  (or `{public}`), so nothing is blocked at the DB. **This is the Step 2 dual-identity gap (§8), not
  a Step 1½ regression.**

---

## 8. Step 2 — dual-identity + single front door (8.6a SHIPPED 2026-08-01; rest proposed)
Folds two findings from the Step 1½ live-verify into one theme: **a signed-in office user should be
recognized on every board they open, and there should be one obvious way in and around the boards.**
Both are **identity/routing = UX**; neither changes enforcement (that stays the future owner-gate +
RLS, §4–5c). **8.6a is built** (the dual reader + owner-board pilot); 8.6b–8.6e remain proposed —
approve before building each.

### 8.0 In one line
One front door (`office-login.html`) that, on success, **routes by role** to the user's board; every
board resolves "who am I" from an **auth session OR the phone/PIN session**, so per-viewer features
(chat, to-do, planner, roadmap, "who's viewing") work whether you arrived by auth or by PIN.

### 8.1 The two problems, and why they're one
- **Dual-identity gap (functional):** boards resolve the viewer **only** by phone
  (`captureSessionAndGreet` / `gateAndBoot`). An auth session isn't mapped to an `employees` row, so
  `CURRENT_EMPLOYEE_ID` / `CHAT_IDENTITY` are null and every per-viewer feature degrades (verified on
  gm-board: chat "Loading…", to-do "Could not identify you"). Consumers of that identity:
  BoardSettings money-gate, To-Do (`created_by`/`assigned_to`), Team Chat (sender), Push
  (`subscriber_*`), Marketing (`captured_by`), Planner/Roadmap (`owner_employee_id`), the greeting,
  and dashboard-preferences layout (`employee_id`). (§1a.)
- **Single-front-door gap (UX):** office-login is a **dead-end** (no redirect); the boards' own login
  is still `crisdata.html` phone/PIN. An owner who opens another role's board directly gets **no
  "who's viewing" indicator and no "back to my board" nav** — and, until dual-identity lands, a
  half-working board. Same root: the board doesn't know who's looking or where they belong.

### 8.2 What already exists to build on (verified)
- **The link column + resolver:** `employees.auth_user_id` (migration `20260731_…`) is live and
  Cristian is linked; `office-login.html` already resolves `auth.user → employees` and reads
  `name, role` (never `pin`). That exact lookup is the seed of the dual reader.
- **Role→board map:** `crisdata.html:93` `ROLE_DEST = { tech:'my-numbers.html',
  advisor:'advisor-board.html', manager:'gm-board.html', owner:'owner-board.html',
  bookkeeping:'bookkeeping-board.html' }` — the routing table a front door would reuse.
- **Per-board resolvers to converge:** `captureSessionAndGreet()` (advisor/gm/owner),
  `gateAndBoot()` (bookkeeping, the one hard gate), `my-numbers.html` (tech). Each already sets
  `CHAT_IDENTITY` + `CURRENT_EMPLOYEE_ID` — they just need an auth branch prepended.
- **Sign-out already wired:** every board's `initLogout()` calls `db.auth.signOut()` defensively.

### 8.3 Design A — `shared/office-identity.js` (the dual reader) ✅ BUILT
`OfficeIdentity.resolve({ db, sessionPhoneKey, expectedRole })` — one shared resolver each board
calls first, returning `{ employee_id, name, role, photo_url, via }` (via = `'auth' | 'phone'`) or
`null`. Never throws (an auth failure quietly falls through to phone):
1. **Auth branch:** `db.auth.getSession()`; if a session's `user.id` maps to an `employees` row via
   `auth_user_id` → `{id, name, photo_url, role}`, `via:'auth'`. (Same lookup as `office-login.html`
   `:193/:200`.) A session that isn't linked to an employee yet falls through to phone (no hard-fail).
2. **Phone branch (today's path, unchanged):** else `resolvePhone()` mirrors the boards' existing
   logic exactly — `?u=phone&p=pin` passthrough (pin [+ `expectedRole`] validated, persisted to
   `sessionPhoneKey`, URL cleaned) → else the persisted `*BoardPhone` → lookup by phone, `via:'phone'`.
   Techs stay here permanently.
3. **Neither:** returns `null` → boards behave exactly as today (greeting hidden, per-viewer features
   show their existing "reopen from CrisData" message). No regression.
- Boards set `CHAT_IDENTITY`/`CURRENT_EMPLOYEE_ID` from the result and then run unchanged.
  **Permanent, not transitional** — the floor stays on PIN, so the dual reader is forever.
- **Wired first on the owner board** (§8.6a): `captureSessionAndGreet()` now calls the resolver and
  feeds an `applyIdentity(who)` applier (replacing the phone-only `renderGreeting(phone)`); the phone
  path is preserved inside the resolver, not removed. *Rollback:* revert `owner-board.html` to the
  phone-only capture and drop the `office-identity.js` include.

### 8.4 Design B — single front door (routing + cross-board nav + "who's viewing")
- **Route on login:** on `office-login.html` success, resolve role and `location.assign(ROLE_DEST[role])`
  instead of dead-ending. Retire the dead-end only once dual-identity (8.3) is live, so the landed
  board recognizes the session. (crisdata.html phone/PIN stays the parallel front door for the floor.)
- **"Who's viewing" affordance:** a small persistent chip (name · role · `via` auth/PIN) on each
  board; when the viewer's role ≠ the board's native role, show **"Viewing the Manager board —
  back to my board"** linking `ROLE_DEST[myRole]`.
- **Cross-board nav:** for users who legitimately open multiple boards (owner), a compact board
  switcher; scoped by role later when enforcement exists.
- **One session, many tabs:** the auth session is already shared across board tabs on the origin —
  the front door just makes arrival + navigation coherent.

### 8.5 Security posture (unchanged by §8)
Identity + routing here are **UX only**. Who-can-do-what is still governed by today's policies and,
later, the **owner-gate endpoint + `auth.uid()`→role RLS (§4, §5)**. Two guardrails carried in:
- **§5c sequencing (hard):** because `employees` is `{public}` (§7.8), the `employees` RLS lockdown
  must precede giving anyone but the owner an auth account — otherwise a new auth user inherits
  public employees access. So Step 3 (migrate people) is **gated on** the employees lockdown.
- **No new trust from routing:** auto-routing by role is a convenience; it must not be mistaken for
  enforcement (opening another board's URL is still possible until RLS lands).

### 8.6 Phased plan (each step reversible; nothing enforced)
1. **8.6a — `office-identity.js` dual reader**, wired to the **owner board** only. ✅ SHIPPED
   2026-08-01 (`shared/office-identity.js` + `owner-board.html`). Locally verified: board loads with
   no console errors, `OfficeIdentity.resolve` is callable, and with no session/phone it returns
   `null` and leaves the greeting hidden (no regression to the no-identity path). **Auth branch
   pending Cris's live owner sign-in** (can't be exercised without a real office-login session):
   signed-in owner board should greet + load Team Chat + identify To-Do; PIN path unchanged.
   *Rollback:* revert owner-board to phone-only capture, drop the include.
2. **8.6b — roll the reader to gm / advisor / bookkeeping.** ⏳ IN PROGRESS 2026-08-01:
   - **gm-board.html** ✅ wired — `captureSessionAndGreet` now calls the resolver + `applyIdentity`
     (no `expectedRole`, mirroring its role-less passthrough); `loadDashboardPreferences()` preserved.
   - **bookkeeping-board.html** ✅ wired — `gateAndBoot` now resolves via the reader but keeps its
     **hard gate**: no identity → clear phone + redirect `crisdata.html`; `role !== 'bookkeeping'`
     (incl. an auth session for another role, e.g. owner) → bounce, exactly as before.
   - **advisor-board.html** ⏸ HELD — has uncommitted in-flight book-hours edits (hunks at ~1453,
     1944–1972, 3654, 4023, 4461, 4506, 4681, 5129, 5213, 5699; identity code is at 2888–2948, so
     it's code-separable but NOT commit-separable — staging the file would sweep book-hours in).
     Wire it in a clean standalone commit once book-hours lands.
   Locally verified (no auth session): gm loads clean, `OfficeIdentity` callable, greeting hidden
   (no regression); bookkeeping hard-gate still bounces to `crisdata.html`. **Auth branch pending
   Cris's live sign-in** (gm is the real test — where "Could not identify you" happened).
3. **8.6c — "who's viewing / back to my board" chip** on all four office boards (read-only UX).
4. **8.6d — front-door routing:** office-login routes by role on success; add the board switcher.
5. **8.6e — (depends on §4/§5c, off-hours)** owner-gate endpoint + `employees` lockdown **before**
   Step 3 people-migration; only then invite Kevin/Josh/Daiana.

### 8.7 Open questions
- Persisted `*BoardPhone` vs auth session precedence when both exist on one browser (recommend: auth
  wins, phone is fallback).
- Whether the "back to my board" chip should hard-gate non-owners later, or stay advisory until RLS.
- Retire the `?u=phone&p=pin` URL passthrough (PIN-in-URL) as part of 8.6d, or leave for the floor.

## 9. §5c employees lockdown — investigation & proposal (INVESTIGATE-ONLY, nothing applied)
Scoped to the **`employees` table only**. Goal: close the employees hole **before** non-owner auth
accounts exist (bookkeeper next, manager/advisor Mon) **without breaking** the reads/writes the
boards depend on. Nothing here is applied — hand to Cris to review before touching the DB.

### 9.0 The table (verified) — columns & the one sensitive field
`employees` is an **ad-hoc base table** (only column *ALTERs* are in migrations). Columns actually
used anywhere: `id, name, phone, pin, role, active, photo_url, background_photo_url, avatar_path,
auth_user_id`. **No pay / wage / SSN / email / address / DOB columns exist** (swept — none referenced
in any file or migration). The only **login-secret** column is **`pin`** (4-digit). `auth_user_id`
is **security-relevant** (it's what an auth session resolves identity through). `phone` doubles as
the login username. Everything else (name/role/active/photos) is non-sensitive board-display data.

### 9.1 READS of employees — by file, columns, session
- **PIN-matching login reads (anon):** `crisdata.html:148` `select('name,phone,pin,role')
  .eq(phone).eq(pin).eq(active)`; `my-numbers.html:820` same. **These read `pin`** to validate login
  client-side. `shared/office-identity.js:41` (`resolvePhone`) matches `pin` on the `?u/p` passthrough.
- **Auth identity reads (authenticated, NO pin):** `office-login.html:193` `select('name,role')
  .eq(auth_user_id)`; `shared/office-identity.js:71/88` `select('id,name,photo_url,role')` by
  `auth_user_id` (auth branch) or `phone` (phone branch).
- **Staff-mgmt read (manager, reads pin):** `gm-board.html:4156` `select('*')` — the Employee
  Management list; `openEditEmployee` prefills the PIN field from it. Reads **all** columns incl `pin`.
- **Non-pin board/roster reads (anon or auth):** `my-numbers.html:768/828`, `owner-board.html:332`,
  `gm-board.html:2132/2413/2877/3615/3927`, `advisor-board.html:2519/2893/2920/4474`,
  `bookkeeping-board.html:2930`, `crisdata-techboard.html:385`, `shared/board-settings.js:1026`,
  `shared/adoption.js:149` — read only `id/name/phone/role/active/photo_url/background_photo_url`.

### 9.2 WRITES of employees — by file, session, role
- **Self-service (own row; any role; anon OR auth):** `shared/board-settings.js:811` `update{name}`,
  `:858/:879` `update{background_photo_url}`, all `.eq('id', currentEmployeeId)` (the viewer's own
  row). Plus `team-chat.js` `update{avatar_path}` (self). Runs on **every** office board.
- **Staff management (MANAGER or owner; gm-board; anon OR auth):** `gm-board.html:4290`
  `insert{id,name,phone,pin,role,active,photo_url}`, `:4293` `update{…same…}`, `:4328` `delete`.
  **Sets PIN and role.** ⚠ This is done by the **manager** (Kevin, gm-board) — **not** owner-only.
- **`auth_user_id`: NEVER written by any client** (verified — only read at office-login:193 /
  office-identity:72; set by hand-SQL in Path A). This is the load-bearing fact for 9.5a.

### 9.3 Sensitive vs board-needed
| Column | Sensitive? | Who needs it |
|---|---|---|
| `pin` | **Yes — login secret** | anon login (crisdata/my-numbers) READ; manager staff-mgmt READ+WRITE |
| `auth_user_id` | **Yes — identity linkage** | client READ only (auth resolve); write = hand-SQL / service-role |
| `phone` | Semi (login username) | login + all boards |
| `name, role, active, photo_url, background_photo_url, avatar_path` | No | boards (display, greeting, roster, self-service) |

### 9.4 Real exposure vs legit access — and the HARD CONSTRAINT
**Exposure today:** the live policy is `ALL {public}` → **every** session (anon *and* any
authenticated account) has full read+write. So anyone can read all PINs, rewrite roles, reset PINs,
insert/delete staff, or **re-point `auth_user_id`**.

**The hard constraint:** the **publishable anon key is embedded in every page** → the `anon` role is
available to anyone with devtools. So any RLS/grant that restricts only `authenticated` is
**bypassable via the anon key** — it is *not* a real boundary. A true close therefore requires
tightening **anon**, which we cannot do yet because **login + staff-mgmt + self-service run on anon**
(crisdata/my-numbers validate `pin` via anon SELECT; board-settings & gm staff-mgmt write via anon).
That is exactly §5c's precondition ("move login off the anon PIN read **first**").

**Reframe for "close before non-owner accounts":** giving the bookkeeper an auth account does **not**
widen DB exposure — they already have full `employees` access via the public anon key today. The
**one genuinely new escalation** the auth rollout introduces is **`auth_user_id` re-linking**: a
signed-in (or anon) actor could `update employees set auth_user_id = <their uid>` on the **owner's**
row → their auth session then resolves as **owner**. That one is real, new, and **closable now**.

### 9.5 Proposal
**9.5a — ✅ APPLIED 2026-08-01 (safe, additive, zero breakage): `auth_user_id` writes locked to
service-role only.** No client writes `auth_user_id` (§9.2), so revoking client insert/update of
*that column* broke nothing and killed the re-link-to-owner escalation. Applied via the column
re-grant in §9.7a (reconciled vs PART 0: privileges on `anon`+`authenticated` directly; 11 live
columns incl `created_at`). **Live-verified with the public anon key** (non-matching row filter, no
data touched): `update employees set auth_user_id=…` → **HTTP 401 / `42501` permission denied**;
control `update … set name=…` → **HTTP 204 success** (proves the lock is specific to `auth_user_id`,
not a blanket break). `authenticated` carries the identical column grant → same denial. GM board
hard-refreshed post-apply: greeting + to-do + chat all still work. **By-hand `auth_user_id` linking
(as `postgres`, the noon bookkeeper link) unaffected.**

**9.5b — PROPOSE, DON'T APPLY (the real close; endpoints-first, §5c order):**
1. **`api/staff`** — service-role endpoint, **verifies the caller's JWT → re-checks role ∈ {owner,
   manager}**, performs staff insert/update/delete + PIN/role changes. Migrate `gm-board`
   staff-mgmt to it. (Self-service own-row name/bg can stay client-side, scoped to the caller.)
2. **`api/login`** — service-role endpoint that verifies `phone+pin` **server-side** for
   `crisdata.html` + `my-numbers.html`, removing the anon `SELECT(pin)` dependency.
3. Finish moving **all** board identity onto auth/endpoint (advisor wiring + front door, §8.6b/d).
4. **THEN the flip:** revoke anon/authenticated direct **writes**; revoke `SELECT(pin)` from
   anon+authenticated (pin readable only by service-role / the endpoints); **keep** anon+auth
   `SELECT` on the **non-pin** columns so board reads/greeting/roster keep working.

**9.5c — DO NOT do a naive "owner-only employees" RLS flip now.** It would break: the **PIN login**
(anon SELECT of pin), **self-rename + board background** (board-settings, every board), **manager
staff-management** (Kevin is manager, not owner), and **greeting/roster reads** — *and* it would be
**bypassable via the anon key** = false security. The manager-staff-mgmt write is the clearest trap
a naive owner-only policy sets off.

### 9.6 PART 0 — read-only verification (run FIRST, eyeball, like the widen)
```sql
-- 0a. Current employees RLS policies (name + cmd + roles — need the policy name for 9.5b):
select policyname, cmd, roles, qual, with_check
  from pg_policies where schemaname='public' and tablename='employees'
 order by cmd, policyname;
-- 0b. Table-level privileges on employees by role (what to convert to column grants):
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema='public' and table_name='employees'
   and grantee in ('anon','authenticated','service_role','public')
 order by grantee, privilege_type;
-- 0c. Existing COLUMN-level privileges (see if any column grants already exist):
select grantee, column_name, privilege_type
  from information_schema.column_privileges
 where table_schema='public' and table_name='employees'
   and grantee in ('anon','authenticated','service_role','public')
 order by grantee, column_name, privilege_type;
-- 0d. Confirm the full live column list (so the 9.5a/9.5b grant lists are exact):
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='employees'
 order by ordinal_position;
```
Confirm before applying 9.5a: (1) the exact column set (0d) so the re-grant list is complete;
(2) whether privileges sit on `anon`/`authenticated` or on `public` (0b) — the revoke/grant must
target whatever holds them; (3) no existing column grants that would re-open `auth_user_id` (0c).

### 9.7 Proposed SQL
**9.7a — auth_user_id write-lock. ✅ APPLIED 2026-08-01** (reconciled vs PART 0: 0b confirmed
insert/update held by `anon`+`authenticated` directly, not `public`; 0d confirmed 11 live columns
including **`created_at`** at pos 8). The lists enumerate **every column except `auth_user_id`** — so
the only change is the `auth_user_id` write lock. Applied clean ("Success, no rows returned") and
live-verified (§9.5a).
```sql
-- Client never writes auth_user_id (verified §9.2). Lock it to service_role by replacing the
-- table-level insert/update grant with a column list that OMITS auth_user_id only. Additive to the
-- RLS policy (rows still governed by the existing policy); this changes COLUMN privileges only.
-- service_role / postgres are untouched → by-hand auth_user_id linking (noon bookkeeper) still works.
revoke insert, update on public.employees from anon, authenticated;
grant insert (id, name, phone, pin, role, active, photo_url, created_at, background_photo_url, avatar_path)
  on public.employees to anon, authenticated;
grant update (name, phone, pin, role, active, photo_url, created_at, background_photo_url, avatar_path)
  on public.employees to anon, authenticated;
```
**9.7b — the real close (DO NOT APPLY until api/login + api/staff exist and boards are off anon PIN).**
```sql
-- Illustrative target — finalize against PART 0. Replaces the blanket public policy.
drop policy if exists "<public ALL policy name from 0a>" on public.employees;
revoke select, insert, update, delete on public.employees from anon, authenticated;
-- Board reads: every column EXCEPT pin (login now server-side via api/login).
grant select (id, name, phone, role, active, photo_url, background_photo_url, avatar_path, auth_user_id)
  on public.employees to anon, authenticated;
-- All writes go through service-role endpoints (api/staff, self-service) → no direct client writes.
create policy "employees board read" on public.employees
  for select to anon, authenticated using (true);
-- service_role retains full access.
```

### 9.8 Test checklist (prove nothing broke)
**After 9.7a (auth_user_id lock) — expect NO behavior change:**
- **Owner (auth + PIN):** greeting shows; self-rename saves; board background upload saves; to-do/chat OK.
- **Manager (gm-board, PIN today):** Employee Management — **add** a test employee (name/phone/pin/role),
  **edit** one (change role/PIN/active), **delete** the test row — all succeed.
- **Bookkeeping (PIN):** gate boots; self-rename saves.
- **Tech + login (anon):** `crisdata.html` phone+PIN login works (PIN validated); `my-numbers.html` loads.
- **The lock itself:** via the anon key (devtools) attempt `update employees set auth_user_id='…'` →
  **permission denied**. And confirm a normal staff `insert`/`update` (no auth_user_id) still works.

**Additional after 9.7b (only once endpoints exist):** login via `api/login` (no anon pin read);
staff-mgmt via `api/staff` (manager allowed, non-manager denied); a client `select pin` returns no
pin column; all board reads/greeting/roster still populate.

### 9.9 Rollback
- **9.7a:** `revoke insert, update on public.employees from anon, authenticated;` then
  `grant insert, update on public.employees to anon, authenticated;` (restores table-level write incl
  auth_user_id — back to today's posture).
- **9.7b:** drop the `employees board read` policy, re-grant `select, insert, update, delete … to
  anon, authenticated`, and re-create the original `ALL {public}` policy (name from 0a).

## Where it lives in the code
- **Office auth (new, Step 0–1):** `office-login.html` (standalone test page — login/set-password/
  sign-out + role display; **"shop front door" skin** — darkened shop photo background
  `assets/office-login-bg.jpg`, Lee-blue `#1f6fe0` card, LEE TRANSMISSION / CrisData brand,
  password show/hide toggle, techs-use-phone+PIN note, secure footer);
  `migrations/20260731_employees_auth_user_id.sql` (the `auth_user_id` link, hand-run). Registered
  in the File Cabinet via `shared/file-cabinet.js` DOCS.
- **Step 1½ widen (shipped):** `migrations/20260801_office_auth_widen_step1_5.sql` (add-only
  anon→authenticated read+write widen; hand-run 2026-08-01) — see §7.8.
- **Step 2 dual reader (§8.6a–b):** `shared/office-identity.js` (`OfficeIdentity.resolve` — auth
  session OR phone/PIN), wired via a `<script src="shared/office-identity.js">` include into
  `owner-board.html` + `gm-board.html` (`captureSessionAndGreet` → resolver + `applyIdentity`) and
  `bookkeeping-board.html` (`gateAndBoot` → resolver, hard gate + role bounce preserved).
- **Step 2 remaining (not built — §8):** `advisor-board.html` (HELD behind in-flight book-hours);
  `office-login.html` route by role on success; a "who's viewing / back to my board" chip.
- **Existing identity (unchanged):** login + role routing `crisdata.html`; per-board identity
  `captureSessionAndGreet()` (advisor/gm/owner), `gateAndBoot()` (bookkeeping), `my-numbers.html`
  (tech); logout `initLogout()` per board (already calls `db.auth.signOut()`).
- Service-role pattern to mirror for any future auth endpoint: `api/announcement.js`,
  `api/desk-appointment.js`.
- Reference implementation adapted: the `kiki/` repo (§2). Related: [[settings]] (§3 identity, §6
  identity-first, §8 enforcement), [[change-requests]] (§5 — a feature that deferred to this).

## Session change log
- 2026-07-31 — Created during the "Kiki Supabase Auth + lockout-safe adoption" investigation.
  Mapped CrisData's phone/PIN + anon-`employees` identity model and every "who is logged in"
  touchpoint; documented KiKi's email-invite Supabase-Auth implementation (clients, `proxy.ts`
  middleware, `generateLink` invite/recovery via Resend, `set-password`, email-vs-env-var roles,
  coarse `auth.uid()` RLS, service-role admin ops); recommended **email invite over SMS OTP** for
  4 office users; and proposed a 6-step lockout-safe rollout (auth alongside PIN → one test account
  → dual-identity reader → migrate one-by-one → enforce last, `employees` RLS dead last).
  **Investigation only — no code, migrations, or auth changes.**
- 2026-07-31 — **Built Step 0–1** (login-only foothold, **nothing enforced**): the additive
  `migrations/20260731_employees_auth_user_id.sql` (nullable `employees.auth_user_id` + partial
  unique index; no FK, no RLS change — hand-run, not yet applied), and the standalone
  `office-login.html` (plain supabase-js with `persistSession`/`detectSessionInUrl`, CrisData's own
  publishable key, **no service-role**; `signInWithPassword` + set/change password
  (`updateUser`) + `signOut`, role display via the `auth_user_id`→`employees` link reading
  `name, role` only). Set-password folded into the one page so **Path A** (dashboard create-user +
  Auto-Confirm) needs no Site-URL/redirect change. Registered the doc in the File Cabinet
  (`shared/file-cabinet.js`). `crisdata.html`, the four boards, and every RLS policy untouched;
  phone/PIN fully intact. Steps 2–5 not built.
- 2026-07-31 — **Audited Step 1½ (anon→authenticated read+write widen) and PARKED it** (§7).
  Confirmed live: an office-login session makes the browser `authenticated` for every board tab, and
  the anon-only schema goes dark (`change_requests` vanished from triage/My-requests until sign-out).
  Enumerated ~36 anon-only board-read objects (28 tables + `feature_adoption` view + 3 private
  storage buckets) + 7 "verify-live" ad-hoc objects, and the direct-anon-write tables. Captured the
  live-verification query, the ready READS widen (§7.4), the WRITES widen (§7.5), and the rollback
  (§7.6). **Not applied** — a reads-only widen is a silent-write trap, so resume does reads+writes
  together (or writes-behind-endpoints) in a calm off-hours window. **Interim rule: sign out of
  office-login before using a board.** Doc-only pass — no migration, no policy change.
- 2026-07-31 — **Cosmetic: restyled `office-login.html` to the "shop front door" skin** (matches
  `crisdata-office-login-shopfront.html`): the real shop photo as a darkened full-screen background
  (`assets/office-login-bg.jpg`, ~472 KB, referenced by URL — not base64), a centered Lee-blue
  (`#1f6fe0`) card with the LEE TRANSMISSION / CrisData header, email/password with a show/hide
  toggle, the techs-&-floor-crew phone+PIN note, and the secure-sign-in footer — applied to the
  signed-in and set-password views too. **Skin only — all auth logic byte-identical** (supabase-js
  client, `signInWithPassword`, `updateUser`, `signOut`, the `auth_user_id`→`employees` role lookup,
  session handling). No boards / policies / migration touched.
- 2026-07-31 — Added **`customer_phones`** (customer-dedupe Phase A) to the §7 Step 1½ widen
  arrays (§7.3 verify, §7.4 reads, §7.5 writes, §7.6 rollback) — it's born `anon`-full-access like
  `customers`, so it must be widened to `authenticated` alongside the rest when Step 1½ runs.
  Doc-only — the widen is still PARKED / not applied.
- 2026-08-01 — **SHIPPED Step 1½** (§7.8). Re-audited the parked §7.2 list against live code before
  applying and caught omissions it missed: 5 board-WRITE gaps (`push_subscriptions`, `tech_whiteboard`,
  `shopboard_tables` writes; `punches` INSERT) and ALL storage-object WRITES (4 buckets). Ran the
  0a/0b live verify and reconciled: `employees`/`chat_messages`/`core_charges`/`transmissions` are
  already `{public}`/self-authenticated (omitted); `punches` widened INSERT-only; anon lacks delete on
  `crisdata-attachments` and update on `board-backgrounds` (dropped); `employee-photos` is `ALL
  {public}` (skipped). Delivered + applied one add-only migration
  `migrations/20260801_office_auth_widen_step1_5.sql` (no anon/public policy dropped/narrowed, no RLS
  enabled/forced, enforces nothing). **Live-verify:** owner board full read+write ✅; manager board
  reads ✅ but chat/to-do fail on **viewer-identity** (auth session not mapped to an employee when a
  board is opened directly) — **NOT** an RLS trap and **NOT** a 1½ regression. Retired the interim
  sign-out rule for the read/write layer. ⚠ Recorded the hard sequencing constraint: because
  `employees` is `{public}`, the **§5c employees RLS lockdown must precede giving anyone but the owner
  an auth account**.
- 2026-08-01 — **Folded the two live-verify findings into one Step 2 investigation (§8), no build.**
  Dual-identity (`shared/office-identity.js`: resolve viewer by auth session OR phone/PIN so
  chat/to-do/planner/"who's viewing" work signed in) + single front door (one login → route by role
  via `ROLE_DEST` → cross-board nav + "who's viewing / back to my board" chip). Security posture
  unchanged (identity/routing = UX; enforcement stays the §4–5c owner-gate + RLS). Phased plan in
  §8.6, gated on the §5c lockout before Step 3 people-migration.
- 2026-08-01 — **Built Step 2 §8.6a — dual-identity reader + owner-board pilot (additive).** New
  `shared/office-identity.js` (`OfficeIdentity.resolve({db, sessionPhoneKey, expectedRole})` →
  `{employee_id, name, role, photo_url, via}` or null; auth-session-first via `auth_user_id`, else
  the unchanged phone/PIN path; never throws). Wired into `owner-board.html`: `captureSessionAndGreet`
  now calls the resolver and feeds a new `applyIdentity(who)` applier in place of the phone-only
  `renderGreeting(phone)` — phone path preserved inside the resolver, not removed. Locally verified
  (no console errors; resolver callable; no-session/no-phone → null → greeting hidden = no
  regression). **Auth branch pending Cris's live owner sign-in.** No enforcement, no RLS/employees
  changes, nobody migrated; only the owner board touched. Next: §8.6b (gm/advisor/bookkeeping).
- 2026-08-01 — **Built Step 2 §8.6b — rolled the reader into MANAGER + BOOKKEEPING (additive).**
  `gm-board.html`: `captureSessionAndGreet` → `OfficeIdentity.resolve` + new `applyIdentity(who)`
  (no `expectedRole`, mirroring gm's role-less passthrough; `loadDashboardPreferences()` preserved).
  `bookkeeping-board.html`: `gateAndBoot` now resolves via the reader but keeps its **hard gate** —
  no identity → clear phone + redirect `crisdata.html`; `role !== 'bookkeeping'` (incl. an auth
  session for another role) → bounce, unchanged. **`advisor-board.html` HELD** — its identity code
  (2888–2948) is separable but the file carries uncommitted in-flight book-hours edits, so staging
  it would sweep them; wire advisor in a clean commit after book-hours lands. Locally verified: gm
  loads clean (no console errors, resolver callable, greeting hidden = no regression); bookkeeping
  hard-gate still bounces to `crisdata.html` with no identity. **Auth branch pending Cris's live
  sign-in (gm is the real test).** No enforcement / RLS / employees changes; the other in-flight
  files (board-settings, shop-board, teardown, tech-board) left untouched.
- 2026-08-01 — **§5c employees lockdown — INVESTIGATE + PROPOSE only (§9), nothing applied.** Mapped
  every employees read/write vs session: PIN validated by **anon** SELECT in `crisdata.html:148` +
  `my-numbers.html:820`; staff-mgmt insert/update/delete (sets pin+role) is on `gm-board` = **manager**
  (not owner-only); self-rename/bg via `board-settings.js`; `auth_user_id` is **never client-written**
  (read-only). Only sensitive column = `pin`; no pay/PII columns exist. Key finding: the public anon
  key means restricting only `authenticated` is bypassable, so a real close needs the login/staff
  service-role endpoints first (§5c order); adding a non-owner account doesn't widen DB exposure —
  the one genuinely new escalation is `auth_user_id` re-linking, which **is** closable now. Proposed:
  §9.5a lock `auth_user_id` writes to service-role (safe, additive, zero breakage); §9.5b the real
  endpoints-first close (don't apply); §9.5c why a naive owner-only flip is unsafe. Includes PART 0
  verification queries, exact SQL, test checklist, and rollback. Doc-only — no DB/policy change.
- 2026-08-01 — **APPLIED §9.5a — `employees.auth_user_id` write-lock (the one safe-now close).** Ran
  PART 0: insert/update held by `anon`+`authenticated` directly (0b); 11 live columns incl `created_at`
  at pos 8 (0d). Applied §9.7a (revoke insert/update from anon+authenticated; re-grant every column
  **except `auth_user_id`**) — "Success, no rows returned". **Live-verified with the public anon key**
  (non-matching row, no data touched): `update … auth_user_id` → 401/`42501` permission denied;
  control `update … name` → 204 success (lock is `auth_user_id`-specific, not a blanket break). GM
  board post-apply: greeting + to-do + chat intact; by-hand `postgres` linking unaffected. Closes the
  re-link-to-owner escalation before non-owner accounts exist. §9.5b (endpoints-first close) stays
  queued before any enforcement flip. Doc-only commit — no code/in-flight files touched.
