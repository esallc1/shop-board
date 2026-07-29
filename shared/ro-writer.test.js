/* ============================================================
   ro-writer.test.js — unit tests for the RO service-writer helpers.
   Run: npm test   (node --test)

   These lock the security-critical behavior: the printed "Service Advisor"
   line resolves from the RO's STORED writer, never from whoever is logged in;
   the dropdown filters to the right roles and stores IDs (not names); the
   writer stamps onto the RO at creation; and the whole feature stays dormant
   (never throws, prints '—') before the migration adds the column.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITER_ROLES, isEligibleWriter, buildWriterOptions,
  serviceWriterName, withServiceWriter, isMissingColumn,
} from './ro-writer.js';

// ── mintRo auto-stamp ────────────────────────────────────────
test('withServiceWriter stamps the creator id onto the RO row (mintRo auto-stamp)', () => {
  const base = { customer_id: 'c1', vehicle_id: 'v1', complaint: 'noise' };
  const row = withServiceWriter(base, 'emp-josh');
  assert.equal(row.service_writer_id, 'emp-josh');
  // original untouched, other fields preserved
  assert.equal(base.service_writer_id, undefined);
  assert.equal(row.customer_id, 'c1');
  assert.equal(row.complaint, 'noise');
});

test('withServiceWriter stores NULL (never undefined) when there is no creator id', () => {
  assert.equal(withServiceWriter({}, null).service_writer_id, null);
  assert.equal(withServiceWriter({}, undefined).service_writer_id, null);
  assert.equal(withServiceWriter({}, '').service_writer_id, null);
});

// ── dropdown role/active filter ──────────────────────────────
const ROSTER = [
  { id: 'a1', name: 'Josh',   role: 'advisor',     active: true },
  { id: 'm1', name: 'Will',   role: 'manager',     active: true },
  { id: 'o1', name: 'Owner',  role: 'owner',       active: true },
  { id: 't1', name: 'Kevin',  role: 'tech',        active: true },
  { id: 'b1', name: 'Daiana', role: 'bookkeeping', active: true },
  { id: 'a2', name: 'ExAdv',  role: 'advisor',     active: false },
];

test('WRITER_ROLES is exactly advisor/manager/owner — excludes tech and bookkeeping', () => {
  assert.deepEqual([...WRITER_ROLES].sort(), ['advisor', 'manager', 'owner']);
  assert.ok(!WRITER_ROLES.includes('tech'));
  assert.ok(!WRITER_ROLES.includes('bookkeeping'));
  assert.ok(!WRITER_ROLES.includes('service_advisor')); // value is 'advisor', not 'service_advisor'
});

test('isEligibleWriter: advisor/manager/owner active are eligible; tech, bookkeeping, inactive are not', () => {
  assert.ok(isEligibleWriter({ role: 'advisor', active: true }));
  assert.ok(isEligibleWriter({ role: 'manager', active: true }));
  assert.ok(isEligibleWriter({ role: 'owner', active: true }));
  assert.ok(!isEligibleWriter({ role: 'tech', active: true }));
  assert.ok(!isEligibleWriter({ role: 'bookkeeping', active: true }));
  assert.ok(!isEligibleWriter({ role: 'advisor', active: false }));
  assert.ok(!isEligibleWriter(null));
});

test('buildWriterOptions includes advisor/manager/owner, excludes tech/bookkeeping/inactive, and stores the ID', () => {
  const opts = buildWriterOptions(ROSTER, null);
  assert.deepEqual(opts.map((o) => o.id).sort(), ['a1', 'm1', 'o1']);
  // option value is the employee ID, never the name
  const josh = opts.find((o) => o.id === 'a1');
  assert.equal(josh.name, 'Josh');
  assert.notEqual(josh.id, josh.name);
  assert.ok(!opts.some((o) => o.id === 't1'), 'tech excluded');
  assert.ok(!opts.some((o) => o.id === 'b1'), 'bookkeeping excluded');
  assert.ok(!opts.some((o) => o.id === 'a2'), 'inactive excluded');
});

test('buildWriterOptions marks the stored writer selected', () => {
  const opts = buildWriterOptions(ROSTER, 'm1');
  assert.equal(opts.filter((o) => o.selected).length, 1);
  assert.equal(opts.find((o) => o.selected).id, 'm1');
});

test('buildWriterOptions keeps a stored-but-now-ineligible writer visible + selected', () => {
  // writer was deactivated / changed role since the RO was written
  const opts = buildWriterOptions(ROSTER, 'gone-99', 'Former Advisor');
  const sel = opts.find((o) => o.selected);
  assert.equal(sel.id, 'gone-99');
  assert.equal(sel.name, 'Former Advisor');
});

// ── print resolves the STORED writer, not the logged-in user ─
test('serviceWriterName resolves the RO\'s stored writer name', () => {
  assert.equal(serviceWriterName({ service_writer: { name: 'Josh Advisor' } }), 'Josh Advisor');
});

test('printing as a DIFFERENT user still shows the RO\'s writer (never the logged-in name)', () => {
  // Simulate a logged-in user on the browser (what printRo used to read).
  globalThis.CHAT_IDENTITY = { name: 'Kevin (printing)' };
  try {
    const roWrittenByJosh = { service_writer: { name: 'Josh' } };
    // Must be Josh regardless of who is "logged in" — serviceWriterName has no
    // access to CHAT_IDENTITY, which is exactly the guarantee.
    assert.equal(serviceWriterName(roWrittenByJosh), 'Josh');
    // And a writerless RO must NOT fall back to the logged-in name.
    assert.equal(serviceWriterName({ service_writer: null }), '—');
    assert.notEqual(serviceWriterName({ service_writer: null }), 'Kevin (printing)');
  } finally {
    delete globalThis.CHAT_IDENTITY;
  }
});

test('serviceWriterName returns — for a null / writerless / unembedded RO (no throw)', () => {
  assert.equal(serviceWriterName(null), '—');
  assert.equal(serviceWriterName(undefined), '—');
  assert.equal(serviceWriterName({}), '—');                      // e.g. one of the ~30 legacy ROs
  assert.equal(serviceWriterName({ service_writer_id: 'x' }), '—'); // id present but no embed (dormant load)
  assert.equal(serviceWriterName({ service_writer: {} }), '—');
});

test('serviceWriterName tolerates an array-shaped embed', () => {
  assert.equal(serviceWriterName({ service_writer: [{ name: 'Will' }] }), 'Will');
  assert.equal(serviceWriterName({ service_writer: [] }), '—');
});

// ── pre-migration dormancy (42703 / PGRST204) ────────────────
test('isMissingColumn detects the pre-migration errors, ignores unrelated ones', () => {
  assert.ok(isMissingColumn({ code: '42703' }));
  assert.ok(isMissingColumn({ code: 'PGRST204' }));
  assert.ok(isMissingColumn({ message: 'column "service_writer_id" does not exist' }));
  assert.ok(isMissingColumn({ message: "Could not find the 'service_writer_id' column in the schema cache" }));
  assert.ok(!isMissingColumn({ code: '23503', message: 'foreign key violation' }));
  assert.ok(!isMissingColumn(null));
});

test('dormant load path: a base-select RO (no writer embed) prints — without error', () => {
  // What loadRecentList/openRo return after the 42703 fallback: plain columns,
  // no service_writer. Print must degrade to '—', not throw.
  const dormantRo = { id: 'r1', ro_number: 6001, status: 'ro' };
  assert.doesNotThrow(() => serviceWriterName(dormantRo));
  assert.equal(serviceWriterName(dormantRo), '—');
});
