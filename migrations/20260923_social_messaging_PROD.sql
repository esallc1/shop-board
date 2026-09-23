-- ============================================================================
-- Messenger → Advisor inbox tray — STEP 1: the database. Two tables, the shared
-- staff check, and the one write function.
-- PROD run (hygemiszxwmyrkmhbjub / www / board.leetransmissionshop.com).
-- -- Sandbox has its own file: 20260923_social_messaging_SANDBOX.sql — RUN THAT ONE FIRST.
-- Wiring: docs/wiring/meta-webhook.md (storage lands with step 2), office-auth.md (is_staff).
--
-- WHAT.
--   social_threads  — one row per Facebook person per Page (channel + page_id + psid).
--                     channel already allows 'instagram'; nothing uses it yet.
--   social_messages — one row per message; `mid` UNIQUE = a re-delivery is a no-op.
--   is_staff()      — "is the signed-in user an ACTIVE CrisData employee?" The shared
--                     check security Phase 3 will reuse for the Tier-A tables.
--   social_record_message(...) — the ONLY writer of new messages. Server key only.
--
-- WHO CAN DO WHAT.
--   anon           — nothing. Not a read, not a write, not the function.
--   authenticated  — SELECT only, and only when is_staff() is true. "Logged in" is NOT
--                    enough: KiKi shares prod's auth.users, so a KiKi login is also
--                    `authenticated` (api/_lib/require-user.js has the same warning).
--   service_role   — the webhook + api/messenger.js. All writes.
--   There are NO insert/update/delete policies: the browser never writes these rows.
--
-- THE OVERWRITE RULE (the ctm-webhook upsert trap). social_record_message never
-- writes done_at, done_by, customer_id, linked_at or linked_by — those are a person's.
-- "Done" is not reset by a new message; the tray shows a thread when
--   done_at is null OR last_inbound_at > done_at
-- so a newer inbound message brings it back by being newer. sent_by / send_status /
-- display_name are only ever FILLED when empty (the echo-before-send race).
--
-- DELETION (data-deletion.html): deleting a social_threads row deletes its messages
-- (on delete cascade). Deleting a customer only unlinks the thread (set null).
--
-- Supabase's default privileges GRANT new public tables and functions to anon and
-- authenticated. Every revoke below undoes that — do not remove them.
--
-- SELF-GUARDING (staging-db.md §8): refuses to run on the wrong or an unstamped
-- project. One transaction: a failed guard aborts everything. Safe to re-run.
-- ============================================================================

begin;

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP. Stamp this database first (staging-db.md §8).'; end if;
  if v not like 'PROD%' then raise exception 'WRONG PROJECT: % — this is the PROD file, refusing', v; end if;
  raise notice 'social messaging migration running on %', v;
end $$;

-- ── 1. Threads ──────────────────────────────────────────────────────────────
create table if not exists public.social_threads (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null default 'facebook' check (channel in ('facebook','instagram')),
  page_id         text not null,
  psid            text not null,
  display_name    text,
  customer_id     uuid references public.customers(id) on delete set null,
  linked_at       timestamptz,
  linked_by       uuid references public.employees(id),
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  done_at         timestamptz,
  done_by         uuid references public.employees(id),
  created_at      timestamptz not null default now(),
  constraint social_threads_person_key unique (channel, page_id, psid)
);
comment on table public.social_threads is
  'One Facebook (later Instagram) person per Page. Written ONLY via social_record_message + api/messenger.js (service role). '
  'Staff read via is_staff(). done_at/customer_id are human-set: the webhook never writes them.';
comment on column public.social_threads.last_inbound_at is
  'Newest CUSTOMER message. Drives the 24h reply window and brings a Done thread back (last_inbound_at > done_at).';

-- ── 2. Messages ─────────────────────────────────────────────────────────────
create table if not exists public.social_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.social_threads(id) on delete cascade,
  mid         text not null,
  direction   text not null check (direction in ('in','out')),
  is_echo     boolean not null default false,
  source      text not null check (source in ('customer','crisdata','page_inbox')),
  app_id      text,
  text        text,
  attachments jsonb not null default '[]'::jsonb,
  sent_at     timestamptz not null,
  sent_by     uuid references public.employees(id),
  send_status text check (send_status in ('sent','failed')),
  send_error  text,
  created_at  timestamptz not null default now(),
  constraint social_messages_mid_key unique (mid)
);
comment on table public.social_messages is
  'One message. mid = Meta message id (a failed send uses a local:<uuid> mid). Unique mid = idempotent re-delivery. '
  'attachments = metadata/links only, no files.';
