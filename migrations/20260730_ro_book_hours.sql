-- ============================================================
-- CrisData — BOOK HOURS capture (flat-rate groundwork).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHY: moving techs to flat rate needs a real per-job BOOK-HOURS number in
-- the data. Today flag_hours is filled on ~1 job in 70, and flat-priced
-- rebuilds carry a labor line of qty 1 (a price, not hours), so the ALLDATA
-- hours the advisor looks up are never persisted. See
-- docs/wiring/flat-rate-hours.md §2 and §8.
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
-- ADDITIVE + idempotent (ADD COLUMN / CREATE TABLE IF NOT EXISTS): safe to
-- paste / re-run. The app ships with pre-migration fallbacks (writes to the
-- missing columns degrade quietly; the rebuild table simply reads empty), so
-- the RO Board keeps working in the window before this is applied.
-- ============================================================

-- ── 1. repair_orders — the pay-only book-hours fields ────────
alter table public.repair_orders
  add column if not exists book_hours     numeric;                 -- nullable; NULL+na=false = not captured
alter table public.repair_orders
  add column if not exists book_hours_na  boolean not null default false;  -- true = explicit N/A (no labor)
alter table public.repair_orders
  add column if not exists rebuild_type   text;                    -- the chosen rebuild key (see table below); null = not a rebuild

-- ── 2. rebuild_book_hours — the shop-set standard-hours lookup ─
-- One row per rebuild the shop quotes flat, keyed on the transmission code
-- the shop already uses in labor descriptions (e.g. "6L80", "68RFE", "AW4").
-- The RO builder RESOLVE-AND-STORES a row's book_hours ONTO the job
-- (repair_orders.book_hours) at capture time — it is a DEFAULT, never a live
-- lookup at read/report time, so editing this table never rewrites history.
-- Ships EMPTY on purpose — Cris seeds the real values later from the price list.
create table if not exists public.rebuild_book_hours (
  id uuid primary key default gen_random_uuid(),

  transmission_code text not null unique,   -- the lookup key (matches labor-description code)
  label             text,                   -- optional friendly name, e.g. "GM 6L80 R&R w/ overhaul"
  book_hours        numeric not null,       -- the standard flagged book hours for this rebuild
  active            boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_rebuild_book_hours_active
  on public.rebuild_book_hours (active);

-- keep updated_at honest (reuses the Phase-1 helper; re-declared self-contained)
create or replace function public.crisdata_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_rebuild_book_hours_updated_at on public.rebuild_book_hours;
create trigger trg_rebuild_book_hours_updated_at
  before update on public.rebuild_book_hours
  for each row execute function public.crisdata_set_updated_at();

-- ── 3. RLS — anon full access (app-level auth, mirrors every CrisData table) ─
alter table public.rebuild_book_hours enable row level security;
drop policy if exists "Allow anon full access to rebuild_book_hours" on public.rebuild_book_hours;
create policy "Allow anon full access to rebuild_book_hours"
  on public.rebuild_book_hours for all to anon using (true) with check (true);

-- ── 4. REALTIME — SQL-Editor tables aren't auto-added to the publication ─
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'rebuild_book_hours'
  ) then
    alter publication supabase_realtime add table public.rebuild_book_hours;
  end if;
end $$;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) repair_orders gained the three columns:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name in ('book_hours','book_hours_na','rebuild_type')
--    order by column_name;
--   -- expect: book_hours(numeric,YES) | book_hours_na(boolean,NO) | rebuild_type(text,YES)
--
-- (b) the lookup table exists and is EMPTY:
--   select count(*) from public.rebuild_book_hours;   -- expect 0
--
-- (c) RLS policy + realtime registration:
--   select policyname from pg_policies
--    where schemaname='public' and tablename='rebuild_book_hours';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='rebuild_book_hours';
-- ============================================================
