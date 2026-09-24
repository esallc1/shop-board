/* ============================================================
   messenger-tray-logic.test.js — the Advisor inbox tray's rules.
   Run: npm test   (node --test)

   Locks: which threads WAIT (done_at null, or a newer customer message than
   done_at — our own replies never bring one back), who a row is (customer >
   Facebook name > "Facebook user"), the 24h window label, what counts as a
   NEW inbound (auto-open), the preview/byline/attachment wording, and that
   the tray module never writes (static check on shared/messenger-tray.js).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isWaiting, waitingThreads, threadName, windowLabel, previewText, attachmentLabel,
  messageByline, newestInbound, hasNewInbound, latestByThread, timeLabel, WINDOW_MS,
  composeState, replyError, searchCustomers, bylineWithViewer, WINDOW_CLOSED_TEXT, inboundArrivedMs, splitWaiting, callLink,
} from './messenger-tray-logic.js';

const NOW = Date.parse('2026-09-23T15:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();

test('isWaiting: never done → waits', () => {
  assert.equal(isWaiting({ done_at: null, last_inbound_at: ago(1) }), true);
  assert.equal(isWaiting({ done_at: null, last_inbound_at: null }), true);
});

test('isWaiting: done after the last customer message → gone; a newer customer message → back', () => {
  assert.equal(isWaiting({ done_at: ago(1), last_inbound_at: ago(2) }), false);
  assert.equal(isWaiting({ done_at: ago(2), last_inbound_at: ago(1) }), true);
  assert.equal(isWaiting({ done_at: ago(1), last_inbound_at: ago(1) }), false);   // same instant ≠ newer
});

test('isWaiting: our own later reply does NOT bring a Done thread back (only last_inbound_at counts)', () => {
  assert.equal(isWaiting({ done_at: ago(2), last_inbound_at: ago(3), last_message_at: ago(1) }), false);
  assert.equal(isWaiting(null), false);
});

test('waitingThreads: filters and sorts newest activity first, input untouched', () => {
  const input = [
    { id: 'a', done_at: null, last_message_at: ago(5) },
    { id: 'b', done_at: ago(1), last_inbound_at: ago(2), last_message_at: ago(0.5) },
    { id: 'c', done_at: null, last_message_at: ago(1) },
  ];
  const copy = JSON.stringify(input);
  assert.deepEqual(waitingThreads(input).map((t) => t.id), ['c', 'a']);
  assert.equal(JSON.stringify(input), copy);
});

test('threadName: linked customer > Facebook name > "Facebook user"', () => {
  const custs = { C1: { name: 'Maria Lopez' } };
  assert.deepEqual(threadName({ customer_id: 'C1', display_name: 'Mary L' }, custs), { name: 'Maria Lopez', linked: true });
  assert.deepEqual(threadName({ customer_id: 'C2', display_name: 'Mary L' }, custs), { name: 'Mary L', linked: false });   // linked but not loaded
  assert.deepEqual(threadName({ customer_id: null, display_name: '  ' }, custs), { name: 'Facebook user', linked: false });
  assert.deepEqual(threadName({}, null), { name: 'Facebook user', linked: false });
});

test('windowLabel: hours left, minutes when under an hour, closed after 24h', () => {
  assert.deepEqual(windowLabel(ago(1), NOW), { open: true, text: '23h left to reply' });
  const m = windowLabel(new Date(NOW - WINDOW_MS + 20 * 60000).toISOString(), NOW);
  assert.equal(m.open, true);
  assert.equal(m.urgent, true);
  assert.equal(m.text, '20m left to reply');
  assert.deepEqual(windowLabel(ago(25), NOW), { open: false, text: 'Reply window closed' });
  assert.equal(windowLabel(null, NOW).open, false);
});

test('newestInbound / hasNewInbound: only a later customer message on a waiting thread is "new"; first load never is', () => {
  const t1 = [{ done_at: null, last_inbound_at: ago(2) }];
  const t2 = [...t1, { done_at: null, last_inbound_at: ago(0.1) }];
  const a = newestInbound(t1), b = newestInbound(t2);
  assert.equal(hasNewInbound(a, b), true);
  assert.equal(hasNewInbound(b, b), false);
  assert.equal(hasNewInbound(null, b), false);
  assert.equal(newestInbound([{ done_at: ago(0), last_inbound_at: ago(1) }]), null);   // done thread ignored
});

test('previewText: text, attachment-only, our reply, a failed send, truncation', () => {
  assert.equal(previewText({ direction: 'in', text: 'is my  truck\nready?' }), 'is my truck ready?');
  assert.equal(previewText({ direction: 'in', text: null, attachments: [{ type: 'image' }] }), '📷 Photo');
  assert.equal(previewText({ direction: 'out', text: 'Ready at 4', send_status: 'sent' }), 'Shop: Ready at 4');
  assert.equal(previewText({ direction: 'out', text: 'Ready', send_status: 'failed' }), 'Not sent: Ready');
  assert.equal(previewText({ direction: 'in', text: 'x'.repeat(200) }).length, 90);
  assert.equal(previewText(undefined), '');
});

test('attachmentLabel + messageByline wording', () => {
  assert.equal(attachmentLabel({ type: 'image' }), '📷 Photo');
  assert.equal(attachmentLabel({ type: 'image', sticker_id: '1' }), '👍 Sticker');
  assert.equal(attachmentLabel({ type: 'fallback', title: 'A link' }), '🔗 A link');
  assert.equal(attachmentLabel(null), '📎 Attachment');
  const emps = { E1: { name: 'ZZ Test Advisor' } };
  assert.equal(messageByline({ direction: 'in' }, emps), '');
  assert.equal(messageByline({ direction: 'out', source: 'page_inbox' }, emps), 'via Facebook app');
  assert.equal(messageByline({ direction: 'out', source: 'crisdata', sent_by: 'E1' }, emps), 'CrisData · ZZ Test Advisor');
  assert.equal(messageByline({ direction: 'out', source: 'crisdata', sent_by: null }, emps), 'CrisData');
});

test('latestByThread + timeLabel', () => {
  const l = latestByThread([
    { thread_id: 'a', sent_at: ago(3), text: 'old' },
    { thread_id: 'a', sent_at: ago(1), text: 'new' },
    { thread_id: 'b', sent_at: ago(2), text: 'b' },
    null,
  ]);
  assert.equal(l.a.text, 'new');
  assert.equal(l.b.text, 'b');
  assert.equal(timeLabel(new Date(NOW - 20000).toISOString(), NOW), 'now');
  assert.equal(timeLabel(ago(0.5), NOW), '30m');
  assert.equal(timeLabel(ago(5), NOW), '5h');
  assert.equal(timeLabel(null, NOW), '');
});

test('the tray never writes social_* itself — its only write path is cdAuthFetch → /api/messenger', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'messenger-tray.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\s*\(/);
  assert.doesNotMatch(src, /service_role|SERVICE_ROLE/);
  assert.match(src, /db\.auth\.getSession\(\)/);
  // exactly one network write: cdAuthFetch to the one endpoint
  assert.match(src, /const API = '\/api\/messenger';/);
  assert.equal((src.match(/cdAuthFetch\(/g) || []).length, 1);
  assert.doesNotMatch(src, /[^.]fetch\(\s*['"`]/);          // no bare fetch('…') anywhere
  assert.doesNotMatch(src, /\/api\/(?!messenger)[a-z-]+/);    // no other endpoint
  // the tray's actions are exactly reply / link / done
  const actions = [...src.matchAll(/action: '([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(actions)], ['done', 'link', 'reply']);
});

test('advisor-board mounts the tray exactly once, on body, with its stylesheet', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'advisor-board.html'), 'utf8');
  assert.equal((html.match(/mountMessengerTray\(\{ db, viewer: /g) || []).length, 1);
  assert.equal((html.match(/shared\/messenger-tray\.css/g) || []).length, 1);
});

test('composeState: open window → can reply; closed → the plain reason, plus tel: when the linked customer has a phone', () => {
  const open = composeState({ last_inbound_at: ago(2) }, null, NOW);
  assert.deepEqual(open, { canReply: true, reason: '', tel: null });
  const closed = composeState({ last_inbound_at: ago(30) }, { name: 'Maria', phone_primary: '(239) 555-0142' }, NOW);
  assert.equal(closed.canReply, false);
  assert.equal(closed.reason, WINDOW_CLOSED_TEXT);
  assert.match(closed.reason, /within 24 hours of their last message — call them instead/);
  assert.equal(closed.tel, 'tel:+12395550142');
  assert.equal(composeState({ last_inbound_at: ago(30) }, { name: 'X', phone_primary: '', phone_secondary: '12395550199' }, NOW).tel, 'tel:+12395550199');
  assert.equal(composeState({ last_inbound_at: ago(30) }, null, NOW).tel, null);
  assert.equal(composeState({ last_inbound_at: null }, null, NOW).canReply, false);
});

test('replyError: 190 / not connected → banner; window closed; 401; Meta refusal; network', () => {
  assert.equal(replyError(502, { error: 'token_expired', message: 'Facebook connection expired — …' }).banner, true);
  assert.equal(replyError(503, { error: 'not_connected', message: "Facebook isn't connected to CrisData yet…" }).banner, true);
  assert.deepEqual(replyError(409, { error: 'window_closed', message: 'x' }), { banner: false, message: WINDOW_CLOSED_TEXT });
  assert.match(replyError(401, { error: 'unauthorized' }).message, /sign in again/);
  assert.deepEqual(replyError(502, { error: 'send_failed', message: 'Facebook refused the message: bad' }), { banner: false, message: 'Facebook refused the message: bad' });
  assert.match(replyError(0, null).message, /Couldn't reach CrisData/);
  assert.match(replyError(400, { error: 'thread_id must be a uuid' }).message, /thread_id/);
});

test('searchCustomers: the Desk picker rules — recent 30 with no query, name/business or ≥3 phone digits, cap 60', () => {
  const list = [
    { id: 1, name: 'Maria Lopez', phone_primary: '(239) 555-0142', last_invoiced: '2026-09-01' },
    { id: 2, name: 'Juan Perez', business_name: 'JDPR Construction', phone_primary: '239-555-0199', last_invoiced: '2026-09-20' },
    { id: 3, name: 'Ann Lee', phone_secondary: '+1 (941) 222-3333' },
  ];
  assert.deepEqual(searchCustomers(list, '').map((c) => c.id), [2, 1, 3]);
  assert.deepEqual(searchCustomers(list, 'jdpr').map((c) => c.id), [2]);
  assert.deepEqual(searchCustomers(list, 'maria').map((c) => c.id), [1]);
  assert.deepEqual(searchCustomers(list, '0142').map((c) => c.id), [1]);
  assert.deepEqual(searchCustomers(list, '222').map((c) => c.id), [3]);
  assert.deepEqual(searchCustomers(list, '55').map((c) => c.id), []);          // <3 digits: no phone match
  assert.equal(searchCustomers(Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'Bob ' + i })), 'bob').length, 60);
  assert.equal(searchCustomers(Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'B' })), '').length, 30);
  assert.deepEqual(searchCustomers(null, 'x'), []);
});

test('bylineWithViewer: the viewer names their own reply when the roster view hides them', () => {
  const viewer = { id: 'ZZ', name: 'ZZ Test Advisor' };
  const mine = { direction: 'out', source: 'crisdata', sent_by: 'ZZ' };
  assert.equal(bylineWithViewer(mine, {}, viewer), 'CrisData · ZZ Test Advisor');
  assert.equal(bylineWithViewer(mine, { ZZ: { name: 'Roster Name' } }, viewer), 'CrisData · Roster Name');
  assert.equal(bylineWithViewer({ ...mine, sent_by: 'OTHER' }, {}, viewer), 'CrisData');
  assert.equal(bylineWithViewer({ direction: 'out', source: 'page_inbox' }, {}, viewer), 'via Facebook app');
  assert.equal(bylineWithViewer(mine, {}, null), 'CrisData');
});

test('THE sent-before-Done case: sent 10:00:00, Done 10:00:05, delivered 10:00:06 → the thread comes back', () => {
  const t = {
    last_inbound_at: '2026-09-23T14:00:00Z',            // Meta: when the customer SENT it
    done_at: '2026-09-23T14:00:05Z',                    // someone clicked Done
    last_inbound_received_at: '2026-09-23T14:00:06Z',   // when it ARRIVED here
  };
  assert.equal(isWaiting(t), true);
  // the reply window still runs on Meta's clock, not arrival
  assert.equal(windowLabel(t.last_inbound_at, Date.parse('2026-09-24T13:59:00Z')).open, true);
  assert.equal(windowLabel(t.last_inbound_at, Date.parse('2026-09-24T14:00:01Z')).open, false);
});

test('arrival rules: arrived before Done → stays done; our reply after Done never counts; old rows fall back to last_inbound_at', () => {
  assert.equal(isWaiting({ last_inbound_at: ago(3), last_inbound_received_at: ago(3), done_at: ago(2) }), false);
  assert.equal(isWaiting({ last_inbound_at: ago(3), last_inbound_received_at: ago(3), done_at: ago(2), last_message_at: ago(1) }), false);
  assert.equal(isWaiting({ last_inbound_at: ago(1), last_inbound_received_at: null, done_at: ago(2) }), true);    // pre-column row
  assert.equal(isWaiting({ last_inbound_at: ago(3), last_inbound_received_at: null, done_at: ago(2) }), false);
  assert.equal(inboundArrivedMs({ last_inbound_at: ago(5), last_inbound_received_at: ago(1) }), NOW - 3600000);
  assert.equal(inboundArrivedMs(null), null);
});

test('auto-open follows ARRIVAL: a late delivery with an older Meta timestamp still counts as new', () => {
  const before = [{ done_at: null, last_inbound_at: ago(1), last_inbound_received_at: ago(1) }];
  const after = [...before, { done_at: null, last_inbound_at: ago(2), last_inbound_received_at: ago(0) }];
  assert.equal(hasNewInbound(newestInbound(before), newestInbound(after)), true);
});

test('the tray reads last_inbound_received_at', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'messenger-tray.js'), 'utf8');
  assert.match(src, /last_inbound_received_at/);
});

/* ── After-hours auto-reply in the tray (meta-webhook.md §12) ─────────────── */
import { matchPhoneToCustomer as _match, messageByline as _byline } from './messenger-tray-logic.js';
import { readFileSync as _read } from 'node:fs';

