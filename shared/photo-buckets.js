/* ============================================================
   photo-buckets.js — the pure logic behind PER-RO photo buckets.

   THE RULE THIS FILE EXISTS TO ENFORCE: a bucket is a COPY, not a link.
   A repair order is BORN with the shop's standard buckets copied onto it (by
   the `trg_repair_orders_photo_buckets` trigger, not by any JS). After that
   the buckets belong to THAT RO. Renaming or removing a bucket on RO #6032
   changes RO #6032 and nothing else, ever — nothing at runtime reads
   `photo_bucket_templates` again.

   Everything here is pure: no db, no DOM, no window. Both consumers import it —
   my-numbers.html (the tech's grids) and advisor-board.html (the customer
   record) — so the two sides can never disagree about what "No bucket" means
   or which bucket a capture lands in.

   THREE THINGS THAT LOOK LIKE DETAILS AND ARE NOT
   1. REMOVING A BUCKET DOES NOT TOUCH `attachments.bucket_id`. It sets
      `photo_buckets.archived_at`, and `groupPhotosByBucket` renders anything
      pointing at a non-live bucket under "No bucket". That is what makes the
      removal reversible and destroys nothing — un-archive the bucket and every
      photo walks straight back into it. Moving the photos instead (setting
      bucket_id to NULL) would look identical on screen and would permanently
      erase which bucket they had been in.
   2. UNIQUENESS IS CASE-INSENSITIVE AND SCOPED TO ONE RO's LIVE BUCKETS. It
      mirrors the partial unique index `(ro_id, lower(name)) where archived_at
      is null` exactly. Checking it here is a courtesy that produces a readable
      message; the index is what actually guarantees it.
   3. NAMES ARE ENGLISH ONLY, BY DECISION (2026-08-22). They are free-typed by
      the office and shown verbatim to every tech in every language. There is
      no name_es/name_ht. Only the surrounding chrome ("No bucket", "Add
      Photo") is translated.
   4. A "PHOTO" HERE MAY BE A VIDEO. Since 2026-08-27 a tech can shoot a clip
      into the same buckets, stored as the same kind='ro_photo' row and
      distinguished only by the extension on file_path (shared/ro-media.js,
      and ro-photos.md §1d for why there is no 'ro_video' enum value).
      groupPhotosByBucket stamps `isVideo` on the way past so that a render
      site which forgets to branch is still HANDED the flag rather than
      having to go and ask — the one thing standing between a clip and an
      <img src="clip.mov">.
   ============================================================ */

import { isVideoPath } from './ro-media.js';

// A live bucket cap. Not a database constraint — a usability floor. Past a
// dozen the tech's accordion is a scroll and the office's own list stops being
// scannable, and nothing about a single repair order needs more.
export const MAX_LIVE_BUCKETS = 12;

// Longest name we accept. Bucket names are headings on a 96px tile grid and on
// a phone; past this they are not readable anywhere they are displayed.
export const MAX_BUCKET_NAME = 40;

// At or below this the tech sees the ORIGINAL flat layout — one grid per
// bucket, both open, nothing to tap. Above it the grids collapse to an
// accordion with the first bucket open. Two is the standard set, so the
// overwhelmingly common job looks EXACTLY as it did before per-RO buckets
// shipped and the tech has nothing new to learn.
export const TECH_FLAT_MAX = 2;

// The roles that may rename / add / remove a bucket. 'manager' IS the GM —
// that is the value stored in employees.role; there is no 'gm'. Techs are
// absent on purpose: they pick from the buckets already on the RO, never
// create or edit one. 'bookkeeping' is absent because the customer record does
// not exist on the bookkeeping board.
export const BUCKET_MANAGER_ROLES = ['advisor', 'manager', 'owner'];

// Identity resolves ASYNCHRONOUSLY on every office board, so this is called
// once with role === null (nothing shows) and again once OfficeIdentity lands.
// It must therefore be safe to call with null, and the caller must re-render.
export function canManageBuckets(role) {
  return BUCKET_MANAGER_ROLES.indexOf(String(role || '')) !== -1;
}

