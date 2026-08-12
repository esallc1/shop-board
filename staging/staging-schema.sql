-- ============================================================================
-- STAGING BOOTSTRAP — FULL SCHEMA (DDL + RLS ONLY, no data)
-- Assembled from /migrations in date order. Data is loaded separately via
-- `pg_dump --data-only` from prod (see docs/wiring/staging-db.md).
-- Run ONCE, by hand, in the SQL editor of the NEW (staging) Supabase project.
-- Wrapped in ONE transaction: any failure rolls it all back, so after fixing the
-- cause (e.g. enabling an extension) you can just re-run the whole file cleanly.
-- NOTE: ALTER TYPE ... ADD VALUE statements from the source migrations are folded
-- into their CREATE TYPE here (they cannot run inside a transaction).
-- ============================================================================
begin;
set local client_min_messages = warning;

-- Columns the excluded ALLDATA import migration added to `customers` (re-added so
-- the schema matches prod, WITHOUT importing the ALLDATA data):
alter table public.customers add column if not exists alldata_code  text;
alter table public.customers add column if not exists source        text;
alter table public.customers add column if not exists last_invoiced date;
create unique index if not exists uq_customers_alldata_code on public.customers(alldata_code);


-- ===== 20260711_completed_jobs.sql =====
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


-- ===== 20260711_dashboard_preferences.sql =====
-- ============================================================
-- GM Board: dashboard_preferences table
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Per-employee customizable Overview dashboard layout: which stat
-- cards are visible and in what order. One row per employee; the
-- whole layout is written in one shot on "Save" (Customize mode has
-- no live/incremental autosave).
-- ============================================================

create table public.dashboard_preferences (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  layout jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (employee_id)
);

create index idx_dashboard_preferences_employee on public.dashboard_preferences (employee_id);

-- RLS: matches the anon-key pattern already used for completed_jobs —
-- this app has no Supabase Auth session, only app-level PIN login, so
-- access control stays at the app layer, not the DB layer.
alter table public.dashboard_preferences enable row level security;

create policy "Allow anon full access to dashboard_preferences"
  on public.dashboard_preferences
  for all
  to anon
  using (true)
  with check (true);


-- ===== 20260713_chat_sender_role_check.sql =====
-- ============================================================
-- Fix: chat_messages.sender_role CHECK constraint blocks the
-- Bookkeeping role from sending Team Chat messages.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Reported live: Daiana (role='bookkeeping') tried to send a Team
-- Chat message and got a real Postgres error —
--   "new row for relation \"chat_messages\" violates check
--    constraint \"chat_messages_sender_role_check\""
-- This is a SEPARATE constraint from chat_messages_channel_check
-- (already widened in migrations/20260713_invoice_queue.sql) — that
-- one gates the `channel` column, this one gates `sender_role`, and
-- both were apparently hardcoded to the original four roles
-- (tech/advisor/manager/owner) when this table was created directly
-- in the SQL Editor, before this repo's migrations/ folder existed.
-- ============================================================

-- ── STEP 1 (do this first): confirm exact current constraint defs ──
-- PostgREST + the anon key cannot read pg_constraint/information_schema
-- (confirmed repeatedly — no read-only path exists from the app side),
-- so this can only be checked by running SQL directly. This query lists
-- EVERY check constraint in the public schema in one shot, specifically
-- so we catch any other hardcoded-to-4-roles gap in the same pass
-- instead of hitting them one at a time as they break in production:
--
--   select
--     conrelid::regclass as table_name,
--     conname as constraint_name,
--     pg_get_constraintdef(oid) as definition
--   from pg_constraint
--   where contype = 'c'
--     and connamespace = 'public'::regnamespace
--   order by table_name, constraint_name;
--
-- Compare chat_messages_sender_role_check's actual definition against
-- the assumption below (tech/advisor/manager/owner) before running
-- STEP 2 — if it differs, adjust the value list to match reality
-- rather than what's assumed here.
-- ============================================================

-- ── STEP 2: widen the constraint ──
alter table public.chat_messages drop constraint if exists chat_messages_sender_role_check;

alter table public.chat_messages add constraint chat_messages_sender_role_check
  check (sender_role in (
    'tech',
    'advisor',
    'manager',
    'owner',
    'bookkeeping'
  ));


