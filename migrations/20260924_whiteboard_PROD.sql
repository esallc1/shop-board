-- ============================================================================
-- Whiteboard (advisor board) — SLICE 3: the database. Two tables.
-- PROD run (hygemiszxwmyrkmhbjub / www / board.leetransmissionshop.com).
-- -- Sandbox has its own file: 20260924_whiteboard_SANDBOX.sql — RUN THAT ONE FIRST.
-- Wiring: docs/wiring/whiteboard.md (§6 storage, §7 the endpoint).
--
-- WHAT.
--   whiteboard_items        — the hand-written lines: kind 'parts' (Waiting on parts) or
--                             'note' (Don't forget). Optional RO link. Who + when wrote it.
--                             Never deleted: "Arrived ✓" / erase set cleared_* (soft), and
--                             Undo clears them again ("Recently erased").
--   whiteboard_pickup_calls — "Called ✓" on a Ready → call for pickup line: ONE row per RO
--                             (ro_id is the key). A mis-tap undo sets called_* back to null —
--                             the row stays (no hard deletes). If the RO comes back to
--                             'invoice' later, the old stamp is still there to show.
--
-- WHO CAN DO WHAT (same posture as social_threads / social_messages, 2026-09-23).
--   anon           — nothing. Not a read, not a write.
--   authenticated  — SELECT only, and only when public.is_staff() is true. "Logged in" is
--                    NOT enough: KiKi shares prod's auth.users (require-user.js has the
--                    same warning).
--   service_role   — api/whiteboard.js. All writes; who/when stamped there from the
--                    signed-in employee, never from the browser.
--   There are NO insert/update/delete policies: the browser never writes these rows.
--
-- NEEDS public.is_staff() — created by 20260923_social_messaging_*.sql (applied to both
-- projects 2026-09-23). The guard below refuses to run without it.
--
-- Supabase's default privileges GRANT new public tables to anon and authenticated.
-- Every revoke below undoes that — do not remove them.
--
-- SELF-GUARDING (staging-db.md §8): refuses to run on the wrong or an unstamped
-- project. One transaction: a failed guard aborts everything. Safe to re-run.
-- ============================================================================

begin;

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP. Stamp this database first (staging-db.md §8).'; end if;
  if v not like 'PROD%' then raise exception 'WRONG PROJECT: % — this is the PROD file, refusing', v; end if;
  if to_regprocedure('public.is_staff()') is null then raise exception 'public.is_staff() is missing — run 20260923_social_messaging first'; end if;
  raise notice 'whiteboard migration running on %', v;
end $$;

-- ── 1. The hand-written lines ───────────────────────────────────────────────
create table if not exists public.whiteboard_items (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('parts','note')),
  text            text not null check (char_length(btrim(text)) between 1 and 500),
  ro_id           uuid references public.repair_orders(id) on delete set null,
  created_by      uuid references public.employees(id),
  created_by_name text not null,
  created_at      timestamptz not null default now(),
  cleared_at      timestamptz,
  cleared_by      uuid references public.employees(id),
  cleared_by_name text,
  cleared_reason  text check (cleared_reason in ('arrived','erased')),
  constraint whiteboard_items_cleared_pair check ((cleared_at is null) = (cleared_reason is null)),
  constraint whiteboard_items_arrived_is_parts check (cleared_reason is distinct from 'arrived' or kind = 'parts')
);
comment on table public.whiteboard_items is
  'Whiteboard lines (advisor board). kind parts = Waiting on parts, note = Don''t forget. Written ONLY by api/whiteboard.js '
  '(service role); staff read via is_staff(). Never deleted: cleared_* = Arrived ✓ / erased (Undo clears them).';
create index if not exists whiteboard_items_open_idx    on public.whiteboard_items (kind, created_at) where cleared_at is null;
create index if not exists whiteboard_items_cleared_idx on public.whiteboard_items (cleared_at desc) where cleared_at is not null;

-- ── 2. "Called ✓" per RO ────────────────────────────────────────────────────
create table if not exists public.whiteboard_pickup_calls (
  ro_id          uuid primary key references public.repair_orders(id),
  called_at      timestamptz,
  called_by      uuid references public.employees(id),
  called_by_name text,
  updated_at     timestamptz not null default now(),
  constraint whiteboard_pickup_calls_stamp_pair check ((called_at is null) = (called_by_name is null))
);
comment on table public.whiteboard_pickup_calls is
  '"Called ✓" on a Ready → call for pickup line: one row per RO. Undo = called_* null (row kept). Written ONLY by '
  'api/whiteboard.js (service role); staff read via is_staff().';

