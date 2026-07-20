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
    insert into public.chat_conversations (type, title, created_by_name, created_by_role)
    values ('group', 'Office', v_owner, 'owner')
    returning id into v_office_id;
  end if;

  -- add the four office members (skip any role that is currently unfilled)
  insert into public.chat_members (conversation_id, member_name, member_role)
  select v_office_id, x.member_name, x.member_role
  from (values
    (v_owner,       'owner'),
    (v_manager,     'manager'),
    (v_advisor,     'advisor'),
    (v_bookkeeping, 'bookkeeping')
  ) as x(member_name, member_role)
  where x.member_name is not null
  on conflict (conversation_id, member_name) do nothing;

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
      insert into public.chat_conversations (type, dm_key, created_by_name, created_by_role)
      values ('dm', v_dm_key, v_name_a, v_role_a)
      returning id into v_conv_id;
    end if;

    insert into public.chat_members (conversation_id, member_name, member_role) values
      (v_conv_id, v_name_a, v_role_a),
      (v_conv_id, v_name_b, v_role_b)
    on conflict (conversation_id, member_name) do nothing;

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
