# How office login could adopt Supabase Auth (investigation + lockout-safe plan)

> Doc: `/docs/wiring/office-auth.md`
> Last updated: 2026-07-31 — verified vs commit `77bf5c5`
> Status: 🟡 STEP 0–1 BUILT (login-only foothold — **nothing enforced**); §5 Steps 2–5 still
> proposed. §1 (CrisData today) and §2 (KiKi's auth) are verified against the live code
> (`crisdata.html`, the four boards, `api/*`, the embedded `kiki/` repo). Step 0 migration is
> **hand-run — not yet applied** until Cris runs it. Extends [[settings]] §6 — which left two
> identity paths (an HMAC token OR "a Supabase Auth session if we adopt GoTrue later"); this
> adopts the **Supabase Auth** path using KiKi's proven implementation.

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

## Where it lives in the code
- **Office auth (new, Step 0–1):** `office-login.html` (standalone test page — login/set-password/
  sign-out + role display); `migrations/20260731_employees_auth_user_id.sql` (the `auth_user_id`
  link, hand-run). Registered in the File Cabinet via `shared/file-cabinet.js` DOCS.
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
