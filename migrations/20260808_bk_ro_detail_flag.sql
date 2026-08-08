-- ============================================================
-- CrisData — Bookkeeping per-RO drill-down feature switch.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive boolean on the single shop_settings row — the master
-- on/off switch for the Bookkeeping board's per-RO drill-down (Income / Open-RO
-- tiles → a per-RO detail with the original RO on the left and its matched parts
-- receipts + "profit over parts" on the right). Default OFF, so the board renders
-- exactly like today until an owner flips it on (owner Features pane, 4th flag).
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). shop_settings is the single
-- anon-full-access row (see settings.md §1); the new column inherits its grants —
-- NO RLS/policy change. Reader fails safe to OFF (missing column / failed read →
-- false), so a board on the un-migrated schema behaves exactly like today.
--
-- READ-ONLY FEATURE: the drill-down only READS invoice_queue / invoice_po_lines /
-- repair_orders / ro_line_items (+ signed reads of the invoice-images bucket). It
-- writes nothing. No other schema change is needed.
-- ============================================================

alter table public.shop_settings
  add column if not exists feature_bk_ro_detail boolean not null default false;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_bk_ro_detail';
--   -- expect: feature_bk_ro_detail | boolean | false
-- ============================================================
