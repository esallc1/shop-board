/* ============================================================
   meta-webhook.js — Meta / Facebook webhook receiver (CrisData).

   Meta app: "Lee Transmission CrisData" · App ID 1075837401512965 · Development.
   This is the FIRST Meta code in the repo. It does exactly two things:

     GET  → the subscription verification handshake Meta runs once, when Cris
            saves the Callback URL in the app dashboard.
     POST → verify X-Hub-Signature-256, then log one structured line and 200.

   OUT OF SCOPE on purpose: no Supabase client, no `calls` row, no PSID storage,
   no Messenger reply, no UI. Turning a payload into a row needs schema
   decisions that have not been made. Receiving and PROVING AUTHENTICITY is the
   whole slice — everything downstream can be built on top of a request we know
   came from Meta.

   RESPONSE DISCIPLINE (Meta retries non-200s and eventually unsubscribes the
   app): 200 fast on every authentic request, even a payload shape we don't
   handle yet — log it and 200. 403 ONLY for a failed signature or a failed
   handshake. Never 500 on an unrecognised payload.

   FAIL CLOSED: if META_APP_SECRET or META_VERIFY_TOKEN is missing from the
   environment we 403 and log that it's missing. There is no default, and no
   "skip verification when unconfigured" path.
   ============================================================ */

import crypto from 'node:crypto';

// Vercel's default body parser consumes and re-serializes the request, which
// destroys the exact bytes the HMAC is computed over. Turn it off and read the
// raw stream ourselves. (Same reason as api/ctm-webhook.js.)
export const config = { api: { bodyParser: false } };

// Read the raw request stream as a BUFFER — not a string. The signature is over
// the bytes Meta sent; a utf8 round-trip is a chance to change them.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ── The signature check ────────────────────────────────────────────────────
   Meta sends `X-Hub-Signature-256: sha256=<hex>` where the hex is
   HMAC-SHA256(raw request body, app secret).

   ⚠ DELIBERATE DEPARTURE FROM api/ctm-webhook.js — DO NOT "ALIGN THE TWO
   FILES". ctm-webhook computes a signature and stores sig_match but NEVER
   rejects on it (see its §"Signature is LOG-ONLY here"), because the exact CTM
   signing string is still an assumption we're confirming against real logged
   values. Meta's signing string is documented and fixed, and Meta REQUIRES
   enforcement — an unauthenticated endpoint here is an open door for anyone who
   learns the URL. So this one enforces. The permissive behaviour over there is
   a known, temporary state of a DIFFERENT vendor's integration; it is not a
   house style to copy.

   Pure function, exported, tested directly — the way isAllowedOrigin was pulled
   out of send-push.js in 1fc57fa. Never throws: every bad input is a reason.
   ──────────────────────────────────────────────────────────────────────── */
export function verifyMetaSignature(header, rawBody, appSecret) {
  // Fail closed on an unconfigured environment. This is NOT "no secret, no
  // check" — it's "no secret, no service".
  if (!appSecret || typeof appSecret !== 'string') return { ok: false, reason: 'no-app-secret' };
  if (!header || typeof header !== 'string') return { ok: false, reason: 'no-signature-header' };

  // Accept only `sha256=<hex>`. Meta's sha1 header (X-Hub-Signature) is not
  // accepted here — we read the 256 header and nothing else.
  const m = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed-signature-header' };

  // Hex is case-insensitive: Buffer.from decodes either case to the same bytes,
  // so a lowercase and an uppercase spelling of the same digest both pass.
  const received = Buffer.from(m[1], 'hex');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest();

  // LENGTH FIRST. crypto.timingSafeEqual THROWS on a length mismatch, so a
  // short/long hex (or an odd-length one, which Buffer.from silently
  // truncates) must be rejected before it reaches the comparison.
  if (received.length !== expected.length) return { ok: false, reason: 'length-mismatch' };
  if (!crypto.timingSafeEqual(received, expected)) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true, reason: 'ok' };
}

/* ── The GET handshake ─────────────────────────────────────────────────────
   Meta calls the Callback URL once with hub.mode / hub.verify_token /
   hub.challenge, and string-compares the response body to the challenge it
   sent. So the body must be the challenge and NOTHING else: no JSON, no
   quotes, no trailing newline.

   Pure function so the token comparison is testable on its own.
   ──────────────────────────────────────────────────────────────────────── */
export function verifyHandshake(query, verifyToken) {
  if (!verifyToken || typeof verifyToken !== 'string') return { ok: false, reason: 'no-verify-token' };
  const q = query || {};
  const mode = pickOne(q['hub.mode']);
  const token = pickOne(q['hub.verify_token']);
  const challenge = pickOne(q['hub.challenge']);
  if (mode !== 'subscribe') return { ok: false, reason: 'bad-mode' };
  if (typeof token !== 'string' || token !== verifyToken) return { ok: false, reason: 'bad-verify-token' };
  if (typeof challenge !== 'string' || challenge === '') return { ok: false, reason: 'no-challenge' };
  return { ok: true, reason: 'ok', challenge };
}

