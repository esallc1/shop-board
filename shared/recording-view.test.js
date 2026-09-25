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
  createButtonPlayer, closeOpenPlayer, openPlayerInfo, inlineRecordingView, loadInlineRecording,
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

/* ── the player: the browser's own <audio controls>, opened in place ──── */

function fakeAudio({ failSrc = [] } = {}) {
  const ls = {};
  const a = {
    src: '', paused: true, plays: [], controls: false, preload: '', attrs: {}, parentNode: null,
    get isConnected() { return isConnected(a); },
    setAttribute: (k, v) => { a.attrs[k] = v; },
    removeAttribute: (k) => { if (k === 'src') a.src = ''; delete a.attrs[k]; },
    load() {},
    addEventListener: (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); },
    emit: (ev) => Promise.all((ls[ev] || []).map((fn) => fn())),
    async play() {
      a.plays.push(a.src);
      if (failSrc.includes(a.src)) { setTimeout(() => a.emit('error'), 0); throw new Error('NotSupportedError'); }
      a.paused = false;
    },
    pause() { a.paused = true; },
  };
  return a;
}
// A tiny DOM: elements with a parent, replaceWith / appendChild, and "on the page" = reaches a root.
function isConnected(el) { let n = el; while (n) { if (n.isRoot) return true; n = n.parentNode; } return false; }
function el(tag) {
  const e = { tag, className: '', children: [], parentNode: null,
    get isConnected() { return isConnected(e); },
    appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
    replaceWith(n) { const p = e.parentNode; if (!p) return; const i = p.children.indexOf(e); p.children[i] = n; n.parentNode = p; e.parentNode = null; },
  };
  return e;
}
function fakeDoc(audioOpts) {
  const made = [];
  return { made, createElement: (tag) => { const x = tag === 'audio' ? fakeAudio(audioOpts) : el(tag); made.push(x); return x; } };
}
// A row on the page holding a "▶ Play" button.
function row() { const root = el('page'); root.isRoot = true; const r = root.appendChild(el('row')); const btn = r.appendChild(el('button')); return { root, row: r, btn }; }
const tick = () => new Promise((r) => setTimeout(r, 5));

test('tap → the button is replaced IN PLACE by the built-in player (controls), playing the remembered link — no fetch', async () => {
  closeOpenPlayer();
  let fetches = 0;
  const doc = fakeDoc();
  const P = createButtonPlayer({ place: 'desk', doc, fetchIndex: async () => { fetches++; return {}; } });
  P.remember(7, describeEntry(READY));
  const { row: r, btn } = row();
  await P.play(7, btn);
  const wrap = r.children[0];
  assert.equal(wrap.className, 'rec-player');
  const audio = wrap.children[0];
  assert.equal(audio.controls, true, 'the browser\'s own controls: play/pause, the bar, the time');
  assert.deepEqual(audio.plays, ['https://x/s1']);
  assert.equal(audio.paused, false);
  assert.equal(btn.parentNode, null, 'the button is out of the row');
  assert.equal(fetches, 0, 'no fetch when the link is fresh');
  assert.deepEqual(openPlayerInfo(), { place: 'desk', callId: '7' });
  closeOpenPlayer();
  assert.equal(r.children[0], btn, 'collapsed: the SAME button (its listeners) is back');
  assert.equal(audio.paused, true);
  assert.equal(openPlayerInfo(), null);
});

test('ONE open player on the whole board: opening another pauses + collapses the first, in any place', async () => {
  closeOpenPlayer();
  const doc = fakeDoc();
  const desk = createButtonPlayer({ place: 'desk', doc, fetchIndex: async () => ({}) });
  const cust = createButtonPlayer({ place: 'cust', doc, fetchIndex: async () => ({}) });
  desk.remember(7, describeEntry(READY));
  desk.remember(8, describeEntry({ ...READY, call_id: 8, playback_url: 'https://x/s2' }));
  cust.remember(9, describeEntry({ ...READY, call_id: 9, playback_url: 'https://x/s3' }));
  const a = row(), b = row(), c = row();
  await desk.play(7, a.btn);
  const first = a.row.children[0].children[0];
  await desk.play(8, b.btn);
  assert.equal(a.row.children[0], a.btn, 'the first is back to its button');
  assert.equal(first.paused, true, 'and paused');
  assert.equal(b.row.children[0].className, 'rec-player');
  await cust.play(9, c.btn);
  assert.equal(b.row.children[0], b.btn, 'another place closes it too');
  assert.deepEqual(openPlayerInfo(), { place: 'cust', callId: '9' });
  // Leaving a view: only that place's player (closeOpenPlayer(place)), or any (no place).
  assert.equal(closeOpenPlayer('desk'), false, 'the Call log closing leaves the customer record alone');
  assert.equal(closeOpenPlayer('cust'), true);
  assert.equal(c.row.children[0], c.btn);
  // A redraw of a place (reset) closes its open player.
  await desk.play(7, a.btn);
  desk.reset();
  assert.equal(a.row.children[0], a.btn);
  assert.equal(openPlayerInfo(), null);
});