-- ===== 20260713_invoice_queue.sql =====
-- ============================================================
-- Bookkeeping Board (Phase 1): invoice_queue table + private
-- storage bucket for vendor invoice / shop expense photos.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Workflow this supports:
--   Josh (advisor) snaps a photo of a vendor invoice or shop
--   receipt -> uploaded to a PRIVATE storage bucket + a row lands
--   here with status='unprocessed', no other fields required.
--   Bookkeeping (new role) opens each row, classifies it as either
--   a parts/vendor invoice (linked to a job by PO, searched across
--   the three open board tables + the completed_jobs archive) or a
--   general shop expense (no job link), fills in vendor/amount/
--   category/notes, and confirms -> status='processed'.
--
-- QuickBooks sync is a later phase — quickbooks_bill_id is a
-- reserved placeholder, unused this round (same pattern as
-- completed_jobs' labor_subtotal..payment_status columns).
-- ============================================================

-- ============================================================
-- REQUIRED FIX — found by prototyping the board (then named
-- accounting-board.html, since renamed to bookkeeping-board.html)
-- against the live DB before writing this file:
--
-- chat_messages.channel has a CHECK constraint (chat_messages_
-- channel_check) hard-limiting it to the four channel keys the
-- existing boards use: 'group', 'owner_manager', 'owner_advisor',
-- 'manager_advisor'. Reads on any other value succeed (that's why
-- the queue/tab UI looked fine), but every INSERT with a new
-- channel key was silently rejected with a 23514 constraint
-- violation — confirmed live via a real insert attempt against
-- 'owner_accounting' (pre-rename). Without this fix, nobody can
-- ever send a message on Team Chat's Owner/Manager/Advisor tabs on
-- the new Bookkeeping board — only the shared 'group' tab would work.
-- ============================================================

alter table public.chat_messages drop constraint if exists chat_messages_channel_check;

alter table public.chat_messages add constraint chat_messages_channel_check
  check (channel in (
    'group',
    'owner_manager',
    'owner_advisor',
    'manager_advisor',
    'owner_bookkeeping',
    'manager_bookkeeping',
    'advisor_bookkeeping'
  ));

-- ── BEFORE RUNNING: read-only sanity check ──────────────────
-- We could not verify from the app (anon key + PostgREST has no
-- access to information_schema/pg_constraint) whether employees.role
-- has a CHECK constraint limiting it to the four existing values
-- (tech/advisor/manager/owner). Run this first — if it returns 0
-- rows, role is free text and adding 'bookkeeping' as a value needs
-- no DDL. If it returns a row, the constraint's definition will be
-- in the `consrc`/pg_get_constraintdef output and will need altering
-- before the Bookkeeping role dropdown will actually save.
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.employees'::regclass
--     and contype = 'c';
--
-- ============================================================

create table public.invoice_queue (
  id uuid primary key default gen_random_uuid(),

  -- capture (Josh's side — no fields, just image + upload)
  image_path text not null,          -- storage object path in the
                                      -- private 'invoice-images' bucket,
                                      -- NOT a baked public URL — display
                                      -- via createSignedUrl() at read time
  original_filename text,
  uploaded_by uuid references public.employees(id),
  uploaded_by_name text not null,
  uploaded_at timestamptz not null default now(),

  -- triage state
  status text not null default 'unprocessed',   -- 'unprocessed' | 'processed'

  -- classification (Bookkeeping's side — null until processed)
  invoice_type text,                 -- 'parts_vendor' | 'shop_expense'
  po text,                           -- nullable; only set for parts_vendor
  matched_source_table text,         -- 'shopboard_lifts' | 'shopboard_parking'
                                      -- | 'shopboard_pickup' | 'completed_jobs' | null
                                      -- soft reference only (mirrors
                                      -- completed_jobs.source_table/source_id) —
                                      -- no real FK, since a PO's row changes
                                      -- table (and PK type) over its lifecycle
  matched_source_id text,
  vendor text,
  amount numeric(10,2),
  category text,                     -- free text; only used for shop_expense
  notes text,

  -- disposition
  processed_at timestamptz,
  processed_by uuid references public.employees(id),
  processed_by_name text,

  -- reserved for the later QuickBooks-sync phase — stays null this round
  quickbooks_bill_id text
);

create index idx_invoice_queue_status on public.invoice_queue (status);
create index idx_invoice_queue_po on public.invoice_queue (po);
create index idx_invoice_queue_uploaded_at on public.invoice_queue (uploaded_at desc);

-- RLS: matches the anon-key pattern already used everywhere else in
-- this app (completed_jobs, dashboard_preferences) — no Supabase Auth
-- session exists anywhere in CrisData, only app-level PIN login, so
-- access control stays at the app layer, not the DB layer.
alter table public.invoice_queue enable row level security;

create policy "Allow anon full access to invoice_queue"
  on public.invoice_queue
  for all
  to anon
  using (true)
  with check (true);


-- ============================================================
-- STORAGE: private bucket for invoice/receipt photos.
--
-- Deliberately NOT public (unlike employee-photos): invoice images
-- can show vendor account numbers, banking details printed on
-- checks, etc. Access is via short-lived signed URLs
-- (createSignedUrl), not getPublicUrl.
--
-- Honest caveat: because this app still has no real Supabase Auth,
-- "private" here means "not globally guessable via a permanent
-- public URL" — it does NOT mean per-role access control. Anyone
-- holding the anon key (which is already embedded in every board's
-- page source) can still call createSignedUrl for any known path,
-- same as they can already read/write every other table in this
-- project. This is a real step up from a public bucket, not a
-- complete fix — flagging so it's a conscious tradeoff, not an
-- assumed one.
-- ============================================================


create policy "Allow anon insert to invoice-images"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'invoice-images');

create policy "Allow anon read invoice-images"
  on storage.objects for select
  to anon
  using (bucket_id = 'invoice-images');


-- ===== 20260714_board_backgrounds.sql =====
-- ============================================================
-- Custom board background photo (per-employee).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Lets each employee upload a personal background photo that's
-- applied to the main content area of whichever board they log into
-- (Advisor, Bookkeeping, GM, Owner). One row per employee, same
-- pattern as employees.photo_url (Employee Management avatars) —
-- reusing that table rather than a new preferences table since this
-- is a single scalar value, not a structured layout like
-- dashboard_preferences.layout.
-- ============================================================

alter table public.employees
  add column if not exists background_photo_url text;

-- ── STORAGE: public bucket for background photos.
--
-- Public (like employee-photos, unlike invoice-images): these are
-- personal decorative photos an employee chose to upload, not
-- sensitive documents, so a permanent public URL via getPublicUrl()
-- is fine — no signed-URL indirection needed.
-- ============================================================


create policy "Allow anon insert to board-backgrounds"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'board-backgrounds');

create policy "Allow anon read board-backgrounds"
  on storage.objects for select
  to anon
  using (bucket_id = 'board-backgrounds');


-- ===== 20260714_invoice_queue_date.sql =====
-- ============================================================
-- Bookkeeping Board (Phase 4, revised) — classify/organize/present
-- for manual QuickBooks entry (no QuickBooks API calls this phase —
-- AP-side write access, vendor lookup, and Chart of Accounts aren't
-- available in the connected environment).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Adds the user-entered transaction date, captured at classify time
-- (distinct from uploaded_at, when Josh took the photo, and
-- processed_at, when Daiana confirmed it). Used for the vendor/date
-- storage folder and shown in the History tab.
--
-- Also adds the missing UPDATE policy on the invoice-images bucket.
-- Confirmed live (uploaded a throwaway test object, then called the
-- move endpoint directly): Supabase Storage's move/rename is
-- implemented as an update of the object's path, and the bucket only
-- had insert/select/delete policies (delete added in Phase 3) — no
-- update — so every move Phase 4's classify flow attempts would fail
-- with a false "Object not found" (RLS silently filtering, not
-- actually missing). Without this, storage reorganization (point 1)
-- does not work.
-- ============================================================

alter table public.invoice_queue
  add column if not exists invoice_date date;

create policy "Allow anon update invoice-images"
  on storage.objects for update
  to anon
  using (bucket_id = 'invoice-images')
  with check (bucket_id = 'invoice-images');


-- ===== 20260714_invoice_queue_delete.sql =====
-- ============================================================
-- Bookkeeping Board (Phase 3): delete option for Unprocessed
-- Invoices.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- invoice_queue itself needs NO new policy — it already has
-- "Allow anon full access to invoice_queue" (for all, i.e. SELECT/
-- INSERT/UPDATE/DELETE) from migrations/20260713_invoice_queue.sql.
-- DELETE was already permitted at the DB level; the app simply never
-- called .delete() on it until now.
--
-- The actual gap was storage: the invoice-images bucket only had
-- insert + read policies (deliberately, per that same migration's
-- "no-delete/audit-trail" comment), so a delete call against a
-- storage object would fail. This migration reverses that -- an
-- intentional, confirmed decision -- by adding the missing delete
-- policy.
--
-- Role scoping caveat: this app has no Supabase Auth anywhere (see
-- every prior migration's RLS comments) -- every board connects with
-- the same shared anon key regardless of which employee/role is
-- logged in, so there is no auth.jwt() claim to scope a DB policy to
-- role='bookkeeping' against. Access control for this feature is
-- app-level instead, same as everywhere else in this app: the delete
-- affordance only exists in bookkeeping-board.html's Unprocessed
-- Invoices queue.
-- ============================================================

create policy "Allow anon delete invoice-images"
  on storage.objects for delete
  to anon
  using (bucket_id = 'invoice-images');


-- ===== 20260714_invoice_queue_line_item.sql =====
-- ============================================================
-- Bookkeeping Board — Description + Part Number fields for the
-- invoice auto-detection feature (Parts/Vendor invoices only).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- description: line-item description of what was purchased, as
-- printed on the invoice (e.g. "SPC DW EXTR").
-- part_number: the item/part number, if printed — often a separate
-- value from the PO#.
-- ============================================================

alter table public.invoice_queue
  add column if not exists description text,
  add column if not exists part_number text;


-- ===== 20260714_parts_orders.sql =====
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


-- ===== 20260715_core_charges.sql =====
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


-- ===== 20260715_core_charges_returned_by.sql =====
-- ============================================================
-- Bookkeeping / GM Boards — Core Bank: record WHO returned a core.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Adds returned_by (text): the display name of the logged-in employee
-- who marked a core returned (the same value shown in each board's
-- "Hi, X" greeting). Set alongside returned=true / returned_at=now();
-- cleared back to null on Undo. Nullable, no default — pre-existing
-- returned rows simply show "Returned by someone" until re-marked.
--
-- Both boards read it to render "Returned by {name} • {date}" in their
-- Returned lists (Bookkeeping Overview Core Bank + GM Overview Core
-- Bank card).
-- ============================================================

alter table public.core_charges
  add column if not exists returned_by text;


-- ===== 20260715_todos.sql =====
-- ============================================================
-- To-Do lists (personal + assignable) — Advisor, Bookkeeping, GM,
-- and Owner boards.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- assigned_to is nullable: null means it's a personal to-do (only
-- visible to created_by). Non-null means it's assigned to that
-- employee (visible to them regardless of who created it, and still
-- visible to the creator too, tagged "Assigned to X" on their view).
--
-- Denormalized *_name columns alongside the *_by/*_to FKs follow the
-- same convention as invoice_queue's uploaded_by/uploaded_by_name —
-- avoids a join just to render "Assigned to Kevin" / "Assigned by
-- Cris" tags in the list.
--
-- completed_at is nullable and drives both the checkbox state and
-- the 3-day visibility window (app-side query filter, not deleted —
-- see the board JS's loadAndRenderTodos()).
-- ============================================================

create table public.todos (
  id uuid primary key default gen_random_uuid(),

  text text not null,

  created_by uuid references public.employees(id),
  created_by_name text not null,

  assigned_to uuid references public.employees(id),
  assigned_to_name text,

  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index idx_todos_assigned_to on public.todos (assigned_to);
create index idx_todos_created_by on public.todos (created_by);
create index idx_todos_completed_at on public.todos (completed_at);

-- RLS: matches the anon-key, app-level-auth-only pattern used
-- everywhere else in this app (completed_jobs, invoice_queue,
-- parts_orders, etc.) — no Supabase Auth session exists anywhere in
-- CrisData. Edit/delete permission (creator or assignee only) is
-- enforced app-side, same as everything else in this app.
alter table public.todos enable row level security;

create policy "Allow anon full access to todos"
  on public.todos
  for all
  to anon
  using (true)
  with check (true);


-- ===== 20260715_todos_realtime.sql =====
-- ============================================================
-- Follow-up to migrations/20260715_todos.sql — register the new
-- `todos` table with Supabase's realtime publication.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- Tables created via the SQL Editor (raw CREATE TABLE) are NOT
-- automatically added to the `supabase_realtime` publication — that
-- auto-registration only happens when a table is created through the
-- Table Editor UI's "Enable Realtime" toggle. Without this statement,
-- the `postgres_changes` subscription in each board's To-Do view
-- joins its channel successfully (looks connected) but never
-- receives events, so assigned-to-you items don't show up live —
-- confirmed live during testing: channel state was "joined" but an
-- INSERT from another tab produced zero events until this ran.
-- ============================================================

alter publication supabase_realtime add table public.todos;


-- ===== 20260716_bookkeeping_multiPO_categories_types.sql =====
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


-- ===== 20260716_marketing_content.sql =====
-- ============================================================
-- Marketing Content — "Catch this moment" captures + Cris's
-- consolidated marketing library. Run in the Supabase SQL Editor
-- (project hygemiszxwmyrkmhbjub). ADDITIVE ONLY.
--
-- Storage rule: photos + SHORT capture clips live in Supabase (small);
-- big/polished marketing videos live on YouTube (unlisted) and we store
-- only the LINK (+ thumbnail derived from the id). So a row is either:
--   storage='file'    → file_path in the private marketing-content bucket
--   storage='youtube' → youtube_url (no file)
--
-- Idempotent; the app has fallbacks so nothing breaks pre-migration.
-- ============================================================

create table if not exists public.marketing_content (
  id uuid primary key default gen_random_uuid(),
  media_type text not null check (media_type in ('photo', 'video')),
  storage    text not null check (storage in ('file', 'youtube')),
  file_path   text,          -- set when storage='file' (bucket object path)
  youtube_url text,          -- set when storage='youtube'
  caption     text,
  captured_by text,          -- CHAT_IDENTITY.name (same as core returns)
  captured_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_marketing_content_captured_at on public.marketing_content (captured_at desc);
create index if not exists idx_marketing_content_media_type on public.marketing_content (media_type);

-- RLS: anon-full-access, matching core_charges / invoice_queue (no
-- Supabase Auth; access is app-level).
alter table public.marketing_content enable row level security;
drop policy if exists "Allow anon full access to marketing_content" on public.marketing_content;
create policy "Allow anon full access to marketing_content"
  on public.marketing_content for all to anon using (true) with check (true);

-- Realtime — so "catch this moment" captures appear live in the owner
-- Marketing tab. (SQL-Editor tables aren't auto-added.)
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='marketing_content'
  ) then
    alter publication supabase_realtime add table public.marketing_content;
  end if;
end $$;

-- ============================================================
-- STORAGE: private 'marketing-content' bucket. Objects live under
-- photos/<yyyy-mm>/ and clips/<yyyy-mm>/. Access via short-lived signed
-- URLs (createSignedUrl), same as invoice-images. Anon insert + select +
-- delete (owner deletes a stored item's object before its row).
-- Honest caveat (same as invoice-images): "private" = not globally
-- guessable via a permanent public URL, NOT per-role access control.
-- ============================================================

drop policy if exists "Allow anon insert to marketing-content" on storage.objects;
create policy "Allow anon insert to marketing-content"
  on storage.objects for insert to anon with check (bucket_id = 'marketing-content');

drop policy if exists "Allow anon read marketing-content" on storage.objects;
create policy "Allow anon read marketing-content"
  on storage.objects for select to anon using (bucket_id = 'marketing-content');

drop policy if exists "Allow anon delete marketing-content" on storage.objects;
create policy "Allow anon delete marketing-content"
  on storage.objects for delete to anon using (bucket_id = 'marketing-content');


-- ============================================================
-- VERIFY (run after applying):
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='marketing_content';
--   select id, public from storage.buckets where id='marketing-content';   -- public=false
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='marketing_content'; -- 1 row
-- ============================================================


-- ===== 20260716_phase3_print_fields.sql =====
-- ============================================================
-- CrisData Phase 3 — printable one-page Estimate/RO/Invoice: the
-- additive columns behind it. Run in the Supabase SQL Editor
-- (project hygemiszxwmyrkmhbjub). ADDITIVE ONLY — new columns on
-- existing CrisData tables; does NOT touch the live shop floor,
-- Approval Queue, parts_orders, or completed_jobs.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app has pre-migration fallbacks, so the RO Board and print
-- action keep working in the window before this is applied.
-- ============================================================

-- ── shop_settings: shop-profile fields for the invoice header +
--    legal footer. Owner/GM-only to edit (UI-level, in Settings). ──
alter table public.shop_settings add column if not exists shop_name       text;
alter table public.shop_settings add column if not exists address_line    text;
alter table public.shop_settings add column if not exists city_state_zip  text;
alter table public.shop_settings add column if not exists phone           text;
alter table public.shop_settings add column if not exists email           text;
alter table public.shop_settings add column if not exists website         text;
alter table public.shop_settings add column if not exists logo_url        text;   -- Supabase Storage public URL
alter table public.shop_settings add column if not exists mv_number       text;   -- NOT seeded — Cris enters it in Settings
alter table public.shop_settings add column if not exists legal_terms     text;   -- invoice small-print footer; editable in Settings

-- Seed the known Lee Transmission profile onto the fixed settings row,
-- but ONLY where still null (never clobber a value Cris already set).
-- mv_number is intentionally left out of this seed.
update public.shop_settings set
  shop_name      = coalesce(shop_name,      'Lee Transmission'),
  address_line   = coalesce(address_line,   '5583 Lee St Unit 12'),
  city_state_zip = coalesce(city_state_zip, 'Lehigh Acres, FL 33971'),
  phone          = coalesce(phone,          '239-491-2809'),
  email          = coalesce(email,          'will@leetransmissionauto.com'),
  website        = coalesce(website,         'www.leetransmissionauto.com')
where id = '00000000-0000-0000-0000-000000000001';

-- Seed the invoice LEGAL TERMS (small-print footer). ⚠️ REPLACE the
-- placeholder string below with Lee Transmission's EXACT lien /
-- authorization / warranty paragraph BEFORE running — or leave it and
-- paste the real wording in Settings → Shop Profile → Legal terms after
-- applying. COALESCE means it only fills when still null (never clobbers
-- text Cris already entered). Escape any apostrophes by doubling them.
update public.shop_settings set
  legal_terms = coalesce(legal_terms,
    '[[ PASTE Lee Transmission''s exact lien / authorization / warranty paragraph here — editable in Settings ]]')
where id = '00000000-0000-0000-0000-000000000001';

-- ── repair_orders: per-RO fields the printed invoice needs. ──
alter table public.repair_orders add column if not exists miles_out      integer;  -- odometer out (null until close)
alter table public.repair_orders add column if not exists advisory_notes text;      -- advisories beyond the complaint
alter table public.repair_orders add column if not exists technician     text;      -- assigned tech name (display)

-- ── ro_line_items: part number on parts lines. ──
alter table public.ro_line_items add column if not exists part_number    text;


-- ============================================================
-- VERIFY (run after applying): expect the shop profile populated
-- (shop_name 'Lee Transmission', etc.), mv_number NULL, and the new
-- repair_orders / ro_line_items columns present.
-- ============================================================
--   select shop_name, address_line, city_state_zip, phone, email, website,
--          logo_url, mv_number, legal_terms
--   from public.shop_settings;
--
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='repair_orders'
--     and column_name in ('miles_out','advisory_notes','technician');
--
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='ro_line_items'
--     and column_name = 'part_number';


-- ===== 20260716_ro_foundation.sql =====
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
    create type public.ro_status as enum ('estimate', 'ro', 'invoice', 'closed');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ro_line_type') then
    create type public.ro_line_type as enum ('labor', 'parts', 'fee', 'shop_supply', 'hazmat', 'package');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'attachment_entity_type') then
    create type public.attachment_entity_type as enum ('customer', 'vehicle', 'repair_order');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'attachment_kind') then
    create type public.attachment_kind as enum ('id_photo', 'walkaround', 'tax_cert', 'diagnosis_audio');
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


-- ===== 20260716_shop_settings.sql =====
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


-- ===== 20260717_ro_diagnosis.sql =====
-- ============================================================
-- CrisData Phase 4, Slice 2 — Tech Diagnosis capture: the schema behind
-- the digital replacement for ALLDATA's printed tech sheet. Run in the
-- Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- A tech opens an RO assigned to him (repair_orders.technician, landed in
-- Phase 3), sees complaint + vehicle read-only, and records his diagnosis
-- back ONTO the RO so the advisor builds the estimate without re-keying:
--   * DTCs  -> structured, one row per code (new ro_diagnostic_codes)
--   * Recommendation -> free text on the RO (typed, or a voice transcript)
--   * Submitting PUSHES the RO into the advisor's Approval Queue.
--
-- ADDITIVE ONLY. Parallel/beta on the CrisData RO tables; does NOT touch
-- the live shop floor (shopboard_*), the Approval Queue's ALLDATA-era
-- path, parts_orders, or completed_jobs. Idempotent — safe to re-run.
-- The app has pre-migration fallbacks so nothing breaks in the window
-- before this is applied.
--
-- VOICE (decided — record + attach audio now, transcript deferred): the
-- recommendation TEXT lives here (diagnosis_recommendation, typed for now).
-- The tech can ALSO record audio; the clip attaches via the existing
-- attachments table (entity_type='repair_order', kind='diagnosis_audio')
-- and lives in the crisdata-attachments bucket as the source of truth.
-- Automatic transcription is DEFERRED to a separate Whisper-backend thread
-- (Supabase Edge Function + OpenAI key) — until then the advisor listens to
-- the clip; the codes are structured so nothing needs re-keying.
-- ============================================================

-- ── 0. attachment_kind — add the diagnosis-audio value ───────
-- ⚠️ ALTER TYPE ... ADD VALUE cannot be USED in the same transaction that
-- adds it. Nothing in THIS migration inserts an attachment, so it's safe
-- alongside the DDL below. If the SQL Editor ever errors with "ALTER TYPE
-- ... ADD VALUE cannot run inside a transaction block", run just this one
-- line by itself first, then re-run the rest.

-- ── 1. ro_diagnostic_codes — one row per DTC per RO ──────────
-- Bare codes only (no per-code note). ANY format accepted (P/U/B/C +
-- manufacturer-specific/oddball) — no leading-letter validation. Stored
-- UPPERCASE (app-normalized: p0730 -> P0730) so the future cross-vehicle
-- code-search screen banks clean, matchable data.
create table if not exists public.ro_diagnostic_codes (
  id uuid primary key default gen_random_uuid(),
  repair_order_id uuid not null references public.repair_orders(id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ro_diagnostic_codes_repair_order_id
  on public.ro_diagnostic_codes (repair_order_id);
-- indexed for the later "find this code across all our jobs" search
create index if not exists idx_ro_diagnostic_codes_code
  on public.ro_diagnostic_codes (code);

-- ── 2. repair_orders — recommendation text + handoff timestamps ──
-- diagnosis_recommendation : the tech's recommendation (typed or a voice
--                            transcript); readable/searchable on the RO.
-- diagnosis_submitted_at   : set when the tech pushes the diagnosis ->
--                            this is the "diagnosis ready" signal the
--                            advisor's Approval Queue keys on.
-- diagnosis_reviewed_at    : set when the advisor opens it from the queue
--                            -> drops it off the queue. NULL = still ready.
alter table public.repair_orders add column if not exists diagnosis_recommendation text;
alter table public.repair_orders add column if not exists diagnosis_submitted_at   timestamptz;
alter table public.repair_orders add column if not exists diagnosis_reviewed_at    timestamptz;

-- ── 3. RLS — anon full access (app-level auth, mirrors every other
--    CrisData table; no Supabase Auth anywhere in this app) ──
alter table public.ro_diagnostic_codes enable row level security;
drop policy if exists "Allow anon full access to ro_diagnostic_codes" on public.ro_diagnostic_codes;
create policy "Allow anon full access to ro_diagnostic_codes"
  on public.ro_diagnostic_codes for all to anon using (true) with check (true);

-- ── 4. REALTIME — SQL-Editor tables aren't auto-added to the
--    publication; guard so re-runs don't error ──
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ro_diagnostic_codes'
  ) then
    alter publication supabase_realtime add table public.ro_diagnostic_codes;
  end if;
end $$;

-- ============================================================
-- VERIFY (run separately, after the migration commits)
-- ============================================================
-- (a) new table + columns exist:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_diagnostic_codes'
--    order by ordinal_position;
--   -- expect: id | repair_order_id | code | created_at
--
-- (b) repair_orders gained the three columns:
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name in ('diagnosis_recommendation','diagnosis_submitted_at','diagnosis_reviewed_at')
--    order by column_name;
--   -- expect 3 rows: diagnosis_recommendation(text),
--   --                diagnosis_reviewed_at(timestamptz),
--   --                diagnosis_submitted_at(timestamptz)
--
-- (c) RLS policy + realtime registration:
--   select policyname from pg_policies
--    where schemaname='public' and tablename='ro_diagnostic_codes';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='ro_diagnostic_codes';
--
-- (d) attachment_kind gained 'diagnosis_audio':
--   select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
--    where t.typname='attachment_kind' order by e.enumsortorder;
--   -- expect: id_photo | walkaround | tax_cert | diagnosis_audio


-- ===== 20260717_ro_status_closed.sql =====
-- ============================================================
-- CrisData Phase 4, Slice 1 — RO status lifecycle: add the 4th stage.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- The RO already mints as 'estimate' and the enum today is
-- ('estimate', 'ro', 'invoice'). This slice adds the closing stage so
-- the lifecycle is:
--
--     estimate  ->  ro (Active RO)  ->  invoice  ->  closed
--
-- This is the MONEY/DOCUMENT axis (quote -> job -> paid), NOT the car's
-- physical location on the shop floor — that stays on shopboard_* and is
-- untouched here.
--
-- SCOPE: one enum value. No new columns:
--   * repair_orders.status already exists (Phase 1).
--   * completed_jobs already carries the reserved billing columns
--     (labor_subtotal / parts_subtotal / tax / total_amount / amount_paid
--     / balance_due / payment_status) the Close archive fills — see
--     migrations/20260711_completed_jobs.sql. Nothing to add there.
--
-- ⚠️ POSTGRES CAVEAT — run this file BY ITSELF, as its own statement.
--   `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, and
--   the new value cannot be USED until the statement that adds it has
--   committed. Running just this one line in the SQL Editor auto-commits,
--   so it's fine standalone; do NOT paste it into a larger multi-statement
--   batch that also writes status='closed'.
--
-- Idempotent (ADD VALUE IF NOT EXISTS): safe to paste / re-run. The app
-- has a pre-migration fallback — writing status='closed' before this is
-- applied degrades quietly (warns, no data loss), and the other three
-- stages work today. ADDITIVE ONLY; does not touch the live shop floor.
-- ============================================================

-- ── VERIFY (run separately, after the ALTER commits) ──────────
-- Expect exactly these four labels, in this order:
--     estimate | ro | invoice | closed
--
--   select e.enumlabel
--     from pg_enum e
--     join pg_type t on t.oid = e.enumtypid
--    where t.typname = 'ro_status'
--    order by e.enumsortorder;


-- ===== 20260718_payment_methods.sql =====
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


-- ===== 20260718_ro_arrived_at.sql =====
-- ─────────────────────────────────────────────────────────────────────────
-- RO → Floor convergence, Slice 1: "Check in / Arrived"
--
-- Adds a single additive column that records the PHYSICAL arrival of the car
-- for a CrisData RO. This is history ("this car did arrive"), NOT a live
-- on-floor flag — a car checks in once per RO. It does NOT change the RO
-- stage and does NOT touch the shopboard_* tables (v1 shop floor).
--
-- Run this in the Supabase SQL Editor, then confirm with the verify query
-- below BEFORE any dependent advisor-board.html code ships.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.repair_orders
  add column if not exists arrived_at timestamptz;

comment on column public.repair_orders.arrived_at is
  'Timestamp the car physically arrived / was checked in onto the v1 shop '
  'floor for this RO. Set once at check-in; stays set as history even after '
  'the car is later picked up or cleared on v1. Null = not yet checked in.';

-- ── VERIFY (expect one row: arrived_at | timestamp with time zone | YES) ──
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name   = 'repair_orders'
--    and column_name  = 'arrived_at';


-- ===== 20260718_ro_payments.sql =====
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


-- ===== 20260719_ro_number_legacy_override.sql =====
-- ─────────────────────────────────────────────────────────────────────────
-- TEMPORARY (legacy 5xxx migration): allow an explicit ro_number override.
--
-- WHY: We are draining legacy 5xxx repair orders off the v1 shop floor one
-- car at a time. An advisor needs to create a v2 RO that REUSES a car's
-- existing legacy PO (e.g. 5495) instead of getting the next auto-assigned
-- 6xxx number. `repair_orders.ro_number` is currently
-- `GENERATED ALWAYS AS IDENTITY`, which forbids inserting an explicit value
-- (Postgres error 428C9) — the PostgREST/anon client can't emit
-- `OVERRIDING SYSTEM VALUE`. Flipping it to `GENERATED BY DEFAULT` lets an
-- explicit value be inserted while the default path is UNCHANGED:
--   * omit ro_number  → the identity sequence still assigns the next 6xxx
--   * pass ro_number  → that value is used, and the sequence is NOT advanced
-- Every legacy value is < 6000 (the sequence's floor), so there is no
-- collision risk with future auto-assigned 6xxx numbers.
--
-- REMOVE AFTER MIGRATION: once all 5xxx cars are off the floor and the
-- override UI is deleted from advisor-board.html, you MAY flip this back to
-- `GENERATED ALWAYS` for extra safety:
--   alter table public.repair_orders
--     alter column ro_number set generated always;
-- (Leaving it BY DEFAULT is also harmless — the intake never sets ro_number
-- once the override markup is gone.)
--
-- Run this in the Supabase SQL Editor BEFORE the override UI is used.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.repair_orders
  alter column ro_number set generated by default;

-- ── VERIFY (expect: is_identity = YES, identity_generation = BY DEFAULT) ──
-- select column_name, is_identity, identity_generation
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name   = 'repair_orders'
--    and column_name  = 'ro_number';


-- ===== 20260720_chat_attachments.sql =====
-- ============================================================
-- Team Chat — Slice 4a: message attachments (photo, then file/voice).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file (not the whole 20260720 batch — same lesson as 3a).
--
-- DATA MODEL DECISION (Cris): one attachment per message, pointer lives ON
-- the chat_messages row (NOT the shared `attachments` table). Storage reuses
-- the existing private `crisdata-attachments` bucket (bucket-wide anon
-- insert/select policies from 20260716_ro_foundation.sql — no new storage
-- policy needed), read via short-lived createSignedUrl at render time.
--
-- All three kinds ('photo','file','voice') are allowed NOW so the 4b (file)
-- and 4c (voice) slices need no further migration — they reuse these columns.
-- Every column is nullable: a plain text message leaves them all null; an
-- attachment can ride with an optional caption (message) OR stand alone.
--
-- Idempotent: add-column-if-not-exists + drop-then-add the CHECK constraint.
-- ============================================================

alter table public.chat_messages add column if not exists attachment_path text;  -- path inside crisdata-attachments
alter table public.chat_messages add column if not exists attachment_kind text;  -- 'photo' | 'file' | 'voice'
alter table public.chat_messages add column if not exists attachment_name text;  -- original filename (file/download display)
alter table public.chat_messages add column if not exists attachment_mime text;  -- content type

-- Constrain the kind (null = a plain text message). Drop-then-add = idempotent.
alter table public.chat_messages drop constraint if exists chat_messages_attachment_kind_check;
alter table public.chat_messages add constraint chat_messages_attachment_kind_check
  check (attachment_kind is null or attachment_kind in ('photo', 'file', 'voice'));

-- An attachment-only message has no text — make sure `message` is nullable.
-- (Safe/no-op if it already is.)
alter table public.chat_messages alter column message drop not null;


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The four columns exist, all nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='chat_messages'
--   and column_name in ('attachment_path','attachment_kind','attachment_name','attachment_mime')
-- order by column_name;   -- ⇒ 4 rows, is_nullable = YES

-- V2. The kind CHECK is present and allows only photo/file/voice (or null).
-- select conname, pg_get_constraintdef(oid) as def
-- from pg_constraint
-- where conrelid='public.chat_messages'::regclass and conname='chat_messages_attachment_kind_check';

-- V3. message is nullable (attachment-only rows are legal).
-- select is_nullable from information_schema.columns
-- where table_schema='public' and table_name='chat_messages' and column_name='message';  -- ⇒ YES


-- ===== 20260720_chat_conversations.sql =====
-- ============================================================
-- Team Chat — Slice 3a: conversations data model (SCHEMA + BACKFILL).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- WHY: today the boards address chat by hardcoded role-pair strings
-- (owner_manager, manager_bookkeeping, …) baked into each board's
-- config.channels list, plus a fixed 'group'. That is a static
-- allow-list — it can't express real DMs or groups. This slice
-- introduces a proper conversations model (the Slack/WhatsApp shape):
--   chat_conversations  — one row per DM or group
--   chat_members        — who is in each conversation
--   chat_messages.conversation_id / chat_reads.conversation_id
--
-- ADDITIVE + SAFE TO DEPLOY FIRST. Nothing reads conversation_id yet —
-- shared/team-chat.js, the boards, and api/send-push.js are untouched
-- (those are Slices 3b–3d). Old rows keep their `channel` string for
-- audit; this migration only ADDS structure and backfills it.
--
-- IDENTITY CHOICE (deliberate): members are keyed on member_name
-- (+ cached member_role), matching the existing chat_reads(reader_name)
-- convention and the { role, name } identity the chat module already
-- passes. There is no employee id in CHAT_IDENTITY, so name is the
-- stable key — this avoids threading employee ids through every board.
-- All four office names are distinct today; id-keying is a later
-- migration if ever needed.
-- ============================================================

-- pgcrypto for gen_random_uuid()
create extension if not exists pgcrypto;

-- SHARED updated_at trigger fn — already created by 20260716_ro_foundation.sql,
-- re-asserted here so this file stands alone.
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
-- 1. chat_conversations
-- ============================================================
create table if not exists public.chat_conversations (
  id              uuid        primary key default gen_random_uuid(),
  type            text        not null check (type in ('dm','group')),
  title           text,                 -- groups only; null for dm
  dm_key          text        unique,   -- dm only: the two member names,
                                        -- lowercased, sorted, joined '|'
                                        -- (find-or-create dedupe); null for groups
  created_by_name text,
  created_by_role text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists trg_chat_conversations_updated_at on public.chat_conversations;
create trigger trg_chat_conversations_updated_at
  before update on public.chat_conversations
  for each row execute function public.crisdata_set_updated_at();


-- ============================================================
-- 2. chat_members
-- ============================================================
create table if not exists public.chat_members (
  conversation_id uuid        not null references public.chat_conversations(id) on delete cascade,
  member_name     text        not null,
  member_role     text,                 -- cached for context / labeling
  added_at        timestamptz not null default now(),
  primary key (conversation_id, member_name)
);

-- "my conversations" lookup: which conversations is this person in?
create index if not exists idx_chat_members_member on public.chat_members (member_name);


-- ============================================================
-- 3. RLS — same anon-full-access pattern as chat_messages / chat_reads.
--    CrisData has no Supabase Auth session (app-level PIN login only),
--    so access control stays at the app layer, not the DB layer.
-- ============================================================
alter table public.chat_conversations enable row level security;
drop policy if exists "Allow anon full access to chat_conversations" on public.chat_conversations;
create policy "Allow anon full access to chat_conversations"
  on public.chat_conversations for all to anon using (true) with check (true);

alter table public.chat_members enable row level security;
drop policy if exists "Allow anon full access to chat_members" on public.chat_members;
create policy "Allow anon full access to chat_members"
  on public.chat_members for all to anon using (true) with check (true);


-- ============================================================
-- 4. Realtime — add both new tables to the supabase_realtime publication.
-- ============================================================
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='chat_conversations'
  ) then
    alter publication supabase_realtime add table public.chat_conversations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='chat_members'
  ) then
    alter publication supabase_realtime add table public.chat_members;
  end if;
end $$;


-- ============================================================
-- 5. ALTER chat_messages
--    - add conversation_id (backfilled below)
--    - DROP the channel CHECK: a fixed allow-list is wrong once
--      conversations are dynamic. KEEP the sender_role CHECK.
--    - make channel nullable: 3b writes new rows with conversation_id
--      and leaves channel null; old rows keep their channel for audit.
-- ============================================================
alter table public.chat_messages
  add column if not exists conversation_id uuid references public.chat_conversations(id) on delete cascade;

create index if not exists idx_chat_messages_conversation
  on public.chat_messages (conversation_id, created_at);

alter table public.chat_messages drop constraint if exists chat_messages_channel_check;
-- sender_role CHECK intentionally left in place (see 20260713_chat_sender_role_check.sql).

alter table public.chat_messages alter column channel drop not null;


-- ============================================================
-- 6. ALTER chat_reads
--    - drop the OLD pk FIRST — channel is a PK column, and Postgres
--      won't let us drop NOT NULL on a column that is still in a
--      primary key (error 42P16). So the PK swap is split: drop here,
--      re-add as the fail-loud completeness guard in section 8.
--    - THEN make channel nullable, kept for audit
--    - add conversation_id (backfilled below; NEW pk added AFTER backfill)
-- ============================================================
-- Default PK name for chat_reads is chat_reads_pkey (created as
-- `primary key (channel, reader_name)` in 20260720_chat_reads.sql).
-- On a re-run this also drops the NEW pk from a prior full apply.
alter table public.chat_reads drop constraint if exists chat_reads_pkey;

alter table public.chat_reads alter column channel drop not null;

alter table public.chat_reads
  add column if not exists conversation_id uuid references public.chat_conversations(id) on delete cascade;


-- ============================================================
-- 7. BACKFILL — so no history is orphaned.
--
-- The role→person map is 1:1 today (owner, manager, advisor, bookkeeping),
-- resolved live from the employees table (active office roles). We create:
--   * ONE 'Office' group with all four as members  ← legacy 'group' channel
--   * one DM per DISTINCT legacy role-pair channel actually present,
--     with the two corresponding people as members and dm_key set.
-- Then stamp conversation_id onto every existing chat_messages / chat_reads
-- row from its channel string.
--
-- The DM loop is data-driven off the channels actually present (union of
-- both tables) and parses "roleA_roleB" by splitting on '_', so any pair
-- that shows up — including ones not enumerated here — is handled.
-- ============================================================
do $$
declare
  v_office_id   uuid;
  v_owner       text;
  v_manager     text;
  v_advisor     text;
  v_bookkeeping text;
  r             record;
  v_role_a      text;
  v_role_b      text;
  v_name_a      text;
  v_name_b      text;
  v_dm_key      text;
  v_conv_id     uuid;
begin
  -- ── resolve the 1:1 role→person names (active office roles) ──
  select name into v_owner       from public.employees where role='owner'       and active=true order by name limit 1;
  select name into v_manager     from public.employees where role='manager'     and active=true order by name limit 1;
  select name into v_advisor     from public.employees where role='advisor'     and active=true order by name limit 1;
  select name into v_bookkeeping from public.employees where role='bookkeeping' and active=true order by name limit 1;

  -- ── 'Office' group (find-or-create) ──
  select id into v_office_id from public.chat_conversations where type='group' and title='Office' limit 1;
  if v_office_id is null then
  end if;

  -- add the four office members (skip any role that is currently unfilled)

  -- map the legacy 'group' channel → 'Office'
  update public.chat_messages set conversation_id = v_office_id where channel = 'group' and conversation_id is null;
  update public.chat_reads    set conversation_id = v_office_id where channel = 'group' and conversation_id is null;

  -- ── one DM per distinct legacy role-pair channel ──
  for r in
    select distinct channel from public.chat_messages
      where channel is not null and channel <> 'group'
    union
    select distinct channel from public.chat_reads
      where channel is not null and channel <> 'group'
  loop
    v_role_a := split_part(r.channel, '_', 1);
    v_role_b := split_part(r.channel, '_', 2);

    -- must be a clean two-token role pair (role tokens contain no '_')
    if v_role_a = '' or v_role_b = '' or split_part(r.channel, '_', 3) <> '' then
      raise notice 'chat_conversations backfill: skipping non-pair channel %', r.channel;
      continue;
    end if;

    select name into v_name_a from public.employees where role = v_role_a and active = true order by name limit 1;
    select name into v_name_b from public.employees where role = v_role_b and active = true order by name limit 1;

    if v_name_a is null or v_name_b is null then
      raise notice 'chat_conversations backfill: skipping channel % — unresolved role (a=%, b=%)',
        r.channel, v_role_a, v_role_b;
      continue;
    end if;

    -- dm_key: two names, lowercased, sorted, joined with '|'
    v_dm_key := (select string_agg(n, '|' order by n)
                 from (values (lower(v_name_a)), (lower(v_name_b))) as t(n));

    -- find-or-create the DM by dm_key
    select id into v_conv_id from public.chat_conversations where dm_key = v_dm_key limit 1;
    if v_conv_id is null then
    end if;


    update public.chat_messages set conversation_id = v_conv_id where channel = r.channel and conversation_id is null;
    update public.chat_reads    set conversation_id = v_conv_id where channel = r.channel and conversation_id is null;
  end loop;
end $$;


-- ============================================================
-- 8. chat_reads NEW pk — AFTER backfill (every row now has conversation_id).
--    New PK (conversation_id, reader_name). The old pk was already dropped
--    in section 6 (it had to be, to null the channel column). ADD PRIMARY
--    KEY auto-enforces NOT NULL on conversation_id, so this fails loudly if
--    any chat_reads row was left unmapped by the backfill — the intended
--    completeness guard. Idempotent: section 6 drops chat_reads_pkey first,
--    so a full re-run reaches here with no pk and this re-adds it cleanly.
-- ============================================================
alter table public.chat_reads add constraint chat_reads_pkey
  primary key (conversation_id, reader_name);


-- ============================================================
-- VERIFICATION CHECKLIST — run each after applying. Expected results noted.
-- ============================================================

-- V1. Conversations: expect 1 'Office' group + one dm per distinct legacy
--     role-pair channel (6 pairs across the boards today ⇒ 7 rows total).
-- select type, title, dm_key from public.chat_conversations order by type, title, dm_key;

-- V2. No message left orphaned — expect 0.
-- select count(*) as orphan_messages from public.chat_messages where conversation_id is null;

-- V3. No read-state left orphaned — expect 0.
-- select count(*) as orphan_reads from public.chat_reads where conversation_id is null;

-- V4. chat_reads PK is now (conversation_id, reader_name).
-- select conname, pg_get_constraintdef(oid) as def
-- from pg_constraint where conrelid='public.chat_reads'::regclass and contype='p';

-- V5. channel CHECK on chat_messages is gone; sender_role CHECK still present.
-- select conname, pg_get_constraintdef(oid) as def
-- from pg_constraint where conrelid='public.chat_messages'::regclass and contype='c'
-- order by conname;
--   ⇒ expect chat_messages_sender_role_check present, NO chat_messages_channel_check.

-- V6. Membership: 4 in 'Office', exactly 2 per dm.
-- select c.type, coalesce(c.title, c.dm_key) as conv, count(m.*) as members
-- from public.chat_conversations c
-- left join public.chat_members m on m.conversation_id = c.id
-- group by c.id, c.type, c.title, c.dm_key
-- order by c.type, conv;
--   ⇒ expect the 'Office' group = 4, every dm = 2.

-- V7. Confirm the resolved names look right (sanity on the role→person map).
-- select conversation_id, member_name, member_role from public.chat_members order by conversation_id, member_role;


-- ===== 20260720_chat_reads.sql =====
-- ============================================================
-- Team Chat — durable read-state (Slice 1 of the chat rebuild).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- WHY: today unread counts live only in memory (chatUnreadCounts), so
-- they reset on every reload and don't sync across a person's devices.
-- This table records, per reader per channel, the moment they last read
-- it. Unread for a channel = chat_messages with created_at > last_read_at
-- (excluding the reader's own messages).
--
-- The shared component (shared/team-chat.js) DEGRADES GRACEFULLY if this
-- table is missing — it falls back to today's in-memory-only counting and
-- logs a warning, so the boards keep working before this migration lands.
-- Read-state only becomes durable once this has been run.
--
-- KEY CHOICE: primary key (channel, reader_name). CrisData identity is
-- CHAT_IDENTITY = { name, role } — resolved from employees by the board's
-- passthrough session — and `sender_name` is already the per-person key
-- used throughout chat_messages (me/them matching, self-filtering). There
-- is no phone/id in CHAT_IDENTITY, so reader_name is the stable key that
-- matches how identity is actually resolved. reader_role is stored for
-- context only (not part of the key).
-- ============================================================

create table if not exists public.chat_reads (
  channel       text        not null,
  reader_role   text,
  reader_name   text        not null,
  last_read_at  timestamptz not null default now(),
  primary key (channel, reader_name)
);

-- Fast lookup of a single reader's rows on load / focus reconcile.
create index if not exists idx_chat_reads_reader on public.chat_reads (reader_name);

-- RLS: same anon-key pattern used everywhere else in this app
-- (chat_messages, invoice_queue, completed_jobs, dashboard_preferences).
-- CrisData has no Supabase Auth session — only app-level PIN login — so
-- access control stays at the app layer, not the DB layer.
alter table public.chat_reads enable row level security;

-- Idempotent: Postgres has no "create policy if not exists", so drop first.
-- This file is already applied; the guard only makes a re-run (or a batch
-- re-run alongside 20260720_chat_conversations.sql) clean instead of 42710.
drop policy if exists "Allow anon full access to chat_reads" on public.chat_reads;

create policy "Allow anon full access to chat_reads"
  on public.chat_reads
  for all
  to anon
  using (true)
  with check (true);


-- ===== 20260720_declined_estimate.sql =====
-- ============================================================
-- Declined-estimate flag + callback list (CrisData RO board).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- Cris's decision: "Declined" is a FLAG on an estimate, NOT a new stage.
-- The status enum (estimate | ro | invoice | closed) is unchanged. A
-- declined estimate = status='estimate' with declined_at set; it's pulled
-- off the active kanban into a callback list. Money/totals are untouched —
-- declining creates no invoice and changes no line items.
--
-- Additive + nullable only → safe to run mid-workday. First real case is
-- RO #5473.
--
-- The advisor board loads these columns resiliently: if this migration
-- hasn't run yet, the RO board falls back to its old query and the declined
-- feature stays dormant (no breakage). The feature lights up once this runs.
-- ============================================================

alter table public.repair_orders
  add column if not exists declined_at     timestamptz null,
  add column if not exists declined_reason text        null;

-- Callback list = declined estimates, newest declined_at first.
create index if not exists idx_repair_orders_declined_at
  on public.repair_orders (declined_at desc)
  where declined_at is not null;


-- ===== 20260720_diag_fee_setting.sql =====
-- ============================================================
-- Quick diag-fee receipt — default diagnostic-fee amount setting.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- When a customer declines an estimate but pays a diagnostic fee at pickup,
-- the advisor prints a quick one-line receipt. This adds the DEFAULT amount
-- that prefills that receipt (still editable per receipt), same pattern as
-- the labor rate / tax % / card fee already in shop_settings.
--
-- Additive + nullable → safe to run mid-workday. Owner/GM edit it in
-- Settings → RO & Pricing. The receipt itself needs no schema change: it
-- archives into completed_jobs with a DISTINCT source_table='diag_receipt'
-- so it never collides with the estimate's own 'repair_orders' archive row.
--
-- board-settings.js reads this column resiliently (getShopSettings only
-- surfaces it when present), so nothing breaks before this runs.
-- ============================================================

alter table public.shop_settings
  add column if not exists default_diag_fee numeric(10,2) null;

-- Optional: seed a starting amount (or leave null and set it in Settings).
-- update public.shop_settings set default_diag_fee = 165.00
--   where id = '00000000-0000-0000-0000-000000000001';


-- ===== 20260720_push_subscriptions.sql =====
-- ============================================================
-- Web Push — subscription storage (Team Chat push, sub-slice 2b).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- WHY: sub-slice 2b captures a browser's Web Push subscription when the
-- user turns on notifications on a board, and stores it here. The 2c
-- sender (a Vercel function using the VAPID private key) will read these
-- rows to deliver pushes. No sending happens in 2b.
--
-- KEY CHOICE: endpoint is the primary key. A Web Push `endpoint` is
-- unique per device+browser install, so it naturally dedupes re-enables
-- from the same device (upsert on endpoint refreshes keys + last_seen_at)
-- while letting one person have several rows across their devices.
--
-- shared/push.js DEGRADES GRACEFULLY if this table is missing (PGRST205 →
-- treated as "off", no crash), mirroring the chat_reads fallback — so the
-- boards keep working before this migration lands. Subscriptions only
-- persist once this has been run.
-- ============================================================

create table if not exists public.push_subscriptions (
  endpoint        text        primary key,
  p256dh          text,
  auth            text,
  subscriber_role text,
  subscriber_name text,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

-- Look up a person's devices when fanning out a push in 2c.
create index if not exists idx_push_subscriptions_name on public.push_subscriptions (subscriber_name);

-- RLS: same anon-key pattern used everywhere else in this app
-- (chat_messages, chat_reads, invoice_queue). CrisData has no Supabase
-- Auth session — only app-level PIN login — so access control stays at
-- the app layer, not the DB layer.
alter table public.push_subscriptions enable row level security;

-- Idempotent: no "create policy if not exists" in Postgres, so drop first
-- to keep a re-run (or batch re-run with the other 20260720 files) clean.
drop policy if exists "Allow anon full access to push_subscriptions" on public.push_subscriptions;

create policy "Allow anon full access to push_subscriptions"
  on public.push_subscriptions
  for all
  to anon
  using (true)
  with check (true);


-- ===== 20260721_chat_group_photo.sql =====
-- ============================================================
-- Team Chat — Avatars/Settings sub-slice 2: group photo.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file (NOT the whole 20260721 batch — re-applying older
-- migrations throws "already exists"; same lesson as 3a / 4a).
--
-- Adds a single nullable pointer to the group's avatar object, stored in the
-- existing private `crisdata-attachments` bucket under
--   avatars/group/<conversationId>/<uuid>
-- (namespaced apart from message attachments under chat/<conversationId>/…).
-- Read via short-lived createSignedUrl at render time — same pattern as the
-- 4a message photos, so no new storage policy is needed (the bucket-wide anon
-- insert/select policies from 20260716_ro_foundation.sql already cover it).
--
-- ANY member may set/change/remove a group's photo (low-stakes + reversible);
-- there is no creator gate here — creator-only gating is reserved for the later
-- destructive sub-slices (remove members, delete group). null photo_path = the
-- generic 👥 group glyph.
--
-- Idempotent + self-contained: add-column-if-not-exists, safe to re-run.
-- ============================================================

alter table public.chat_conversations
  add column if not exists photo_path text;  -- path inside crisdata-attachments (avatars/group/<conversationId>/<uuid>); null = glyph


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The column exists and is nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='chat_conversations'
--   and column_name='photo_path';   -- ⇒ 1 row, is_nullable = YES, data_type = text


-- ===== 20260721_chat_message_delete.sql =====
-- ============================================================
-- Team Chat — MESSAGE DELETE (tombstone, own-messages-only, delete-for-everyone).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file.
--
-- Delete is a soft/tombstone UPDATE on the message row: the client nulls the
-- text + attachment pointer and sets deleted_at (+ who). deleted_at IS NOT NULL
-- => the row renders as "🚫 This message was deleted" for everyone; the row
-- stays in place so ordering + day dividers are unaffected.
--
-- NO realtime-publication change needed: chat_messages is already in
-- supabase_realtime (INSERT receipts/messages work live), and a table in the
-- publication broadcasts UPDATE too — the UPDATE `new` payload carries the full
-- new row (deleted_at set, message/attachment nulled), which is all the client
-- reads. NO RLS change needed: chat_messages already allows anon UPDATE
-- (verified live with a no-op PATCH → HTTP 200 + row returned), same
-- app-level/PIN model as the rest of chat.
--
-- Idempotent: add-column-if-not-exists x2, safe to re-run.
-- ============================================================

alter table public.chat_messages add column if not exists deleted_at timestamptz;  -- set => tombstoned (message deleted for everyone)
alter table public.chat_messages add column if not exists deleted_by text;          -- who deleted it (own-messages-only, so = sender_name)


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. Both columns exist, nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='chat_messages'
--   and column_name in ('deleted_at','deleted_by') order by column_name;  -- ⇒ 2 rows, YES


-- ===== 20260721_chat_reads_realtime.sql =====
-- ============================================================
-- Team Chat — READ RECEIPTS ("seen"): put chat_reads on the realtime feed.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file.
--
-- WHY: read receipts flip live (✓ → ✓✓) via a realtime subscription on
-- chat_reads. Tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication (same lesson as todos / core_charges /
-- marketing_content), and no earlier migration added chat_reads — so without
-- this, receipts are still CORRECT on thread open (computed from a fresh
-- SELECT) but never flip live while both people have the thread open.
--
-- No schema change, no RLS change: chat_reads already has anon full-access RLS
-- (from 20260720_chat_reads.sql) so anon SELECT for the receipt computation is
-- already allowed. This only adds the table to the broadcast publication.
--
-- Idempotent: guarded on pg_publication_tables, so re-running is a no-op.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_reads'
  ) then
    alter publication supabase_realtime add table public.chat_reads;
  end if;
end $$;


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. chat_reads is now in the realtime publication.
-- select tablename from pg_publication_tables
-- where pubname='supabase_realtime' and schemaname='public' and tablename='chat_reads';  -- ⇒ 1 row


-- ===== 20260721_employee_avatar.sql =====
-- ============================================================
-- Team Chat — Avatars/Settings sub-slice 3: person profile photos (self-service).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file (NOT the whole 20260721 batch — re-applying older
-- migrations throws "already exists"; same lesson as 3a / 4a / group-photo).
--
-- Adds a single nullable pointer to the person's avatar object, stored in the
-- existing private `crisdata-attachments` bucket under
--   avatars/person/<name-slug>/<uuid>
-- (namespaced apart from group avatars avatars/group/… and message attachments
-- chat/…). Read via short-lived createSignedUrl at render time — same pattern
-- as the 4a message photos + the group photo, so no new storage policy needed.
--
-- SELF-SERVICE: a person only ever sets/changes/removes their OWN photo. The
-- client updates the current user's own employees row (matched by live
-- getIdentity name + role). The employees table is anon-updatable under the
-- existing app-level (PIN) RLS model — verified live with a no-op UPDATE that
-- returned the row — so this write works without loosening any policy.
--
-- NOTE: employees already has an unused `photo_url` (and `background_photo_url`)
-- column; this `avatar_path` is deliberately separate — it is a STORAGE PATH
-- read via signed URL from the private bucket, not a public URL. Leaving the
-- old columns untouched.
--
-- Idempotent + self-contained: add-column-if-not-exists, safe to re-run.
-- ============================================================

alter table public.employees
  add column if not exists avatar_path text;  -- path inside crisdata-attachments (avatars/person/<name-slug>/<uuid>); null = initial circle


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The column exists and is nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='employees'
--   and column_name='avatar_path';   -- ⇒ 1 row, is_nullable = YES, data_type = text


-- ===== 20260721_todo_attachments.sql =====
-- ============================================================
-- To-Do — FILE ATTACHMENTS (one file per to-do, any type).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Run ONLY this one file.
--
-- One optional attachment per todo row, pointer ON the row (same shape as the
-- chat message attachments). Stored in the existing private
-- crisdata-attachments bucket under todos/<uuid>/<filename> (namespaced apart
-- from chat/ and avatars/), read via short-lived createSignedUrl at render.
-- No new storage policy needed (bucket-wide anon insert/select already exist).
--
-- MULTI-ASSIGN needs NO schema change: assignment stays one row per assignee
-- (existing assigned_to / assigned_to_name single-assignee model); the client
-- fans out N rows on add, each with the SAME attachment_path.
--
-- No RLS change: todos is already anon-full-access (20260715_todos.sql).
-- Resilient: the board loads todos with select('*'), and plain (no-file)
-- to-dos never reference these columns, so adding/listing to-dos keeps working
-- before this migration runs — only file attachments need it.
--
-- Idempotent: add-column-if-not-exists x3, safe to re-run.
-- ============================================================

alter table public.todos add column if not exists attachment_path text;  -- path inside crisdata-attachments (todos/<uuid>/<filename>)
alter table public.todos add column if not exists attachment_name text;  -- original filename (chip display)
alter table public.todos add column if not exists attachment_mime text;  -- content type


-- ============================================================
-- VERIFICATION (run after applying):
-- ============================================================

-- V1. The three columns exist, all nullable.
-- select column_name, is_nullable, data_type
-- from information_schema.columns
-- where table_schema='public' and table_name='todos'
--   and column_name in ('attachment_path','attachment_name','attachment_mime')
-- order by column_name;   -- ⇒ 3 rows, is_nullable = YES


-- ===== 20260727_feature_adoption.sql =====
-- ============================================================
-- Feature-adoption view — owner board "who actually uses what" tab.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub). READ-ONLY
-- reporting view over data that already exists — no new instrumentation.
--
-- Grain: one row per (person, metric): event_count + last_touched. All the
-- counting/grouping is server-side; the client reads this view ONCE.
--
-- METRIC = a single STAMPED ACTION, never "used the feature". This matters:
-- e.g. cores_returned counts ONLY marking a core returned — it does NOT count
-- Daiana entering cores from receipts (that insert carries no attribution),
-- so a low/"never" here is a blind spot, not proof of non-use. The UI spells
-- out each metric's blind spot. Labels in the client mirror the action
-- ("cores returned", "chat sent", "invoices captured/processed", …).
--
-- NORMALIZATION (one place, here):
--   • "Sleepy Josh" -> "Josh", "Cristian Mendez" -> "Cristian"
--   • Then keep ONLY people present in employees AND active. That single
--     semi-join drops: test junk (Claude (feature verification), __test__,
--     gfh, ghgh, ]p[), inactive staff (Capote), and teardown.html's own
--     hardcoded non-employee tech names (Cuba, Alnar, Dier, chris) — none of
--     which are trustable. No "unknown" bucket.
--
-- teardowns_logged is LOW CONFIDENCE: teardown.html is the discontinued v1
-- tool running off its own hardcoded tech list, predating the employees
-- table. The client marks that chip and says so. (No work proposed on v1.)
-- ============================================================

create or replace view public.feature_adoption as
with raw(person_raw, metric, ts) as (
  select created_by_name,    'todo_created',       created_at   from public.todos             where created_by_name is not null
  union all
  select assigned_to_name,   'todo_completed',     completed_at from public.todos             where assigned_to_name is not null and completed_at is not null
  union all
  select sender_name,        'chat_sent',          created_at   from public.chat_messages     where sender_name is not null
  union all
  select reader_name,        'chat_read',          last_read_at from public.chat_reads        where reader_name is not null
  union all
  select uploaded_by_name,   'invoices_captured',  uploaded_at  from public.invoice_queue     where uploaded_by_name is not null
  union all
  select processed_by_name,  'invoices_processed', processed_at from public.invoice_queue     where processed_by_name is not null and processed_at is not null
  union all
  select returned_by,        'cores_returned',     returned_at  from public.core_charges      where returned_by is not null and returned_at is not null
  union all
  select created_by_name,    'parts_ordered',      created_at   from public.parts_orders      where created_by_name is not null
  union all
  select captured_by,        'marketing_captured', captured_at  from public.marketing_content where captured_by is not null
  union all
  select tech_name,          'teardowns_logged',   created_at   from public.teardowns         where tech_name is not null
  union all
  select tech_name,          'punches',            punched_at   from public.punches           where tech_name is not null
),
norm as (
  select
    case btrim(person_raw)
      when 'Sleepy Josh'     then 'Josh'
      when 'Cristian Mendez' then 'Cristian'
      else btrim(person_raw)          -- Alnar / Dier / chris / Cuba pass through here, dropped by the semi-join below
    end as person,
    metric, ts
  from raw
  where ts is not null
)
select n.person, n.metric, count(*)::int as event_count, max(n.ts) as last_touched
from norm n
where n.person in (select name from public.employees where active)   -- excludes junk, non-employees, inactive
group by n.person, n.metric;

grant select on public.feature_adoption to anon;

-- ============================================================
-- VERIFY (run after applying):
--   select person, metric, event_count, last_touched
--     from public.feature_adoption order by person, metric;
--   -- expect only active-employee names (Cristian, Kevin, Josh, Daiana Mendez,
--   -- Alex, Alnardier); NOT Cuba/Alnar/Dier/chris/Capote/junk. Cory has an
--   -- employees row but no rows here (zero stamped actions) — correct.
-- ============================================================


-- ===== 20260727_planning_items.sql =====
-- ============================================================
-- Owner planning surface — PHASE 2 SLICE A: `planning_items`.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Idempotent; the app has a fallback so nothing breaks pre-migration.
--
-- Cris's own planning work (the Planner week view + ideas inbox), tied
-- optionally to projects. Same conventions as `projects`: anon-full-access
-- RLS, realtime added explicitly.
--
-- DELIBERATELY SEPARATE FROM `todos`. No FK, no shared columns, no data
-- migration between them. `todos` stays the operational shop tool with
-- assignment/fan-out; planning_items are the owner's private planning.
--
-- NULLABLE project_id is first-class — a captured idea/loose note has no
-- project yet. `on delete set null`: projects are archived (not hard
-- deleted) in the roadmap UI, so this rarely fires, but if a project ever
-- is deleted its items just go neutral (lose the color) instead of erroring.
--
-- scheduled_time is OPTIONAL and separate from scheduled_date:
--   date + time  -> timed calendar grid at that slot
--   date, no time -> all-day item pinned to the top of that day
--   neither      -> unscheduled (the inbox rail)
-- NEVER defaulted or faked as midnight.
--
-- done_at drives the checkbox + a 3-day visibility window (app-side query
-- filter, mirroring the To-Do board's completed_at rule — not deleted).
-- ============================================================

create table if not exists public.planning_items (
  id                uuid primary key default gen_random_uuid(),
  owner_employee_id uuid not null references public.employees(id),
  project_id        uuid references public.projects(id) on delete set null,
  title             text not null,
  notes             text,
  scheduled_date    date,
  scheduled_time    time,
  duration_minutes  int check (duration_minutes is null or duration_minutes > 0),
  done_at           timestamptz,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz
);

create index if not exists idx_planning_items_owner   on public.planning_items (owner_employee_id);
create index if not exists idx_planning_items_sched   on public.planning_items (scheduled_date);
create index if not exists idx_planning_items_project on public.planning_items (project_id);
create index if not exists idx_planning_items_done    on public.planning_items (done_at);

-- RLS: anon-full-access, matching projects / todos / marketing_content
-- (no Supabase Auth; scoping + edit rights are enforced app-side).
alter table public.planning_items enable row level security;
drop policy if exists "Allow anon full access to planning_items" on public.planning_items;
create policy "Allow anon full access to planning_items"
  on public.planning_items for all to anon using (true) with check (true);

-- Realtime — so a capture/drag on one device updates the Planner live on
-- another. (SQL-Editor tables aren't auto-added to the publication.)
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='planning_items'
  ) then
    alter publication supabase_realtime add table public.planning_items;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='planning_items' order by ordinal_position;
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='planning_items';   -- 1 row
-- ============================================================


-- ===== 20260727_projects.sql =====
-- ============================================================
-- Owner planning surface — PHASE 1: the `projects` roadmap table.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Idempotent; the app has a fallback so nothing breaks pre-migration.
--
-- SCOPING: owner_employee_id makes each person's roadmap PRIVATE. Every
-- query filters .eq('owner_employee_id', CURRENT_EMPLOYEE_ID) and every
-- insert stamps it. This is APP-LEVEL scoping — the same honest caveat
-- as marketing_content / invoice_queue: RLS here is anon-full-access (no
-- Supabase Auth exists anywhere in CrisData), so "private" means the app
-- never shows you someone else's roadmap, NOT per-row DB access control.
-- Shipping the column now = zero backfill when bookkeeping/manager get
-- this feature later.
--
-- NULL DATES ARE FIRST-CLASS (both start_date and target_date nullable):
--   both set     -> bar start_date..target_date on the timeline
--   target only  -> a diamond milestone marker at target_date
--   start only   -> a "running" bar start_date..today (open right edge,
--                   "no target" chip) — work in flight nobody has
--                   committed to finishing; stays ON the timeline
--   neither      -> the "no date yet" backlog list beside the timeline
--
-- STATUS -> bar color (app-side, shared/roadmap.js):
--   not_started grey   active accent/indigo   stalled amber
--   shipped green       parked muted slate + hatch
-- RED IS RESERVED for the LATE treatment only — never a status color.
--
-- archived_at: non-null = archived; hidden by default, shown behind a
-- "Show archived" toggle (soft delete, no hard delete in the UI).
-- ============================================================

create table if not exists public.projects (
  id                uuid primary key default gen_random_uuid(),
  owner_employee_id uuid not null references public.employees(id),
  name              text not null,
  status            text not null default 'not_started'
                      check (status in ('not_started','active','stalled','shipped','parked')),
  start_date        date,
  target_date       date,
  color             text,          -- optional per-project override; null = use status color
  notes             text,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz    -- non-null = archived (hidden by default)
);

create index if not exists idx_projects_owner    on public.projects (owner_employee_id);
create index if not exists idx_projects_archived on public.projects (archived_at);
create index if not exists idx_projects_target   on public.projects (target_date);

-- RLS: anon-full-access, matching todos / marketing_content / invoice_queue
-- (no Supabase Auth; scoping + edit rights are enforced app-side).
alter table public.projects enable row level security;
drop policy if exists "Allow anon full access to projects" on public.projects;
create policy "Allow anon full access to projects"
  on public.projects for all to anon using (true) with check (true);

-- Realtime — so a project added/edited on one device updates the roadmap
-- live on another. (SQL-Editor tables aren't auto-added to the publication.)
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='projects'
  ) then
    alter publication supabase_realtime add table public.projects;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='projects' order by ordinal_position;
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='projects';   -- 1 row
-- ============================================================


-- ===== 20260728_calls.sql =====
-- ============================================================
-- CTM caller card — slice 2: the `calls` table (CrisData).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- ctm_webhook_log (slice 1) is UNCHANGED.
--
-- One row per CTM call, keyed on the CTM call id. api/ctm-webhook.js UPSERTS
-- here (on conflict ctm_call_id do update) right after the ctm_webhook_log
-- insert, using the service-role key. The upsert is what makes CTM's retries
-- harmless and lets a future `end` trigger update the SAME row.
--
-- The advisor board subscribes to realtime INSERTs on this table and pops a
-- read-only caller card. It reads with the anon publishable key, so anon needs
-- SELECT — but nothing else. Writes are service-role only (bypass RLS).
-- ============================================================

create table if not exists public.calls (
  id                bigserial primary key,
  ctm_call_id       bigint not null unique,      -- body.id from CTM
  caller_bare       text,                        -- caller_number_bare (raw 10 digits)
  caller_formatted  text,                        -- caller_number_format ("(239) 600-1971")
  cnam              text,                        -- may be null / empty
  tracking_bare     text,                        -- tracking_number_bare
  source            text,                        -- body.source ("Direct")
  city              text,                        -- often empty string
  state             text,
  is_new_caller     boolean,
  tags              jsonb,                       -- body.tag_list (array, often empty)
  status            text,                        -- body.dial_status ("ringing")
  started_at        timestamptz,                 -- from body.unix_time (epoch seconds)
  created_at        timestamptz not null default now()
);

create index if not exists calls_started_at_idx on public.calls (started_at desc);

alter table public.calls enable row level security;

-- ONE policy: anon may SELECT, nothing else. (No anon insert/update/delete —
-- the webhook writes with the service-role key, which bypasses RLS.) Matches
-- the naming/shape of the repo's other board-readable anon policies; narrowed
-- from `for all` to `for select` because this table is board-READ-only.
-- Idempotent: no "create policy if not exists" in Postgres, so drop first.
drop policy if exists "Allow anon select on calls" on public.calls;
create policy "Allow anon select on calls"
  on public.calls
  for select
  to anon
  using (true);

-- Realtime: tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication (the todos / core_charges / chat_reads lesson).
-- Without this, the board's INSERT subscription never fires and no card pops.
-- Idempotent: guarded on pg_publication_tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   -- table + policy
--   select policyname, cmd from pg_policies where tablename='calls';        -- ⇒ SELECT only
--   -- in the realtime publication
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and schemaname='public' and tablename='calls';  -- ⇒ 1 row
--   -- after a real test call to (239) 933-5750:
--   select ctm_call_id, caller_bare, caller_formatted, cnam, tracking_bare,
--          source, city, state, is_new_caller, tags, status, started_at
--     from public.calls order by started_at desc limit 5;
-- ============================================================


-- ===== 20260728_calls_notes.sql =====
-- ============================================================
-- Advisor call window — slice 3a: notes + next step on the caller card.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Extends `calls` (slice 2); ctm_webhook_log is UNCHANGED.
--
-- ⚠️ TYPE CORRECTION vs the task DDL: the task wrote
--   `customer_id bigint references customers(id)` and
--   `ro_id bigint references repair_orders(id)`,
-- but customers.id and repair_orders.id are BOTH `uuid` (gen_random_uuid),
-- not bigint — a bigint FK to a uuid PK fails to create. So these two FK
-- columns are `uuid`. (calls.id itself stays bigserial; only the FKs change.)
--
-- next_step is constrained with a CHECK (not an enum type) — same approach as
-- declined_at, so we never touch a shared enum.
-- ============================================================

alter table public.calls
  add column if not exists customer_id   uuid references public.customers(id),
  add column if not exists note          text,
  add column if not exists next_step     text,
  add column if not exists due_at        timestamptz,
  add column if not exists due_all_day   boolean default true,
  add column if not exists ro_id         uuid references public.repair_orders(id),
  add column if not exists noted_by_name text,
  add column if not exists noted_at      timestamptz;

-- next_step ∈ the four intake outcomes (NULL allowed = not yet chosen).
-- Idempotent: drop the constraint first so a re-run is clean.
alter table public.calls drop constraint if exists calls_next_step_check;
alter table public.calls
  add constraint calls_next_step_check
  check (next_step is null or next_step in
    ('quoted_callback', 'dropping_off', 'checking_on_car', 'price_shopper'));

-- ── RLS: calls was anon-SELECT-only (slice 2). The board now UPDATEs these
-- columns from the card, so add an anon UPDATE policy — matching the anon
-- posture of todos / marketing_content (using(true)/with check(true)). Row
-- CREATION stays service-role only: NO anon INSERT, NO anon DELETE policy, so
-- the webhook still owns inserts. Idempotent: drop first.
drop policy if exists "Allow anon update on calls" on public.calls;
create policy "Allow anon update on calls"
  on public.calls
  for update
  to anon
  using (true)
  with check (true);

-- ============================================================
-- VERIFY (run after applying):
--   -- columns present
--   select column_name, data_type from information_schema.columns
--     where table_name='calls'
--       and column_name in ('customer_id','note','next_step','due_at',
--                           'due_all_day','ro_id','noted_by_name','noted_at')
--     order by column_name;                                  -- ⇒ 8 rows (uuid FKs)
--   -- policies: SELECT + UPDATE for anon, NO insert/delete
--   select policyname, cmd from pg_policies where tablename='calls' order by cmd;
--   -- after a live test call + a typed note:
--   select ctm_call_id, customer_id, note, next_step, due_at, due_all_day,
--          ro_id, noted_by_name, noted_at
--     from public.calls order by started_at desc limit 5;
-- ============================================================


-- ===== 20260728_calls_resolved.sql =====
-- ============================================================
-- Advisor desk — slice 3b: let call-backed items leave a lane.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Extends `calls` again (slices 2 + 3a unchanged); ctm_webhook_log unchanged.
--
-- The Desk's Callbacks and Coming-in lanes are driven by calls rows. Without a
-- way to mark one handled they'd grow forever. An item leaves its lane when
-- resolved_at is set (via the row's "Done" action, stamping resolved_by_name).
--
-- No RLS change: the anon UPDATE policy from slice 3a already covers these two
-- columns. No new enum. (The Declined lane is repair_orders-backed and clears
-- via its existing declined_at/restore lifecycle, not resolved_at.)
-- ============================================================

alter table public.calls
  add column if not exists resolved_at      timestamptz,
  add column if not exists resolved_by_name text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type from information_schema.columns
--     where table_name='calls' and column_name in ('resolved_at','resolved_by_name')
--     order by column_name;                                  -- ⇒ 2 rows
--   -- open lane items (unresolved callbacks / drop-offs):
--   select ctm_call_id, next_step, due_at, due_all_day, resolved_at, resolved_by_name
--     from public.calls
--    where next_step in ('quoted_callback','dropping_off') and resolved_at is null
--    order by due_at;
-- ============================================================


-- ===== 20260728_ctm_webhook_log.sql =====
-- ============================================================
-- CTM webhook capture log — CrisData reconnaissance slice.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Purpose: api/ctm-webhook.js receives every CallTrackingMetrics webhook POST,
-- logs the COMPLETE raw payload here, and returns 200. This table exists only
-- so we can SEE what CTM actually sends before building anything against it.
-- No parsing, matching, or downstream use — that is deliberately out of scope.
--
-- Both forms of the body are stored:
--   • body_raw  — the exact bytes as received (source of truth for signature work)
--   • body      — JSON.parse(body_raw); NULL + parse_error if it doesn't parse.
-- A parse failure must NEVER prevent the row from being written.
--
-- Signature fields are LOG-ONLY in this phase. sig_computed is a CANDIDATE
-- (HMAC-SHA1 over X-CTM-Time + raw body — an ASSUMPTION, not confirmed). We
-- compare sig_received vs sig_computed across real deliveries to learn the true
-- signing string, then turn on enforcement in a later commit. Nothing is
-- rejected on mismatch here.
--
-- RLS: default-deny (enabled, NO policies). This table holds raw webhook
-- payloads + signatures — the anon publishable key the boards ship must NOT be
-- able to read or write it. Only the server-side service-role key (which
-- bypasses RLS) touches this table.
-- ============================================================

create table if not exists public.ctm_webhook_log (
  id            bigserial primary key,
  received_at   timestamptz not null default now(),
  headers       jsonb not null,
  body          jsonb,
  body_raw      text,
  sig_received  text,
  sig_computed  text,
  sig_match     boolean,
  parse_error   text
);

create index if not exists ctm_webhook_log_received_at_idx
  on public.ctm_webhook_log (received_at desc);

alter table public.ctm_webhook_log enable row level security;
-- No policies on purpose: default-deny for anon/authenticated. The webhook
-- endpoint writes with the service-role key, which bypasses RLS.

-- ============================================================
-- VERIFY (run after applying, and after the first real/test delivery):
--   select id, received_at, sig_received, sig_computed, sig_match, parse_error,
--          jsonb_pretty(headers) as headers, body_raw, jsonb_pretty(body) as body
--     from public.ctm_webhook_log
--    order by received_at desc
--    limit 5;
-- ============================================================


-- ===== 20260729_call_attach.sql =====
-- ============================================================
-- Advisor desk — call log: deliberate ATTACH / UN-ATTACH + "not a customer".
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
-- Extends `calls` again (slices 2 / 3a / 3b / 3e unchanged); other tables
-- untouched.
--
-- WHY: calls.customer_id has only ever been written as a SIDE EFFECT of Josh
-- acting on a live ring-time card, so it was unreliable — which is exactly why
-- slice 3e made the call log resolve identity by a LIVE last-10 phone match
-- instead of trusting the column. This slice keeps that rule and finally gives
-- customer_id a deliberate meaning: A HUMAN CONFIRMED THIS CALL IS THIS PERSON.
--
--   attached_by_name / attached_at  — who confirmed the attach, and when.
--   learned_phone (default false)   — TRUE only when the attach itself wrote
--       the caller's number into customers.phone_secondary (an empty slot).
--       Un-attach clears phone_secondary ONLY when this flag is true, so a
--       pre-existing number is never deleted by undoing a linking mistake.
--   not_a_customer_at / _by_name    — a reversible mark for spam / wrong
--       numbers, so they can leave the Unattached list without inventing a
--       person (avoids the Declined-lane "permanent noise" failure mode).
--
-- customer_id ALREADY EXISTS (slice 2) — deliberately not re-added here.
--
-- No RLS change: the anon UPDATE policy from slice 3a already covers new
-- columns (same as 20260728_calls_resolved.sql). No new enum.
-- ============================================================

alter table public.calls
  add column if not exists attached_by_name     text,
  add column if not exists attached_at          timestamptz,
  add column if not exists learned_phone        boolean not null default false,
  add column if not exists not_a_customer_at    timestamptz,
  add column if not exists not_a_customer_by_name text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_name='calls'
--      and column_name in ('attached_by_name','attached_at','learned_phone',
--                          'not_a_customer_at','not_a_customer_by_name')
--    order by column_name;                                   -- ⇒ 5 rows
--
--   -- unattached calls (no confirmed customer, not marked not-a-customer):
--   select id, caller_bare, customer_id, attached_by_name, learned_phone,
--          not_a_customer_at
--     from public.calls
--    where customer_id is null and not_a_customer_at is null
--    order by started_at desc
--    limit 20;
-- ============================================================


-- ===== 20260729_comeback_capture.sql =====
-- ============================================================
-- Comeback capture — SLICE: badge + chain view + blocked close.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHY THIS COLUMN EXISTS:
--   A comeback is not invoiced, so nothing today forces anyone to record what
--   the complaint was or what we did about it — which is exactly why the
--   green-Chevy repair history is missing. This adds the ONE place to record
--   "what we did on the comeback," and the app then BLOCKS closing a comeback
--   until both the complaint (existing field) and this resolution are filled.
--   It fixes history going FORWARD only; nothing backfills old rows.
--
-- ⚠️ A NEW COLUMN ON PURPOSE — do NOT reuse advisory_notes:
--   advisory_notes PRINTS on the customer invoice (printRo) and archives to
--   completed_jobs.notes. "What we did on the comeback" is INTERNAL — it must
--   never print and never leave via the archive. So it gets its own column.
--   The COMPLAINT side reuses the EXISTING repair_orders.complaint field —
--   there is deliberately no second complaint column.
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). Nullable — NULL means
-- "nobody has recorded it yet," never "there was no repair." No RLS change:
-- repair_orders keeps its existing anon policy; the board already UPDATEs it.
-- The client degrades quietly if this column is missing (42703 / PGRST204).
-- ============================================================

alter table public.repair_orders
  add column if not exists comeback_resolution text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='repair_orders'
--       and column_name = 'comeback_resolution';   -- text, YES nullable
-- ============================================================


-- ===== 20260729_ctm_webhook_trigger.sql =====
-- ============================================================
-- CTM webhook trigger hint — recon column for the end / end_immediate triggers.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Purpose: we are about to point TWO more CallTrackingMetrics webhooks at the
-- SAME endpoint (api/ctm-webhook.js) — the `end` and `end_immediate` triggers —
-- purely to CAPTURE what CTM sends at those moments. We do not yet know the
-- end-payload field names and are not building against them.
--
-- Those two webhooks carry a `?trigger=end` / `?trigger=end_immediate` query
-- param; the endpoint records the param value here so the captured rows can be
-- told apart from the (param-less) `start` deliveries. NULL on the start
-- webhook, which points at the bare URL with no param.
--
-- This column is CAPTURE-ONLY. The end payload is deliberately NOT mapped into
-- `calls` — those rows now hold the advisor's typed notes, and running an end
-- payload through the upsert would null real data over the same ctm_call_id.
--
-- Until this migration is applied, the endpoint keeps working: the insert falls
-- back to writing the row WITHOUT trigger_hint on a 42703 (undefined_column)
-- error, so no log row is ever lost in the pre-migration window.
-- ============================================================

alter table public.ctm_webhook_log
  add column if not exists trigger_hint text;

-- ============================================================
-- VERIFY (run after applying, and after the first end / end_immediate delivery):
--   select id, received_at, trigger_hint, parse_error, body_raw
--     from public.ctm_webhook_log
--    order by received_at desc
--    limit 10;
-- ============================================================


-- ===== 20260729_recordings.sql =====
-- ============================================================
-- Call recordings pipeline — SLICE A: get CTM call audio into Storage.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- DO NOT rely on the app to run it — Cris runs migrations by hand.
--
-- WHAT THIS BACKS (no UI this slice):
--   • api/ctm-webhook.js — on the CTM `end` trigger, when the payload carries a
--     non-empty `audio` (a CTM API URL that 302-redirects to a TEMPORARY S3
--     link), inserts a `recordings` row with fetch_status='pending'. The
--     amazonaws.com URL is never stored — only the CTM API URL (remote_url),
--     always re-requested fresh.
--   • api/fetch-recordings.js — a 5-minute Vercel cron that downloads each
--     pending remote_url and uploads the bytes to the private `call-recordings`
--     bucket, then flips the row to 'ready' + storage_path.
--   • api/backfill-recordings.js — one-time, idempotent scan of ctm_webhook_log
--     (trigger_hint='end', body.audio present) to seed rows for calls already
--     logged (~40 from July 29).
--
-- ⚠️ RLS: ENABLED with ZERO POLICIES (default-deny). remote_url is a key to a
-- customer conversation and every board ships the same anon key, so the anon /
-- authenticated roles must NOT be able to read or write this table. ONLY the
-- server-side SERVICE-ROLE key (which bypasses RLS) touches `recordings` and the
-- `call-recordings` bucket. A reader (signed URL / policy) is Slice B — NOT here.
--
-- ctm_call_id is UNIQUE so the webhook + cron + backfill can all use
-- on-conflict-do-nothing: CTM retries and repeated `end` deliveries never create
-- a duplicate recording.
-- ============================================================

create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  source           text not null default 'call',      -- 'call' this slice; room for other sources later
  ctm_call_id      bigint unique,                      -- CTM body.id; UNIQUE → on-conflict-do-nothing
  call_id          bigint references public.calls(id) on delete set null,  -- resolved from calls.ctm_call_id; nullable
  remote_url       text not null,                      -- the CTM API URL (302→S3). NEVER the amazonaws.com url.
  storage_path     text,                               -- object key in the private call-recordings bucket, once fetched
  duration_seconds integer,                            -- from the payload's `duration`
  recorded_at      timestamptz,                        -- from the payload
  fetch_status     text not null default 'pending',    -- 'pending' | 'ready' | 'failed'
  fetch_attempts   integer not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The cron's work-list query: pending + under the attempt cap, oldest first.
create index if not exists idx_recordings_pending
  on public.recordings (fetch_status, created_at);
create index if not exists idx_recordings_call_id
  on public.recordings (call_id);

-- RLS on, NO policies → default-deny to anon/authenticated. Service-role only.
alter table public.recordings enable row level security;
-- (No CREATE POLICY on purpose. A Slice-B reader will add scoped access later.)

-- ============================================================
-- STORAGE — private 'call-recordings' bucket.
-- Cris may create this in the dashboard; this idempotent insert is here so the
-- cron never fails on a missing bucket. NO storage.objects policies are added
-- (private + service-role only), matching the zero-policy stance above.
-- ============================================================

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='recordings' order by ordinal_position;
--   -- RLS on, zero policies:
--   select relrowsecurity from pg_class where oid='public.recordings'::regclass;      -- t
--   select count(*) from pg_policies where schemaname='public' and tablename='recordings';  -- 0
--   select id, public from storage.buckets where id='call-recordings';               -- public=false
-- ============================================================


-- ===== 20260729_recordings_links.sql =====
-- ============================================================
-- Call recordings — SLICE B, PART 1: link a recording to a vehicle / RO.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHY THESE COLUMNS EXIST NOW, WITH NOTHING WRITING THEM YET:
--   The fleet case — "what did he say about THIS truck / THIS RO" — needs a
--   recording to be answerable WITHOUT re-deriving the link from the audio.
--   Adding the columns now means a later slice can backfill/populate them in
--   place; the play-button slice (B) neither writes nor reads them.
--
--   Both nullable, and NULL means "nobody has said yet" — NOT "no vehicle" /
--   "no RO". Never treat NULL as a negative fact.
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). No RLS change — the
-- recordings table stays RLS-ENABLED with ZERO POLICIES (default-deny); only the
-- service-role key touches it. Slice B's reader is api/recording-links.js, which
-- uses the service-role key server-side and never exposes these columns.
-- ============================================================

alter table public.recordings
  add column if not exists vehicle_id uuid references public.vehicles(id),
  add column if not exists ro_id      uuid references public.repair_orders(id);

-- Lookups by vehicle / RO will come with the slice that populates them; index
-- now so that slice needs no schema change. Partial (only linked rows).
create index if not exists idx_recordings_vehicle_id
  on public.recordings (vehicle_id) where vehicle_id is not null;
create index if not exists idx_recordings_ro_id
  on public.recordings (ro_id) where ro_id is not null;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='recordings'
--       and column_name in ('vehicle_id','ro_id');   -- both uuid, YES nullable
--   -- RLS unchanged: still on, still zero policies:
--   select relrowsecurity from pg_class where oid='public.recordings'::regclass;         -- t
--   select count(*) from pg_policies where schemaname='public' and tablename='recordings'; -- 0
-- ============================================================


-- ===== 20260729_repair_orders_no_delete.sql =====
-- ============================================================
-- repair_orders: make it create/read/update but NOT delete for the anon key
-- the boards ship. Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
-- BY HAND. Cris runs migrations manually; the app never runs this.
--
-- WHY:
--   A repair order carries payments and an invoice the customer holds — it's a
--   financial record, and financial records are append-only. A cancelled order
--   isn't erased; a status is added (we close/archive, never delete). This also
--   protects the comeback chain: parent_ro_id is `on delete set null`, so a
--   stray anon DELETE would silently orphan every child comeback. Denying anon
--   DELETE closes that door at the DB level.
--
-- WHY IT'S SAFE (loses no capability):
--   A read-only trace found ZERO deletes on repair_orders anywhere — boards,
--   api/, migrations, triggers. Closing is an UPDATE; archiving is a COPY into
--   completed_jobs. Nothing in the app deletes a repair_orders row today.
--
-- WHAT THIS CHANGES:
--   The existing policy is "Allow anon full access to repair_orders" from
--   migrations/20260716_ro_foundation.sql (~line 404), created as
--   `for all to anon using (true) with check (true)`. Postgres cannot narrow a
--   FOR ALL policy in place, so it is DROPPED and replaced with three separate
--   policies — SELECT, INSERT, UPDATE. There is deliberately NO DELETE policy,
--   which means DELETE is denied by default (RLS default-deny for any command
--   with no permissive policy).
--
--   ONLY the allowed COMMANDS change. The anon grant and `using (true) /
--   with check (true)` are kept on the three that remain — who and which rows
--   are untouched; app-level (PIN) scoping stays exactly as it is.
--
-- SCOPE: repair_orders ONLY. ro_line_items keeps full access (editing an RO
--   legitimately deletes line items). ro_payments, todos, marketing_content,
--   projects and every other anon-full-access table are untouched — narrowing
--   the shopwide convention is its own conversation, not this migration.
--
-- ⚠️ NOTE FOR CRIS: service_role BYPASSES RLS. Deleting a row by hand in the
--   Supabase SQL editor still works, and any future service-role endpoint still
--   could. That is intended — a deliberate act by the owner, not a stray client
--   call. This migration only removes DELETE from the anon (board) key.
--
-- IDEMPOTENT: every policy is dropped-if-exists before it is (re)created, so a
--   re-run never throws 42710 ("policy already exists"). Wrapped in ONE
--   transaction so there is never a window where the boards have no read policy.
-- ============================================================



-- RLS is already on from the foundation migration; re-assert it harmlessly so
-- this file is self-contained (no-op if already enabled).
alter table public.repair_orders enable row level security;

-- Remove the FOR ALL policy — it grants DELETE and cannot be narrowed in place.
drop policy if exists "Allow anon full access to repair_orders" on public.repair_orders;

-- SELECT — boards read ROs. (SELECT policies take USING only.)
drop policy if exists "Allow anon select on repair_orders" on public.repair_orders;
create policy "Allow anon select on repair_orders"
  on public.repair_orders
  for select
  to anon
  using (true);

-- INSERT — the New RO wizard mints ROs. (INSERT policies take WITH CHECK only.)
drop policy if exists "Allow anon insert on repair_orders" on public.repair_orders;
create policy "Allow anon insert on repair_orders"
  on public.repair_orders
  for insert
  to anon
  with check (true);

-- UPDATE — stage changes, close, edits. (UPDATE policies take USING + WITH CHECK.)
drop policy if exists "Allow anon update on repair_orders" on public.repair_orders;
create policy "Allow anon update on repair_orders"
  on public.repair_orders
  for update
  to anon
  using (true)
  with check (true);

-- (No DELETE policy on purpose → anon DELETE is denied by default.)



-- ============================================================
-- VERIFY (run after applying):
--   -- exactly three anon policies, commands SELECT / INSERT / UPDATE, no DELETE:
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'repair_orders'
--    order by cmd;
--
-- THEN VERIFY IN THE APP (anon key):
--   1. Open an RO, change its Stage, confirm it saves.            (UPDATE works)
--   2. Create a new RO through the wizard.                        (INSERT works)
--   3. Close a comeback and confirm the archive row appears in
--      completed_jobs.                                            (UPDATE + copy)
--   4. A delete attempt with the anon key now FAILS with an RLS
--      error instead of silently succeeding.                     (DELETE denied)
-- ============================================================


-- ===== 20260729_ro_service_writer.sql =====
-- ============================================================
-- CrisData RO — stored SERVICE WRITER (the actor the RO was written by).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- WHY: printRo() prints a "Service Advisor" line, but today it derives that
-- name from CHAT_IDENTITY at PRINT TIME — i.e. whoever is logged in on the
-- browser when Print is clicked. If Kevin prints an RO that Josh wrote, the
-- customer's paperwork says Kevin. That is wrong data leaving the shop. This
-- column stores WHO wrote the RO so the printed line can tell the truth.
--
-- repair_orders already has six stage timestamps but no actor record of any
-- kind, and that history cannot be reconstructed. This is the first actor
-- column. It is deliberately ONE nullable FK — NOT a per-stage actor set and
-- NOT an events table (both out of scope).
--
-- NULLABLE, no default, no backfill: the ~30 existing ROs predate this and
-- stay NULL. NULL honestly means "written before we tracked the writer" and
-- prints as '—'. We do not guess an author for old paperwork.
--
-- Stores the employee ID (uuid FK → employees.id), NOT a free-text name. This
-- is deliberately unlike the existing `technician` free-text column, which is a
-- known shortcut we are NOT repeating here. ON DELETE SET NULL: removing an
-- employee must never delete or block their ROs — the writer just goes blank.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app ships with a pre-migration fallback (selects retry without this
-- column; creation retries without it; print shows '—'), so the RO board keeps
-- working in the window before this is applied. Same resilience lesson as the
-- declined_estimate / returned_by columns.
-- ============================================================

alter table public.repair_orders
  add column if not exists service_writer_id uuid
    references public.employees(id) on delete set null;

create index if not exists idx_repair_orders_service_writer_id
  on public.repair_orders (service_writer_id);

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name='service_writer_id';   -- ⇒ uuid, YES (nullable)
--
--   -- existing ROs are all NULL (no backfill):
--   select count(*) as total,
--          count(service_writer_id) as with_writer
--     from public.repair_orders;               -- ⇒ with_writer = 0 right after apply
-- ============================================================


-- ===== 20260730_announcements.sql =====
-- ============================================================
-- Announcement banner — v1: the `announcements` table.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   The owner broadcasts one short message to the office team, shown as a
--   dismissible banner on the office boards (advisor + owner). The board shows
--   the single most-recent ACTIVE, NON-EXPIRED announcement.
--
-- ⚠️ WRITES ARE SERVICE-ROLE ONLY (same posture as `calls`): anon may SELECT
--   (the banner reads with the board's anon key) but NOT insert/update/delete.
--   Posting/removing goes through api/announcement.js with the service-role key.
--   We do NOT widen anon writes here.
--
-- APPEND-ONLY: an announcement is never deleted. `removed_at` (null = active) is
--   stamped to retire it, mirroring the resolved_at / declined_at convention.
-- ============================================================

create table if not exists public.announcements (
  id             uuid primary key default gen_random_uuid(),
  message        text not null,
  style          text not null default 'normal',   -- 'normal' (info) | 'important' (alert)
  posted_by_name text,                              -- CHAT_IDENTITY.name of the poster
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,                       -- optional auto-hide; null = never expires
  removed_at     timestamptz,                       -- null = active; set = retired (append-only)
  constraint announcements_style_check check (style in ('normal', 'important'))
);

-- The banner's "current active" query: newest active row first.
create index if not exists idx_announcements_active
  on public.announcements (created_at desc) where removed_at is null;

alter table public.announcements enable row level security;

-- anon may SELECT only. No anon insert/update/delete — writes are service-role
-- (api/announcement.js), which bypasses RLS. Idempotent: drop first.
drop policy if exists "Allow anon select on announcements" on public.announcements;
create policy "Allow anon select on announcements"
  on public.announcements
  for select
  to anon
  using (true);

-- Realtime: tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication. Without this the banner never updates live.
-- Idempotent: guarded on pg_publication_tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'announcements'
  ) then
    alter publication supabase_realtime add table public.announcements;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='announcements' order by ordinal_position;
--   -- policies: SELECT only for anon, no insert/update/delete:
--   select policyname, cmd from pg_policies where tablename='announcements';
--   -- in the realtime publication:
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and schemaname='public' and tablename='announcements';  -- 1 row
-- ============================================================


-- ===== 20260730_announcements_audience.sql =====
-- ============================================================
-- Announcement banner — audience targeting. Adds `audience` to `announcements`.
-- Run in the Supabase SQL Editor AFTER 20260730_announcements.sql. Cris runs
-- migrations by hand; the app never runs this.
--
-- WHAT THIS BACKS:
--   "Who sees it" — an announcement targets any combo of the three office roles
--   (manager / advisor / bookkeeping). Each role board shows only announcements
--   whose audience includes its role:
--     manager      -> gm-board.html
--     advisor      -> advisor-board.html
--     bookkeeping  -> bookkeeping-board.html
--   The owner board shows the active one unfiltered (a broadcaster preview) and
--   is where announcements are posted. Tech-floor screens are excluded entirely.
--
-- `audience` is a text[] of role keys. DEFAULT all three, so any pre-existing
-- (pre-audience) row keeps showing to everyone. NOT NULL — the app always sends
-- at least one role (the endpoint rejects an empty audience).
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). No RLS change — reads
-- stay anon SELECT; writes stay service-role (api/announcement.js).
-- ============================================================

alter table public.announcements
  add column if not exists audience text[] not null
    default array['manager', 'advisor', 'bookkeeping'];

-- Role-filtered "current active" query uses array containment (audience @>
-- ARRAY[<role>]); a GIN index serves it.
create index if not exists idx_announcements_audience
  on public.announcements using gin (audience);

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='announcements' and column_name='audience';
--     -- ARRAY, NO (not null), default {manager,advisor,bookkeeping}
--   -- role-filtered read (what the advisor board runs):
--   select id, message, audience from public.announcements
--    where removed_at is null and (expires_at is null or expires_at > now())
--      and audience @> array['advisor']
--    order by created_at desc limit 1;
-- ============================================================


-- ===== 20260730_ro_book_hours.sql =====
-- ============================================================
-- CrisData — BOOK HOURS capture (tech-pay groundwork).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHY: moving techs to flat rate needs a real per-job BOOK-HOURS number in
-- the data. Today flag_hours is filled on ~1 job in 70, so the ALLDATA hours
-- the advisor looks up per vehicle are never persisted. The advisor types the
-- ALLDATA book time by hand on the RO — there is no fixed hours-per-rebuild
-- lookup (hours vary by vehicle). See docs/wiring/flat-rate-hours.md.
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
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app ships with pre-migration fallbacks (writes to the missing columns
-- degrade quietly), so the RO Board keeps working in the window before this
-- is applied.
-- ============================================================

-- ── repair_orders — the pay-only book-hours fields ───────────
alter table public.repair_orders
  add column if not exists book_hours     numeric;                 -- nullable; NULL+na=false = not captured
alter table public.repair_orders
  add column if not exists book_hours_na  boolean not null default false;  -- true = explicit N/A (no labor)

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- repair_orders gained the two columns:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='repair_orders'
--      and column_name in ('book_hours','book_hours_na')
--    order by column_name;
--   -- expect: book_hours(numeric,YES) | book_hours_na(boolean,NO)
-- ============================================================


-- ===== 20260730_ro_work_description.sql =====
-- ============================================================
-- RO "Work Description" (Kevin). Adds `work_description` to repair_orders.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   Internal instructions from the advisor/manager to the mechanic — e.g.
--   "remove the valve body and take it to the bench." Edited on the advisor-board
--   RO detail (directly under Complaint) and shown READ-ONLY on the tech board's
--   job modal (crisdata-techboard.html), fetched by `po`.
--
--   DISTINCT from `advisory_notes` (customer-facing recommendations, which print
--   on the invoice) and from `complaint` (the customer's concern). This column is
--   INTERNAL and does NOT print. Do not merge them.
--
-- SECURITY: no RLS change. repair_orders already allows anon SELECT + UPDATE
--   (20260729_repair_orders_no_delete.sql) — the advisor board edits it directly;
--   the tech board only SELECTs it. Nullable; NULL = nothing written yet.
--
-- SAFE TO RE-RUN: add column if not exists (idempotent). The app degrades quietly
--   if the column is missing (the RO select is `*`; updateRoField swallows 42703).
-- ============================================================

alter table public.repair_orders
  add column if not exists work_description text;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='repair_orders'
--       and column_name = 'work_description';   -- text, YES nullable
-- ============================================================


-- ===== 20260730_todos_priority.sql =====
-- ============================================================
-- To-Do priority (Kevin). Adds `priority` to `todos`.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   Each to-do gets a priority — immediate / high / normal / low (default
--   'normal') — set from a small per-item dropdown on the boards' To-Do list,
--   color-coded (left border) and sorted Immediate-first.
--
-- SECURITY: no RLS change. `todos` is already anon-full-access
--   (20260715_todos.sql), so the boards set priority with a direct anon UPDATE —
--   we do NOT add an endpoint or widen anything. Realtime is unchanged (todos is
--   already in the publication via 20260715_todos_realtime.sql).
--
-- SAFE TO RE-RUN: add column if not exists (idempotent); the CHECK is dropped
--   first. Existing rows get 'normal' via the NOT NULL default.
-- ============================================================

alter table public.todos
  add column if not exists priority text not null default 'normal';

-- Constrain to the four values. Existing rows are all 'normal' (the default), so
-- the constraint validates cleanly. Idempotent: drop first.
alter table public.todos drop constraint if exists todos_priority_check;
alter table public.todos
  add constraint todos_priority_check
  check (priority in ('immediate', 'high', 'normal', 'low'));

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='todos' and column_name='priority';
--     -- text, NO (not null), default 'normal'
--   select conname from pg_constraint where conname='todos_priority_check';   -- 1 row
--   select priority, count(*) from public.todos group by priority;           -- all 'normal' pre-use
-- ============================================================


-- ===== 20260731_change_requests.sql =====
-- ============================================================
-- Requests & Feedback intake — Phase 1: the `change_requests` table.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   The inbound counterpart to the announcement banner. Kevin (Manager),
--   Josh (Advisor) and Bookkeeping submit a Bug/Idea — text and/or an uploaded
--   screenshot — from their own board (a "🚩 Report a change" button in the
--   topbar). The owner triages it from the owner board's "Team Comms" tab
--   (New -> Reviewing -> In progress -> Done / Not now / Won't build) and writes
--   a neutral status note back (owner_note). See docs/wiring/change-requests.md.
--
-- ⚠️ WRITES ARE SERVICE-ROLE ONLY (same posture as `announcements` / `calls`):
--   anon may SELECT (the boards read the triage/list with the anon key) but NOT
--   insert/update/delete. Submitting and triaging go through
--   api/change-request.js with the service-role key. We do NOT widen anon writes.
--
-- SCREENSHOTS reuse the EXISTING private `crisdata-attachments` bucket under a
--   `reports/<uuid>/<file>` prefix (uploaded client-side with the anon key, read
--   via short-lived createSignedUrl) — same trust boundary as invoice images and
--   chat/todo attachments. No new storage bucket or storage policy is needed.
-- ============================================================

create table if not exists public.change_requests (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,                    -- 'bug' | 'idea'
  priority          text not null default 'normal',   -- 'immediate' | 'high' | 'normal' | 'low' (the To-Do scale)
  body              text,                             -- the plain note (nullable; a submission can be screenshot-only)
  screenshot_path   text,                             -- pointer inside crisdata-attachments (reports/<uuid>/<file>); nullable
  screenshot_name   text,                             -- original filename (chip/alt display)
  screenshot_mime   text,                             -- content type
  submitted_by_id   uuid,                             -- employees.id of the submitter (nullable — identity may be unresolved)
  submitted_by_name text,                             -- CHAT_IDENTITY.name of the submitter
  submitted_by_role text,                             -- role inferred from which board it was sent from (a hint, not a boundary)
  context_board     text,                             -- which board: 'manager' | 'advisor' | 'bookkeeping'
  context_view      text,                             -- the active tab/screen (.sidebar-item.active dataset.view)
  context_ro        text,                             -- RO # if one was in scope; nullable
  app_version       text,                             -- deployed build SHA from /api/version at submit time
  user_agent        text,                             -- navigator.userAgent (device/browser)
  status            text not null default 'new',      -- 'new' | 'reviewing' | 'in_progress' | 'done' | 'not_now' | 'wont_build'
  owner_note        text,                             -- latest neutral note back to the submitter (denormalized; surfaced Phase 2)
  owner_note_at     timestamptz,                      -- when owner_note was last written
  created_at        timestamptz not null default now(),

  constraint change_requests_type_check     check (type in ('bug', 'idea')),
  constraint change_requests_priority_check check (priority in ('immediate', 'high', 'normal', 'low')),
  constraint change_requests_status_check   check (status in ('new', 'reviewing', 'in_progress', 'done', 'not_now', 'wont_build')),
  -- must carry SOMETHING: a non-blank note OR a screenshot (mirrors the
  -- endpoint's "body OR screenshot required" rule).
  constraint change_requests_has_content    check (
    (body is not null and length(btrim(body)) > 0) or screenshot_path is not null
  )
);

-- Triage list: open items first, newest first. Plus a submitter index for the
-- Phase 2 client-side "My requests" filter.
create index if not exists idx_change_requests_status     on public.change_requests (status);
create index if not exists idx_change_requests_created     on public.change_requests (created_at desc);
create index if not exists idx_change_requests_submitter   on public.change_requests (submitted_by_id);

alter table public.change_requests enable row level security;

-- anon may SELECT only. No anon insert/update/delete — writes are service-role
-- (api/change-request.js), which bypasses RLS. Idempotent: drop first.
drop policy if exists "Allow anon select on change_requests" on public.change_requests;
create policy "Allow anon select on change_requests"
  on public.change_requests
  for select
  to anon
  using (true);

-- Realtime: tables created in the SQL Editor are NOT auto-added to the
-- supabase_realtime publication. Without this the triage list never updates
-- live. Idempotent: guarded on pg_publication_tables.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'change_requests'
  ) then
    alter publication supabase_realtime add table public.change_requests;
  end if;
end $$;

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='change_requests' order by ordinal_position;
--   -- policies: SELECT only for anon, no insert/update/delete:
--   select policyname, cmd from pg_policies where tablename='change_requests';
--   -- in the realtime publication:
--   select tablename from pg_publication_tables
--     where pubname='supabase_realtime' and schemaname='public' and tablename='change_requests';  -- 1 row
--   -- content constraint rejects an empty submission:
--   insert into public.change_requests (type) values ('bug');   -- should FAIL (has_content)
-- ============================================================


-- ===== 20260731_customer_phones.sql =====
-- ============================================================
-- Phase A of customer dedupe (docs/wiring/customer-dedupe.md §4/§7).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS:
--   A multi-phone model — a customer can have many numbers (e.g. a wife's cell) —
--   so a call from a new number resolves to the existing customer instead of
--   minting a duplicate. This is Phase A only: the table + a one-time backfill.
--
-- ⚠️ ADDITIVE + INERT — nothing changes for anyone:
--   • NOTHING reads customer_phones yet (that is Phase B). This is a snapshot.
--   • customers.phone_primary / phone_secondary stay AUTHORITATIVE and untouched;
--     the existing code keeps writing them, unchanged.
--   • No board/app change, no enforcement. Because it is inert, this one is safe
--     to run during hours (the calm-window rule is for the Phase B/C deploys).
--
-- SYNC DURING TRANSITION (no trigger — by decision): customer_phones is a snapshot
--   here; any drift (a customer created after this backfill) is harmless while
--   nothing reads it. At the Phase B cutover we re-run the idempotent
--   "insert-missing" backfill to catch up, and Phase B dual-writes so the legacy
--   columns and this table stay in lockstep from then on.
-- ============================================================

create table if not exists public.customer_phones (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  phone_norm    text not null,                 -- last-10 digits, the match key
  phone_display text,                           -- as entered/formatted, for display
  label         text,                           -- 'mobile' | 'home' | 'work' | 'wife' | … (free text)
  is_primary    boolean not null default false,
  source        text,                           -- 'backfill_primary' | 'backfill_secondary' | later 'callin' | 'attach'
  created_at    timestamptz not null default now()
);

create index if not exists idx_customer_phones_norm     on public.customer_phones (phone_norm);
create index if not exists idx_customer_phones_customer  on public.customer_phones (customer_id);
-- a number is NOT globally unique (families share a line); but at most one primary per customer:
create unique index if not exists uq_customer_phones_primary on public.customer_phones (customer_id) where is_primary;

-- RLS: mirror `customers` (anon full access) so Phase B can read/write with the board key.
-- (When the parked Step 1½ read/write widen runs, customer_phones is included in its
--  arrays — see office-auth.md §7 — so a logged-in office session isn't blinded to it.)
alter table public.customer_phones enable row level security;
drop policy if exists "Allow anon full access to customer_phones" on public.customer_phones;
create policy "Allow anon full access to customer_phones"
  on public.customer_phones for all to anon using (true) with check (true);

-- ── Backfill: primary numbers ──

-- ── Backfill: secondary numbers (skip when identical to the primary) ──

-- ============================================================
-- VERIFY (run after applying):
--   -- row counts (primaries + distinct secondaries):
--   select count(*) filter (where is_primary) as primaries, count(*) as total from public.customer_phones;
--   -- the one-primary invariant holds (expect 0 rows):
--   select customer_id from public.customer_phones where is_primary group by customer_id having count(*) > 1;
--   -- spot-check a customer resolves to all their numbers:
--   select phone_norm, is_primary, source from public.customer_phones
--     where customer_id = '<some customer id>' order by is_primary desc;
--   -- RLS present (anon full access), one policy:
--   select policyname, cmd, roles from pg_policies where tablename = 'customer_phones';
-- ============================================================

-- ============================================================
-- ROLLBACK (clean — nothing references customer_phones yet):
--   drop table if exists public.customer_phones cascade;
--   -- customers.phone_primary / phone_secondary are untouched; nothing is lost.
-- ============================================================


-- ===== 20260731_employees_auth_user_id.sql =====
-- ============================================================
-- Office-auth rollout — Step 0: link employees to Supabase Auth users.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub) BY HAND.
-- Cris runs migrations manually; the app never runs this.
--
-- WHAT THIS BACKS (docs/wiring/office-auth.md §5, Step 0):
--   The first, INVISIBLE step of adding a real office login (Supabase Auth,
--   email invite) ALONGSIDE today's phone+PIN. This only adds a nullable link
--   from an employee to their auth.users id. Nothing reads it yet.
--
-- ⚠️ ADDITIVE + INVISIBLE — nothing is enforced by this migration:
--   • NO row-level-security change. `employees` keeps its exact current posture
--     (still anon read/update, as today). We do NOT tighten it here.
--   • NO foreign key to auth.users yet. A FK would add a check on employees
--     writes, and employees is still anon-updatable this pass; a plain nullable
--     uuid guarantees zero interaction with any existing writer. (The FK is a
--     later hardening, once employee writes move server-side.)
--   • NO login/board change. Everyone still uses phone+PIN; this column stays
--     NULL for everyone until an auth user is linked by hand (Step 1).
--
-- Multiple NULLs are allowed (everyone starts NULL); the partial unique index
-- enforces at most ONE employee per auth user once links exist.
-- ============================================================

alter table public.employees
  add column if not exists auth_user_id uuid;

create unique index if not exists idx_employees_auth_user_id
  on public.employees (auth_user_id) where auth_user_id is not null;

comment on column public.employees.auth_user_id is
  'Nullable link to a Supabase Auth user for the office-login rollout (office-auth.md). NULL = still phone/PIN. No FK/RLS yet — additive only.';

-- ============================================================
-- LINK ONE PERSON (Step 1, Path A) — run after creating the auth user in the
-- dashboard (Authentication > Users > Add user > Create new user, Auto Confirm).
-- Copy the new User UID and their employee phone (digits only):
--
--   update public.employees set auth_user_id = '<CRISTIAN_AUTH_UID>'
--    where phone = '<CRISTIAN_PHONE_DIGITS>';   -- or: where name = 'Cristian'
-- ============================================================

-- ============================================================
-- VERIFY (run after applying):
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='employees' and column_name='auth_user_id';
--     -- 1 row: uuid, YES (nullable)
--   -- no policy change — employees policies are unchanged by this migration:
--   select policyname, cmd from pg_policies where tablename='employees';
-- ============================================================

-- ============================================================
-- ROLLBACK (instant, reversible — removes the column + index, nothing else):
--   drop index if exists idx_employees_auth_user_id;
--   alter table public.employees drop column if exists auth_user_id;
--   -- (also null out any link you set, though dropping the column covers it)
-- ============================================================


-- ===== 20260801_office_auth_widen_step1_5.sql =====
-- ============================================================================
-- Office Auth — STEP 1½ : anon → authenticated read + write WIDEN
-- migrations/20260801_office_auth_widen_step1_5.sql   (hand-run in Supabase SQL)
-- ============================================================================
-- WHAT: A signed-in office-login session runs as the `authenticated` role for
--   every board tab on the origin. Most of the schema is anon-scoped, so an
--   authenticated session goes BLIND (reads return 0 rows, direct writes fail
--   silently) until sign-out. This migration extends the anon-only policies to
--   ALSO cover `authenticated`, so a signed-in office session sees and operates
--   the boards EXACTLY like the anon (phone+PIN) session does today.
--
-- SAFETY — this file is ADD-ONLY. Verify before running:
--   • Every statement is `create policy ... to authenticated` or a matching
--     `grant ... to authenticated`. No table has RLS enabled/forced here.
--   • The only `drop policy if exists` calls target the NEW `auth …` /
--     `Allow authenticated …` policy names this file creates (for idempotent
--     re-runs) — NEVER an existing `anon`/`public` policy. No existing policy is
--     dropped, narrowed, or altered. Techs/PIN and everything on anon keep working.
--   • Enforces nothing. Changes who-can-do-what by ZERO. It only stops a
--     signed-in session from going blind. (Enforcement / RLS lockdown = Step 2+.)
--
-- SCOPE NOTE (re-audit 2026-08-01, reconciled vs live 0a/0b): the parked §7 list
--   missed board-WRITE gaps (push_subscriptions, tech_whiteboard, shopboard_tables
--   writes; punches INSERT) and storage-object WRITES (4 buckets) — folded in below.
--   Reconciled against the live posture:
--     • `employees` is `public`-scoped (role {public}) → authenticated ALREADY has
--       full read+write. This migration touches employees ZERO. The §5c employees
--       RLS lockdown is what will actually close it, and it MUST land BEFORE anyone
--       besides the owner gets an auth account (today only the owner has one).
--     • `chat_messages`, `core_charges`, `transmissions`, and the `employee-photos`
--       bucket are already {public} / carry their own authenticated policies →
--       omitted (nothing to widen).
--     • `punches` is append-and-read (anon has INSERT + SELECT only, no update/
--       delete — deliberate time-clock integrity) → widened INSERT only.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PART 0 — VERIFY FIRST (read-only). [ALREADY RUN & RECONCILED 2026-08-01.]
--   Left here for the record / re-runs. Re-eyeball if the schema changed since.
-- ════════════════════════════════════════════════════════════════════════════
-- 0a. Table policies (role + cmd) for every object we touch:
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and tablename in (
        'employees','repair_orders','calls','change_requests','announcements','todos',
        'invoice_queue','core_charges','customers','vehicles','ro_line_items','attachments',
        'completed_jobs','chat_conversations','chat_messages','chat_members','chat_reads',
        'ro_payments','ro_diagnostic_codes','rebuild_book_hours','projects','planning_items',
        'parts_orders','marketing_content','invoice_types','expense_categories','invoice_po_lines',
        'payment_methods','shop_settings','dashboard_preferences','tech_whiteboard',
        'shopboard_tables','transmissions','punches','customer_phones','push_subscriptions',
        'shopboard_parking','shopboard_lifts','shopboard_pickup')
 order by tablename, cmd, policyname;
-- 0b. ALL storage.objects policies (confirm anon insert/update/delete per bucket):
select policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
 order by policyname;
-- 0c. feature_adoption grants + bucket public flags:
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'feature_adoption';
select id, public from storage.buckets order by id;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — TABLE READS → authenticated  (additive `for select to authenticated`)
--   Omitted (already {public} or own authenticated policy): employees,
--   chat_messages, core_charges, transmissions.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'repair_orders','calls','change_requests','announcements','todos',
    'invoice_queue','customers','vehicles','ro_line_items','attachments',
    'completed_jobs','chat_conversations','chat_members','chat_reads',
    'ro_payments','ro_diagnostic_codes','rebuild_book_hours','projects','planning_items',
    'parts_orders','marketing_content','invoice_types','expense_categories','invoice_po_lines',
    'payment_methods','shop_settings','dashboard_preferences','tech_whiteboard',
    'shopboard_tables','punches','customer_phones','push_subscriptions'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth read '||t, t);
      execute format('create policy %I on public.%I for select to authenticated using (true)', 'auth read '||t, t);
    end if;
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — TABLE WRITES → authenticated  (mirror the existing anon writes)
--   2a. Direct-anon-write tables → `for all to authenticated` (mirrors
--       `for all to anon`). Includes re-audit gaps: push_subscriptions,
--       tech_whiteboard, shopboard_tables.
--   2b. repair_orders: anon has insert + update only (no delete). Mirror.
--   2c. calls: anon has UPDATE only (rows arrive via CTM webhook / service role;
--       boards update them client-side today). Mirror update only.
--   2d. punches: anon has INSERT + SELECT only (append-and-read; time-clock
--       integrity — no update/delete). Mirror INSERT only (select via PART 1).
--   NOT widened here (unchanged):
--     • change_requests, announcements — submitted/posted via /api/* service role.
--     • employees — already {public}; §5c lockdown closes it, not this file.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'todos','chat_conversations','chat_members','chat_reads','marketing_content',
    'shop_settings','dashboard_preferences','projects','planning_items','parts_orders',
    'customers','vehicles','ro_line_items','attachments','completed_jobs','ro_payments',
    'ro_diagnostic_codes','rebuild_book_hours','invoice_queue','invoice_types','expense_categories',
    'invoice_po_lines','payment_methods','customer_phones',
    'push_subscriptions','tech_whiteboard','shopboard_tables'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth write '||t, t);
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', 'auth write '||t, t);
    end if;
  end loop;
end $$;

drop policy if exists "auth insert repair_orders" on public.repair_orders;
create policy "auth insert repair_orders" on public.repair_orders for insert to authenticated with check (true);
drop policy if exists "auth update repair_orders" on public.repair_orders;
create policy "auth update repair_orders" on public.repair_orders for update to authenticated using (true) with check (true);

drop policy if exists "auth update calls" on public.calls;
create policy "auth update calls" on public.calls for update to authenticated using (true) with check (true);

drop policy if exists "auth insert punches" on public.punches;
create policy "auth insert punches" on public.punches for insert to authenticated with check (true);


-- ════════════════════════════════════════════════════════════════════════════
-- PART 3 — STORAGE READS → authenticated  (private buckets read via createSignedUrl)
--   board-backgrounds + employee-photos are PUBLIC buckets (getPublicUrl) → skip.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare b text;
begin
  foreach b in array array['crisdata-attachments','invoice-images','marketing-content'] loop
    execute format('drop policy if exists %I on storage.objects', 'Allow authenticated read '||b);
    execute format('create policy %I on storage.objects for select to authenticated using (bucket_id = %L)',
                   'Allow authenticated read '||b, b);
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 4 — STORAGE WRITES → authenticated  (mirror anon's REAL per-bucket posture
--   confirmed in 0b). Scoped by bucket_id — add-only.
--     crisdata-attachments : insert            (anon: insert+read only — NO delete)
--     marketing-content    : insert + delete    (anon: insert+read+delete)
--     invoice-images       : insert + update + delete  (anon: full)
--     board-backgrounds    : insert            (anon: insert+read only — NO update; public read)
--   Omitted: employee-photos (bucket policy is ALL {public} → authenticated
--            already has full access — nothing to add).
-- ════════════════════════════════════════════════════════════════════════════
-- crisdata-attachments (insert only)
drop policy if exists "Allow authenticated insert crisdata-attachments" on storage.objects;
create policy "Allow authenticated insert crisdata-attachments" on storage.objects
  for insert to authenticated with check (bucket_id = 'crisdata-attachments');

-- marketing-content (insert + delete)
drop policy if exists "Allow authenticated insert marketing-content" on storage.objects;
create policy "Allow authenticated insert marketing-content" on storage.objects
  for insert to authenticated with check (bucket_id = 'marketing-content');
drop policy if exists "Allow authenticated delete marketing-content" on storage.objects;
create policy "Allow authenticated delete marketing-content" on storage.objects
  for delete to authenticated using (bucket_id = 'marketing-content');

-- invoice-images (insert + update + delete)
drop policy if exists "Allow authenticated insert invoice-images" on storage.objects;
create policy "Allow authenticated insert invoice-images" on storage.objects
  for insert to authenticated with check (bucket_id = 'invoice-images');
drop policy if exists "Allow authenticated update invoice-images" on storage.objects;
create policy "Allow authenticated update invoice-images" on storage.objects
  for update to authenticated using (bucket_id = 'invoice-images') with check (bucket_id = 'invoice-images');
drop policy if exists "Allow authenticated delete invoice-images" on storage.objects;
create policy "Allow authenticated delete invoice-images" on storage.objects
  for delete to authenticated using (bucket_id = 'invoice-images');

-- board-backgrounds (insert only; public bucket read via getPublicUrl)
drop policy if exists "Allow authenticated insert board-backgrounds" on storage.objects;
create policy "Allow authenticated insert board-backgrounds" on storage.objects
  for insert to authenticated with check (bucket_id = 'board-backgrounds');


-- ════════════════════════════════════════════════════════════════════════════
-- PART 5 — feature_adoption (VIEW, granted to anon only) → also grant authenticated
-- ════════════════════════════════════════════════════════════════════════════
grant select on public.feature_adoption to authenticated;


-- ============================================================================
-- ROLLBACK (removes ONLY what this file adds; existing posture untouched)
-- ============================================================================
/*
do $$
declare t text;
begin
  foreach t in array array[
    'repair_orders','calls','change_requests','announcements','todos','invoice_queue',
    'customers','vehicles','ro_line_items','attachments','completed_jobs',
    'chat_conversations','chat_members','chat_reads','ro_payments','ro_diagnostic_codes',
    'rebuild_book_hours','projects','planning_items','parts_orders','marketing_content','invoice_types',
    'expense_categories','invoice_po_lines','payment_methods','shop_settings','dashboard_preferences',
    'tech_whiteboard','shopboard_tables','punches','customer_phones','push_subscriptions'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth read '||t, t);
      execute format('drop policy if exists %I on public.%I', 'auth write '||t, t);
    end if;
  end loop;
end $$;
drop policy if exists "auth insert repair_orders" on public.repair_orders;
drop policy if exists "auth update repair_orders" on public.repair_orders;
drop policy if exists "auth update calls" on public.calls;
drop policy if exists "auth insert punches" on public.punches;
do $$
declare b text;
begin
  foreach b in array array['crisdata-attachments','invoice-images','marketing-content'] loop
    execute format('drop policy if exists %I on storage.objects', 'Allow authenticated read '||b);
  end loop;
end $$;
drop policy if exists "Allow authenticated insert crisdata-attachments" on storage.objects;
drop policy if exists "Allow authenticated insert marketing-content" on storage.objects;
drop policy if exists "Allow authenticated delete marketing-content" on storage.objects;
drop policy if exists "Allow authenticated insert invoice-images" on storage.objects;
drop policy if exists "Allow authenticated update invoice-images" on storage.objects;
drop policy if exists "Allow authenticated delete invoice-images" on storage.objects;
drop policy if exists "Allow authenticated insert board-backgrounds" on storage.objects;
revoke select on public.feature_adoption from authenticated;
*/


-- ===== 20260807_feature_book_hours_flag.sql =====
-- ============================================================
-- CrisData — FEATURE FLAG: Book Hours master on/off switch.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one owner-controlled master switch for the whole Book Hours feature,
-- stored as a boolean column on the existing single-row shop_settings table
-- (same home + same anon RLS as show_tech_on_ro / tax_rate / card_fee_pct —
-- NO new table, NO RLS change needed).
--
-- DEFAULT OFF (false): with the flag off the advisor board behaves exactly as
-- it did before the Book Hours feature — the Book Hours field is hidden and the
-- "enter hours / N/A before leaving Estimate" gate does NOT block. The board
-- reads the flag on load and FAILS SAFE to OFF if the settings read fails.
--
-- EXTENSIBLE: this is the first entry in a "Features" switchboard (owner-only
-- Settings pane). Each future master switch (e.g. the Phase 3 manager-approval
-- toggle) is just another boolean column here + one line in the app's
-- FEATURE_FLAGS registry — no schema redesign.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS): safe to paste / re-run.
-- The app ships a pre-migration fallback (getShopSettings() returns
-- feature_book_hours=false when the column/row is missing), so the boards keep
-- working — feature OFF — in the window before this is applied.
-- ============================================================

