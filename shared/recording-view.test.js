/* ============================================================
   recording-view.test.js — the ONE call-recording player (Inbox slice 2b).
   Locks: the links fetch (batches of 50, failures skipped), the ▶ Play button
   in its three states + nothing for no recording, the player (tap again = stop,
   ONE fresh link when the 5-min link expired), and the tray card's inline player
   (ready / pending / failed / no recording — "No recording", never "arrives …"
   forever — / test call / one fresh link on a playback error). Plus: every place
   on the advisor board uses it, and the old copies are gone.
   Wiring: docs/wiring/recordings-audio.md §3.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LINKS_BATCH, NO_RECORDING_AFTER_MS, cleanCallIds, fetchRecordingIndex, recButtonHtml,
  createButtonPlayer, inlineRecordingView, loadInlineRecording,
} from './recording-view.js';
import { describeEntry } from './recording-player.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), 'utf8');
const NOW = Date.parse('2026-09-25T18:00:00Z');

const READY = { call_id: 7, status: 'ready', duration_seconds: 83, playback_url: 'https://x/s1' };
const PENDING = { call_id: 8, status: 'pending' };
const FAILED = { call_id: 9, status: 'failed' };
const ok = (results) => ({ ok: true, status: 200, json: async () => ({ results }) });

/* ── the links fetch ────────────────────────────────────────────────────── */

test('fetchRecordingIndex: ids cleaned, batches of 50, a failed batch is skipped (never thrown)', async () => {
  assert.deepEqual(cleanCallIds([3, '3', 4, 0, -1, 'x', 2.5, null, 5]), [3, 4, 5]);
  const seen = [];
  const ids = Array.from({ length: 120 }, (_, i) => i + 1);
  const idx = await fetchRecordingIndex(ids, async (batch) => {
    seen.push(batch.length);
    if (batch[0] === 51) return { ok: false, status: 502 };                  // middle batch fails
    return ok(batch.map((id) => ({ call_id: id, status: 'pending' })));
  }, 'test');
  assert.equal(LINKS_BATCH, 50);
  assert.deepEqual(seen, [50, 50, 20]);
  assert.equal(Object.keys(idx).length, 70, 'the failed batch just has no recordings');
  assert.ok(idx['1'] && idx['120'] && !idx['51']);
  assert.deepEqual(await fetchRecordingIndex([], async () => { throw new Error('never'); }), {});
  assert.deepEqual(await fetchRecordingIndex([1], async () => { throw new Error('offline'); }), {});
});

/* ── the ▶ Play button: three states + nothing ──────────────────────────── */

test('the button: ready = a play button, pending = a disabled "Recording…", failed = a quiet marker, no recording = nothing', () => {
  const ready = recButtonHtml(describeEntry(READY), 7);
  assert.match(ready, /^<button type="button" class="rec-btn rec-ready" data-rec-play="7" aria-label="Play call recording, 1:23 long">▶ Play \(1:23\)<\/button>$/);
  assert.match(recButtonHtml(describeEntry(PENDING), 8), /^<span class="rec-btn rec-pending" title="[^"]+" aria-label="[^"]+">● Recording…<\/span>$/);
  assert.match(recButtonHtml(describeEntry(FAILED), 9), /^<span class="rec-marker" title="[^"]+">Recording unavailable<\/span>$/);
  assert.equal(recButtonHtml(describeEntry(null), 10), '');
  assert.equal(recButtonHtml(null, 10), '');
  assert.doesNotMatch(recButtonHtml(describeEntry(READY), '"><script>'), /<script>/, 'escaped');
});

/* ── the player: tap again = stop; ONE fresh link when the link expired ── */

function fakeAudio({ failSrc = [] } = {}) {
  const ls = {};
  const a = {
    src: '', paused: true, plays: [],
    addEventListener: (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); },
    emit: (ev) => (ls[ev] || []).forEach((fn) => fn()),
    async play() { a.plays.push(a.src); if (failSrc.includes(a.src)) throw new Error('403 expired'); a.paused = false; },
    pause() { a.paused = true; a.emit('pause'); },
  };
  return a;
}
const fakeBtn = () => { const c = new Set(); return { classList: { add: (x) => c.add(x), remove: (x) => c.delete(x), has: (x) => c.has(x) } }; };

