-- ============================================================
-- Bookkeeping Board (Phase 3): delete option for Unprocessed
-- Invoices.
-- Run this in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub)
--
-- invoice_queue itself needs NO new policy — it already has
-- "Allow anon full access to invoice_queue" (for all, i.e. SELECT/
-- INSERT/UPDATE/DELETE) from migrations/20260713_invoice_queue.sql.
-- DELETE was already permitted at the DB level; the app simply never
-- called .delete() on it until now.
--
-- The actual gap was storage: the invoice-images bucket only had
-- insert + read policies (deliberately, per that same migration's
-- "no-delete/audit-trail" comment), so a delete call against a
-- storage object would fail. This migration reverses that -- an
-- intentional, confirmed decision -- by adding the missing delete
-- policy.
--
-- Role scoping caveat: this app has no Supabase Auth anywhere (see
-- every prior migration's RLS comments) -- every board connects with
-- the same shared anon key regardless of which employee/role is
-- logged in, so there is no auth.jwt() claim to scope a DB policy to
-- role='bookkeeping' against. Access control for this feature is
-- app-level instead, same as everywhere else in this app: the delete
-- affordance only exists in bookkeeping-board.html's Unprocessed
-- Invoices queue.
-- ============================================================

create policy "Allow anon delete invoice-images"
  on storage.objects for delete
  to anon
  using (bucket_id = 'invoice-images');
