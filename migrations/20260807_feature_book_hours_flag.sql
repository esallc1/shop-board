-- ============================================================
-- CrisData — FEATURE FLAG: Book Hours master on/off switch.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one owner-controlled master switch for the whole Book Hours feature,
-- stored as a boolean column on the existing single-row shop_settings table
-- (same home + same anon RLS as show_tech_on_ro / tax_rate / card_fee_pct —
-- NO new table, NO RLS change needed).
--
-- DEFAULT OFF (false): with the flag off the advisor board behaves exactly as
-- it did before the Book Hours feature — the Book Hours field is hidden and the
-- "enter hours / N/A before leaving Estimate" gate does NOT block. The board
-- reads the flag on load and FAILS SAFE to OFF if the settings read fails.
--
-- EXTENSIBLE: this is the first entry in a "Features" switchboard (owner-only
-- Settings pane). Each future master switch (e.g. the Phase 3 manager-approval
-- toggle) is just another boolean column here + one line in the app's
-- FEATURE_FLAGS registry — no schema redesign.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app ships a pre-migration fallback (getShopSettings() returns
-- feature_book_hours=false when the column/row is missing), so the boards keep
-- working — feature OFF — in the window before this is applied.
-- ============================================================

-- ── shop_settings — the Book Hours master switch ─────────────
alter table public.shop_settings
  add column if not exists feature_book_hours boolean not null default false;

-- No RLS / policy / realtime changes: shop_settings is already anon-full-access
-- (mirrors the existing pattern) and already in the realtime publication.

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) the column exists with the right type + default:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_book_hours';
--   -- expect: feature_book_hours | boolean | NO | false
--
-- (b) the single shop_settings row picked up the default (still OFF):
--   select id, feature_book_hours from public.shop_settings;
--   -- expect one row, feature_book_hours = false
-- ============================================================
