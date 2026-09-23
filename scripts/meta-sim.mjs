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

   AFTER-HOURS AUTO-REPLY (meta-webhook.md §12) — META_SIM_SCENARIO=…
     autoreply     five fresh threads, timestamps picked from the last 20 h by the
                   real shop hours (the webhook decides by the MESSAGE's time):
                     A closed-hours inbound            → auto-reply recorded
                     A second inbound, same stretch    → no second reply
                     B staff (Business Suite) reply, then inbound → no auto-reply
                     C open-hours inbound              → nothing
                     D closed inbound with a phone that belongs to a customer
                       (META_SIM_PHONE, default "(239) 887-8557") → phone saved
     closedtoday   one fresh thread, an OPEN-hours inbound — run it with
                   Settings → Facebook → "Shop closed today" ON → auto-reply
     autoecho      the echo of our auto-reply (app_id CrisData, metadata
                   crisdata:auto) — needs META_SIM_PSID and META_SIM_ECHO_MID =
                   the auto row's mid (dry-run: dryrun:…) → no new row, auto stays true
   ============================================================ */
import crypto from 'node:crypto';
import { isShopOpen } from '../shared/shop-hours.js';

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

const CRISDATA_APP = 1075837401512965;   // = CRISDATA_APP_ID in api/meta-webhook.js
const scenario = process.env.META_SIM_SCENARIO || '';

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex');

async function send(label, raw, { signed = true, expect = 200 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (signed) headers['X-Hub-Signature-256'] = sign(raw);
  const r = await fetch(url, { method: 'POST', headers, body: raw });
  const ok = r.status === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} HTTP ${r.status} (expect ${expect})`);
  return ok;
}

if (scenario) { await autoReplyScenario(scenario); }

async function autoReplyScenario(which) {
  const HOUR = 3600_000;
  const now = Date.now();
  // A minute whose ±2 h are all closed (every night has one), and the newest open minute.
  const closedAround = (t) => [-2, -1, 0, 1, 2].every((h) => !isShopOpen(t + h * HOUR));
  let closedAt = null, openAt = null;
  for (let t = now - 2 * HOUR; t > now - 20 * HOUR && closedAt == null; t -= 15 * 60_000) if (closedAround(t)) closedAt = t;
  for (let t = now - 5 * 60_000; t > now - 20 * HOUR && openAt == null; t -= 15 * 60_000) if (isShopOpen(t)) openAt = t;
  const et = (ms) => ms == null ? '—' : new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  console.log(`closed-hours time used: ${et(closedAt)} ET · open-hours time used: ${et(openAt)} ET\n`);
  const P = (tag) => `SIM_${run}${tag}`;
  const env2 = (m) => JSON.stringify({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [m] }] });
  const inb = (ps, n, text, ts) => env2({ sender: { id: ps }, recipient: { id: PAGE }, timestamp: ts, message: { mid: `m_sim_${run}_${n}`, text } });
  const res = [];
  const threads = {};
  if (which === 'autoreply') {
    if (closedAt == null) { console.error('No closed minute in the last 20 h?'); process.exit(1); }
    const phone = process.env.META_SIM_PHONE || '(239) 887-8557';
    threads.A = P(1); threads.B = P(2); threads.C = P(3); threads.D = P(4);
    res.push(await send('A1. closed-hours inbound (→ auto-reply)', inb(threads.A, 'a1', 'SIM A: hello? anyone there?', closedAt)));
    res.push(await send('A2. same thread, same stretch (→ none)', inb(threads.A, 'a2', 'SIM A: hello again', closedAt + 60_000)));
    res.push(await send('B1. staff reply in Business Suite', env2({ sender: { id: PAGE }, recipient: { id: threads.B }, timestamp: closedAt - 60_000,
      message: { mid: `m_sim_${run}_b1`, text: 'SIM B: we open at 8', is_echo: true, app_id: INBOX_APP } })));
    res.push(await send('B2. then the customer writes (→ none)', inb(threads.B, 'b2', 'SIM B: ok thanks', closedAt)));
    if (openAt != null) res.push(await send('C1. open-hours inbound (→ none)', inb(threads.C, 'c1', 'SIM C: are you open?', openAt)));
    else console.log('SKIP  C1. no open minute in the last 20 h (weekend run)');
    res.push(await send(`D1. closed inbound with phone ${phone}`, inb(threads.D, 'd1', `SIM D: this is Tony, call me ${phone}, 2011 F-150 slipping`, closedAt)));
  } else if (which === 'closedtoday') {
    if (openAt == null) { console.error('No open minute in the last 20 h.'); process.exit(1); }
    threads.E = P(5);
    res.push(await send('E1. open-hours inbound, closed-today ON (→ auto)', inb(threads.E, 'e1', 'SIM E: are you open today?', openAt)));
  } else if (which === 'autoecho') {
    const ps = process.env.META_SIM_PSID, m = process.env.META_SIM_ECHO_MID;
    if (!/^SIM_\d+$/.test(ps || '') || !m) { console.error('autoecho needs META_SIM_PSID=SIM_… and META_SIM_ECHO_MID=<the auto row mid>'); process.exit(2); }
    threads.echo = ps;
    res.push(await send('F1. echo of our auto-reply (→ no new row)', env2({ sender: { id: PAGE }, recipient: { id: ps }, timestamp: now - 1000,
      message: { mid: m, text: 'Thanks for messaging Lee Transmission!…', is_echo: true, app_id: CRISDATA_APP, metadata: 'crisdata:auto' } })));
  } else { console.error('unknown META_SIM_SCENARIO ' + which); process.exit(2); }
  console.log('\nthreads:', JSON.stringify(threads));
  process.exit(res.every(Boolean) ? 0 : 1);
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