-- ── shop_settings — the Book Hours master switch ─────────────
alter table public.shop_settings
  add column if not exists feature_book_hours boolean not null default false;

-- No RLS / policy / realtime changes: shop_settings is already anon-full-access
-- (mirrors the existing pattern) and already in the realtime publication.

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) the column exists with the right type + default:
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_book_hours';
--   -- expect: feature_book_hours | boolean | NO | false
--
-- (b) the single shop_settings row picked up the default (still OFF):
--   select id, feature_book_hours from public.shop_settings;
--   -- expect one row, feature_book_hours = false
-- ============================================================


-- ===== 20260807_packages.sql =====
-- ============================================================
-- CrisData — PACKAGES: package unit prices + a "Package" RO line type.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: a shop-set list of package units (e.g. "6L80" = $4950 set price,
-- 6.5 default R&R hours) that the RO builder drops onto a new "Package" line
-- type. The set price is the CUSTOMER price (qty 1, taxable by default,
-- editable per job). The R&R hours are TECH-PAY only (pull/install credit) —
-- they never enter the money math. Whole feature is behind an owner switch
-- (feature_packages), default OFF.
--
-- PRINCIPLE (same as book_hours): price and pay are separate.
--   • package line price  = ro_line_items.unit_price (qty fixed at 1)
--   • package line pay     = ro_line_items.rr_hours (never summed into totals)
-- The R&R-hours field only shows when the Book Hours feature is ON.
--
-- ADDITIVE + idempotent. The app ships pre-migration fallbacks (the Packages
-- settings pane reads empty, the Package line type only appears when the switch
-- is ON, and rr_hours / package_unit_id writes degrade quietly on a missing
-- column), so boards keep working — feature OFF — before this is applied.
--
-- ⚠ STEP 1 MUST RUN ON ITS OWN. `alter type ... add value` cannot run inside a
-- transaction block. Run STEP 1 by itself first, then run STEP 2+ together.
-- ============================================================

