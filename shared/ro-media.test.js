/* ============================================================
   ro-media.test.js — unit tests for the photo/video predicate.
   Run: npm test   (node --test)

   THE MOST IMPORTANT TEST IN THIS FILE is "videoExtFor NEVER returns 'jpg'".
   See the header of ro-media.js: shared/photo-compress.js's extForImageMime()
   returns 'jpg' for every non-image mime and compressImage() does not throw
   on a video, so the lazy implementation of this feature writes a .mov's
   bytes to a .jpg key — a clip classified as a photo forever, unfixable by
   any code change, on a storage object that has no delete policy to remove.
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_MB, MAX_VIDEO_BYTES, SOFT_MAX_SECONDS,
  extOfPath, isVideoPath, videoExtFor, isVideoFile, formatDuration,
  videoStem, videoDurationFromPath, checkVideoFile, longClipWarning,
} from './ro-media.js';

const F = (type, size, name) => ({ type, size, name: name || '' });
const KEY = (file) => `repair_order/6f1e0c2a-1111-2222-3333-444455556666/photos/${file}`;

// ── 1. the predicate ──────────────────────────────────────────
test('every video container we write is recognised as a video', () => {
  for (const ext of ['mp4', 'mov', 'm4v', 'webm', '3gp', 'avi', 'mkv']) {
    assert.equal(isVideoPath(KEY(`1756300000000-a1b2c3.${ext}`)), true, ext);
  }
});

test('every image extension the photo path writes is NOT a video', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) {
    assert.equal(isVideoPath(KEY(`1756300000000-a1b2c3.${ext}`)), false, ext);
  }
});

test('UNKNOWN or MISSING extension is a PHOTO, never a video', () => {
  // The fail-safe direction, and it is load-bearing. A broken <img> is
  // visible and one line to fix; a <video> pointed at JPEG bytes is a
  // silently dead black tile that looks like the feature working.
  assert.equal(isVideoPath(KEY('1756300000000-a1b2c3')), false);        // no extension at all
  assert.equal(isVideoPath(KEY('1756300000000-a1b2c3.')), false);       // trailing dot
  assert.equal(isVideoPath(KEY('1756300000000-a1b2c3.bin')), false);    // unknown
  assert.equal(isVideoPath(KEY('.hidden')), false);                     // leading dot only
  assert.equal(isVideoPath(''), false);
  assert.equal(isVideoPath(null), false);
  assert.equal(isVideoPath(undefined), false);
});

test('extension matching is CASE-INSENSITIVE — a third-party app writes .MOV', () => {
  assert.equal(isVideoPath(KEY('1756300000000-a1b2c3.MOV')), true);
  assert.equal(isVideoPath(KEY('1756300000000-a1b2c3.Mp4')), true);
  assert.equal(isVideoPath(KEY('1756300000000-a1b2c3.JPG')), false);
});

test('a dot in a FOLDER name never decides the media type', () => {
  // Only the last path segment is read. Otherwise a folder called
  // "before.mp4" would turn every photo under it into a video.
  assert.equal(isVideoPath('repair_order/x.mp4/photos/1756-a1.jpg'), false);
  assert.equal(isVideoPath('repair_order/x.jpg/photos/1756-a1.mp4'), true);
  assert.equal(isVideoPath('repair_order/x.mp4/photos/1756-a1'), false);
  assert.equal(extOfPath('repair_order/x.mp4/photos/1756-a1.jpg'), 'jpg');
});

// ── 2. THE ONE THAT MATTERS ───────────────────────────────────
test("videoExtFor NEVER returns 'jpg' for a video — the permanent, retroactive bug", () => {
  const mimes = [
    'video/quicktime',        // what an iPhone hands back for a .mov capture
    'video/mp4',
    'video/x-m4v',
    'video/webm',
    'video/3gpp',
    'video/x-msvideo',
    'video/x-matroska',
    'video/some-container-nobody-has-heard-of',
    'video/quicktime; codecs="hvc1"',
    '',                       // no type at all
  ];
  for (const type of mimes) {
    const ext = videoExtFor(F(type, 1024, 'IMG_0042.MOV'));
    assert.notEqual(ext, 'jpg', `videoExtFor('${type}') must never be jpg`);
    assert.notEqual(ext, 'jpeg', `videoExtFor('${type}') must never be jpeg`);
    assert.ok(isVideoPath(KEY('1756-a1.' + ext)),
      `videoExtFor('${type}') produced '${ext}', which isVideoPath does not recognise`);
  }
});

test('videoExtFor maps the containers we know by mime, not by mime subtype', () => {
  assert.equal(videoExtFor(F('video/quicktime', 1)), 'mov');   // NOT 'quicktime'
  assert.equal(videoExtFor(F('video/mp4', 1)), 'mp4');
  assert.equal(videoExtFor(F('video/x-m4v', 1)), 'm4v');
  assert.equal(videoExtFor(F('video/webm', 1)), 'webm');
});

test("videoExtFor falls back to the file's own name, then to mp4", () => {
  assert.equal(videoExtFor(F('video/unknown', 1, 'clip.webm')), 'webm');
  assert.equal(videoExtFor(F('video/unknown', 1, 'clip.JPG')), 'mp4');   // a photo ext is not honoured
  assert.equal(videoExtFor(F('video/unknown', 1, 'clip')), 'mp4');
  assert.equal(videoExtFor(F('video/unknown', 1)), 'mp4');
  assert.equal(videoExtFor(null), 'mp4');
});

test('isVideoFile reads the mime, and an image is never a video', () => {
  assert.equal(isVideoFile(F('video/mp4', 1)), true);
  assert.equal(isVideoFile(F('VIDEO/MP4', 1)), true);
  assert.equal(isVideoFile(F('image/jpeg', 1)), false);
  assert.equal(isVideoFile(F('', 1)), false);
  assert.equal(isVideoFile(null), false);
});

// ── 3. duration formatting ────────────────────────────────────
test('formatDuration reads the way a person says it', () => {
  assert.equal(formatDuration(130), '2:10');
  assert.equal(formatDuration(42), '0:42');
  assert.equal(formatDuration(60), '1:00');
  assert.equal(formatDuration(9), '0:09');
  assert.equal(formatDuration(3903), '1:05:03');
  assert.equal(formatDuration(42.4), '0:42');    // rounded, never '0:42.4'
});

test("formatDuration says NOTHING rather than '0:00' when it does not know", () => {
  // Infinity is what a <video> hands back when it could not work the
  // duration out. '' means "say nothing about duration" — a chip reading
  // 0:00 on a real clip is worse than no chip.
  assert.equal(formatDuration(Infinity), '');
  assert.equal(formatDuration(NaN), '');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-5), '');
});

// ── 4. duration survives in the storage key ───────────────────
test('the duration round-trips through the storage key', () => {
  const stem = videoStem('1756300000000-a1b2c3', 42);
  assert.equal(stem, '1756300000000-a1b2c3-42s');
  assert.equal(videoDurationFromPath(KEY(stem + '.mp4')), 42);
  assert.equal(videoDurationFromPath(KEY(videoStem('1756-a1', 130) + '.mov')), 130);
});

test('a clip whose duration never landed simply carries none', () => {
  // Every clip shot before this shipped, and every clip where iOS could not
  // decode the metadata. The tile shows no chip; nothing breaks.
  for (const secs of [null, undefined, 0, Infinity, NaN, -3]) {
    assert.equal(videoStem('1756-a1', secs), '1756-a1');
  }
  assert.equal(videoDurationFromPath(KEY('1756-a1.mp4')), null);
});

test('videoDurationFromPath only ever answers for a VIDEO', () => {
  // A photo key can never yield a duration, whatever it looks like.
  assert.equal(videoDurationFromPath(KEY('1756-a1-42s.jpg')), null);
  assert.equal(videoDurationFromPath(KEY('1756-a1-42s')), null);
  assert.equal(videoDurationFromPath(null), null);
});

// ── 5. the size gate ──────────────────────────────────────────
test('the cap is exactly 100 MB, and one byte over is refused', () => {
  assert.equal(MAX_VIDEO_MB, 100);
  assert.equal(MAX_VIDEO_BYTES, 100 * 1024 * 1024);
  assert.equal(checkVideoFile(F('video/mp4', MAX_VIDEO_BYTES)).ok, true);
  const over = checkVideoFile(F('video/mp4', MAX_VIDEO_BYTES + 1));
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too-big');
});

test('the too-big message carries the REAL size, not just the limit', () => {
  // "That clip is too big" tells the tech nothing they can act on. The
  // number is what tells them how much to trim.
  const r = checkVideoFile(F('video/mp4', 128 * 1024 * 1024));
  assert.equal(r.ok, false);
  assert.equal(r.mb, 128);
  assert.equal(r.maxMb, 100);
  assert.ok(r.message.includes('128'), r.message);
  assert.ok(r.message.includes('100'), r.message);
});

test('empty, missing and not-a-video are each refused with their own reason', () => {
  assert.equal(checkVideoFile(F('video/mp4', 0)).reason, 'empty');
  assert.equal(checkVideoFile(null).reason, 'missing');
  assert.equal(checkVideoFile(F('image/jpeg', 5000)).reason, 'not-a-video');
});

test('the gate is SYNCHRONOUS and never consults duration', () => {
  // file.size is the only always-available signal; duration can fail to
  // arrive on iOS entirely. A clip must never be blocked on something the
  // browser may simply never tell us.
  const r = checkVideoFile(F('video/mp4', 5 * 1024 * 1024));
  assert.equal(r.ok, true);
  assert.equal(typeof r.then, 'undefined');
});

// ── 6. the duration advisory ──────────────────────────────────
test('a long clip warns but is never blocked', () => {
  assert.equal(SOFT_MAX_SECONDS, 60);
  const w = longClipWarning(130);
  assert.ok(w.includes('2:10'), w);
  assert.ok(/uploading it anyway/i.test(w), w);
});

test('nothing is said about duration when it is short, or when it never landed', () => {
  assert.equal(longClipWarning(42), '');
  assert.equal(longClipWarning(60), '');      // exactly at the limit is fine
  assert.equal(longClipWarning(null), '');
  assert.equal(longClipWarning(Infinity), '');
  assert.equal(longClipWarning(NaN), '');
});
