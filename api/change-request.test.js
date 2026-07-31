/* ============================================================
   change-request.test.js — unit tests for the change-request endpoint's PURE
   validator. Invariants: two actions; type/priority/status whitelists; a
   submission needs a note OR a screenshot; screenshot_path must be one we minted
   (reports/<uuid>/…); uuid for triage.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangeRequestBody, TYPES, PRIORITIES, STATUSES, MAX_BODY } from './change-request.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const SHOT = `reports/${UUID}/screen.png`;

// ── create ──────────────────────────────────────────────────
test('create: accepts a text-only submission, defaults priority to normal + status new', () => {
  const r = parseChangeRequestBody({ type: 'bug', body: '  the print button is dead  ' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'create');
  assert.equal(r.row.type, 'bug');
  assert.equal(r.row.body, 'the print button is dead');   // trimmed
  assert.equal(r.row.priority, 'normal');                  // absent → normal
  assert.equal(r.row.status, 'new');                       // server-set, never from body
  assert.equal(r.row.screenshot_path, null);
});

test('create: accepts a screenshot-only submission (no body)', () => {
  const r = parseChangeRequestBody({ type: 'idea', screenshot_path: SHOT, screenshot_name: 'screen.png', screenshot_mime: 'image/png' });
  assert.equal(r.ok, true);
  assert.equal(r.row.body, null);
  assert.equal(r.row.screenshot_path, SHOT);
  assert.equal(r.row.screenshot_name, 'screen.png');
  assert.equal(r.row.screenshot_mime, 'image/png');
});

test('create: rejects a submission with neither a note nor a screenshot', () => {
  assert.equal(parseChangeRequestBody({ type: 'bug' }).ok, false);
  assert.equal(parseChangeRequestBody({ type: 'bug', body: '   ' }).ok, false);   // blank note doesn't count
});

test('create: rejects an unknown type', () => {
  assert.equal(parseChangeRequestBody({ type: 'question', body: 'hi' }).ok, false);
  assert.equal(parseChangeRequestBody({ body: 'hi' }).ok, false);                 // missing type
});

test('create: an unknown priority falls back to normal', () => {
  assert.equal(parseChangeRequestBody({ type: 'bug', body: 'x', priority: 'urgent' }).row.priority, 'normal');
  assert.equal(parseChangeRequestBody({ type: 'bug', body: 'x', priority: 'immediate' }).row.priority, 'immediate');
});

test('create: rejects a screenshot_path that is not reports/<uuid>/<file>', () => {
  assert.equal(parseChangeRequestBody({ type: 'bug', screenshot_path: 'invoices/secret.png' }).ok, false);
  assert.equal(parseChangeRequestBody({ type: 'bug', screenshot_path: `reports/not-a-uuid/x.png` }).ok, false);
  assert.equal(parseChangeRequestBody({ type: 'bug', screenshot_path: SHOT }).ok, true);
});

test('create: rejects an over-long note', () => {
  assert.equal(parseChangeRequestBody({ type: 'bug', body: 'x'.repeat(MAX_BODY + 1) }).ok, false);
  assert.equal(parseChangeRequestBody({ type: 'bug', body: 'x'.repeat(MAX_BODY) }).ok, true);
});

test('create: captures context + submitter, ignores a spoofed non-uuid submitter id', () => {
  const r = parseChangeRequestBody({
    type: 'idea', body: 'dark mode please',
    submitted_by_id: UUID, submitted_by_name: 'Josh', submitted_by_role: 'advisor',
    context_board: 'advisor', context_view: 'approval', context_ro: 'RO-1234',
    app_version: 'abc1234', user_agent: 'Mozilla/5.0',
  });
  assert.equal(r.row.submitted_by_id, UUID);
  assert.equal(r.row.submitted_by_name, 'Josh');
  assert.equal(r.row.context_board, 'advisor');
  assert.equal(r.row.context_view, 'approval');
  assert.equal(r.row.context_ro, 'RO-1234');
  assert.equal(parseChangeRequestBody({ type: 'bug', body: 'x', submitted_by_id: 'nope' }).row.submitted_by_id, null);
});

// ── triage ──────────────────────────────────────────────────
test('triage: requires a uuid id and a valid status', () => {
  assert.deepEqual(parseChangeRequestBody({ action: 'triage', id: UUID, status: 'reviewing' }),
    { ok: true, action: 'triage', id: UUID, status: 'reviewing', owner_note: null });
  assert.equal(parseChangeRequestBody({ action: 'triage', id: 'nope', status: 'reviewing' }).ok, false);
  assert.equal(parseChangeRequestBody({ action: 'triage', id: UUID, status: 'shipping' }).ok, false);
  assert.equal(parseChangeRequestBody({ action: 'triage', id: UUID }).ok, false);   // missing status
});

test('triage: keeps a trimmed owner_note when present', () => {
  const r = parseChangeRequestBody({ action: 'triage', id: UUID, status: 'wont_build', owner_note: '  not planned right now  ' });
  assert.equal(r.ok, true);
  assert.equal(r.owner_note, 'not planned right now');
});

// ── whitelists locked ───────────────────────────────────────
test('whitelists are exactly as documented', () => {
  assert.deepEqual(TYPES, ['bug', 'idea']);
  assert.deepEqual(PRIORITIES, ['immediate', 'high', 'normal', 'low']);
  assert.deepEqual(STATUSES, ['new', 'reviewing', 'in_progress', 'done', 'not_now', 'wont_build']);
});