-- ── STEP 1 — extend the ro_line_type enum (RUN THIS ALONE FIRST) ─

-- ============================================================
-- ── STEP 2 — tables, columns, switch (run together after STEP 1) ─
-- ============================================================

-- 2a. package_units — the shop-set list the RO dropdown reads.
create table if not exists public.package_units (
  id uuid primary key default gen_random_uuid(),

  unit_code       text    not null,          -- the label shown in the dropdown, e.g. "6L80"
  set_price       numeric not null default 0, -- CUSTOMER set price (qty 1)
  default_rr_hours numeric,                    -- TECH-PAY default R&R hours (nullable)
  active          boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_package_units_active on public.package_units (active);

-- group_label: an optional organizing tag (units that share a label are shown
-- together and can be bulk-priced in Settings). Additive so this file stays
-- one migration even though the column was added after the table was drafted;
-- each unit keeps its own set_price — group_label is just a grouping key.
alter table public.package_units
  add column if not exists group_label text;

-- keep updated_at honest (reuses the shared helper)
create or replace function public.crisdata_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_package_units_updated_at on public.package_units;
create trigger trg_package_units_updated_at
  before update on public.package_units
  for each row execute function public.crisdata_set_updated_at();

-- 2b. RLS — anon full access (app-level auth, mirrors every CrisData table).
alter table public.package_units enable row level security;
drop policy if exists "Allow anon full access to package_units" on public.package_units;
create policy "Allow anon full access to package_units"
  on public.package_units for all to anon using (true) with check (true);

-- 2c. REALTIME — SQL-Editor tables aren't auto-added to the publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'package_units'
  ) then
    alter publication supabase_realtime add table public.package_units;
  end if;
