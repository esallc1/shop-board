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

create policy "Allow anon full access to chat_reads"
  on public.chat_reads
  for all
  to anon
  using (true)
  with check (true);
