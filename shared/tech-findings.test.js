/* ============================================================
   tech-findings.test.js — the append-not-overwrite history that lives
   inside one text column.
   Run: npm test   (node --test)
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEP, sanitizeBody, sanitizeName, formatHeader, formatEntry, parseFindings,
  wrapLegacy, prependEntry, replaceNewestEntry, canEditNewest, newestBody, entryCount,
} from './tech-findings.js';

const T1 = '2026-08-20T14:10:00.000Z';
const T2 = '2026-08-25T09:30:00.000Z';
const T3 = '2026-08-25T16:45:00.000Z';

// ── the delimiter cannot be forged ────────────────────────────
test('a body containing the separator is STRIPPED, so a header cannot be forged', () => {
  const evil = `real text\n${SEP} FINDINGS ${SEP} by=Somebody Else ${SEP} at=${T1} ${SEP}\nfake entry`;
  const raw = prependEntry('', 'Manny', T2, evil);
  assert.equal(parseFindings(raw).length, 1, 'the typed fake header must not become a second entry');
  assert.equal(parseFindings(raw)[0].name, 'Manny');
  assert.equal(raw.split(SEP).length - 1, 4, 'only the ONE real header carries separators');
});

test('a separator in the NAME is stripped too — the header stays parseable', () => {
  const raw = prependEntry('', `Man${SEP}ny ${SEP} by=x`, T2, 'body');
  assert.equal(parseFindings(raw)[0].name, 'Manny  by=x');
  assert.equal(parseFindings(raw)[0].body, 'body');
});

test('sanitizeBody normalises CRLF so a phone keyboard cannot break the line anchors', () => {
  assert.equal(sanitizeBody('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(sanitizeName('Man\nny'), 'Man ny');
});

// ── parsing ───────────────────────────────────────────────────
test('an empty or blank column parses to no entries at all (rule 6: no empty heading)', () => {
  assert.deepEqual(parseFindings(''), []);
  assert.deepEqual(parseFindings(null), []);
  assert.deepEqual(parseFindings('   \n  '), []);
  assert.equal(entryCount(''), 0);
});

test('one headed entry round-trips name, timestamp and a multi-line body', () => {
  const raw = formatEntry('Manny', T2, 'line one\nline two');
  const [e] = parseFindings(raw);
  assert.equal(e.name, 'Manny');
  assert.equal(e.at, T2);
  assert.equal(e.body, 'line one\nline two');
  assert.equal(e.headed, true);
});

test('entries come back NEWEST FIRST, in stored order', () => {
  let raw = prependEntry('', 'Manny', T1, 'first');
  raw = prependEntry(raw, 'Alnardier', T2, 'second');
  raw = prependEntry(raw, 'Manny', T3, 'third');
  assert.deepEqual(parseFindings(raw).map((e) => e.body), ['third', 'second', 'first']);
  assert.equal(newestBody(raw), 'third');
  assert.equal(entryCount(raw), 3);
});

// ── legacy rows (what is sitting on prod today) ───────────────
test('bare legacy text parses as ONE entry with NO name and NO date — never invented', () => {
  const [e] = parseFindings('valve body is toast, needs a rebuild');
  assert.equal(e.headed, false);
  assert.equal(e.name, null, 'the author was never recorded — do not guess it');
  assert.equal(e.at, null);
  assert.equal(e.body, 'valve body is toast, needs a rebuild');
});

test('wrapLegacy dates the old text from diagnosis_submitted_at and gives it NO byline', () => {
  const raw = wrapLegacy('old words', T1);
  const [e] = parseFindings(raw);
  assert.equal(e.at, T1, 'the date is real — it comes from the column');
  assert.equal(e.name, null, 'the name is omitted, not inferred from repair_orders.technician');
  assert.equal(e.body, 'old words');
});

test('wrapLegacy with no known date yields an entry that still parses, undated', () => {
  const [e] = parseFindings(wrapLegacy('old words', null));
  assert.equal(e.at, null);
  assert.equal(e.body, 'old words');
});

test('wrapLegacy is idempotent — already-headed text is returned untouched', () => {
  const once = wrapLegacy('old words', T1);
  assert.equal(wrapLegacy(once, T2), once, 'a second wrap must not nest headers');
});

test('a follow-up onto legacy text wraps the old words FIRST, keeping their real date', () => {
  const raw = prependEntry('old words', 'Manny', T2, 'new findings', T1);
  const e = parseFindings(raw);
  assert.deepEqual(e.map((x) => [x.name, x.at, x.body]), [
    ['Manny', T2, 'new findings'],
    [null, T1, 'old words'],
  ]);
});

test('a legacy lead is sorted LAST, not first — new entries are prepended above it', () => {
  const raw = 'the oldest words\n\n' + formatEntry('Manny', T2, 'newer');
  assert.deepEqual(parseFindings(raw).map((e) => e.body), ['newer', 'the oldest words']);
});

// ── THE DOUBLING TRAP ─────────────────────────────────────────
test('THE TRAP: submitting the WHOLE history back does not double it — bodies stay distinct', () => {
  // Before this slice the tech's textarea was seeded with the stored column,
  // so a submit re-sent the entire history. The seed is now empty; this pins
  // that even a re-sent history cannot forge headers and re-nest itself.
  let raw = prependEntry('', 'Manny', T1, 'first');
  const resent = raw;                          // what the old prefilled box would send
  raw = prependEntry(raw, 'Manny', T2, resent);
  const e = parseFindings(raw);
  assert.equal(e.length, 2, 'the re-sent text is ONE new body, not a re-parsed history');
  assert.equal(e[1].body, 'first', 'the original entry is still intact underneath');
  assert.ok(!e[0].body.includes(SEP), 'the re-sent headers were stripped out of the new body');
});

// ── empty bodies ──────────────────────────────────────────────
test('a codes-only submit (empty body) adds NO entry', () => {
  const base = prependEntry('', 'Manny', T1, 'first');
  assert.equal(prependEntry(base, 'Manny', T2, ''), base);
  assert.equal(prependEntry(base, 'Manny', T2, '   \n '), base);
  assert.equal(entryCount(prependEntry(base, 'Manny', T2, '')), 1);
});

test('a codes-only submit on an EMPTY column stays empty — no blank first entry', () => {
  assert.equal(prependEntry('', 'Manny', T1, ''), '');
  assert.deepEqual(parseFindings(prependEntry('', 'Manny', T1, '')), []);
});

// ── EDIT ──────────────────────────────────────────────────────
test('edit rewrites the newest entry IN PLACE — no new entry appears', () => {
  let raw = prependEntry('', 'Manny', T1, 'first');
  raw = prependEntry(raw, 'Manny', T2, 'secnod typo');
  const edited = replaceNewestEntry(raw, 'Manny', T3, 'second, fixed');
  const e = parseFindings(edited);
  assert.equal(e.length, 2, 'still two entries');
  assert.equal(e[0].body, 'second, fixed');
  assert.equal(e[1].body, 'first', 'the older entry is untouched by an edit');
});

test('edit stamps the header with the time of THIS write and the editing tech', () => {
  const raw = prependEntry('', 'Manny', T2, 'typo');
  const edited = replaceNewestEntry(raw, 'Alnardier', T3, 'fixed');
  const [e] = parseFindings(edited);
  assert.equal(e.at, T3, 'the header answers when these words were last written');
  assert.equal(e.name, 'Alnardier', 'after an edit the words are the editor\'s');
});

test('edit preserves older entries verbatim, including their names and dates', () => {
  let raw = prependEntry('', 'Manny', T1, 'first');
  raw = prependEntry(raw, 'Alnardier', T2, 'second');
  const e = parseFindings(replaceNewestEntry(raw, 'Alnardier', T3, 'second v2'));
  assert.deepEqual(e.map((x) => [x.name, x.at, x.body]), [
    ['Alnardier', T3, 'second v2'],
    ['Manny', T1, 'first'],
  ]);
});

test('editing a LEGACY entry gives it a header for the first time, carrying the editor', () => {
  const e = parseFindings(replaceNewestEntry('old bare words', 'Manny', T3, 'rewritten'));
  assert.equal(e.length, 1);
  assert.equal(e[0].name, 'Manny', 'he just rewrote those words, so they are his now');
  assert.equal(e[0].body, 'rewritten');
});

test('an EMPTY edit destroys nothing — the entry it was meant to correct survives', () => {
  const raw = prependEntry('', 'Manny', T2, 'real findings');
  assert.equal(parseFindings(replaceNewestEntry(raw, 'Manny', T3, ''))[0].body, 'real findings');
});

test('edit on an empty column simply creates the first entry', () => {
  const e = parseFindings(replaceNewestEntry('', 'Manny', T2, 'first words'));
  assert.deepEqual(e.map((x) => [x.name, x.body]), [['Manny', 'first words']]);
});

// ── THE LOCK ──────────────────────────────────────────────────
test('THE LOCK: edit is allowed only while the advisor has NOT opened it', () => {
  assert.equal(canEditNewest({ diagnosis_reviewed_at: null }), true);
  assert.equal(canEditNewest({ diagnosis_reviewed_at: undefined }), true);
  assert.equal(canEditNewest({ diagnosis_reviewed_at: T3 }), false,
    'once the writer has quoted from these words they must not change under him');
  assert.equal(canEditNewest(null), false);
});

// ── the Approval Queue card ───────────────────────────────────
test('the queue card shows the NEWEST body only — never a raw sentinel', () => {
  let raw = prependEntry('', 'Manny', T1, 'first');
  raw = prependEntry(raw, 'Manny', T2, 'newest');
  assert.equal(newestBody(raw), 'newest');
  assert.ok(!newestBody(raw).includes(SEP));
});

test('the queue card degrades cleanly on legacy and empty columns', () => {
  assert.equal(newestBody('bare legacy text'), 'bare legacy text');
  assert.equal(newestBody(''), '');
  assert.equal(newestBody(null), '');
});

// ── shapes that could break the parse ─────────────────────────
test('a body that merely MENTIONS the word FINDINGS is not a header', () => {
  const raw = prependEntry('', 'Manny', T2, 'FINDINGS: see photos\nby=me at=now');
  assert.equal(parseFindings(raw).length, 1);
  assert.equal(parseFindings(raw)[0].body, 'FINDINGS: see photos\nby=me at=now');
});

test('a header with a name containing spaces still yields the right timestamp', () => {
  const [e] = parseFindings(formatEntry('Jean Baptiste Pierre', T2, 'body'));
  assert.equal(e.name, 'Jean Baptiste Pierre');
  assert.equal(e.at, T2);
});

test('a header with an empty body parses as an entry with an empty body, not a merge', () => {
  const raw = formatEntry('Manny', T2, '') + '\n\n' + formatEntry('Manny', T1, 'older');
  const e = parseFindings(raw);
  assert.equal(e.length, 2);
  assert.equal(e[0].body, '');
  assert.equal(e[1].body, 'older');
});

test('formatHeader shape is exactly what the regex expects', () => {
  assert.equal(formatHeader('Manny', T2), `${SEP} FINDINGS ${SEP} by=Manny ${SEP} at=${T2} ${SEP}`);
});

test('three edits and two follow-ups leave exactly three entries', () => {
  let raw = prependEntry('', 'Manny', T1, 'a');
  raw = replaceNewestEntry(raw, 'Manny', T1, 'a2');
  raw = prependEntry(raw, 'Manny', T2, 'b');
  raw = replaceNewestEntry(raw, 'Manny', T2, 'b2');
  raw = replaceNewestEntry(raw, 'Manny', T2, 'b3');
  raw = prependEntry(raw, 'Manny', T3, 'c');
  assert.deepEqual(parseFindings(raw).map((e) => e.body), ['c', 'b3', 'a2']);
});
