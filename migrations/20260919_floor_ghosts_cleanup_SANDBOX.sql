-- ============================================================================
-- One-time cleanup: cars still on the shop floor whose RO is CLOSED — SANDBOX run
-- (efhmefpaijjncwgbvwki / test.*). Prod has its own file: 20260919_floor_ghosts_cleanup_PROD.sql
-- (identical except the inverted guard). Wiring: docs/wiring/tech-board.md §8,
-- docs/wiring/ro-checkin-tech.md §8.
--
-- WHY: until fix/close-clears-floor, closing an RO from the Stage dropdown never
-- removed its car from the floor tables, so the Tech Board, the Approval Queue and
-- the Manager board's Tech Status kept showing cars that left weeks ago (Kevin,
-- Aug 6 / 13 / 26). The app now clears the floor on every close; this removes the
-- ghosts that were already there. The shop closes an RO only after the car has
-- left the lot (Cris, 2026-09-19), so a closed RO's floor row is always stale.
--
-- WHAT IT DOES, for the 14 POs listed below ONLY (the 2026-09-19 prod read):
--   • re-checks each RO's CURRENT status at run time — acts only when EVERY RO
--     with that po is status 'closed' (NOT closed_at: #6065 / #6085 / #6092 are
--     reopened but still carry closed_at);
--   • backs up each affected floor row, whole, into
--     public.floor_ghost_backup_20260919 (RLS on, no policies → invisible to the
--     app/API, readable only in this SQL editor);
--   • DELETES lot (shopboard_parking) and pickup (shopboard_pickup) rows;
--   • CLEARS a lift bay (shopboard_lifts) back to the empty-bay shape — the same
--     columns the app's EMPTY_LIFT writes (shared/floor-clear.js). A lift row is
--     NEVER deleted (six fixed bays);
--   • skips and REPORTS any listed PO whose RO isn't closed, has no RO, or isn't
--     on the floor.
-- LEFT OUT on purpose: #6054 and #6072 (declined estimates), #6074 (paid, not
-- closed). No schema change. repair_orders and completed_jobs are not touched.
--
-- Run BY HAND in the Supabase SQL editor — SANDBOX FIRST, then PROD. Run the
-- whole file; the result grid is ONE summary row (before/after counts + what was
-- skipped). Safe to re-run: a second run finds nothing to do and reports 0.
--
-- SELF-GUARDING (staging-db.md §8.2/§8.3): refuses to run when app_env is empty or says PROD — it cannot touch prod.
-- ============================================================================

-- ── 1. guard + backup table ────────────────────────────────────────────────
do $$
declare v text;
begin
  select env into v from public.app_env limit 1;
  if v is null then
    raise exception 'app_env HAS NO ROW — STOP. Every guard would silently match nothing. Stamp this database first (staging-db.md §8).';
  end if;
  if v like 'PROD%' then
    raise exception 'WRONG PROJECT: % — this is the SANDBOX file, refusing', v;
  end if;

  create table if not exists public.floor_ghost_backup_20260919 (
    backup_id    bigserial primary key,
    backed_up_at timestamptz not null default now(),
    src_table    text not null,          -- shopboard_parking | shopboard_pickup | shopboard_lifts
    row_id       text not null,          -- the floor row's id (uuid for lot/pickup, bay number for lifts)
    po           text not null,
    ro_status    text not null,          -- the RO status seen at run time ('closed')
    row_data     jsonb not null          -- the whole floor row, before
  );
  alter table public.floor_ghost_backup_20260919 enable row level security;
  raise notice 'guard ok on %', v;
end $$;