test('the player plays the remembered link; tapping the playing button stops it; a second button stops the first', async () => {
  const audio = fakeAudio();
  let fetches = 0;
  const P = createButtonPlayer({ getAudio: () => audio, fetchIndex: async () => { fetches++; return {}; } });
  P.remember(7, describeEntry(READY));
  const b1 = fakeBtn(), b2 = fakeBtn();
  await P.play(7, b1);
  assert.deepEqual(audio.plays, ['https://x/s1']);
  assert.equal(b1.classList.has('playing'), true);
  assert.equal(fetches, 0, 'no fetch when the link is fresh');
  await P.play(7, b1);                                       // tap again → stop
  assert.equal(audio.paused, true);
  assert.equal(b1.classList.has('playing'), false, 'pause clears the highlight');
  P.remember(8, describeEntry({ ...READY, call_id: 8, playback_url: 'https://x/s2' }));
  await P.play(7, b1); await P.play(8, b2);
  assert.equal(b1.classList.has('playing'), false);
  assert.equal(b2.classList.has('playing'), true);
  audio.emit('ended');
  assert.equal(b2.classList.has('playing'), false, 'ended clears the highlight');
});

test('an EXPIRED link: the play fails → ONE fresh link is fetched and played; a second failure gives up quietly', async () => {
  const audio = fakeAudio({ failSrc: ['https://x/old'] });
  const asked = [];
  const P = createButtonPlayer({ getAudio: () => audio, fetchIndex: async (ids) => { asked.push(ids); return { 7: { ...READY, playback_url: 'https://x/new' } }; } });
  P.remember(7, describeEntry({ ...READY, playback_url: 'https://x/old' }));
  const b = fakeBtn();
  await P.play(7, b);
  assert.deepEqual(audio.plays, ['https://x/old', 'https://x/new']);
  assert.deepEqual(asked, [[7]], 'exactly one fresh link');
  assert.equal(b.classList.has('playing'), true);
  assert.equal(P.descriptor(7).playbackUrl, 'https://x/new', 'the fresh link is remembered');

  const dead = fakeAudio({ failSrc: ['https://x/old', 'https://x/new'] });
  const P2 = createButtonPlayer({ getAudio: () => dead, fetchIndex: async () => ({ 7: { ...READY, playback_url: 'https://x/new' } }) });
  P2.remember(7, describeEntry({ ...READY, playback_url: 'https://x/old' }));
  const b2 = fakeBtn();
  await P2.play(7, b2);
  assert.equal(dead.plays.length, 2, 'never a third try');
  assert.equal(b2.classList.has('playing'), false);
  // Never drawn (e.g. a pending row that became ready) → it asks for a link first.
  const P3 = createButtonPlayer({ getAudio: () => fakeAudio(), fetchIndex: async () => ({}) });
  const b3 = fakeBtn();
  await P3.play(99, b3);
  assert.equal(b3.classList.has('playing'), false, 'no recording → nothing plays');
});

test('paint(): draws a cell and remembers it; reset() forgets', () => {
  const P = createButtonPlayer({ getAudio: () => null, fetchIndex: async () => ({}) });
  const cell = { innerHTML: 'old' };
  P.paint(cell, { 7: READY }, '7');
  assert.match(cell.innerHTML, /rec-ready/);
  assert.equal(P.descriptor(7).state, 'ready');
  P.paint(cell, {}, '10');
  assert.equal(cell.innerHTML, '', 'no recording → empty cell');
  P.reset();
  assert.equal(P.descriptor(7), null);
});

/* ── the tray card's inline player ──────────────────────────────────────── */

