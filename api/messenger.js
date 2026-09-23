/* ============================================================
   api/messenger.js — the Advisor tray's three actions on a Messenger thread.
   Step 3 of Messenger → Advisor tray. Wiring: docs/wiring/meta-webhook.md §11.

   POST { action: 'reply', thread_id, text }
   POST { action: 'link',  thread_id, customer_id }   (customer_id null = unlink)
   POST { action: 'done',  thread_id }

   ── WHO ──
   requireUser(req) FIRST: the bearer token must be a live Supabase session
   (checked by /auth/v1/user — never parsed here) that maps to exactly ONE
   ACTIVE employees row. Anything else — no token, junk, a KiKi login with no
   employees row, an inactive employee — is a flat 401 and nothing is read.
   Then every read/write is the service-role key: the browser never writes
   social_* rows, and anon can't even read them.

   ── WHAT EACH ACTION MAY TOUCH ──
   reply → a NEW social_messages row via social_record_message. The thread's
           human fields (customer_id, linked_*, done_*) are never touched.
   link  → social_threads.customer_id, linked_at, linked_by. Nothing else.
   done  → social_threads.done_at, done_by. Nothing else.

   ── THE 24-HOUR WINDOW ──
   Meta lets a Page reply ("messaging_type: RESPONSE") only within 24 hours of
   the customer's LAST message (social_threads.last_inbound_at; our own and
   Business Suite replies don't reset it). Checked HERE, before Meta is called:
   closed → 409 with a plain-English reason. The browser checks too, but the
   server is the rule.

   ── SENDING ──
   Graph Send API, Page token from META_PAGE_ACCESS_TOKEN in the Authorization
   header (never the URL). No token → 503 "Facebook isn't connected yet" and
   nothing is stored. Meta refuses → the attempt IS stored, send_status
   'failed' + Meta's message, under a local:<uuid> mid, and the error goes back
   to the browser. No automatic retry. Code 190 = the token is dead → a clear
   "Facebook connection expired" message.

   META_SEND_MODE=dry-run (Preview · branch `staging` ONLY): the whole path —
   auth, window, write — with a fake `dryrun:<uuid>` mid, and Meta is never
   called. Refused outright on a Production deployment (VERCEL_ENV).
   ============================================================ */
import crypto from 'node:crypto';
import { requireUser } from './_lib/require-user.js';
import { isArchived, mergedIntoId } from '../shared/customer-archive.js';
import { graphSendText, metaErrorMessage } from './_lib/meta-send.js';

// The Graph call + Meta's error wording live in api/_lib/meta-send.js (shared
// with the webhook's after-hours auto-reply). Re-exported so existing callers
// and tests keep importing it from here.
export { metaErrorMessage };

const PROD_SUPABASE = 'https://hygemiszxwmyrkmhbjub.supabase.co';
export const CRISDATA_APP_ID = '1075837401512965';
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_TEXT = 2000;          // Messenger's text limit
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Pure helpers (exported, tested) ─────────────────────────────────────── */

// Is the reply window open? `lastInboundAt` = the thread's last customer message.
export function replyWindow(lastInboundAt, nowMs = Date.now()) {
  const t = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  if (!Number.isFinite(t)) {
    return { open: false, reason: "Facebook only lets the shop reply after the customer has messaged us, and we have no message from them. Call them instead." };
  }
  const closesAt = t + WINDOW_MS;
  if (nowMs < closesAt) return { open: true, closesAt: new Date(closesAt).toISOString() };
  return {
    open: false,
    closedAt: new Date(closesAt).toISOString(),
    reason: "Facebook only lets the shop reply within 24 hours of the customer's last message, and that was more than 24 hours ago. Call them instead — or reply here as soon as they message again.",
  };
}

