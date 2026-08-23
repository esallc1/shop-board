# How RO photos are wired

> Doc: `/docs/wiring/ro-photos.md`
> Last updated: 2026-08-23 — **slice 3 is LIVE ON PROD.** Verified vs commit `484a3e0`.
> Status: 🟢 **ALL THREE SLICES LIVE ON PROD.**
> • Slices 1 + 2 — code `ae4510b`, migrations run by hand on prod **2026-08-20**.
> • Slice 3 — code `484a3e0` deployed to prod **2026-08-23** (byte-verified on www),
>   then `migrations/20260822_photo_buckets_per_ro_PROD.sql` run by hand, block by block,
>   on `PROD — KiKi hygemiszxwmyrkmhbjub`. Blocks 00 · 0 · A · B1 · C · B2 · B3 · B4 · B5
>   all clean; block D's **13 checks all pass**. Numbers: **ros 66 · templates 2 ·
>   buckets created 132 · photos repointed 4 · globals deleted 2 · `ro_id` NOT NULL locked
>   in.** Buckets confirmed rendering on prod on an iPhone the same night.
> ⚠ **Block E is still open** — it proves the trigger on the next real RO the shop creates.
> Sandbox (`efhmefpaijjncwgbvwki`) still carries the slice-3 test data (renamed buckets,
> test photos, two ROs assigned to `ZZ Test Tech`) — left in place on purpose.
> Related: [[my-numbers]], [[customer-record]], [[hosting-domains]] §5.5, [[recordings-audio]],
> [[staging-db]] §8.

## 0. In one line
A tech shoots photos of a job on their phone — and the office can shoot one too, from the
customer record. They attach to the **repair order**, sort into **buckets that belong to that
one RO**, and show on the customer record under that vehicle's RO, where the office renames,
adds and removes those buckets and moves photos between them.

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

### 1a. Buckets belong to ONE repair order

`photo_buckets` is `id, ro_id, name, sort_order, archived_at, archived_by, created_at`.

**`ro_id` is NOT NULL.** That is the schema saying the thing the feature is about: a bucket
cannot exist without a repair order. It was a shop-wide list until 2026-08-22 and is not one any
more.

| | |
|---|---|
| `ro_id` | the RO this bucket belongs to. `on delete cascade` — a bucket never outlives its RO |
| `archived_at` / `archived_by` | **removed**. The row stays; the bucket stops being offered |
| unique index | `(ro_id, lower(name)) where archived_at is null` |

**A bucket is a COPY, not a link.** A new RO is *born* with the shop's standard buckets copied
onto it (§1b). After that nothing on the RO reaches back to a shared list — renaming or removing
"Before" on RO #6032 changes RO #6032 and nothing else, ever. The same reasoning as the byline
stamps: `uploaded_by` records a NAME, not an employee id, because a historical record should not
change when the thing it was copied from does.

**Uniqueness is per RO, scoped to LIVE buckets, and case-insensitive.** Per-RO because the whole
point is that fifty repair orders each have their own "Before". Scoped to `archived_at is null`
for the slice-1 reason — a plain unique burns a name forever, so removing "Before" and later
wanting it back would be impossible. Case-insensitive because names are **free-typed** now, and
`lower(name)` is what stops one RO carrying "Before", "before" and "Befor".

### 1b. `photo_bucket_templates` — the standard set, read once

`photo_bucket_templates` (`id, name, sort_order, created_at`, unique on `lower(name)`) is the
only shop-wide list left. It holds the two names the shop has always used — **Before** and
**Part / Repair** — and it is read **exactly once per RO, by a trigger, at creation.**

It is a **separate table on purpose**, rather than template rows living in `photo_buckets` with
a null `ro_id`. Two reasons, and the second is the real one:

1. It lets `photo_buckets.ro_id` be `NOT NULL`, which makes an RO-less bucket unrepresentable
   instead of merely discouraged.
2. Sharing the table would mean every reader had to remember `.eq('ro_id', roId)` or the
   templates would leak onto every RO's picker. This subsystem has already been bitten twice by
   exactly that shape — the four readers that must filter `deleted_at` (§4), and the
   `CHAT_IDENTITY` guard ([[office-auth]] §1b). A rule enforced by a schema beats a rule
   enforced by everyone remembering.

### 1c. Born with buckets — a DB trigger, not `mintRo`

`trg_repair_orders_photo_buckets` is an `after insert` row trigger on `repair_orders` that runs
`copy_photo_bucket_templates()` — one `insert … select` from the templates. **`mintRo` was not
changed and does not know this happens.**

The trigger, not the wizard, for three reasons:

1. **Atomicity.** `mintRo` already carries a resilient-insert retry that drops
   `service_writer_id` and re-inserts ([advisor-board.html](../../advisor-board.html) `mintRo`).
   A second, separate write after it can fail while the RO succeeds — leaving a bucketless RO
   while the wizard cheerfully says "RO #6041 created".
2. **Coverage.** A repo sweep on 2026-08-22 found **exactly one** application path that creates
   a repair order: `mintRo`. Comebacks (`parent_ro_id` set), the legacy 5xxx PO override, and
   the Desk's "open the customer" all route *through* it; no `api/*.js` route, no `.rpc()`, and
   no migration inserts an RO. That is true today. The trigger keeps it true for hand-run SQL
   and for whatever path gets added next, without anyone having to remember.
