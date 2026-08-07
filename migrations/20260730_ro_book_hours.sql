-- ============================================================
-- CrisData — BOOK HOURS capture (tech-pay groundwork).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHY: moving techs to flat rate needs a real per-job BOOK-HOURS number in
-- the data. Today flag_hours is filled on ~1 job in 70, so the ALLDATA hours
-- the advisor looks up per vehicle are never persisted. The advisor types the
-- ALLDATA book time by hand on the RO — there is no fixed hours-per-rebuild
-- lookup (hours vary by vehicle). See docs/wiring/flat-rate-hours.md.
--
-- PRINCIPLE: book_hours is a PAY field, NOT a PRICE field. The customer
-- price stays Σ(quantity × unit_price) over ro_line_items — untouched here.
-- book_hours is a separate per-job number with different consumers (tech
-- pay / the future flat-rate report), and it MIRRORS onto the floor row's
-- existing flag_hours column (no new floor column — the app write-through
-- mirrors book_hours → shopboard_*.flag_hours so the pickup archive keeps
-- working unchanged).
--
-- THREE-WAY STATE (deliberate): a lone nullable numeric can only express
-- "null vs a number", but we need THREE distinct states —
--     • book_hours IS NULL  AND book_hours_na = false → NOT CAPTURED (blank)
--     • book_hours = <n>     (book_hours_na = false)    → captured hours
--         (n = 0 is a real, allowed value, distinct from blank and N/A)
--     • book_hours IS NULL  AND book_hours_na = true  → explicit N/A
--         (diagnostic-only / no-labor RO — never trapped into a fake number)
-- Hence the extra book_hours_na flag. The mirror writes flag_hours = the
-- number when captured, and NULL for both blank and N/A.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app ships with pre-migration fallbacks (writes to the missing columns
-- degrade quietly), so the RO Board keeps working in the window before this
-- is applied.
-- ============================================================

-- ── repair_orders — the pay-only book-hours fields ───────────
alter table public.repair_orders
  add column if not exists book_hours     numeric;                 -- nullable; NULL+na=false = not captured
alter table public.repair_orders
  add column if not exists book_hours_na  boolean not null default false;  -- true = explicit N/A (no labor)

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- repair_orders gained the two columns:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name in ('book_hours','book_hours_na')
--    order by column_name;
--   -- expect: book_hours(numeric,YES) | book_hours_na(boolean,NO)
-- ============================================================
