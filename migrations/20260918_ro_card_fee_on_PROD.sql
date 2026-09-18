-- ============================================================================
-- Card fee as a LIVE switch — PROD run (hygemiszxwmyrkmhbjub / www + board).
-- The sandbox has its own file: 20260918_ro_card_fee_on_SANDBOX.sql (different
-- RO list, inverted guard). docs/wiring/card-fee.md is the wiring.
--
-- Run BY HAND in the Supabase SQL editor, in this ORDER:
--   STEP 1  (schema)       → then deploy the app that reads card_fee_on
--   STEP 2  (convert data) → only AFTER that app is live on this database's site.
-- Running STEP 2 before the new app is live would drop the fee from those ROs
-- (the old app ignores the switch and the stored line would be gone).
--
-- SELF-GUARDING (staging-db.md §8.2/§8.3): every block refuses to run unless
-- app_env says PROD. Nothing here can touch the sandbox.
--
-- ⚠ PROD RO LIST — from the step-0 read of PROD on 2026-09-18, as approved by
--   Cris: the 14 estimate/ro ROs with a stored card-fee line, INCLUDING the 5
--   declined estimates (6023, 6025, 6054, 6072, 6079) and the two whose total
--   moves on conversion (5501 +$2.94, 6054 +$0.68). #6074 (status 'invoice',
--   unpaid) is DELIBERATELY NOT listed — it keeps its stored line. Closed ROs
--   are never touched (and the status re-check would skip them anyway).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 1 — schema: repair_orders.card_fee_on (default OFF). Safe to re-run.
-- Existing table RLS (anon + authenticated full access) covers the new column.
-- Adding a NOT NULL column with a constant default is metadata-only (no rewrite).
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then
    raise exception 'app_env HAS NO ROW — STOP. Every guard would silently match nothing. Stamp this database first (staging-db.md §8).';
  end if;
  if v not like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this is the PROD file, refusing', v;
  end if;

  alter table public.repair_orders
    add column if not exists card_fee_on boolean not null default false;
  comment on column public.repair_orders.card_fee_on is
    'Card processing fee switch. true = totals add shop_settings.card_fee_pct x (all lines + sales tax), computed live by shared/ro-totals.js; never stored as a line. Default off.';

  raise notice 'STEP 1 done on %', v;
end $$;

notify pgrst, 'reload schema';

-- STEP 1 verification (expect: 1 row boolean / NO / false; switched_on = 0; the PROD stamp)
--   select env from public.app_env;
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'repair_orders' and column_name = 'card_fee_on';
--   select count(*) filter (where card_fee_on) as switched_on, count(*) as all_ros from public.repair_orders;


