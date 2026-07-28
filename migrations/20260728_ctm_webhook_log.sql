-- ============================================================
-- CTM webhook capture log — CrisData reconnaissance slice.
-- Run in the Supabase SQL Editor (project hygemiszxwmyrkmhbjub).
--
-- Purpose: api/ctm-webhook.js receives every CallTrackingMetrics webhook POST,
-- logs the COMPLETE raw payload here, and returns 200. This table exists only
-- so we can SEE what CTM actually sends before building anything against it.
-- No parsing, matching, or downstream use — that is deliberately out of scope.
--
-- Both forms of the body are stored:
--   • body_raw  — the exact bytes as received (source of truth for signature work)
--   • body      — JSON.parse(body_raw); NULL + parse_error if it doesn't parse.
-- A parse failure must NEVER prevent the row from being written.
--
-- Signature fields are LOG-ONLY in this phase. sig_computed is a CANDIDATE
-- (HMAC-SHA1 over X-CTM-Time + raw body — an ASSUMPTION, not confirmed). We
-- compare sig_received vs sig_computed across real deliveries to learn the true
-- signing string, then turn on enforcement in a later commit. Nothing is
-- rejected on mismatch here.
--
-- RLS: default-deny (enabled, NO policies). This table holds raw webhook
-- payloads + signatures — the anon publishable key the boards ship must NOT be
-- able to read or write it. Only the server-side service-role key (which
-- bypasses RLS) touches this table.
-- ============================================================

create table if not exists public.ctm_webhook_log (
  id            bigserial primary key,
  received_at   timestamptz not null default now(),
  headers       jsonb not null,
  body          jsonb,
  body_raw      text,
  sig_received  text,
  sig_computed  text,
  sig_match     boolean,
  parse_error   text
);

create index if not exists ctm_webhook_log_received_at_idx
  on public.ctm_webhook_log (received_at desc);

alter table public.ctm_webhook_log enable row level security;
-- No policies on purpose: default-deny for anon/authenticated. The webhook
-- endpoint writes with the service-role key, which bypasses RLS.

-- ============================================================
-- VERIFY (run after applying, and after the first real/test delivery):
--   select id, received_at, sig_received, sig_computed, sig_match, parse_error,
--          jsonb_pretty(headers) as headers, body_raw, jsonb_pretty(body) as body
--     from public.ctm_webhook_log
--    order by received_at desc
--    limit 5;
-- ============================================================
