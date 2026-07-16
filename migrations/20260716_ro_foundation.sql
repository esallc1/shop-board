-- ============================================================
-- CrisData RO/Invoice System — Phase 1: FOUNDATION SCHEMA.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- This migration is DATA-MODEL ONLY. It creates NEW tables that will
-- eventually back CrisData's own RO/Invoice system (replacing
-- ALLDATA's document side). NO UI, NO app code, NO live integrations
-- are wired this round — Phase 2 (the RO builder in the New Vehicle
-- Intake tab) reads/writes these tables.
--
-- "Separate but converging": every customer-facing / money table keys
-- on `po` — the SAME text identifier already used by
-- shopboard_lifts/parking/pickup, completed_jobs, invoice_queue,
-- parts_orders, and core_charges — so everything already on the board
-- plugs straight in. repair_orders MINTS that number (ro_number, a
-- 4-digit sequence starting at 6000) and `po` mirrors it.
--
-- GUARDRAILS honored here:
--   * NEW tables only. This file does NOT touch or alter any existing
--     live table (shopboard_*, parking, pickup, parts_orders,
--     core_charges, invoice_queue, completed_jobs, employees,
--     board_backgrounds, dashboard_preferences, todos, chat_messages).
--   * anon-full-access RLS, matching parts_orders / core_charges — this
--     app has no Supabase Auth; role scoping is app-level (PIN login).
--   * every new table is registered with the supabase_realtime
--     publication (SQL-Editor-created tables are NOT auto-registered —
--     see 20260715_todos_realtime.sql for why this matters).
--   * a PRIVATE storage bucket ('crisdata-attachments') with signed-URL
--     access, following the invoice-images bucket pattern.
--
-- This file is IDEMPOTENT: safe to paste and re-run. Enums, tables,
-- indexes, policies, the storage bucket, and the realtime registration
-- are all guarded. (Prior lesson: never assume a migration was applied
-- — a verification script ships alongside this one:
-- 20260716_ro_foundation_VERIFY.sql. Run it after applying.)
--
-- ro_number starts at 6000: ALLDATA is at ~5498 and keeps running in
-- parallel, so CrisData deliberately mints from a higher, non-colliding
-- band. The first RO created will be 6000.
-- ============================================================


-- ============================================================
-- ENUM TYPES  (locked design — created idempotently)
-- ============================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'delivery_preference') then
    create type public.delivery_preference as enum ('print', 'email', 'both');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'drive_type') then
    create type public.drive_type as enum ('FWD', 'RWD', 'AWD', '4WD');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ro_status') then
    create type public.ro_status as enum ('estimate', 'ro', 'invoice');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ro_line_type') then
    create type public.ro_line_type as enum ('labor', 'parts', 'fee', 'shop_supply', 'hazmat');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'attachment_entity_type') then
    create type public.attachment_entity_type as enum ('customer', 'vehicle', 'repair_order');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'attachment_kind') then
    create type public.attachment_kind as enum ('id_photo', 'walkaround', 'tax_cert');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'interaction_kind') then
    create type public.interaction_kind as enum ('call', 'text');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'interaction_direction') then
    create type public.interaction_direction as enum ('inbound', 'outbound');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'authorization_method') then
    create type public.authorization_method as enum ('verbal', 'text', 'in_person');
  end if;
end $$;


-- ============================================================
-- SHARED: updated_at trigger function.
-- The existing app maintains timestamps app-side, but these
-- foundation tables carry a real updated_at, so a DB-level trigger
-- keeps it honest without relying on every future writer to
-- remember. Schema-only (no app dependency); created idempotently.
-- ============================================================

create or replace function public.crisdata_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================
-- 1. customers
-- Finally backs the Customer Log tab (demo-only today).
-- Pay-and-take business — NO accounts-receivable / terms / aging.
-- ============================================================

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  business_name text,                       -- nullable

  tax_exempt boolean not null default false,
  tax_exempt_cert_expires date,             -- nullable

  phone_primary text,
  phone_secondary text,                     -- nullable
  email text,

  -- mailing address
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text default 'USA',

  lead_source text,                         -- nullable, system-only

  delivery_preference public.delivery_preference not null default 'print',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customers_phone_primary on public.customers (phone_primary);