test('an EXPIRED link: the player errors → ONE fresh link into the same player; a second failure collapses back to the button', async () => {
  closeOpenPlayer();
  const asked = [];
  const doc = fakeDoc({ failSrc: ['https://x/old'] });
  const P = createButtonPlayer({ place: 'CdRO', doc, fetchIndex: async (ids) => { asked.push(ids); return { 7: { ...READY, playback_url: 'https://x/new' } }; } });
  P.remember(7, describeEntry({ ...READY, playback_url: 'https://x/old' }));
  const { row: r, btn } = row();
  await P.play(7, btn);
  await tick();
  const audio = r.children[0].children[0];
  assert.deepEqual(audio.plays, ['https://x/old', 'https://x/new']);
  assert.deepEqual(asked, [[7]], 'exactly one fresh link');
  assert.equal(audio.paused, false, 'playing the fresh link');
  assert.equal(P.descriptor(7).playbackUrl, 'https://x/new', 'the fresh link is remembered');
  closeOpenPlayer();

  const dead = fakeDoc({ failSrc: ['https://x/old', 'https://x/new'] });
  const P2 = createButtonPlayer({ place: 'CdRO', doc: dead, fetchIndex: async () => ({ 7: { ...READY, playback_url: 'https://x/new' } }) });
  P2.remember(7, describeEntry({ ...READY, playback_url: 'https://x/old' }));
  const two = row();
  await P2.play(7, two.btn);
  await tick(); await tick();
  const a2 = dead.made.find((x) => x.plays);
  assert.equal(a2.plays.length, 2, 'never a third try');
  assert.equal(two.row.children[0], two.btn, 'gave up: the button is back');
  assert.equal(openPlayerInfo(), null);
});

test('no link at all → the button stays, nothing opens; a player redrawn off the page stops itself', async () => {
  closeOpenPlayer();
  const doc = fakeDoc();
  const P = createButtonPlayer({ place: 'cust', doc, fetchIndex: async () => ({}) });
  const one = row();
  await P.play(99, one.btn);
  assert.equal(one.row.children[0], one.btn);
  assert.equal(openPlayerInfo(), null);
  // The customer record re-draws its body: the row (and the open player) leave the page.
  P.remember(7, describeEntry(READY));
  await P.play(7, one.btn);
  const audio = one.row.children[0].children[0];
  one.row.parentNode.children.length = 0; one.row.parentNode = null;   // redrawn away
  await audio.emit('timeupdate');
  assert.equal(audio.paused, true, 'no invisible audio keeps talking');
  assert.equal(openPlayerInfo(), null);
});

test('the latest tap wins: a slow fresh-link fetch can not open a second player', async () => {
  closeOpenPlayer();
  const doc = fakeDoc();
  let release;
  const slow = new Promise((r) => { release = r; });
  const P = createButtonPlayer({ place: 'desk', doc, fetchIndex: async (ids) => { if (ids[0] === 1) await slow; return { [ids[0]]: { ...READY, call_id: ids[0], playback_url: `https://x/${ids[0]}` } }; } });
  const a = row(), b = row();
  const first = P.play(1, a.btn);            // no remembered link → fetches (slowly)
  P.remember(2, describeEntry({ ...READY, call_id: 2, playback_url: 'https://x/2' }));
  await P.play(2, b.btn);                     // tapped second, opens at once
  release(); await first;
  assert.equal(a.row.children[0], a.btn, 'the slow first tap does not open');
  assert.deepEqual(openPlayerInfo(), { place: 'desk', callId: '2' });
  closeOpenPlayer();
});

test('paint(): draws a cell and remembers it; reset() forgets', () => {
  const P = createButtonPlayer({ place: 'desk', doc: fakeDoc(), fetchIndex: async () => ({}) });
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
  // "ready" but no link could be signed (file missing from storage) → not "arrives …" either.
  const unsigned = inlineRecordingView(describeEntry({ ...READY, playback_url: null }), { callId: 7, nowMs: NOW });
  assert.deepEqual([unsigned.state, /couldn't be fetched/.test(unsigned.html), /arrives/.test(unsigned.html)], ['failed', true, false]);
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
  assert.match(code, /const deskRec = cdRecordingPlayer\('desk'\);/, 'Call Log');
  assert.match(code, /const roRec = cdRecordingPlayer\('CdRO'\);/, 'RO Call History');
  assert.match(code, /const custRec = cdRecordingPlayer\('cust'\);/, 'customer record');
  // The built-in player replaced the hidden <audio> per place; leaving collapses it.
  assert.doesNotMatch(code, /deskRecAudio|cdRoRecAudio|custRecAudio/, 'no hidden per-place <audio> left');
  assert.match(code, /function closeLog\(\) \{ closeAttach\(\); cdRecordingStop\('desk'\);/, 'closing the Call log');
  assert.equal((code.match(/cdRecordingStop\('CdRO'\);/g) || []).length, 2, 'another RO / leaving the RO');
  assert.equal((code.match(/cdRecordingStop\('cust'\);/g) || []).length, 3, 'customer list / back / reload');
  assert.match(code, /i\.addEventListener\('click', \(\) => cdRecordingStop\(\)\)\);/, 'any sidebar navigation');
  assert.match(code, /\.rec-player audio \{/);
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
