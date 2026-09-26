-- ============================================================================
-- Security slice 3, step (b): LOCK DOWN WRITES TO `calls`.
-- ⛔ DO NOT RUN until the watch period is clear — Cris runs by hand, sandbox first.
-- SANDBOX run (efhmefpaijjncwgbvwki / test.leetransmissionshop.com). Run this one FIRST;
-- the prod file is 20260926_calls_lockdown_PROD.sql.
-- Wiring: docs/wiring/call-window-desk.md §1 (RLS), inbox-calls.md §5.
--
-- WHAT. Browsers may still READ calls (unchanged), but may no longer WRITE them.
--   before: anon + authenticated — SELECT (using true) and UPDATE (using true / with check true)
--   after:  anon + authenticated — SELECT only. No UPDATE / INSERT / DELETE policy, and the
--           table privileges themselves revoked, so a missed browser writer gets a LOUD
--           "permission denied" instead of a silent 0-row update.
--   service_role (api/calls.js, api/desk-appointment.js, api/ctm-webhook.js, the crons)
--   bypasses RLS and keeps every privilege — nothing server-side changes.
--
-- BEFORE RUNNING (the "watch" gate — see the session report):
--   • slice 3 (a)1 + (a)2 + (a)3 LIVE on prod (every browser writer on api/calls.js);
--   • the watch period clean: no browser PATCH/POST/DELETE on /rest/v1/calls in the
--     Supabase API logs since (a)3 shipped, and no unexplained api/calls 401s;
--   • every advisor board reloaded since (a)3 (an old open tab still carries the old code).
--
-- SELF-GUARDING (staging-db.md §8): refuses the wrong or an unstamped project.
-- One transaction: a failed guard aborts everything. Safe to re-run.
-- ============================================================================

begin;

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP. Stamp this database first (staging-db.md §8).'; end if;
  if v like 'PROD%' then raise exception 'WRONG PROJECT: % — this is the SANDBOX file, refusing', v; end if;
  if to_regclass('public.calls') is null then raise exception 'public.calls is missing — wrong database?'; end if;
  raise notice 'calls lockdown running on %', v;
end $$;

-- ── 1. The two browser UPDATE policies go ───────────────────────────────────
drop policy if exists "Allow anon update on calls" on public.calls;   -- 20260728_calls_notes.sql
drop policy if exists "auth update calls"          on public.calls;   -- 20260801_office_auth_widen_step1_5.sql

-- ── 2. Table privileges: SELECT only for the browser roles ──────────────────
-- (Supabase's default privileges grant ALL on public tables to anon + authenticated.)
revoke all    on table public.calls from anon, authenticated;
grant  select on table public.calls to   anon, authenticated;

-- ── 3. Reads stay exactly as they are ───────────────────────────────────────
-- "Allow anon select on calls" (20260728_calls.sql) and "auth read calls"
-- (20260801_office_auth_widen_step1_5.sql) are NOT touched. Realtime keeps working
-- (it needs SELECT). Locking READS is a separate, later slice.

commit;

-- ============================================================================
-- VERIFY (read-only; run right after, same SQL editor). Every row must say ok = true.
-- ============================================================================
-- select 'database' as check_name, true as ok, (select env from public.app_env limit 1) as detail
-- union all
-- select 'no UPDATE/INSERT/DELETE/ALL policy for anon or authenticated',
--        not exists (select 1 from pg_policies where schemaname='public' and tablename='calls'
--                    and cmd in ('UPDATE','INSERT','DELETE','ALL')
--                    and (roles && array['anon','authenticated']::name[] or roles && array['public']::name[])),
--        (select string_agg(policyname || ' [' || cmd || ']', ', ') from pg_policies where schemaname='public' and tablename='calls')
-- union all
-- select 'SELECT policies still there (anon + authenticated)',
--        (select count(*) from pg_policies where schemaname='public' and tablename='calls' and cmd='SELECT') >= 2, null
-- union all
-- select 'anon: SELECT only',
--        has_table_privilege('anon','public.calls','SELECT') and not has_table_privilege('anon','public.calls','UPDATE')
--        and not has_table_privilege('anon','public.calls','INSERT') and not has_table_privilege('anon','public.calls','DELETE'), null
-- union all
-- select 'authenticated: SELECT only',
--        has_table_privilege('authenticated','public.calls','SELECT') and not has_table_privilege('authenticated','public.calls','UPDATE')
--        and not has_table_privilege('authenticated','public.calls','INSERT') and not has_table_privilege('authenticated','public.calls','DELETE'), null
-- union all
-- select 'service_role: can still write',
--        has_table_privilege('service_role','public.calls','UPDATE') and has_table_privilege('service_role','public.calls','INSERT'), null
-- union all
-- select 'still in the realtime publication',
--        exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='calls'), null;
--
-- Then, in the board (signed in): write a tray note, a Desk outcome, an attach — each "Saved" /
-- 200 through api/calls.js — and nothing else changes.

-- ============================================================================
-- UNDO (only if something breaks) — puts back exactly what was there before.
-- ============================================================================
-- begin;
-- grant all on table public.calls to anon, authenticated;
-- create policy "Allow anon update on calls" on public.calls for update to anon          using (true) with check (true);
-- create policy "auth update calls"          on public.calls for update to authenticated using (true) with check (true);
-- commit;