test('tray card: ready → inline <audio controls>; pending → "arrives a few minutes…"; failed → "couldn\'t be fetched"; test call', () => {
  const r = inlineRecordingView(describeEntry(READY), { callId: 7, startedMs: NOW - 3600e3, nowMs: NOW });
  assert.equal(r.state, 'ready');
  assert.match(r.html, /🎧 Recording · ▶ Play \(1:23\)<\/div><audio class="cc-rec-audio" controls preload="none" src="https:\/\/x\/s1"><\/audio>/);
  const p = inlineRecordingView(describeEntry(PENDING), { callId: 8, startedMs: NOW - 3600e3, nowMs: NOW });
  assert.deepEqual([p.state, /arrives a few minutes after the call ends/.test(p.html)], ['pending', true]);
  const f = inlineRecordingView(describeEntry(FAILED), { callId: 9, nowMs: NOW });
  assert.deepEqual([f.state, /couldn't be fetched/.test(f.html)], ['failed', true]);
  assert.equal(inlineRecordingView(null, { callId: null }).state, 'test');
  assert.match(inlineRecordingView(null, { callId: null }).html, /none \(test call\)/);
});

test('tray card, NO recording row: "shows up after the call ends" in the first 30 min, then "No recording" — never "arrives a few minutes…" forever', () => {
  const none = describeEntry(null);
  const young = inlineRecordingView(none, { callId: 5, startedMs: NOW - 5 * 60e3, nowMs: NOW });
  assert.equal(young.state, 'waiting');
  assert.match(young.html, /shows up after the call ends/);
  const old = inlineRecordingView(none, { callId: 5, startedMs: NOW - NO_RECORDING_AFTER_MS - 1, nowMs: NOW });
  assert.equal(old.state, 'none');
  assert.match(old.html, /🎧 No recording/);
  assert.equal(inlineRecordingView(none, { callId: 5, startedMs: NaN, nowMs: NOW }).state, 'none', 'no start time → no guessing');
  for (const v of [young, old]) assert.doesNotMatch(v.html, /arrives a few minutes/);
  assert.equal(NO_RECORDING_AFTER_MS, 30 * 60 * 1000);
});

function fakeBox() {
  const box = { dataset: {}, _html: '', audio: null };
  Object.defineProperty(box, 'innerHTML', {
    get: () => box._html,
    set: (h) => { box._html = h; box.audio = /<audio/.test(h) ? fakeAudio() : null; },
  });
  box.querySelector = (sel) => (sel === 'audio' ? box.audio : null);
  return box;
}

test('loadInlineRecording: fills the box, keeps a ready player, and fetches ONE fresh link on a playback error', async () => {
  const box = fakeBox();
  let n = 0;
  const fetchIndex = async () => { n++; return { 7: { ...READY, playback_url: `https://x/s${n}` } }; };
  const call = { id: 7, started_at: new Date(NOW - 3600e3).toISOString() };
  assert.equal(await loadInlineRecording(box, call, fetchIndex, NOW), 'ready');
  assert.match(box.innerHTML, /src="https:\/\/x\/s1"/);
  assert.equal(await loadInlineRecording(box, call, fetchIndex, NOW), 'ready');
  assert.equal(n, 1, 'a ready player is kept (the 45 s re-check does not refetch it)');
  const first = box.audio;
  first.emit('error');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n, 2, 'one fresh link');
  assert.match(box.innerHTML, /src="https:\/\/x\/s2"/);
  box.audio.emit('error');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n, 2, 'only once per card');

  const empty = fakeBox();
  assert.equal(await loadInlineRecording(empty, call, async () => ({}), NOW), 'none');
  assert.match(empty.innerHTML, /No recording/);
  const test0 = fakeBox();
  assert.equal(await loadInlineRecording(test0, { id: null }, async () => { throw new Error('never'); }, NOW), 'test');
});

/* ── every place uses it; the old copies are gone ───────────────────────── */

test('static: the advisor board has ONE links reader and every recording place uses the shared player', () => {
  const board = src('../advisor-board.html');
  const code = board.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal((code.match(/'\/api\/recording-links'/g) || []).length, 1, 'one call site: cdRecordingIndex');
  assert.match(code, /function cdRecordingIndex\(callIds, tag\) \{[\s\S]*?cdAuthFetch\(db, '\/api\/recording-links'/);
  assert.match(code, /import \* as RecordingView from '\.\/shared\/recording-view\.js';\s*window\.RecordingPlayer = RecordingPlayer;\s*window\.RecordingView = RecordingView;/);
  // The four places.
  assert.match(code, /const deskRec = cdRecordingPlayer\('deskRecAudio', 'desk'\);/, 'Call Log');
  assert.match(code, /const roRec = cdRecordingPlayer\('cdRoRecAudio', 'CdRO'\);/, 'RO Call History');
  assert.match(code, /const custRec = cdRecordingPlayer\('custRecAudio', 'cust'\);/, 'customer record');
  assert.match(code, /custRecIdx = await cdRecordingIndex\(custRecCallsAll\.map\(c => c\.id\), 'cust'\);/);
  assert.match(code, /return RV\.loadInlineRecording\(el, card\._call \|\| \{\}, \(ids\) => cdRecordingIndex\(ids, 'callerCard'\)\);/, 'tray call card');
  // The old copies.
  for (const gone of ['fetchRecordingLinks', 'remintRecordingUrl', 'playRecording(', 'recPlayingBtn', 'recStateByCall',
    'fetchRoRecordingLinks', 'remintRoRecordingUrl', 'playRoRecording', 'roRecPlayingBtn', 'roRecStateByCall',
    'fetchCustRecLinks', 'remintCustRec', 'playCustRec', 'custRecPlayingBtn', 'custRecState']) {
    assert.ok(!code.includes(gone), `old copy left: ${gone}`);
  }
  // The tray card keeps its 45 s re-check until ready.
  assert.match(code, /if \(await loadCardRecording\(card\) === 'ready'\) clearInterval\(timer\);\s*\}, 45000\);/);
});

test('static: the shared player reads nothing itself and writes nothing', () => {
  const m = src('recording-view.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(m, /\bfetch\(|\bdb\b|\.from\(|supabase|recordings'|\bdocument\.|\bwindow\./);
});
