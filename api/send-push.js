/* ============================================================
   api/send-push.js — Web Push SENDER (Team Chat push, sub-slice 2c).

   Client-triggered (Option 1): the sender's board POSTs here right after a
   chat message inserts. We look up everyone subscribed to that channel
   (minus the sender), send each a Web Push, and prune dead endpoints.

   Requires:
   • VAPID_PRIVATE_KEY in the Vercel env (set in 2b). If missing we fail
     loudly (500 + console.error) — never silently.
   • push_subscriptions table migrated (2b).

   Never leaks the private key or subscription internals in the response.
   ============================================================ */
import webpush from 'web-push';

// Public VAPID key — same value embedded client-side in shared/push.js.
const VAPID_PUBLIC = 'BByOPsrzKI55qegn0RENJRoA0ijuf4Axb3rVpt4UJ7SYBlqRSMJiITi1JZhAyayPwHHcBU3u9ygvwF2Kvf--AD8';
// Contact for setVapidDetails — PLACEHOLDER. Cris: confirm/replace with a real
// monitored address; push services use it to reach you about your pushes.
const VAPID_CONTACT = 'mailto:admin@leetransmissionshop.com';

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

  // Fail loudly if the key isn't configured — do NOT silently no-op.
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  if (!VAPID_PRIVATE) {
    console.error('[send-push] VAPID_PRIVATE_KEY is not set in the environment — cannot send.');
    return res.status(500).json({ error: 'push not configured' });
  }

  // Validate payload shape + known channel (light abuse guard — see NOTE below).
  const { channel, senderName, senderRole, messagePreview } = req.body || {};
  if (typeof channel !== 'string' || !CHANNELS[channel]) {
    return res.status(400).json({ error: 'unknown channel' });
  }
  if (typeof senderName !== 'string' || typeof messagePreview !== 'string') {
    return res.status(400).json({ error: 'bad payload' });
  }
  // NOTE (known limitation to harden later): this endpoint is callable by
  // anyone who finds it — there's no auth token. It only fans a short text
  // notification to a fixed set of subscribers, but a real deployment should
  // add a shared secret / origin check. Not blocking shipping.

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
