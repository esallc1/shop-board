# How invoice capture & the Process-Invoice modal are wired

> Doc: `/docs/wiring/invoice-classify.md`
> **2026-09-17 — `/api/extract-invoice` is now EMPLOYEES-ONLY** (Security Phase 3): the board
> sends its signed-in session's access token and the endpoint maps it to an active `employees`
> row before spending anything (§2a). Before this it answered an anonymous POST from anywhere
> and billed the shop. Verified vs `origin/main` + this branch; nothing else re-checked.
> Previously: 2026-09-11 — verified vs commit `1fc57fa` (the commit this doc ships with)
> Status: ✅ Verified this session against `bookkeeping-board.html` (queue, modal, rotate,
> zoom, confirm/move), `advisor-board.html` (Capture Invoice), `api/extract-invoice.js`, and
> `migrations/20260713_invoice_queue.sql` + siblings. The **preview-viewer** sections (§4, §5)
> were exercised in-browser against the real CSS/markup/JS. Sections marked ⚠ in §6 are
> **not** verified — they were outside this session's change.

## 0. In one line
A photo of a receipt is uploaded with **no fields at all** and lands in `invoice_queue` as
`status='unprocessed'`; Daiana later opens it in the **Process Invoice** modal, where she reads
the numbers off the photo and types them into the form beside it — and confirming both files
the image into its permanent folder and flips the row to `processed`.

## 1. The two halves — capture is deliberately dumb
1. **Capture** (`advisor-board.html`, `#view-capture`): Josh taps one button, picks/takes a
   photo, and that is the entire interaction. The file goes to the private `invoice-images`
   bucket at the flat path `<uuid>/<timestamp>.<ext>`, then a row is inserted into
   `invoice_queue` carrying only `id`, `image_path`, `original_filename`, `uploaded_by`,
   `uploaded_by_name`. **Vendor is unknown at capture time** — that is why the storage path is
   flat here and gets moved later (§3).
2. **Classify** (`bookkeeping-board.html`): the Unprocessed Invoices list is
   `invoice_queue` filtered to `status='unprocessed'`, newest first. History is the same table
   filtered to `status='processed'`, by `processed_at`.

## 2. The modal has two entry points, one body
`openInvoiceDetail(id)` (classify, from the queue) and `openHistoryEditModal(id)` (edit, from
History) fill the **same** `#invoiceDetailModal`. The difference is carried in
`isEditingHistoryRow`:
- classify runs auto-detect; **History edit deliberately does not** — she already reviewed
  those values once, so re-running vision extraction would risk silently replacing a correct
  number with a fresh AI guess.
- classify stamps `processed_at` / `processed_by` / `processed_by_name`; editing does not
  restamp them.

Every close path funnels through **`closeInvoiceDetail()`** — the ✕ button, Cancel, and the end
of a successful confirm. It is the single place per-invoice view state is torn down.

**Auto-detect** (`runAutoDetect`) POSTs a signed image URL to `/api/extract-invoice`, which
calls Anthropic `claude-haiku-4-5-20251001` (`max_tokens: 300`) and returns vendor / date /
amount / po_number / description / part_number.

### 2a. Auto-detect is employees-only (Security Phase 3, 2026-09-17)
`runAutoDetect` reads `db.auth.getSession()` and sends `Authorization: Bearer <access_token>`.
The endpoint calls `requireUser` (`api/_lib/require-user.js`) **first** — before the image fetch
and before Anthropic — and answers a flat `401 {error:'unauthorized'}` unless the token is a live
Supabase session **whose `auth.uid()` maps to an `employees` row with `active = true`**. A valid
session is not enough on its own: the KiKi app shares this project's `auth.users`.

Why the gate is first: every call costs real Anthropic credits. Until this landed, a plain
`POST {imageUrl}` from anywhere on the internet was answered and billed to the shop.

**A 401 is not a broken modal.** Auto-detect has always been best-effort: on any failure the
fields simply stay empty and Daiana types them, exactly as before the feature existed. The only
new symptom is a `[AutoDetect] request rejected — HTTP 401` console line. Confirm, rotate, zoom
and the move-on-confirm flow do not touch this endpoint and are unchanged. Each field it fills gets a ✨ badge, and that
badge is cleared the moment she edits the field — it is a hint, not a guarantee. Both the
extractor callback and the rotate handler re-check `detailInvoice.id` before writing to the
DOM, so a slow response can't clobber a modal that has moved on to another invoice.

