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

   Auto-attach (Phase 2): after that upsert, try to file the call — match the
   caller to a customer by last-10 phone, and if that customer had exactly one
   RO open at call time, set ro_id too. Rules live in shared/call-auto-attach.js
   (the same predicate as the hand-run backfills). STRICTLY BEST EFFORT: it
   runs after the row exists, it is wrapped so it can never throw into the
   handler, and every failure path leaves the call sitting in the pile for a
   human. A call is never lost because attach failed.

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
import {
  AUTO_ATTACH_LIVE_RUN_ID, last10Key, shouldAutoAttach, pickCustomer, pickOpenRoAt,
  autoAttachCallPatch, autoFileRoPatch,
} from '../shared/call-auto-attach.js';

// Vercel's default body parser consumes and re-serializes the request, which
// destroys the exact bytes signature verification needs. Turn it off and read
// the raw stream ourselves.
export const config = { api: { bodyParser: false } };

// Supabase REST — same project as the rest of api/. This table is written with
// the SERVICE-ROLE key (server-side only, bypasses RLS). ctm_webhook_log is
// default-deny to anon, so the publishable key the boards ship cannot touch it.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hygemiszxwmyrkmhbjub.supabase.co'; // staging deployments set SUPABASE_URL (Preview env) to the staging project; prod unset -> this fallback

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

// Map a parsed CTM `end` body → a `recordings` row. Pure + exported so the
// field mapping is locked by a test. Returns null when there's no id OR no
// non-empty `audio` (e.g. an end_immediate payload, or a call with no
// recording) — the caller inserts nothing in that case. remote_url is the CTM
// API URL (which 302s to a TEMPORARY S3 link); we store ONLY this URL and always
// re-request it fresh — never the amazonaws.com url.
export function mapRecordingRow(body, callId) {
  if (!body || body.id == null) return null;
  const audio = body.audio;
  if (audio == null || String(audio).trim() === '') return null;
  const dur = Number(body.duration);
  return {
    source: 'call',
    ctm_call_id: body.id,
    call_id: callId ?? null,
    remote_url: audio,
    duration_seconds: (Number.isFinite(dur) && dur >= 0) ? Math.round(dur) : null,
    recorded_at: unixToIso(body.unix_time),
    fetch_status: 'pending',
  };
}

// Best-effort INSERT of a pending `recordings` row for a CTM `end` payload that
// carries audio. Service-role key, never throws (a recordings failure must not
// turn into a non-200 to CTM). Idempotent: on-conflict(ctm_call_id)-do-nothing,
// so CTM retries and repeated end deliveries never duplicate. This does NOT
// touch `calls` — the recon guard still holds; only the recordings table is
// written here.
async function insertRecording(body) {
  // No id or no audio (end_immediate, or a call with no recording) → nothing to
  // do. Checked BEFORE any network call so a no-audio end is a clean no-op.
  if (!body || body.id == null) return;
  if (body.audio == null || String(body.audio).trim() === '') return;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[ctm-webhook] SUPABASE_SERVICE_ROLE_KEY not set — cannot insert recording.');
    return;
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // Resolve call_id from the existing calls row (nullable — leave null if the
  // ring-time start never created one). This is a READ of calls, not the upsert.
  let callId = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/calls?ctm_call_id=eq.${encodeURIComponent(body.id)}&select=id`,
      { headers });
    if (r.ok) { const rows = await r.json(); callId = (rows && rows[0] && rows[0].id != null) ? rows[0].id : null; }
  } catch (e) { /* non-fatal — leave call_id null */ }

  const row = mapRecordingRow(body, callId);
  if (!row) return;   // no audio / no id → nothing to insert

  try {
    // on_conflict=ctm_call_id + resolution=ignore-duplicates = INSERT ... ON
    // CONFLICT DO NOTHING. return=minimal so a duplicate is a clean no-op.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/recordings?on_conflict=ctm_call_id`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      console.error('[ctm-webhook] recording insert failed', r.status, await r.text());
    }
  } catch (e) {
    console.error('[ctm-webhook] recording insert threw', e);
  }
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
    // return=representation so auto-attach can work from the row that actually
    // landed (its id, and whether a human already claimed it on a retry).
    const r = await fetch(`${SUPABASE_URL}/rest/v1/calls?on_conflict=ctm_call_id`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      console.error('[ctm-webhook] calls upsert failed', r.status, await r.text());
      return null;
    }
    const rows = await r.json().catch(() => null);
    return (Array.isArray(rows) && rows.length) ? rows[0] : null;
  } catch (e) {
    console.error('[ctm-webhook] calls upsert threw', e);
  }
  return null;
}

