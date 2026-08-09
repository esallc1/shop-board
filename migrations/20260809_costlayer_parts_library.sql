-- ============================================================
-- CrisData — COST LAYER (Cost & Profit Step 2b): shared parts library +
-- vendor bulk-cost sweep.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT this adds (ADD-ONLY — nothing is renamed, altered, or dropped):
--   1. public.parts_library — reusable interchangeable parts (ATF, cleaner,
--      common hardware) entered ONCE and linked into many unit recipes. Cost is
--      either a flat per-unit cost OR a bulk price ÷ bulk size (drum $1,268 ÷
--      200 qt = $6.34/qt); the per-unit cost is COMPUTED in the app, not stored.
--   2. public.unit_parts.library_part_id — a nullable FK so a recipe line can
--      REFERENCE a library item (stores only the reference + qty; name/vendor/
--      cost read live from the library) instead of typing a standalone part.
--
-- SAFETY (the add-only / mirror-anon check):
--   • parts_library' RLS + policy + realtime MIRROR public.package_units EXACTLY
--     (see 20260807_packages.sql 2b/2c) — anon full access, app-level auth, the
--     same posture every settings list uses. NO broader access.
--   • unit_parts is only EXTENDED (one nullable FK column); its existing columns,
--     the Step-2a recipe rows, package_units, and all ROs are untouched.
--   • Everything is IF NOT EXISTS / additive. Re-running is safe.
--   • FK is ON DELETE SET NULL as a DB backstop; the app additionally BLOCKS
--     deleting a library item that is still used by a recipe line, so a linked
--     line never silently loses its cost.
--   • The app ships pre-migration fallbacks: the Parts catalog reads empty, the
--     "add from library" control hides, and standalone Step-2a recipe lines keep
--     working, until this runs.
-- ============================================================

-- ── 1. parts_library — the shared, reusable parts catalog ───────
create table if not exists public.parts_library (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  part_no     text,
  vendor      text,
  cost_mode   text not null default 'flat',   -- 'flat' (unit_cost) | 'bulk' (bulk_price ÷ bulk_qty)
  unit_cost   numeric,     -- flat mode: $ per unit
  bulk_price  numeric,     -- bulk mode: $ for the whole bulk pack
  bulk_qty    numeric,     -- bulk mode: how many units in the pack
  bulk_unit   text,        -- bulk mode: unit label (qt / ea / …)
  created_at  timestamptz not null default now()
);

create index if not exists idx_parts_library_vendor on public.parts_library (vendor);

-- RLS — anon full access, MIRRORING public.package_units exactly. No broader.
alter table public.parts_library enable row level security;
drop policy if exists "Allow anon full access to parts_library" on public.parts_library;
create policy "Allow anon full access to parts_library"
  on public.parts_library for all to anon using (true) with check (true);

-- REALTIME — mirror package_units (2c).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'parts_library'
  ) then
    alter publication supabase_realtime add table public.parts_library;
  end if;
end $$;

-- ── 2. unit_parts.library_part_id — link a recipe line to a library item ─
-- A unit_parts row is EITHER a standalone typed part (library_part_id null,
-- carries its own name/vendor/unit_cost — Step 2a) OR a linked library line
-- (library_part_id set → name/vendor/cost come from parts_library; the row
-- stores only the reference + qty). ON DELETE SET NULL is a backstop; the app
-- blocks deleting an in-use library item.
alter table public.unit_parts
  add column if not exists library_part_id uuid references public.parts_library(id) on delete set null;

create index if not exists idx_unit_parts_library on public.unit_parts (library_part_id);

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) parts_library exists + EMPTY, anon policy + realtime mirror package_units:
--   select count(*) from public.parts_library;                          -- expect 0
--   select tablename, policyname, cmd, roles, qual, with_check
--     from pg_policies where tablename in ('package_units','parts_library') order by tablename;
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='parts_library';    -- expect one row
--
-- (b) unit_parts gained the nullable FK column:
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='unit_parts' and column_name='library_part_id';
--   -- expect: library_part_id | uuid | YES
--   select conname, confdeltype from pg_constraint
--    where conrelid='public.unit_parts'::regclass and contype='f';       -- SET NULL = 'n'
-- ============================================================
