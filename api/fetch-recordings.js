/* ============================================================
   api/fetch-recordings.js — call-recordings pipeline SLICE A, PART 2 (cron).

   Every 5 minutes (Vercel cron → vercel.json): pick the oldest `pending`
   recordings under the attempt cap, download each remote_url (the CTM API URL,
   which 302-redirects to a TEMPORARY S3 link — we ALWAYS re-request it fresh,
   never store/reuse the amazonaws.com url), upload the bytes to the PRIVATE
   `call-recordings` bucket at <yyyy-mm>/<ctm_call_id>.mp3 (upsert), then flip
   the row to 'ready' + storage_path.

   On failure: increment fetch_attempts + store last_error, leave 'pending' so
   the next run retries; at MAX_FETCH_ATTEMPTS set 'failed'.

   Service-role ONLY (bypasses the recordings/bucket RLS, which is default-deny).
   NEVER the anon key. Capped per run so the function can't time out.
   ============================================================ */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hygemiszxwmyrkmhbjub.supabase.co'; // staging deployments set SUPABASE_URL (Preview env) to the staging project; prod unset -> this fallback
const BUCKET = 'call-recordings';

// Cap per invocation so a slow batch of large files can't run past the function
// timeout. The 5-minute cadence drains a backlog across runs.
export const MAX_PER_RUN = 8;
// A recording is abandoned after this many failed attempts.
export const MAX_FETCH_ATTEMPTS = 5;

// Storage object key: <yyyy-mm>/<ctm_call_id>.mp3, month from recorded_at (else
// now). Pure + exported so the path convention is locked by a test. `now` is
// injectable for deterministic testing.
export function computeStoragePath(ctmCallId, recordedAtIso, now) {
  const d = recordedAtIso ? new Date(recordedAtIso) : (now || new Date());
  const base = isNaN(d.getTime()) ? (now || new Date()) : d;
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}/${ctmCallId}.mp3`;
}

// The row patch after an attempt. ok=true → 'ready' + storage_path (+ clear the
// error). ok=false → attempts+1, last_error, and 'failed' once the cap is hit,
// else back to 'pending' for the next run. Pure + exported so the retry/failure
// ladder is locked by a test.
export function nextFetchState(prevAttempts, ok, opts) {
  const o = opts || {};
  if (ok) {
    return { fetch_status: 'ready', storage_path: o.storagePath, last_error: null };
  }
  const attempts = (Number(prevAttempts) || 0) + 1;
  return {
    fetch_attempts: attempts,
    last_error: (o.error != null ? String(o.error) : 'unknown error').slice(0, 800),
    fetch_status: attempts >= MAX_FETCH_ATTEMPTS ? 'failed' : 'pending',
  };
}

// Vercel cron auth: when CRON_SECRET is set, Vercel sends
// `Authorization: Bearer <CRON_SECRET>`. Require it if configured; if it isn't
// set, allow (and warn) so the very first deploy still runs.
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) { console.warn('[fetch-recordings] CRON_SECRET not set — running unauthenticated.'); return true; }
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return auth === `Bearer ${secret}`;
}

async function processOne(rec, headers) {
  // 1. Download the audio (follow the CTM→S3 302; no credentials needed).
  let bytes;
  try {
    const r = await fetch(rec.remote_url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`download ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length) throw new Error('empty audio body');
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  // 2. Upload to the private bucket (upsert so a re-fetch overwrites cleanly).
  const path = computeStoragePath(rec.ctm_call_id, rec.recorded_at);
  try {
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' },
      body: bytes,
    });
    if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, storagePath: path };
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[fetch-recordings] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // Work-list: pending + under the attempt cap, oldest first, capped per run.
  let pending = [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/recordings` +
      `?fetch_status=eq.pending&fetch_attempts=lt.${MAX_FETCH_ATTEMPTS}` +
      `&order=created_at.asc&limit=${MAX_PER_RUN}` +
      `&select=id,ctm_call_id,remote_url,recorded_at,fetch_attempts`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      console.error('[fetch-recordings] work-list query failed', r.status, await r.text());
      return res.status(502).json({ error: 'query failed' });
    }
    pending = await r.json();
  } catch (e) {
    console.error('[fetch-recordings] work-list threw', e);
    return res.status(502).json({ error: 'query failed' });
  }

  let ready = 0, retriable = 0, failed = 0;
  for (const rec of pending) {
    const outcome = await processOne(rec, headers);
    const patch = { ...nextFetchState(rec.fetch_attempts, outcome.ok, { storagePath: outcome.storagePath, error: outcome.error }), updated_at: new Date().toISOString() };
    try {
      const p = await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${encodeURIComponent(rec.id)}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (!p.ok) console.error('[fetch-recordings] status patch failed', rec.id, p.status, await p.text());
    } catch (e) {
      console.error('[fetch-recordings] status patch threw', rec.id, e);
    }
    if (outcome.ok) ready++;
    else if (patch.fetch_status === 'failed') failed++;
    else retriable++;
  }

  return res.status(200).json({ processed: pending.length, ready, retriable, failed });
}