test('an auto-reply is labelled "Auto-reply", never as a person or the Facebook app', () => {
  assert.equal(_byline({ direction: 'out', source: 'crisdata', auto: true, sent_by: null }, {}), 'Auto-reply');
  assert.equal(_byline({ direction: 'out', source: 'page_inbox', auto: true }, {}), 'Auto-reply');
  assert.notEqual(_byline({ direction: 'out', source: 'page_inbox', auto: false }, {}), 'Auto-reply');
});

test('a typed phone suggests a customer ONLY when exactly one active customer has it', () => {
  const list = [
    { id: 'c1', name: 'Snooks Services', phone_primary: '(239) 887-8557', archived_at: null },
    { id: 'c2', name: 'Ana', phone_primary: '2395550000', phone_secondary: '+1 239-555-1111', archived_at: null },
    { id: 'c3', name: 'Twin A', phone_primary: '2395552222', archived_at: null },
    { id: 'c4', name: 'Twin B', phone_secondary: '239.555.2222', archived_at: null },
    { id: 'c5', name: 'Old', phone_primary: '2395553333', archived_at: '2026-01-01' },
  ];
  assert.equal(_match(list, '2398878557').id, 'c1');
  assert.equal(_match(list, '2395551111').id, 'c2');   // second number counts too
  assert.equal(_match(list, '2395552222'), null);        // two people → never guess
  assert.equal(_match(list, '2395553333'), null);        // archived → no
  assert.equal(_match(list, '2395559999'), null);
  assert.equal(_match(list, null), null);
  assert.equal(_match(null, '2398878557'), null);
});

