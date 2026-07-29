/* ============================================================
   ctm-webhook.js — CallTrackingMetrics webhook (CrisData).

   Slice 1 (capture): receive the POST, log the COMPLETE raw payload + all
   headers to ctm_webhook_log, return 200. Still does exactly this.

   Slice 2 (caller card): after the ctm_webhook_log insert, ALSO UPSERT the
   parsed body into `calls`, keyed on ctm_call_id (on conflict do update). The
   advisor board subscribes to realtime INSERTs on `calls` and pops a read-only
   caller card. The upsert is what makes CTM's retries harmless (a retry hits
   ON CONFLICT and updates the same row instead of duplicating) and lets a
   future `end` trigger update that same row.

   STILL out of scope: audio download, transcription, field extraction,
   estimate creation, spam/scam flag (no such field in the payload).

   HARD CONSTRAINT: respond 200 as early as possible, and respond 200 even on
   internal error. CTM retries on slow/failed responses. The whole handler is
   wrapped so a non-200 never reaches CTM in this phase.

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

// PostgREST error 42703 = undefined_column. When the `trigger_hint` column has
// not been migrated in yet, the insert comes back with this code (in the JSON
// error body) — we detect it to fall back to a payload without that key rather
// than lose the whole log row. Same spirit as team-chat's isMissingColumn.
function isMissingColumnError(errText) {
  if (!errText) return false;
  try {
    const j = JSON.parse(errText);
    if (j && j.code === '42703') return true;
  } catch { /* not JSON — fall through to the text match */ }
  return /42703|column .* does not exist/i.test(errText);
}

// Best-effort insert into ctm_webhook_log via PostgREST with the service-role
// key. Returns the inserted row (Prefer: return=representation) or null; never
// throws — a logging failure must not turn into a non-200 to CTM.
//
// RESILIENT to a pre-migration schema: if the row carries `trigger_hint` and the
// column doesn't exist yet (42703), retry ONCE without it so the raw capture is
// still written. Same fallback pattern as the declined-estimate columns.
async function logRow(row) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[ctm-webhook] SUPABASE_SERVICE_ROLE_KEY not set — cannot log row.');
    return null;
  }
  const insert = (payload) => fetch(`${SUPABASE_URL}/rest/v1/ctm_webhook_log`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  try {
    let r = await insert(row);
    if (!r.ok) {
      const errText = await r.text();
      // trigger_hint column not migrated in yet → drop it and retry once.
      if (isMissingColumnError(errText) && row && 'trigger_hint' in row) {
        const { trigger_hint, ...withoutHint } = row;
        r = await insert(withoutHint);
        if (!r.ok) {
          console.error('[ctm-webhook] insert failed after trigger_hint fallback', r.status, await r.text());
          return null;
        }
      } else {
        console.error('[ctm-webhook] insert failed', r.status, errText);
        return null;
      }
    }
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    console.error('[ctm-webhook] insert threw', e);
    return null;
  }
}

// Epoch seconds (CTM's body.unix_time) → ISO timestamptz, or null if absent /
// unparseable. Never throws. Exported for the unit test.
export function unixToIso(unixTime) {
  const n = Number(unixTime);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

// Map a parsed CTM body → a `calls` row. Field names are the REAL ones from a
// captured payload — do NOT substitute plausible-looking alternatives. Returns
// null when there's no body or no id to key the upsert on. Pure + exported so
// the exact field mapping is locked by a test and can't silently drift.
export function mapCallRow(body) {
  if (!body || body.id == null) return null;
  return {
    ctm_call_id:      body.id,
    caller_bare:      body.caller_number_bare ?? null,
    caller_formatted: body.caller_number_format ?? null,
    cnam:             body.cnam ?? null,
    tracking_bare:    body.tracking_number_bare ?? null,
    source:           body.source ?? null,
    city:             body.city ?? null,
    state:            body.state ?? null,
    is_new_caller:    body.is_new_caller ?? null,
    tags:             body.tag_list ?? null,
    status:           body.dial_status ?? null,
    started_at:       unixToIso(body.unix_time),
  };
}

// Best-effort UPSERT into `calls` keyed on ctm_call_id, via PostgREST with the
// service-role key. Returns nothing and never throws: a `calls` failure must
// not turn into a non-200 to CTM, and must not undo the ctm_webhook_log write.
async function upsertCall(body) {
  const row = mapCallRow(body);
  // No parsed body (parse failure) or no id to key on → skip the upsert, but
  // the caller still logged ctm_webhook_log and still returns 200.
  if (!row) return;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[ctm-webhook] SUPABASE_SERVICE_ROLE_KEY not set — cannot upsert call.');
    return;
  }

  try {
    // PostgREST upsert: POST + Prefer: resolution=merge-duplicates, conflict
    // target = the unique ctm_call_id. A CTM retry updates the same row.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/calls?on_conflict=ctm_call_id`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      console.error('[ctm-webhook] calls upsert failed', r.status, await r.text());
    }
  } catch (e) {
    console.error('[ctm-webhook] calls upsert threw', e);
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

  // Recon routing. The `end` and `end_immediate` CTM webhooks point at this
  // same endpoint with a `?trigger=...` query param; the `start` webhook points
  // at the BARE url with no param. Presence of the param (any value) = recon
  // mode: capture the raw delivery only, and NEVER touch `calls`. An end payload
  // shares the same ctm_call_id and, run through mapCallRow, would UPDATE the row
  // Josh typed notes into — nulling every field the end payload omits. That
  // silent data loss is the whole reason this gate exists.
  //
  // trigger stays null when the param is absent, keeping the start path
  // byte-identical to today apart from the (null) trigger_hint we now always log.
  let trigger = null;
  try {
    const u = new URL(req.url || '', 'http://ctm.local');
    if (u.searchParams.has('trigger')) trigger = u.searchParams.get('trigger') ?? '';
  } catch { trigger = null; }
  const isRecon = (trigger !== null);

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
    //    trigger_hint records the recon param (null on the start webhook).
    await logRow({
      headers: redactHeaders(req.headers),
      body,
      body_raw: rawBody,
      sig_received: sigReceived,
      sig_computed: sigComputed,
      sig_match: sigMatch,
      parse_error: parseError,
      trigger_hint: trigger,
    });

    // 5. Slice 2: upsert the parsed body into `calls` (skipped if body is null
    //    on a parse failure). ctm_webhook_log is already written above either
    //    way, so a malformed payload never costs us the raw capture.
    //
    //    RECON GUARD: an end / end_immediate delivery must NEVER reach this
    //    upsert. It is capture-only — skip mapCallRow entirely so an end payload
    //    can't overwrite the advisor's typed notes on the shared ctm_call_id.
    if (!isRecon) {
      await upsertCall(body);
    }
  } catch (e) {
    // Never surface a non-200 to CTM in this phase — log and move on.
    console.error('[ctm-webhook] handler error', e);
  }

  return res.status(200).send('ok');
}
