/* ============================================================
   ro-media.js — the ONE place that knows whether an RO attachment
   is a photo or a video.

   WHY THIS FILE EXISTS, AND WHY THERE IS NO 'ro_video' ENUM VALUE
   A video shot by a tech is stored EXACTLY like a photo: same
   `attachments` table, same kind='ro_photo', same private
   crisdata-attachments bucket, same repair_order/<ro_id>/photos/ folder,
   same bucket_id, same deleted_at tombstone. The ONLY thing that
   distinguishes it is the extension on `file_path`.

   That was a deliberate choice over adding 'ro_video' to the
   attachment_kind enum, and the reasoning is about which way each option
   FAILS — see docs/wiring/ro-photos.md §1d for the full write-up:

   • With a separate enum value, any reader still filtering
     .eq('kind','ro_photo') SILENTLY DROPS videos. A tech shoots the
     transmission slipping, the customer record shows nothing, and there
     is no tell anywhere that something is missing.
   • Reusing 'ro_photo', a render site that forgets to branch emits
     <img src="clip.mov"> — a broken tile. Loud, obvious the first time
     anyone opens the RO, one line to fix, and nothing is lost.

   This subsystem's whole posture is anti-silent-loss (ro-photos.md §4's
   six-reader table exists for exactly that reason), so we take the loud
   failure every time.

   WE AUTHOR THE EXTENSION, WHICH IS WHY THIS IS SAFE.
   The storage key is `repair_order/<ro_id>/photos/<ts>-<rand>[-<n>s].<ext>`.
   No user-supplied filename ever enters it. The extension set is closed
   and it is ours, so "detect by extension" here is not the usual guess it
   is elsewhere.

   THE DEFAULT DIRECTION IS LOAD-BEARING: an unknown or missing extension
   is a PHOTO, never a video. A broken <img> is visible; a <video> pointed
   at JPEG bytes is a silently dead black tile.

   ⚠ videoExtFor() MUST NEVER RETURN 'jpg'.
   shared/photo-compress.js's extForImageMime() returns 'jpg' for every
   non-image mime, and compressImage() does NOT throw on a video — it
   returns usedOriginal with ext:'jpg'. So the lazy version of this feature
   (delete one guard, let the photo path run) writes a .mov's bytes to a
   .jpg key. That clip is then classified as a photo FOREVER: broken on
   every surface, and unfixable by any code change, because the extension
   is baked into file_path AND into the storage object's name — which
   crisdata-attachments has no delete policy to remove (ro-photos.md §6).
   It is the only failure in this slice that is permanent and retroactive.
   ro-media.test.js pins it.

   DURATION LIVES IN THE PATH, and that is also deliberate.
   `attachments` has no duration column and adding one is SQL. A duration
   held only in memory would show on the tile for the session that shot the
   clip and then vanish on the next load, which reads as a bug. So the
   seconds are written into the storage key — `<ts>-<rand>-42s.mp4` — the
   same filename we already encode the media type into. Missing or
   unreadable duration simply omits the segment and the tile shows no chip.

   No DOM at module scope: everything above the BROWSER divider is pure and
   is imported directly by shared/ro-media.test.js under `node --test`.
   Same shape as shared/photo-compress.js.
   ============================================================ */

// The hard cap. file.size is the ONLY always-available signal (duration can
// fail to arrive on iOS — see readVideoDuration), so this is what blocks.
// Mirrors the project-level Supabase upload limit, which was raised to
// 100 MB on BOTH projects before this shipped — hosting-domains.md §5.5.
export const MAX_VIDEO_MB = 100;
export const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;

// The SOFT cap. Over this we warn and upload anyway. Not a block: a 55 MB /
// 1:20 clip is inside the storage cap and there is no reason to refuse it,
// and blocking on a signal that sometimes never arrives would mean
// sometimes-refusing a clip identical to one we accepted.
export const SOFT_MAX_SECONDS = 60;

// The closed set. Everything NOT in here is a photo.
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', '3gp', 'avi', 'mkv'];

// mime -> the extension we write. Deliberately explicit rather than derived
// from the mime's subtype: 'video/quicktime' is .mov, not .quicktime.
const VIDEO_MIME_EXT = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/m4v': 'm4v',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
};

/* PURE. The extension of a storage key, lowercased, or '' when there isn't
   one. Reads only the LAST path segment, so a dot in a folder name (or in
   the RO's own id, which is a uuid and has none, but never rely on that)
   cannot be mistaken for the file's extension. */
export function extOfPath(filePath) {
  const s = String(filePath == null ? '' : filePath);
  const seg = s.split('/').pop() || '';
  const dot = seg.lastIndexOf('.');
  if (dot <= 0 || dot === seg.length - 1) return '';   // no dot, leading dot, or trailing dot
  return seg.slice(dot + 1).toLowerCase();
}

/* PURE. THE PREDICATE. Every render site on every board asks this and
   nothing else. Unknown extension -> false (photo), always. */
export function isVideoPath(filePath) {
  const ext = extOfPath(filePath);
  return ext !== '' && VIDEO_EXTS.indexOf(ext) !== -1;
}

/* PURE. The storage extension for a picked video File.
   NEVER 'jpg' — see the header. Order: the mime we understand, then the
   file's own name if it carries a known video extension, then 'mp4' as the
   last resort. mp4 rather than the mime's subtype because an unrecognised
   container we cannot name is still far likelier to be mp4 than anything
   else, and a wrong-but-video extension still classifies correctly. */