-- ── 2. back up + remove/clear, in ONE statement → one summary row ──────────
with listed(po) as (
  values ('6017'), ('6027'), ('6029'), ('6030'), ('6033'), ('6040'), ('6043'),
         ('6053'), ('6056'), ('6051'), ('6045'), ('6066'), ('6071'), ('6069')
), floor_rows as (
  select 'shopboard_parking'::text as src, p.id::text as row_id, p.po, to_jsonb(p) as row_data
    from public.shopboard_parking p where p.po in (select po from listed)
  union all
  select 'shopboard_pickup', k.id::text, k.po, to_jsonb(k)
    from public.shopboard_pickup k where k.po in (select po from listed)
  union all
  select 'shopboard_lifts', l.id::text, l.po, to_jsonb(l)
    from public.shopboard_lifts l where l.po in (select po from listed)
), ro_state as (
  -- every distinct CURRENT status of the RO(s) with this po; 'closed' only when all are closed
  select l.po,
         (select string_agg(distinct r.status::text, ',') from public.repair_orders r where r.po = l.po) as statuses
    from listed l
), targets as (
  select f.src, f.row_id, f.po, f.row_data, s.statuses
    from floor_rows f join ro_state s on s.po = f.po
   where s.statuses = 'closed'                                           -- re-checked NOW
     and (select env from public.app_env limit 1) not like 'PROD%'  -- wrong project ⇒ 0 rows
), backed as (
  insert into public.floor_ghost_backup_20260919 (src_table, row_id, po, ro_status, row_data)
  select src, row_id, po, statuses, row_data from targets
  returning src_table
), del_lot as (
  delete from public.shopboard_parking
   where id::text in (select row_id from targets where src = 'shopboard_parking')
  returning po
), del_pickup as (
  delete from public.shopboard_pickup
   where id::text in (select row_id from targets where src = 'shopboard_pickup')
  returning po
), cleared_lift as (
  -- the empty-bay shape: EXACTLY shared/floor-clear.js EMPTY_LIFT
  update public.shopboard_lifts
     set po = '', vehicle = '', customer = '', work = '', status = 'empty', notes = '',
         arrival_date = null, assigned_tech = '', tech_status = 'available',
         tech_notes = '', job_category = '', warranty = false
   where id::text in (select row_id from targets where src = 'shopboard_lifts')
  returning id
), cars_before as (
  select (select count(*) from public.shopboard_parking where trim(coalesce(vehicle, '')) <> '')
       + (select count(*) from public.shopboard_pickup  where trim(coalesce(vehicle, '')) <> '')
       + (select count(*) from public.shopboard_lifts   where trim(coalesce(vehicle, '')) <> '') as n
)
select
  (select env from public.app_env limit 1)                                       as database,
  (select n from cars_before)                                                    as floor_cars_before,
  (select count(*) from targets)                                                 as ghost_rows_found,
  (select count(*) from backed)                                                  as rows_backed_up,
  (select count(*) from del_lot)                                                 as lot_rows_deleted,
  (select count(*) from del_pickup)                                              as pickup_rows_deleted,
  (select count(*) from cleared_lift)                                            as lift_bays_cleared,
  (select n from cars_before)
    - (select count(*) from targets where trim(coalesce(row_data->>'vehicle', '')) <> '') as floor_cars_after,
  (select string_agg(distinct po, ', ' order by po) from targets)                as pos_removed,
  (select string_agg(l.po || ' (RO is ' || s.statuses || ')', ', ' order by l.po)
     from listed l join ro_state s on s.po = l.po
    where s.statuses is not null and s.statuses <> 'closed'
      and l.po in (select po from floor_rows))                                   as skipped_ro_not_closed,
  (select string_agg(l.po, ', ' order by l.po)
     from listed l join ro_state s on s.po = l.po
    where s.statuses is null and l.po in (select po from floor_rows))             as skipped_no_ro,
  (select string_agg(l.po, ', ' order by l.po)
     from listed l where l.po not in (select po from floor_rows))                as not_on_floor;

-- ── VERIFY afterwards (read-only; expect 0 rows from the first query) ───────
--   -- any listed PO still on the floor with a closed RO?
--   select 'lot' t, p.po from public.shopboard_parking p join public.repair_orders r on r.po = p.po
--    where r.status = 'closed' and p.po in ('6017','6027','6029','6030','6033','6040','6043','6053','6056','6051','6045','6066','6071','6069')
--   union all select 'pickup', k.po from public.shopboard_pickup k join public.repair_orders r on r.po = k.po
--    where r.status = 'closed' and k.po in ('6017','6027','6029','6030','6033','6040','6043','6053','6056','6051','6045','6066','6071','6069')
--   union all select 'lift', l.po from public.shopboard_lifts l join public.repair_orders r on r.po = l.po
--    where r.status = 'closed' and l.po in ('6017','6027','6029','6030','6033','6040','6043','6053','6056','6051','6045','6066','6071','6069');
--   -- the six bays are all still there; the cleared one is empty
--   select id, po, vehicle, status from public.shopboard_lifts order by id;
--   -- what was backed up
--   select src_table, row_id, po, ro_status, backed_up_at from public.floor_ghost_backup_20260919 order by po;


-- ════════════════════════════════════════════════════════════════════════════
-- UNDO (not run). Puts every backed-up car back exactly as it was. Lot/pickup
-- rows are re-inserted with their original ids (skipped if the id exists again);
-- a lift bay is restored only if it is still empty (never overwrites a new car).
--
--   insert into public.shopboard_parking
--   select (jsonb_populate_record(null::public.shopboard_parking, b.row_data)).*
--     from public.floor_ghost_backup_20260919 b
--    where b.src_table = 'shopboard_parking'
--      and not exists (select 1 from public.shopboard_parking x where x.id::text = b.row_id);
--
--   insert into public.shopboard_pickup
--   select (jsonb_populate_record(null::public.shopboard_pickup, b.row_data)).*
--     from public.floor_ghost_backup_20260919 b
--    where b.src_table = 'shopboard_pickup'
--      and not exists (select 1 from public.shopboard_pickup x where x.id::text = b.row_id);
--
--   update public.shopboard_lifts l
--      set po = r.po, vehicle = r.vehicle, customer = r.customer, work = r.work,
--          status = r.status, notes = r.notes, arrival_date = r.arrival_date,
--          assigned_tech = r.assigned_tech, tech_status = r.tech_status,
--          tech_notes = r.tech_notes, job_category = r.job_category, warranty = r.warranty
--     from (select b.row_id, (jsonb_populate_record(null::public.shopboard_lifts, b.row_data)).*
--             from public.floor_ghost_backup_20260919 b where b.src_table = 'shopboard_lifts') r
--    where l.id::text = r.row_id and trim(coalesce(l.vehicle, '')) = '';
--
--   -- when no longer needed:  drop table public.floor_ghost_backup_20260919;
-- ════════════════════════════════════════════════════════════════════════════
