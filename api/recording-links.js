/* ============================================================
   api/recording-links.js — call-recordings pipeline SLICE B, PART 2 (reader).

   POST { call_ids: [<calls.id>, ...] } → for each call that HAS a recording:
       { call_id, status: 'pending'|'ready'|'failed', duration_seconds, playback_url }
   A call with no recording is simply absent from the results.

   playback_url is a SHORT-LIVED SIGNED URL minted from the PRIVATE
   `call-recordings` bucket, and ONLY for 'ready' rows. It's requested on demand
   (the player asks when the slide-out opens / at play time), so a few minutes of
   validity is plenty.

   ── SECURITY (this endpoint is called from the boards, which ship the anon key) ──
   • Service-role key server-side ONLY — the recordings table + bucket are RLS
     default-deny; nothing client-side can read them.
   • READ-ONLY. It never writes recordings and never mutates anything.
   • It accepts ONLY call ids. It must NEVER accept a storage_path from the caller
     — if it signed an arbitrary caller-supplied path it would become a signed-URL
     generator for the whole private bucket. The path is resolved server-side from
     the recordings row keyed by call_id.
   • It NEVER returns remote_url, storage_path, or last_error — not on the happy
     path, not in any error branch. Only the four whitelisted fields ship. This is
     locked by shapeReadyRow / publicRow being the ONLY shapers + a unit test.
   • No CRON_SECRET (it's a board endpoint, not a cron), but the read-only +
     ids-only stance above is what keeps it safe to expose.
   ============================================================ */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hygemiszxwmyrkmhbjub.supabase.co'; // staging deployments set SUPABASE_URL (Preview env) to the staging project; prod unset -> this fallback
const BUCKET = 'call-recordings';

// Cap the batch so a caller can't ask us to sign an unbounded number of URLs in
// one request. The call log shows one day of calls — well under this.
export const MAX_CALL_IDS = 50;
// Signed-URL validity. A few minutes: the player requests on open / at play, and
// re-requests if a url ages out, so short is safe and leaks less.
export const SIGNED_URL_TTL_SECONDS = 300;

// Sanitize the caller's `call_ids`: keep only positive integer ids (calls.id is
// a bigserial), dedupe, cap at MAX_CALL_IDS. Pure + exported so the input
// contract is locked by a test. Anything non-numeric is dropped silently — this
// endpoint only ever deals in ids, never paths or free text.
export function sanitizeCallIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (out.length >= MAX_CALL_IDS) break;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// Shape ONE recordings row into the PUBLIC payload — the ONLY place a row becomes
// client-facing. Whitelist, not blacklist: we build a fresh object with exactly
// the four allowed fields, so remote_url / storage_path / last_error can never
// leak even if the select or a future column change hands us more. playbackUrl is
// passed in (minted separately) and attached only for 'ready'. Pure + exported so
// the no-leak invariant is locked by a test.
export function publicRow(rec, playbackUrl) {
  const status = ['pending', 'ready', 'failed'].includes(rec && rec.fetch_status)
    ? rec.fetch_status : 'failed';
  const duration = rec && rec.duration_seconds != null ? Number(rec.duration_seconds) : null;
  return {
    call_id: rec ? rec.call_id : null,
    status,
    duration_seconds: Number.isFinite(duration) ? duration : null,
    playback_url: status === 'ready' && playbackUrl ? playbackUrl : null,
    // A HUMAN's assignment (api/recording-assign), so the customer record can
    // restore it after a reload instead of only re-deriving from calls.ro_id.
    // NOT in the secret class: it's an internal shop id the customer record
    // already holds for its vehicle chips — unlike remote_url / storage_path /
    // last_error, which stay server-side and are still excluded below.
    vehicle_id: rec && rec.vehicle_id != null ? rec.vehicle_id : null,
  };
}

// Mint a short-lived signed URL for one storage_path in the private bucket, via
// the Storage REST sign endpoint (service-role). Returns the absolute URL, or
// null on any failure (the row still ships as 'ready' with a null url — the
// player re-mints at click, so a transient signing hiccup is not fatal).
async function signPlaybackUrl(storagePath, headers) {
  if (!storagePath) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    });
    if (!r.ok) { console.warn('[recording-links] sign failed', r.status); return null; }
    const j = await r.json();
    // signedURL is a relative path under /storage/v1 (e.g. /object/sign/...).
    const rel = j && (j.signedURL || j.signedUrl);
    if (!rel) return null;
    return `${SUPABASE_URL}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}`;
  } catch (e) {
    console.warn('[recording-links] sign threw', e && e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const callIds = sanitizeCallIds(req.body && req.body.call_ids);
  if (!callIds.length) return res.status(200).json({ results: [] });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[recording-links] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // Look up recordings by call_id. Select ONLY what shaping needs — never
  // remote_url / last_error. storage_path is used server-side to sign, and is
  // dropped by publicRow before anything ships.
  let rows = [];
  try {
    const inList = callIds.join(',');
    const url = `${SUPABASE_URL}/rest/v1/recordings` +
      `?call_id=in.(${inList})` +
      `&select=call_id,fetch_status,duration_seconds,storage_path,vehicle_id`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      console.error('[recording-links] query failed', r.status, await r.text());
      return res.status(502).json({ error: 'query failed' });
    }
    rows = await r.json();
  } catch (e) {
    console.error('[recording-links] query threw', e);
    return res.status(502).json({ error: 'query failed' });
  }

  // Sign 'ready' rows in parallel, then shape everything through publicRow.
  const results = await Promise.all((rows || []).map(async (rec) => {
    const playbackUrl = rec && rec.fetch_status === 'ready'
      ? await signPlaybackUrl(rec.storage_path, headers)
      : null;
    return publicRow(rec, playbackUrl);
  }));

  return res.status(200).json({ results });
}