export function videoExtFor(file) {
  const mime = String((file && file.type) || '').toLowerCase().split(';')[0].trim();
  if (VIDEO_MIME_EXT[mime]) return VIDEO_MIME_EXT[mime];
  const named = extOfPath(String((file && file.name) || ''));
  if (named && VIDEO_EXTS.indexOf(named) !== -1) return named;
  return 'mp4';
}

// PURE. Is this File something we should treat as a video at all?
export function isVideoFile(file) {
  return String((file && file.type) || '').toLowerCase().startsWith('video/');
}

/* PURE. "2:10", "0:42", "1:05:03". Returns '' for anything unusable —
   null, NaN, zero, negative, and Infinity, which is what a <video> hands
   back when it could not work the duration out. '' means "say nothing about
   duration", never "0:00" — a chip reading 0:00 on a real clip is worse
   than no chip. */
export function formatDuration(seconds) {
  if (seconds == null || seconds === '') return '';
  const n = Number(seconds);
  // <= 0 is unusable too, not "0:00": no clip is zero seconds long, so a
  // zero here means we failed to read it, same as NaN.
  if (!isFinite(n) || n <= 0) return '';
  const total = Math.round(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* PURE. Build the storage key's filename stem, with the duration folded in
   when we have one. `seconds` of null/0/Infinity simply omits the segment.
   Kept separate from the caller so ro-media.test.js can pin the round trip
   against videoDurationFromPath. */
export function videoStem(stamp, seconds) {
  const n = Number(seconds);
  const base = String(stamp == null ? '' : stamp);
  if (!isFinite(n) || n <= 0) return base;
  return `${base}-${Math.round(n)}s`;
}

/* PURE. Read the duration back out of a storage key. Returns seconds, or
   null when the key carries none (every clip shot before this shipped, and
   every clip whose duration never arrived). The `-<n>s` segment is matched
   against the END of the stem only, so a random suffix that happens to end
   in a digit followed by 's' is the only false positive — and the random
   suffix is base36 from Math.random().toString(36).slice(2,8), which can
   produce exactly that. Accepted: the consequence is a wrong duration chip
   on a video, not a misfiled or unreadable clip. */
export function videoDurationFromPath(filePath) {
  if (!isVideoPath(filePath)) return null;
  const seg = String(filePath).split('/').pop() || '';
  const stem = seg.slice(0, seg.lastIndexOf('.'));
  const m = /-(\d{1,5})s$/.exec(stem);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isFinite(n) && n > 0 ? n : null;
}

/* PURE. THE GATE. Runs synchronously, first, always — before compression
   (which video must never touch), before storage, before anything.
   Returns { ok:false, reason, message, mb, maxMb } or { ok:true }.

   `message` is English and self-contained so this module is testable on its
   own; My Numbers renders the translated string from the same numbers. */
export function checkVideoFile(file, opts) {
  const o = opts || {};
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_VIDEO_BYTES;
  const maxMb = Math.round(maxBytes / (1024 * 1024));
  if (!file) {
    return { ok: false, reason: 'missing', message: 'No video came back. Try again.', mb: 0, maxMb };
  }
  if (!isVideoFile(file)) {
    return { ok: false, reason: 'not-a-video', message: 'That file is not a video.', mb: 0, maxMb };
  }
  const size = Number(file.size) || 0;
  if (!size) {
    return { ok: false, reason: 'empty', message: 'That clip came back empty — take it again.', mb: 0, maxMb };
  }
  if (size > maxBytes) {
    const mb = Math.round(size / (1024 * 1024));
    return {
      ok: false, reason: 'too-big', mb, maxMb,
      message: `That clip is ${mb} MB — too big. Keep it under ${maxMb} MB (about a minute).`,
    };
  }
  return { ok: true, reason: null, message: '', mb: Math.round(size / (1024 * 1024)), maxMb };
}

/* PURE. The advisory, given a duration we actually managed to read.
   Returns '' when there is nothing to say — including when duration never
   landed, which is the whole reason this takes null gracefully. */
export function longClipWarning(seconds, opts) {
  const o = opts || {};
  const limit = Number(o.softMaxSeconds) > 0 ? Number(o.softMaxSeconds) : SOFT_MAX_SECONDS;
  const n = Number(seconds);
  if (!isFinite(n) || n <= limit) return '';
  return `That clip is ${formatDuration(n)}. Keep it under a minute next time — uploading it anyway.`;
}

// ── BROWSER ────────────────────────────────────────────────────────────
/* Duration from a File, via an <video> and a local object URL.

   IT IS RELIABLE ON iOS SAFARI FOR A LOCAL BLOB — the notorious
   `duration === Infinity` bug is a server-streamed / range-request problem,
   not a blob one. But three things can still stop it dead:
     • iOS cannot decode the codec (some HEVC .mov, anything a third-party
       app wrote) -> `error` fires and `loadedmetadata` never does;
     • it hangs with no event at all;
     • Low Power Mode delays the decode past any sane wait.

   So this NEVER blocks and NEVER throws. It resolves to a number or to
   null, whichever comes first, and the caller says nothing about duration
   when it gets null. file.size is what actually gates the upload. */
export function readVideoDuration(file, timeoutMs) {
  const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : 2500;
  return new Promise((resolve) => {
    let done = false;
    let url = null;
    const v = document.createElement('video');
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { v.removeAttribute('src'); v.load(); } catch (e) { /* best effort */ }
      if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* best effort */ } }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), wait);
    try {
      url = URL.createObjectURL(file);
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = () => {
        const d = Number(v.duration);
        finish(isFinite(d) && d > 0 ? d : null);
      };
      v.onerror = () => finish(null);
      v.src = url;
    } catch (e) {
      finish(null);
    }
  });
}