// ── AUTO-ATTACH (Phase 2) ───────────────────────────────────────────────
// Best effort, service-role, and deliberately timid:
//   RULE 1  exactly one customer matches the caller's last 10 → attach.
//           0 or 2+ → leave it in the pile for a human. Never guess.
//   RULE 2  that customer had exactly ONE RO open at the time of the call →
//           also set ro_id. 0 or 2+ → leave ro_id null.
// The decision logic is shared/call-auto-attach.js — the same predicate the
// hand-run backfills used. Nothing here writes phone_primary, phone_secondary,
// learned_phone, attached_by_name or attached_at.
//
// Never throws. Every early return leaves the call exactly where it was.
async function autoAttachCall(row) {
  if (!shouldAutoAttach(row) || row.id == null) return;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return;                                    // already logged by the caller
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const k = last10Key(row.caller_bare);

  try {
    // RULE 1 — the phone lookup, on the generated last-10 columns
    // (migrations/20260818_customers_phone_l10.sql). limit=2 is all we need:
    // two rows already means ambiguous, and we stop caring how many more.
    // Merged-away customers are excluded — auto-attaching a call to a row a
    // human already merged into another would undo their cleanup. Retried
    // without the filter if archived_at isn't on this project yet, so the
    // webhook keeps working before the merge migration is run.
    const custUrl = (archFilter) =>
      `${SUPABASE_URL}/rest/v1/customers?select=id&or=(phone_primary_l10.eq.${k},phone_secondary_l10.eq.${k})${archFilter ? '&archived_at=is.null' : ''}&limit=2`;
    let cr = await fetch(custUrl(true), { headers });
    if (!cr.ok) cr = await fetch(custUrl(false), { headers });
    if (!cr.ok) {
      // The most likely cause is the l10 migration not having been run on this
      // project yet. Say so plainly rather than failing silently every call.
      console.error('[ctm-webhook] auto-attach customer lookup failed', cr.status, await cr.text(),
        '— has migrations/20260818_customers_phone_l10.sql been run on this project?');
      return;
    }
    const customerId = pickCustomer(await cr.json());
    if (!customerId) return;                           // stranger or ambiguous → stays in the pile

    // RULE 2 — was exactly one RO open when this call came in?
    let roId = null;
    if (row.started_at) {
      const rr = await fetch(
        `${SUPABASE_URL}/rest/v1/repair_orders?select=id,status,created_at,closed_at,declined_at&customer_id=eq.${encodeURIComponent(customerId)}`,
        { headers });
      if (rr.ok) roId = pickOpenRoAt(await rr.json(), row.started_at);
      else console.error('[ctm-webhook] auto-attach RO lookup failed', rr.status, await rr.text());
    }

    // Write it. The customer_id=is.null & not_a_customer_at=is.null filters make
    // this atomic in the DATABASE: if a human attached (or dismissed) the call
    // between our read and this write, the PATCH matches zero rows and we lose
    // the race harmlessly. The robot can never overwrite a person's decision.
    const nowISO = new Date().toISOString();
    const patch = {
      ...autoAttachCallPatch(customerId, nowISO, AUTO_ATTACH_LIVE_RUN_ID),
      ...(roId ? autoFileRoPatch(roId, nowISO, AUTO_ATTACH_LIVE_RUN_ID) : {}),
    };
    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/calls?id=eq.${encodeURIComponent(row.id)}&customer_id=is.null&not_a_customer_at=is.null`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
    if (!pr.ok) console.error('[ctm-webhook] auto-attach write failed', pr.status, await pr.text());
    else console.log('[ctm-webhook] auto-attached call', row.id, '→ customer', customerId, roId ? `+ RO ${roId}` : '(no single open RO)');
  } catch (e) {
    // Swallowed on purpose. The call row already exists and is visible on the
    // board; the worst case is that it stays unattached, which is the status quo.
    console.error('[ctm-webhook] auto-attach threw', e);
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

  // Trigger routing. The `end` / `end_immediate` CTM webhooks point at this same
  // endpoint with a `?trigger=...` query param; the `start` webhook points at the
  // BARE url with no param. Behavior is now driven by the EXPLICIT value:
  //   • trigger === null   → the start webhook: upsert `calls` (as today).
  //   • trigger === 'end'  → capture the recording (if audio present). NEVER
  //                          upsert `calls` — an end payload run through mapCallRow
  //                          would null the notes Josh typed on the same
  //                          ctm_call_id. That recon guard is the whole point.
  //   • any other value    → logged only; nothing else (e.g. 'end_immediate',
  //                          which carries no audio).
  // trigger stays null when the param is absent, keeping the start path
  // byte-identical to today apart from the (null) trigger_hint we now always log.
  let trigger = null;
  try {
    const u = new URL(req.url || '', 'http://ctm.local');
    if (u.searchParams.has('trigger')) trigger = u.searchParams.get('trigger') ?? '';
  } catch { trigger = null; }

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

    // 5. Downstream, keyed on the EXPLICIT trigger value:
    //    • start (no param) → upsert `calls`.
    //    • end              → capture the recording ONLY. The calls upsert is
    //      NOT reached, so Josh's typed notes on this ctm_call_id are safe.
    //    • anything else     → nothing (already logged above).
    //    body is null on a parse failure; both branches no-op safely then.
    if (trigger === null) {
      const call = await upsertCall(body);
      // 5b. Auto-attach, AFTER the row exists. Best effort by construction:
      //     autoAttachCall never throws, and a null row (upsert skipped or
      //     failed) simply means there is nothing to attach yet.
      if (call) await autoAttachCall(call);
    } else if (trigger === 'end') {
      if (body) await insertRecording(body);
    }
  } catch (e) {
    // Never surface a non-200 to CTM in this phase — log and move on.
    console.error('[ctm-webhook] handler error', e);
  }

  return res.status(200).send('ok');
}
