/* ============================================================
   tech-findings.js — the tech's write-up, APPENDED not overwritten,
   inside the SINGLE existing `repair_orders.diagnosis_recommendation`
   text column. No history table, no migration, no schema change.

   WHY THIS EXISTS AT ALL
   Until 2026-08-25 a second SUBMIT overwrote the column and the first
   write-up was gone forever — no copy, no audit, nothing. The advisor
   also only ever saw it once, in the Approval Queue card, which "Open
   in RO Board →" then dismissed. So the words a tech wrote were both
   destructible and invisible.

   ONE MODULE, TWO WRITERS, ONE READER. my-numbers.html formats and
   writes; advisor-board.html parses and renders. If those two ever
   disagreed about the format, entries would silently merge or vanish —
   which is exactly the failure this module exists to make impossible.
   Everything here is pure and tested; nothing touches the DB.

   THE FORMAT
     ␞ FINDINGS ␞ by=<name> ␞ at=<ISO-8601> ␞
     <body, verbatim, may span lines>
     (blank line)
     ␞ FINDINGS ␞ by=<name> ␞ at=<ISO-8601> ␞
     <older body>

   Newest first. Text sitting ABOVE the first sentinel is a LEGACY entry
   — everything written before this slice has no header (see wrapLegacy).
   ============================================================ */

/* U+241E SYMBOL FOR RECORD SEPARATOR. Chosen over the real control
   character U+001E for two reasons that matter in practice:

     1. It is PRINTABLE. You can eyeball and grep this column in the
        Supabase SQL editor. A true control char parses just as well and
        is undebuggable by hand, and anything that sanitises control
        characters in transit would silently eat it.
     2. It is NOT REACHABLE on an iOS or Android keyboard, in EN or ES,
        including the emoji picker. A tech cannot type it by accident.

   But rarity is NOT the guarantee — sanitizeBody() STRIPS it from every
   body before writing, so a forged header is impossible by construction
   rather than merely unlikely. That distinction is the whole point: a
   delimiter that is only improbable eventually collides. */
export const SEP = '␞';

export const HEADER_PREFIX = SEP + ' FINDINGS ' + SEP;

/* Anchored to line start AND line end, multiline. `by=` is non-greedy and
   `at=` is \S* so a name containing spaces cannot swallow the timestamp,
   and an empty `at=` (a legacy wrap with no known date) still parses. */
const HEADER_RE = new RegExp(
  '^' + SEP + ' FINDINGS ' + SEP + ' by=(.*?) ' + SEP + ' at=(\\S*) ' + SEP + '$',
);
const HEADER_RE_G = new RegExp(HEADER_RE.source, 'gm');

/* Strip every separator from text a human typed, and normalise the line
   endings so a phone keyboard's \r\n cannot break the line-anchored parse.
   Called on EVERY body before it is written. */