create index if not exists idx_customers_name on public.customers (name);
create index if not exists idx_customers_email on public.customers (email);

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at
  before update on public.customers
  for each row execute function public.crisdata_set_updated_at();


-- ============================================================
-- 2. vehicles
-- ============================================================

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),

  customer_id uuid not null references public.customers(id) on delete cascade,

  plate text,
  plate_state text,
  vin text,
  year integer,
  make text,
  model text,
  engine text,
  transmission_code text,                   -- hand-confirmed
  drive_type public.drive_type,
  unit_number text,                         -- nullable (fleet unit #)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vehicles_customer_id on public.vehicles (customer_id);
create index if not exists idx_vehicles_plate on public.vehicles (plate);
create index if not exists idx_vehicles_vin on public.vehicles (vin);

drop trigger if exists trg_vehicles_updated_at on public.vehicles;
create trigger trg_vehicles_updated_at
  before update on public.vehicles
  for each row execute function public.crisdata_set_updated_at();


-- ============================================================
-- 3. repair_orders  — the spine; mints the number the board keys on.
--
-- ro_number: 4-digit sequential IDENTITY starting at 6000 (see header).
-- po: a STORED generated mirror of ro_number, so the shared text
--     identifier the rest of the app already keys on is always exactly
--     equal to the RO number and can never drift. (Generated columns may
--     reference an identity column — the identity default is resolved
--     before the generated expression.)
-- parent_ro_id: self-FK, nullable — set = this RO is a comeback /
--     warranty return linked to that parent.
-- status: lifecycle column only (estimate -> ro -> invoice); the actual
--     lifecycle logic is Phase 4.
-- ============================================================

create table if not exists public.repair_orders (
  id uuid primary key default gen_random_uuid(),

  ro_number integer generated always as identity (start with 6000) unique,
  po text generated always as (ro_number::text) stored,

  customer_id uuid not null references public.customers(id) on delete restrict,
  vehicle_id  uuid not null references public.vehicles(id)  on delete restrict,

  parent_ro_id uuid references public.repair_orders(id) on delete set null,

  complaint text,
  odometer_in integer,                      -- per-visit odometer

  status public.ro_status not null default 'estimate',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_repair_orders_ro_number on public.repair_orders (ro_number);
create index if not exists idx_repair_orders_po on public.repair_orders (po);
create index if not exists idx_repair_orders_customer_id on public.repair_orders (customer_id);
create index if not exists idx_repair_orders_vehicle_id on public.repair_orders (vehicle_id);
create index if not exists idx_repair_orders_parent_ro_id on public.repair_orders (parent_ro_id);

drop trigger if exists trg_repair_orders_updated_at on public.repair_orders;
create trigger trg_repair_orders_updated_at
  before update on public.repair_orders
  for each row execute function public.crisdata_set_updated_at();


-- ============================================================
-- 4. ro_line_items  — billing lines.
-- SEPARATE from parts_orders (that table is parts ordering/tracking;
-- these are the money lines on the RO/invoice). Same po via the
-- repair_order FK, different job.
-- ============================================================

create table if not exists public.ro_line_items (
  id uuid primary key default gen_random_uuid(),

  repair_order_id uuid not null references public.repair_orders(id) on delete cascade,

  line_type public.ro_line_type not null,
  description text,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(10,2) not null default 0,
  taxable boolean not null default true,
  sort_order integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ro_line_items_repair_order_id on public.ro_line_items (repair_order_id);

drop trigger if exists trg_ro_line_items_updated_at on public.ro_line_items;
create trigger trg_ro_line_items_updated_at
  before update on public.ro_line_items
  for each row execute function public.crisdata_set_updated_at();


-- ============================================================
-- 5. labor_codes  — library.
-- ============================================================

create table if not exists public.labor_codes (
  id uuid primary key default gen_random_uuid(),

  code text not null unique,                -- e.g. LAB1, DIAG
  description text,
  default_rate numeric(10,2),

  created_at timestamptz not null default now()
);

create index if not exists idx_labor_codes_code on public.labor_codes (code);


-- ============================================================
-- 6. symptom_presets  — library.
-- ============================================================

create table if not exists public.symptom_presets (
  id uuid primary key default gen_random_uuid(),

  label text not null,
  preset_text text,

  created_at timestamptz not null default now()
);


-- ============================================================
-- 7. attachments  — ONE shared file table for the whole system.
-- Polymorphic parent (entity_type + entity_id): id_photo -> vehicle,
-- walkaround -> repair_order, tax_cert -> customer. entity_id is a
-- bare uuid (NOT a FK) because it points at three different tables;
-- integrity of the pairing is enforced app-side.
-- file_path is a Supabase Storage object path in the private
-- 'crisdata-attachments' bucket — display via createSignedUrl() at
-- read time, NOT a baked public URL.
-- ============================================================

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),

  entity_type public.attachment_entity_type not null,
  entity_id uuid not null,
  kind public.attachment_kind not null,
  file_path text not null,

  created_at timestamptz not null default now()
);

create index if not exists idx_attachments_entity on public.attachments (entity_type, entity_id);


-- ============================================================
-- 8. interactions  — comms. Provider-NEUTRAL bones; nothing wired yet.
-- ============================================================

create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(),

  customer_id uuid not null references public.customers(id) on delete cascade,
  repair_order_id uuid references public.repair_orders(id) on delete set null,  -- nullable

  kind public.interaction_kind not null,
  direction public.interaction_direction not null,
  occurred_at timestamptz,
  from_number text,
  to_number text,
  body text,                                -- nullable
  recording_url text,                       -- nullable

  provider text,                            -- e.g. 'ctm'
  provider_ref_id text,

  created_at timestamptz not null default now()
);

