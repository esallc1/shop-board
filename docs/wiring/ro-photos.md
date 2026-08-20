# How RO photos are wired

> Doc: `/docs/wiring/ro-photos.md`
> Last updated: 2026-08-20 — created for slice 2 (archive + provenance). Verified vs the
> `feat/photo-archive` branch off `staging` (`4a23cf9`).
> Status: 🟡 **slice 1 LIVE on staging, slice 2 built and unmerged.** Neither is on prod: prod's
> database has none of `photo_buckets`, the `ro_photo` enum value, `attachments.bucket_id`, or
> slice 2's three columns. Prod code is `e90bf01`.
> Related: [[my-numbers]], [[customer-record]], [[hosting-domains]] §5.5, [[recordings-audio]].

## 0. In one line
A tech shoots photos of a job on their phone; they attach to the **repair order**, sort into
buckets the shop names itself, and show on the customer record under that vehicle's RO.

## 1. Where the data lives
Everything hangs off the existing `attachments` table — no new photo table.

| Column | Meaning for a photo |
|---|---|
| `entity_type` / `entity_id` | always `'repair_order'` + the RO's id |
| `kind` | `'ro_photo'` (added to the `attachment_kind` enum) |
| `file_path` | object key in the **private** `crisdata-attachments` bucket |
| `bucket_id` | → `photo_buckets.id`. **NULL is a real state: "No bucket"** |
| `uploaded_by` | display NAME of whoever shot it. NULL on everything before slice 2 |
| `deleted_at` / `deleted_by` | tombstone — archived, see §4 |
| `created_at` | server-set; the date shown under each thumbnail |

`photo_buckets` is the shop-named category list: `id, name, sort_order, archived_at, created_at`.
Modelled on `expense_categories`. **Name uniqueness is scoped to ACTIVE buckets** via a partial
unique index (`where archived_at is null`) — a plain `unique` would burn a name forever, so
archiving "Before" and later wanting "Before" back would have been impossible.

**No new storage bucket.** Photos reuse `crisdata-attachments` at
`repair_order/<ro_id>/photos/<ts>-<rand>.<ext>`, mirroring the diagnosis-audio path beside them.
A new bucket would have meant a manual dashboard step on both projects ([[hosting-domains]] §5.5).

## 2. Why the grids are on the RO screen, not the job screen
The photo grids used to live on My Numbers' **shopboard job** detail — where they were fake:
data URLs in an in-memory array, never uploaded, gone on reload. They could not become real
there. A shopboard row (`sbRowToJob`) carries no `repair_orders.id` and no link to one beyond
free-typed `po` text, and resolving an RO by matching that text is the same failure shape as the
call-attach ambiguity — filing something onto the wrong record silently, with no error.

So the grids moved to the **RO diagnosis screen** (`roDiag`), which already holds a real RO id
and already hosts the diagnosis voice clips. The fake grids were deleted rather than left
looking real. Consequence to know: **a shopboard job with no CrisData RO has no photo capture.**
That is the design working, not a gap.

## 3. Capture (My Numbers)
`<input type="file" accept="image/*" capture="environment">` → downscale → upload → row.

- **Compression** (`shared/photo-compress.js`): 1600px long edge, JPEG q0.8, always re-encoded
  to JPEG. A 12MP iPhone capture drops ~6× in pixels; 3–5 MB lands at ~200–400 KB. A 20-photo
  job goes from ~80 MB over shop wifi to ~6 MB. Two guards upload the ORIGINAL rather than lose
  a photo: an undecodable file, and a re-encode that came out bigger.
- **EXIF orientation** is handled by decoding through an `<img>`, not `createImageBitmap`.
  Browsers default to `image-orientation: from-image`, so the decode is upright and
  `naturalWidth/Height` are already oriented. `createImageBitmap`'s `imageOrientation` option is
  silently IGNORED where unsupported — a sideways image with no error, on Safari, the browser
  techs actually use. The `<img>` path fails safe.
- **Input-reset ordering is load-bearing.** `await` the upload, THEN `e.target.value = ''`.
  Resetting mid-flight can invalidate a camera-captured File's bytes on some mobile browsers —
  the File still looks valid but Storage receives no content. Copied from Capture Invoice.
- **Bucket is implied by which grid was tapped**, resolved by NAME against `photo_buckets where
  archived_at is null`. A renamed or archived bucket stops matching and the photo lands
  unbucketed rather than failing or guessing.
- Works inside the gm-board `?as=` iframe (verified on a phone 2026-08-19).

## 4. Archive — a tombstone, never a delete
Removing a photo sets `deleted_at` + `deleted_by`. **The row stays and the storage object
stays.** Shape copied exactly from chat's tombstone (`chat_messages.deleted_at/deleted_by`).

**Every reader must filter `deleted_at is null`.** There are FOUR, and missing one silently
resurrects archived photos:

| Reader | What it reads |
|---|---|
| `advisor-board.html` customer record | `ro_photo` for all of a customer's ROs |
| `advisor-board.html` RO card | `diagnosis_audio` for one RO |
| `my-numbers.html` `loadRoPhotos` | `ro_photo` for one RO |
| `my-numbers.html` `loadRoClips` | `diagnosis_audio` for one RO |

**Who may archive:** whoever took it, plus the office on the customer record. Enforced in the
UI, not in RLS — `attachments` carries table-level `for all` for both roles, and My Numbers
authenticates by PIN against `employees`, not a Supabase Auth session, so the database has no
identity to enforce against. Same app-level posture as every other permission here.

