/* ============================================================
   photo-compress.js — downscale + re-encode a camera photo before upload.

   WHY THIS EXISTS
   Nothing in CrisData compresses an image today: Capture Invoice, the
   catch-moment FAB and the employee-photo picker all upload the raw camera
   file. That is survivable for one invoice a day. It is NOT survivable for RO
   photos, where a tech may shoot 15–20 per job: a modern phone capture is
   3–5 MB, so one job is ~80 MB uploaded over shop wifi and stored forever.
   Downscaling on capture turns that into ~6 MB.

   THE NUMBERS, AND WHY
   • MAX_EDGE = 1600 (long edge). These are documentation photos of parts,
     fluid and damage, read on the advisor's customer record (desktop) and on a
     phone. 1600px is ~2 MP: it fills a desktop viewer at full width and still
     leaves headroom to pinch into a detail, while being ~6× fewer pixels than
     a 12 MP iPhone capture (4032×3024 -> 1600×1200).
   • QUALITY = 0.8 JPEG. The standard sweet spot — visually near-lossless on
     photographic content at roughly half the bytes of 0.9. Below ~0.7, banding
     starts showing on the smooth metal and fluid gradients that dominate
     transmission photos, which is exactly the detail these are shot for.
   • Output is ALWAYS image/jpeg. That normalizes an iPhone HEIC into something
     every browser, the RO/invoice print path, and any future PDF can render.
   Net: a 3–5 MB capture lands at roughly 200–400 KB.

   EXIF ORIENTATION — why an <img> and not createImageBitmap
   iPhone photos carry an EXIF rotation flag; drawn naively they come out
   sideways. We do NOT parse EXIF by hand. We decode through an <img> element,
   because browsers default to `image-orientation: from-image`, so the decoded
   image is already upright and `naturalWidth`/`naturalHeight` already report
   the ORIENTED dimensions — `drawImage` then copies it upright for free.
   `createImageBitmap(file, { imageOrientation: 'from-image' })` looks like the
   more explicit tool, but a browser that does not support that options bag
   IGNORES it silently and hands back an unoriented bitmap — a wrong result
   with no error, on Safari, which is the browser techs are actually using.
   The <img> path fails safe instead.

   FAILING SAFE
   Two guards, both of which upload the ORIGINAL rather than lose the photo:
   • decode fails (a HEIC the browser can't read) -> upload the original;
   • the re-encode came out BIGGER than the original (already-small or
     already-optimized images) -> upload the original.
   A photo the tech took is never dropped because compression had a bad day.

   No DOM at module scope: the pure helpers below are imported directly by
   shared/photo-compress.test.js under `node --test`.
   ============================================================ */

export const MAX_EDGE = 1600;          // long edge, px
export const QUALITY  = 0.8;           // JPEG quality
export const OUT_MIME = 'image/jpeg';

// PURE. Source dims + a max long edge -> the dims to draw at.
// Never upscales: an image already under the cap is returned unchanged with
// scaled:false, so a small photo is not blown up and re-encoded for nothing.
// Returns null when the dims are unusable (0, NaN, missing).
export function targetDimensions(width, height, maxEdge) {
  const w = Number(width), h = Number(height);
  const max = Number(maxEdge) > 0 ? Number(maxEdge) : MAX_EDGE;
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
  const longest = Math.max(w, h);
  if (longest <= max) return { width: Math.round(w), height: Math.round(h), scaled: false };
  const ratio = max / longest;
  return {
    width:  Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

// PURE. Keep the original instead of the re-encode? True when the encode
// failed to produce bytes, or produced MORE bytes than we started with.
export function shouldKeepOriginal(originalBytes, encodedBytes) {
  const o = Number(originalBytes), e = Number(encodedBytes);
  if (!isFinite(e) || e <= 0) return true;      // nothing usable came back
  if (!isFinite(o) || o <= 0) return false;     // unknown original — take the encode
  return e >= o;                                // no saving; don't re-encode for free
}

// PURE. Storage extension for an output mime. Defaults to jpg, which is what
// this module emits on the happy path.
export function extForImageMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/png')  return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/heic') return 'heic';
  if (m === 'image/heif') return 'heif';
  return 'jpg';
}

// PURE. Is this something we should even try to compress?
export function isCompressibleImage(type) {
  return String(type || '').toLowerCase().startsWith('image/');
}

// ── BROWSER ────────────────────────────────────────────────────────────
// Decode a File through an <img> so EXIF orientation is applied (see header).
// Resolves to the element; rejects if the browser cannot decode it.
function decodeOriented(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

/* File -> { blob, mime, ext, width, height, usedOriginal, originalBytes, bytes }
   Never throws for an image it simply could not process — it falls back to the
   original file so the upload still carries the tech's photo. */
export async function compressImage(file, opts) {
  const o = opts || {};
  const maxEdge = o.maxEdge || MAX_EDGE;
  const quality = o.quality || QUALITY;
  const originalBytes = (file && file.size) || 0;

  const fallback = (why) => ({
    blob: file, mime: file.type || OUT_MIME, ext: extForImageMime(file.type),
    width: null, height: null, usedOriginal: true, why,
    originalBytes, bytes: originalBytes,
  });

  if (!file || !isCompressibleImage(file.type)) return fallback('not-an-image');

  let decoded = null;
  try {
    decoded = await decodeOriented(file);
    // naturalWidth/Height are the ORIENTED dimensions — EXIF already applied.
    const dims = targetDimensions(decoded.img.naturalWidth, decoded.img.naturalHeight, maxEdge);
    if (!dims) return fallback('no-dimensions');

    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback('no-2d-context');
    ctx.drawImage(decoded.img, 0, 0, dims.width, dims.height);

    const blob = await new Promise((res) => canvas.toBlob(res, OUT_MIME, quality));
    if (shouldKeepOriginal(originalBytes, blob && blob.size)) return fallback('no-saving');

    return {
      blob, mime: OUT_MIME, ext: extForImageMime(OUT_MIME),
      width: dims.width, height: dims.height, usedOriginal: false, why: null,
      originalBytes, bytes: blob.size,
    };
  } catch (e) {
    return fallback('decode-error');
  } finally {
    if (decoded && decoded.revoke) decoded.revoke();
  }
}
