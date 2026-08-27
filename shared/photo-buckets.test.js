/* ============================================================
   photo-buckets.test.js — unit tests for PER-RO photo buckets.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LIVE_BUCKETS, MAX_BUCKET_NAME, TECH_FLAT_MAX, NO_BUCKET_LABEL,
  BUCKET_MANAGER_ROLES, canManageBuckets, normalizeBucketName, liveBuckets,
  sortBuckets, defaultCaptureBucketId, nextSortOrder, validateBucketName,
  canAddBucket, techLayout, groupPhotosByBucket, totalPhotos, moveTargets,
  resolveCaptureBucketId,
} from './photo-buckets.js';

const B = (id, name, sort, archived) => ({ id, name, sort_order: sort, archived_at: archived || null });
const P = (id, bucketId) => ({ id, bucket_id: bucketId == null ? null : bucketId });

// ── who may manage buckets ────────────────────────────────────
test('office roles may manage buckets; techs and bookkeeping may not', () => {
  assert.equal(canManageBuckets('advisor'), true);
  assert.equal(canManageBuckets('manager'), true);   // GM — the stored value is 'manager', never 'gm'
  assert.equal(canManageBuckets('owner'), true);
  assert.equal(canManageBuckets('tech'), false);
  assert.equal(canManageBuckets('bookkeeping'), false);
  assert.equal(canManageBuckets('gm'), false);       // not a real role value
});

test('canManageBuckets is SAFE on an unresolved identity — never throws, never grants', () => {
  // Identity resolves asynchronously, so this is genuinely called with null on
  // first render. It must return false rather than explode, and the board must
  // re-render once OfficeIdentity lands.
  assert.equal(canManageBuckets(null), false);
  assert.equal(canManageBuckets(undefined), false);
  assert.equal(canManageBuckets(''), false);
  assert.deepEqual(BUCKET_MANAGER_ROLES, ['advisor', 'manager', 'owner']);
});

// ── name normalisation ────────────────────────────────────────
test('names are trimmed and inner whitespace collapsed', () => {
  assert.equal(normalizeBucketName('  Before  '), 'Before');
  assert.equal(normalizeBucketName('Part /  Repair'), 'Part / Repair');
  assert.equal(normalizeBucketName('\tTeardown\nfindings '), 'Teardown findings');
  assert.equal(normalizeBucketName(null), '');
  assert.equal(normalizeBucketName(undefined), '');
});

// ── validation ────────────────────────────────────────────────
test('an empty or whitespace-only name is refused', () => {
  assert.equal(validateBucketName('', { buckets: [] }).ok, false);
  assert.equal(validateBucketName('   ', { buckets: [] }).reason, 'empty');
});

test('a name longer than MAX_BUCKET_NAME is refused, one character under is accepted', () => {
  const ok = validateBucketName('x'.repeat(MAX_BUCKET_NAME), { buckets: [] });
  assert.equal(ok.ok, true);
  const bad = validateBucketName('x'.repeat(MAX_BUCKET_NAME + 1), { buckets: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'too-long');
});

test('duplicates are refused CASE-INSENSITIVELY — mirrors the (ro_id, lower(name)) index', () => {
  const buckets = [B('1', 'Before', 1)];
  assert.equal(validateBucketName('before', { buckets }).ok, false);
  assert.equal(validateBucketName('BEFORE', { buckets }).reason, 'duplicate');
  assert.equal(validateBucketName('  Before  ', { buckets }).ok, false, 'normalised first, then compared');
  assert.equal(validateBucketName('After', { buckets }).ok, true);
});

test('an ARCHIVED bucket does not block the name — removing "Before" and adding it back works', () => {
  // This is the whole point of scoping uniqueness to `archived_at is null`.
  const buckets = [B('1', 'Before', 1, '2026-08-22T10:00:00Z')];
  const out = validateBucketName('Before', { buckets });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'Before');
});

test('renaming a bucket to its own name (or only its capitalisation) is allowed via selfId', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  assert.equal(validateBucketName('Before', { buckets, selfId: '1' }).ok, true);
  assert.equal(validateBucketName('BEFORE', { buckets, selfId: '1' }).ok, true);
  // ...but not to a name a DIFFERENT live bucket already holds.
  assert.equal(validateBucketName('Part / Repair', { buckets, selfId: '1' }).ok, false);
});

test('validateBucketName returns the NORMALISED name to write, not the raw input', () => {
  const out = validateBucketName('  Teardown   findings ', { buckets: [] });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'Teardown findings');
});

// ── the cap ───────────────────────────────────────────────────
test('the live-bucket cap counts LIVE buckets only — archived ones never block an add', () => {
  const live = Array.from({ length: MAX_LIVE_BUCKETS }, (_, i) => B(String(i), 'B' + i, i));
  assert.equal(canAddBucket(live).ok, false);
  assert.equal(canAddBucket(live).reason, 'cap');
  assert.equal(canAddBucket(live.slice(0, MAX_LIVE_BUCKETS - 1)).ok, true);

  const archived = live.map((b) => ({ ...b, archived_at: '2026-08-22T10:00:00Z' }));
  assert.equal(canAddBucket(archived).ok, true, 'twelve REMOVED buckets must not lock the RO out');
});

// ── ordering ──────────────────────────────────────────────────
test('sortBuckets orders by sort_order, then name, then id — a TOTAL order', () => {
  const out = sortBuckets([B('c', 'Zeta', 2), B('a', 'Alpha', 1), B('b', 'Alpha', 2)]);
  assert.deepEqual(out.map((b) => b.id), ['a', 'b', 'c']);
});

test('two buckets with identical sort_order AND name still order deterministically (id tiebreak)', () => {
  const one = sortBuckets([B('y', 'Same', 5), B('x', 'Same', 5)]).map((b) => b.id);
  const two = sortBuckets([B('x', 'Same', 5), B('y', 'Same', 5)]).map((b) => b.id);
  assert.deepEqual(one, two, 'render order must not depend on the order rows came back');
});

test('nextSortOrder is max + 1, and 1 for an RO with no buckets', () => {
  assert.equal(nextSortOrder([]), 1);
  assert.equal(nextSortOrder([B('1', 'A', 1), B('2', 'B', 7)]), 8);
  // Archived buckets still count: reusing their slot would interleave a new
  // bucket into the middle of the list the day one is restored.
  assert.equal(nextSortOrder([B('1', 'A', 1), B('2', 'B', 9, 'x')]), 10);
});

// ── where a capture lands ─────────────────────────────────────
test('an office capture lands in the FIRST LIVE bucket by sort order — it never asks', () => {
  const buckets = [B('2', 'Part / Repair', 2), B('1', 'Before', 1)];
  assert.equal(defaultCaptureBucketId(buckets), '1');
});

test('a removed first bucket hands the default to the next live one', () => {
  const buckets = [B('1', 'Before', 1, '2026-08-22T10:00:00Z'), B('2', 'Part / Repair', 2)];
  assert.equal(defaultCaptureBucketId(buckets), '2');
});

test('an RO with every bucket removed yields null — upload UNBUCKETED, never fail', () => {
  assert.equal(defaultCaptureBucketId([B('1', 'Before', 1, 'x')]), null);
  assert.equal(defaultCaptureBucketId([]), null);
});

// ── the tech's layout ─────────────────────────────────────────
test('two buckets keep the ORIGINAL flat layout; three or more collapse to an accordion', () => {
  assert.equal(techLayout([B('1', 'a', 1), B('2', 'b', 2)]), 'flat');
  assert.equal(techLayout([B('1', 'a', 1), B('2', 'b', 2), B('3', 'c', 3)]), 'accordion');
  assert.equal(TECH_FLAT_MAX, 2);
});

test('archived buckets do not push the tech into the accordion', () => {
  const buckets = [B('1', 'a', 1), B('2', 'b', 2), B('3', 'c', 3, '2026-08-22T10:00:00Z')];
  assert.equal(techLayout(buckets), 'flat');
});

// ── grouping ──────────────────────────────────────────────────
test('photos group into their bucket, in bucket sort order', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  const photos = [P('p1', '2'), P('p2', '1'), P('p3', '1')];
  const groups = groupPhotosByBucket(photos, buckets);
  assert.deepEqual(groups.map((g) => g.name), ['Before', 'Part / Repair']);
  assert.deepEqual(groups[0].photos.map((p) => p.id), ['p2', 'p3']);
  assert.deepEqual(groups[1].photos.map((p) => p.id), ['p1']);
});

test('bucket_id NULL renders as "No bucket", and it sorts LAST', () => {
  const buckets = [B('1', 'Before', 1)];
  const groups = groupPhotosByBucket([P('p1', null), P('p2', '1')], buckets);
  assert.deepEqual(groups.map((g) => g.name), ['Before', NO_BUCKET_LABEL]);
  assert.equal(groups[1].isNoBucket, true);
});

test('REMOVING a bucket shows its photos under "No bucket" — bucket_id is untouched', () => {
  // The photos still carry bucket_id '1'. Nothing was written to attachments.
  const photos = [P('p1', '1'), P('p2', '1')];
  const live = [B('1', 'Teardown', 1), B('2', 'Before', 2)];
  assert.equal(groupPhotosByBucket(photos, live)[0].name, 'Teardown');

  const afterRemoval = [B('1', 'Teardown', 1, '2026-08-22T10:00:00Z'), B('2', 'Before', 2)];
  const groups = groupPhotosByBucket(photos, afterRemoval);
  assert.deepEqual(groups.map((g) => g.name), [NO_BUCKET_LABEL]);
  assert.equal(groups[0].photos.length, 2);
  assert.deepEqual(photos.map((p) => p.bucket_id), ['1', '1'], 'attachments.bucket_id NEVER written');
});

test('un-removing the bucket walks every photo straight back into it', () => {
  const photos = [P('p1', '1'), P('p2', '1')];
  const restored = [B('1', 'Teardown', 1, null)];
  const groups = groupPhotosByBucket(photos, restored);
  assert.deepEqual(groups.map((g) => g.name), ['Teardown']);
  assert.equal(groups[0].photos.length, 2);
});

test('a photo pointing at a bucket that is not on this RO shows under "No bucket", never vanishes', () => {
  const groups = groupPhotosByBucket([P('p1', 'some-other-ros-bucket')], [B('1', 'Before', 1)]);
  assert.deepEqual(groups.map((g) => g.name), [NO_BUCKET_LABEL]);
  assert.equal(groups[0].photos.length, 1);
});

test('empty groups are omitted by default and emitted with includeEmpty', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  assert.equal(groupPhotosByBucket([P('p1', '1')], buckets).length, 1);
  const all = groupPhotosByBucket([P('p1', '1')], buckets, { includeEmpty: true });
  assert.deepEqual(all.map((g) => g.name), ['Before', 'Part / Repair']);
  assert.equal(all[1].photos.length, 0);
});

test('includeEmpty never invents an empty "No bucket" group', () => {
  const all = groupPhotosByBucket([P('p1', '1')], [B('1', 'Before', 1)], { includeEmpty: true });
  assert.equal(all.some((g) => g.isNoBucket), false);
});

test('an RO with no photos at all yields no groups (read-only) but every bucket (manageable)', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  assert.equal(groupPhotosByBucket([], buckets).length, 0);
  assert.equal(groupPhotosByBucket([], buckets, { includeEmpty: true }).length, 2);
});

test('totalPhotos counts across every group including No bucket', () => {
  const groups = groupPhotosByBucket([P('a', '1'), P('b', null), P('c', '1')], [B('1', 'Before', 1)]);
  assert.equal(totalPhotos(groups), 3);
  assert.equal(totalPhotos([]), 0);
});

// ── moving a photo ────────────────────────────────────────────
test('move targets are the RO\'s other live buckets plus "No bucket"', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2), B('3', 'After', 3)];
  const targets = moveTargets(P('p1', '1'), buckets);
  assert.deepEqual(targets.map((t) => t.name), ['Part / Repair', 'After', NO_BUCKET_LABEL]);
  assert.equal(targets[targets.length - 1].id, null);
});

test('a photo is never offered the bucket it is already in', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  assert.equal(moveTargets(P('p1', '2'), buckets).some((t) => t.id === '2'), false);
});

test('an UNBUCKETED photo is offered every live bucket and NOT "No bucket" again', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  const targets = moveTargets(P('p1', null), buckets);
  assert.deepEqual(targets.map((t) => t.name), ['Before', 'Part / Repair']);
  assert.equal(targets.some((t) => t.id === null), false, 'moving No bucket -> No bucket is not an option');
});

test('REMOVED buckets are never a move target', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Gone', 2, '2026-08-22T10:00:00Z')];
  assert.equal(moveTargets(P('p1', null), buckets).some((t) => t.name === 'Gone'), false);
});

test('Cris\'s case: eight in Before, three belong in Part / Repair — same RO, one at a time', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  const photos = Array.from({ length: 8 }, (_, i) => P('p' + i, '1'));
  // Each of the three offers "Part / Repair" as a target...
  [5, 6, 7].forEach((i) => {
    assert.equal(moveTargets(photos[i], buckets).some((t) => t.id === '2'), true);
    photos[i].bucket_id = '2';                      // ...the write the UI performs
  });
  const groups = groupPhotosByBucket(photos, buckets);
  assert.deepEqual(groups.map((g) => [g.name, g.photos.length]), [['Before', 5], ['Part / Repair', 3]]);
});

test('there is NO way to express a cross-RO move — moveTargets only ever sees one RO\'s buckets', () => {
  // The guarantee is structural: the function takes the photo and THIS RO's
  // buckets, and returns ids drawn only from that list. A caller holding
  // another RO's buckets is a different bug, not a reachable option here.
  const roA = [B('a1', 'Before', 1)];
  const targets = moveTargets(P('p1', null), roA);
  assert.deepEqual(targets.map((t) => t.id), ['a1']);
});

// ── resolveCaptureBucketId — where a REQUESTED capture lands ───
// The per-bucket [+] on the RO-detail photo card asks for one specific bucket.
// The answer is resolved when the photo is WRITTEN, not when the [+] was
// tapped, because the camera can be open for a minute while the office edits
// buckets on another screen.
test('a requested bucket that is still live is honoured', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2)];
  assert.equal(resolveCaptureBucketId(buckets, '2'), '2');
});

test('no preference (the black Take photo button) lands in the FIRST live bucket', () => {
  const buckets = [B('2', 'Part / Repair', 2), B('1', 'Before', 1)];
  assert.equal(resolveCaptureBucketId(buckets, null), '1');
  assert.equal(resolveCaptureBucketId(buckets, undefined), '1');
  assert.equal(resolveCaptureBucketId(buckets, ''), '1');
});

test('a bucket REMOVED while the camera was open falls back to the default, never to the dead id', () => {
  const buckets = [B('1', 'Before', 1), B('2', 'Part / Repair', 2, '2026-08-25T10:00:00Z')];
  assert.equal(resolveCaptureBucketId(buckets, '2'), '1',
    'writing the archived id would render as "No bucket" forever and read as a lost photo');
});

test('a requested bucket belonging to ANOTHER RO is never written', () => {
  // The caller only ever holds one RO's buckets, but the resolver must not
  // trust the id either: an unknown id resolves to this RO's default.
  const buckets = [B('1', 'Before', 1)];
  assert.equal(resolveCaptureBucketId(buckets, 'some-other-ros-bucket'), '1');
});

test('an RO with every bucket removed captures UNBUCKETED rather than failing', () => {
  const buckets = [B('1', 'Before', 1, '2026-08-25T10:00:00Z')];
  assert.equal(resolveCaptureBucketId(buckets, '1'), null);
  assert.equal(resolveCaptureBucketId(buckets, null), null);
  assert.equal(resolveCaptureBucketId([], null), null);
});

test('ids are compared as STRINGS — a numeric id and its text form are the same bucket', () => {
  const buckets = [B(7, 'Before', 1)];
  assert.equal(resolveCaptureBucketId(buckets, '7'), 7);
});

// ── media type never changes how grouping behaves ─────────────
test('GROUPING IS BLIND TO MEDIA TYPE — a video files, and lands in "No bucket", exactly like a photo', () => {
  // The guard against someone later "helpfully" segregating clips into
  // their own group. A bucket is a bucket: the tech shot both for the same
  // job, and splitting them would break the chronology the buckets exist to
  // carry (Before -> Part / Repair is the story of the job).
  const buckets = [B('b1', 'Before', 1), B('b2', 'Teardown', 2, '2026-08-27T00:00:00Z')];
  const photos = [
    { id: 'p1', bucket_id: 'b1', file_path: 'repair_order/r/photos/1-a.jpg' },
    { id: 'v1', bucket_id: 'b1', file_path: 'repair_order/r/photos/2-a-42s.mp4' },
    { id: 'v2', bucket_id: 'b2', file_path: 'repair_order/r/photos/3-a.mov' },  // REMOVED bucket
    { id: 'v3', bucket_id: null, file_path: 'repair_order/r/photos/4-a.mp4' },
  ];
  const groups = groupPhotosByBucket(photos, buckets);
  assert.deepEqual(groups.map(g => g.name), ['Before', NO_BUCKET_LABEL]);
  assert.deepEqual(groups[0].photos.map(p => p.id), ['p1', 'v1']);
  // A clip in a removed bucket drops to "No bucket" like any photo would,
  // and un-archiving the bucket walks it straight back in.
  assert.deepEqual(groups[1].photos.map(p => p.id), ['v2', 'v3']);
  assert.equal(totalPhotos(groups), 4);
});

test('isVideo is STAMPED from file_path, and the caller\'s objects are not mutated', () => {
  const buckets = [B('b1', 'Before', 1)];
  const photos = [
    { id: 'p1', bucket_id: 'b1', file_path: 'repair_order/r/photos/1-a.jpg' },
    { id: 'v1', bucket_id: 'b1', file_path: 'repair_order/r/photos/2-a.MOV' },
    { id: 'x1', bucket_id: 'b1', file_path: 'repair_order/r/photos/3-a' },      // no extension
  ];
  const out = groupPhotosByBucket(photos, buckets)[0].photos;
  assert.deepEqual(out.map(p => p.isVideo), [false, true, false]);
  // Unknown extension is a PHOTO — a broken <img> is visible, a <video>
  // pointed at image bytes is a silently dead black tile.
  assert.equal(out[2].isVideo, false);
  // Purity: the board owns these arrays and re-uses them across renders.
  assert.equal('isVideo' in photos[0], false);
  assert.equal('isVideo' in photos[1], false);
});

test('a moved video is offered the same targets as a moved photo', () => {
  const buckets = [B('b1', 'Before', 1), B('b2', 'Part / Repair', 2)];
  const clip = { id: 'v1', bucket_id: 'b1', file_path: 'repair_order/r/photos/1-a.mp4' };
  assert.deepEqual(moveTargets(clip, buckets).map(t => t.name), ['Part / Repair', NO_BUCKET_LABEL]);
});
