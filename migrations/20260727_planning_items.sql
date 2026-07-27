-- ============================================================
-- Owner planning surface — PHASE 2 SLICE A: `planning_items`.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Idempotent; the app has a fallback so nothing breaks pre-migration.
--
-- Cris's own planning work (the Planner week view + ideas inbox), tied
-- optionally to projects. Same conventions as `projects`: anon-full-access
-- RLS, realtime added explicitly.
--
-- DELIBERATELY SEPARATE FROM `todos`. No FK, no shared columns, no data
-- migration between them. `todos` stays the operational shop tool with
-- assignment/fan-out; planning_items are the owner's private planning.
--
-- NULLABLE project_id is first-class — a captured idea/loose note has no
-- project yet. `on delete set null`: projects are archived (not hard
-- deleted) in the roadmap UI, so this rarely fires, but if a project ever
-- is deleted its items just go neutral (lose the color) instead of erroring.
--
-- scheduled_time is OPTIONAL and separate from scheduled_date:
--   date + time  -> timed calendar grid at that slot
--   date, no time -> all-day item pinned to the top of that day
--   neither      -> unscheduled (the inbox rail)
-- NEVER defaulted or faked as midnight.
--
-- done_at drives the checkbox + a 3-day visibility window (app-side query
-- filter, mirroring the To-Do board's completed_at rule — not deleted).
-- ============================================================

create table if not exists public.planning_items (
  id                uuid primary key default gen_random_uuid(),
  owner_employee_id uuid not null references public.employees(id),
  project_id        uuid references public.projects(id) on delete set null,
  title             text not null,
  notes             text,
  scheduled_date    date,
  scheduled_time    time,
  duration_minutes  int check (duration_minutes is null or duration_minutes > 0),
  done_at           timestamptz,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz
);

create index if not exists idx_planning_items_owner   on public.planning_items (owner_employee_id);
create index if not exists idx_planning_items_sched   on public.planning_items (scheduled_date);
create index if not exists idx_planning_items_project on public.planning_items (project_id);
create index if not exists idx_planning_items_done    on public.planning_items (done_at);

-- RLS: anon-full-access, matching projects / todos / marketing_content
-- (no Supabase Auth; scoping + edit rights are enforced app-side).
alter table public.planning_items enable row level security;
drop policy if exists "Allow anon full access to planning_items" on public.planning_items;
create policy "Allow anon full access to planning_items"
  on public.planning_items for all to anon using (true) with check (true);

-- Realtime — so a capture/drag on one device updates the Planner live on
-- another. (SQL-Editor tables aren't auto-added to the publication.)
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='planning_items'
  ) then
    alter publication supabase_realtime add table public.planning_items;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='planning_items' order by ordinal_position;
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='planning_items';   -- 1 row
-- ============================================================
