-- ============================================================
-- CrisData — COST LAYER (Cost & Profit Step 2a): per-unit parts recipes +
-- three shop-level standard-cost rates.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT this adds (ADD-ONLY — nothing is renamed, altered, or dropped):
--   1. public.unit_parts — one row per part line in a package unit's rebuild
--      recipe (name, part #, vendor, cost, qty), FK to package_units.
--   2. Three numeric columns on the single shop_settings row — the standard-cost
--      rate placeholders the owner tunes on the Build Sheet → People & rates tab.
--
-- SAFETY (the add-only / mirror-anon check):
--   • unit_parts' RLS + policy + grants MIRROR public.package_units EXACTLY —
--     anon full access, app-level auth, the same posture the app already uses for
--     every settings list. NO broader access than package_units.
--   • Everything is `IF NOT EXISTS` / additive. Re-running is safe. No existing
--     table, column, policy, RO, or package_units field is touched.
--   • The app ships pre-migration fallbacks: the recipe editor reads empty and the
--     rates fall back to their defaults (advisor 2.5% / R&R $0 / rebuilder $0)
--     until this runs, so the boards keep working before it is applied.
-- ============================================================

-- ── 1. unit_parts — per-unit rebuild recipe lines ───────────────
create table if not exists public.unit_parts (
  id               uuid primary key default gen_random_uuid(),
  package_unit_id  uuid not null references public.package_units(id) on delete cascade,
  name             text,
  part_no          text,
  vendor           text,          -- free text for now (shared vendor list is Step 2b)
  unit_cost        numeric,       -- $ per part
  qty              numeric,       -- how many of this part per unit built
  created_at       timestamptz not null default now()
);

create index if not exists idx_unit_parts_unit on public.unit_parts (package_unit_id);

-- RLS — anon full access, MIRRORING public.package_units exactly (see
-- 20260807_packages.sql 2b). App-level auth; no broader access.
alter table public.unit_parts enable row level security;
drop policy if exists "Allow anon full access to unit_parts" on public.unit_parts;
create policy "Allow anon full access to unit_parts"
  on public.unit_parts for all to anon using (true) with check (true);

-- REALTIME — mirror package_units (2c). SQL-Editor tables aren't auto-added to
-- the publication; the app doesn't subscribe today, but keep the mirror faithful.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'unit_parts'
  ) then
    alter publication supabase_realtime add table public.unit_parts;
  end if;
end $$;

-- ── 2. shop_settings — three standard-cost rate placeholders ────
-- Defaults fabricate nothing: advisor % = 2.5 (of sale), R&R rate = $0/hr,
-- rebuilder = $0/unit. The owner tunes them on Build Sheet → People & rates.
-- These are for the Build Sheet's standard-cost estimate ONLY — they are NOT
-- wired to the live Advisor Commission engine.
alter table public.shop_settings
  add column if not exists std_advisor_pct numeric not null default 2.5;   -- % of sale
alter table public.shop_settings
  add column if not exists std_rr_rate     numeric not null default 0;      -- $/flagged hour
alter table public.shop_settings
  add column if not exists rebuilder_cost  numeric not null default 0;      -- $/unit built

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) unit_parts exists + EMPTY, with the mirrored anon policy + realtime:
--   select count(*) from public.unit_parts;                       -- expect 0
--   select policyname, cmd, roles from pg_policies
--    where tablename='unit_parts';                                -- expect the anon "for all" policy
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='unit_parts'; -- expect one row
--   -- confirm it mirrors package_units (same policy shape):
--   select tablename, policyname, cmd, roles, qual, with_check
--     from pg_policies where tablename in ('package_units','unit_parts') order by tablename;
--
-- (b) shop_settings gained the three rate columns with the right defaults:
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name in ('std_advisor_pct','std_rr_rate','rebuilder_cost')
--    order by column_name;
--   -- expect: rebuilder_cost|numeric|0 , std_advisor_pct|numeric|2.5 , std_rr_rate|numeric|0
--   select id, std_advisor_pct, std_rr_rate, rebuilder_cost from public.shop_settings;
-- ============================================================
