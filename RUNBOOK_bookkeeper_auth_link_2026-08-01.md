# Runbook — link Daiana (bookkeeper) to her Supabase auth account (Path A)

> Status: **READY — reviewed & green-lit 2026-08-01. NOT YET RUN.** Run at noon.
> Context: office-auth Step 3 (migrate people one-by-one). Owner + manager + bookkeeping boards
> already carry the §8.6b dual-identity reader; §5c 9.5a (`auth_user_id` write-lock) is applied &
> verified. Full background: `docs/wiring/office-auth.md` §5, §8, §9.

**Facts filled in:** email `midacri@live.com` · UID `5b5cee1c-64e4-4bb6-88c2-bc89097807dc` · her
Supabase auth user **already exists** (no create step) · `{{HER_EMP_ID}}` = fill from Step 2a at noon
(the one runtime unknown).

---

## Step 1 — Confirm her auth user + password readiness (no create needed)
In the Supabase dashboard (project `hygemiszxwmyrkmhbjub`) → **Authentication → Users**:
1. Confirm `midacri@live.com` exists and its UID is `5b5cee1c-64e4-4bb6-88c2-bc89097807dc`.
2. ⚠️ **Since the account already exists:** before the office-login step (Step 3), either **confirm
   Daiana knows her `midacri@live.com` password**, or **reset it in the dashboard** (Users → her row →
   Reset/set a temp password) so she has working credentials at noon. Don't skip this — a forgotten
   password is the most likely thing to stall the noon step.

## Step 2 — Confirm her employees row, then link
Run **2a first** and eyeball it. It finds her row and safety-checks that her UID isn't already linked:

```sql
-- 2a. CONFIRM. Left list: the bookkeeping row(s) — pick Daiana's id (auth_user_id should be NULL).
--     Right list: make sure her UID isn't already linked to some other row (expect 0 rows).
select id, name, phone, role, active, auth_user_id
  from public.employees
 where role = 'bookkeeping'
 order by name;

select id, name, role, auth_user_id
  from public.employees
 where auth_user_id = '5b5cee1c-64e4-4bb6-88c2-bc89097807dc';   -- expect: 0 rows
```

Then paste Daiana's confirmed `id` into `{{HER_EMP_ID}}` and run the link. The guards make it
self-protecting — it links **only** her row and **only** if not already linked:

```sql
-- 2b. LINK (runs as postgres in the SQL editor → bypasses the 9.5a auth_user_id lock, as intended).
update public.employees
   set auth_user_id = '5b5cee1c-64e4-4bb6-88c2-bc89097807dc'
 where id = '{{HER_EMP_ID}}'
   and role = 'bookkeeping'
   and auth_user_id is null;
-- Expect: "Success. 1 row(s) affected." If 0 rows → STOP (wrong id, already linked, or role
-- mismatch) and re-check 2a. The partial unique index on auth_user_id also blocks a double-link.

-- 2c. VERIFY the link landed on the right person:
select id, name, role, auth_user_id
  from public.employees
 where id = '{{HER_EMP_ID}}';   -- auth_user_id should now show her UID
```

## Step 3 — Daiana's office-login sign-in + set-password
1. She opens **https://board.leetransmissionshop.com/office-login.html**
2. Signs in with **`midacri@live.com`** + her password (from Step 1 — known or freshly reset).
3. On the signed-in card, use **set/change password** to set the password she'll keep (`updateUser`).
4. **Reload** — session persists; the card should show **her name + role: bookkeeping** (reads through
   the `auth_user_id` link, so it confirms Step 2 worked).
5. Have her **Sign out**, then sign back in once with the new password to confirm it sticks.

## Step 4 — Post-link verify checklist
- **Bookkeeping board greets her:** open **https://board.leetransmissionshop.com/bookkeeping-board.html**
  while signed in → hard gate **boots** (no redirect to crisdata), greeting **"Hi, Daiana"**.
  *(Exercises the §8.6b dual reader's auth branch → `role='bookkeeping'` → gate passes.)*
- **Per-viewer features signed in:** To-Do identifies her + a to-do adds; Team Chat loads (not stuck
  "Loading…").
- **Phone/PIN still works:** separate/incognito browser → normal `crisdata.html` phone+PIN as
  bookkeeping → board boots. (Auth is additive; PIN untouched.)
- **Gating — honest state:** the **only enforced boundary today** is the bookkeeping board's hard gate
  (admits only `role='bookkeeping'`; bounces others to crisdata). ⚠️ **Cross-board access is NOT yet
  enforced** (Step 4/5) — if she opens `owner-board.html`/`gm-board.html` directly she'll *see* it with
  her identity; expected pre-enforcement, not a regression. What she **cannot** do: escalate via
  `auth_user_id` (9.5a lock, verified live). True owner-only enforcement is the queued §9.5b / Step 4–5
  work.

## Rollback (if anything looks wrong)
```sql
-- Unlink her → reverts to phone/PIN only. Her auth user stays (already existed).
update public.employees set auth_user_id = null where id = '{{HER_EMP_ID}}';
```

---

## After the run — record it
Once Daiana is linked and verified, note it in `docs/wiring/office-auth.md` (§5 Step 3 / change log):
bookkeeper migrated to auth on 2026-08-01, phone/PIN retained as fallback. Then this runbook can be
left as-is (historical) — the repo keeps it recoverable.
