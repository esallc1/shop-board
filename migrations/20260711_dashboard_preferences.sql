-- ============================================================
-- GM Board: dashboard_preferences table
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Per-employee customizable Overview dashboard layout: which stat
-- cards are visible and in what order. One row per employee; the
-- whole layout is written in one shot on "Save" (Customize mode has
-- no live/incremental autosave).
-- ============================================================

create table public.dashboard_preferences (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  layout jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (employee_id)
);

create index idx_dashboard_preferences_employee on public.dashboard_preferences (employee_id);

-- RLS: matches the anon-key pattern already used for completed_jobs —
-- this app has no Supabase Auth session, only app-level PIN login, so
-- access control stays at the app layer, not the DB layer.
alter table public.dashboard_preferences enable row level security;

create policy "Allow anon full access to dashboard_preferences"
  on public.dashboard_preferences
  for all
  to anon
  using (true)
  with check (true);