end $$;

-- 2d. ro_line_items — the per-line package fields.
--   • package_unit_id: which unit was chosen (nullable; set null if the unit is
--     later deleted — the line keeps its stored description/price/hours).
--   • rr_hours: the effective TECH-PAY R&R hours for THIS job (resolve-and-store
--     from the unit's default, editable; NEVER enters the price math).
alter table public.ro_line_items
  add column if not exists package_unit_id uuid references public.package_units(id) on delete set null;
alter table public.ro_line_items
  add column if not exists rr_hours numeric;

-- 2e. shop_settings — the owner master switch (default OFF, fail-safe).
alter table public.shop_settings
  add column if not exists feature_packages boolean not null default false;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) enum gained 'package':
--   select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
--    where t.typname='ro_line_type' order by e.enumsortorder;
--   -- expect: labor, parts, fee, shop_supply, hazmat, package
--
-- (b) package_units exists + is EMPTY, with RLS + realtime + group_label:
--   select count(*) from public.package_units;   -- expect 0
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='package_units'
--      and column_name='group_label';            -- expect: group_label
--   select policyname from pg_policies where tablename='package_units';
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='package_units';
--
-- (c) ro_line_items gained the two columns:
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='ro_line_items'
--      and column_name in ('package_unit_id','rr_hours') order by column_name;
--   -- expect: package_unit_id(uuid) | rr_hours(numeric)
--
-- (d) shop_settings gained the switch (default false):
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_packages';
--   -- expect: feature_packages | boolean | false
--   select id, feature_packages from public.shop_settings;   -- expect one row, false
-- ============================================================


