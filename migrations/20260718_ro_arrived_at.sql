-- ─────────────────────────────────────────────────────────────────────────
-- RO → Floor convergence, Slice 1: "Check in / Arrived"
--
-- Adds a single additive column that records the PHYSICAL arrival of the car
-- for a CrisData RO. This is history ("this car did arrive"), NOT a live
-- on-floor flag — a car checks in once per RO. It does NOT change the RO
-- stage and does NOT touch the shopboard_* tables (v1 shop floor).
--
-- Run this in the Supabase SQL Editor, then confirm with the verify query
-- below BEFORE any dependent advisor-board.html code ships.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.repair_orders
  add column if not exists arrived_at timestamptz;

comment on column public.repair_orders.arrived_at is
  'Timestamp the car physically arrived / was checked in onto the v1 shop '
  'floor for this RO. Set once at check-in; stays set as history even after '
  'the car is later picked up or cleared on v1. Null = not yet checked in.';

-- ── VERIFY (expect one row: arrived_at | timestamp with time zone | YES) ──
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name   = 'repair_orders'
--    and column_name  = 'arrived_at';
