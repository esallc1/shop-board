-- ============================================================
-- CrisData — shop_settings: shop-wide RO/money config out of code.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Moves the RO Board's hardcoded tax constant (CD_SHOP_TAX_RATE = 0.07)
-- and other shop/RO config into a single editable row. ADDITIVE — does
-- NOT touch the Phase-1 RO tables, the shop floor, Approval Queue, or
-- parts_orders.
--
-- Single fixed-id row model: one row holds all shop-wide settings, so
-- the app reads/writes a known id. Seeded with tax_rate = 0.07 so
-- behavior is UNCHANGED on day one. The app also falls back to 0.07 in
-- code if this row/table doesn't exist yet, so the RO Board never
-- breaks in the window between deploy and this migration being applied.
--
-- This file is IDEMPOTENT (safe to paste / re-run).
--
-- HELD for later passes (deliberately NOT columns here):
--   * FEES (card processing, shop supplies, hazmat) — flat-vs-% and
--     which fees exist still need to be defined.
--   * tech SELECTOR on the RO — that's a new repair_orders field later.
--     `show_tech_on_ro` below is only the display toggle, stored now.
-- ============================================================

create table if not exists public.shop_settings (
  id uuid primary key default gen_random_uuid(),

  tax_rate numeric(6,4) not null default 0.07,   -- fraction, e.g. 0.07 = 7%
  default_labor_rate numeric(10,2),              -- $/hr; nullable until set
  show_tech_on_ro boolean not null default false,

  -- Fees. card_fee_pct is a PERCENTAGE (fraction of the RO total);
  -- shop_supplies_default and hazmat_default are FLAT dollar amounts
  -- that prefill their line's unit price (advisor can override per RO).
  card_fee_pct numeric(6,4) not null default 0.03,      -- 0.03 = 3%
  shop_supplies_default numeric(10,2) not null default 0,
  hazmat_default numeric(10,2) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent add for the fee columns, so re-running this file on a
-- shop_settings table created by an earlier version of it backfills
-- them (existing seeded row picks up the column defaults).
alter table public.shop_settings add column if not exists card_fee_pct numeric(6,4) not null default 0.03;
alter table public.shop_settings add column if not exists shop_supplies_default numeric(10,2) not null default 0;
alter table public.shop_settings add column if not exists hazmat_default numeric(10,2) not null default 0;

-- keep updated_at honest (reuses the Phase-1 helper; re-declared here so
-- this migration is self-contained and order-independent).
create or replace function public.crisdata_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_shop_settings_updated_at on public.shop_settings;
create trigger trg_shop_settings_updated_at
  before update on public.shop_settings
  for each row execute function public.crisdata_set_updated_at();

-- Seed the single settings row at a fixed id (the app targets this id).
-- tax_rate = 0.07 → day-one behavior matches the old hardcoded constant.
-- Fee columns fall back to their defaults (card 3%, supplies/hazmat $0).
insert into public.shop_settings (id, tax_rate, show_tech_on_ro, card_fee_pct, shop_supplies_default, hazmat_default)
values ('00000000-0000-0000-0000-000000000001', 0.07, false, 0.03, 0, 0)
on conflict (id) do nothing;

-- RLS: same anon-full-access pattern as parts_orders / core_charges —
-- no Supabase Auth anywhere; role scoping (who may EDIT money vs ops)
-- is enforced app-side by which board renders the editable control.
alter table public.shop_settings enable row level security;

drop policy if exists "Allow anon full access to shop_settings" on public.shop_settings;
create policy "Allow anon full access to shop_settings"
  on public.shop_settings
  for all
  to anon
  using (true)
  with check (true);

-- Realtime (optional) — so an Owner/GM tax edit can propagate live.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shop_settings'
  ) then
    alter publication supabase_realtime add table public.shop_settings;
  end if;
end $$;


-- ============================================================
-- VERIFY (run after applying): expect ONE row, tax_rate = 0.0700,
-- card_fee_pct = 0.0300, shop_supplies_default = 0.00, hazmat_default = 0.00.
-- ============================================================
--   select id, tax_rate, default_labor_rate, show_tech_on_ro,
--          card_fee_pct, shop_supplies_default, hazmat_default
--   from public.shop_settings;
