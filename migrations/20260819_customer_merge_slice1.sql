-- ============================================================
-- Customer merge — SLICE 1. Three clusters, nothing more.
-- Run BY HAND, SANDBOX ONLY (efhmefpaijjncwgbvwki). Requires
-- migrations/20260819_customer_merge.sql.
--
--   IAN GEQUELIN     239-600-3735
--   KEVIN CRUZ       239-785-8879
--   Shanika Brimmer  704-891-4849
--
-- All three are wizard-minted duplicates from the last two weeks, and each has
-- history on exactly ONE row — a clean repoint with nothing to reconcile.
--
-- RUN THEM ONE AT A TIME. Look at the result, then run the next.
--
-- DECISIONS BAKED IN (docs/wiring/customer-dedupe.md §8):
--   • survivor = most history > most vehicles > richest record > oldest row;
--   • blank keeper fields are NOT filled from the losers (a log can't undo it);
--   • completed_jobs is NOT touched (free text, nothing joins on it);
--   • a loser's customer_phones primary is demoted ONLY IF the keeper already
--     has one — that is what dodges the uq_customer_phones_primary partial
--     unique index. Demoting unconditionally would needlessly leave a keeper
--     with no primary at all, so it is conditional and the demotion is LOGGED
--     (customer_merge_log.demoted_primary) so the reverse can restore it.
-- ============================================================

-- ════════════════════════════════════════════════════════════════════════
-- B. PREVIEW — READ-ONLY. Run this FIRST and eyeball the keeper choice.
--    Expect 6 rows: two per cluster, the keeper marked '>>> KEEPER'.
-- ════════════════════════════════════════════════════════════════════════
with cl(cluster_id, phone, label) as (
  values ('cccccccc-0001-4c01-8c01-000000000001'::uuid, '2396003735', 'IAN GEQUELIN'),
         ('cccccccc-0002-4c02-8c02-000000000002'::uuid, '2397858879', 'KEVIN CRUZ'),
         ('cccccccc-0003-4c03-8c03-000000000003'::uuid, '7048914849', 'Shanika Brimmer')
), rows as (
  select cl.cluster_id, cl.label, c.*
    from cl
    join public.customers c
      on right(regexp_replace(coalesce(c.phone_primary,''),   '\D','','g'),10) = cl.phone
      or right(regexp_replace(coalesce(c.phone_secondary,''), '\D','','g'),10) = cl.phone
), counted as (
  select r.*,
    (select count(*) from public.vehicles v        where v.customer_id = r.id)                         as n_veh,
    (select count(*) from public.repair_orders o   where o.customer_id = r.id)                         as n_ro,
    (select count(*) from public.calls k           where k.customer_id = r.id)                         as n_call,
    (select count(*) from public.recordings g join public.vehicles v2 on v2.id = g.vehicle_id
       where v2.customer_id = r.id)                                                                    as n_rec_veh,
    (select count(*) from public.recordings g2 join public.calls k2 on k2.id = g2.call_id
       where k2.customer_id = r.id)                                                                    as n_rec_call,
    (select count(*) from public.customer_phones p where p.customer_id = r.id)                         as n_phones,
    (select count(*) from public.customer_phones p where p.customer_id = r.id and p.is_primary)        as n_primary,
    ((r.email is not null)::int + (r.address_line1 is not null)::int
      + (r.business_name is not null)::int + (r.city is not null)::int)                                 as richness
  from rows r
), ranked as (
  select *, (n_ro + n_call + n_rec_veh + n_rec_call) as history,
    row_number() over (partition by cluster_id order by
      (n_ro + n_call + n_rec_veh + n_rec_call) desc,   -- rule 1  most history
      n_veh                                   desc,    -- rule 2  most vehicles
      richness                                desc,    -- rule 3  richest record  (ABOVE oldest, on purpose)
      created_at                              asc      -- rule 4  oldest row
    ) as rk
  from counted
), rival as (
  select *,
    max(history)  filter (where rk = 2) over (partition by cluster_id) as riv_hist,
    max(n_veh)    filter (where rk = 2) over (partition by cluster_id) as riv_veh,
    max(richness) filter (where rk = 2) over (partition by cluster_id) as riv_rich
  from ranked
)
select label,
       case when rk = 1 then '>>> KEEPER' else '    loser' end as role,
       id, name, source, created_at::date as created,
       history, n_veh as vehicles, n_ro as ros, n_call as calls,
       (n_rec_veh + n_rec_call) as recordings, n_phones as phone_rows, n_primary as primary_rows,
       richness,
       case when rk <> 1 then null
            when history  > coalesce(riv_hist, -1) then 'rule 1 — most history'
            when n_veh    > coalesce(riv_veh,  -1) then 'rule 2 — most vehicles'
            when richness > coalesce(riv_rich, -1) then 'rule 3 — richest record'
            else                                        'rule 4 — oldest row' end as decided_by,
       -- what would MOVE off this row if it is the loser
       case when rk = 1 then null else
         n_veh || ' vehicles, ' || n_ro || ' ROs, ' || n_call || ' calls, ' || n_phones || ' phone rows' end as would_move
  from rival
 order by label, rk;


-- ════════════════════════════════════════════════════════════════════════
-- C. THE MERGES — one transaction per cluster. RUN ONE, LOOK, THEN THE NEXT.
--    run_id  aaaaaaaa-0001-4a01-8a01-000000000001  (shared by all three)
-- ════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- CLUSTER 1 — IAN GEQUELIN  (239-600-3735)
--   KEEPER eceb4bb6-1468-497e-b8cb-f26373190835  "IAN GEQUELIN"  1 veh, 1 RO, 1 call
--   loser  d358fca4-178d-4736-817d-90174d416210  "ian gequelin"  nothing attached
-- ─────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  k uuid := 'eceb4bb6-1468-497e-b8cb-f26373190835';
  l uuid[] := array['d358fca4-178d-4736-817d-90174d416210']::uuid[];
begin
  -- Nothing enforces the polymorphic attachments link, so assert it by hand.
  if exists (select 1 from public.attachments where entity_type = 'customer') then
    raise exception 'attachments rows with entity_type=customer exist — a merge would orphan them. Adjudicate first.';
  end if;
  if exists (select 1 from public.customers where id = k and archived_at is not null) then
    raise exception 'keeper % is itself archived', k;
  end if;
  if exists (select 1 from public.customers where id = any(l) and archived_at is not null) then
    raise exception 'a loser is already merged';
  end if;
  if (select count(*) from public.customers where id = any(l) or id = k) <> 1 + array_length(l,1) then
    raise exception 'keeper/loser ids do not all resolve';
  end if;
end $$;

-- customer_phones — demote the loser's primary ONLY IF the keeper has one.
insert into public.customer_merge_log
  (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id, demoted_primary)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0001-4c01-8c01-000000000001',
       'customer_phones', p.id::text, p.customer_id, 'eceb4bb6-1468-497e-b8cb-f26373190835',
       (p.is_primary and exists (select 1 from public.customer_phones kk
                                  where kk.customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835' and kk.is_primary))
  from public.customer_phones p
 where p.customer_id in ('d358fca4-178d-4736-817d-90174d416210');

update public.customer_phones p set is_primary = false
 where p.customer_id in ('d358fca4-178d-4736-817d-90174d416210') and p.is_primary
   and exists (select 1 from public.customer_phones kk
                where kk.customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835' and kk.is_primary);

update public.customer_phones set customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835'
 where customer_id in ('d358fca4-178d-4736-817d-90174d416210');

-- vehicles / repair_orders / calls / interactions — log the move, then move.
insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0001-4c01-8c01-000000000001',
       'vehicles', v.id::text, v.customer_id, 'eceb4bb6-1468-497e-b8cb-f26373190835'
  from public.vehicles v where v.customer_id in ('d358fca4-178d-4736-817d-90174d416210');
update public.vehicles set customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835'
 where customer_id in ('d358fca4-178d-4736-817d-90174d416210');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0001-4c01-8c01-000000000001',
       'repair_orders', o.id::text, o.customer_id, 'eceb4bb6-1468-497e-b8cb-f26373190835'
  from public.repair_orders o where o.customer_id in ('d358fca4-178d-4736-817d-90174d416210');
update public.repair_orders set customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835'
 where customer_id in ('d358fca4-178d-4736-817d-90174d416210');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0001-4c01-8c01-000000000001',
       'calls', k.id::text, k.customer_id, 'eceb4bb6-1468-497e-b8cb-f26373190835'
  from public.calls k where k.customer_id in ('d358fca4-178d-4736-817d-90174d416210');
update public.calls set customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835'
 where customer_id in ('d358fca4-178d-4736-817d-90174d416210');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0001-4c01-8c01-000000000001',
       'interactions', i.id::text, i.customer_id, 'eceb4bb6-1468-497e-b8cb-f26373190835'
  from public.interactions i where i.customer_id in ('d358fca4-178d-4736-817d-90174d416210');
update public.interactions set customer_id = 'eceb4bb6-1468-497e-b8cb-f26373190835'
 where customer_id in ('d358fca4-178d-4736-817d-90174d416210');

-- archive the loser (log it so the reverse can find it)
insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id, note)
values ('aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0001-4c01-8c01-000000000001',
        'customers', 'd358fca4-178d-4736-817d-90174d416210', null,
        'eceb4bb6-1468-497e-b8cb-f26373190835', 'archived');

update public.customers
   set merged_into  = 'eceb4bb6-1468-497e-b8cb-f26373190835',
       archived_at  = now(),
       merge_run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001'
 where id in ('d358fca4-178d-4736-817d-90174d416210');

commit;
-- expect: the loser had nothing attached, so only the 'customers' log row.


-- ─────────────────────────────────────────────────────────────────────
-- CLUSTER 2 — KEVIN CRUZ  (239-785-8879)
--   KEEPER 6389c1d7-57f6-4652-8b05-e8ed462ddb48  "KEVIN CRUZ"  1 veh, 1 RO
--   loser  d603759f-af52-46a9-a3af-e8d34ab7a0bf  "kevin cruz"  nothing attached
-- Identical to cluster 1 with the ids swapped.
-- ─────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  k uuid := '6389c1d7-57f6-4652-8b05-e8ed462ddb48';
  l uuid[] := array['d603759f-af52-46a9-a3af-e8d34ab7a0bf']::uuid[];
begin
  if exists (select 1 from public.attachments where entity_type = 'customer') then
    raise exception 'attachments rows with entity_type=customer exist — a merge would orphan them. Adjudicate first.';
  end if;
  if exists (select 1 from public.customers where id = k and archived_at is not null) then
    raise exception 'keeper % is itself archived', k;
  end if;
  if exists (select 1 from public.customers where id = any(l) and archived_at is not null) then
    raise exception 'a loser is already merged';
  end if;
  if (select count(*) from public.customers where id = any(l) or id = k) <> 1 + array_length(l,1) then
    raise exception 'keeper/loser ids do not all resolve';
  end if;
end $$;

insert into public.customer_merge_log
  (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id, demoted_primary)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0002-4c02-8c02-000000000002',
       'customer_phones', p.id::text, p.customer_id, '6389c1d7-57f6-4652-8b05-e8ed462ddb48',
       (p.is_primary and exists (select 1 from public.customer_phones kk
                                  where kk.customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48' and kk.is_primary))
  from public.customer_phones p where p.customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

update public.customer_phones p set is_primary = false
 where p.customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf') and p.is_primary
   and exists (select 1 from public.customer_phones kk
                where kk.customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48' and kk.is_primary);

update public.customer_phones set customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
 where customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0002-4c02-8c02-000000000002',
       'vehicles', v.id::text, v.customer_id, '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
  from public.vehicles v where v.customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');
update public.vehicles set customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
 where customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0002-4c02-8c02-000000000002',
       'repair_orders', o.id::text, o.customer_id, '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
  from public.repair_orders o where o.customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');
update public.repair_orders set customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
 where customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0002-4c02-8c02-000000000002',
       'calls', k.id::text, k.customer_id, '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
  from public.calls k where k.customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');
update public.calls set customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
 where customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0002-4c02-8c02-000000000002',
       'interactions', i.id::text, i.customer_id, '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
  from public.interactions i where i.customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');
update public.interactions set customer_id = '6389c1d7-57f6-4652-8b05-e8ed462ddb48'
 where customer_id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id, note)
values ('aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0002-4c02-8c02-000000000002',
        'customers', 'd603759f-af52-46a9-a3af-e8d34ab7a0bf', null,
        '6389c1d7-57f6-4652-8b05-e8ed462ddb48', 'archived');

update public.customers
   set merged_into  = '6389c1d7-57f6-4652-8b05-e8ed462ddb48',
       archived_at  = now(),
       merge_run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001'
 where id in ('d603759f-af52-46a9-a3af-e8d34ab7a0bf');

commit;


-- ─────────────────────────────────────────────────────────────────────
-- CLUSTER 3 — Shanika Brimmer  (704-891-4849)   ⚠️ THE INTERESTING ONE
--   KEEPER b9198f81-16b3-4f46-9240-aa4e26309a09  "SHANIKA BRIMMER"  crisdata,
--          1 veh, 1 RO — wins on rule 1 (most history)
--   loser  edf1f20f-7be9-490d-b38c-2480fcae4841  "Shanika Brimmer"  alldata,
--          1 veh, 0 ROs, and it holds the ONLY customer_phones PRIMARY row.
--   The keeper has no customer_phones row at all (created after the Phase A
--   backfill), so the demote does NOT fire and the primary moves across intact.
--   That is the conditional-demote behaviour doing the right thing.
-- ─────────────────────────────────────────────────────────────────────
begin;

do $$
declare
  k uuid := 'b9198f81-16b3-4f46-9240-aa4e26309a09';
  l uuid[] := array['edf1f20f-7be9-490d-b38c-2480fcae4841']::uuid[];
begin
  if exists (select 1 from public.attachments where entity_type = 'customer') then
    raise exception 'attachments rows with entity_type=customer exist — a merge would orphan them. Adjudicate first.';
  end if;
  if exists (select 1 from public.customers where id = k and archived_at is not null) then
    raise exception 'keeper % is itself archived', k;
  end if;
  if exists (select 1 from public.customers where id = any(l) and archived_at is not null) then
    raise exception 'a loser is already merged';
  end if;
  if (select count(*) from public.customers where id = any(l) or id = k) <> 1 + array_length(l,1) then
    raise exception 'keeper/loser ids do not all resolve';
  end if;
end $$;

insert into public.customer_merge_log
  (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id, demoted_primary)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0003-4c03-8c03-000000000003',
       'customer_phones', p.id::text, p.customer_id, 'b9198f81-16b3-4f46-9240-aa4e26309a09',
       (p.is_primary and exists (select 1 from public.customer_phones kk
                                  where kk.customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09' and kk.is_primary))
  from public.customer_phones p where p.customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

update public.customer_phones p set is_primary = false
 where p.customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841') and p.is_primary
   and exists (select 1 from public.customer_phones kk
                where kk.customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09' and kk.is_primary);

update public.customer_phones set customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09'
 where customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0003-4c03-8c03-000000000003',
       'vehicles', v.id::text, v.customer_id, 'b9198f81-16b3-4f46-9240-aa4e26309a09'
  from public.vehicles v where v.customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');
update public.vehicles set customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09'
 where customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0003-4c03-8c03-000000000003',
       'repair_orders', o.id::text, o.customer_id, 'b9198f81-16b3-4f46-9240-aa4e26309a09'
  from public.repair_orders o where o.customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');
update public.repair_orders set customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09'
 where customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0003-4c03-8c03-000000000003',
       'calls', k.id::text, k.customer_id, 'b9198f81-16b3-4f46-9240-aa4e26309a09'
  from public.calls k where k.customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');
update public.calls set customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09'
 where customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id)
select 'aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0003-4c03-8c03-000000000003',
       'interactions', i.id::text, i.customer_id, 'b9198f81-16b3-4f46-9240-aa4e26309a09'
  from public.interactions i where i.customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');
update public.interactions set customer_id = 'b9198f81-16b3-4f46-9240-aa4e26309a09'
 where customer_id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

insert into public.customer_merge_log (run_id, cluster_id, table_name, row_id, from_customer_id, to_customer_id, note)
values ('aaaaaaaa-0001-4a01-8a01-000000000001', 'cccccccc-0003-4c03-8c03-000000000003',
        'customers', 'edf1f20f-7be9-490d-b38c-2480fcae4841', null,
        'b9198f81-16b3-4f46-9240-aa4e26309a09', 'archived');

update public.customers
   set merged_into  = 'b9198f81-16b3-4f46-9240-aa4e26309a09',
       archived_at  = now(),
       merge_run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001'
 where id in ('edf1f20f-7be9-490d-b38c-2480fcae4841');

commit;


-- ════════════════════════════════════════════════════════════════════════
-- F. VERIFY — run after EACH cluster.
-- ════════════════════════════════════════════════════════════════════════
-- 1. What moved, for this cluster:
--      select table_name, count(*), bool_or(demoted_primary) as any_demote
--        from public.customer_merge_log
--       where cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--       group by table_name order by table_name;
--
-- 2. The loser is archived and points at the keeper; the keeper is untouched:
--      select id, name, archived_at is not null as archived, merged_into
--        from public.customers
--       where id in ('b9198f81-16b3-4f46-9240-aa4e26309a09','edf1f20f-7be9-490d-b38c-2480fcae4841');
--
-- 3. NOTHING is still hanging off the loser (every count must be 0):
--      select
--        (select count(*) from public.vehicles        where customer_id = 'edf1f20f-7be9-490d-b38c-2480fcae4841') as veh,
--        (select count(*) from public.repair_orders   where customer_id = 'edf1f20f-7be9-490d-b38c-2480fcae4841') as ros,
--        (select count(*) from public.calls           where customer_id = 'edf1f20f-7be9-490d-b38c-2480fcae4841') as calls,
--        (select count(*) from public.customer_phones where customer_id = 'edf1f20f-7be9-490d-b38c-2480fcae4841') as phones;
--
-- 4. The partial-unique index is still satisfied (expect 0 rows):
--      select customer_id, count(*) from public.customer_phones
--       where is_primary group by customer_id having count(*) > 1;
--
-- 5. Whole-run summary:
--      select cluster_id, table_name, count(*) from public.customer_merge_log
--       where run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001'
--       group by 1,2 order by 1,2;


-- ════════════════════════════════════════════════════════════════════════
-- D. THE REVERSE — two forms. Both restore the child rows AND the archive
--    marks, and both delete the log rows they consumed so the state is clean.
--    ⚠️ Change the WHERE on every statement together — they must all target
--    the same scope.
-- ════════════════════════════════════════════════════════════════════════

-- ── D1. UNDO ONE CLUSTER (swap the cluster_id) ──
-- begin;
-- update public.customers c
--    set merged_into = null, archived_at = null, merge_run_id = null
--   from public.customer_merge_log l
--  where l.cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--    and l.table_name = 'customers' and l.row_id = c.id::text;
--
-- update public.vehicles t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--    and l.table_name = 'vehicles' and l.row_id = t.id::text;
--
-- update public.repair_orders t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--    and l.table_name = 'repair_orders' and l.row_id = t.id::text;
--
-- update public.calls t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--    and l.table_name = 'calls' and l.row_id = t.id::text;
--
-- update public.interactions t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--    and l.table_name = 'interactions' and l.row_id = t.id::text;
--
-- -- customer_phones: move back AND restore any primary this merge demoted.
-- update public.customer_phones t
--    set customer_id = l.from_customer_id,
--        is_primary  = case when l.demoted_primary then true else t.is_primary end
--   from public.customer_merge_log l
--  where l.cluster_id = 'cccccccc-0003-4c03-8c03-000000000003'
--    and l.table_name = 'customer_phones' and l.row_id = t.id::text;
--
-- delete from public.customer_merge_log
--  where cluster_id = 'cccccccc-0003-4c03-8c03-000000000003';
-- commit;

-- ── D2. UNDO THE WHOLE RUN (identical, keyed on run_id) ──
-- begin;
-- update public.customers c
--    set merged_into = null, archived_at = null, merge_run_id = null
--   from public.customer_merge_log l
--  where l.run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001'
--    and l.table_name = 'customers' and l.row_id = c.id::text;
-- update public.vehicles t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001' and l.table_name = 'vehicles' and l.row_id = t.id::text;
-- update public.repair_orders t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001' and l.table_name = 'repair_orders' and l.row_id = t.id::text;
-- update public.calls t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001' and l.table_name = 'calls' and l.row_id = t.id::text;
-- update public.interactions t set customer_id = l.from_customer_id
--   from public.customer_merge_log l
--  where l.run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001' and l.table_name = 'interactions' and l.row_id = t.id::text;
-- update public.customer_phones t
--    set customer_id = l.from_customer_id,
--        is_primary  = case when l.demoted_primary then true else t.is_primary end
--   from public.customer_merge_log l
--  where l.run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001' and l.table_name = 'customer_phones' and l.row_id = t.id::text;
-- delete from public.customer_merge_log
--  where run_id = 'aaaaaaaa-0001-4a01-8a01-000000000001';
-- commit;