3. It runs as the **invoker**, not `security definer` — both `anon` and `authenticated` already
   hold full-access policies on both tables, so the trigger grants nobody anything new.

**An RO with no live buckets is a real, handled state**, not a broken one: the office can remove
every bucket. Both screens fall back to a single "No bucket" grid that still accepts a photo
(§3, §5a). A photo is never worth losing over a missing category.

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
- **Bucket is implied by which grid was tapped, and resolved by ID** — never by name.
  Per-RO there are as many rows named "Before" as there are repair orders, so a name lookup
  would pick an arbitrary one and file the photo onto **somebody else's RO**. That is why
  `loadPhotoBuckets(roId)` returns an ordered ARRAY of this RO's live buckets instead of the old
  shop-wide name→id map. The bucket is re-resolved **at write time**: if the office removed it
  while the camera was open, the photo lands unbucketed rather than pointing at a bucket that is
  no longer on the RO.
- **The tech reads LIVE buckets only** (`archived_at is null`) — you must never be able to file
  INTO a bucket the office removed. Photos already sitting in a removed bucket are not hidden by
  that filter: grouping puts anything whose `bucket_id` is not in the live list into "No bucket".
- Works inside the gm-board `?as=` iframe (verified on a phone 2026-08-19).

### 3a. The tech's layout — two grids, or an accordion
`PhotoBuckets.techLayout` decides, and the threshold is **two**:

- **≤ 2 live buckets → the original flat layout.** One grid per bucket, both open, nothing to
  tap. Two is the standard set, so the overwhelmingly common job looks exactly as it did before
  slice 3 and the tech has nothing new to learn.
- **≥ 3 → an accordion**, first bucket open, one panel at a time. N flat grids on a phone is a
  scroll. Tapping the open panel's own header does **not** collapse it, so there is never a
  state with every grid hidden and no way to add a photo.

**Bucket names are shown VERBATIM, in English, in all three languages** (decision 2026-08-22).
They are free-typed by the office and there is no `name_es`/`name_ht`. Only the chrome around
them — "No bucket", "Add Photo", the toasts — is translated. The old `beforePhotosLabel` /
`partPhotosLabel` i18n keys were deleted rather than left dead. See [[my-numbers]] for the
standing note that **Creole is no longer needed anywhere in the app**.

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

**Where each side gets the name for `deleted_by`:** My Numbers uses `currentTechName()`; the
office uses `CHAT_IDENTITY.name`, the same session identity that renders the "Hi, <name>"
greeting (populated by `captureSessionAndGreet` → `applyIdentity` from `OfficeIdentity`).
`CHAT_IDENTITY` is a **script-scoped `let`, never a `window` property** — reading it as
`window.CHAT_IDENTITY` always yields `undefined`. That is exactly how the office archive
silently wrote a NULL `deleted_by` while the tech path worked (fixed 2026-08-20; the one prod
row archived before the fix is deliberately left NULL rather than backfilled with a guess).
The same guard bug hit three `calls` writes — `fileCallToRo`, `performAttach`,
`performNotACustomer` — and all four sites were fixed together. Full write-up of the bug class,
the repo-wide sweep, and why sandbox missed this: [[office-auth]] §1b.

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
enlarge (lightbox). Each tile carries its byline beneath it on **two lines** — date, then name —
and the lightbox repeats the full byline. A photo with no `uploaded_by` shows the date alone
rather than "· Unknown", because nobody was recorded, which is not the same as an unknown person.

**Tiles are 96px, and the byline is two lines, for one reason:** at 0.58rem a 72px caption holds
about 15 characters and `Aug 20, 7:00 PM` is exactly 15 — so on one line the NAME was always the
half that got ellipsised, which is precisely the value `uploaded_by` exists to show. The date is
also built from two `toLocaleDateString`/`toLocaleTimeString` calls rather than one
`toLocaleString`, because a single call lets the engine insert a connector (Chrome renders
`Aug 20 at 7:00 PM`) — three wasted characters that vary by browser.

Buckets are loaded here **without** the `archived_at` filter and **batched**:
`.in('ro_id', roIds)`, one query for the whole customer alongside the existing photo read, not
one per RO. Mint Motors has 31 vehicles; a per-RO bucket query would be dozens of round trips on
a screen that already does several. **Both reads now carry `.limit(2000)`** — they were
unbounded, which is the README's 1000-row hazard: a long history could silently take the default
cap and render a partial record that looked complete.

Removed buckets are loaded **on purpose**. Their photos still point at them, so grouping needs
to recognise the id to place it under "No bucket" — and keeping the row is what lets a removal
be undone.

`bucket_id` NULL renders as its own "No bucket" group, sorted last. **So does a photo whose
bucket was removed, and a photo pointing at a bucket that is not on this RO at all.** That last
case should be impossible after the migration (the verification query counts it), but grouping
it here means a stray row shows up somewhere visible instead of vanishing from the record.