**Ownerless rows.** `uploaded_by IS NULL` (everything shot before slice 2) means nobody can
prove they took it, so **no tech can archive it** — letting any tech remove it would let one
tech delete another's work on a technicality. The office still can, from the customer record.
That is the cleanup path for those rows.

⚠ **Archive is not erasure.** The object is still in the bucket and still signable by anyone who
can read the row. Fine for a blurry frame; **not sufficient for a photo of the wrong customer's
vehicle.** Hard purge is deferred and needs a delete policy on `crisdata-attachments`, which
today has none — see §6.

## 5. Display (customer record)
Under each vehicle's RO: thumbnails grouped by bucket — bucket name, count, tiles, click to
enlarge (lightbox). Each tile carries `Aug 10, 8:41 · Manny` beneath it; a photo with no
`uploaded_by` shows the date alone rather than "· Unknown", because nobody was recorded, which
is not the same as an unknown person.

Buckets are loaded here **without** the `archived_at` filter, deliberately — My Numbers filters
to live buckets (you must not file INTO a retired one), but the record must still resolve the
NAME of an archived bucket or history silently degrades to "No bucket" the day one is retired.
`bucket_id` NULL renders as its own "No bucket" group, sorted last.

Reads are one batched `.in()` over the customer's ROs and ONE `createSignedUrls` for the whole
customer. Tile clicks are delegated from `#custVehicles` because the accordion re-renders
constantly and per-tile listeners would leak.

## Known gaps & open questions (as of 2026-08-20)
- **⚠ Storage deletes have been silently failing since July — see §6.** Not caused by this
  subsystem, but this is where the trail leads.
- **No hard purge.** Archive hides; it does not erase. Wrong-customer photos need purge.
- **No captions/labels.** `attachments` has no caption column. `marketing_content.caption` is
  the precedent if we add one; the hard part is WHERE a tech enters it without slowing capture.
- **The grid is unbounded vertically.** `.cust-photo-grid` has no `max-height`/`overflow`, so
  60 photos on one RO push the calls timeline a screen further down.
- **The photo read is unbounded** (`.in('entity_id', roIds)` with no `.limit()`) — the README's
  1000-row hazard. A display list, so the lesser category, but real.
- **No bucket CRUD.** Rename/add/remove is seed-only today; the partial unique index already
  supports archive-and-reuse when that ships.
- **`uploaded_by` is a NAME, not an id** (mirroring `marketing_content.captured_by`). It
  survives an employee being renamed or deactivated, but it does not follow a rename.

## 6. ⚠ FINDING (2026-08-20): storage deletes have never worked
**`crisdata-attachments` has NO delete policy for `anon` or `authenticated`** — confirmed across
every migration. Yet two shipped features have been calling `remove()` on it since July, and
both swallow the failure:

- `my-numbers.html:2044` — `deleteClip`, the diagnosis voice-note delete
- `shared/team-chat.js:1881` — chat attachment delete (its own comment calls it "best-effort ...
  never blocks the tombstone")

Neither can succeed. **The row goes; the bytes stay, forever.** Every deleted voice note and
chat attachment since July has left an orphaned object in the bucket. Nobody noticed because the
UI shows the correct thing afterwards.

Three consequences worth holding together:
1. There is an **unknown-size backlog of orphaned objects** in `crisdata-attachments` that
   nothing accounts for and nothing can currently remove.
2. RO-photo archive was designed as a tombstone anyway, so it is **not affected** — but it means
   "delete the file" is not available to any future slice without a policy change.
3. Adding that delete policy would **change the behaviour of chat and clip deletes** from
   "silently orphan" to "actually destroy". That is arguably the fix, but it is a behaviour
   change to two other subsystems and must be a deliberate decision, not a side-effect of a
   photo feature.

Not fixed here on purpose — logged so the next person hits the note instead of the bug.

## Where it lives in the code
- Schema: `migrations/20260819_photo_buckets.sql` (slice 1), `migrations/20260820_photo_archive.sql` (slice 2).
- Storage layout: `migrations/20260819_storage_buckets.sql`, [[hosting-domains]] §5.5.
- Compression + EXIF: `shared/photo-compress.js` (+ `.test.js`).
- Capture, buckets, archive: `my-numbers.html` (`loadPhotoBuckets`, `loadRoPhotos`,
  `uploadRoPhoto`, `archiveRoPhoto`, `canArchivePhoto`, `roPhotoGridHtml`).
- Display: `advisor-board.html` (`custPhotoGroups`, `roPhotosHtml`, `photoMetaLine`,
  `archiveCustPhoto`, the `#custVehicles` delegated listener).

## Session change log
- 2026-08-20 — **Slice 2 built** (unmerged): archive-as-tombstone (`deleted_at`/`deleted_by`,
  chat's shape), `uploaded_by` captured at upload — My Numbers had the tech's name all along and
  was discarding it — and the date · name byline on the customer record. All FOUR readers
  filtered, including `loadRoClips`, which the original three-site estimate missed. Logged §6:
  storage deletes in chat and diagnosis clips have been failing silently since July.
- 2026-08-19 — **Slice 1 shipped to staging** (`4a23cf9`): schema + buckets, real upload from My
  Numbers with compression and EXIF, customer-record display. Grids moved off the shopboard job
  screen (no RO id there) and the fake local-only grids deleted. Doc created 2026-08-20.
