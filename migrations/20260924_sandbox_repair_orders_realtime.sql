-- ============================================================
-- SANDBOX ONLY — project efhmefpaijjncwgbvwki (test.leetransmissionshop.com).
-- ⛔ DO NOT RUN ON PROD (hygemiszxwmyrkmhbjub): prod has had repair_orders in
--    supabase_realtime since July (20260716_ro_foundation.sql, the REALTIME block).
--
-- RECORD ONLY — ALREADY APPLIED by Cris on the sandbox, 2026-09-24.
--   Re-check after applying returned 1 row (query at the bottom).
--
-- Why: the sandbox was built as a copy of prod, but its supabase_realtime
-- publication did not include repair_orders, so no board on test.* received
-- live repair_orders changes (the Whiteboard's "Ready → call for pickup", the
-- RO Board list, the Desk). Found 2026-09-24 while testing the Whiteboard
-- (docs/wiring/whiteboard.md §5): the channel joined but got 0 events, and the
-- list only moved on the 60 s catch-up.
--
-- The check Cris ran first (both projects):
--   PROD    → 1 row (nothing to do)
--   SANDBOX → 0 rows → the line below was run
-- ============================================================

alter publication supabase_realtime add table public.repair_orders;

-- Verify (expect 1 row):
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename = 'repair_orders';