> **This changed in slice 3.** Until 2026-08-22 the record resolved an archived bucket's NAME so
> history kept reading correctly. That rule existed only because buckets were shop-wide —
> retiring one silently rewrote history on *every* RO. Per-RO, removing a bucket is a deliberate
> act on one repair order, so reading as "No bucket" is exactly what was asked for. The per-RO
> model dissolved the tension rather than trading one side of it away.

### 5a0. ⚠ EVERY PHOTO/BUCKET WRITE RE-RENDERS ONE RO, IN PLACE
**Never call `renderCustVehicles()` from a photo or bucket write.** Use
`renderRoPhotos(roId)`, which replaces the innerHTML of `#custPhotos_<roId>`
and nothing else.

`renderCustVehicles()` rebuilds the whole `#custVehicles` subtree, and a browser
cannot keep scroll anchoring through that — the page jumps to the top of the
record. On a customer with 31 vehicles the advisor then has to find their way
back down. Cris, on a phone: *"every time i do something with the picture it
refresh it and i have to tap on the RO again to go back to the buckets… it goes
out to customer."* It was the biggest complaint about the whole slice.

Every one of these writes touches exactly ONE repair order, so exactly one
section needs to change. Scroll position, the open vehicle, the fleet filter and
every other RO's state survive because they are simply never re-rendered.

Three separate things had to be fixed to actually hold position — the first one
alone was not enough:

1. **`renderRoPhotos` instead of `renderCustVehicles`** on all eleven write and
   editor-toggle paths.
2. **`renderRoPhotos` pins `scrollTop` across the swap.** An in-place update
   still changes the section's HEIGHT (the rename editor is a row taller than
   the heading it replaces; adding a bucket adds a row), and when that happens
   above the viewport the page slides under the reader. Measured at 36px for a
   rename before this.
3. **`focusBucketEditor` uses `focus({ preventScroll: true })`.** A bare
   `.focus()` scrolls the element into view — that alone threw the page **1643px
   to the bottom of the record** on a rename. The editor opens exactly where the
   advisor just tapped, so there is nothing to scroll to. The offset is pinned
   around the call as well, for engines that ignore the options bag.

**And a reload of the customer already on screen must not move anyone.**
`VIEW_REFRESH.customer` fires on `visibilitychange` + `focus`, which on a phone
means every app switch and every return from the camera. `loadCustomerRecord`
now detects a same-customer refresh and keeps the open vehicle, the filter and
the scroll position, and skips the "Loading history…" placeholder that used to
collapse the accordion. Opening a *different* customer still resets everything.

Verified: take photo, move, remove photo, remove bucket, rename, add bucket, and
a visibilitychange+focus refetch all measured **0px drift** with the vehicle
still open.

### 5a. Bucket management — office only, on the record
All of it is inline on the RO, per the v6 mockup. **`PhotoBuckets.canManageBuckets(role)` gates
every control**: `advisor`, `manager` and `owner`. **`manager` IS the GM** — that is the value
stored in `employees.role`; there is no `'gm'`. Techs never create or edit a bucket; they pick
from the ones already on the RO. `bookkeeping` is excluded and moot anyway — the customer record
does not exist on that board.

⚠ **Identity resolves ASYNCHRONOUSLY, so the first render genuinely has `CHAT_IDENTITY.role`
null and every control hidden.** `applyIdentity` therefore calls `window.cdCustomerRecordRerender()`
once the role lands (a no-op unless the record is on screen). Without it an advisor opening a
record on a fresh tab would find the controls simply missing, with nothing to say they were
coming. `advisor-board.html` passes no `expectedRole` to `OfficeIdentity.resolve` — only
owner-board does — so the role is the only gate here.

**THE LABELS NAME THEIR NOUN, AND THAT IS A BUG FIX.** The photo tile's control
says **"Remove photo"**; the bucket heading's says **"Remove bucket"**. They used
to both read "Remove", they sit inches apart on a phone, and Cris tapped one
meaning the other — archiving a photo instead of the bucket (confirmed in the
data: the photo carried a `deleted_at`, the bucket was never archived). The
vocabulary is **bucket** everywhere, on both screens — "+ New bucket",
"Remove bucket", "No bucket". Never "group" or "folder".

| Control | Write | Note |
|---|---|---|
| **Rename** — the ✏️ **beside** the name | `photo_buckets.name` | validated against this RO's live buckets, case-insensitively; `selfId` exempts itself so re-saving unchanged, or changing only capitalisation, is allowed |
| **+ New bucket** | insert `{ro_id, name, sort_order: max+1}` | free-typed, trimmed, capped at **12 live** per RO |
| **Remove** | `archived_at` + `archived_by` | **`attachments.bucket_id` is NEVER written** — see below |
| **Move** (per photo) | `attachments.bucket_id` | **same RO only** |
| **Take photo** | storage + `attachments` insert | §5b |

**REMOVING A BUCKET DOES NOT TOUCH THE PHOTOS.** It sets `archived_at`/`archived_by`, and the
grouping rule renders anything pointing at a non-live bucket under "No bucket". The photos stay
visible, nothing is destroyed, and **un-removing the bucket walks every one of them straight back
in.** Nulling `bucket_id` instead would look identical on screen and would permanently erase
which bucket they had been in — the one piece of information the removal was never asked to take.

