-- ============================================================
-- Comeback capture — SLICE: badge + chain view + blocked close.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHY THIS COLUMN EXISTS:
--   A comeback is not invoiced, so nothing today forces anyone to record what
--   the complaint was or what we did about it — which is exactly why the
--   green-Chevy repair history is missing. This adds the ONE place to record
--   "what we did on the comeback," and the app then BLOCKS closing a comeback
--   until both the complaint (existing field) and this resolution are filled.
--   It fixes history going FORWARD only; nothing backfills old rows.
--
-- ⚠️ A NEW COLUMN ON PURPOSE — do NOT reuse advisory_notes:
--   advisory_notes PRINTS on the customer invoice (printRo) and archives to
--   completed_jobs.notes. "What we did on the comeback" is INTERNAL — it must
--   never print and never leave via the archive. So it gets its own column.
--   The COMPLAINT side reuses the EXISTING repair_orders.complaint field —
--   there is deliberately no second complaint column.
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). Nullable — NULL means
-- "nobody has recorded it yet," never "there was no repair." No RLS change:
-- repair_orders keeps its existing anon policy; the board already UPDATEs it.
-- The client degrades quietly if this column is missing (42703 / PGRST204).
-- ============================================================

alter table public.repair_orders
  add column if not exists comeback_resolution text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='repair_orders'
--       and column_name = 'comeback_resolution';   -- text, YES nullable
-- ============================================================
