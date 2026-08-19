import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetDimensions, shouldKeepOriginal, extForImageMime, isCompressibleImage,
  MAX_EDGE, QUALITY, OUT_MIME,
} from './photo-compress.js';

// ── targetDimensions ──────────────────────────────────────────────────
test('targetDimensions scales a 12MP iPhone landscape capture to the long edge', () => {
  const d = targetDimensions(4032, 3024, 1600);
  assert.equal(d.width, 1600);
  assert.equal(d.height, 1200);          // aspect preserved exactly
  assert.equal(d.scaled, true);
});

test('targetDimensions scales portrait by its LONG edge, not width', () => {
  const d = targetDimensions(3024, 4032, 1600);
  assert.equal(d.height, 1600);
  assert.equal(d.width, 1200);
  assert.equal(d.scaled, true);
});

test('targetDimensions never upscales — a small photo is left alone', () => {
  const d = targetDimensions(800, 600, 1600);
  assert.deepEqual(d, { width: 800, height: 600, scaled: false });
});

test('targetDimensions leaves an exactly-at-cap image alone', () => {
  const d = targetDimensions(1600, 900, 1600);
  assert.equal(d.scaled, false);
  assert.equal(d.width, 1600);
});

test('targetDimensions preserves aspect ratio within a rounding pixel', () => {
  const d = targetDimensions(4000, 2251, 1600);
  const srcRatio = 4000 / 2251, outRatio = d.width / d.height;
  assert.ok(Math.abs(srcRatio - outRatio) < 0.01, `ratio drifted: ${srcRatio} vs ${outRatio}`);
});

test('targetDimensions never returns a zero dimension on an extreme panorama', () => {
  const d = targetDimensions(20000, 5, 1600);
  assert.ok(d.width >= 1, 'width floored to at least 1');
  assert.ok(d.height >= 1, 'height floored to at least 1 — a 0-height canvas throws');
});

test('targetDimensions returns null on unusable input', () => {
  assert.equal(targetDimensions(0, 100, 1600), null);
  assert.equal(targetDimensions(100, 0, 1600), null);
  assert.equal(targetDimensions(NaN, 100, 1600), null);
  assert.equal(targetDimensions(undefined, undefined, 1600), null);
});

test('targetDimensions falls back to MAX_EDGE when no cap is given', () => {
  const d = targetDimensions(4032, 3024);
  assert.equal(d.width, MAX_EDGE);
});

// ── shouldKeepOriginal ────────────────────────────────────────────────
test('shouldKeepOriginal keeps the original when the encode saved nothing', () => {
  assert.equal(shouldKeepOriginal(100_000, 140_000), true);   // bigger
  assert.equal(shouldKeepOriginal(100_000, 100_000), true);   // no saving
});

test('shouldKeepOriginal takes the encode when it actually shrank', () => {
  assert.equal(shouldKeepOriginal(4_000_000, 300_000), false);
});

test('shouldKeepOriginal keeps the original when the encode produced nothing', () => {
  assert.equal(shouldKeepOriginal(4_000_000, 0), true);
  assert.equal(shouldKeepOriginal(4_000_000, null), true);
  assert.equal(shouldKeepOriginal(4_000_000, undefined), true);
});

test('shouldKeepOriginal takes the encode when the original size is unknown', () => {
  assert.equal(shouldKeepOriginal(0, 300_000), false);
});

// ── extForImageMime ───────────────────────────────────────────────────
test('extForImageMime maps the types a phone camera can hand us', () => {
  assert.equal(extForImageMime('image/jpeg'), 'jpg');
  assert.equal(extForImageMime('image/png'), 'png');
  assert.equal(extForImageMime('image/webp'), 'webp');
  assert.equal(extForImageMime('image/heic'), 'heic');
  assert.equal(extForImageMime('image/heif'), 'heif');
});

test('extForImageMime tolerates a parameterised or cased mime', () => {
  assert.equal(extForImageMime('IMAGE/JPEG'), 'jpg');
  assert.equal(extForImageMime('image/jpeg; charset=binary'), 'jpg');
});

test('extForImageMime defaults to jpg — never returns an empty extension', () => {
  assert.equal(extForImageMime(''), 'jpg');
  assert.equal(extForImageMime(null), 'jpg');
  assert.equal(extForImageMime('application/octet-stream'), 'jpg');
});

// ── isCompressibleImage ───────────────────────────────────────────────
test('isCompressibleImage accepts images and rejects everything else', () => {
  assert.equal(isCompressibleImage('image/jpeg'), true);
  assert.equal(isCompressibleImage('image/heic'), true);
  assert.equal(isCompressibleImage('video/mp4'), false);
  assert.equal(isCompressibleImage('application/pdf'), false);
  assert.equal(isCompressibleImage(''), false);
  assert.equal(isCompressibleImage(null), false);
});

// ── the constants are the documented decision ─────────────────────────
test('the compression settings are the ones the header justifies', () => {
  assert.equal(MAX_EDGE, 1600);
  assert.equal(QUALITY, 0.8);
  assert.equal(OUT_MIME, 'image/jpeg');
});