// Collapse whitespace and trim. Typed on a phone and at a desk, so "Before "
// and "Before  Photos" are the same intent as "Before" / "Before Photos".
export function normalizeBucketName(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

// Is `list` (the RO's buckets) live?
export function liveBuckets(buckets) {
  return (buckets || []).filter((b) => b && b.archived_at == null);
}

// Sort for display and for "which bucket does a capture land in".
// sort_order first, then name, then id — the id tiebreak is what makes the
// order TOTAL, so two buckets added in the same second can never swap places
// between renders and make the UI look like it moved on its own.
export function sortBuckets(buckets) {
  return (buckets || []).slice().sort((a, b) => {
    const sa = a && a.sort_order != null ? a.sort_order : 0;
    const sb = b && b.sort_order != null ? b.sort_order : 0;
    if (sa !== sb) return sa - sb;
    const na = String((a && a.name) || ''), nb = String((b && b.name) || '');
    if (na !== nb) return na.localeCompare(nb);
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  });
}

// Where an office capture lands when nothing else says otherwise: the RO's
// FIRST LIVE bucket by sort order. Deterministic, so the camera never has to
// ask — the RO is already known and so is the answer.
//
// Returns null only when the RO genuinely has no live bucket left (every one
// removed). The caller must handle that as "upload unbucketed", not as an
// error: a photo is never worth losing over a missing category.
export function defaultCaptureBucketId(buckets) {
  const live = sortBuckets(liveBuckets(buckets));
  return live.length ? live[0].id : null;
}

// Where a capture lands when the caller ASKED for a specific bucket — the
// per-bucket [+] on the RO-detail photo card, which files a mid-job photo
// straight into the bucket it was tapped in.
//
// RESOLVED AT WRITE TIME, NEVER AT TAP TIME. The camera can be open for a
// minute while the office removes a bucket on another screen; a requested id
// that is no longer live must not be written, because a photo pointing at a
// bucket that is not on the RO reads as "No bucket" forever and looks like the
// photo went missing. The order is deliberate:
//   1. the requested bucket, if it is still live on THIS RO
//   2. otherwise the RO's default (first live) bucket
//   3. otherwise null — upload unbucketed rather than fail
// Step 2 rather than straight to null because the photo was taken FOR this RO;
// landing it in Before is closer to the intent than landing it nowhere.
//
// `requestedId` of null/undefined means "no preference" and goes straight to
// the default — that is the black Take photo button's path (rule 2).
export function resolveCaptureBucketId(buckets, requestedId) {
  if (requestedId == null || requestedId === '') return defaultCaptureBucketId(buckets);
  const live = liveBuckets(buckets);
  const hit = live.find((b) => b && String(b.id) === String(requestedId));
  return hit ? hit.id : defaultCaptureBucketId(buckets);
}

export function nextSortOrder(buckets) {
  let max = 0;
  (buckets || []).forEach((b) => {
    const s = b && b.sort_order != null ? b.sort_order : 0;
    if (s > max) max = s;
  });
  return max + 1;
}

// Validate a typed name against THIS RO's buckets.
//   { ok: true,  name }            → write this exact (normalized) string
//   { ok: false, reason, message } → show `message`, write nothing
// `selfId` exempts the bucket being renamed, so re-saving a name unchanged, or
// only changing its capitalisation, is allowed rather than "already exists".
export function validateBucketName(raw, opts) {
  const o = opts || {};
  const name = normalizeBucketName(raw);
  if (!name) {
    return { ok: false, reason: 'empty', message: 'Give the bucket a name.' };
  }
  if (name.length > MAX_BUCKET_NAME) {
    return {
      ok: false, reason: 'too-long',
      message: `That name is too long — keep it under ${MAX_BUCKET_NAME} characters.`,
    };
  }
  const selfId = o.selfId == null ? null : String(o.selfId);
  const clash = liveBuckets(o.buckets).some(
    (b) => String(b.id) !== selfId && String(b.name || '').toLowerCase() === name.toLowerCase()
  );
  if (clash) {
    return {
      ok: false, reason: 'duplicate',
      message: `This RO already has a bucket called "${name}".`,
    };
  }
  return { ok: true, name };
}

// May another bucket be added to this RO? Separate from validateBucketName so
// the UI can disable/hide the "+ New bucket" control BEFORE anyone types.
export function canAddBucket(buckets) {
  const n = liveBuckets(buckets).length;
  return n < MAX_LIVE_BUCKETS
    ? { ok: true }
    : {
        ok: false, reason: 'cap',
        message: `${MAX_LIVE_BUCKETS} buckets is the limit on one RO. Remove one you are not using first.`,
      };
}

// Does the tech get the original flat two-grid layout, or the accordion?
export function techLayout(buckets) {
  return liveBuckets(buckets).length > TECH_FLAT_MAX ? 'accordion' : 'flat';
}

export const NO_BUCKET_LABEL = 'No bucket';

/* Group one RO's photos for display.

   A photo lands in the "No bucket" group when its bucket_id is NULL, when the
   bucket was REMOVED (archived), or when it points at a bucket that is not on
   this RO at all. That last case should be impossible after the migration —
   the verification query counts it — but grouping it here means a stray row
   shows up somewhere visible instead of vanishing from the record.

   "No bucket" always sorts LAST and is only emitted when it has photos, so an
   RO where everything is filed never grows an empty group.

   `opts.includeEmpty` emits every live bucket even with zero photos — that is
   what the tech's grids and the office's manageable list need (you cannot put
   a photo INTO a bucket that does not render), while the read-only case wants
   only groups that have something in them.

   EVERY PHOTO COMES OUT WITH `isVideo` STAMPED ON IT, derived from file_path.
   Grouping is otherwise completely blind to media type — a clip files,
   moves, archives and lands in "No bucket" exactly as a photo does. The
   stamp is a SHALLOW COPY, never a mutation of the caller's object: this
   module is pure, and the boards own those arrays. */
export function groupPhotosByBucket(photos, buckets, opts) {
  const o = opts || {};
  const live = sortBuckets(liveBuckets(buckets));
  const liveById = new Map(live.map((b) => [String(b.id), b]));

  const groups = live.map((b) => ({
    id: String(b.id), name: String(b.name || ''), bucket: b, isNoBucket: false, photos: [],
  }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const none = { id: null, name: NO_BUCKET_LABEL, bucket: null, isNoBucket: true, photos: [] };

  (photos || []).forEach((p) => {
    if (!p) return;
    const key = p.bucket_id != null ? String(p.bucket_id) : null;
    const g = key && liveById.has(key) ? byId.get(key) : none;
    g.photos.push({ ...p, isVideo: isVideoPath(p.file_path) });
  });

  const out = o.includeEmpty ? groups : groups.filter((g) => g.photos.length);
  if (none.photos.length) out.push(none);
  return out;
}

// Total photos across every group — the count the vehicle header shows.
export function totalPhotos(groups) {
  return (groups || []).reduce((n, g) => n + ((g && g.photos) ? g.photos.length : 0), 0);
}

/* Where may THIS photo be moved to? The RO's live buckets minus the one it is
   already in, plus "No bucket" when it is currently in a bucket.

   SAME RO ONLY. There is deliberately no parameter here that could name
   another RO: moving a photo across repair orders (or customers) is exactly
   the silent-misfiling failure this subsystem is built to avoid, and the way
   to make it impossible is to give the code no way to express it. */
export function moveTargets(photo, buckets) {
  const cur = photo && photo.bucket_id != null ? String(photo.bucket_id) : null;
  const targets = sortBuckets(liveBuckets(buckets))
    .filter((b) => String(b.id) !== cur)
    .map((b) => ({ id: String(b.id), name: String(b.name || '') }));
  if (cur) targets.push({ id: null, name: NO_BUCKET_LABEL });
  return targets;
}
