-- ============================================================
-- Owner planning surface — PHASE 1: the `projects` roadmap table.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Idempotent; the app has a fallback so nothing breaks pre-migration.
--
-- SCOPING: owner_employee_id makes each person's roadmap PRIVATE. Every
-- query filters .eq('owner_employee_id', CURRENT_EMPLOYEE_ID) and every
-- insert stamps it. This is APP-LEVEL scoping — the same honest caveat
-- as marketing_content / invoice_queue: RLS here is anon-full-access (no
-- Supabase Auth exists anywhere in CrisData), so "private" means the app
-- never shows you someone else's roadmap, NOT per-row DB access control.
-- Shipping the column now = zero backfill when bookkeeping/manager get
-- this feature later.
--
-- NULL DATES ARE FIRST-CLASS (both start_date and target_date nullable):
--   both set     -> bar start_date..target_date on the timeline
--   target only  -> a diamond milestone marker at target_date
--   start only   -> a "running" bar start_date..today (open right edge,
--                   "no target" chip) — work in flight nobody has
--                   committed to finishing; stays ON the timeline
--   neither      -> the "no date yet" backlog list beside the timeline
--
-- STATUS -> bar color (app-side, shared/roadmap.js):
--   not_started grey   active accent/indigo   stalled amber
--   shipped green       parked muted slate + hatch
-- RED IS RESERVED for the LATE treatment only — never a status color.
--
-- archived_at: non-null = archived; hidden by default, shown behind a
-- "Show archived" toggle (soft delete, no hard delete in the UI).
-- ============================================================

create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  owner_employee_id uuid not null references public.employees(id),
  name              text not null,
  status            text not null default 'not_started'
                      check (status in ('not_started','active','stalled','shipped','parked')),
  start_date        date,
  target_date       date,
  color             text,          -- optional per-project override; null = use status color
  notes             text,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz    -- non-null = archived (hidden by default)
);

create index if not exists idx_projects_owner    on public.projects (owner_employee_id);
create index if not exists idx_projects_archived on public.projects (archived_at);
create index if not exists idx_projects_target   on public.projects (target_date);

-- RLS: anon-full-access, matching todos / marketing_content / invoice_queue
-- (no Supabase Auth; scoping + edit rights are enforced app-side).
alter table public.projects enable row level security;
drop policy if exists "Allow anon full access to projects" on public.projects;
create policy "Allow anon full access to projects"
  on public.projects for all to anon using (true) with check (true);

-- Realtime — so a project added/edited on one device updates the roadmap
-- live on another. (SQL-Editor tables aren't auto-added to the publication.)
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='projects'
  ) then
    alter publication supabase_realtime add table public.projects;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='projects' order by ordinal_position;
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='projects';   -- 1 row
-- ============================================================