### 5a1. UNDO on a bucket removal — and the promise it replaced
`armBucketUndo` shows an amber Undo bar in that RO's photo section for **60 seconds**
(`BUCKET_UNDO_MS`). Undo clears `archived_at`/`archived_by` and **touches nothing else** — the
photos never moved, so restoring the bucket is the whole operation.

**This exists because the confirm was making a promise the app could not keep.** It used to say
the photos would come back if you *"put the bucket back"*, which reads as: create a new bucket
with the same name. That does **not** work — a new bucket is a new row, and the photos still
point at the archived one, so they stay in "No bucket". The confirm now says so in as many
words, and names the honest post-expiry state: they have to be filed back by hand.

**Scope is deliberate.** Cris's reasoning: the realistic case is a mis-tap, not a change of
heart — so this is a short Undo, **not a removed-buckets screen.** When it expires the bar
disappears and the state is exactly what the confirm warned about.

The 60s timer fires with no user action, so its re-render goes through `renderRoPhotos` and is
scroll-pinned like every other one — including the fallback path for when the RO has since been
collapsed (§5a0). A pending Undo is cleared when a *different* customer is opened; it survives a
same-customer refetch, because that is not a change of context.

**Moving is same-RO by construction, not by check.** `PhotoBuckets.moveTargets(photo, buckets)`
takes the photo and *this RO's* buckets and returns ids drawn only from that list, plus "No
bucket". There is no parameter that could name another repair order. Filing a photo onto the
wrong RO is the exact silent misfiling this subsystem exists to prevent, so the way to make it
impossible is to give the code no way to express it. The target is re-checked against the RO's
live buckets at write time as well.

**THE BUCKET NAME IS NOT THE RENAME TARGET.** It is inert text; a small ✏️ beside
it opens the editor, with a 32px tap target. The name used to be the button, and
on a phone that is a wide target sitting exactly where a thumb lands — Cris
renamed a bucket by accident just by tapping it, with no confirmation and no
undo. The affordance is now small, deliberate, and separate from the label.

**An empty bucket renders as a heading with no grid** — enough to rename or remove it, without
two empty grids per RO cluttering a vehicle that has six repair orders.

⚠ **Free-typed names go into HTML attributes, so they need `escAttr`, not `esc`.** The board's
`esc()` replaces only `<` and `>`, which was safe while every attribute on this screen held a URL
or a UUID. A bucket name — or an employee name in `data-caption` — can contain a double quote,
which closes the attribute early: broken markup at best, `" onfocus=…` at worst, on a screen that
renders customer data. `escAttr` (quotes included) is used for every attribute carrying text a
human typed.

### 5b0. ⚠ THE CAMERA'S FILE INPUT MUST LIVE OUTSIDE `#custVehicles`
**This is the bug that made office capture fail silently on a real iPhone on
2026-08-22, and the reason the input is where it is.** Read this before moving it.

Returning from the iOS camera fires **`visibilitychange` (→ visible)** and **`focus`**.
Both are wired to `refreshActiveView()`, and `VIEW_REFRESH.customer.refetch` runs
`loadCustomerRecord()`, whose first act is:

```js
$('custVehicles').innerHTML = '<div class="cust-tl-empty">Loading history…</div>';
```

So the sequence on a phone is:

1. tap **Take photo** → the native camera opens, page goes hidden
2. tap **Use Photo** → page returns → `visibilitychange` + `focus` fire
3. `loadCustomerRecord()` **replaces `#custVehicles.innerHTML`**
4. iOS *then* delivers `change` to the input — which is now **detached**
5. a **delegated** listener on `#custVehicles` never sees it. No upload, no row,
   no error, no tile.

The first version rendered `<input type="file">` inside `custPhotoBarHtml` and
listened via delegation, so it lost every photo taken on a real phone while
working perfectly in a desktop test (nothing re-renders there). **My Numbers was
never affected because `bindPhotoInputs()` binds `change` DIRECTLY to each input
— a direct listener still fires on a detached element; a delegated one cannot.**
That binding strategy, not the upload body, was the whole difference between the
two call sites.

Two independent guards now, either of which alone would fix it:
- **One persistent `#custCamInput`** in the record's STATIC markup, a sibling of
  `#custVehicles`, never re-rendered — same reasoning as the fleet filter box
  (§4a). A "Take photo" **button** stores `camPendingRo` and calls
  `input.click()` synchronously inside the user gesture. This is exactly the
  shape Capture Invoice has used on the shop's phones since July.
- **`VIEW_REFRESH.customer.refetch` holds off while `camPendingRo` is set**, so
  the destructive reload does not run mid-capture and cannot wipe `custRoPhotos`
  under an upload that has not landed. It self-clears on settle and on a 90s
  backstop, so a cancelled camera can never freeze the record's refresh.

**The input is reset in a `finally`, not after the await.** iOS names every
capture `image.jpg`; an input still holding the previous file does **not** fire
`change` for the next identical pick. That is why Cris's *second* attempt also
did nothing. Both boards now clear it on the failure path too.

