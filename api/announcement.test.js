/* ============================================================
   announcement.test.js — unit tests for the announcement endpoint's PURE
   validator. Invariants: two actions, style whitelist, message required +
   bounded, expires_at optional/valid, uuid for remove.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnouncementBody, STYLES, ROLES, MAX_MESSAGE } from './announcement.js';

const UUID = '11111111-2222-3333-4444-555555555555';

// ── create ──────────────────────────────────────────────────
test('create: accepts a normal message, defaults style to normal + audience to all roles', () => {
  const r = parseAnnouncementBody({ message: '  Shop closes at 3 today  ' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(r.row.message, 'Shop closes at 3 today');   // trimmed
  assert.equal(r.row.style, 'normal');
  assert.equal(r.row.expires_at, null);
  assert.deepEqual(r.row.audience, ['manager', 'advisor', 'bookkeeping']);   // absent → all three
});

// ── audience ────────────────────────────────────────────────
test('audience: a subset is kept, unknown roles dropped, deduped', () => {
  assert.deepEqual(parseAnnouncementBody({ message: 'hi', audience: ['advisor'] }).row.audience, ['advisor']);
  assert.deepEqual(parseAnnouncementBody({ message: 'hi', audience: ['manager', 'owner', 'manager'] }).row.audience, ['manager']);
});

test('audience: present-but-empty (or all-unknown) is rejected', () => {
  assert.equal(parseAnnouncementBody({ message: 'hi', audience: [] }).ok, false);
  assert.equal(parseAnnouncementBody({ message: 'hi', audience: ['nobody'] }).ok, false);
  assert.equal(parseAnnouncementBody({ message: 'hi', audience: 'advisor' }).ok, false);   // not an array
});

test('ROLES is exactly the three office roles', () => {
  assert.deepEqual(ROLES, ['manager', 'advisor', 'bookkeeping']);
});

test('create: accepts important style + expires_at + poster', () => {
  const r = parseAnnouncementBody({ message: 'Water main break', style: 'important', expires_at: '2026-08-05T23:59:59.000Z', posted_by_name: 'Cris' });
  assert.equal(r.ok, true);
  assert.equal(r.row.style, 'important');
  assert.equal(r.row.expires_at, '2026-08-05T23:59:59.000Z');
  assert.equal(r.row.posted_by_name, 'Cris');
});

test('create: an unknown style falls back to normal', () => {
  assert.equal(parseAnnouncementBody({ message: 'hi', style: 'flashing-red' }).row.style, 'normal');
});

test('create: rejects an empty / whitespace message', () => {
  assert.equal(parseAnnouncementBody({ message: '   ' }).ok, false);
  assert.equal(parseAnnouncementBody({}).ok, false);
});

test('create: rejects an over-long message', () => {
  assert.equal(parseAnnouncementBody({ message: 'x'.repeat(MAX_MESSAGE + 1) }).ok, false);
  assert.equal(parseAnnouncementBody({ message: 'x'.repeat(MAX_MESSAGE) }).ok, true);
});

test('create: rejects a bad expires_at but accepts null / empty', () => {
  assert.equal(parseAnnouncementBody({ message: 'hi', expires_at: 'someday' }).ok, false);
  assert.equal(parseAnnouncementBody({ message: 'hi', expires_at: null }).row.expires_at, null);
  assert.equal(parseAnnouncementBody({ message: 'hi', expires_at: '' }).row.expires_at, null);
});

// ── remove ──────────────────────────────────────────────────
test('remove: requires a uuid id', () => {
  assert.deepEqual(parseAnnouncementBody({ action: 'remove', id: UUID }), { ok: true, action: 'remove', id: UUID });
  assert.equal(parseAnnouncementBody({ action: 'remove', id: 'nope' }).ok, false);
  assert.equal(parseAnnouncementBody({ action: 'remove' }).ok, false);
});

test('STYLES is exactly normal + important', () => {
  assert.deepEqual(STYLES, ['normal', 'important']);
});