create index if not exists social_messages_thread_idx on public.social_messages (thread_id, sent_at);
create index if not exists social_threads_recent_idx  on public.social_threads (last_message_at desc);

-- ── 3. The shared staff check ───────────────────────────────────────────────
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.employees
     where auth_user_id = auth.uid()
       and active is true
  );
$fn$;
comment on function public.is_staff() is
  'True when the signed-in Supabase user maps to an ACTIVE employees row. Shared staff check '
  '(social_* read policies now; security Phase 3 Tier-A tables next). office-auth.md.';
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;

-- ── 4. RLS + grants: staff read, nobody else anything ───────────────────────
alter table public.social_threads  enable row level security;
alter table public.social_messages enable row level security;

revoke all on table public.social_threads, public.social_messages from public, anon, authenticated;
grant select on table public.social_threads, public.social_messages to authenticated;
grant all    on table public.social_threads, public.social_messages to service_role;

drop policy if exists staff_read on public.social_threads;
create policy staff_read on public.social_threads
  for select to authenticated using (public.is_staff());
drop policy if exists staff_read on public.social_messages;
create policy staff_read on public.social_messages
  for select to authenticated using (public.is_staff());
-- NO insert / update / delete policies. Writes are service role only.

-- ── 5. The one writer ───────────────────────────────────────────────────────
-- Called by api/meta-webhook.js (inbound + echoes) and api/messenger.js (our sends),
-- both with the service-role key. Returns the thread, the message, and whether this
-- call inserted it (false = a re-delivery or the other half of the echo/send race).
create or replace function public.social_record_message(
  p_channel      text,
  p_page_id      text,
  p_psid         text,
  p_mid          text,
  p_direction    text,
  p_is_echo      boolean,
  p_source       text,
  p_app_id       text,
  p_text         text,
  p_attachments  jsonb,
  p_sent_at      timestamptz,
  p_sent_by      uuid default null,
  p_send_status  text default null,
  p_send_error   text default null,
  p_display_name text default null
)
returns table (thread_id uuid, message_id uuid, inserted boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_thread   uuid;
  v_message  uuid;
  v_inserted boolean := false;
begin
  if coalesce(p_page_id, '') = '' or coalesce(p_psid, '') = '' or coalesce(p_mid, '') = '' then
    raise exception 'social_record_message: page_id, psid and mid are required';
  end if;
  if p_sent_at is null then
    raise exception 'social_record_message: sent_at is required';
  end if;

  -- 1. The thread: create if missing. DO NOTHING on conflict (never a no-op UPDATE of
  --    someone's row); a concurrent creator's row is visible to the select once its
  --    insert commits, because the conflict check waits for it.
  insert into public.social_threads as t (channel, page_id, psid, display_name)
  values (coalesce(p_channel, 'facebook'), p_page_id, p_psid, nullif(p_display_name, ''))
  on conflict (channel, page_id, psid) do nothing;

  select t.id into v_thread
    from public.social_threads t
   where t.channel = coalesce(p_channel, 'facebook') and t.page_id = p_page_id and t.psid = p_psid;

  -- A name learned later only fills an empty slot; it never replaces one.
  if nullif(p_display_name, '') is not null then
    update public.social_threads t set display_name = p_display_name
     where t.id = v_thread and t.display_name is null;
  end if;

  -- 2. The message: a re-delivered mid inserts nothing.
  insert into public.social_messages as m
    (thread_id, mid, direction, is_echo, source, app_id, text, attachments,
     sent_at, sent_by, send_status, send_error)
  values
    (v_thread, p_mid, p_direction, coalesce(p_is_echo, false), p_source, p_app_id, p_text,
     coalesce(p_attachments, '[]'::jsonb), p_sent_at, p_sent_by, p_send_status, p_send_error)
  on conflict (mid) do nothing
  returning m.id into v_message;

  if v_message is not null then
    v_inserted := true;

    -- 3. Advance the thread clocks — only ever forward. Inbound = customer only.
    update public.social_threads t
       set last_message_at = greatest(t.last_message_at, p_sent_at),
           last_inbound_at = case when p_direction = 'in'
                                  then greatest(t.last_inbound_at, p_sent_at)
                                  else t.last_inbound_at end
     where t.id = v_thread
       and (t.last_message_at is null or t.last_message_at < p_sent_at
            or (p_direction = 'in' and (t.last_inbound_at is null or t.last_inbound_at < p_sent_at)));
  else
    -- 4. Already there — the echo of our own send can land before the send returns.
    --    Fill who-sent-it / status only where still empty. Nothing else changes.
    select m.id into v_message from public.social_messages m where m.mid = p_mid;
    if p_sent_by is not null or p_send_status is not null then
      update public.social_messages m
         set sent_by     = coalesce(m.sent_by, p_sent_by),
             send_status = coalesce(m.send_status, p_send_status)
       where m.id = v_message
         and ((m.sent_by is null and p_sent_by is not null)
              or (m.send_status is null and p_send_status is not null));
    end if;
  end if;

  thread_id  := v_thread;
  message_id := v_message;
  inserted   := v_inserted;
  return next;
end;
$fn$;
comment on function public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text) is
  'The only writer of social_messages. Service role only. Idempotent on mid; clocks only move forward; '
  'fills sent_by/send_status/display_name only when empty; never writes done_at or customer_id.';
revoke all on function public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text)
  to service_role;