-- ===== 20260807_ro_closed_at.sql =====
-- ============================================================
-- CrisData — repair_orders.closed_at (STABLE completion stamp for pay).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHY: the weekly per-tech Billed-Hrs rollup must bucket each RO's hours by a
-- timestamp that is set ONCE and never moves — billed hours are a pay-driving
-- number. Until now the rollup used repair_orders.updated_at, which drifts
-- (editing a closed RO later shifts its hours into a later week).
--
-- WHAT: an additive repair_orders.closed_at timestamptz, stamped the FIRST time
-- an RO enters status 'invoice' or 'closed' and NEVER overwritten — enforced by
-- a BEFORE trigger, so it can't be bypassed by any writer (Stage select, kanban
-- drag, archive, anything). (completed_jobs.picked_up_at was considered and does
-- NOT fit: it only exists for picked-up jobs, so invoice-status ROs — work done,
-- billed, not yet collected — would be dropped, and it links by `po` with
-- possible duplicate rows, not cleanly per-RO.)
--
-- SEMANTICS: closed_at = "when the work was first billed/closed", regardless of
-- customer payment. A job invoiced then edited stays in its first week. A job
-- reverted to estimate keeps its stamp but is excluded by the rollup's status
-- filter until it is invoice/closed again (which won't re-stamp).
--
-- ADDITIVE + idempotent. No RLS change (repair_orders already has anon +
-- authenticated policies; the new column inherits them). The app degrades
-- quietly pre-apply (the rollup falls back to updated_at when closed_at is
-- missing).
-- ============================================================

-- ── 1. the column ────────────────────────────────────────────
alter table public.repair_orders
  add column if not exists closed_at timestamptz;   -- set once when first invoice/closed; never moves

-- ── 2. one-time backfill for ROs already invoice/closed ──────
-- These were billed/closed before the stamp existed; updated_at is the best
-- available seed. Runs BEFORE the trigger is created so nothing interferes.
-- Going forward the trigger stamps closed_at once and it never moves.
update public.repair_orders
   set closed_at = updated_at
 where status in ('invoice', 'closed') and closed_at is null;

-- ── 3. set-once trigger — stamp the FIRST time status hits invoice/closed ─
create or replace function public.crisdata_stamp_ro_closed_at()
returns trigger language plpgsql as $$
begin
  -- only stamp when it isn't already set (never overwrite) and the row is
  -- (becoming) invoice/closed. Works on INSERT and UPDATE.
  if new.closed_at is null and new.status in ('invoice', 'closed') then
    new.closed_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_repair_orders_closed_at on public.repair_orders;
create trigger trg_repair_orders_closed_at
  before insert or update on public.repair_orders
  for each row execute function public.crisdata_stamp_ro_closed_at();

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) the column exists:
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='repair_orders' and column_name='closed_at';
--   -- expect: closed_at | timestamp with time zone
--
-- (b) backfill covered every invoice/closed RO:
--   select count(*) from public.repair_orders
--    where status in ('invoice','closed') and closed_at is null;   -- expect 0
--
-- (c) the trigger is installed:
--   select tgname from pg_trigger where tgname='trg_repair_orders_closed_at';
--
-- (d) set-once holds — moving an already-stamped RO's status does NOT change
--     closed_at (spot-check one po before/after a status edit).
-- ============================================================


