-- ============================================================================
-- Messenger — WHEN a customer message ARRIVED (the sent-before-Done fix).
-- PROD run (hygemiszxwmyrkmhbjub / www / board.leetransmissionshop.com).
-- -- Sandbox has its own file: 20260923_social_inbound_received_SANDBOX.sql — RUN THAT ONE FIRST.
-- Needs 20260923_social_messaging_*.sql applied first. Wiring: docs/wiring/messenger-tray.md §2.
--
-- THE GAP. The tray's "waiting" rule was  done_at is null OR last_inbound_at > done_at.
-- last_inbound_at is META'S timestamp — when the customer SENT it. A message sent at
-- 10:00:00, Done clicked at 10:00:05, delivered at 10:00:06 → 10:00:00 < 10:00:05 → the
-- thread stayed Done and the message was never seen.
--
-- THE FIX. social_threads.last_inbound_received_at = when the newest customer message
-- ARRIVED here (now() inside social_record_message). The waiting rule becomes
--   done_at is null OR last_inbound_received_at > done_at.
-- last_inbound_at stays exactly as it is and still drives the 24h reply window — that
-- rule is Meta's and runs on Meta's clock.
--
-- WHAT.
--   1. add column social_threads.last_inbound_received_at timestamptz (nullable).
--   2. backfill: = last_inbound_at where it is null (existing rows keep today's behaviour).
--   3. replace social_record_message: the SAME function (same signature, same idempotency,
--      same fill-only-if-empty rules, still never writes done_* / customer_id / linked_*),
--      plus: a NEW inbound message stamps last_inbound_received_at = greatest(it, now()).
--      Never on a re-delivery (the insert did nothing), never on an echo or our send
--      (direction 'out'). Privileges re-stated: service_role only.
--   No RLS / grant change on the tables: the column is covered by staff_read + the
--   existing revokes (anon: nothing; authenticated: select via is_staff()).
--
-- SELF-GUARDING (staging-db.md §8) + one transaction. Safe to re-run.
-- ============================================================================

begin;

do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP. Stamp this database first (staging-db.md §8).'; end if;
  if v not like 'PROD%' then raise exception 'WRONG PROJECT: % — this is the PROD file, refusing', v; end if;
  if to_regclass('public.social_threads') is null then raise exception 'social_threads is missing — run 20260923_social_messaging first'; end if;
  raise notice 'inbound-received migration running on %', v;
end $$;

-- ── 1. The column ───────────────────────────────────────────────────────────
alter table public.social_threads add column if not exists last_inbound_received_at timestamptz;
comment on column public.social_threads.last_inbound_received_at is
  'When the newest CUSTOMER message ARRIVED at CrisData (now() in social_record_message). The tray waiting rule: '
  'done_at is null OR last_inbound_received_at > done_at. last_inbound_at (Meta send time) still drives the 24h window.';

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
update public.social_threads
   set last_inbound_received_at = last_inbound_at
 where last_inbound_received_at is null and last_inbound_at is not null;

-- ── 3. The writer, with the arrival stamp ───────────────────────────────────
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
    --    last_inbound_at          = Meta's send time (the 24h reply window — Meta's rule, Meta's clock).
    --    last_inbound_received_at = when it ARRIVED here (the tray's waiting rule vs done_at).
    --    A NEW customer message always stamps its arrival, even when Meta's timestamp is
    --    older than what we have (a late delivery) — that is the whole point of the column.
    update public.social_threads t
       set last_message_at = greatest(t.last_message_at, p_sent_at),
           last_inbound_at = case when p_direction = 'in'
                                  then greatest(t.last_inbound_at, p_sent_at)
                                  else t.last_inbound_at end,
           last_inbound_received_at = case when p_direction = 'in'
                                           then greatest(t.last_inbound_received_at, now())
                                           else t.last_inbound_received_at end
     where t.id = v_thread
       and (p_direction = 'in'
            or t.last_message_at is null or t.last_message_at < p_sent_at);
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
  'a NEW inbound stamps last_inbound_received_at = now(); fills sent_by/send_status/display_name only when empty; '
  'never writes done_at or customer_id.';
revoke all on function public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.social_record_message(text,text,text,text,text,boolean,text,text,text,jsonb,timestamptz,uuid,text,text,text)
  to service_role;

commit;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY — ONE query, one row per check, every `ok` must be true.
-- ============================================================================
-- select * from (
--   select 'env' as chk, (select env from public.app_env limit 1) as got, true as ok
--   union all select 'column exists',
--     (select data_type from information_schema.columns where table_schema='public' and table_name='social_threads' and column_name='last_inbound_received_at'),
--     exists (select 1 from information_schema.columns where table_schema='public' and table_name='social_threads' and column_name='last_inbound_received_at' and data_type='timestamp with time zone')
--   union all select 'backfill done (rows missing it)',
--     (select count(*)::text from public.social_threads where last_inbound_at is not null and last_inbound_received_at is null),
--     (select count(*) = 0 from public.social_threads where last_inbound_at is not null and last_inbound_received_at is null)
--   union all select 'function stamps arrival',
--     (select position('last_inbound_received_at' in prosrc)::text from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace),
--     (select prosrc like '%last_inbound_received_at = case when p_direction = ''in''%' from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace)
--   union all select 'function definer + pinned path',
--     (select prosecdef::text || ' ' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace),
--     (select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace)
--   union all select 'function: service_role only',
--     (select 'anon='||has_function_privilege('anon',oid,'execute')||' auth='||has_function_privilege('authenticated',oid,'execute')||' service='||has_function_privilege('service_role',oid,'execute') from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace),
--     (select not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute') and has_function_privilege('service_role',oid,'execute') from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace)
--   union all select 'only one social_record_message',
--     (select count(*)::text from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace),
--     (select count(*) = 1 from pg_proc where proname='social_record_message' and pronamespace='public'::regnamespace)
--   union all select 'anon: no access to either table',
--     (select bool_or(has_table_privilege('anon', t, p))::text from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['select','insert','update','delete']) p),
--     (select not bool_or(has_table_privilege('anon', t, p)) from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['select','insert','update','delete']) p)
--   union all select 'authenticated: select only',
--     (select bool_or(has_table_privilege('authenticated', t, p))::text from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['insert','update','delete']) p),
--     (select not bool_or(has_table_privilege('authenticated', t, p)) and has_table_privilege('authenticated','public.social_threads','select') from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['insert','update','delete']) p)
-- ) v order by ok, chk;
-- → every row ok = true. A false row sorts to the TOP.