### 5b. Office capture — the camera sits ON THE RO
Same upload path as My Numbers, deliberately: `PhotoCompress` downscale + EXIF fix, the same
private `crisdata-attachments` bucket, the same `repair_order/<ro id>/photos/<ts>-<rand>.<ext>`
key, the same `attachments` row. **The office is not a second kind of photo.**

- **It never asks which RO** — the button is on the RO, so the answer is already known. That is
  the whole reason it lives there and not on a floating capture button.
- **It never asks which bucket** either: `PhotoBuckets.defaultCaptureBucketId` = the RO's **first
  live bucket by sort order**. An RO with every bucket removed uploads **unbucketed** rather than
  failing.
- **No name, no photo.** `uploaded_by` comes from `CHAT_IDENTITY.name` read **bare** (§4), and an
  unresolved identity blocks the capture with "reopen this board from CrisData". An office photo
  nobody signed is worse than one not taken — the record would show a date with no
  accountability behind it, which is the exact thing the byline exists to carry.
- `capture="environment"` is the rear camera on a phone or tablet and is **ignored on desktop**,
  where it opens a file picker. Both are wanted: the advisor is sometimes on the floor and
  sometimes at a desk with the photo already on disk.
- The insert's returning clause carries `uploaded_by, created_at` into the local object, so a
  fresh tile renders identically before and after a reload — the same bug fixed on the tech side
  on 2026-08-20.
- **Reset the input AFTER awaiting the upload**, never before (§3) — and in a
  `finally`, so a failed attempt clears it too (§5b0).
- **EVERY exit is visible.** There is no `return` in `captureCustPhoto` that
  leaves the screen unchanged, and the whole body is wrapped in a `catch` that
  puts the reason on screen. It reports through a status line in the photo bar:
  grey **"Uploading photo…"**, then green **"Added to &lt;bucket name&gt;"** or a
  red line naming the failure. On success the new tile is scrolled into view and
  pulsed (`.cust-photo-new`, reduced-motion aware).
- **Saying WHICH bucket is not decoration.** Cris's first complaint, before
  anything failed, was that he took a photo and had no idea where it went.
  "It lands in the first bucket" is a rule the code knows and the person does
  not, so the answer is on screen, by name.

**Three delegated listeners on `#custVehicles`** — click, change, keydown — cover every photo and
bucket control however many ROs are open. The accordion re-renders constantly, so per-control
listeners would leak. Nothing re-renders while an inline editor is open, and `focusBucketEditor()`
restores the caret after the render that created it: a render per keystroke would kill the caret
mid-word, the same reason the fleet filter input lives OUTSIDE `#custVehicles`
([[customer-record]] §4a).

Reads are one batched `.in()` over the customer's ROs and ONE `createSignedUrls` for the whole
customer. Tile clicks are delegated from `#custVehicles` because the accordion re-renders
constantly and per-tile listeners would leak.

**The lightbox image is sized in viewport units (`max-width:90vw; max-height:85vh;
object-fit:contain`), not percentages.** `.cust-lightbox-fig` is an auto-height flex item, so a
percentage `max-height` on the image resolves against an indefinite height and constrains
nothing — the image falls back to natural size. That is what let tall photos run off the bottom
of the screen. Anything sizing this image must stay viewport-relative for the same reason.

**85vh, not 90vh**, because the image is not the only thing in the figure: it is image + a 10px
gap + the caption line, sitting inside 28px of overlay padding top and bottom. At 90vh that
total overflows a ~800px laptop viewport and the caption is what gets clipped — the byline this
subsystem exists to show. The 5vh is deliberate headroom, not a round number.

**`.cust-lightbox` sits at `z-index:4600`, which must stay above the mobile sidebar.** At
≤768px `shared/board-shell.css` gives `.sidebar` `z-index:4500` and `.sidebar-backdrop` `4499`.
The lightbox was `4000`, so opening a photo with the nav drawer open painted the sidebar over
the image. Desktop was never affected (the sidebar is a static flex column there).

### 5c. The board-wide unhandled-rejection net
`window.addEventListener('unhandledrejection')` → a red `.board-fault` bar under
the header. An `async` event listener that rejects produces an unhandled
rejection: the console has it, the person has nothing — which is precisely how
two failed captures left no trace. Every async handler on this board is one
refactor away from the same fault, so the net catches what escapes and says so.
It can only inform: it never blocks the board and never grants anything. Same
posture as `reportAmbiguous` in `shared/office-identity.js`.

## Known gaps & open questions (as of 2026-08-22)
- **⚠ Storage deletes have been silently failing since July — see §6.** Not caused by this
  subsystem, but this is where the trail leads.
- **No hard purge.** Archive hides; it does not erase. Wrong-customer photos need purge.
- **No captions/labels.** `attachments` has no caption column. `marketing_content.caption` is
  the precedent if we add one; the hard part is WHERE a tech enters it without slowing capture.
- **The grid is unbounded vertically.** `.cust-photo-grid` has no `max-height`/`overflow`, so
  60 photos on one RO push the calls timeline a screen further down.