-- ── 6. Realtime (SQL-editor tables are not auto-added) ───────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'social_threads') then
    alter publication supabase_realtime add table public.social_threads;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'social_messages') then
    alter publication supabase_realtime add table public.social_messages;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY (read-only; run after the commit, in the same SQL editor)
-- ============================================================================
-- a) Which database (expect the sandbox / PROD label you meant):
--    select env from public.app_env;
--
-- b) RLS on for both (expect 2 rows, rowsecurity = true):
--    select tablename, rowsecurity from pg_tables
--     where schemaname = 'public' and tablename in ('social_threads','social_messages');
--
-- c) Exactly two policies, both SELECT, both authenticated (expect 2 rows · {authenticated} · SELECT):
--    select tablename, policyname, roles, cmd, qual from pg_policies
--     where tablename in ('social_threads','social_messages');
--
-- d) Table privileges (expect: every anon column false; authenticated select true, write false):
--    select r.role, t.tbl,
--           has_table_privilege(r.role, t.tbl, 'select') as sel,
--           has_table_privilege(r.role, t.tbl, 'insert') as ins,
--           has_table_privilege(r.role, t.tbl, 'update') as upd,
--           has_table_privilege(r.role, t.tbl, 'delete') as del
--      from (values ('anon'),('authenticated')) r(role),
--           (values ('public.social_threads'),('public.social_messages')) t(tbl);
--
-- e) Functions: definer, pinned search_path, and who may execute
--    (expect is_staff: t · anon f · auth t;  social_record_message: t · anon f · auth f · service t):
--    select p.proname, p.prosecdef, p.proconfig,
--           has_function_privilege('anon', p.oid, 'execute')          as anon_x,
--           has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
--           has_function_privilege('service_role', p.oid, 'execute')  as service_x
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in ('is_staff','social_record_message');
--
-- f) Realtime (expect 2 rows):
--    select tablename from pg_publication_tables
--     where pubname = 'supabase_realtime' and tablename in ('social_threads','social_messages');
--
-- g) Empty to start (expect 0 · 0):
--    select (select count(*) from public.social_threads) as threads,
--           (select count(*) from public.social_messages) as messages;
--
-- h) Over the API as anon (expect 401 / 42501 "permission denied"), after step 2 ships or with curl:
--    GET https://<ref>.supabase.co/rest/v1/social_threads?select=id   (apikey = publishable key, no user token)
--
-- ROLLBACK (only if step 1 must be undone before any real message is stored):
--    drop function if exists public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text);
--    drop table if exists public.social_messages;
--    drop table if exists public.social_threads;
--    -- keep public.is_staff(): security Phase 3 depends on it.
