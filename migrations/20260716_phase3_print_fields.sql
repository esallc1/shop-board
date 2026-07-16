-- ============================================================
-- CrisData Phase 3 — printable one-page Estimate/RO/Invoice: the
-- additive columns behind it. Run in the Supabase SQL Editor
-- (project hygemiszxwmyrkmhbjub). ADDITIVE ONLY — new columns on
-- existing CrisData tables; does NOT touch the live shop floor,
-- Approval Queue, parts_orders, or completed_jobs.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app has pre-migration fallbacks, so the RO Board and print
-- action keep working in the window before this is applied.
-- ============================================================

-- ── shop_settings: shop-profile fields for the invoice header +
--    legal footer. Owner/GM-only to edit (UI-level, in Settings). ──
alter table public.shop_settings add column if not exists shop_name       text;
alter table public.shop_settings add column if not exists address_line    text;
alter table public.shop_settings add column if not exists city_state_zip  text;
alter table public.shop_settings add column if not exists phone           text;
alter table public.shop_settings add column if not exists email           text;
alter table public.shop_settings add column if not exists website         text;
alter table public.shop_settings add column if not exists logo_url        text;   -- Supabase Storage public URL
alter table public.shop_settings add column if not exists mv_number       text;   -- NOT seeded — Cris enters it in Settings
alter table public.shop_settings add column if not exists legal_terms     text;   -- invoice small-print footer; editable in Settings

-- Seed the known Lee Transmission profile onto the fixed settings row,
-- but ONLY where still null (never clobber a value Cris already set).
-- mv_number is intentionally left out of this seed.
update public.shop_settings set
  shop_name      = coalesce(shop_name,      'Lee Transmission'),
  address_line   = coalesce(address_line,   '5583 Lee St Unit 12'),
  city_state_zip = coalesce(city_state_zip, 'Lehigh Acres, FL 33971'),
  phone          = coalesce(phone,          '239-491-2809'),
  email          = coalesce(email,          'will@leetransmissionauto.com'),
  website        = coalesce(website,         'www.leetransmissionauto.com')
where id = '00000000-0000-0000-0000-000000000001';

-- Seed the invoice LEGAL TERMS (small-print footer). ⚠️ REPLACE the
-- placeholder string below with Lee Transmission's EXACT lien /
-- authorization / warranty paragraph BEFORE running — or leave it and
-- paste the real wording in Settings → Shop Profile → Legal terms after
-- applying. COALESCE means it only fills when still null (never clobbers
-- text Cris already entered). Escape any apostrophes by doubling them.
update public.shop_settings set
  legal_terms = coalesce(legal_terms,
    '[[ PASTE Lee Transmission''s exact lien / authorization / warranty paragraph here — editable in Settings ]]')
where id = '00000000-0000-0000-0000-000000000001';

-- ── repair_orders: per-RO fields the printed invoice needs. ──
alter table public.repair_orders add column if not exists miles_out      integer;  -- odometer out (null until close)
alter table public.repair_orders add column if not exists advisory_notes text;      -- advisories beyond the complaint
alter table public.repair_orders add column if not exists technician     text;      -- assigned tech name (display)

-- ── ro_line_items: part number on parts lines. ──
alter table public.ro_line_items add column if not exists part_number    text;


-- ============================================================
-- VERIFY (run after applying): expect the shop profile populated
-- (shop_name 'Lee Transmission', etc.), mv_number NULL, and the new
-- repair_orders / ro_line_items columns present.
-- ============================================================
--   select shop_name, address_line, city_state_zip, phone, email, website,
--          logo_url, mv_number, legal_terms
--   from public.shop_settings;
--
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='repair_orders'
--     and column_name in ('miles_out','advisory_notes','technician');
--
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='ro_line_items'
--     and column_name = 'part_number';
