-- ============================================================
-- Bookkeeping Board — Core charges ("Core Bank").
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- ALREADY APPLIED by Cris — checked in here to document the exact
-- schema the bookkeeping-board.html code is written against.
--
-- Context: many Parts/Vendor invoices include a refundable "core
-- charge" — a deposit the vendor bills for a rebuildable old part
-- (alternator, torque converter, etc.). The shop gets that money
-- back when the old core is returned. These are tracked SEPARATELY
-- from the invoice amount (they never modify it) so nothing gets
-- lost: the Overview tab's "Core Bank" surfaces the outstanding
-- total so Josh/Kevin get reminded to take the cores back.
--
-- One invoice_queue row can carry several core lines, so this is a
-- child table keyed by invoice_queue_id (soft-linked, ON DELETE
-- CASCADE — deleting the invoice removes its cores).
-- ============================================================

create table public.core_charges (
  id uuid primary key default gen_random_uuid(),

  -- parent invoice (Parts/Vendor only) — set at process time.
  invoice_queue_id uuid references public.invoice_queue(id) on delete cascade,

  amount numeric(10,2) not null,     -- the core deposit amount
  label text,                        -- e.g. "reman alternator core"

  -- denormalized from the parent invoice at insert time so the Core
  -- Bank list can render vendor/PO/date without a join, and so the
  -- context survives even if the invoice is later re-filed.
  vendor text,
  po text,
  charged_date date,                 -- = the invoice's invoice_date

  -- return tracking — the whole point of the Core Bank.
  returned boolean not null default false,
  returned_at timestamptz,

  created_at timestamptz not null default now()
);

create index idx_core_charges_invoice on public.core_charges (invoice_queue_id);
create index idx_core_charges_returned on public.core_charges (returned);
create index idx_core_charges_charged_date on public.core_charges (charged_date);

-- RLS: same anon-key pattern as invoice_queue / completed_jobs —
-- no Supabase Auth session exists anywhere in CrisData, access
-- control stays at the app layer (PIN login), not the DB layer.
alter table public.core_charges enable row level security;

create policy "Allow anon full access to core_charges"
  on public.core_charges
  for all
  to anon
  using (true)
  with check (true);

-- Realtime — the Overview tab's Core Bank total/list and alert
-- banner subscribe to this table so Mark Returned / Undo and new
-- core inserts update live across everyone's screens.
alter publication supabase_realtime add table public.core_charges;
