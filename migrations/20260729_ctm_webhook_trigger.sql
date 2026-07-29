-- ============================================================
-- CTM webhook trigger hint — recon column for the end / end_immediate triggers.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Purpose: we are about to point TWO more CallTrackingMetrics webhooks at the
-- SAME endpoint (api/ctm-webhook.js) — the `end` and `end_immediate` triggers —
-- purely to CAPTURE what CTM sends at those moments. We do not yet know the
-- end-payload field names and are not building against them.
--
-- Those two webhooks carry a `?trigger=end` / `?trigger=end_immediate` query
-- param; the endpoint records the param value here so the captured rows can be
-- told apart from the (param-less) `start` deliveries. NULL on the start
-- webhook, which points at the bare URL with no param.
--
-- This column is CAPTURE-ONLY. The end payload is deliberately NOT mapped into
-- `calls` — those rows now hold the advisor's typed notes, and running an end
-- payload through the upsert would null real data over the same ctm_call_id.
--
-- Until this migration is applied, the endpoint keeps working: the insert falls
-- back to writing the row WITHOUT trigger_hint on a 42703 (undefined_column)
-- error, so no log row is ever lost in the pre-migration window.
-- ============================================================

alter table public.ctm_webhook_log
  add column if not exists trigger_hint text;

-- ============================================================
-- VERIFY (run after applying, and after the first end / end_immediate delivery):
--   select id, received_at, trigger_hint, parse_error, body_raw
--     from public.ctm_webhook_log
--    order by received_at desc
--    limit 10;
-- ============================================================
