# How tech findings are wired

> Doc: `/docs/wiring/tech-findings.md`
> Last updated: 2026-08-25 — created with the append-not-overwrite slice.
> Verified vs commit `2d545a8`. Status: 🟡 **on staging, not yet on prod.**
> Related: [[my-numbers]], [[ro-photos]] §4, [[ro-invoice]], [[tech-board]].

## 0. In one line
The tech's write-up on a repair order — what he found, the DTC codes and the
voice notes — kept as a **dated history that is never overwritten**, written from
My Numbers and shown to the service writer on the RO screen the whole time he is
working the job.

## 1. What SUBMIT actually writes
One `UPDATE` on **`repair_orders`**. There is no findings table, no migration,
and this slice added no schema at all.

| Column | Written by | Meaning |
|---|---|---|
| `diagnosis_recommendation` | My Numbers | the **whole history**, newest first (§2) |
| `diagnosis_submitted_at` | My Numbers | when the job was handed over. Ordering key for the queue |
| `diagnosis_reviewed_at` | advisor board | set when the writer opens the queue card; **null = still ready** |

**The RO's `status` is not touched.** An estimate stays an estimate. "Diagnosis
ready" is a derived state — `submitted_at` set **and** `reviewed_at` null — not a
flag of its own.

**DTC codes are not written by submit.** Each code is inserted into
`ro_diagnostic_codes` the moment the tech adds the chip, and voice notes and
photos upload as they are taken. Submit only moves the text and the timestamps.

## 2. The history lives in ONE text column
Until 2026-08-25 a second submit **overwrote** `diagnosis_recommendation` and the
first write-up was gone — no copy, no audit. It is now an append-only log inside
that same column:

```
␞ FINDINGS ␞ by=Manny ␞ at=2026-08-25T13:30:00.000Z ␞
3-4 clutch pack is cooked, recommend a full rebuild.

␞ FINDINGS ␞ by=Manny ␞ at=2026-08-20T14:10:00.000Z ␞
first look — fluid is burnt
```

Newest first. All of the formatting and parsing is in **`shared/tech-findings.js`**,
used by **both** boards — My Numbers formats and writes, the advisor board parses
and renders. Two implementations of one delimiter is how entries silently merge
or vanish, so there is only ever one.

### 2a. Why `␞` (U+241E), and why it cannot collide
`␞` is the *printable* Symbol For Record Separator.

- It is **not reachable** on an iOS or Android keyboard in EN or ES, including
  the emoji picker.
- It is **printable**, so the column can be read and grepped by hand in the SQL
  editor. The real control character U+001E would parse as well and be
  undebuggable, and anything that strips control characters in transit would
  silently eat it.
- It is the **field** separator as well as the line sentinel, so a name
  containing a `|` or a space cannot break the parse.

**Rarity is not the guarantee.** `sanitizeBody()` strips every `␞` from a body
*before* it is written, so a forged header is impossible **by construction**
rather than merely unlikely. A delimiter that is only improbable eventually
collides.

The header regex is anchored to the start **and** end of a line, so a body that
merely mentions the word FINDINGS is not a header (pinned by a test).

### 2b. Legacy rows — wrapped lazily, never backfilled
Everything written before this slice is bare text with no header. On the **next**
write to that RO it is wrapped using the timestamp the DB already holds
(`diagnosis_submitted_at`) and **no name**.

**The author is omitted, not guessed.** `submitDiagnosis` never recorded one, so
there is nothing to recover. Stamping `repair_orders.technician` would be an
inference presented as a fact — that column is the **assigned** tech, written by
a different action (`assignTechCore`), and it is not the same person whenever a
job was reassigned after diagnosis. Same rule as `attachments.uploaded_by IS
NULL` rendering a date-only tile: nobody was recorded is not the same as an
unknown person.

Lazy on purpose: an RO nobody writes to again keeps its exact current bytes
forever. **There is no backfill and no migration.**

## 3. The tech's two ways to change it
| | What it does | When |
|---|---|---|
| **Edit** | rewrites the most recent entry **in place**; no new entry appears | typos and corrections |
| **Add follow-up** | a new dated entry stacked on top | new findings |

### 3a. ⚠ THE BOX STARTS EMPTY — and that is load-bearing
The textarea used to be seeded with `ro.diagnosis_recommendation`. With appends,
a prefilled box means every submit prepends the **entire history onto itself**
and the column **doubles on every submit**. The seed is now `''`; previous
entries render read-only underneath.

