#!/usr/bin/env node
/* ============================================================
   scripts/meta-sim.mjs — send SIGNED fake Messenger deliveries to a webhook.

   For test.leetransmissionshop.com, whose META_APP_SECRET is a MADE-UP,
   staging-only value (Vercel Preview, branch `staging`). Meta itself can't
   reach staging usefully — it signs with the real secret, which staging does
   not have — so this script plays Meta.

   ⚠ Never point this at prod with the real App Secret. Prod gets its traffic
   from Meta; fake rows there would be customer-looking junk in the tray.

   Usage:
     META_SIM_SECRET=<staging secret> node scripts/meta-sim.mjs https://test.leetransmissionshop.com/api/meta-webhook

   Sends, in order (a fresh fake PSID every run):
     1. a new customer's first message
     2. their second message
     3. a reply typed in Business Suite (page-inbox echo)
     4. delivery #1 AGAIN, byte for byte (Meta re-delivery → must insert nothing)
     5. an UNSIGNED copy of #1 (must be 403)
   and prints each status plus the PSID / mids to look up in the sandbox.

   META_SIM_AGE_HOURS=30 shifts the fake messages that many hours into the past —
   e.g. to get a thread whose 24-hour reply window is already closed.
   META_SIM_PSID=SIM_… reuses an existing fake PSID instead of a fresh one — e.g.
   to send a new customer message into a thread that was marked Done.
   ============================================================ */
import crypto from 'node:crypto';

const url = process.argv[2];
const secret = process.env.META_SIM_SECRET;
const PAGE = process.env.META_PAGE_ID || '821690607890680';
const INBOX_APP = 263902037430900; // Meta's Page inbox app — i.e. NOT CrisData's app

if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: META_SIM_SECRET=… node scripts/meta-sim.mjs <webhook url>');
  process.exit(2);
}
if (!secret) {
  console.error('META_SIM_SECRET is not set (the staging-only secret, never the real one).');
  process.exit(2);
}
if (/\/\/(www\.|board\.)?leetransmissionshop\.com\b/.test(url)) {
  console.error('Refusing: that is PROD. This script is for test.leetransmissionshop.com.');
  process.exit(2);
}

const run = Date.now();
const reuse = /^SIM_\d+$/.test(process.env.META_SIM_PSID || '');
const psid = reuse ? process.env.META_SIM_PSID : `SIM_${run}`;
const ageMs = Math.max(0, Number(process.env.META_SIM_AGE_HOURS) || 0) * 3600_000;
// Messages are 20 s apart and end ~now. Into an EXISTING thread they are 1 s apart,
// so they land AFTER anything done to it moments ago (e.g. Done) — a 60 s backdate
// would stamp them before the Done and (correctly) not bring the thread back.
const step = reuse ? 1_000 : 20_000;
const t0 = run - ageMs - 3 * step;
const mid = (n) => `m_sim_${run}_${n}`;

const envelope = (messaging) => JSON.stringify({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [messaging] }] });
const inbound = (n, text, ts) => envelope({ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid: mid(n), text } });
const inboxEcho = (n, text, ts) => envelope({ sender: { id: PAGE }, recipient: { id: psid }, timestamp: ts,
  message: { mid: mid(n), text, is_echo: true, app_id: INBOX_APP } });

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex');

async function send(label, raw, { signed = true, expect = 200 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (signed) headers['X-Hub-Signature-256'] = sign(raw);
  const r = await fetch(url, { method: 'POST', headers, body: raw });
  const ok = r.status === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} HTTP ${r.status} (expect ${expect})`);
  return ok;
}

const first = inbound(1, 'SIM: Hi, is my Silverado ready?', t0);
const results = [
  await send('1. new customer, first message', first),
  await send('2. same customer, second message', inbound(2, 'SIM: I can come at 4', t0 + step)),
  await send('3. page-inbox echo (Business Suite reply)', inboxEcho(3, 'SIM: Yes, ready at 4 — Daiana', t0 + 2 * step)),
  await send('4. re-delivery of #1 (same bytes)', first),
  await send('5. UNSIGNED copy of #1', first, { signed: false, expect: 403 }),
];

console.log(`\nPSID: ${psid}`);
console.log(`mids: ${[1, 2, 3].map(mid).join(', ')}`);
console.log('\nLook them up in the SANDBOX SQL editor:');
console.log(`  select t.psid, t.display_name, t.last_inbound_at, t.last_message_at, t.done_at, t.customer_id,
         m.mid, m.direction, m.is_echo, m.source, m.app_id, m.text, m.sent_at
    from public.social_threads t join public.social_messages m on m.thread_id = t.id
   where t.psid = '${psid}' order by m.sent_at;`);
console.log('  -- expect 3 rows (1 thread): in/customer, in/customer, out/page_inbox; #4 added nothing.');
process.exit(results.every(Boolean) ? 0 : 1);