- **~~The photo read is unbounded.~~** Both the photo and bucket reads now carry `.limit(2000)`
  (§5). Note that a limit *caps* the hazard, it does not remove it: a customer past 2000 photos
  would still render a partial record silently. Nothing is near that.
- **~~No bucket CRUD.~~** Shipped in slice 3 — §5a.
- **The templates have no editor.** Changing the standard set a new RO is born with means a hand
  -run `insert`/`update` on `photo_bucket_templates`. Deliberate for now: it changes every future
  RO in the shop and there are exactly two rows.
- **No multi-select move.** Cris's case — eight in "Before", three of them are the old valve body
  — is three separate Move → pick actions. Correct, just not brisk. Multi-select is the obvious
  follow-up if it turns out to be a daily job rather than an occasional one.
- **~~Removing a bucket has no undo in the UI.~~** Shipped — §5a1. A 60s Undo covers the mis-tap
  case. Recovering a bucket removed LONGER ago is still a one-line hand-run `update`
  (`archived_at = null`), and deliberately has no screen.
- **A removed bucket's name is not shown anywhere.** Its photos read "No bucket", which is what
  was asked for, but that does mean "these five were in Teardown" is no longer visible on the
  record — it survives only in `photo_buckets.name` on the archived row.
- **`archived_by` has no reader.** It is stamped and never displayed; there is no bucket history
  panel. Same posture as `deleted_by` was before the byline shipped.
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
- Schema: `migrations/20260819_photo_buckets.sql` (slice 1),
  `migrations/20260820_photo_archive.sql` (slice 2),
  `migrations/20260822_photo_buckets_per_ro.sql` (slice 3 — **SANDBOX run, applied 2026-08-22**),
  `migrations/20260822_photo_buckets_per_ro_PROD.sql` (slice 3 — **PROD, NOT RUN**; separate file
  on purpose, refuses unless `app_env like 'PROD%'`, no data-modifying CTEs, and it must run in
  the SAME window as the code deploy — see its header note 1).
- Storage layout: `migrations/20260819_storage_buckets.sql`, [[hosting-domains]] §5.5.
- **Bucket rules (pure, shared by both screens): `shared/photo-buckets.js` (+ `.test.js`, 33
  tests).** Grouping, ordering, the live cap, name validation, the flat/accordion threshold,
  where a capture lands, and the move targets all live here so the tech's grids and the customer
  record cannot disagree.
- Compression + EXIF: `shared/photo-compress.js` (+ `.test.js`). Loaded by **both** boards now.
- DB: `public.photo_bucket_templates`, `public.copy_photo_bucket_templates()`,
  `trg_repair_orders_photo_buckets` on `repair_orders`.
- Tech capture, grids, archive: `my-numbers.html` (`loadPhotoBuckets(roId)`, `RO_BUCKETS`,
  `roPhotoGroups`, `roPhotoGridHtml`, `roPhotosHtml`, `roOpenBucketKey`, `uploadRoPhoto`,
  `archiveRoPhoto`, `canArchivePhoto`, `bindPhotoInputs`).
- Display + management + office capture: `advisor-board.html` (`canManageCustBuckets`,
  `custBucketsFor`, `escAttr`, `custPhotoGroups`, `custPhotoCellHtml`, `custBucketHeadHtml`,
  `custPhotoBarHtml`, `roPhotosHtml`, `custActorName`, `custSetBuckets`, `addCustBucket`,
  `renameCustBucket`, `removeCustBucket`, `moveCustPhoto`, `captureCustPhoto`,
  `focusBucketEditor`, `window.cdCustomerRecordRerender`, the three `#custVehicles` delegated
  listeners).

## Session change log
- 2026-08-23 — **SLICE 3 IS LIVE ON PROD.** Code `484a3e0` was deployed to `main` FIRST and
  byte-verified on www, then Cris ran the prod migration by hand, block by block, in the
  Supabase editor on `PROD — KiKi hygemiszxwmyrkmhbjub`. Blocks 00 · 0 · A · B1 · C · B2 · B3 ·
  B4 · B5 all ran clean; block D's 13 checks all pass. **ros 66 · templates 2 · buckets created
  132 · photos repointed 4 · globals deleted 2 · `ro_id` NOT NULL.** He confirmed the buckets
  render on prod on his iPhone. **Block E remains open** — it proves the born-with-buckets
  trigger on the next real RO the shop creates, and there is nothing to do until then.
  Deploy-first was the deliberate change from the original plan, and it is now the house rule:
  [[staging-db]] §8.5.
  Also corrected while recording this: the slice-1 and slice-2 migration headers had said
  **"❌ NOT on prod"** since 2026-08-20 — the day they were run on prod. For three days two
  files in this repo asserted the opposite of the truth about a production database. Both now
  state where they have run. See the recurring-hazard list in `docs/wiring/README.md`.
