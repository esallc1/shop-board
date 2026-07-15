-- ============================================================
-- Follow-up to migrations/20260715_todos.sql — register the new
-- `todos` table with Supabase's realtime publication.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Tables created via the SQL Editor (raw CREATE TABLE) are NOT
-- automatically added to the `supabase_realtime` publication — that
-- auto-registration only happens when a table is created through the
-- Table Editor UI's "Enable Realtime" toggle. Without this statement,
-- the `postgres_changes` subscription in each board's To-Do view
-- joins its channel successfully (looks connected) but never
-- receives events, so assigned-to-you items don't show up live —
-- confirmed live during testing: channel state was "joined" but an
-- INSERT from another tab produced zero events until this ran.
-- ============================================================

alter publication supabase_realtime add table public.todos;