create index if not exists idx_interactions_customer_id on public.interactions (customer_id);
create index if not exists idx_interactions_repair_order_id on public.interactions (repair_order_id);
create index if not exists idx_interactions_occurred_at on public.interactions (occurred_at desc);


-- ============================================================
-- 9. authorizations  — customer authorization, first-class on the RO.
-- Many rows per RO: initial + one per supplemental finding.
-- interaction_id is the proof (nullable — an in-person auth may have
-- no linked call/text).
-- ============================================================

create table if not exists public.authorizations (
  id uuid primary key default gen_random_uuid(),

  repair_order_id uuid not null references public.repair_orders(id) on delete cascade,
  interaction_id uuid references public.interactions(id) on delete set null,  -- nullable proof

  method public.authorization_method not null,
  scope_note text,                          -- what was authorized
  authorized_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists idx_authorizations_repair_order_id on public.authorizations (repair_order_id);
create index if not exists idx_authorizations_interaction_id on public.authorizations (interaction_id);


-- ============================================================
-- RLS — anon-full-access on every new table.
-- Matches parts_orders / core_charges / invoice_queue: this app has no
-- Supabase Auth session anywhere; access control is app-level (PIN
-- login), not DB-level. Policies dropped-then-created for idempotency.
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array[
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Allow anon full access to %s" on public.%I', t, t);
    execute format(
      'create policy "Allow anon full access to %s" on public.%I for all to anon using (true) with check (true)',
      t, t
    );
  end loop;
end $$;


-- ============================================================
-- REALTIME — register every new table with supabase_realtime.
-- SQL-Editor-created tables are NOT auto-added to the publication
-- (see 20260715_todos_realtime.sql). Guarded so re-runs don't error
-- with "relation is already member of publication".
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array[
    'customers','vehicles','repair_orders','ro_line_items',
    'labor_codes','symptom_presets','attachments','interactions','authorizations'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ============================================================
-- STORAGE — private 'crisdata-attachments' bucket.
-- Follows the invoice-images pattern: NOT public (id photos, tax
-- certs, and walkaround shots can carry PII), access via short-lived
-- signed URLs (createSignedUrl), not getPublicUrl.
--
-- Honest caveat (same as invoice-images): with no real Supabase Auth,
-- "private" means "not globally guessable via a permanent public URL"
-- — it is NOT per-role access control. Anyone holding the anon key
-- (already embedded in every board's page source) can still call
-- createSignedUrl for a known path. A real step up from a public
-- bucket, not a complete fix — a conscious tradeoff.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('crisdata-attachments', 'crisdata-attachments', false)
on conflict (id) do nothing;

drop policy if exists "Allow anon insert to crisdata-attachments" on storage.objects;
create policy "Allow anon insert to crisdata-attachments"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'crisdata-attachments');

drop policy if exists "Allow anon read crisdata-attachments" on storage.objects;
create policy "Allow anon read crisdata-attachments"
  on storage.objects for select
  to anon
  using (bucket_id = 'crisdata-attachments');