- 2026-08-22 (phone testing, round 3) — **RO accordion + Undo on bucket removal.**
  Cris on `6d01223`: everything from rounds 1–2 verified working on his iPhone (capture, move,
  the clearer labels, the pencil, staying in place). Two changes.
  (1) **Each RO now collapses**, because *"there's not a clear division between RO's"* — one
  job's photo grids ran straight into the next job's heading. `roRowHtml` mirrors `vehRowHtml`
  exactly (same chevron, same rotate, same head/body split, same accent-on-open) rather than
  inventing a second pattern; the newest RO opens by default and the collapsed header carries RO
  number, status, date, a one-line complaint, invoice total and photo count. `resolveOpenRo`
  uses the same three-state shape as the tech's accordion (undefined = newest, null =
  deliberately closed, id = that one). Because the head is a `<button>`, "Open RO #…" moved into
  the body — which is also safer, since it is the one control that navigates away.
  (2) **Undo on bucket removal** (§5a1), replacing a confirm that promised something the app
  could not do.
  **Fix 2 re-measured with the accordion in place: 0px drift and open/closed RO state held
  across all seven paths** — take photo, move, remove photo, add bucket, rename, remove bucket,
  and visibilitychange+focus. Two new scroll traps found and closed on the way: the RO header's
  photo count is patched in place by `syncRoPhotoCount` (an in-place render does not touch the
  header, so the count would have gone stale), and the Undo timer's unattended re-render is
  scroll-pinned on both the in-place and fallback paths.
- 2026-08-22 (phone testing, round 2) — **Three fixes from Cris's iPhone on
  `cfcfb1c`; the camera fix itself was confirmed working by him.**
  (1) **"Remove" appeared on both a photo and a bucket** and he tapped the wrong
  one — now "Remove photo" and "Remove bucket", with the vocabulary swept for
  stray "group"/"folder" on both screens (§5a). (2) **Every action threw him back
  to the top of the record** — all photo/bucket writes now re-render one RO in
  place via `renderRoPhotos`, `renderRoPhotos` pins scroll across the swap,
  `focusBucketEditor` no longer scrolls (that one alone was a 1643px jump), and a
  same-customer refetch keeps the open vehicle and scroll (§5a0). Measured 0px
  drift on all seven actions. (3) **The bucket name was itself the rename
  target** and he renamed one by mis-tapping — a ✏️ beside the name is now the
  only way in (§5a). Also restored the photo he archived by accident, using the
  tombstone's inverse rather than a delete.
- 2026-08-22 (later) — **FIXED: office capture failed silently on a real iPhone.**
  Root cause was **not** HEIC, not the compressor and not memory:
  `compressImage` catches everything and falls back to the original, so it cannot
  throw. It was **event delivery** — the camera's `<input>` was rendered INSIDE
  `#custVehicles`, and returning from the camera fires `visibilitychange`+`focus`
  → `refreshActiveView()` → `loadCustomerRecord()` → `innerHTML` replaced →
  the input is detached before iOS delivers `change`, which a **delegated**
  listener never sees. Full write-up: §5b0. Fixed with one persistent input in
  static markup outside the accordion, a button that clicks it inside the user
  gesture, and a refetch hold-off while a capture is pending. Separately: the
  input is now reset in a `finally` (that is why the SECOND attempt also did
  nothing — iOS reuses `image.jpg` and an un-reset input does not re-fire), the
  whole capture is wrapped in a real `catch`, every exit reports on screen, a
  success names the bucket and pulses the new tile, and a board-wide
  unhandled-rejection net (§5c) makes any future escape visible. The same
  missing `catch` and the same reset-in-`finally` were applied to My Numbers,
  which had the identical exposure. Verified locally by replaying the exact iOS
  sequence (open → visibilitychange+focus → deliver file): the upload lands, the
  bar reads "Added to On arrival", and a forced failure shows a red line and
  clears the input so the retry works.
- 2026-08-22 — **Slice 3 VERIFIED against the sandbox, in the real screens.** Ten checks, all
  driven through the actual UI as `ZZ Test Advisor` (advisor) and `ZZ Test Tech`:
  **per-RO isolation** — renaming "Before" → "On arrival" on RO #6012 left RO #6001 and the
  other 53 `Before` rows untouched (both ROs are on the SAME vehicle of the same customer, so
  they render side by side); **add** free-typed; **case collision** — `"  TEARDOWN   FINDINGS  "`
  refused against `Teardown findings`, whitespace collapsed, editor kept the typing;
  **12-cap** — the + button is replaced by the message on the capped RO while a sibling RO with
  2 buckets still offers it; **escAttr** — a bucket literally named `Bad" onfocus="…" x="`
  produced zero stray `onfocus` attributes, never fired, and round-tripped byte-for-byte through
  `value="…"`; **office camera** — 8 shots landed in the first live bucket without asking,
  byline `ZZ Test Advisor`; **move 3 of 8** — Before 8/0 → 5/3, picker never offered the photo's
  own bucket, and a DB-wide check found **0** photos pointing at another RO's bucket;
  **remove → restore** — the 5 photos read "No bucket" (a plain span, no rename, no Remove) while
  `attachments.bucket_id` stayed **untouched**, and clearing `archived_at` walked all 5 straight
  back in; **`archived_by` = `ZZ Test Advisor`, not null** — dbc9f9a's bug class does not recur;
  **tech layout** — 2 buckets rendered the original flat two-grid layout (2 headings, 2 grids,
  2 add tiles, 8 thumbs, zero accordion), 3 buckets rendered a 3-panel accordion with the first
  open, and a tech upload went in by BUCKET ID (`roPhotoInput_<uuid>`) to the right bucket on the
  right RO.
  Two findings that are NOT app bugs but cost time: the local `npx serve` clean-URL redirect
  **strips the query string**, so `my-numbers.html?as=…` silently loses `?as=` (use the
  extensionless path); and the Supabase editor's linter turns a data-modifying CTE into an
  "enable RLS on repair_orders" dialog whose green default would blank every board — the prod
  file therefore contains **no data-modifying CTEs**, using `GET DIAGNOSTICS` instead
  ([[staging-db]] §8.4).