## 3. Confirm moves the file, then the row
On confirm the image is moved to its permanent home keyed off the **entered invoice date**:
`<vendor-slug>/<yyyy-mm>/` for parts/vendor, `shop-expenses/<yyyy-mm>/`,
`repair-invoices/<yyyy-mm>/`, or `<type-slug>/<yyyy-mm>/` for a custom type. The move happens
**before** the row update and only when the computed path actually differs, so editing an
invoice where nothing path-relevant changed never touches storage; if the row update then
fails, the move is rolled back so `image_path` can't point at a file that isn't there.
Cores and multi-PO lines are written **after** the row is processed, and a failure there does
not un-process the invoice — she's told to fix them from History → Edit.

## 4. The preview is TWO different things — this is the section to read before touching it
Both controls sit over the same `.invoice-detail-img-wrap`, and they are opposites:

**4a. Rotate (↺ ↻) WRITES.** The AI extractor reads the **stored bytes**, so a merely visual
rotation would not help it. `rotateInvoiceImage()` therefore fetches the stored file, re-draws
it 90° on a canvas, **re-uploads over the same path** (`upsert: true`), and — in the classify
flow only — re-runs auto-detect on the corrected orientation. It accumulates: each click
rotates the already-saved file another 90°.

**4b. Zoom (− + Fit) DOES NOT WRITE.** Zoom exists because she reads small numbers off a
photographed receipt *while typing them into the fields below it*, so it magnifies **in place**
— a CSS `transform` on the `<img>`, cropped by the wrap's existing `overflow:hidden`. She is
never made to close or leave anything to type. It never fetches, re-encodes, re-crops,
re-uploads, or re-runs the extractor. **Do not "improve" it by persisting the zoom** — that
would convert a free view control into a destructive write on every receipt.

State is one module-level object `invZoom = {scale, tx, ty}` (translation in screen px,
applied as `translate(tx,ty) scale(s)` about the centre), driven by:
- **buttons** — ±1.4× per click about the centre; `Fit` returns to 1.0. Scale is clamped to
  **1–6×**; `−` and `Fit` disable at fit, and a `%` chip appears only while zoomed (pure CSS,
  off the `.is-zoomed` class).
- **wheel / trackpad**, anchored on the pointer so the number she is reading stays under the
  cursor. `preventDefault()` here is **mandatory, not tidiness**: `.modal-box` is
  `overflow-y:auto` (`shared/board-shell.css`), so without it the form scrolls out from under
  the photo instead of zooming. A macOS trackpad pinch arrives as ctrl+wheel and is given a
  larger step; Firefox's line/page delta modes are normalised to pixels first.
- **touch** — two fingers pinch *and* drag together, anchored on the midpoint; one finger pans
  **only once zoomed past fit**. At fit, a one-finger swipe is left alone (`touch-action:pan-y`)
  so the form still scrolls; zoomed, the image takes the gesture (`touch-action:none`).
- **mouse drag** to pan, with grab/grabbing cursors. A `mousedown` on any control inside the
  wrap is ignored, so clicking a zoom or rotate button can never start a pan.

**Pan is clamped** against the *letterboxed content box*, not the element box: `object-fit:
contain` bars a tall receipt with empty space, and clamping against the element would let her
drag that emptiness into frame and lose the photo. The content box is derived from
`naturalWidth/Height` vs `offsetWidth/Height` — **`offsetWidth`, never
`getBoundingClientRect()`, which would report the box we just transformed and feed our own
scale back in.** A consequence worth knowing: when an axis has no slack (a narrow receipt at
low zoom), the clamp overrides the cursor anchor on that axis. That is correct — the anchor
must not push the receipt out of frame.

## 5. Rotate × zoom — why the `load` listener exists
Rotate **swaps the underlying file out from under an active transform**: the replacement comes
back with width and height swapped, so an existing pan offset now points at nothing. Left
alone, rotating while zoomed strands her on a corner of the image with no way back but closing
the modal. So every `load` on `#invDetailImg` **keeps her magnification** (she zoomed in for a
reason and is mid-field) and **re-centres the pan** — the only offset still meaningful across
the swap — then lets the clamp re-derive limits from the new dimensions. `Fit` always returns
the whole receipt.

