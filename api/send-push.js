/* ============================================================
   api/send-push.js — Web Push SENDER (Team Chat push, sub-slice 2c).

   Client-triggered (Option 1): the sender's board POSTs here right after a
   chat message inserts. We look up everyone subscribed to that channel
   (minus the sender), send each a Web Push, and prune dead endpoints.

   Auth (harden pass): two lightweight gates in front of the existing logic —
   an origin allow-list (403) and a shared-secret header x-cd-push-secret
   compared to PUSH_SHARED_SECRET (401). Order: 405 → 403 → 401 → 400 → send.

   Requires:
   • VAPID_PRIVATE_KEY in the Vercel env (set in 2b). If missing we fail
     loudly (500 + console.error) — never silently.
   • PUSH_SHARED_SECRET in the Vercel env (harden pass). Missing → 401 + log.
   • push_subscriptions table migrated (2b).

   Never leaks the private key or subscription internals in the response.
   ============================================================ */
import webpush from 'web-push';

// Public VAPID key — same value embedded client-side in shared/push.js.
const VAPID_PUBLIC = 'BByOPsrzKI55qegn0RENJRoA0ijuf4Axb3rVpt4UJ7SYBlqRSMJiITi1JZhAyayPwHHcBU3u9ygvwF2Kvf--AD8';
// TODO(Cris): STILL A PLACEHOLDER — provide the real monitored address and
// replace this. Push services use it to reach you about your pushes. web-push
// requires a valid mailto:/https: subject, so it's left as a working
// placeholder (not invented per se — carried from 2c) until you supply one.
const VAPID_CONTACT = 'mailto:admin@leetransmissionshop.com';

// GATE 1 allow-list — only these origins may call this endpoint. Small array
// so domains are easy to add later.
// NOTE(Cris): confirm the vercel.app entry matches your actual project domain
// (guessed from the repo name) — adjust if your Vercel URL differs.
const ALLOWED_ORIGINS = [
  'https://board.leetransmissionshop.com',   // custom production domain
  'https://shop-board.vercel.app',           // vercel.app production domain (VERIFY)
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

// Channel → participant office roles. Mirrors the hardcoded role-pair channel
// keys used across the boards (group = all office roles; each DM key is
// "<roleA>_<roleB>"). This is also the allow-list of known channels.
const CHANNELS = {
  group: ['owner', 'manager', 'advisor', 'bookkeeping'],
  owner_manager: ['owner', 'manager'],
  owner_advisor: ['owner', 'advisor'],
  owner_bookkeeping: ['owner', 'bookkeeping'],
  manager_advisor: ['manager', 'advisor'],
  manager_bookkeeping: ['manager', 'bookkeeping'],
  advisor_bookkeeping: ['advisor', 'bookkeeping'],
};

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

  // Validate payload shape + known channel.
  const { channel, senderName, senderRole, messagePreview } = req.body || {};
  if (typeof channel !== 'string' || !CHANNELS[channel]) {
    return res.status(400).json({ error: 'unknown channel' });
  }
  if (typeof senderName !== 'string' || typeof messagePreview !== 'string') {
    return res.status(400).json({ error: 'bad payload' });
  }

  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

  const participants = CHANNELS[channel];

  // Recipients: everyone subscribed whose role participates in this channel.
  let subs = [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/push_subscriptions` +
      `?subscriber_role=in.(${participants.join(',')})` +
      `&select=endpoint,p256dh,auth,subscriber_name`;
    const r = await fetch(url, { headers: sbHeaders });
    if (!r.ok) {
      console.error('[send-push] recipient lookup failed', r.status, await r.text());
      return res.status(502).json({ error: 'lookup failed' });
    }
    subs = await r.json();
  } catch (e) {
    console.error('[send-push] recipient lookup threw', e);
    return res.status(502).json({ error: 'lookup failed' });
  }

  // Exclude the sender's own devices (by name — the per-person key). Rows with
  // a null name are kept (can't confirm they're the sender).
  subs = (subs || []).filter((s) => s && s.endpoint && s.subscriber_name !== senderName);

  const payload = JSON.stringify({
    title: senderName || 'CrisData',
    body: String(messagePreview).slice(0, 120),
    channel,
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
