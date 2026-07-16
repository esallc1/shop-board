-- ============================================================
-- Bookkeeping board — multiple POs per invoice + editable expense
-- categories + editable invoice types. Run in the Supabase SQL
-- Editor (project hygemiszxwmyrkmhbjub). ADDITIVE ONLY — does NOT
-- touch invoice_queue, core_charges, or the existing single-PO /
-- Shop Expense / Repair Invoice / Cores / History flows.
--
-- Idempotent (create table if not exists + guarded seeds/realtime).
-- The app has fallbacks (hardcoded category/type lists) so nothing
-- breaks before this is applied.
-- ============================================================


-- ═══ FEATURE 1 — invoice_po_lines: itemized PO breakdown for a
-- Parts/Vendor invoice that covers multiple jobs (the FL Torque case).
-- Same shape / RLS / realtime as core_charges. Single-PO invoices keep
-- invoice_queue.po and never write here. Each line ties an amount to
-- its own PO (the cost-per-job link). ═══
create table if not exists public.invoice_po_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_queue_id uuid references public.invoice_queue(id) on delete cascade,
  po text,
  label text,                          -- part / converter name for this line
  amount numeric(10,2),
  created_at timestamptz not null default now()
);

create index if not exists idx_invoice_po_lines_invoice on public.invoice_po_lines (invoice_queue_id);
create index if not exists idx_invoice_po_lines_po on public.invoice_po_lines (po);


-- ═══ FEATURE 2 — expense_categories: editable Shop Expense category
-- list (was hardcoded). ═══
create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Seed the existing six, preserving their order. ON CONFLICT so re-runs
-- (or an already-populated table) are safe.
insert into public.expense_categories (name, sort_order) values
  ('Rent', 1), ('Utilities', 2), ('Tools/Equipment', 3),
  ('Office Supplies', 4), ('Insurance', 5), ('Other', 6)
on conflict (name) do nothing;


-- ═══ FEATURE 3 — invoice_types: editable invoice type list + behavior.
-- `key` is the value stored in invoice_queue.invoice_type. counts_as
-- drives the Overview spend math (cost adds, credit subtracts,
-- record_only is ignored). System types are protected (can't delete). ═══
create table if not exists public.invoice_types (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,            -- stored in invoice_queue.invoice_type
  name text not null,                  -- display label
  counts_as text not null default 'cost'
    check (counts_as in ('cost', 'credit', 'record_only')),
  is_system boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Seed the three existing types PRESERVING behavior:
--   parts_vendor  = cost        (adds to spend)
--   shop_expense  = cost        (adds to spend)
--   repair_invoice= record_only (revenue archival — already excluded)
insert into public.invoice_types (key, name, counts_as, is_system, sort_order) values
  ('parts_vendor',  'Parts / Vendor Invoice',      'cost',        true, 1),
  ('shop_expense',  'General Shop Expense',        'cost',        true, 2),
  ('repair_invoice','Repair Invoice / Job Record', 'record_only', true, 3)
on conflict (key) do nothing;


-- ═══ RLS — anon-full-access on all three, matching core_charges /
-- parts_orders (no Supabase Auth; access is app-level). ═══
do $$
declare t text;
begin
  foreach t in array array['invoice_po_lines','expense_categories','invoice_types'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Allow anon full access to %s" on public.%I', t, t);
    execute format(
      'create policy "Allow anon full access to %s" on public.%I for all to anon using (true) with check (true)',
      t, t);
  end loop;
end $$;


-- ═══ REALTIME — register all three (SQL-Editor tables aren't
-- auto-added to the publication). Guarded so re-runs don't error. ═══
do $$
declare t text;
begin
  foreach t in array array['invoice_po_lines','expense_categories','invoice_types'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ============================================================
-- VERIFY (run after applying):
--   select * from public.expense_categories order by sort_order;      -- 6 rows
--   select key, name, counts_as, is_system from public.invoice_types
--     order by sort_order;                                            -- 3 system rows
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='invoice_po_lines';  -- id, invoice_queue_id, po, label, amount, created_at
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime'
--       and tablename in ('invoice_po_lines','expense_categories','invoice_types'); -- 3 rows
-- ============================================================
