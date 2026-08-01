-- ============================================================================
-- Office Auth — STEP 1½ : anon → authenticated read + write WIDEN
-- migrations/20260801_office_auth_widen_step1_5.sql   (hand-run in Supabase SQL)
-- ============================================================================
-- WHAT: A signed-in office-login session runs as the `authenticated` role for
--   every board tab on the origin. Most of the schema is anon-scoped, so an
--   authenticated session goes BLIND (reads return 0 rows, direct writes fail
--   silently) until sign-out. This migration extends the anon-only policies to
--   ALSO cover `authenticated`, so a signed-in office session sees and operates
--   the boards EXACTLY like the anon (phone+PIN) session does today.
--
-- SAFETY — this file is ADD-ONLY. Verify before running:
--   • Every statement is `create policy ... to authenticated` or a matching
--     `grant ... to authenticated`. No table has RLS enabled/forced here.
--   • The only `drop policy if exists` calls target the NEW `auth …` /
--     `Allow authenticated …` policy names this file creates (for idempotent
--     re-runs) — NEVER an existing `anon`/`public` policy. No existing policy is
--     dropped, narrowed, or altered. Techs/PIN and everything on anon keep working.
--   • Enforces nothing. Changes who-can-do-what by ZERO. It only stops a
--     signed-in session from going blind. (Enforcement / RLS lockdown = Step 2+.)
--
-- SCOPE NOTE (re-audit 2026-08-01, reconciled vs live 0a/0b): the parked §7 list
--   missed board-WRITE gaps (push_subscriptions, tech_whiteboard, shopboard_tables
--   writes; punches INSERT) and storage-object WRITES (4 buckets) — folded in below.
--   Reconciled against the live posture:
--     • `employees` is `public`-scoped (role {public}) → authenticated ALREADY has
--       full read+write. This migration touches employees ZERO. The §5c employees
--       RLS lockdown is what will actually close it, and it MUST land BEFORE anyone
--       besides the owner gets an auth account (today only the owner has one).
--     • `chat_messages`, `core_charges`, `transmissions`, and the `employee-photos`
--       bucket are already {public} / carry their own authenticated policies →
--       omitted (nothing to widen).
--     • `punches` is append-and-read (anon has INSERT + SELECT only, no update/
--       delete — deliberate time-clock integrity) → widened INSERT only.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PART 0 — VERIFY FIRST (read-only). [ALREADY RUN & RECONCILED 2026-08-01.]
--   Left here for the record / re-runs. Re-eyeball if the schema changed since.
-- ════════════════════════════════════════════════════════════════════════════
-- 0a. Table policies (role + cmd) for every object we touch:
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and tablename in (
        'employees','repair_orders','calls','change_requests','announcements','todos',
        'invoice_queue','core_charges','customers','vehicles','ro_line_items','attachments',
        'completed_jobs','chat_conversations','chat_messages','chat_members','chat_reads',
        'ro_payments','ro_diagnostic_codes','rebuild_book_hours','projects','planning_items',
        'parts_orders','marketing_content','invoice_types','expense_categories','invoice_po_lines',
        'payment_methods','shop_settings','dashboard_preferences','tech_whiteboard',
        'shopboard_tables','transmissions','punches','customer_phones','push_subscriptions',
        'shopboard_parking','shopboard_lifts','shopboard_pickup')
 order by tablename, cmd, policyname;
-- 0b. ALL storage.objects policies (confirm anon insert/update/delete per bucket):
select policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
 order by policyname;
