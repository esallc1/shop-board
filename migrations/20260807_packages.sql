-- ============================================================
-- CrisData — PACKAGES: package unit prices + a "Package" RO line type.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: a shop-set list of package units (e.g. "6L80" = $4950 set price,
-- 6.5 default R&R hours) that the RO builder drops onto a new "Package" line
-- type. The set price is the CUSTOMER price (qty 1, taxable by default,
-- editable per job). The R&R hours are TECH-PAY only (pull/install credit) —
-- they never enter the money math. Whole feature is behind an owner switch
-- (feature_packages), default OFF.
--
-- PRINCIPLE (same as book_hours): price and pay are separate.
--   • package line price  = ro_line_items.unit_price (qty fixed at 1)
--   • package line pay     = ro_line_items.rr_hours (never summed into totals)
-- The R&R-hours field only shows when the Book Hours feature is ON.
--
-- ADDITIVE + idempotent. The app ships pre-migration fallbacks (the Packages
-- settings pane reads empty, the Package line type only appears when the switch
-- is ON, and rr_hours / package_unit_id writes degrade quietly on a missing
-- column), so boards keep working — feature OFF — before this is applied.
--
-- ⚠ STEP 1 MUST RUN ON ITS OWN. `alter type ... add value` cannot run inside a
-- transaction block. Run STEP 1 by itself first, then run STEP 2+ together.
-- ============================================================

-- ── STEP 1 — extend the ro_line_type enum (RUN THIS ALONE FIRST) ─
alter type public.ro_line_type add value if not exists 'package';

-- ============================================================
-- ── STEP 2 — tables, columns, switch (run together after STEP 1) ─
-- ============================================================

-- 2a. package_units — the shop-set list the RO dropdown reads.
create table if not exists public.package_units (
  id uuid primary key default gen_random_uuid(),

  unit_code       text    not null,          -- the label shown in the dropdown, e.g. "6L80"
  set_price       numeric not null default 0, -- CUSTOMER set price (qty 1)
  default_rr_hours numeric,                    -- TECH-PAY default R&R hours (nullable)
  active          boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_package_units_active on public.package_units (active);

-- keep updated_at honest (reuses the shared helper)
create or replace function public.crisdata_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_package_units_updated_at on public.package_units;
create trigger trg_package_units_updated_at
  before update on public.package_units
  for each row execute function public.crisdata_set_updated_at();

-- 2b. RLS — anon full access (app-level auth, mirrors every CrisData table).
alter table public.package_units enable row level security;
drop policy if exists "Allow anon full access to package_units" on public.package_units;
create policy "Allow anon full access to package_units"
  on public.package_units for all to anon using (true) with check (true);

-- 2c. REALTIME — SQL-Editor tables aren't auto-added to the publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'package_units'
  ) then
    alter publication supabase_realtime add table public.package_units;
  end if;
end $$;

-- 2d. ro_line_items — the per-line package fields.
--   • package_unit_id: which unit was chosen (nullable; set null if the unit is
--     later deleted — the line keeps its stored description/price/hours).
--   • rr_hours: the effective TECH-PAY R&R hours for THIS job (resolve-and-store
--     from the unit's default, editable; NEVER enters the price math).
alter table public.ro_line_items
  add column if not exists package_unit_id uuid references public.package_units(id) on delete set null;
alter table public.ro_line_items
  add column if not exists rr_hours numeric;

-- 2e. shop_settings — the owner master switch (default OFF, fail-safe).
alter table public.shop_settings
  add column if not exists feature_packages boolean not null default false;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) enum gained 'package':
--   select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
--    where t.typname='ro_line_type' order by e.enumsortorder;
--   -- expect: labor, parts, fee, shop_supply, hazmat, package
--
-- (b) package_units exists + is EMPTY, with RLS + realtime:
--   select count(*) from public.package_units;   -- expect 0
--   select policyname from pg_policies where tablename='package_units';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='package_units';
--
-- (c) ro_line_items gained the two columns:
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='ro_line_items'
--      and column_name in ('package_unit_id','rr_hours') order by column_name;
--   -- expect: package_unit_id(uuid) | rr_hours(numeric)
--
-- (d) shop_settings gained the switch (default false):
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_packages';
--   -- expect: feature_packages | boolean | false
--   select id, feature_packages from public.shop_settings;   -- expect one row, false
-- ============================================================
