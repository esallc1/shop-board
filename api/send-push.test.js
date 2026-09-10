/* ============================================================
   send-push.test.js — unit tests for the Slice 3d recipient resolution.
   Run: npm test   (node --test)

   These replace the old channel→roles assertions. Recipients now come from
   conversation membership: a group pushes every OTHER member, a DM pushes the
   one other person, and the sender never pushes themselves.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipientNamesFromMembers, buildSubscriberInList, formatPushNotification, attachmentLabel, effectivePreview } from './_push-recipients.js';
import { isAllowedOrigin, getRequestOrigin } from './send-push.js';

/* ── GATE 1: the origin allow-list ─────────────────────────────────────────
   Previously UNTESTED, which is how the front desk lost push. The allow-list
   was two exact strings (board.* + one vercel alias) while the office works
   from https://www.leetransmissionshop.com — so every push from the front desk
   403'd, invisibly, because firePush discarded the response.

   These tests pin BOTH halves of the rule: the shop domain matches on a PARSED
   HOSTNAME (never a raw-string endsWith, which is spoofable), and the vercel
   aliases stay an exact-match list because anyone can deploy to vercel.app.
   ──────────────────────────────────────────────────────────────────────── */

// The regression that started this: the office's actual address.
test('www.leetransmissionshop.com is ALLOWED (the front desk — the original bug)', () => {
  assert.equal(isAllowedOrigin('https://www.leetransmissionshop.com'), true);
});

test('the apex and board.* are ALLOWED', () => {
  assert.equal(isAllowedOrigin('https://leetransmissionshop.com'), true);
  assert.equal(isAllowedOrigin('https://board.leetransmissionshop.com'), true);
});

test('a future prod subdomain is ALLOWED without touching this file', () => {
  assert.equal(isAllowedOrigin('https://anything-new.leetransmissionshop.com'), true);
});

// Staging must never be able to ring the crew's real phones — the sandbox
// Supabase project's push_subscriptions is a COPY of prod's.
test('test.leetransmissionshop.com is REJECTED (staging pushes to REAL devices)', () => {
  assert.equal(isAllowedOrigin('https://test.leetransmissionshop.com'), false);
  assert.equal(isAllowedOrigin('https://TEST.leetransmissionshop.com'), false);  // case-folded too
});

// THE SPOOFING PAIR. A raw-string endsWith/includes check accepts both of
// these; a parsed-hostname check accepts neither. This is the whole reason
// isAllowedOrigin parses before comparing.
test('evil-leetransmissionshop.com is REJECTED (no dot before the apex)', () => {
  assert.equal(isAllowedOrigin('https://evil-leetransmissionshop.com'), false);
});

test('leetransmissionshop.com.evil.com is REJECTED (apex as a prefix, attacker owns the domain)', () => {
  assert.equal(isAllowedOrigin('https://leetransmissionshop.com.evil.com'), false);
  assert.equal(isAllowedOrigin('https://www.leetransmissionshop.com.evil.com'), false);
});

test('plaintext http is REJECTED even for a real shop hostname', () => {
  assert.equal(isAllowedOrigin('http://www.leetransmissionshop.com'), false);
  assert.equal(isAllowedOrigin('http://leetransmissionshop.com'), false);
});

