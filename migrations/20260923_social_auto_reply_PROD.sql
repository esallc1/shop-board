-- ============================================================================
-- Messenger — the AFTER-HOURS AUTO-REPLY (+ the phone number a customer types).
-- PROD run (hygemiszxwmyrkmhbjub / www / board.leetransmissionshop.com).
-- -- Sandbox has its own file: 20260923_social_auto_reply_SANDBOX.sql — RUN THAT ONE FIRST.
-- Needs 20260923_social_messaging_* and 20260923_social_inbound_received_* first.
-- Wiring: docs/wiring/meta-webhook.md §12, messenger-tray.md, settings.md.
--
-- WHAT (columns only — no new table, no RLS / grant change: new columns inherit
-- their table's rules. social_*: staff read via is_staff(), service-role writes.
-- shop_settings: its existing posture, same as every other setting.)
--   social_messages.auto              boolean not null default false
--       true = CrisData's automatic after-hours reply (the tray labels it "auto";
--       it never counts as a staff reply).
--   social_threads.last_auto_reply_at timestamptz
--       when this thread last got the auto-reply — one per closed stretch.
--   social_threads.detected_phone     text
--       a US phone number the customer typed (10 digits, newest wins).
--   shop_settings.fb_auto_reply_on    boolean not null default true
--   shop_settings.fb_auto_reply_text  text      (NULL/empty = the built-in default text,
--       which lives in code — shared/fb-auto-reply.js — not in this migration)
--   shop_settings.shop_closed_on      date      ("Shop closed today": active only while it
--       equals today's America/New_York date, so it expires by itself at midnight)
--
-- Nothing is backfilled: every existing message is not auto (the default), no
-- thread has had an auto-reply, and the switch starts ON with the default text.
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
  if to_regclass('public.social_threads') is null or to_regclass('public.social_messages') is null then
    raise exception 'social_threads / social_messages missing — run 20260923_social_messaging first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='social_threads' and column_name='last_inbound_received_at') then
    raise exception 'social_threads.last_inbound_received_at missing — run 20260923_social_inbound_received first';
  end if;
  raise notice 'social auto-reply migration running on %', v;
end $$;

alter table public.social_messages add column if not exists auto boolean not null default false;
comment on column public.social_messages.auto is
  'true = CrisData''s automatic after-hours reply (api/meta-webhook.js). Labelled "auto" in the tray; never counts as a staff reply.';

alter table public.social_threads add column if not exists last_auto_reply_at timestamptz;
alter table public.social_threads add column if not exists detected_phone text;
comment on column public.social_threads.last_auto_reply_at is
  'When this thread last got the after-hours auto-reply. At most one per closed stretch (meta-webhook.md §12).';
comment on column public.social_threads.detected_phone is
  'A US phone number the customer typed in a message (10 digits; the newest wins). Machine-set.';

alter table public.shop_settings add column if not exists fb_auto_reply_on boolean not null default true;
alter table public.shop_settings add column if not exists fb_auto_reply_text text;
alter table public.shop_settings add column if not exists shop_closed_on date;
comment on column public.shop_settings.fb_auto_reply_on is 'Facebook after-hours auto-reply master switch (default ON).';
comment on column public.shop_settings.fb_auto_reply_text is 'The auto-reply text; NULL/empty = the built-in default (shared/fb-auto-reply.js).';
comment on column public.shop_settings.shop_closed_on is
  '"Shop closed today": the America/New_York date it applies to. Active only while it equals today''s ET date.';

commit;

notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFY — ONE query, one row per check, every `ok` must be true (false rows sort first).
-- ============================================================================
-- select * from (
--   select 'env' as chk, (select env from public.app_env limit 1) as got, true as ok
--   union all select 'social_messages.auto',
--     (select data_type||' '||is_nullable||' '||coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name='social_messages' and column_name='auto'),
--     exists (select 1 from information_schema.columns where table_schema='public' and table_name='social_messages' and column_name='auto' and data_type='boolean' and is_nullable='NO' and column_default='false')
--   union all select 'social_threads.last_auto_reply_at',
--     (select data_type from information_schema.columns where table_schema='public' and table_name='social_threads' and column_name='last_auto_reply_at'),
--     exists (select 1 from information_schema.columns where table_schema='public' and table_name='social_threads' and column_name='last_auto_reply_at' and data_type='timestamp with time zone')
--   union all select 'social_threads.detected_phone',
--     (select data_type from information_schema.columns where table_schema='public' and table_name='social_threads' and column_name='detected_phone'),
--     exists (select 1 from information_schema.columns where table_schema='public' and table_name='social_threads' and column_name='detected_phone' and data_type='text')
--   union all select 'shop_settings.fb_auto_reply_on (default ON)',
--     (select fb_auto_reply_on::text from public.shop_settings limit 1),
--     coalesce((select fb_auto_reply_on from public.shop_settings limit 1), false)
--   union all select 'shop_settings.fb_auto_reply_text (null = default)',
--     (select coalesce(left(fb_auto_reply_text, 20), 'null') from public.shop_settings limit 1),
--     exists (select 1 from information_schema.columns where table_schema='public' and table_name='shop_settings' and column_name='fb_auto_reply_text' and data_type='text')
--   union all select 'shop_settings.shop_closed_on (date)',
--     (select data_type from information_schema.columns where table_schema='public' and table_name='shop_settings' and column_name='shop_closed_on'),
--     exists (select 1 from information_schema.columns where table_schema='public' and table_name='shop_settings' and column_name='shop_closed_on' and data_type='date')
--   union all select 'no message is auto yet',
--     (select count(*)::text from public.social_messages where auto),
--     (select count(*) = 0 from public.social_messages where auto)
--   union all select 'anon: still no access to social_*',
--     (select bool_or(has_table_privilege('anon', t, p))::text from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['select','insert','update','delete']) p),
--     (select not bool_or(has_table_privilege('anon', t, p)) from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['select','insert','update','delete']) p)
--   union all select 'authenticated: still select-only on social_*',
--     (select bool_or(has_table_privilege('authenticated', t, p))::text from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['insert','update','delete']) p),
--     (select not bool_or(has_table_privilege('authenticated', t, p)) from unnest(array['public.social_threads','public.social_messages']) t, unnest(array['insert','update','delete']) p)
-- ) v order by ok, chk;