test('tray: reads auto + detected_phone, shows the auto label, and Attach runs the normal Link (never automatic)', () => {
  const src = _read(new URL('./messenger-tray.js', import.meta.url), 'utf8');
  assert.match(src, /last_message_at, done_at, detected_phone'\)/);
  assert.equal((src.match(/send_status, (send_error, sent_by, )?sent_at, auto'\)/g) || []).length, 2);
  assert.match(src, /class="mtray-auto"/);
  assert.match(src, /case 'attach-suggest': \{[\s\S]*?doLink\(st\.suggest\.customer\)/);
  // the suggestion only for an UNLINKED thread with a typed phone
  assert.match(src, /if \(!t \|\| t\.customer_id \|\| !t\.detected_phone \|\| st\.busy\) return '';/);
  // doLink is only ever called from a tap, never from a render/load path
  const calls = [...src.matchAll(/doLink\(/g)].length;
  assert.equal(calls, 3, 'doLink: its definition + the picker tap + the suggestion tap');
});

test("waiting threads split: can still reply → Needs handling (counted); window closed → Can't reply anymore (not counted); a new message brings it back", () => {
  const now = Date.parse('2026-09-24T18:00:00Z');
  const th = [
    { id: 'fresh', done_at: null, last_inbound_at: '2026-09-24T10:00:00Z', last_message_at: '2026-09-24T10:00:00Z' },
    { id: 'old', done_at: null, last_inbound_at: '2026-09-22T10:00:00Z', last_message_at: '2026-09-22T11:00:00Z' },
    { id: 'none', done_at: null, last_inbound_at: null, last_message_at: '2026-09-23T10:00:00Z' },
    { id: 'done', done_at: '2026-09-24T11:00:00Z', last_inbound_at: '2026-09-24T10:00:00Z' },
  ];
  const r = splitWaiting(th, now);
  assert.deepEqual(r.active.map((t) => t.id), ['fresh']);
  assert.deepEqual(r.stale.map((t) => t.id), ['none', 'old'], 'newest activity first');
  // The customer writes again → the window reopens → back in Needs handling.
  const again = splitWaiting([{ ...th[1], last_inbound_at: '2026-09-24T17:30:00Z', last_inbound_received_at: '2026-09-24T17:30:05Z', last_message_at: '2026-09-24T17:30:00Z' }], now);
  assert.deepEqual([again.active.length, again.stale.length], [1, 0]);
  assert.deepEqual(th.map((t) => t.id), ['fresh', 'old', 'none', 'done'], 'input untouched');
});

test('Call them: the linked customer\'s phone, else the phone they typed; else nothing', () => {
  assert.deepEqual(callLink({ detected_phone: '239-887-8557' }, { phone_primary: '(813) 590-9459' }), { tel: 'tel:+18135909459', digits: '8135909459' });
  assert.deepEqual(callLink({ detected_phone: '239-887-8557' }, null), { tel: 'tel:+12398878557', digits: '2398878557' });
  assert.deepEqual(callLink({ detected_phone: '239-887-8557' }, { phone_primary: null, phone_secondary: '12395550112' }), { tel: 'tel:+12395550112', digits: '2395550112' });
  assert.equal(callLink({}, null), null);
  assert.equal(callLink({ detected_phone: '555' }, null), null);
});
