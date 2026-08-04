import test from 'node:test';
import assert from 'node:assert/strict';

import { fileKey, filterImages, isImageFile } from '../js/lib/intake.js';

const fileOf = (name, type = '', lastModified = 1) =>
  new File(['x'], name, { type, lastModified });

test('files are accepted on their MIME type', () => {
  assert.equal(isImageFile(fileOf('a.png', 'image/png')), true);
  assert.equal(isImageFile(fileOf('a.heic', 'image/heic')), true);
  assert.equal(isImageFile(fileOf('a.pdf', 'application/pdf')), false);
  assert.equal(isImageFile(fileOf('a.txt', 'text/plain')), false);
});

test('a missing MIME type falls back to the extension', () => {
  assert.equal(isImageFile(fileOf('photo.JPG')), true);
  assert.equal(isImageFile(fileOf('photo.jpeg')), true);
  assert.equal(isImageFile(fileOf('vector.svg')), true);
  assert.equal(isImageFile(fileOf('scan.tiff')), true);
  assert.equal(isImageFile(fileOf('notes.md')), false);
  assert.equal(isImageFile(fileOf('noextension')), false);
});

test('a MIME type that is present wins over the extension', () => {
  // A .png that the OS reported as a PDF is not something we should decode.
  assert.equal(isImageFile(fileOf('trick.png', 'application/pdf')), false);
});

test('isImageFile tolerates nothing at all', () => {
  assert.equal(isImageFile(null), false);
  assert.equal(isImageFile(undefined), false);
});

test('fileKey identifies a file by name, size and mtime', () => {
  const a = fileOf('a.png', 'image/png', 10);
  const b = fileOf('a.png', 'image/png', 10);
  const c = fileOf('a.png', 'image/png', 11);

  assert.equal(fileKey(a), fileKey(b));
  assert.notEqual(fileKey(a), fileKey(c));
});

test('filterImages splits images from everything else', () => {
  const result = filterImages([
    fileOf('a.png', 'image/png'),
    fileOf('readme.md', 'text/markdown'),
    fileOf('b.webp', 'image/webp'),
  ]);

  assert.equal(result.accepted.length, 2);
  assert.equal(result.rejected, 1);
  assert.equal(result.duplicates, 0);
});

test('filterImages drops files already seen, across calls', () => {
  const seen = new Set();
  const first = filterImages([fileOf('a.png', 'image/png')], seen);
  const second = filterImages([fileOf('a.png', 'image/png')], seen);

  assert.equal(first.accepted.length, 1);
  assert.equal(second.accepted.length, 0);
  assert.equal(second.duplicates, 1);
});

test('filterImages de-duplicates within a single drop', () => {
  const result = filterImages([
    fileOf('a.png', 'image/png'),
    fileOf('a.png', 'image/png'),
    fileOf('b.png', 'image/png'),
  ]);

  assert.equal(result.accepted.length, 2);
  assert.equal(result.duplicates, 1);
});

test('filterImages handles an empty selection', () => {
  assert.deepEqual(filterImages([]), { accepted: [], rejected: 0, duplicates: 0 });
});
