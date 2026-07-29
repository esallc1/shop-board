/* ============================================================
   api/backfill-recordings.js — call-recordings pipeline SLICE A, PART 3.

   One-time, idempotent seed. Scans ctm_webhook_log for `end` deliveries that
   carried audio (trigger_hint='end', body.audio present) and creates a pending
   `recordings` row for every ctm_call_id not already present (~40 rows from
   July 29). Same on-conflict(ctm_call_id)-do-nothing as the live webhook, so it
   is SAFELY RE-RUNNABLE — a second run inserts nothing new.

   Service-role ONLY (recordings/bucket RLS is default-deny). Manual trigger:
     curl -X POST -H "Authorization: Bearer $CRON_SECRET" .../api/backfill-recordings
   ============================================================ */

import { mapRecordingRow } from './ctm-webhook.js';

const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';

// Keep only the FIRST body per ctm_call_id — the log holds a row per delivery,
// so retries mean several `end` rows share one id. Pure + exported for a test.
export function dedupeByCtmCallId(bodies) {
  const seen = new Set(), out = [];
  for (const b of bodies || []) {
    if (!b || b.id == null || seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

// Build the recordings rows to seed from raw ctm_webhook_log rows: take each
// row's `body`, keep only those with non-empty audio, dedupe by ctm_call_id, and
// map via the SAME mapRecordingRow the webhook uses (call_id from callIdMap, or
// null). Pure + exported so the whole transform is testable without a DB.
export function buildBackfillRows(logRows, callIdMap) {
  const bodies = (logRows || []).map((r) => r && r.body).filter(Boolean);
  const withAudio = bodies.filter((b) => b && b.audio != null && String(b.audio).trim() !== '');
  const deduped = dedupeByCtmCallId(withAudio);
  const map = callIdMap || {};
  return deduped.map((b) => mapRecordingRow(b, map[b.id])).filter(Boolean);
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) { console.warn('[backfill-recordings] CRON_SECRET not set — running unauthenticated.'); return true; }
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[backfill-recordings] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // 1. Every logged `end` delivery's parsed body.
  let logRows = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ctm_webhook_log?trigger_hint=eq.end&select=body`, { headers });
    if (!r.ok) {
      console.error('[backfill-recordings] log scan failed', r.status, await r.text());
      return res.status(502).json({ error: 'scan failed' });
    }
    logRows = await r.json();
  } catch (e) {
    console.error('[backfill-recordings] log scan threw', e);
    return res.status(502).json({ error: 'scan failed' });
  }

  // 2. Resolve call_id for each distinct ctm_call_id in ONE lookup.
  const distinctIds = dedupeByCtmCallId(
    logRows.map((r) => r && r.body).filter((b) => b && b.id != null && b.audio != null && String(b.audio).trim() !== '')
  ).map((b) => b.id);
  const callIdMap = {};
  if (distinctIds.length) {
    try {
      const inList = distinctIds.map((n) => encodeURIComponent(n)).join(',');
      const r = await fetch(`${SUPABASE_URL}/rest/v1/calls?ctm_call_id=in.(${inList})&select=id,ctm_call_id`, { headers });
      if (r.ok) {
        for (const row of await r.json()) { if (row && row.ctm_call_id != null) callIdMap[row.ctm_call_id] = row.id; }
      } else {
        console.warn('[backfill-recordings] call_id lookup failed', r.status);   // non-fatal → call_id stays null
      }
    } catch (e) { console.warn('[backfill-recordings] call_id lookup threw', e); }
  }

  // 3. Build + bulk upsert (on-conflict-do-nothing). return=representation so we
  //    can report how many were actually NEW — a re-run reports inserted=0.
  const rows = buildBackfillRows(logRows, callIdMap);
  let inserted = 0;
  if (rows.length) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/recordings?on_conflict=ctm_call_id`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
      if (!r.ok) {
        console.error('[backfill-recordings] upsert failed', r.status, await r.text());
        return res.status(502).json({ error: 'upsert failed' });
      }
      const back = await r.json();
      inserted = Array.isArray(back) ? back.length : 0;
    } catch (e) {
      console.error('[backfill-recordings] upsert threw', e);
      return res.status(502).json({ error: 'upsert failed' });
    }
  }

  return res.status(200).json({ scanned: logRows.length, candidates: rows.length, inserted });
}
