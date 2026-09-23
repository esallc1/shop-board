/* ============================================================
   meta-webhook.js — Meta / Facebook webhook receiver (CrisData).

   Meta app: "Lee Transmission CrisData" · App ID 1075837401512965 · Page
   821690607890680. Wiring: docs/wiring/meta-webhook.md.

     GET  → the subscription verification handshake Meta runs once, when Cris
            saves the Callback URL in the app dashboard.
     POST → verify X-Hub-Signature-256, then STORE the Messenger messages and
            echoes it carries (social_record_message, service role), log one
            structured line, 200.

   What gets stored (step 2 of the Messenger → Advisor tray): a customer's
   message (`messages` field) and an echo of a Page reply (`message_echoes` —
   our own Send API replies AND replies typed in Business Suite / the Pages
   app). Everything else — another Page, delivery / read receipts, reactions,
   postbacks, standby — is COUNTED in the log line and dropped.

   RESPONSE DISCIPLINE (Meta retries non-200s and eventually unsubscribes the
   app): 200 on every authentic request — a payload shape we don't handle, a
   database error, a Graph error. Log it and 200. 403 ONLY for a failed
   signature or a failed handshake. Never 500.

   FAIL CLOSED: if META_APP_SECRET or META_VERIFY_TOKEN is missing from the
   environment we 403 and log that it's missing. There is no default, and no
   "skip verification when unconfigured" path.

   NEVER LOGGED: message text, attachment URLs, PSIDs, names. The log line is
   counts and reasons only.
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

/* ── Which Page, which app ─────────────────────────────────────────────────
   Deliveries for any other Page are dropped. META_PAGE_ID overrides the
   constant (tests, or if the shop's Page ever changes); the app id is how an
   echo of OUR OWN Send API reply is told apart from one typed in Business
   Suite (its app_id is Meta's inbox app, or absent).
   ──────────────────────────────────────────────────────────────────────── */
export const SHOP_PAGE_ID = '821690607890680';
export const CRISDATA_APP_ID = '1075837401512965';
const GRAPH = 'https://graph.facebook.com/v26.0';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hygemiszxwmyrkmhbjub.supabase.co';

// Attachment METADATA only — type + Meta's link (which expires) + sticker id +
// title. No file is fetched or stored in this slice.
function attachmentMeta(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a === 'object').map((a) => {
    const p = (a.payload && typeof a.payload === 'object') ? a.payload : {};
    const out = { type: typeof a.type === 'string' ? a.type : 'unknown' };
    if (typeof p.url === 'string') out.url = p.url;
    if (p.sticker_id != null) out.sticker_id = String(p.sticker_id);
    if (typeof a.title === 'string') out.title = a.title;
    return out;
  });
}

function isoFromMs(ms, fallbackMs) {
  const n = Number(ms);
  const use = Number.isFinite(n) && n > 0 ? n : Number(fallbackMs);
  const d = new Date(Number.isFinite(use) && use > 0 ? use : Date.now());
  return d.toISOString();
}

/* ── The parser ────────────────────────────────────────────────────────────
   Pure: a delivery body in, { rows, skipped } out. One row per message or
   echo, in delivery order (the order matters — it is the order the thread
   clocks move in). `skipped` counts what was dropped, by reason, so the log
   line can say so without carrying any content.

   Row shape = social_record_message's parameters, minus the p_ prefix.
   ──────────────────────────────────────────────────────────────────────── */
export function parseMessagingEvents(body, pageId = SHOP_PAGE_ID, appId = CRISDATA_APP_ID) {
  const rows = [];
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  if (!body || typeof body !== 'object') { skip('no-body'); return { rows, skipped }; }
  if (body.object !== 'page') { skip('not-page-object'); return { rows, skipped }; }
  const page = String(pageId);

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    if (!entry || typeof entry !== 'object') { skip('bad-entry'); continue; }
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    if (String(entry.id) !== page) { skip('foreign-page'); continue; }
    if (Array.isArray(entry.standby)) for (let i = 0; i < entry.standby.length; i++) skip('standby');
    if (Array.isArray(entry.changes)) for (let i = 0; i < entry.changes.length; i++) skip('changes');

    for (const ev of events) {
      if (!ev || typeof ev !== 'object') { skip('bad-event'); continue; }
      const m = ev.message;
      if (!m || typeof m !== 'object') {
        if (ev.delivery) skip('delivery');
        else if (ev.read) skip('read');
        else if (ev.reaction) skip('reaction');
        else if (ev.postback) skip('postback');
        else skip('other-event');
        continue;
      }
      if (m.is_deleted) { skip('deleted'); continue; }
      if (typeof m.mid !== 'string' || !m.mid) { skip('no-mid'); continue; }
      const senderId = ev.sender && ev.sender.id != null ? String(ev.sender.id) : '';
      const recipientId = ev.recipient && ev.recipient.id != null ? String(ev.recipient.id) : '';
      const echo = m.is_echo === true;

      // The Page must be the OTHER party: recipient of an inbound, sender of an echo.
      if (echo ? senderId !== page : recipientId !== page) { skip('foreign-page'); continue; }
      const psid = echo ? recipientId : senderId;
      if (!psid) { skip('no-psid'); continue; }

      const echoApp = m.app_id != null ? String(m.app_id) : null;
      rows.push({
        channel: 'facebook',
        page_id: page,
        psid,
        mid: m.mid,
        direction: echo ? 'out' : 'in',
        is_echo: echo,
        source: !echo ? 'customer' : (echoApp === String(appId) ? 'crisdata' : 'page_inbox'),
        app_id: echoApp,
        text: typeof m.text === 'string' ? m.text : null,
        attachments: attachmentMeta(m.attachments),
        sent_at: isoFromMs(ev.timestamp, entry.time),
      });
    }
  }
  return { rows, skipped };
}