Tapping **Edit** seeds the box with *that one entry's* body and flips
`RO_DIAG.editing`, so the submit rewrites rather than adds.

### 3b. THE LOCK — Edit dies the moment the writer opens it
Edit is offered **only while `diagnosis_reviewed_at IS NULL`.**

The reason is not tidiness. The advisor quotes the job from these words at 11am;
if they could change under him at 2pm with nothing saying so, the estimate no
longer matches the findings it came from. Once the card has been opened, a
follow-up — dated, stacked on top, and re-opening the queue card — is the only
honest way to add something.

The locked state is **not a vanished button**: it is replaced by the reason, in
the tech's language — *"The writer has already seen this — add a follow-up
instead."* A control that silently disappears teaches nothing.

### 3c. The race, and why the UI check is not enough
The advisor can open the card **while the tech is mid-edit**. The concurrency
guard is on `diagnosis_submitted_at`, which an edit deliberately does **not**
change, so it would not catch this on its own. Therefore the edit write also
carries `.is('diagnosis_reviewed_at', null)` — **the lock is enforced at write
time, against the database, not just in the UI.**

When it is refused, what the tech typed **is not dropped**. He is offered the
same words as a follow-up, which is the honest way to add something the writer
has already read; declining leaves the text sitting in the box.

### 3d. Optimistic concurrency, because there is no transaction
The new column value is computed from a **fresh read** taken immediately before
the write — never from `RO_DIAG.ro`, which may be minutes stale and would erase
anything submitted in between. The `UPDATE` is then conditional on the row still
looking the way it did (`.eq('diagnosis_submitted_at', <what we just read>)`, or
`.is(..., null)` because **PostgREST `.eq` cannot match NULL**), and `.select('id')`
reports whether it matched. Zero rows means somebody wrote first: re-read and
retry **once**, then fail loudly and reload rather than clobber.

### 3e. Rules that keep the history honest
- **A codes-only submit adds no entry.** No blank rows in the log.
- **An empty edit destroys nothing** — it returns the entry unchanged, because
  "clear the box and submit" must not silently delete the words the Edit was
  meant to correct.
- **A follow-up clears `diagnosis_reviewed_at`**, re-opening the queue card even
  if the writer already reviewed it. An edit does not — it never left his sight.
- **An edit's header timestamp becomes the time of that write**, and the name the
  editor's: the header answers *who wrote these words and when*, and after an
  edit they are his, as of now. The original handover time is not lost — it stays
  in `diagnosis_submitted_at`, which an edit does not touch, so the queue keeps
  ordering by when the job was first handed over.

## 4. Where the service writer sees it
### 4a. Tech Findings, on the RO detail screen
A fourth block **inside the Complaint & Notes card**, below Advisory Notes — not
a card of its own, because it belongs with Work Description, the other internal
never-printed thing on that screen. It shows the newest entry with its byline,
the DTC codes and the voice notes, and older entries collapsed behind
*"N earlier versions"*.

**It is READ-ONLY, and that is a rule.** The advisor cannot edit or delete a word
of it, and this board never writes `diagnosis_recommendation`. The tech owns
those words; if the advisor could overwrite them there would be no record of what
the tech actually said, which is the whole reason it stopped being one
overwritable column. Corrections are the tech's, from My Numbers, under §3b.

**It renders on estimate and active RO alike** — `status` is a column, not a
record, so there is nothing to branch on. **If nothing was ever submitted the
block does not render at all**: no empty heading, no "no findings yet" line.

### 4b. ⚠ IT IS NEVER PRINTED — verified, not assumed
`shared/ro-invoice.js` is the **single** document builder behind both the advisor
board's `printRo` and the bookkeeping board's RO-detail embed. It reads an
**explicit allowlist of eleven fields** off the RO —
`advisory_notes`, `closed_at`, `complaint`, `customers`, `miles_out`,
`odometer_in`, `ro_number`, `service_writer`, `status`, `technician`, `vehicles`
— and has no branch that dumps unknown fields. `diagnosis_recommendation` does
not appear anywhere in it (nor does `work_description`, the same way). Putting
findings on paper would take a deliberate edit to that list.

### 4c. The Approval Queue card shows the NEWEST entry only
The card rendered the raw column before this slice; left alone it would print
`␞ FINDINGS ␞ by=…` sentinels straight at the service writer. It now shows the
newest body, labelled *"· newest of N"* when there is a history. The full history
is one tap away on the RO screen, which is where reading it belongs — the card is
the handoff, not the archive.