-- ===== 20260807_ro_line_tech.sql =====
-- ============================================================
-- CrisData — ro_line_items.line_tech_id (per-line tech credit).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive column so a LABOR line's hours can credit to a specific
-- technician when a 2nd tech did one piece (e.g. a radiator). NULL = inherit the
-- RO's assigned technician (repair_orders.technician). This is tech-PAY data —
-- it never touches price/tax math.
--
-- ROLLUP: a tech's weekly Billed Hrs = Σ labor-line hours credited to them
-- (line_tech_id when set, else the RO's assigned tech) + Σ package R&R hours on
-- ROs where they are the assigned tech. All behind the Book Hours feature switch.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). ro_line_items already
-- carries anon + authenticated RLS policies (office-auth widen,
-- 20260801_office_auth_widen_step1_5.sql), so NO policy / RLS change is needed —
-- the new column inherits the table's grants. The app degrades quietly if this
-- isn't applied yet (a labor line saves without its per-line tech; missing-column
-- write is caught and retried without line_tech_id).
-- ============================================================

alter table public.ro_line_items
  add column if not exists line_tech_id uuid references public.employees(id) on delete set null;
  -- NULL = credit the RO's assigned technician; a value = credit that employee

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_line_items'
--      and column_name='line_tech_id';
--   -- expect: line_tech_id | uuid | YES
--
--   -- FK is in place (references employees):
--   select constraint_name from information_schema.table_constraints
--    where table_schema='public' and table_name='ro_line_items'
--      and constraint_type='FOREIGN KEY';
-- ============================================================