-- ════════════════════════════════════════════════════════════════════════════
-- STEP 2 — convert OPEN ROs that carry an old stored card-fee line:
--   switch card_fee_on ON and delete the stored line, after backing it up.
--   • Explicit RO list (from the step-0 read of PROD, 2026-09-18 — see header).
--   • Status is RE-CHECKED at run time: only rows still 'estimate' or 'ro'.
--     A listed RO that has since been invoiced/closed is skipped, untouched.
--   • Only line_type='fee' lines whose description starts "card processing fee"
--     (both the button's "(4.00%)" wording and the old uppercase one).
--   • One statement → atomic. The result row reports what it did.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then raise exception 'app_env HAS NO ROW — STOP (staging-db.md §8).'; end if;
  if v not like 'PROD%' then raise exception 'WRONG PROJECT: % — PROD file, refusing', v; end if;

  -- Backup table: the removed lines, whole-row, for an exact restore. RLS on with
  -- NO policies → invisible to the app/API; readable only here in the SQL editor.
  create table if not exists public.ro_card_fee_line_backup_20260918 (
    backup_id    bigserial primary key,
    backed_up_at timestamptz not null default now(),
    ro_id        uuid    not null,
    ro_number    integer not null,
    ro_status    text    not null,
    line_id      uuid    not null,
    line         jsonb   not null
  );
  alter table public.ro_card_fee_line_backup_20260918 enable row level security;
end $$;

with targets as (
  select li.id as line_id, r.id as ro_id, r.ro_number, r.status::text as ro_status, to_jsonb(li) as line
    from public.ro_line_items li
    join public.repair_orders r on r.id = li.repair_order_id
   where r.ro_number in (5501, 6023, 6025, 6054, 6072, 6073, 6077, 6079, 6080, 6083, 6084, 6086, 6087, 6093)
     and r.status in ('estimate', 'ro')                          -- re-checked NOW
     and li.line_type = 'fee'
     and li.description ilike 'card processing fee%'
     and (select env from public.app_env) like 'PROD%'           -- wrong project ⇒ 0 rows
), backed as (
  insert into public.ro_card_fee_line_backup_20260918 (ro_id, ro_number, ro_status, line_id, line)
  select ro_id, ro_number, ro_status, line_id, line from targets
  returning line_id
), switched as (
  update public.repair_orders set card_fee_on = true
   where id in (select ro_id from targets)
  returning ro_number
), removed as (
  delete from public.ro_line_items where id in (select line_id from targets)
  returning id
)
select (select count(*) from backed)   as lines_backed_up,
       (select count(*) from switched) as ros_switched_on,
       (select count(*) from removed)  as lines_removed,
       (select string_agg(ro_number::text, ', ' order by ro_number) from switched) as ros;

-- STEP 2 verification — one row per listed RO: switch, stored card-fee lines left,
-- backed-up lines, and the RO total BEFORE (current lines + the backed-up line) vs AFTER
-- (current lines + tax + live fee when on). Same math as shared/ro-totals.js; totals are
-- round(…, 2) half-up (none of the 14 sits on an exact half cent, so it matches the app).
--   with s as (select tax_rate, card_fee_pct from public.shop_settings limit 1),
--   r as (
--     select r.id, r.ro_number, r.status::text as status, r.card_fee_on, coalesce(c.tax_exempt, false) as exempt
--       from public.repair_orders r join public.customers c on c.id = r.customer_id
--      where r.ro_number in (5501, 6023, 6025, 6054, 6072, 6073, 6077, 6079, 6080, 6083, 6084, 6086, 6087, 6093)
--   ),
--   cur as (
--     select li.repair_order_id as ro_id,
--            sum(li.quantity * li.unit_price)                                         as sub,
--            sum(case when li.taxable then li.quantity * li.unit_price else 0 end)    as txb,
--            count(*) filter (where li.line_type = 'fee' and li.description ilike 'card processing fee%') as stored
--       from public.ro_line_items li join r on r.id = li.repair_order_id
--      group by li.repair_order_id
--   ),
--   bak as (
--     select b.ro_id,
--            sum((b.line->>'quantity')::numeric * (b.line->>'unit_price')::numeric)   as sub,
--            sum(case when (b.line->>'taxable')::boolean
--                     then (b.line->>'quantity')::numeric * (b.line->>'unit_price')::numeric else 0 end) as txb,
--            count(*) as n
--       from public.ro_card_fee_line_backup_20260918 b join r on r.id = b.ro_id
--      group by b.ro_id
--   ),
--   t as (
--     select r.*, coalesce(cur.stored, 0) as stored_card_fee_lines, coalesce(bak.n, 0) as backed_up_lines,
--            (coalesce(cur.sub, 0) + coalesce(bak.sub, 0))
--              + case when r.exempt then 0 else (coalesce(cur.txb, 0) + coalesce(bak.txb, 0)) * s.tax_rate end as before_raw,
--            coalesce(cur.sub, 0) + case when r.exempt then 0 else coalesce(cur.txb, 0) * s.tax_rate end        as prefee_raw,
--            s.card_fee_pct
--       from r cross join s left join cur on cur.ro_id = r.id left join bak on bak.ro_id = r.id
--   )
--   select (select env from public.app_env) as env,
--          ro_number, status, card_fee_on, stored_card_fee_lines, backed_up_lines,
--          round(before_raw, 2) as total_before,
--          round(prefee_raw + case when card_fee_on and stored_card_fee_lines = 0
--                                  then round(card_fee_pct * prefee_raw, 2) else 0 end, 2) as total_after,
--          (select count(*) from public.repair_orders where card_fee_on) as switched_on_total
--     from t
--    order by ro_number;

-- ════════════════════════════════════════════════════════════════════════════
-- UNDO for STEP 2 (not run) — restores the exact lines and switches OFF.
--   insert into public.ro_line_items
--   select (jsonb_populate_record(null::public.ro_line_items, b.line)).*
--     from public.ro_card_fee_line_backup_20260918 b
--    where b.ro_number in (5501, 6023, 6025, 6054, 6072, 6073, 6077, 6079, 6080, 6083, 6084, 6086, 6087, 6093)
--      and not exists (select 1 from public.ro_line_items x where x.id = b.line_id);
--   update public.repair_orders set card_fee_on = false
--    where ro_number in (5501, 6023, 6025, 6054, 6072, 6073, 6077, 6079, 6080, 6083, 6084, 6086, 6087, 6093);
-- ════════════════════════════════════════════════════════════════════════════
