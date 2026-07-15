-- ============================================================
-- To-Do lists (personal + assignable) — Advisor, Bookkeeping, GM,
-- and Owner boards.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- assigned_to is nullable: null means it's a personal to-do (only
-- visible to created_by). Non-null means it's assigned to that
-- employee (visible to them regardless of who created it, and still
-- visible to the creator too, tagged "Assigned to X" on their view).
--
-- Denormalized *_name columns alongside the *_by/*_to FKs follow the
-- same convention as invoice_queue's uploaded_by/uploaded_by_name —
-- avoids a join just to render "Assigned to Kevin" / "Assigned by
-- Cris" tags in the list.
--
-- completed_at is nullable and drives both the checkbox state and
-- the 3-day visibility window (app-side query filter, not deleted —
-- see the board JS's loadAndRenderTodos()).
-- ============================================================

create table public.todos (
  id uuid primary key default gen_random_uuid(),

  text text not null,

  created_by uuid references public.employees(id),
  created_by_name text not null,

  assigned_to uuid references public.employees(id),
  assigned_to_name text,

  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index idx_todos_assigned_to on public.todos (assigned_to);
create index idx_todos_created_by on public.todos (created_by);
create index idx_todos_completed_at on public.todos (completed_at);

-- RLS: matches the anon-key, app-level-auth-only pattern used
-- everywhere else in this app (completed_jobs, invoice_queue,
-- parts_orders, etc.) — no Supabase Auth session exists anywhere in
-- CrisData. Edit/delete permission (creator or assignee only) is
-- enforced app-side, same as everything else in this app.
alter table public.todos enable row level security;

create policy "Allow anon full access to todos"
  on public.todos
  for all
  to anon
  using (true)
  with check (true);