// Validate the request body. Returns { ok, action, threadId, text?, customerId? } or { ok:false, error }.
export function parseBody(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const action = b.action;
  if (!['reply', 'link', 'done'].includes(action)) return { ok: false, error: 'action must be reply, link or done' };
  const threadId = typeof b.thread_id === 'string' ? b.thread_id : '';
  if (!UUID_RE.test(threadId)) return { ok: false, error: 'thread_id must be a uuid' };
  if (action === 'reply') {
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) return { ok: false, error: 'text is required' };
    if (text.length > MAX_TEXT) return { ok: false, error: `text is longer than ${MAX_TEXT} characters` };
    return { ok: true, action, threadId, text };
  }
  if (action === 'link') {
    if (!('customer_id' in b)) return { ok: false, error: 'customer_id is required (null to unlink)' };
    const customerId = b.customer_id;
    if (customerId !== null && !(typeof customerId === 'string' && UUID_RE.test(customerId))) {
      return { ok: false, error: 'customer_id must be a uuid or null' };
    }
    return { ok: true, action, threadId, customerId };
  }
  return { ok: true, action, threadId };
}

/* ── The handler ─────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // GATE — before the body is looked at.
  const employee = await requireUser(req);
  if (!employee) return res.status(401).json({ error: 'unauthorized' });

  const parsed = parseBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const env = process.env;
  const base = env.SUPABASE_URL || PROD_SUPABASE;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('[messenger] SUPABASE_SERVICE_ROLE_KEY not set — cannot run.');
    return res.status(500).json({ error: 'not configured' });
  }
  const db = { base, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };

  let thread;
  try {
    const r = await fetch(`${base}/rest/v1/social_threads?id=eq.${parsed.threadId}&select=id,channel,page_id,psid,last_inbound_at`, { headers: db.headers });
    if (!r.ok) { console.error('[messenger] thread read failed · HTTP', r.status); return res.status(502).json({ error: 'read failed' }); }
    const rows = await r.json();
    thread = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('[messenger] thread read threw:', String((e && e.message) || e));
    return res.status(502).json({ error: 'read failed' });
  }
  if (!thread) return res.status(404).json({ error: 'thread not found' });

  if (parsed.action === 'done') return doDone(res, db, thread, employee);
  if (parsed.action === 'link') return doLink(res, db, thread, employee, parsed.customerId);
  return doReply(res, db, thread, employee, parsed.text, env);
}

// PATCH exactly the given columns of one thread. Returns the updated row or null.
async function patchThread(db, threadId, fields) {
  const r = await fetch(`${db.base}/rest/v1/social_threads?id=eq.${threadId}&select=id,customer_id,linked_at,linked_by,done_at,done_by`, {
    method: 'PATCH',
    headers: { ...db.headers, Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) { console.error('[messenger] thread write failed · HTTP', r.status); return null; }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function doDone(res, db, thread, employee) {
  try {
    const row = await patchThread(db, thread.id, { done_at: new Date().toISOString(), done_by: employee.id });
    if (!row) return res.status(502).json({ error: 'write failed' });
    return res.status(200).json({ thread: row });
  } catch (e) {
    console.error('[messenger] done threw:', String((e && e.message) || e));
    return res.status(502).json({ error: 'write failed' });
  }
}

async function doLink(res, db, thread, employee, customerId) {
  try {
    if (customerId === null) {
      const row = await patchThread(db, thread.id, { customer_id: null, linked_at: null, linked_by: null });
      if (!row) return res.status(502).json({ error: 'write failed' });
      return res.status(200).json({ thread: row });
    }

    // The customer must exist and must not be archived / merged away. Same rule
    // and helper as the board's pickers (shared/customer-archive.js). A project
    // without the merge columns (42703) falls back to id,name — nothing is archived there.
    let r = await fetch(`${db.base}/rest/v1/customers?id=eq.${customerId}&select=id,name,archived_at,merged_into`, { headers: db.headers });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (!body.includes('42703')) { console.error('[messenger] customer read failed · HTTP', r.status); return res.status(502).json({ error: 'read failed' }); }
      r = await fetch(`${db.base}/rest/v1/customers?id=eq.${customerId}&select=id,name`, { headers: db.headers });
      if (!r.ok) { console.error('[messenger] customer read failed · HTTP', r.status); return res.status(502).json({ error: 'read failed' }); }
    }
    const rows = await r.json();
    const customer = Array.isArray(rows) ? rows[0] : null;
    if (!customer) return res.status(404).json({ error: 'customer not found' });
    if (isArchived(customer)) {
      return res.status(409).json({
        error: 'customer_archived',
        message: 'That customer record was merged or archived. Link the current record instead.',
        merged_into: mergedIntoId(customer),
      });
    }

    const row = await patchThread(db, thread.id, { customer_id: customer.id, linked_at: new Date().toISOString(), linked_by: employee.id });
    if (!row) return res.status(502).json({ error: 'write failed' });
    return res.status(200).json({ thread: row, customer: { id: customer.id, name: customer.name } });
  } catch (e) {
    console.error('[messenger] link threw:', String((e && e.message) || e));
    return res.status(502).json({ error: 'write failed' });
  }
}

// Store one outgoing message through the one writer. Returns the RPC row or null.
async function recordOut(db, thread, fields) {
  try {
    const r = await fetch(`${db.base}/rest/v1/rpc/social_record_message`, {
      method: 'POST',
      headers: db.headers,
      body: JSON.stringify({
        p_channel: thread.channel || 'facebook', p_page_id: thread.page_id, p_psid: thread.psid,
        p_mid: fields.mid, p_direction: 'out', p_is_echo: false, p_source: 'crisdata',
        p_app_id: CRISDATA_APP_ID, p_text: fields.text, p_attachments: [], p_sent_at: fields.sentAt,
        p_sent_by: fields.sentBy, p_send_status: fields.status, p_send_error: fields.error || null,
      }),
    });
    if (!r.ok) { console.error('[messenger] social_record_message failed · HTTP', r.status); return null; }
    const data = await r.json();
    return Array.isArray(data) ? data[0] || null : data;
  } catch (e) {
    console.error('[messenger] social_record_message threw:', String((e && e.message) || e));
    return null;
  }
}

async function doReply(res, db, thread, employee, text, env) {
  const win = replyWindow(thread.last_inbound_at);
  if (!win.open) return res.status(409).json({ error: 'window_closed', message: win.reason });

  const sentAt = new Date().toISOString();
  const dryRun = env.META_SEND_MODE === 'dry-run';

  if (dryRun) {
    if (env.VERCEL_ENV === 'production') {
      console.error('[messenger] META_SEND_MODE=dry-run on a PRODUCTION deployment — refusing to pretend to send.');
      return res.status(500).json({ error: 'misconfigured', message: 'Sending is misconfigured on this server. Nothing was sent.' });
    }
    const mid = `dryrun:${crypto.randomUUID()}`;
    const rec = await recordOut(db, thread, { mid, text, sentAt, sentBy: employee.id, status: 'sent' });
    if (!rec) return res.status(502).json({ error: 'write failed', message: 'Dry run: the message could not be saved.' });
    return res.status(200).json({ dry_run: true, message: { id: rec.message_id, mid, text, sent_at: sentAt, send_status: 'sent', sent_by: employee.id } });
  }

  const token = env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error('[messenger] META_PAGE_ACCESS_TOKEN not set — cannot send.');
    return res.status(503).json({ error: 'not_connected', message: "Facebook isn't connected to CrisData yet, so replies can't be sent from here. Reply from the Facebook app for now. Nothing was sent." });
  }

  // Send. Anything but a 2xx with a message_id is a refusal (api/_lib/meta-send.js).
  const sent = await graphSendText({ pageId: thread.page_id, psid: thread.psid, text, token });
  const metaMid = sent.mid || null;
  const failure = sent.failure || null;
  if (sent.thrown) console.error('[messenger] Send API threw:', sent.thrown);

  if (failure) {
    console.warn('[messenger] Send API refused · code', failure.code);
    const mid = `local:${crypto.randomUUID()}`;
    const rec = await recordOut(db, thread, { mid, text, sentAt, sentBy: employee.id, status: 'failed', error: failure.message });
    return res.status(502).json({
      error: failure.code === 190 ? 'token_expired' : 'send_failed',
      message: failure.message,
      meta_code: failure.code,
      message_row: rec ? { id: rec.message_id, mid, text, sent_at: sentAt, send_status: 'failed' } : null,
    });
  }

  // Sent. Record it — if Meta's echo got here first, the writer just fills sent_by/send_status.
  const rec = await recordOut(db, thread, { mid: metaMid, text, sentAt, sentBy: employee.id, status: 'sent' });
  return res.status(200).json({
    message: { id: rec ? rec.message_id : null, mid: metaMid, text, sent_at: sentAt, send_status: 'sent', sent_by: employee.id },
    ...(rec ? {} : { warning: 'Sent to Facebook, but not saved here yet — it will appear when Facebook echoes it back.' }),
  });
}