test('a malformed origin is REJECTED and never throws', () => {
  for (const bad of ['not a url', '', '://', 'https://', 'leetransmissionshop.com', '  ']) {
    assert.doesNotThrow(() => isAllowedOrigin(bad));
    assert.equal(isAllowedOrigin(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('a null / undefined / non-string origin is REJECTED and never throws', () => {
  for (const bad of [null, undefined, 0, {}, []]) {
    assert.doesNotThrow(() => isAllowedOrigin(bad));
    assert.equal(isAllowedOrigin(bad), false);
  }
});

test('a non-https scheme on a real hostname is REJECTED', () => {
  assert.equal(isAllowedOrigin('javascript://www.leetransmissionshop.com'), false);
  assert.equal(isAllowedOrigin('file://leetransmissionshop.com'), false);
});

test('the vercel aliases are ALLOWED by EXACT match only', () => {
  assert.equal(isAllowedOrigin('https://shop-board-ten.vercel.app'), true);
  assert.equal(isAllowedOrigin('https://shop-board-leetransmission-kiki.vercel.app'), true);
});

// vercel.app is a shared namespace — a suffix match there would hand the
// endpoint to anyone who can deploy a project.
test('an unlisted vercel.app host is REJECTED (no suffix matching there)', () => {
  assert.equal(isAllowedOrigin('https://evil.vercel.app'), false);
  assert.equal(isAllowedOrigin('https://shop-board-git-staging-leetransmission-kiki.vercel.app'), false);
});

/* ── GATE 1, the resolver half: Origin header vs Referer fallback ───────── */

test('origin absent + allowed Referer → resolves and is ALLOWED', () => {
  const req = { headers: { referer: 'https://www.leetransmissionshop.com/advisor-board.html' } };
  const origin = getRequestOrigin(req);
  assert.equal(origin, 'https://www.leetransmissionshop.com');
  assert.equal(isAllowedOrigin(origin), true);
});

test('origin absent + Referer absent → null, REJECTED', () => {
  const origin = getRequestOrigin({ headers: {} });
  assert.equal(origin, null);
  assert.equal(isAllowedOrigin(origin), false);
});

test('origin absent + malformed Referer → null, REJECTED, no throw', () => {
  let origin;
  assert.doesNotThrow(() => { origin = getRequestOrigin({ headers: { referer: 'not a url' } }); });
  assert.equal(origin, null);
  assert.equal(isAllowedOrigin(origin), false);
});

test('the Origin header WINS over the Referer when both are present', () => {
  const req = {
    headers: {
      origin: 'https://test.leetransmissionshop.com',                 // rejected
      referer: 'https://www.leetransmissionshop.com/advisor-board.html', // would be allowed
    },
  };
  assert.equal(getRequestOrigin(req), 'https://test.leetransmissionshop.com');
  assert.equal(isAllowedOrigin(getRequestOrigin(req)), false);
});


test('group push targets all other members, excludes the sender', () => {
  const office = [
    { member_name: 'Cristian' }, { member_name: 'Kevin' },
    { member_name: 'Josh' }, { member_name: 'Daiana Mendez' },
  ];
  assert.deepEqual(
    recipientNamesFromMembers(office, 'Kevin').sort(),
    ['Cristian', 'Daiana Mendez', 'Josh']
  );
});

test('DM push targets the single other person', () => {
  const dm = [{ member_name: 'Josh' }, { member_name: 'Daiana Mendez' }];
  assert.deepEqual(recipientNamesFromMembers(dm, 'Josh'), ['Daiana Mendez']);
  // ...and symmetrically from the other side (no self-push either way).
  assert.deepEqual(recipientNamesFromMembers(dm, 'Daiana Mendez'), ['Josh']);
});

test('sender absent from the membership still yields the full member list', () => {
  // e.g. a stale/renamed sender name — everyone in the conversation is notified.
  const dm = [{ member_name: 'Josh' }, { member_name: 'Kevin' }];
  assert.deepEqual(recipientNamesFromMembers(dm, 'Nobody').sort(), ['Josh', 'Kevin']);
});

test('blank/null names and duplicate members are dropped', () => {
  const messy = [
    { member_name: 'Josh' }, { member_name: 'Josh' },
    { member_name: null }, { member_name: '' }, {},
    { member_name: 'Kevin' },
  ];
  assert.deepEqual(recipientNamesFromMembers(messy, 'Cristian'), ['Josh', 'Kevin']);
});

test('empty / missing member list yields no recipients (no-op push)', () => {
  assert.deepEqual(recipientNamesFromMembers([], 'Kevin'), []);
  assert.deepEqual(recipientNamesFromMembers(null, 'Kevin'), []);
  // A conversation where only the sender is a member → nobody to notify.
  assert.deepEqual(recipientNamesFromMembers([{ member_name: 'Kevin' }], 'Kevin'), []);
});

test('buildSubscriberInList quotes each name (incl. spaces) for the PostgREST in-filter', () => {
  assert.equal(buildSubscriberInList(['Josh', 'Daiana Mendez']), '"Josh","Daiana Mendez"');
  // an embedded double-quote is doubled per PostgREST escaping
  assert.equal(buildSubscriberInList(['A"B']), '"A""B"');
  assert.equal(buildSubscriberInList([]), '');
});

// ── notification formatting (Slice 3e) ──

test('group push reads as title=groupTitle, body="Sender: msg"', () => {
  assert.deepEqual(
    formatPushNotification({ type: 'group', title: 'Office' }, 'Josh', 'test'),
    { title: 'Office', body: 'Josh: test' }
  );
});

test('DM push reads as title=Sender, body=msg (unchanged behavior)', () => {
  assert.deepEqual(
    formatPushNotification({ type: 'dm', title: null }, 'Cristian', 'hey test'),
    { title: 'Cristian', body: 'hey test' }
  );
});

test('titleless / null-title group falls back to "Group" (never an empty title)', () => {
  assert.equal(formatPushNotification({ type: 'group', title: null }, 'Josh', 'hi').title, 'Group');
  assert.equal(formatPushNotification({ type: 'group', title: '   ' }, 'Josh', 'hi').title, 'Group');
});

test('missing/unknown conversation falls back to DM-style formatting', () => {
  assert.deepEqual(
    formatPushNotification(null, 'Kevin', 'yo'),
    { title: 'Kevin', body: 'yo' }
  );
});

test('body is capped at 120 chars INCLUDING the "Sender: " prefix on groups', () => {
  const long = 'x'.repeat(200);
  const g = formatPushNotification({ type: 'group', title: 'Office' }, 'Josh', long);
  assert.equal(g.body.length, 120);
  assert.ok(g.body.startsWith('Josh: xxx'));
  const d = formatPushNotification({ type: 'dm', title: null }, 'Josh', long);
  assert.equal(d.body.length, 120);
});

// ── attachment labels + preview fallback (Slice 4a) ──

test('attachmentLabel covers all three kinds', () => {
  assert.equal(attachmentLabel('photo'), '📷 Photo');
  assert.equal(attachmentLabel('voice'), '🎤 Voice message');
  assert.equal(attachmentLabel('file', 'brakes.pdf'), '📎 brakes.pdf');
  assert.equal(attachmentLabel('file', null), '📎 File');   // filename fallback
  assert.equal(attachmentLabel('file', '   '), '📎 File');
  assert.equal(attachmentLabel(null), '');                  // plain text message
});

test('effectivePreview: caption wins, else attachment label', () => {
  assert.equal(effectivePreview('nice one', 'photo', null), 'nice one');
  assert.equal(effectivePreview('', 'photo', null), '📷 Photo');
  assert.equal(effectivePreview('   ', 'file', 'inv.pdf'), '📎 inv.pdf');
  assert.equal(effectivePreview('', 'voice', null), '🎤 Voice message');
  assert.equal(effectivePreview('hello', null, null), 'hello');  // plain text
});

test('attachment-only photo pushes "Sender: 📷 Photo" in a group, "📷 Photo" in a DM', () => {
  const preview = effectivePreview('', 'photo', null);
  assert.deepEqual(
    formatPushNotification({ type: 'group', title: 'Office' }, 'Josh', preview),
    { title: 'Office', body: 'Josh: 📷 Photo' }
  );
  assert.deepEqual(
    formatPushNotification({ type: 'dm', title: null }, 'Josh', preview),
    { title: 'Josh', body: '📷 Photo' }
  );
});
