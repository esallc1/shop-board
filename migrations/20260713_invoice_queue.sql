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

insert into storage.buckets (id, name, public)
values ('invoice-images', 'invoice-images', false)
on conflict (id) do nothing;

create policy "Allow anon insert to invoice-images"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'invoice-images');

create policy "Allow anon read invoice-images"
  on storage.objects for select
  to anon
  using (bucket_id = 'invoice-images');
