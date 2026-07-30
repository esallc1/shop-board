-- ============================================================
-- To-Do priority (Kevin). Adds `priority` to `todos`.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   Each to-do gets a priority — immediate / high / normal / low (default
--   'normal') — set from a small per-item dropdown on the boards' To-Do list,
--   color-coded (left border) and sorted Immediate-first.
--
-- SECURITY: no RLS change. `todos` is already anon-full-access
--   (20260715_todos.sql), so the boards set priority with a direct anon UPDATE —
--   we do NOT add an endpoint or widen anything. Realtime is unchanged (todos is
--   already in the publication via 20260715_todos_realtime.sql).
--
-- SAFE TO RE-RUN: add column if not exists (idempotent); the CHECK is dropped
--   first. Existing rows get 'normal' via the NOT NULL default.
-- ============================================================

alter table public.todos
  add column if not exists priority text not null default 'normal';

-- Constrain to the four values. Existing rows are all 'normal' (the default), so
-- the constraint validates cleanly. Idempotent: drop first.
alter table public.todos drop constraint if exists todos_priority_check;
alter table public.todos
  add constraint todos_priority_check
  check (priority in ('immediate', 'high', 'normal', 'low'));

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='todos' and column_name='priority';
--     -- text, NO (not null), default 'normal'
--   select conname from pg_constraint where conname='todos_priority_check';   -- 1 row
--   select priority, count(*) from public.todos group by priority;           -- all 'normal' pre-use
-- ============================================================
