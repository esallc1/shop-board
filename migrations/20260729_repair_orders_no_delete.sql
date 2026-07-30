-- ============================================================
-- repair_orders: make it create/read/update but NOT delete for the anon key
-- the boards ship. Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
-- BY HAND. Cris runs migrations manually; the app never runs this.
--
-- WHY:
--   A repair order carries payments and an invoice the customer holds — it's a
--   financial record, and financial records are append-only. A cancelled order
--   isn't erased; a status is added (we close/archive, never delete). This also
--   protects the comeback chain: parent_ro_id is `on delete set null`, so a
--   stray anon DELETE would silently orphan every child comeback. Denying anon
--   DELETE closes that door at the DB level.
--
-- WHY IT'S SAFE (loses no capability):
--   A read-only trace found ZERO deletes on repair_orders anywhere — boards,
--   api/, migrations, triggers. Closing is an UPDATE; archiving is a COPY into
--   completed_jobs. Nothing in the app deletes a repair_orders row today.
--
-- WHAT THIS CHANGES:
--   The existing policy is "Allow anon full access to repair_orders" from
--   migrations/20260716_ro_foundation.sql (~line 404), created as
--   `for all to anon using (true) with check (true)`. Postgres cannot narrow a
--   FOR ALL policy in place, so it is DROPPED and replaced with three separate
--   policies — SELECT, INSERT, UPDATE. There is deliberately NO DELETE policy,
--   which means DELETE is denied by default (RLS default-deny for any command
--   with no permissive policy).
--
--   ONLY the allowed COMMANDS change. The anon grant and `using (true) /
--   with check (true)` are kept on the three that remain — who and which rows
--   are untouched; app-level (PIN) scoping stays exactly as it is.
--
-- SCOPE: repair_orders ONLY. ro_line_items keeps full access (editing an RO
--   legitimately deletes line items). ro_payments, todos, marketing_content,
--   projects and every other anon-full-access table are untouched — narrowing
--   the shopwide convention is its own conversation, not this migration.
--
-- ⚠️ NOTE FOR CRIS: service_role BYPASSES RLS. Deleting a row by hand in the
--   Supabase SQL editor still works, and any future service-role endpoint still
--   could. That is intended — a deliberate act by the owner, not a stray client
--   call. This migration only removes DELETE from the anon (board) key.
--
-- IDEMPOTENT: every policy is dropped-if-exists before it is (re)created, so a
--   re-run never throws 42710 ("policy already exists"). Wrapped in ONE
--   transaction so there is never a window where the boards have no read policy.
-- ============================================================

begin;

-- RLS is already on from the foundation migration; re-assert it harmlessly so
-- this file is self-contained (no-op if already enabled).
alter table public.repair_orders enable row level security;

-- Remove the FOR ALL policy — it grants DELETE and cannot be narrowed in place.
drop policy if exists "Allow anon full access to repair_orders" on public.repair_orders;

-- SELECT — boards read ROs. (SELECT policies take USING only.)
drop policy if exists "Allow anon select on repair_orders" on public.repair_orders;
create policy "Allow anon select on repair_orders"
  on public.repair_orders
  for select
  to anon
  using (true);

-- INSERT — the New RO wizard mints ROs. (INSERT policies take WITH CHECK only.)
drop policy if exists "Allow anon insert on repair_orders" on public.repair_orders;
create policy "Allow anon insert on repair_orders"
  on public.repair_orders
  for insert
  to anon
  with check (true);

-- UPDATE — stage changes, close, edits. (UPDATE policies take USING + WITH CHECK.)
drop policy if exists "Allow anon update on repair_orders" on public.repair_orders;
create policy "Allow anon update on repair_orders"
  on public.repair_orders
  for update
  to anon
  using (true)
  with check (true);

-- (No DELETE policy on purpose → anon DELETE is denied by default.)

commit;

-- ============================================================
-- VERIFY (run after applying):
--   -- exactly three anon policies, commands SELECT / INSERT / UPDATE, no DELETE:
--   select policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and tablename = 'repair_orders'
--    order by cmd;
--
-- THEN VERIFY IN THE APP (anon key):
--   1. Open an RO, change its Stage, confirm it saves.            (UPDATE works)
--   2. Create a new RO through the wizard.                        (INSERT works)
--   3. Close a comeback and confirm the archive row appears in
--      completed_jobs.                                            (UPDATE + copy)
--   4. A delete attempt with the anon key now FAILS with an RLS
--      error instead of silently succeeding.                     (DELETE denied)
-- ============================================================
