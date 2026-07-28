/* ============================================================
   ctm-webhook.js — CallTrackingMetrics webhook capture stub (CrisData).

   RECONNAISSANCE SLICE. Its ONLY job: receive a CTM webhook POST, log the
   COMPLETE raw payload + all headers to ctm_webhook_log, and return 200.
   No parsing of caller/phone/vehicle, no matching, no UI, no RO/estimate —
   that is all deliberately out of scope. We are logging so we can SEE what
   CTM actually sends before building anything.

   HARD CONSTRAINT: respond 200 as early as possible, and respond 200 even on
   internal error. CTM retries on slow/failed responses, which produces
   duplicate deliveries. The whole handler is wrapped so a non-200 never
   reaches CTM in this phase.

   Signature is LOG-ONLY here — computed, stored, compared, but NEVER enforced.
   The exact signing string is an assumption (X-CTM-Time + raw body); we confirm
   it later by comparing real logged values, then turn on enforcement.
   ============================================================ */

import crypto from 'node:crypto';

// Vercel's default body parser consumes and re-serializes the request, which
// destroys the exact bytes signature verification needs. Turn it off and read
// the raw stream ourselves.
export const config = { api: { bodyParser: false } };

// Supabase REST — same project as the rest of api/. This table is written with
// the SERVICE-ROLE key (server-side only, bypasses RLS). ctm_webhook_log is
// default-deny to anon, so the publishable key the boards ship cannot touch it.
const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';

// Vercel's edge injects its OWN infrastructure headers onto the incoming
// request — including x-vercel-oidc-token (a real signed project JWT) and
// x-vercel-proxy-signature. Those are Vercel's live credentials, not anything
// CTM sent, and must never be persisted. Strip exactly these two (case-
// insensitive) and keep every other header verbatim — we still don't know
// which CTM headers matter. Exported for the unit test.
const REDACTED_HEADERS = new Set(['x-vercel-oidc-token', 'x-vercel-proxy-signature']);

export function redactHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    if (REDACTED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = headers[k];
  }
  return out;
}

// Read the raw request stream to a string without any parsing.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Candidate CTM signature: HMAC-SHA1(secret, X-CTM-Time + raw body), hex.
// ASSUMPTION about the signing string — logged, never trusted. Returns null if
// the secret is unset so a missing env var never throws.
function computeCandidateSignature(secret, ctmTime, rawBody) {
  if (!secret) return null;
  const signingString = `${ctmTime == null ? '' : ctmTime}${rawBody}`;
  return crypto.createHmac('sha1', secret).update(signingString, 'utf8').digest('hex');
}

// Best-effort insert into ctm_webhook_log via PostgREST with the service-role
// key. Returns the inserted row (Prefer: return=representation) or null; never
// throws — a logging failure must not turn into a non-200 to CTM.
async function logRow(row) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[ctm-webhook] SUPABASE_SERVICE_ROLE_KEY not set — cannot log row.');
    return null;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ctm_webhook_log`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      console.error('[ctm-webhook] insert failed', r.status, await r.text());
      return null;
    }
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    console.error('[ctm-webhook] insert threw', e);
    return null;
  }
}

export default async function handler(req, res) {
  // GET — reachability check so the endpoint can be opened in a browser after
  // deploy. No logging, just proof it's live.
  if (req.method === 'GET') {
    return res.status(200).send('ok');
  }

  // Anything that isn't POST: still 200 (never surface a non-200 to CTM), but
  // don't log — it isn't a webhook delivery.
  if (req.method !== 'POST') {
    return res.status(200).send('ok');
  }

  try {
    // 1. Raw bytes first — before anything slow or fallible.
    const rawBody = await readRawBody(req);

    // 2. Signature: compute the candidate, store received + computed + match.
    //    LOG ONLY — never reject.
    const sigReceived = (req.headers['x-ctm-signature'] || null);
    const ctmTime = (req.headers['x-ctm-time'] || null);
    const sigComputed = computeCandidateSignature(process.env.CTM_SECRET_KEY, ctmTime, rawBody);
    const sigMatch = (sigReceived != null && sigComputed != null)
      ? (sigReceived === sigComputed)
      : null;

    // 3. Parse the body defensively. A parse failure leaves body null, keeps
    //    body_raw, and records the error — the row is written regardless.
    let body = null;
    let parseError = null;
    if (rawBody && rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch (e) {
        parseError = String(e && e.message ? e.message : e);
      }
    }

    // 4. Log EVERY header (complete object, not a subset) — minus Vercel's own
    //    injected credential headers (see redactHeaders) — plus both body forms.
    await logRow({
      headers: redactHeaders(req.headers),
      body,
      body_raw: rawBody,
      sig_received: sigReceived,
      sig_computed: sigComputed,
      sig_match: sigMatch,
      parse_error: parseError,
    });
  } catch (e) {
    // Never surface a non-200 to CTM in this phase — log and move on.
    console.error('[ctm-webhook] handler error', e);
  }

  return res.status(200).send('ok');
}
