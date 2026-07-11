-- ============================================================
-- Shop Board: completed_jobs table
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Permanent archive for cars picked up from shopboard_pickup.
-- Becomes the searchable RO/invoice history (customer, phone, PO,
-- vehicle). Line items / payments are explicitly out of scope this
-- round — labor_subtotal..payment_status are reserved placeholders.
-- ============================================================

create table public.completed_jobs (
  id uuid primary key default gen_random_uuid(),

  -- provenance / audit trail back to the live board
  source_table text not null,        -- 'shopboard_lifts' | 'shopboard_parking' | 'shopboard_pickup'
  source_id text not null,           -- original row's id (int or uuid), stored as text

  -- job identity / searchable fields
  po text,
  vehicle text,
  customer text,
  customer_phone text,               -- reserved; no source column populates this yet
  work text,
  notes text,
  tech_notes text,
  job_category text,
  assigned_tech text,
  tech_status text,
  warranty boolean default false,
  job_order integer,
  arrival_date date,
  status text,

  -- lifecycle timestamps
  created_at timestamptz,
  diagnosing_at timestamptz,
  waiting_at timestamptz,
  approved_at timestamptz,
  tech_started_at timestamptz,
  tech_finished_at timestamptz,
  comeback_flagged_at timestamptz,
  flag_hours numeric,

  -- archive event
  picked_up_at timestamptz not null default now(),

  -- reserved for future line-item/payment work — out of scope this round
  labor_subtotal numeric default 0,
  parts_subtotal numeric default 0,
  tax numeric default 0,
  total_amount numeric default 0,
  amount_paid numeric default 0,
  balance_due numeric default 0,
  payment_status text default 'unbilled'
);

create index idx_completed_jobs_customer on public.completed_jobs (customer);
create index idx_completed_jobs_po on public.completed_jobs (po);
create index idx_completed_jobs_vehicle on public.completed_jobs (vehicle);
create index idx_completed_jobs_picked_up_at on public.completed_jobs (picked_up_at desc);

-- RLS: this app never uses Supabase Auth (no supabase.auth.signIn calls
-- anywhere) — every page connects with the anon/publishable key and all
-- access control is app-level (employee PIN login), matching how
-- shopboard_lifts/parking/pickup already work. Mirroring that here.
alter table public.completed_jobs enable row level security;

create policy "Allow anon full access to completed_jobs"
  on public.completed_jobs
  for all
  to anon
  using (true)
  with check (true);