-- ===== 20260807_ro_line_unit_cost.sql =====
-- ============================================================
-- CrisData — ro_line_items.unit_cost (parts cost / margin, INTERNAL).
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive column so a PART line can store the shop's COST alongside
-- the customer SELL price. The Add/Edit-Line pop-up shows margin (Sell − Cost,
-- and %) live while editing. Cost is INTERNAL — it is never shown to the
-- customer and never printed on the invoice (printRo reads description /
-- part_number / quantity / unit_price only, never unit_cost).
--
-- PRICE/MATH UNCHANGED: totals still = Σ(quantity × unit_price) + tax. unit_cost
-- is a separate, nullable field that never enters the money math.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). ro_line_items already
-- carries anon + authenticated RLS policies (office-auth widen,
-- 20260801_office_auth_widen_step1_5.sql), so NO policy / RLS change is needed —
-- the new column inherits the table's grants. The app degrades quietly if this
-- isn't applied yet (a parts line saves without its cost; missing-column write
-- is caught and retried without unit_cost).
-- ============================================================

alter table public.ro_line_items
  add column if not exists unit_cost numeric;   -- shop cost per unit (INTERNAL); nullable

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='ro_line_items'
--      and column_name='unit_cost';
--   -- expect: unit_cost | numeric | YES
-- ============================================================


-- ===== 20260808_advisor_commission.sql =====
-- ============================================================
-- CrisData — Advisor Commission (Hours Engine Part 2)
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: a per-ADVISOR weekly gross-profit rollup + commission widgets, behind
-- their own owner feature switch (default OFF). This migration adds ONLY
-- additive, nullable columns + one boolean flag — no data is rewritten, nothing
-- is dropped, and NO RLS/policy change is needed:
--   • shop_settings  — single anon-full-access row (see settings.md §1); new
--                      columns inherit its grants.
--   • employees      — anon + authenticated RLS (office-auth widen); inherits.
--   • package_units  — anon-full-access + realtime (see packages.md §2); inherits.
--
-- Everything fails safe: the reader treats a missing column / failed read as
-- feature OFF and falls back to code defaults, so a board on the un-migrated
-- schema behaves exactly like today.
--
-- GROSS PROFIT (the pay basis), locked with the owner:
--   advisor GP per RO = Σ labor-line revenue (labor ≈ pure margin)
--                     + Σ parts-line markup (unit_price − unit_cost)
--                     + Σ package-line margin (unit_price − package unit_cost)
--   Shop Supply / Hazmat / Fee lines are EXCLUDED (owner decision 2026-08-08).
--   When a parts/package line has no real cost yet, GP falls back to
--   price × the shop-wide assumed-margin % below (STEP 4) — a real cost on the
--   line always overrides. Package per-unit cost lives on package_units (STEP 3).
--
-- PAYOUT (locked): base $1,000 / full 40-hr week + 2.5% of THAT week's GP,
--   weekly-final (no monthly true-up, no clawbacks). Base + % are per-advisor
--   (STEP 2); null → the code default ($1,000 / 2.5%). Manny's plan is the
--   default — nothing is hardcoded to one person.
-- ============================================================

-- ── STEP 1 — the master switch (3rd FEATURE_FLAGS entry), default OFF ─────────
alter table public.shop_settings
  add column if not exists feature_advisor_commission boolean not null default false;

-- ── STEP 2 — per-advisor pay plan (nullable → code default $1,000/wk, 2.5%) ───
alter table public.employees
  add column if not exists commission_base_weekly numeric;   -- $/full week; null → default 1000
alter table public.employees
  add column if not exists commission_gp_pct       numeric;   -- % of weekly GP; null → default 2.5

-- ── STEP 3 — package cost so package GP is derivable ─────────────────────────
-- Parts already carry ro_line_items.unit_cost. A package line is a bundled set
-- price with no per-line cost, so the shop's rebuild cost lives per UNIT here;
-- package GP = line unit_price − this unit_cost (fallback to STEP 4 % until set).
alter table public.package_units
  add column if not exists unit_cost numeric;   -- INTERNAL rebuild cost per unit; nullable

-- ── STEP 4 — shop-wide assumed-margin fallbacks (used ONLY when a line has no ─
-- real cost, so legacy rows aren't systematically wrong). A real cost always
-- overrides. Stored as fractions (0.40 = 40%). Null → code default.
alter table public.shop_settings
  add column if not exists parts_margin_pct   numeric;   -- assumed GP fraction on parts w/o cost
alter table public.shop_settings
  add column if not exists package_margin_pct numeric;   -- assumed GP fraction on packages w/o cost

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public'
--      and ( (table_name='shop_settings' and column_name in
--               ('feature_advisor_commission','parts_margin_pct','package_margin_pct'))
--         or (table_name='employees' and column_name in
--               ('commission_base_weekly','commission_gp_pct'))
--         or (table_name='package_units' and column_name='unit_cost') )
--    order by table_name, column_name;
--   -- expect 6 rows, all is_nullable=YES except feature_advisor_commission (NO, default false)
-- ============================================================


-- ===== 20260808_bk_ro_detail_flag.sql =====
-- ============================================================
-- CrisData — Bookkeeping per-RO drill-down feature switch.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT: one additive boolean on the single shop_settings row — the master
-- on/off switch for the Bookkeeping board's per-RO drill-down (Income / Open-RO
-- tiles → a per-RO detail with the original RO on the left and its matched parts
-- receipts + "profit over parts" on the right). Default OFF, so the board renders
-- exactly like today until an owner flips it on (owner Features pane, 4th flag).
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). shop_settings is the single
-- anon-full-access row (see settings.md §1); the new column inherits its grants —
-- NO RLS/policy change. Reader fails safe to OFF (missing column / failed read →
-- false), so a board on the un-migrated schema behaves exactly like today.
--
-- READ-ONLY FEATURE: the drill-down only READS invoice_queue / invoice_po_lines /
-- repair_orders / ro_line_items (+ signed reads of the invoice-images bucket). It
-- writes nothing. No other schema change is needed.
-- ============================================================

alter table public.shop_settings
  add column if not exists feature_bk_ro_detail boolean not null default false;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_bk_ro_detail';
--   -- expect: feature_bk_ro_detail | boolean | false
-- ============================================================


-- ===== 20260809_costlayer_parts_library.sql =====
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
--   • parts_library' anon RLS + policy + realtime MIRROR public.package_units'
--     anon posture (see 20260807_packages.sql 2b/2c) — anon full access,
--     app-level auth. NO broader than anon.
--   • PLUS an `authenticated` twin policy (same access, no broader): a signed-in
--     office owner runs as `authenticated`, so anon-only would leave them blind.
--     This mirrors the 2026-08-01 office-auth widen. (On the live DB this was
--     added separately by 20260809_costlayer_rls_authenticated_fix.sql.)
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

-- RLS — anon full access (mirrors public.package_units' anon posture). No broader.
alter table public.parts_library enable row level security;
drop policy if exists "Allow anon full access to parts_library" on public.parts_library;
create policy "Allow anon full access to parts_library"
  on public.parts_library for all to anon using (true) with check (true);

-- Office-auth: a signed-in owner runs as the `authenticated` role (Supabase Auth
-- via office-login.html — see docs/wiring/office-auth.md + the 2026-08-01 widen
-- `20260801_office_auth_widen_step1_5.sql`). Add the authenticated twin of the
-- anon policy — same access, no broader — or the signed-in owner goes blind
-- (SELECT → 0 rows, INSERT → "violates row-level security policy").
-- NOTE: the LIVE DB shipped this table anon-only first; the authenticated policy
-- was added there by 20260809_costlayer_rls_authenticated_fix.sql. This inline
-- copy keeps a FRESH rebuild correct.
drop policy if exists "auth write parts_library" on public.parts_library;
create policy "auth write parts_library"
  on public.parts_library for all to authenticated using (true) with check (true);

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


-- ===== 20260809_costlayer_rls_authenticated_fix.sql =====
-- ============================================================
-- CrisData — COST LAYER RLS FIX: parts_library (+ unit_parts) → authenticated.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- ── ROOT CAUSE ──────────────────────────────────────────────
-- The office owner (Cristian) is signed in via office-login.html (Supabase
-- Auth), so every board tab's browser client runs as the **`authenticated`**
-- Postgres role — NOT `anon`. (OfficeIdentity.resolve reads db.auth.getSession();
-- see docs/wiring/office-auth.md — "STEP 1½ SHIPPED".)
--
-- On 2026-08-01, `20260801_office_auth_widen_step1_5.sql` widened a FIXED LIST of
-- existing tables from anon-only to ALSO cover `authenticated` (adding
-- `for all to authenticated using(true) with check(true)` per table). Any table
-- created AFTER that widen must add its own authenticated policy or the signed-in
-- owner goes blind (SELECT → 0 rows, INSERT/UPDATE → "new row violates
-- row-level security policy").
--
-- `parts_library` (Step 2b, created 2026-08-09) shipped with ONLY a `to anon`
-- policy → the authenticated owner has no applicable policy → INSERT is
-- RLS-blocked. (`unit_parts` already carries an authenticated policy, which is
-- why adding recipe parts works — parts_library was the one left out.) This is a
-- ROLE mismatch, not a missing GRANT: a missing grant would say "permission
-- denied for table", not "violates row-level security policy".
--
-- ── FIX (ADD-ONLY — mirrors the 2026-08-01 widen exactly) ───
-- Add a `for all to authenticated using(true) with check(true)` policy to
-- parts_library — the 1:1 authenticated twin of its existing `to anon` policy,
-- no broader. unit_parts gets the same statement idempotently (belt-and-suspenders:
-- it already works, so this just pins that policy into version control under the
-- widen's canonical `auth write …` name).
--
-- SAFETY:
--   • ADD-ONLY. The only `drop policy if exists` targets the NEW `auth write …`
--     names created here (for idempotent re-runs) — NEVER an existing anon policy.
--     No existing policy is dropped, narrowed, or altered; no RLS is enabled/forced;
--     no GRANT and no DATA is touched. Anon (phone/PIN) sessions keep working.
--   • Scope is exactly the two cost-layer tables — no other table is touched.
--   • Authenticated access = the SAME `using(true)/with check(true)` the anon
--     policy already grants. No wider than anon.
-- ============================================================

-- parts_library — the broken table: add its authenticated twin.
drop policy if exists "auth write parts_library" on public.parts_library;
create policy "auth write parts_library"
  on public.parts_library for all to authenticated using (true) with check (true);

-- unit_parts — idempotent belt-and-suspenders (already works for authenticated;
-- this pins the policy into a tracked migration under the widen's canonical name).
drop policy if exists "auth write unit_parts" on public.unit_parts;
create policy "auth write unit_parts"
  on public.unit_parts for all to authenticated using (true) with check (true);

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) both tables now carry an anon AND an authenticated "for all" policy:
--   select tablename, policyname, cmd, roles, qual, with_check
--     from pg_policies
--    where schemaname='public' and tablename in ('parts_library','unit_parts')
--    order by tablename, roles;
--   -- expect, per table: one {anon} row + one {authenticated} row, cmd ALL,
--   --   qual=true / with_check=true.
--
-- (b) as the signed-in owner (authenticated), inserting a library item now
--     succeeds in the app: Build Sheet → Parts catalog → Add item.
-- ============================================================


-- ===== 20260809_costlayer_unit_parts_rates.sql =====
-- ============================================================
-- CrisData — COST LAYER (Cost & Profit Step 2a): per-unit parts recipes +
-- three shop-level standard-cost rates.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- WHAT this adds (ADD-ONLY — nothing is renamed, altered, or dropped):
--   1. public.unit_parts — one row per part line in a package unit's rebuild
--      recipe (name, part #, vendor, cost, qty), FK to package_units.
--   2. Three numeric columns on the single shop_settings row — the standard-cost
--      rate placeholders the owner tunes on the Build Sheet → People & rates tab.
--
-- SAFETY (the add-only / mirror-anon check):
--   • unit_parts' RLS + policy + grants MIRROR public.package_units EXACTLY —
--     anon full access, app-level auth, the same posture the app already uses for
--     every settings list. NO broader access than package_units.
--   • Everything is `IF NOT EXISTS` / additive. Re-running is safe. No existing
--     table, column, policy, RO, or package_units field is touched.
--   • The app ships pre-migration fallbacks: the recipe editor reads empty and the
--     rates fall back to their defaults (advisor 2.5% / R&R $0 / rebuilder $0)
--     until this runs, so the boards keep working before it is applied.
-- ============================================================

-- ── 1. unit_parts — per-unit rebuild recipe lines ───────────────
create table if not exists public.unit_parts (
  id               uuid primary key default gen_random_uuid(),
  package_unit_id  uuid not null references public.package_units(id) on delete cascade,
  name             text,
  part_no          text,
  vendor           text,          -- free text for now (shared vendor list is Step 2b)
  unit_cost        numeric,       -- $ per part
  qty              numeric,       -- how many of this part per unit built
  created_at       timestamptz not null default now()
);

create index if not exists idx_unit_parts_unit on public.unit_parts (package_unit_id);

-- RLS — anon full access, MIRRORING public.package_units exactly (see
-- 20260807_packages.sql 2b). App-level auth; no broader access.
alter table public.unit_parts enable row level security;
drop policy if exists "Allow anon full access to unit_parts" on public.unit_parts;
create policy "Allow anon full access to unit_parts"
  on public.unit_parts for all to anon using (true) with check (true);

-- REALTIME — mirror package_units (2c). SQL-Editor tables aren't auto-added to
-- the publication; the app doesn't subscribe today, but keep the mirror faithful.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'unit_parts'
  ) then
    alter publication supabase_realtime add table public.unit_parts;
  end if;
end $$;

-- ── 2. shop_settings — three standard-cost rate placeholders ────
-- Defaults fabricate nothing: advisor % = 2.5 (of sale), R&R rate = $0/hr,
-- rebuilder = $0/unit. The owner tunes them on Build Sheet → People & rates.
-- These are for the Build Sheet's standard-cost estimate ONLY — they are NOT
-- wired to the live Advisor Commission engine.
alter table public.shop_settings
  add column if not exists std_advisor_pct numeric not null default 2.5;   -- % of sale
alter table public.shop_settings
  add column if not exists std_rr_rate     numeric not null default 0;      -- $/flagged hour
alter table public.shop_settings
  add column if not exists rebuilder_cost  numeric not null default 0;      -- $/unit built

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
-- (a) unit_parts exists + EMPTY, with the mirrored anon policy + realtime:
--   select count(*) from public.unit_parts;                       -- expect 0
--   select policyname, cmd, roles from pg_policies
--    where tablename='unit_parts';                                -- expect the anon "for all" policy
--   select tablename from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='unit_parts'; -- expect one row
--   -- confirm it mirrors package_units (same policy shape):
--   select tablename, policyname, cmd, roles, qual, with_check
--     from pg_policies where tablename in ('package_units','unit_parts') order by tablename;
--
-- (b) shop_settings gained the three rate columns with the right defaults:
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name in ('std_advisor_pct','std_rr_rate','rebuilder_cost')
--    order by column_name;
--   -- expect: rebuilder_cost|numeric|0 , std_advisor_pct|numeric|2.5 , std_rr_rate|numeric|0
--   select id, std_advisor_pct, std_rr_rate, rebuilder_cost from public.shop_settings;
-- ============================================================


-- ===== 20260809_feature_cost_profit_flag.sql =====
-- ============================================================
-- CrisData — "Cost & Profit" feature switch (Step 1: frame + relocation only).
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
-- Cris runs migrations by hand — the app never runs this.
--
-- ⚠️ SUPERSEDED / OPTIONAL (2026-08-09): the feature switch was removed the same
-- day — the Cost & Profit group now ships unconditionally (no toggle). No app
-- code reads shop_settings.feature_cost_profit anymore. You do NOT need to run
-- this; if you already ran it, the column is harmless and stays (dormant,
-- additive — intentionally not dropped). Kept only as history.
--
-- WHAT: one additive boolean on the single shop_settings row — the master
-- on/off switch for the "Cost & Profit" sidebar group (Cockpit + Build Sheet) on
-- the Owner and Bookkeeping boards. When ON it also moves "Rebuild Units &
-- Prices" out of Settings into Build Sheet → Units (the Settings pane becomes a
-- one-line "Moved to the Build Sheet" redirect). Default OFF, so both boards look
-- exactly like today until an owner flips it on (owner Features pane, 5th flag).
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS). shop_settings is the single
-- anon-full-access row (see settings.md §1); the new column inherits its grants —
-- NO RLS/policy change. Reader fails safe to OFF (missing column / failed read →
-- false), so a board on the un-migrated schema behaves exactly like today.
--
-- NO OTHER SCHEMA CHANGE: Step 1 is frame + relocation only. It does NOT touch
-- package_units (the Units editor is the SAME editor, just relocated) or any RO.
-- Parts recipes / vendor costs / profit math arrive in Steps 2 and 3.
-- ============================================================

alter table public.shop_settings
  add column if not exists feature_cost_profit boolean not null default false;

-- ============================================================
-- VERIFY (run separately, after applying)
-- ============================================================
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='shop_settings'
--      and column_name='feature_cost_profit';
--   -- expect: feature_cost_profit | boolean | false
-- ============================================================


-- ============================================================================
-- RLS NORMALIZATION — every public table gets BOTH {anon} and {authenticated}
-- full-access policies (permissive, FOR ALL, USING true / WITH CHECK true).
-- Idempotent: only adds a standard policy for a role when the table has no
-- permissive FOR ALL policy for it yet.
-- ============================================================================
do $$
declare r record; role_name text; pol_name text;
begin
  for r in
    select c.relname as tbl from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.tbl);
    foreach role_name in array array['anon','authenticated'] loop
      if not exists (
        select 1 from pg_policies p
        where p.schemaname='public' and p.tablename=r.tbl
          and p.cmd='ALL' and p.permissive='PERMISSIVE'
          and role_name = any(p.roles)
      ) then
        pol_name := format('staging_%s_full_access_%s', role_name, r.tbl);
        execute format('create policy %I on public.%I for all to %I using (true) with check (true)',
                       pol_name, r.tbl, role_name);
      end if;
    end loop;
  end loop;
end $$;

commit;
