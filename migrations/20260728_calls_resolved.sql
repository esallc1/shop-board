-- ============================================================
-- Advisor desk — slice 3b: let call-backed items leave a lane.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Extends `calls` again (slices 2 + 3a unchanged); ctm_webhook_log unchanged.
--
-- The Desk's Callbacks and Coming-in lanes are driven by calls rows. Without a
-- way to mark one handled they'd grow forever. An item leaves its lane when
-- resolved_at is set (via the row's "Done" action, stamping resolved_by_name).
--
-- No RLS change: the anon UPDATE policy from slice 3a already covers these two
-- columns. No new enum. (The Declined lane is repair_orders-backed and clears
-- via its existing declined_at/restore lifecycle, not resolved_at.)
-- ============================================================

alter table public.calls
  add column if not exists resolved_at      timestamptz,
  add column if not exists resolved_by_name text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type from information_schema.columns
--     where table_name='calls' and column_name in ('resolved_at','resolved_by_name')
--     order by column_name;                                  -- ⇒ 2 rows
--   -- open lane items (unresolved callbacks / drop-offs):
--   select ctm_call_id, next_step, due_at, due_all_day, resolved_at, resolved_by_name
--     from public.calls
--    where next_step in ('quoted_callback','dropping_off') and resolved_at is null
--    order by due_at;
-- ============================================================
