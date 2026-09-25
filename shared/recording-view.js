/* ============================================================
   recording-view.js — the ONE call-recording player the advisor board uses
   (Inbox slice 2b, 2026-09-25). Wiring: docs/wiring/recordings-audio.md §3.

   shared/recording-player.js still DECIDES the state of a recording
   (ready / pending / failed / none) and stays pure. This module does the rest,
   once, for every place that shows a recording:
     - fetchRecordingIndex — asks api/recording-links (the ONLY reader; the
       board never touches the recordings table) for many call ids, in batches
       of 50 (the endpoint's cap);
     - recButtonHtml + createButtonPlayer — the ▶ Play button used by the Call
       Log, the RO's Call History and the customer record: one reused hidden
       <audio> per place, tap again = stop, a signed link that aged out (5 min)
       is fetched fresh ONCE;
     - inlineRecordingView + loadInlineRecording — the tray call card's inline
       <audio controls> player (pending → "arrives a few minutes after the call
       ends"; no recording at all → a short "No recording" once the call is
       old enough that one would have shown up; one fresh link on a playback error).

   No database, no writes. The network call is injected (`request`), so the
   board keeps its signed-in cdAuthFetch and the tests run without a browser.
   Nothing here touches the DOM at import time.
   ============================================================ */
import { indexResults, describeCallId } from './recording-player.js';

export const LINKS_BATCH = 50;                     // api/recording-links MAX_CALL_IDS
// A recordings row is created by the CTM "end" webhook when the call ends WITH
// audio. Until then there is simply no row. After this long from the call's start
// with still no row, there isn't going to be one → "No recording".
export const NO_RECORDING_AFTER_MS = 30 * 60 * 1000;

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Positive integer call ids, de-duplicated, in order.
export function cleanCallIds(callIds) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(callIds) ? callIds : []) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// → { [callId]: entry } (indexResults). request(ids) → a fetch Response (or
// anything with ok / status / json()). A failed batch is logged and skipped —
// its calls simply show no recording, never an error on the page.
export async function fetchRecordingIndex(callIds, request, tag = 'rec') {
  const ids = cleanCallIds(callIds);
  const idx = {};
  if (!ids.length || typeof request !== 'function') return idx;
  for (let i = 0; i < ids.length; i += LINKS_BATCH) {
    try {
      const r = await request(ids.slice(i, i + LINKS_BATCH));
      if (!r || !r.ok) { console.warn(`[${tag}] recording-links`, r && r.status); continue; }
      Object.assign(idx, indexResults(await r.json()));
    } catch (e) { console.warn(`[${tag}] recording-links failed`, e); }
  }
  return idx;
}

/* ── The ▶ Play button (Call Log · RO Call History · customer record) ───── */

// d = a recording-player descriptor. No recording → '' (no affordance).
export function recButtonHtml(d, callId, esc = escHtml) {
  if (!d || !d.render) return '';
  if (d.state === 'ready') return `<button type="button" class="rec-btn rec-ready" data-rec-play="${esc(callId)}" aria-label="${esc(d.aria)}">${esc(d.label)}</button>`;
  if (d.state === 'pending') return `<span class="rec-btn rec-pending" title="${esc(d.aria)}" aria-label="${esc(d.aria)}">${esc(d.label)}</span>`;
  return `<span class="rec-marker" title="${esc(d.aria)}">${esc(d.label)}</span>`;
}