Verified in-browser this session on the real code: zoom to 274% → pan → rotate → the scale is
preserved, pan re-centres to 0,0, clamps are recomputed against the swapped dimensions, the
receipt is still readable and pannable, and `Fit` restores the whole image.

Zoom is **per-invoice, not a sticky preference**: it is fully reset in `closeInvoiceDetail()`
and in both open paths (needed separately, because setting `src=''` fires no `load` event and a
stale scale would otherwise survive into the next receipt).

## 6. Known gaps & open questions (as of 2026-09-11)
- **The wrap's height changes when the aspect ratio does.** `<img>` is `height:auto` under a
  300px cap, so rotating a portrait receipt to landscape shortens the preview and the form
  below shifts up. Pre-existing, not introduced by zoom; it would be fixed by giving the wrap a
  fixed height.
- **Zoom is view-only by design, so it does not help the extractor.** If auto-detect misreads a
  small number, zooming does not change what the AI sees — only rotate does.
- **Wheel over the photo always zooms**, so hovering it and scrolling will not scroll the form.
  Standard for image viewers, but it is a deliberate trade, not an oversight.
- ⚠ **Not verified this session:** the bucket's RLS policies (the rotate comment claims an anon
  UPDATE policy shared with the classify move), the cores / multi-PO (`invoice_po_lines`,
  `core_charges`) write paths beyond their ordering, and the 8 pre-Phase-4 flat files the move
  logic says it never touches.

## 7. Where it lives in the code
- **Capture:** `advisor-board.html` — `#view-capture`, the upload + `invoice_queue` insert.
- **Queue / History / modal:** `bookkeeping-board.html` — `#invoiceDetailModal`,
  `openInvoiceDetail`, `openHistoryEditModal`, `closeInvoiceDetail`, `confirmInvoiceDetail`,
  `runAutoDetect`, `rotateInvoiceImage`, and the `invZoom*` viewer (`invZoomApply`,
  `invZoomAt`, `invZoomContentBox`, `invZoomReset`, `wireInvoiceZoomGestures`).
- **Preview CSS:** `bookkeeping-board.html` — `.invoice-detail-img-wrap`,
  `.invoice-zoom-controls`, `.invoice-rotate-controls`, `.is-zoomed`, `.is-panning`.
- **Extractor:** `api/extract-invoice.js` (Anthropic `claude-haiku-4-5-20251001`). Since
  2026-09-17 it is the **only** endpoint in this project that calls Anthropic — the Ask-Kiki chat
  bot and its `api/chat.js` were deleted ([[page-map]] §6a), so `ANTHROPIC_API_KEY` exists for
  this one function. Since the same day it is **employees-only** (§2a) via
  `api/_lib/require-user.js` — the reusable caller check the other office endpoints will adopt.
- **Storage:** private bucket `invoice-images`; signed URLs, TTL 3600s.
- **Schema:** `migrations/20260713_invoice_queue.sql`, `20260714_invoice_queue_date.sql`,
  `20260714_invoice_queue_delete.sql`, `20260714_invoice_queue_line_item.sql`,
  `20260715_core_charges.sql`, `20260715_core_charges_returned_by.sql`.

## Session change log
- 2026-09-17 — **§2a added: `/api/extract-invoice` requires a signed-in active employee.** The board now sends its session token; the endpoint 401s before the image fetch and before Anthropic. New `api/_lib/require-user.js` (+ tests). Nothing else in the modal changed.
- 2026-09-11 — Doc created. Added **in-place zoom** to the Process-Invoice preview (zoom in /
  out / Fit beside rotate, drag-pan, wheel + trackpad + pinch, reset on close), strictly
  view-only via CSS transform, and made rotate compose with an active zoom by re-centring on
  image load (§5). Zoom controls were placed as a **separate bottom-left cluster** rather than
  appended to the rotate group: zoom is safe and constant, rotate re-uploads the file and
  re-runs auto-detect, so the two should not sit a thumb-width apart.
