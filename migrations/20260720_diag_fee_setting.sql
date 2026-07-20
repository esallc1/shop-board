-- ============================================================
-- Quick diag-fee receipt — default diagnostic-fee amount setting.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- When a customer declines an estimate but pays a diagnostic fee at pickup,
-- the advisor prints a quick one-line receipt. This adds the DEFAULT amount
-- that prefills that receipt (still editable per receipt), same pattern as
-- the labor rate / tax % / card fee already in shop_settings.
--
-- Additive + nullable → safe to run mid-workday. Owner/GM edit it in
-- Settings → RO & Pricing. The receipt itself needs no schema change: it
-- archives into completed_jobs with a DISTINCT source_table='diag_receipt'
-- so it never collides with the estimate's own 'repair_orders' archive row.
--
-- board-settings.js reads this column resiliently (getShopSettings only
-- surfaces it when present), so nothing breaks before this runs.
-- ============================================================

alter table public.shop_settings
  add column if not exists default_diag_fee numeric(10,2) null;

-- Optional: seed a starting amount (or leave null and set it in Settings).
-- update public.shop_settings set default_diag_fee = 165.00
--   where id = '00000000-0000-0000-0000-000000000001';
