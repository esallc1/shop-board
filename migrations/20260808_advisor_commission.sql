-- ============================================================
-- CrisData — Advisor Commission (Hours Engine Part 2)
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: a per-ADVISOR weekly gross-profit rollup + commission widgets, behind
-- their own owner feature switch (default OFF). This migration adds ONLY
-- additive, nullable columns + one boolean flag — no data is rewritten, nothing
-- is dropped, and NO RLS/policy change is needed:
--   • shop_settings  — single anon-full-access row (see settings.md §1); new
--                      columns inherit its grants.
--   • employees      — anon + authenticated RLS (office-auth widen); inherits.
--   • package_units  — anon-full-access + realtime (see packages.md §2); inherits.
--
-- Everything fails safe: the reader treats a missing column / failed read as
-- feature OFF and falls back to code defaults, so a board on the un-migrated
-- schema behaves exactly like today.
--
-- GROSS PROFIT (the pay basis), locked with the owner:
--   advisor GP per RO = Σ labor-line revenue (labor ≈ pure margin)
--                     + Σ parts-line markup (unit_price − unit_cost)
--                     + Σ package-line margin (unit_price − package unit_cost)
--   Shop Supply / Hazmat / Fee lines are EXCLUDED (owner decision 2026-08-08).
--   When a parts/package line has no real cost yet, GP falls back to
--   price × the shop-wide assumed-margin % below (STEP 4) — a real cost on the
--   line always overrides. Package per-unit cost lives on package_units (STEP 3).
--
-- PAYOUT (locked): base $1,000 / full 40-hr week + 2.5% of THAT week's GP,
--   weekly-final (no monthly true-up, no clawbacks). Base + % are per-advisor
--   (STEP 2); null → the code default ($1,000 / 2.5%). Manny's plan is the
--   default — nothing is hardcoded to one person.
-- ============================================================

-- ── STEP 1 — the master switch (3rd FEATURE_FLAGS entry), default OFF ─────────
alter table public.shop_settings
  add column if not exists feature_advisor_commission boolean not null default false;

-- ── STEP 2 — per-advisor pay plan (nullable → code default $1,000/wk, 2.5%) ───
alter table public.employees
  add column if not exists commission_base_weekly numeric;   -- $/full week; null → default 1000
alter table public.employees
  add column if not exists commission_gp_pct       numeric;   -- % of weekly GP; null → default 2.5

-- ── STEP 3 — package cost so package GP is derivable ─────────────────────────
-- Parts already carry ro_line_items.unit_cost. A package line is a bundled set
-- price with no per-line cost, so the shop's rebuild cost lives per UNIT here;
-- package GP = line unit_price − this unit_cost (fallback to STEP 4 % until set).
alter table public.package_units
  add column if not exists unit_cost numeric;   -- INTERNAL rebuild cost per unit; nullable

-- ── STEP 4 — shop-wide assumed-margin fallbacks (used ONLY when a line has no ─
-- real cost, so legacy rows aren't systematically wrong). A real cost always
-- overrides. Stored as fractions (0.40 = 40%). Null → code default.
alter table public.shop_settings
  add column if not exists parts_margin_pct   numeric;   -- assumed GP fraction on parts w/o cost
alter table public.shop_settings
  add column if not exists package_margin_pct numeric;   -- assumed GP fraction on packages w/o cost

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public'
--      and ( (table_name='shop_settings' and column_name in
--               ('feature_advisor_commission','parts_margin_pct','package_margin_pct'))
--         or (table_name='employees' and column_name in
--               ('commission_base_weekly','commission_gp_pct'))
--         or (table_name='package_units' and column_name='unit_cost') )
--    order by table_name, column_name;
--   -- expect 6 rows, all is_nullable=YES except feature_advisor_commission (NO, default false)
-- ============================================================
