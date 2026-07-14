-- ============================================================
-- Advisor Board (Phase 1 of Bookkeeping <-> Advisor linkage):
-- parts_orders table.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Backs advisor-board.html's Parts tab (previously hardcoded demo
-- data). Job/RO link uses `po` as free text, matching the identifier
-- already used everywhere else in this app (shopboard_lifts/parking/
-- pickup, completed_jobs, invoice_queue) — no FK, since a PO's row
-- changes table (and PK type) over its lifecycle and this app has no
-- single durable job table to point at.
--
-- Phase 2 (Bookkeeping <-> Advisor linkage) will read this table by
-- `po` from bookkeeping-board.html's invoice classification screen —
-- no schema change needed for that, just a read.
-- ============================================================

create table public.parts_orders (
  id uuid primary key default gen_random_uuid(),

  -- job/RO link + display (same po convention as the rest of the app)
  po text not null,
  vehicle text,

  -- order details
  part_needed text not null,
  vendor text,
  date_ordered date not null default current_date,
  expected_date date,

  -- receipt state
  received boolean not null default false,
  received_at timestamptz,

  created_at timestamptz not null default now(),
  created_by_name text
);

create index idx_parts_orders_po on public.parts_orders (po);
create index idx_parts_orders_received on public.parts_orders (received);
create index idx_parts_orders_expected_date on public.parts_orders (expected_date);

-- RLS: matches the anon-key, app-level-auth-only pattern used
-- everywhere else in this app (completed_jobs, invoice_queue, etc.) —
-- no Supabase Auth session exists anywhere in CrisData.
alter table public.parts_orders enable row level security;

create policy "Allow anon full access to parts_orders"
  on public.parts_orders
  for all
  to anon
  using (true)
  with check (true);
