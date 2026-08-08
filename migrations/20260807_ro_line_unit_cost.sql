-- ============================================================
-- CrisData — ro_line_items.unit_cost (parts cost / margin, INTERNAL).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive column so a PART line can store the shop's COST alongside
-- the customer SELL price. The Add/Edit-Line pop-up shows margin (Sell − Cost,
-- and %) live while editing. Cost is INTERNAL — it is never shown to the
-- customer and never printed on the invoice (printRo reads description /
-- part_number / quantity / unit_price only, never unit_cost).
--
-- PRICE/MATH UNCHANGED: totals still = Σ(quantity × unit_price) + tax. unit_cost
-- is a separate, nullable field that never enters the money math.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). ro_line_items already
-- carries anon + authenticated RLS policies (office-auth widen,
-- 20260801_office_auth_widen_step1_5.sql), so NO policy / RLS change is needed —
-- the new column inherits the table's grants. The app degrades quietly if this
-- isn't applied yet (a parts line saves without its cost; missing-column write
-- is caught and retried without unit_cost).
-- ============================================================

alter table public.ro_line_items
  add column if not exists unit_cost numeric;   -- shop cost per unit (INTERNAL); nullable

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_line_items'
--      and column_name='unit_cost';
--   -- expect: unit_cost | numeric | YES
-- ============================================================
