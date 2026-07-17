-- ============================================================
-- CrisData Phase 5, Slice 2 — editable payment methods.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Slice 1 shipped the methods as a seeded {value,label} constant
-- (cash / card / Koalifi / Snap / check), stored as TEXT on each payment.
-- This makes that list editable in Settings (Owner/GM). NO change to the
-- ro_payments table — methods stay text; ro_payments.method just references
-- this list's `value`, and past payments keep their stored text regardless
-- of what happens to a method here.
--
-- DEACTIVATE, don't delete: `active=false` drops a method from the picker
-- for NEW payments but never removes it — past payments still display, and
-- it can be reactivated. (No hard-delete path in the UI.)
--
-- ADDITIVE ONLY. Parallel/beta on the CrisData side; does NOT touch the live
-- shop floor. Idempotent (create if not exists + on-conflict seed).
-- ============================================================

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  value text not null unique,   -- the token stored in ro_payments.method
  label text not null,          -- display label shown in the picker + ledger
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_payment_methods_active on public.payment_methods (active, sort_order);

-- Seed the current 5 as ACTIVE so the cutover from the constant is seamless.
insert into public.payment_methods (value, label, sort_order, active) values
  ('cash',    'Cash',    0, true),
  ('card',    'Card',    1, true),
  ('koalifi', 'Koalifi', 2, true),
  ('snap',    'Snap',    3, true),
  ('check',   'Check',   4, true)
on conflict (value) do nothing;

-- ── RLS — anon full access (app-level auth, mirrors every other CrisData
--    table; no Supabase Auth anywhere in this app) ──
alter table public.payment_methods enable row level security;
drop policy if exists "Allow anon full access to payment_methods" on public.payment_methods;
create policy "Allow anon full access to payment_methods"
  on public.payment_methods for all to anon using (true) with check (true);

-- ── REALTIME — SQL-Editor tables aren't auto-added to the publication;
--    guard so re-runs don't error ──
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'payment_methods'
  ) then
    alter publication supabase_realtime add table public.payment_methods;
  end if;
end $$;

-- ============================================================
-- VERIFY (run separately, after the migration commits)
-- ============================================================
-- (a) columns:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='payment_methods'
--    order by ordinal_position;
--   -- expect: id | value | label | active | sort_order | created_at
--
-- (b) the 5 seeded methods, all active, in order:
--   select value, label, active, sort_order
--     from public.payment_methods order by sort_order;
--   -- expect: cash | card | koalifi | snap | check  (all active=true)
--
-- (c) RLS policy + realtime registration:
--   select policyname from pg_policies
--    where schemaname='public' and tablename='payment_methods';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='payment_methods';