- 2026-08-22 — **Slice 3 built (UNMERGED, nothing applied anywhere).** Buckets went **per-RO**:
  `photo_buckets.ro_id NOT NULL`, a new `photo_bucket_templates` table read once per RO by an
  `after insert` trigger on `repair_orders`, and per-RO case-insensitive name uniqueness. A
  bucket is now a COPY, not a link. Added office-side **bucket management** (rename / add /
  remove, gated on advisor·manager·owner), **moving a photo between buckets on the same RO**, and
  an **office camera on each RO**. Removing a bucket archives it and **never touches
  `attachments.bucket_id`**, so it is reversible. All the rules moved into
  `shared/photo-buckets.js` (33 tests) so both screens share them.
  Four things found and fixed while building, worth keeping:
  (1) the tech's bucket lookup was **by name**, which per-RO would have filed photos onto an
  arbitrary other repair order — it is by id now;
  (2) `esc()` does not escape quotes, and bucket names are free-typed into attributes — added
  `escAttr`;
  (3) with every bucket removed the tech had **no way to add a photo at all** — both screens now
  fall back to an addable "No bucket" grid;
  (4) `app_env` returns **zero rows to `anon` on both prod and sandbox**, which would make every
  `not like 'PROD%'` guard NULL and every DML block report `0` while looking like it ran — the
  migration opens with a pre-flight that turns that into a loud stop ([[staging-db]] §8.1).
  The i18n keys `beforePhotosLabel`/`partPhotosLabel` were deleted: bucket names are English
  only, shown verbatim, by decision.
- 2026-08-21 — **Lightbox sizing + z-index fixed.** An enlarged photo rendered at natural size,
  so tall photos ran past the bottom of the screen with no way to see the whole image. The
  image's `max-width`/`max-height` were percentages resolving against an auto-height flex
  figure, which constrains nothing; they are now `90vw`/`85vh` plus `object-fit:contain` (85,
  not 90, so the caption clears a ~800px laptop viewport — see §5). Separately, `.cust-lightbox`
  went `4000` → `4600` so it outranks the mobile sidebar (4500) and its backdrop (4499), which
  had been painting over the photo when the nav drawer was open. Two CSS rules; the grid, tiles,
  figure and caption are untouched. A prior session's note claimed the overlay was confined to
  an iframe — investigated and false: `#view-customer` is a plain div, the lightbox is appended
  to `document.body`, and no iframe in the repo embeds this screen.
- 2026-08-20 — **Shipped to prod (`ae4510b`) and then fixed the office archive.** Slices 1+2
  went to prod after the four migrations were run by hand. Prod smoke test found the
  office-side archive writing `deleted_at` but a NULL `deleted_by`: `archiveCustPhoto` guarded
  on `window.CHAT_IDENTITY`, which is always `undefined` because the binding is a script-scoped
  `let`. Sandbox never caught it — only the tech path (`currentTechName()`) had been exercised.
  Now reads `CHAT_IDENTITY` bare. The pre-fix prod row is left NULL on purpose. The same guard
  bug on three `calls` writes was folded into the same branch; a repo-wide sweep found no other
  instance. Bug class documented in [[office-auth]] §1b.
- 2026-08-20 — **Two slice-2 bugs fixed after sandbox verification.** (1) The archive × did not
  appear until a reload: `uploadRoPhoto` pushed a local photo object without `uploaded_by`, so
  `canArchivePhoto` saw it as ownerless — the row had the value, the in-memory object did not.
  The insert's returning clause now yields `uploaded_by, created_at` and those are carried
  through, so a tile renders identically before and after a reload. (2) The customer-record
  caption truncated at 72px and the NAME was the half being cut. Tiles are now 96px, the byline
  is two lines (date, then name), the date is built from two locale calls so no engine inserts
  an "at", and the lightbox carries the full byline as a backstop.
- 2026-08-20 — **Slice 2 built** (unmerged): archive-as-tombstone (`deleted_at`/`deleted_by`,
  chat's shape), `uploaded_by` captured at upload — My Numbers had the tech's name all along and
  was discarding it — and the date · name byline on the customer record. All FOUR readers
  filtered, including `loadRoClips`, which the original three-site estimate missed. Logged §6:
  storage deletes in chat and diagnosis clips have been failing silently since July.
- 2026-08-19 — **Slice 1 shipped to staging** (`4a23cf9`): schema + buckets, real upload from My
  Numbers with compression and EXIF, customer-record display. Grids moved off the shopboard job
  screen (no RO id there) and the fake local-only grids deleted. Doc created 2026-08-20.
