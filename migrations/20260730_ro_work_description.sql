-- ============================================================
-- RO "Work Description" (Kevin). Adds `work_description` to repair_orders.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   Internal instructions from the advisor/manager to the mechanic — e.g.
--   "remove the valve body and take it to the bench." Edited on the advisor-board
--   RO detail (directly under Complaint) and shown READ-ONLY on the tech board's
--   job modal (crisdata-techboard.html), fetched by `po`.
--
--   DISTINCT from `advisory_notes` (customer-facing recommendations, which print
--   on the invoice) and from `complaint` (the customer's concern). This column is
--   INTERNAL and does NOT print. Do not merge them.
--
-- SECURITY: no RLS change. repair_orders already allows anon SELECT + UPDATE
--   (20260729_repair_orders_no_delete.sql) — the advisor board edits it directly;
--   the tech board only SELECTs it. Nullable; NULL = nothing written yet.
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). The app degrades quietly
--   if the column is missing (the RO select is `*`; updateRoField swallows 42703).
-- ============================================================

alter table public.repair_orders
  add column if not exists work_description text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='repair_orders'
--       and column_name = 'work_description';   -- text, YES nullable
-- ============================================================
