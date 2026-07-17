-- ============================================================
-- CrisData Phase 5, Slice 1 — Payments (record-only) on CrisData ROs.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Pay-and-take shop: CrisData RECORDS payments (it's the ledger) — it does
-- NOT process cards. One row per payment against an RO. Running balance =
-- RO total − sum(payments); handles deposits + split payments (multiple
-- rows, multiple methods) with the same mechanism. Recordable at ANY stage.
--
-- This makes the completed_jobs archive's amount_paid / balance_due /
-- payment_status REAL (they exist already from 20260711_completed_jobs.sql —
-- no change needed there).
--
-- ADDITIVE ONLY. Parallel/beta on the CrisData RO tables; does NOT touch the
-- live shop floor (shopboard_*), the Approval Queue, or completed_jobs schema.
-- Idempotent — safe to paste / re-run.
--
-- METHOD is a plain TEXT column, NOT an enum: the app seeds the method list
-- as a constant this slice (cash / card / Koalifi / Snap / check), and Slice 2
-- moves it to an editable Settings list — a text column means that needs no
-- schema change.
-- ============================================================

-- ── ro_payments — one row per payment against an RO ──────────
-- po: convergence key (the shared text identifier every money table keys on),
--     set from the RO at insert. repair_order_id is the hard FK link.
create table if not exists public.ro_payments (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references public.repair_orders(id) on delete cascade,
  po text,
  amount numeric(10,2) not null,
  method text not null,
  paid_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ro_payments_repair_order_id on public.ro_payments (repair_order_id);
create index if not exists idx_ro_payments_po on public.ro_payments (po);

-- ── RLS — anon full access (app-level auth, mirrors every other CrisData
--    table; no Supabase Auth anywhere in this app) ──
alter table public.ro_payments enable row level security;
drop policy if exists "Allow anon full access to ro_payments" on public.ro_payments;
create policy "Allow anon full access to ro_payments"
  on public.ro_payments for all to anon using (true) with check (true);

-- ── REALTIME — SQL-Editor tables aren't auto-added to the publication;
--    guard so re-runs don't error ──
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ro_payments'
  ) then
    alter publication supabase_realtime add table public.ro_payments;
  end if;
end $$;

-- ============================================================
-- VERIFY (run separately, after the migration commits)
-- ============================================================
-- (a) columns:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_payments'
--    order by ordinal_position;
--   -- expect: id | repair_order_id | po | amount | method | paid_at | note | created_at
--
-- (b) RLS policy + realtime registration:
--   select policyname from pg_policies
--    where schemaname='public' and tablename='ro_payments';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='ro_payments';
--
-- (c) completed_jobs already has the billing columns this slice fills
--     (no change needed — just confirming they're there):
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='completed_jobs'
--      and column_name in ('amount_paid','balance_due','payment_status');
--   -- expect 3 rows.
