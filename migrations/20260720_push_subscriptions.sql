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

create policy "Allow anon full access to push_subscriptions"
  on public.push_subscriptions
  for all
  to anon
  using (true)
  with check (true);
