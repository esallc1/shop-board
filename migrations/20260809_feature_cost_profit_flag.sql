-- ============================================================
-- CrisData — "Cost & Profit" feature switch (Step 1: frame + relocation only).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive boolean on the single shop_settings row — the master
-- on/off switch for the "Cost & Profit" sidebar group (Cockpit + Build Sheet) on
-- the Owner and Bookkeeping boards. When ON it also moves "Rebuild Units &
-- Prices" out of Settings into Build Sheet → Units (the Settings pane becomes a
-- one-line "Moved to the Build Sheet" redirect). Default OFF, so both boards look
-- exactly like today until an owner flips it on (owner Features pane, 5th flag).
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). shop_settings is the single
-- anon-full-access row (see settings.md §1); the new column inherits its grants —
-- NO RLS/policy change. Reader fails safe to OFF (missing column / failed read →
-- false), so a board on the un-migrated schema behaves exactly like today.
--
-- NO OTHER SCHEMA CHANGE: Step 1 is frame + relocation only. It does NOT touch
-- package_units (the Units editor is the SAME editor, just relocated) or any RO.
-- Parts recipes / vendor costs / profit math arrive in Steps 2 and 3.
-- ============================================================

alter table public.shop_settings
  add column if not exists feature_cost_profit boolean not null default false;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_cost_profit';
--   -- expect: feature_cost_profit | boolean | false
-- ============================================================