export function sanitizeBody(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split(SEP).join('')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// A display name with separators (and newlines) removed — a name lands in
// the header itself, so it gets the same treatment as a body.
export function sanitizeName(name) {
  const n = String(name == null ? '' : name).replace(/[\r\n]+/g, ' ').split(SEP).join('').trim();
  return n;
}

export function formatHeader(name, at) {
  return HEADER_PREFIX + ' by=' + sanitizeName(name) + ' ' + SEP +
         ' at=' + String(at == null ? '' : at).trim() + ' ' + SEP;
}

export function formatEntry(name, at, body) {
  return formatHeader(name, at) + '\n' + sanitizeBody(body);
}

/* Split a raw column value into entries, NEWEST FIRST (which is the order
   they are stored in). Every entry is
     { name, at, body, headed }
   with `name` and `at` null when unknown — never invented, never inferred.
   `headed:false` means the text predates this slice. */
export function parseFindings(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const marks = [];
  HEADER_RE_G.lastIndex = 0;
  let m;
  while ((m = HEADER_RE_G.exec(text)) !== null) {
    marks.push({ start: m.index, end: m.index + m[0].length, name: m[1], at: m[2] });
    // A zero-length match cannot happen here (the literal prefix is
    // non-empty), but guard anyway so a future format change cannot spin.
    if (HEADER_RE_G.lastIndex === m.index) HEADER_RE_G.lastIndex++;
  }

  const out = [];
  // Anything before the FIRST header is a legacy, unheaded entry.
  const lead = (marks.length ? text.slice(0, marks[0].start) : text).trim();
  if (lead) out.push({ name: null, at: null, body: lead, headed: false });

  marks.forEach((mk, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.push({
      name: mk.name.trim() || null,
      at: mk.at.trim() || null,
      body: text.slice(mk.end, bodyEnd).trim(),
      headed: true,
    });
  });

  /* A legacy lead is the OLDEST thing in the column by definition — new
     entries are prepended above it — so it belongs last, not first. */
  if (out.length > 1 && !out[0].headed) out.push(out.shift());
  return out;
}

/* Give unheaded legacy text a header, using the timestamp the DB already
   holds (`diagnosis_submitted_at`) and NO NAME.

   The author is genuinely unrecorded — submitDiagnosis never wrote one
   before today — so the name is OMITTED rather than guessed. Stamping
   `repair_orders.technician` here would be an inference presented as a
   fact: that column is the ASSIGNED tech, written by a different action
   (assignTechCore), and it is not the same person whenever a job was
   reassigned after diagnosis. Same rule as `attachments.uploaded_by IS
   NULL` rendering the date alone rather than "· Unknown": nobody was
   recorded is not the same as an unknown person.

   Lazy by design — called only when an RO is next written, so a row that
   nobody touches again keeps its exact current bytes forever. There is no
   backfill and no migration in this slice. */
export function wrapLegacy(raw, submittedAt) {
  /* ⚠ TEST THE RAW TEXT FOR A HEADER **BEFORE** SANITISING IT.
     sanitizeBody strips every separator — that is its job, because it is
     meant for text a human typed. Running it first here destroyed the
     headers of an already-formatted column and then, finding no header,
     wrapped the wreckage as if it were legacy text: three entries collapsed
     into one mangled body, and every following write nested it deeper.
     Caught by "three edits and two follow-ups leave exactly three entries". */
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  HEADER_RE_G.lastIndex = 0;
  const alreadyHeaded = HEADER_RE_G.test(text);
  HEADER_RE_G.lastIndex = 0;
  if (alreadyHeaded) return text.trim();
  return formatEntry('', submittedAt || '', text);
}

/* ADD FOLLOW-UP — a new dated entry on top. The existing column is wrapped
   first if it is still bare, so the old words keep their real date instead
   of being absorbed into the new entry.

   Returns the FULL new column value. An empty body returns the base
   unchanged (wrapped): a submit carrying only DTC codes must not push a
   blank entry into the history. */
export function prependEntry(raw, name, at, body, legacyAt) {
  const base = wrapLegacy(raw, legacyAt);
  const clean = sanitizeBody(body);
  if (!clean) return base;
  const entry = formatEntry(name, at, clean);
  return base ? entry + '\n\n' + base : entry;
}

/* EDIT — rewrite the most recent entry IN PLACE. No new entry appears.
   For typos and corrections, and available to the tech ONLY while the
   advisor has not opened it (diagnosis_reviewed_at IS NULL) — see
   canEditNewest. The caller enforces that against the DB at write time as
   well; this function only does the text.

   THE HEADER TIMESTAMP BECOMES THE TIME OF THIS WRITE, and the name
   becomes the editing tech's. Chosen deliberately: the header answers
   "who wrote these words and when", and after an edit the words are his,
   as of now. The original submission time is NOT lost — it stays in
   `diagnosis_submitted_at`, which an edit does not touch, so the queue
   keeps ordering by when the job was first handed over.

   Editing a LEGACY entry gives it a header for the first time, carrying
   the editor's name — he just rewrote those words, so they are his now.

   An empty body deletes nothing: it returns the base unchanged, because
   "clear the box and submit" must not silently destroy the entry that the
   Edit was supposed to correct. */
export function replaceNewestEntry(raw, name, at, body, legacyAt) {
  const clean = sanitizeBody(body);
  if (!clean) return wrapLegacy(raw, legacyAt);
  const entries = parseFindings(raw);
  if (!entries.length) return formatEntry(name, at, clean);
  const rest = entries.slice(1).map((e) => (
    e.headed ? formatEntry(e.name || '', e.at || '', e.body) : formatEntry('', legacyAt || '', e.body)
  ));
  const head = formatEntry(name, at, clean);
  return [head].concat(rest).join('\n\n');
}

/* MAY THE TECH EDIT? Only while the advisor has not opened it.

   The reason is not tidiness. The advisor quotes a job from these words at
   11am; if they can change under him at 2pm with nothing telling him, the
   estimate he built no longer matches the findings it came from. Once the
   card has been opened, a follow-up — which is dated, stacked on top, and
   re-opens the queue card — is the only honest way to add something. */
export function canEditNewest(ro) {
  if (!ro) return false;
  return !ro.diagnosis_reviewed_at;
}

// The newest entry's body, for surfaces that show one line rather than a
// history — today that is the Approval Queue card, which rendered the raw
// column before this slice and would otherwise print sentinels at the
// service writer.
export function newestBody(raw) {
  const e = parseFindings(raw);
  return e.length ? e[0].body : '';
}

export function entryCount(raw) {
  return parseFindings(raw).length;
}
