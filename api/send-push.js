/* ============================================================
   api/send-push.js — Web Push SENDER (Team Chat push, Slice 3d).

   Client-triggered (Option 1): the sender's board POSTs here right after a
   chat message inserts. We resolve the conversation's members (minus the
   sender) from chat_members, look up their push subscriptions, send each a
   Web Push, and prune dead endpoints.

   Slice 3d change: recipients are now DYNAMIC — resolved from the
   conversation membership (chat_members keyed on member_name, the durable
   join since 3a) rather than a hardcoded channel→roles map. This restores
   closed-phone push for every conversation, including brand-new DMs/groups
   created via the 3c compose UI.

   Auth (harden pass): two lightweight gates in front of the logic — an
   origin allow-list (403) and a shared-secret header x-cd-push-secret
   compared to PUSH_SHARED_SECRET (401). Order: 405 → 403 → 401 → 400 → send.

   Requires:
   • VAPID_PRIVATE_KEY in the Vercel env (set in 2b). If missing we fail
     loudly (500 + console.error) — never silently.
   • PUSH_SHARED_SECRET in the Vercel env (harden pass). Missing → 401 + log.
   • chat_members (3a) + push_subscriptions (2b) tables migrated.

   Never leaks the private key or subscription internals in the response.
   ============================================================ */
import webpush from 'web-push';
import { recipientNamesFromMembers, buildSubscriberInList } from './_push-recipients.js';

// Public VAPID key — same value embedded client-side in shared/push.js.
const VAPID_PUBLIC = 'BByOPsrzKI55qegn0RENJRoA0ijuf4Axb3rVpt4UJ7SYBlqRSMJiITi1JZhAyayPwHHcBU3u9ygvwF2Kvf--AD8';
// Contact push services use to reach the shop about delivery problems.
const VAPID_CONTACT = 'mailto:esallc1@yahoo.com';

// GATE 1 allow-list — only these origins may call this endpoint. Small array
// so domains are easy to add later. Both are stable hostnames (the vercel.app
// entry is the project's stable production alias, NOT a per-deploy hash URL).
const ALLOWED_ORIGINS = [
  'https://board.leetransmissionshop.com',              // custom production domain (what the team uses)
  'https://shop-board-leetransmission-kiki.vercel.app', // stable Vercel production alias
];

// Origin of the request — prefer the Origin header, fall back to Referer.
function getRequestOrigin(req) {
  const o = req.headers && req.headers.origin;
  if (o) return o;
  const ref = req.headers && req.headers.referer;
  if (ref) { try { return new URL(ref).origin; } catch (e) { /* malformed */ } }
  return null;
}

// Supabase REST (anon publishable key — same public key the boards ship;
// push_subscriptions RLS is anon-full-access).
const SUPABASE_URL = 'https://hygemiszxwmyrkmhbjub.supabase.co';
const SUPABASE_ANON = 'sb_publishable_8o9Df7K_DGpQ3s6yUCDq-A_HMh4Zllo';

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // GATE 1 — origin allow-list. Reject unknown origins with a generic 403
  // (don't echo the origin back).
  const origin = getRequestOrigin(req);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // GATE 2 — shared secret. The client sends x-cd-push-secret; it must match
  // PUSH_SHARED_SECRET in the env. Fail closed + log loudly if the env is unset.
  // HONEST NOTE: the client is static, so this secret ships in the page source
  // and a determined person could extract it. Combined with the origin check it
  // stops casual/bot abuse of the URL — it is NOT fortress-grade.
  const SHARED_SECRET = process.env.PUSH_SHARED_SECRET;
  if (!SHARED_SECRET) {
    console.error('[send-push] PUSH_SHARED_SECRET is not set in the environment — rejecting.');
    return res.status(401).json({ error: 'unauthorized' });
  }
  if ((req.headers && req.headers['x-cd-push-secret']) !== SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Fail loudly if the key isn't configured — do NOT silently no-op.
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  if (!VAPID_PRIVATE) {
    console.error('[send-push] VAPID_PRIVATE_KEY is not set in the environment — cannot send.');
    return res.status(500).json({ error: 'push not configured' });
  }

  // Validate payload shape — conversationId is now required (replaces channel).
  const { conversationId, senderName, senderRole, messagePreview } = req.body || {};
  if (typeof conversationId !== 'string' || !conversationId) {
    return res.status(400).json({ error: 'missing conversationId' });
  }
  if (typeof senderName !== 'string' || typeof messagePreview !== 'string') {
    return res.status(400).json({ error: 'bad payload' });
  }

  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

  // 1. Resolve who is in this conversation (chat_members keyed on member_name).
  let members = [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/chat_members` +
      `?conversation_id=eq.${encodeURIComponent(conversationId)}&select=member_name`;
    const r = await fetch(url, { headers: sbHeaders });
    if (!r.ok) {
      console.error('[send-push] member lookup failed', r.status, await r.text());
      return res.status(502).json({ error: 'lookup failed' });
    }
    members = await r.json();
  } catch (e) {
    console.error('[send-push] member lookup threw', e);
    return res.status(502).json({ error: 'lookup failed' });
  }

  // Recipients = members minus the sender (group → all others; DM → the one
  // other person). No recipients (e.g. only the sender is a member) → no-op.
  const recipientNames = recipientNamesFromMembers(members, senderName);
  if (recipientNames.length === 0) {
    return res.status(200).json({ sent: 0, failed: 0, pruned: 0 });
  }

  // 2. Their push subscriptions (a person may have several across devices).
  let subs = [];
  try {
    const inList = buildSubscriberInList(recipientNames);
    const url = `${SUPABASE_URL}/rest/v1/push_subscriptions` +
      `?subscriber_name=in.(${encodeURIComponent(inList)})` +
      `&select=endpoint,p256dh,auth,subscriber_name`;
    const r = await fetch(url, { headers: sbHeaders });
    if (!r.ok) {
      console.error('[send-push] subscription lookup failed', r.status, await r.text());
      return res.status(502).json({ error: 'lookup failed' });
    }
    subs = await r.json();
  } catch (e) {
    console.error('[send-push] subscription lookup threw', e);
    return res.status(502).json({ error: 'lookup failed' });
  }

  subs = (subs || []).filter((s) => s && s.endpoint);

  const payload = JSON.stringify({
    title: senderName || 'CrisData',
    body: String(messagePreview).slice(0, 120),
    conversationId,
  });

  let sent = 0, failed = 0, pruned = 0;

  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // Gone — the browser/phone dropped this subscription. Prune it so the
        // table doesn't fill with dead endpoints.
        try {
          const del = await fetch(
            `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
            { method: 'DELETE', headers: sbHeaders }
          );
          if (del.ok) pruned++;
        } catch (e) { /* best-effort prune */ }
      } else {
        failed++;
        console.warn('[send-push] delivery failed', code || (err && err.message));
      }
    }
  }));

  // Small, non-sensitive summary only.
  return res.status(200).json({ sent, failed, pruned });
}