// Vercel's req.query gives a string for a single param and an array for a
// repeated one. Take the first value either way.
function pickOne(v) { return Array.isArray(v) ? v[0] : v; }

// Query params from either Vercel's parsed req.query or the raw req.url.
function queryOf(req) {
  if (req && req.query && Object.keys(req.query).length) return req.query;
  try {
    const u = new URL((req && req.url) || '', 'http://meta.local');
    const out = {};
    for (const [k, v] of u.searchParams.entries()) if (!(k in out)) out[k] = v;
    return out;
  } catch { return {}; }
}

/* ── What we log ───────────────────────────────────────────────────────────
   One structured line per authentic POST: the envelope shape, the event types
   present, and any page ids. Enough to see what Meta is actually sending
   before we design the schema for it — and deliberately NOT the message
   bodies, which would put customer text in the Vercel log.
   ──────────────────────────────────────────────────────────────────────── */
export function summarizeMetaPayload(body) {
  const out = { object: null, entries: 0, events: [], pageIds: [] };
  if (!body || typeof body !== 'object') return out;
  out.object = typeof body.object === 'string' ? body.object : null;
  const entries = Array.isArray(body.entry) ? body.entry : [];
  out.entries = entries.length;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.id != null && !out.pageIds.includes(String(e.id))) out.pageIds.push(String(e.id));
    for (const k of Object.keys(e)) {
      if (k === 'id' || k === 'time') continue;
      // `changes` names its own event in .field (e.g. feed, leadgen); every
      // other key (messaging, standby, …) IS the event name.
      if (k === 'changes' && Array.isArray(e.changes)) {
        for (const c of e.changes) {
          const label = `changes:${(c && c.field) || 'unknown'}`;
          if (!out.events.includes(label)) out.events.push(label);
        }
        continue;
      }
      if (!out.events.includes(k)) out.events.push(k);
    }
  }
  return out;
}

export default async function handler(req, res) {
  const method = (req && req.method) || 'GET';

  // ── GET: the one-time subscription handshake ──
  if (method === 'GET') {
    const token = process.env.META_VERIFY_TOKEN;
    if (!token) console.error('[meta-webhook] META_VERIFY_TOKEN is not set in the environment — rejecting the handshake.');
    const hs = verifyHandshake(queryOf(req), token);
    if (!hs.ok) {
      console.warn('[meta-webhook] handshake REJECTED:', hs.reason);
      return res.status(403).send('');
    }
    // PLAIN TEXT, exactly the challenge — Meta string-compares the body.
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    console.log('[meta-webhook] handshake OK — echoing the challenge.');
    return res.status(200).send(hs.challenge);
  }

  // ── POST: signature, then log, then 200 ──
  if (method === 'POST') {
    const secret = process.env.META_APP_SECRET;
    if (!secret) console.error('[meta-webhook] META_APP_SECRET is not set in the environment — rejecting every delivery.');

    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (e) {
      // We never saw the bytes, so we can't authenticate them. 403, not 500 —
      // and nothing gets processed.
      console.error('[meta-webhook] failed to read the raw body:', String((e && e.message) || e));
      return res.status(403).send('');
    }

    const sig = verifyMetaSignature(req.headers && req.headers['x-hub-signature-256'], rawBody, secret);
    if (!sig.ok) {
      console.warn('[meta-webhook] delivery REJECTED:', sig.reason, '· bytes:', rawBody.length);
      return res.status(403).send('');
    }

    // Only now — after the bytes are proven to be Meta's — do we parse them.
    let body = null;
    let parseError = null;
    try {
      const text = rawBody.toString('utf8');
      if (text.trim()) body = JSON.parse(text);
    } catch (e) {
      parseError = String((e && e.message) || e);
    }

    // One structured line, then 200 regardless of shape. An authentic delivery
    // we don't understand is a logging job, not an error — a non-200 here would
    // make Meta retry it and eventually drop the subscription.
    const summary = summarizeMetaPayload(body);
    console.log('[meta-webhook]', JSON.stringify({
      object: summary.object,
      entries: summary.entries,
      events: summary.events,
      pageIds: summary.pageIds,
      bytes: rawBody.length,
      parseError,
    }));
    return res.status(200).send('EVENT_RECEIVED');
  }

  // Meta only ever GETs or POSTs. Anything else is not a Meta delivery, so
  // there is no retry to protect.
  return res.status(405).send('');
}