/* ── Storing ───────────────────────────────────────────────────────────────
   Each row → one RPC call to social_record_message with the service-role key,
   in order. The function is idempotent on mid, so Meta re-delivering a batch
   inserts nothing twice (`inserted: false`). Never throws: a failure is a
   counted, logged reason, and the handler still 200s.

   Name lookup: after a NEW inbound message, if META_PAGE_ACCESS_TOKEN is set
   and the thread has no display_name yet, ask Graph once for first/last name
   and fill it ONLY if still empty. No token → skipped quietly, no name.
   ──────────────────────────────────────────────────────────────────────── */
export async function storeRows(rows, deps = {}) {
  const doFetch = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const base = env.SUPABASE_URL || SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const out = { inserted: 0, duplicate: 0, errors: 0, named: 0, nameErrors: 0 };
  if (!rows.length) return out;
  if (!key) {
    console.error('[meta-webhook] SUPABASE_SERVICE_ROLE_KEY is not set — cannot store', rows.length, 'message(s).');
    out.errors = rows.length;
    return out;
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const token = env.META_PAGE_ACCESS_TOKEN;

  for (const r of rows) {
    let result = null;
    try {
      const resp = await doFetch(`${base}/rest/v1/rpc/social_record_message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_channel: r.channel, p_page_id: r.page_id, p_psid: r.psid, p_mid: r.mid,
          p_direction: r.direction, p_is_echo: r.is_echo, p_source: r.source, p_app_id: r.app_id,
          p_text: r.text, p_attachments: r.attachments, p_sent_at: r.sent_at,
        }),
      });
      if (!resp.ok) {
        out.errors++;
        console.error('[meta-webhook] social_record_message failed · HTTP', resp.status);
        continue;
      }
      const data = await resp.json();
      result = Array.isArray(data) ? data[0] : data;
    } catch (e) {
      out.errors++;
      console.error('[meta-webhook] social_record_message threw:', String((e && e.message) || e));
      continue;
    }
    if (result && result.inserted) out.inserted++; else out.duplicate++;

    if (token && result && result.inserted && r.direction === 'in' && result.thread_id) {
      const named = await fillNameIfMissing(result.thread_id, r.psid, { doFetch, base, headers, token });
      if (named === true) out.named++; else if (named === false) out.nameErrors++;
    }
  }
  return out;
}

// true = name stored · null = nothing to do (already named / Graph had no name)
// false = something failed (logged without the PSID or the name).
async function fillNameIfMissing(threadId, psid, { doFetch, base, headers, token }) {
  try {
    const q = await doFetch(`${base}/rest/v1/social_threads?id=eq.${encodeURIComponent(threadId)}&select=display_name`, { headers });
    if (!q.ok) { console.error('[meta-webhook] thread name read failed · HTTP', q.status); return false; }
    const rows = await q.json();
    if (!Array.isArray(rows) || !rows.length || rows[0].display_name) return null;

    // Token in the header, never the URL — URLs end up in logs.
    const g = await doFetch(`${GRAPH}/${encodeURIComponent(psid)}?fields=first_name,last_name`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!g.ok) { console.warn('[meta-webhook] Graph name lookup refused · HTTP', g.status); return false; }
    const p = await g.json();
    const name = [p && p.first_name, p && p.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    if (!name) return null;

    // Fill only if STILL empty — never replace a name.
    const u = await doFetch(`${base}/rest/v1/social_threads?id=eq.${encodeURIComponent(threadId)}&display_name=is.null`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ display_name: name }),
    });
    if (!u.ok) { console.error('[meta-webhook] thread name write failed · HTTP', u.status); return false; }
    return true;
  } catch (e) {
    console.warn('[meta-webhook] name lookup threw:', String((e && e.message) || e));
    return false;
  }
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

    // Store what we understand; count what we don't. Then ONE structured line
    // and 200 regardless — a non-200 here would make Meta retry and eventually
    // drop the subscription. No text, no PSID, no name ever reaches the log.
    const summary = summarizeMetaPayload(body);
    const env = process.env;
    const parsed = parseMessagingEvents(body, env.META_PAGE_ID || SHOP_PAGE_ID);
    let stored = { inserted: 0, duplicate: 0, errors: 0, named: 0, nameErrors: 0 };
    try {
      stored = await storeRows(parsed.rows);
    } catch (e) {
      // storeRows never throws; belt and braces so a surprise can't become a 500.
      console.error('[meta-webhook] store step threw:', String((e && e.message) || e));
    }
    console.log('[meta-webhook]', JSON.stringify({
      object: summary.object,
      entries: summary.entries,
      events: summary.events,
      pageIds: summary.pageIds,
      bytes: rawBody.length,
      parseError,
      rows: parsed.rows.length,
      ...stored,
      skipped: parsed.skipped,
    }));
    return res.status(200).send('EVENT_RECEIVED');
  }

  // Meta only ever GETs or POSTs. Anything else is not a Meta delivery, so
  // there is no retry to protect.
  return res.status(405).send('');
}