### 4d. ⚠ There is still NO notification
No push, no badge, no count, no sound. The Approval Queue realtime-subscribes to
`repair_orders`, so a card appears by itself **if the writer is already on that
tab**; otherwise nothing tells him. This slice put the findings in front of him
*once he opens the RO* — it did **not** solve the handoff alert. Standing gap,
also recorded in [[my-numbers]].

## 5. Signed URLs, and the audio element
Voice notes are private-bucket objects signed for **one hour**, and the RO detail
does not refetch itself — its `VIEW_REFRESH.cdros` refetch is the *list*. So the
findings re-read on focus/visibility through **the same `resign` path the RO
photos use** ([[ro-photos]] §5d3), held off mid-capture for the same reason. A
counter iPad left open on one RO must not quietly turn its voice notes into dead
buttons.

**One reused `<audio>` element** for the whole block, so a second voice note stops
the first instead of playing over it — same reasoning as `#custRecAudio` on the
customer record.

## Known gaps & open questions (as of 2026-08-25)
- **No notification on the handoff** (§4d). The oldest and biggest gap here.
- **No real history table.** This is a text column with a strict format. It
  parses reliably and is deliberately designed to be split apart later, but it
  cannot be queried, sorted or joined. If findings ever need reporting, that is
  the migration this slice avoided.
- **The lock is app-level, not RLS.** `repair_orders` carries table-level anon
  access; a client that ignored the UI could still write. Same posture as every
  other write in this app.
- **`.eq` guard vs a true CAS.** The optimistic guard is on the timestamp, not on
  the text. Two techs editing the same RO in the same second could still have one
  write win silently. Guarding on the full text would be a true compare-and-swap
  but puts the whole history in a query string, which has its own limit.
- **Nothing ages an unread diagnosis.** It sits at the top of the queue, oldest
  first, with no age shown and no escalation. Unchanged by this slice.
- **`repair_orders.technician` is still the only tech name on the RO** and it
  still means *assigned*, not *author*. Entries written from 2026-08-25 carry a
  real author in their header; everything older has none, forever.

## Where it lives in the code
- **Format + parse (pure, shared, 29 tests): `shared/tech-findings.js` (+ `.test.js`)** —
  `SEP`, `sanitizeBody`, `sanitizeName`, `formatHeader`, `formatEntry`,
  `parseFindings`, `wrapLegacy`, `prependEntry`, `replaceNewestEntry`,
  `canEditNewest`, `newestBody`, `entryCount`.
- **Write side: `my-numbers.html`** — `submitDiagnosis` (fresh read, guard, retry),
  `roFindingsHtml`, `roFindingsWhen`, `refreshFindingsUI`, `bindFindingsControls`,
  `RO_DIAG.editing`, the `.rof-*` CSS, and the `findings*` i18n keys in all three
  language blocks.
- **Read side: `advisor-board.html`** — `loadRoFindings`, `resignRoFindings`,
  `renderRoFindings`, `tfWhen`, `bindRoFindingsPlayback`, `#cdRoFindings` inside
  the Complaint & Notes card, `#cdRoFindingsAudio`, the `.cd-tf-*` CSS; and
  `tfNewest` / `tfMore` for the Approval Queue card.
- **Not printed:** `shared/ro-invoice.js` (the eleven-field allowlist, §4b).
- **DB:** `repair_orders.diagnosis_recommendation` / `diagnosis_submitted_at` /
  `diagnosis_reviewed_at`, `ro_diagnostic_codes`, `attachments` where
  `kind = 'diagnosis_audio'`. Schema from `migrations/20260717_ro_diagnosis.sql`;
  **this slice added none.**

## Session change log
- 2026-08-25 — **Created, with the append-not-overwrite slice.** Findings became a
  dated history inside the existing column (`␞ FINDINGS ␞`, sanitised on write);
  Edit vs Add-follow-up with the reviewed-at lock enforced at write time; the
  tech's box seeded empty to kill the doubling trap; a read-only Tech Findings
  block on the RO detail so the writer keeps the write-up in front of him; the
  Approval Queue card taught to show the newest entry instead of raw sentinels.
  No SQL, no migration. Also removed the "Catch this moment" FAB from My Numbers
  (see [[my-numbers]]).
