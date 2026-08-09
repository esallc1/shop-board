-- ============================================================
-- CrisData — COST LAYER RLS FIX: parts_library (+ unit_parts) → authenticated.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- ── ROOT CAUSE ──────────────────────────────────────────────
-- The office owner (Cristian) is signed in via office-login.html (Supabase
-- Auth), so every board tab's browser client runs as the **`authenticated`**
-- Postgres role — NOT `anon`. (OfficeIdentity.resolve reads db.auth.getSession();
-- see docs/wiring/office-auth.md — "STEP 1½ SHIPPED".)
--
-- On 2026-08-01, `20260801_office_auth_widen_step1_5.sql` widened a FIXED LIST of
-- existing tables from anon-only to ALSO cover `authenticated` (adding
-- `for all to authenticated using(true) with check(true)` per table). Any table
-- created AFTER that widen must add its own authenticated policy or the signed-in
-- owner goes blind (SELECT → 0 rows, INSERT/UPDATE → "new row violates
-- row-level security policy").
--
-- `parts_library` (Step 2b, created 2026-08-09) shipped with ONLY a `to anon`
-- policy → the authenticated owner has no applicable policy → INSERT is
-- RLS-blocked. (`unit_parts` already carries an authenticated policy, which is
-- why adding recipe parts works — parts_library was the one left out.) This is a
-- ROLE mismatch, not a missing GRANT: a missing grant would say "permission
-- denied for table", not "violates row-level security policy".
--
-- ── FIX (ADD-ONLY — mirrors the 2026-08-01 widen exactly) ───
-- Add a `for all to authenticated using(true) with check(true)` policy to
-- parts_library — the 1:1 authenticated twin of its existing `to anon` policy,
-- no broader. unit_parts gets the same statement idempotently (belt-and-suspenders:
-- it already works, so this just pins that policy into version control under the
-- widen's canonical `auth write …` name).
--
-- SAFETY:
--   • ADD-ONLY. The only `drop policy if exists` targets the NEW `auth write …`
--     names created here (for idempotent re-runs) — NEVER an existing anon policy.
--     No existing policy is dropped, narrowed, or altered; no RLS is enabled/forced;
--     no GRANT and no DATA is touched. Anon (phone/PIN) sessions keep working.
--   • Scope is exactly the two cost-layer tables — no other table is touched.
--   • Authenticated access = the SAME `using(true)/with check(true)` the anon
--     policy already grants. No wider than anon.
-- ============================================================

-- parts_library — the broken table: add its authenticated twin.
drop policy if exists "auth write parts_library" on public.parts_library;
create policy "auth write parts_library"
  on public.parts_library for all to authenticated using (true) with check (true);

-- unit_parts — idempotent belt-and-suspenders (already works for authenticated;
-- this pins the policy into a tracked migration under the widen's canonical name).
drop policy if exists "auth write unit_parts" on public.unit_parts;
create policy "auth write unit_parts"
  on public.unit_parts for all to authenticated using (true) with check (true);

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) both tables now carry an anon AND an authenticated "for all" policy:
--   select tablename, policyname, cmd, roles, qual, with_check
--     from pg_policies
--    where schemaname='public' and tablename in ('parts_library','unit_parts')
--    order by tablename, roles;
--   -- expect, per table: one {anon} row + one {authenticated} row, cmd ALL,
--   --   qual=true / with_check=true.
--
-- (b) as the signed-in owner (authenticated), inserting a library item now
--     succeeds in the app: Build Sheet → Parts catalog → Add item.
-- ============================================================
