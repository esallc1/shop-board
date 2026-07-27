-- ============================================================
-- Feature-adoption view — owner board "who actually uses what" tab.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub). READ-ONLY
-- reporting view over data that already exists — no new instrumentation.
--
-- Grain: one row per (person, metric): event_count + last_touched. All the
-- counting/grouping is server-side; the client reads this view ONCE.
--
-- METRIC = a single STAMPED ACTION, never "used the feature". This matters:
-- e.g. cores_returned counts ONLY marking a core returned — it does NOT count
-- Daiana entering cores from receipts (that insert carries no attribution),
-- so a low/"never" here is a blind spot, not proof of non-use. The UI spells
-- out each metric's blind spot. Labels in the client mirror the action
-- ("cores returned", "chat sent", "invoices captured/processed", …).
--
-- NORMALIZATION (one place, here):
--   • "Sleepy Josh" -> "Josh", "Cristian Mendez" -> "Cristian"
--   • Then keep ONLY people present in employees AND active. That single
--     semi-join drops: test junk (Claude (feature verification), __test__,
--     gfh, ghgh, ]p[), inactive staff (Capote), and teardown.html's own
--     hardcoded non-employee tech names (Cuba, Alnar, Dier, chris) — none of
--     which are trustable. No "unknown" bucket.
--
-- teardowns_logged is LOW CONFIDENCE: teardown.html is the discontinued v1
-- tool running off its own hardcoded tech list, predating the employees
-- table. The client marks that chip and says so. (No work proposed on v1.)
-- ============================================================

create or replace view public.feature_adoption as
with raw(person_raw, metric, ts) as (
  select created_by_name,    'todo_created',       created_at   from public.todos             where created_by_name is not null
  union all
  select assigned_to_name,   'todo_completed',     completed_at from public.todos             where assigned_to_name is not null and completed_at is not null
  union all
  select sender_name,        'chat_sent',          created_at   from public.chat_messages     where sender_name is not null
  union all
  select reader_name,        'chat_read',          last_read_at from public.chat_reads        where reader_name is not null
  union all
  select uploaded_by_name,   'invoices_captured',  uploaded_at  from public.invoice_queue     where uploaded_by_name is not null
  union all
  select processed_by_name,  'invoices_processed', processed_at from public.invoice_queue     where processed_by_name is not null and processed_at is not null
  union all
  select returned_by,        'cores_returned',     returned_at  from public.core_charges      where returned_by is not null and returned_at is not null
  union all
  select created_by_name,    'parts_ordered',      created_at   from public.parts_orders      where created_by_name is not null
  union all
  select captured_by,        'marketing_captured', captured_at  from public.marketing_content where captured_by is not null
  union all
  select tech_name,          'teardowns_logged',   created_at   from public.teardowns         where tech_name is not null
  union all
  select tech_name,          'punches',            punched_at   from public.punches           where tech_name is not null
),
norm as (
  select
    case btrim(person_raw)
      when 'Sleepy Josh'     then 'Josh'
      when 'Cristian Mendez' then 'Cristian'
      else btrim(person_raw)          -- Alnar / Dier / chris / Cuba pass through here, dropped by the semi-join below
    end as person,
    metric, ts
  from raw
  where ts is not null
)
select n.person, n.metric, count(*)::int as event_count, max(n.ts) as last_touched
from norm n
where n.person in (select name from public.employees where active)   -- excludes junk, non-employees, inactive
group by n.person, n.metric;

grant select on public.feature_adoption to anon;

-- ============================================================
-- VERIFY (run after applying):
--   select person, metric, event_count, last_touched
--     from public.feature_adoption order by person, metric;
--   -- expect only active-employee names (Cristian, Kevin, Josh, Daiana Mendez,
--   -- Alex, Alnardier); NOT Cuba/Alnar/Dier/chris/Capote/junk. Cory has an
--   -- employees row but no rows here (zero stamped actions) — correct.
-- ============================================================
