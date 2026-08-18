-- ============================================================
-- Auto-attach (Phase 2) — THE TWO BACKFILLS, kept for the record and for the
-- reverse statements.
--
-- ✅ BOTH PASSES ALREADY RUN ON SANDBOX (efhmefpaijjncwgbvwki) 2026-08-18.
--    Pass 1: UPDATE 64 (64 attached, 25 of them also filed to an RO).
--    Pass 2: UPDATE 17.
--    Net: calls carrying an ro_id went 4 -> 46.
-- ❌ NOT run on prod.
--
-- ⚠️ DO NOT RE-RUN BLINDLY. Both passes are idempotent in the sense that they
--    only ever fill NULL columns (a second run finds nothing left to do), but
--    re-running after a partial reverse would re-stamp rows with a fresh
--    timestamp. Reverse first, then re-run, if that is what you want.
--
-- Requires migrations/20260818_call_auto_attach.sql (the undo tag).
-- The predicate here is the SQL twin of shared/call-auto-attach.js — if you
-- change one, change the other in the SAME COMMIT.
-- See docs/wiring/call-auto-attach.md §1 and §5.
-- ============================================================


-- ════════════════════════════════════════════════════════════════════════
-- PASS 1 — attach the customer (RULE 1), and file the RO too where RULE 2 is
-- unambiguous. Targets calls nobody has claimed: customer_id IS NULL.
-- run id: 11111111-2222-4333-8444-555555555555
-- ════════════════════════════════════════════════════════════════════════
begin;

with cand_ok as (
  select c.id, c.started_at,
         right(regexp_replace(coalesce(c.caller_bare,''), '\D', '', 'g'), 10) as k
  from public.calls c
  where c.customer_id is null            -- never overwrite an existing attach
    and c.not_a_customer_at is null      -- never override a human's "not a customer"
), cand as (
  select * from cand_ok
  where length(k) = 10 and k <> '1234567890' and k !~ '^(.)\1{9}$'
), cust_keys as (
  select distinct cu.id as customer_id,
         right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 10) as k
  from public.customers cu
  cross join lateral (values (cu.phone_primary), (cu.phone_secondary)) as p(phone)
  where length(right(regexp_replace(coalesce(p.phone,''), '\D','','g'),10)) = 10
    and right(regexp_replace(coalesce(p.phone,''), '\D','','g'),10) <> '1234567890'
    and right(regexp_replace(coalesce(p.phone,''), '\D','','g'),10) !~ '^(.)\1{9}$'
), matched as (                          -- RULE 1: exactly one customer, else skip
  select c.id as call_id, c.started_at, (array_agg(ck.customer_id))[1] as customer_id
  from cand c join cust_keys ck on ck.k = c.k
  group by c.id, c.started_at
  having count(distinct ck.customer_id) = 1
), ro_pick as (                          -- RULE 2: exactly one RO OPEN AT CALL TIME
  select m.call_id, (array_agg(r.id))[1] as ro_id
  from matched m
  join public.repair_orders r
    on  r.customer_id = m.customer_id
   and  m.started_at is not null
   and  r.created_at <= m.started_at
   and (r.closed_at   is null or r.closed_at   > m.started_at)
   and (r.declined_at is null or r.declined_at > m.started_at)
   and  not (r.closed_at is null and r.status = 'closed')
  group by m.call_id
  having count(*) = 1
)
update public.calls c
   set customer_id        = m.customer_id,
       auto_attached_at   = now(),
       auto_attach_run_id = '11111111-2222-4333-8444-555555555555'::uuid,
       ro_id              = case when c.ro_id is null then rp.ro_id else c.ro_id end,
       auto_ro_filed_at   = case when c.ro_id is null and rp.ro_id is not null then now() end
  from matched m
  left join ro_pick rp on rp.call_id = m.call_id
 where c.id = m.call_id;

commit;
-- ran: UPDATE 64

-- REVERSE OF PASS 1 (single statement):
--   update public.calls
--      set customer_id        = null,
--          auto_attached_at   = null,
--          auto_attach_run_id = null,
--          ro_id              = case when auto_ro_filed_at is not null then null else ro_id end,
--          auto_ro_filed_at   = null
--    where auto_attach_run_id = '11111111-2222-4333-8444-555555555555'::uuid;
--   -- expect: UPDATE 64
--   Humans never set auto_attach_run_id, so this can only touch the robot's rows.
--   The case guard clears ro_id ONLY where the robot set it.


-- ════════════════════════════════════════════════════════════════════════
-- PASS 2 — file the RO ONLY, on calls a HUMAN had already attached but never
-- filed. Never touches customer_id, never sets auto_attached_at.
-- run id: 22222222-3333-4444-8555-666666666666
--
-- ⚠️ `auto_attach_run_id is null` is LOAD-BEARING, not a nicety. Without it the
--    target set is 72 rows, not 33: it would also catch the 39 pass-1 rows the
--    robot attached but could not file, overwrite THEIR run id with this one,
--    and orphan them from pass 1's undo. (They match zero ROs anyway — pass 1
--    already ruled them out with this identical predicate — so excluding them
--    costs nothing.)
-- ════════════════════════════════════════════════════════════════════════
begin;

with tgt as (
  select c.id, c.customer_id, c.started_at
  from public.calls c
  where c.customer_id is not null
    and c.ro_id is null
    and c.not_a_customer_at is null
    and c.auto_attach_run_id is null     -- HUMAN attaches only — see the note above
    and c.started_at is not null
), pick as (
  select t.id as call_id, (array_agg(r.id))[1] as ro_id
  from tgt t
  join public.repair_orders r
    on  r.customer_id = t.customer_id
   and  r.created_at <= t.started_at
   and (r.closed_at   is null or r.closed_at   > t.started_at)
   and (r.declined_at is null or r.declined_at > t.started_at)
   and  not (r.closed_at is null and r.status = 'closed')
  group by t.id
  having count(*) = 1
)
update public.calls c
   set ro_id              = p.ro_id,
       auto_ro_filed_at   = now(),
       auto_attach_run_id = '22222222-3333-4444-8555-666666666666'::uuid
  from pick p
 where c.id = p.call_id;

commit;
-- ran: UPDATE 17

-- REVERSE OF PASS 2 (single statement):
--   update public.calls
--      set ro_id              = null,
--          auto_ro_filed_at   = null,
--          auto_attach_run_id = null
--    where auto_attach_run_id = '22222222-3333-4444-8555-666666666666'::uuid
--      and auto_attached_at is null;    -- guard: pass-2 rows never carry this
--   -- expect: UPDATE 17
--   customer_id NEVER appears in the SET list, so this statement is
--   STRUCTURALLY unable to undo a human's attach. The two passes undo
--   independently, in any order.


-- ════════════════════════════════════════════════════════════════════════
-- REVERSE OF EVERY LIVE (going-forward) AUTO-ATTACH
-- The webhook and the board stamp AUTO_ATTACH_LIVE_RUN_ID. Same shape as
-- pass 1, because a live attach can set both customer_id and ro_id.
-- ════════════════════════════════════════════════════════════════════════
--   update public.calls
--      set customer_id        = null,
--          auto_attached_at   = null,
--          auto_attach_run_id = null,
--          ro_id              = case when auto_ro_filed_at is not null then null else ro_id end,
--          auto_ro_filed_at   = null
--    where auto_attach_run_id = '00000000-0000-4000-8000-000000000000'::uuid;
--
--   Rows a human has since touched have already left the robot's namespace
--   (un-attach clears all three tags; a manual RO re-file clears
--   auto_ro_filed_at), so this cannot revoke a human decision.