-- ── 3. RLS + grants: staff read, nobody else anything ───────────────────────
alter table public.whiteboard_items        enable row level security;
alter table public.whiteboard_pickup_calls enable row level security;

revoke all on table public.whiteboard_items, public.whiteboard_pickup_calls from public, anon, authenticated;
grant select on table public.whiteboard_items, public.whiteboard_pickup_calls to authenticated;
grant all    on table public.whiteboard_items, public.whiteboard_pickup_calls to service_role;

drop policy if exists staff_read on public.whiteboard_items;
create policy staff_read on public.whiteboard_items
  for select to authenticated using (public.is_staff());
drop policy if exists staff_read on public.whiteboard_pickup_calls;
create policy staff_read on public.whiteboard_pickup_calls
  for select to authenticated using (public.is_staff());
-- NO insert / update / delete policies. Writes are service role only.

-- ── 4. Realtime (SQL-editor tables are not auto-added) ───────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'whiteboard_items') then
    alter publication supabase_realtime add table public.whiteboard_items;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'whiteboard_pickup_calls') then
    alter publication supabase_realtime add table public.whiteboard_pickup_calls;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY (read-only; run after the commit, in the same SQL editor). ONE query,
-- one row per check — every row should say PASS.
-- ============================================================================
-- select check_name, case when ok then 'PASS' else 'FAIL' end as result, detail from (
--   select 1 as n, 'database' as check_name, true as ok, (select env from public.app_env limit 1) as detail
--   union all
--   select 2, 'both tables exist', count(*) = 2, string_agg(tablename, ', ')
--     from pg_tables where schemaname = 'public' and tablename in ('whiteboard_items','whiteboard_pickup_calls')
--   union all
--   select 3, 'RLS on for both', count(*) filter (where rowsecurity) = 2, string_agg(tablename || '=' || rowsecurity, ', ')
--     from pg_tables where schemaname = 'public' and tablename in ('whiteboard_items','whiteboard_pickup_calls')
--   union all
--   select 4, 'only policies = staff_read SELECT to authenticated using is_staff()',
--          count(*) = 2 and bool_and(policyname = 'staff_read' and cmd = 'SELECT' and roles = '{authenticated}' and qual like '%is_staff()%'),
--          string_agg(tablename || ':' || policyname || ':' || cmd, ', ')
--     from pg_policies where schemaname = 'public' and tablename in ('whiteboard_items','whiteboard_pickup_calls')
--   union all
--   select 5, 'anon has NO privileges',
--          not bool_or(has_table_privilege('anon', t, p)), 'select/insert/update/delete/truncate/references/trigger'
--     from unnest(array['public.whiteboard_items','public.whiteboard_pickup_calls']) t,
--          unnest(array['select','insert','update','delete','truncate','references','trigger']) p
--   union all
--   select 6, 'authenticated = SELECT only',
--          bool_and(has_table_privilege('authenticated', t, 'select'))
--            and not bool_or(has_table_privilege('authenticated', t, 'insert') or has_table_privilege('authenticated', t, 'update')
--                            or has_table_privilege('authenticated', t, 'delete') or has_table_privilege('authenticated', t, 'truncate')),
--          'select yes; insert/update/delete/truncate no'
--     from unnest(array['public.whiteboard_items','public.whiteboard_pickup_calls']) t
--   union all
--   select 7, 'both in supabase_realtime', count(*) = 2, string_agg(tablename, ', ')
--     from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
--      and tablename in ('whiteboard_items','whiteboard_pickup_calls')
--   union all
--   select 8, 'empty to start', (select count(*) from public.whiteboard_items) = 0 and (select count(*) from public.whiteboard_pickup_calls) = 0,
--          (select count(*) from public.whiteboard_items) || ' items · ' || (select count(*) from public.whiteboard_pickup_calls) || ' calls'
-- ) c order by n;
--
-- Over the API as anon (expect 401 / 42501 "permission denied"):
--    GET https://<ref>.supabase.co/rest/v1/whiteboard_items?select=id   (apikey = publishable key, no user token)
--
-- ROLLBACK (only before any real line is written):
--    drop table if exists public.whiteboard_pickup_calls;
--    drop table if exists public.whiteboard_items;