-- 0c. feature_adoption grants + bucket public flags:
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'feature_adoption';
select id, public from storage.buckets order by id;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — TABLE READS → authenticated  (additive `for select to authenticated`)
--   Omitted (already {public} or own authenticated policy): employees,
--   chat_messages, core_charges, transmissions.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'repair_orders','calls','change_requests','announcements','todos',
    'invoice_queue','customers','vehicles','ro_line_items','attachments',
    'completed_jobs','chat_conversations','chat_members','chat_reads',
    'ro_payments','ro_diagnostic_codes','rebuild_book_hours','projects','planning_items',
    'parts_orders','marketing_content','invoice_types','expense_categories','invoice_po_lines',
    'payment_methods','shop_settings','dashboard_preferences','tech_whiteboard',
    'shopboard_tables','punches','customer_phones','push_subscriptions'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth read '||t, t);
      execute format('create policy %I on public.%I for select to authenticated using (true)', 'auth read '||t, t);
    end if;
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — TABLE WRITES → authenticated  (mirror the existing anon writes)
--   2a. Direct-anon-write tables → `for all to authenticated` (mirrors
--       `for all to anon`). Includes re-audit gaps: push_subscriptions,
--       tech_whiteboard, shopboard_tables.
--   2b. repair_orders: anon has insert + update only (no delete). Mirror.
--   2c. calls: anon has UPDATE only (rows arrive via CTM webhook / service role;
--       boards update them client-side today). Mirror update only.
--   2d. punches: anon has INSERT + SELECT only (append-and-read; time-clock
--       integrity — no update/delete). Mirror INSERT only (select via PART 1).
--   NOT widened here (unchanged):
--     • change_requests, announcements — submitted/posted via /api/* service role.
--     • employees — already {public}; §5c lockdown closes it, not this file.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'todos','chat_conversations','chat_members','chat_reads','marketing_content',
    'shop_settings','dashboard_preferences','projects','planning_items','parts_orders',
    'customers','vehicles','ro_line_items','attachments','completed_jobs','ro_payments',
    'ro_diagnostic_codes','rebuild_book_hours','invoice_queue','invoice_types','expense_categories',
    'invoice_po_lines','payment_methods','customer_phones',
    'push_subscriptions','tech_whiteboard','shopboard_tables'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth write '||t, t);
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', 'auth write '||t, t);
    end if;
  end loop;
end $$;

drop policy if exists "auth insert repair_orders" on public.repair_orders;
create policy "auth insert repair_orders" on public.repair_orders for insert to authenticated with check (true);
drop policy if exists "auth update repair_orders" on public.repair_orders;
create policy "auth update repair_orders" on public.repair_orders for update to authenticated using (true) with check (true);

drop policy if exists "auth update calls" on public.calls;
create policy "auth update calls" on public.calls for update to authenticated using (true) with check (true);

drop policy if exists "auth insert punches" on public.punches;
create policy "auth insert punches" on public.punches for insert to authenticated with check (true);


-- ════════════════════════════════════════════════════════════════════════════
-- PART 3 — STORAGE READS → authenticated  (private buckets read via createSignedUrl)
--   board-backgrounds + employee-photos are PUBLIC buckets (getPublicUrl) → skip.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare b text;
begin
  foreach b in array array['crisdata-attachments','invoice-images','marketing-content'] loop
    execute format('drop policy if exists %I on storage.objects', 'Allow authenticated read '||b);
    execute format('create policy %I on storage.objects for select to authenticated using (bucket_id = %L)',
                   'Allow authenticated read '||b, b);
  end loop;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 4 — STORAGE WRITES → authenticated  (mirror anon's REAL per-bucket posture
--   confirmed in 0b). Scoped by bucket_id — add-only.
--     crisdata-attachments : insert            (anon: insert+read only — NO delete)
--     marketing-content    : insert + delete    (anon: insert+read+delete)
--     invoice-images       : insert + update + delete  (anon: full)
--     board-backgrounds    : insert            (anon: insert+read only — NO update; public read)
--   Omitted: employee-photos (bucket policy is ALL {public} → authenticated
--            already has full access — nothing to add).
-- ════════════════════════════════════════════════════════════════════════════
-- crisdata-attachments (insert only)
drop policy if exists "Allow authenticated insert crisdata-attachments" on storage.objects;
create policy "Allow authenticated insert crisdata-attachments" on storage.objects
  for insert to authenticated with check (bucket_id = 'crisdata-attachments');

-- marketing-content (insert + delete)
drop policy if exists "Allow authenticated insert marketing-content" on storage.objects;
create policy "Allow authenticated insert marketing-content" on storage.objects
  for insert to authenticated with check (bucket_id = 'marketing-content');
drop policy if exists "Allow authenticated delete marketing-content" on storage.objects;
create policy "Allow authenticated delete marketing-content" on storage.objects
  for delete to authenticated using (bucket_id = 'marketing-content');

-- invoice-images (insert + update + delete)
drop policy if exists "Allow authenticated insert invoice-images" on storage.objects;
create policy "Allow authenticated insert invoice-images" on storage.objects
  for insert to authenticated with check (bucket_id = 'invoice-images');
drop policy if exists "Allow authenticated update invoice-images" on storage.objects;
create policy "Allow authenticated update invoice-images" on storage.objects
  for update to authenticated using (bucket_id = 'invoice-images') with check (bucket_id = 'invoice-images');
drop policy if exists "Allow authenticated delete invoice-images" on storage.objects;
create policy "Allow authenticated delete invoice-images" on storage.objects
  for delete to authenticated using (bucket_id = 'invoice-images');

-- board-backgrounds (insert only; public bucket read via getPublicUrl)
drop policy if exists "Allow authenticated insert board-backgrounds" on storage.objects;
create policy "Allow authenticated insert board-backgrounds" on storage.objects
  for insert to authenticated with check (bucket_id = 'board-backgrounds');


-- ════════════════════════════════════════════════════════════════════════════
-- PART 5 — feature_adoption (VIEW, granted to anon only) → also grant authenticated
-- ════════════════════════════════════════════════════════════════════════════
grant select on public.feature_adoption to authenticated;


-- ============================================================================
-- ROLLBACK (removes ONLY what this file adds; existing posture untouched)
-- ============================================================================
/*
do $$
declare t text;
begin
  foreach t in array array[
    'repair_orders','calls','change_requests','announcements','todos','invoice_queue',
    'customers','vehicles','ro_line_items','attachments','completed_jobs',
    'chat_conversations','chat_members','chat_reads','ro_payments','ro_diagnostic_codes',
    'rebuild_book_hours','projects','planning_items','parts_orders','marketing_content','invoice_types',
    'expense_categories','invoice_po_lines','payment_methods','shop_settings','dashboard_preferences',
    'tech_whiteboard','shopboard_tables','punches','customer_phones','push_subscriptions'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'auth read '||t, t);
      execute format('drop policy if exists %I on public.%I', 'auth write '||t, t);
    end if;
  end loop;
end $$;
drop policy if exists "auth insert repair_orders" on public.repair_orders;
drop policy if exists "auth update repair_orders" on public.repair_orders;
drop policy if exists "auth update calls" on public.calls;
drop policy if exists "auth insert punches" on public.punches;
do $$
declare b text;
begin
  foreach b in array array['crisdata-attachments','invoice-images','marketing-content'] loop
    execute format('drop policy if exists %I on storage.objects', 'Allow authenticated read '||b);
  end loop;
end $$;
drop policy if exists "Allow authenticated insert crisdata-attachments" on storage.objects;
drop policy if exists "Allow authenticated insert marketing-content" on storage.objects;
drop policy if exists "Allow authenticated delete marketing-content" on storage.objects;
drop policy if exists "Allow authenticated insert invoice-images" on storage.objects;
drop policy if exists "Allow authenticated update invoice-images" on storage.objects;
drop policy if exists "Allow authenticated delete invoice-images" on storage.objects;
drop policy if exists "Allow authenticated insert board-backgrounds" on storage.objects;
revoke select on public.feature_adoption from authenticated;
*/
