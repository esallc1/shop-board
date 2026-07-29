/* ============================================================
   recording-player.js — PURE render-state logic for the call-recording play
   button. Slice B, PART 3.

   The boards NEVER read the `recordings` table (RLS default-deny) and never see
   remote_url / storage_path. They call api/recording-links.js with the visible
   calls' ids and get back, per call:
       { call_id, status: 'pending'|'ready'|'failed', duration_seconds, playback_url }
   (playback_url set only for 'ready'; a short-lived signed URL). A call with NO
   recording is simply absent from the response.

   This module maps that response to a render descriptor per call id. It is the
   whole point of the slice that the THREE states render DISTINCTLY:
     ready   → a real play button (playback_url may need re-minting at click).
     pending → a DISABLED "Recording…" affordance, NOT nothing. Audio lands ~90s
               after a call ends; an absent button in that gap reads as broken.
     failed  → a quiet, honest "unavailable" marker. Some recordings genuinely no
               longer exist upstream (CTM → Twilio; one already 404'd).
   A call with no recording row at all → render nothing (absent is correct: there
   is no recording, as opposed to one that's still arriving).

   No DOM, no fetch, no db. Loaded in the browser as an ES module that assigns
   window.RecordingPlayer, and imported directly by shared/recording-player.test.js.
   ============================================================ */

// The three states a recording row can be in. Anything else from the server is
// coerced to 'failed' (an unknown status is not something to play, and not
// something to promise is "coming" — treat it as an honest dead end).
export const RECORDING_STATES = ['ready', 'pending', 'failed'];

// Normalize whatever the server returned into one of the three known states.
export function normalizeStatus(status) {
  const s = status == null ? '' : String(status).toLowerCase();
  return RECORDING_STATES.includes(s) ? s : 'failed';
}

// Format a duration (seconds) as m:ss — for the play button's caption. Returns
// '' for null/absent/negative/non-finite so the caller can omit it cleanly.
export function formatDuration(seconds) {
  const n = Number(seconds);
  if (!isFinite(n) || n <= 0) return '';
  const total = Math.round(n);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Map ONE endpoint result entry → a render descriptor.
//   entry: { call_id, status, duration_seconds, playback_url } | null | undefined
// Returns:
//   { render:false, state:'none' }                         no recording for this call
//   { render:true, state, playable, label, aria, durationLabel, playbackUrl }
// `playable` is true ONLY for a ready row — pending/failed are never clickable.
// `playbackUrl` is surfaced only for ready (null otherwise); the UI may still
// need to re-mint it at click time if it has aged out, so it's a hint, not a
// guarantee.
export function describeEntry(entry) {
  if (!entry) return { render: false, state: 'none' };
  const state = normalizeStatus(entry.status);
  const durationLabel = formatDuration(entry.duration_seconds);
  if (state === 'ready') {
    const dur = durationLabel ? ` (${durationLabel})` : '';
    return {
      render: true, state: 'ready', playable: true,
      label: `▶ Play${dur}`,
      aria: `Play call recording${durationLabel ? `, ${durationLabel} long` : ''}`,
      durationLabel,
      playbackUrl: entry.playback_url || null,
    };
  }
  if (state === 'pending') {
    return {
      render: true, state: 'pending', playable: false,
      label: '● Recording…',
      aria: 'Recording is still processing; check back in a moment',
      durationLabel: '',
      playbackUrl: null,
    };
  }
  // failed (and any coerced-unknown)
  return {
    render: true, state: 'failed', playable: false,
    label: 'Recording unavailable',
    aria: 'This call recording is no longer available',
    durationLabel: '',
    playbackUrl: null,
  };
}

// Index an endpoint response (array of entries, or { results: [...] }) by call_id
// as a STRING key — call ids are bigints on the wire and DOM datasets are always
// strings, so stringify on both sides to avoid 42 !== "42" misses. Later entries
// win on a duplicate id (one recording per call in practice).
export function indexResults(response) {
  const arr = Array.isArray(response) ? response
    : (response && Array.isArray(response.results) ? response.results : []);
  const byCallId = {};
  for (const e of arr) {
    if (!e || e.call_id == null) continue;
    byCallId[String(e.call_id)] = e;
  }
  return byCallId;
}

// Convenience: describe a call id directly against an index from indexResults.
// A call id not in the index → { render:false } (no recording).
export function describeCallId(byCallId, callId) {
  const e = byCallId ? byCallId[String(callId)] : null;
  return describeEntry(e || null);
}