// One per place. getAudio() → that place's hidden <audio>; fetchIndex(ids) → an index.
export function createButtonPlayer({ getAudio, fetchIndex }) {
  let state = {};              // call id (string) → descriptor last drawn
  let playingBtn = null;
  let wired = null;
  function wire() {
    const audio = getAudio();
    if (!audio || wired === audio) return audio;
    wired = audio;
    const clear = () => { if (playingBtn) playingBtn.classList.remove('playing'); };
    audio.addEventListener('ended', clear);
    audio.addEventListener('pause', clear);
    return audio;
  }
  // A fresh signed link for one call (they age out in 5 min). Updates the remembered descriptor.
  async function relink(callId) {
    const idx = await fetchIndex([callId]);
    const d = describeCallId(idx, callId);
    if (state[String(callId)]) state[String(callId)] = d;
    return d.playbackUrl || null;
  }
  const player = {
    fetchIndex,
    reset() { state = {}; wire(); },
    remember(callId, d) { if (d && d.render) state[String(callId)] = d; },
    descriptor: (callId) => state[String(callId)] || null,
    // Paint one cell and remember what it shows.
    paint(cell, idx, callId, esc = escHtml) {
      const d = describeCallId(idx, callId);
      player.remember(callId, d);
      cell.innerHTML = recButtonHtml(d, callId, esc);
      return d;
    },
    async play(callId, btn) {
      const audio = wire(); if (!audio) return;
      if (playingBtn === btn && !audio.paused) { audio.pause(); return; }       // tap the playing one → stop
      if (playingBtn && playingBtn !== btn) playingBtn.classList.remove('playing');
      playingBtn = btn;
      let url = (state[String(callId)] && state[String(callId)].playbackUrl) || null;
      if (!url) url = await relink(callId);                                   // opened > 5 min ago, or never minted
      if (!url) { btn.classList.remove('playing'); return; }
      const tryPlay = async (src) => { audio.src = src; await audio.play(); };
      try { await tryPlay(url); btn.classList.add('playing'); }
      catch (e) {
        // Most likely the signed link aged out between drawing and the tap → one fresh link.
        const fresh = await relink(callId);
        if (fresh) { try { await tryPlay(fresh); btn.classList.add('playing'); } catch (_) { btn.classList.remove('playing'); } }
        else btn.classList.remove('playing');
      }
    },
  };
  wire();
  return player;
}

/* ── The tray call card's inline player ─────────────────────────────────── */

// d = descriptor (or null when there's no call id); startedMs = the call's start.
// → { state: 'test'|'ready'|'pending'|'failed'|'waiting'|'none', html }
export function inlineRecordingView(d, { callId, startedMs, nowMs = Date.now() } = {}, esc = escHtml) {
  const line = (text, wait) => `<div class="cc-rec-line${wait ? ' is-wait' : ''}">${text}</div>`;
  if (callId == null) return { state: 'test', html: line('🎧 Recording — none (test call)') };
  if (d && d.state === 'ready' && d.playbackUrl) {
    return { state: 'ready', html: line(`🎧 Recording${d.label ? ' · ' + esc(d.label) : ''}`)
      + `<audio class="cc-rec-audio" controls preload="none" src="${esc(d.playbackUrl)}"></audio>` };
  }
  // Failed — or "ready" but no link could be signed (the file isn't in storage): either
  // way it isn't arriving, so never say "arrives a few minutes…" for it.
  if (d && d.render && (d.state === 'failed' || d.state === 'ready')) return { state: 'failed', html: line('🎧 Recording — couldn\'t be fetched', true) };
  if (d && d.render) return { state: 'pending', html: line('🎧 Recording — arrives a few minutes after the call ends', true) };
  // No recording row. The row only appears when the call ENDS with audio — so a recent
  // call may still be on the line; an older one simply has no recording.
  const s = Number(startedMs);
  if (Number.isFinite(s) && s > 0 && nowMs - s < NO_RECORDING_AFTER_MS) {
    return { state: 'waiting', html: line('🎧 Recording — shows up after the call ends', true) };
  }
  return { state: 'none', html: line('🎧 No recording', true) };
}

// Fill the card's recording box. el = the box; call = the calls row ({ id, started_at });
// fetchIndex(ids) → index. Returns the state. A playback error fetches ONE fresh link
// per box (the signed link lasts 5 minutes).
export async function loadInlineRecording(el, call, fetchIndex, nowMs = Date.now()) {
  if (!el) return 'none';
  const callId = call && call.id != null ? call.id : null;
  if (callId == null) { const v = inlineRecordingView(null, { callId }); el.innerHTML = v.html; el.dataset.state = v.state; return v.state; }
  if (el.dataset.state === 'ready' && el.querySelector('audio')) return 'ready';
  const idx = await fetchIndex([callId]);
  const d = describeCallId(idx, callId);
  const v = inlineRecordingView(d, { callId, startedMs: Date.parse(call.started_at), nowMs });
  el.dataset.state = v.state;
  el.innerHTML = v.html;
  if (v.state === 'ready') {
    const audio = el.querySelector('audio');
    if (audio) audio.addEventListener('error', async () => {
      if (el.dataset.relinked === '1') return;
      el.dataset.relinked = '1';
      el.dataset.state = '';
      await loadInlineRecording(el, call, fetchIndex);
    }, { once: true });
  }
  return v.state;
}
