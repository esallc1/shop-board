/* ============================================================
   send-push.test.js — unit tests for the Slice 3d recipient resolution.
   Run: npm test   (node --test)

   These replace the old channel→roles assertions. Recipients now come from
   conversation membership: a group pushes every OTHER member, a DM pushes the
   one other person, and the sender never pushes themselves.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipientNamesFromMembers, buildSubscriberInList } from './_push-recipients.js';

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
