import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DPI, findJfifSegment, readJpegDensity, stampJpegDensity } from '../js/lib/dpi.js';

/** A JFIF APP0 segment declaring no physical resolution, as canvases emit. */
const APP0 = [
  0xff, 0xe0, 0x00, 0x10,
  0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
  0x01, 0x02, // version 1.2
  0x00, // units: none
  0x00, 0x01, 0x00, 0x01, // 1:1 aspect
  0x00, 0x00, // no thumbnail
];

/** Marker, length, then filler — enough to be skipped over correctly. */
const segment = (marker, payload = 4) => [
  0xff, marker, 0x00, payload + 2, ...new Array(payload).fill(0x00),
];

const jpeg = (...parts) => Uint8Array.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0x00, 0x02]);

test('finds the JFIF segment at the head of the file', () => {
  assert.equal(findJfifSegment(jpeg(APP0)), 2);
});

test('finds a JFIF segment sitting behind an EXIF block', () => {
  const bytes = jpeg(segment(0xe1, 20), APP0);
  // 2 SOI bytes, then the EXIF block's 2 marker + 2 length + 20 payload.
  assert.equal(findJfifSegment(bytes), 2 + 24);
  assert.deepEqual(readJpegDensity(bytes), { units: 0, x: 1, y: 1 });
});

test('reports no segment for files that have none', () => {
  assert.equal(findJfifSegment(jpeg(segment(0xe1))), -1, 'EXIF only');
  assert.equal(findJfifSegment(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), -1, 'a PNG');
  assert.equal(findJfifSegment(Uint8Array.from([0xff, 0xd8])), -1, 'truncated');
});

test('a bogus segment length is rejected rather than walked off the end', () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x00, 0x00]);
  assert.equal(findJfifSegment(bytes), -1);
});

test('stamping records the resolution in both axes', () => {
  const stamped = stampJpegDensity(jpeg(APP0), 300);

  assert.deepEqual(readJpegDensity(stamped), { units: 1, x: 300, y: 300 });
});

test('stamping never changes the file size', () => {
  const original = jpeg(APP0);
  const stamped = stampJpegDensity(original, 600);

  assert.equal(stamped.length, original.length);
  assert.notEqual(stamped, original, 'the input is left untouched');
  assert.deepEqual(readJpegDensity(original), { units: 0, x: 1, y: 1 });
});

test('stamping accepts a raw ArrayBuffer', () => {
  const source = jpeg(APP0);
  const stamped = stampJpegDensity(source.buffer.slice(0), 72);

  assert.deepEqual(readJpegDensity(stamped), { units: 1, x: 72, y: 72 });
});

test('unusable inputs stamp nothing instead of throwing', () => {
  assert.equal(stampJpegDensity(jpeg(APP0), 0), null);
  assert.equal(stampJpegDensity(jpeg(APP0), -300), null);
  assert.equal(stampJpegDensity(jpeg(APP0), MAX_DPI + 1), null);
  assert.equal(stampJpegDensity(jpeg(APP0), 'lots'), null);
  assert.equal(stampJpegDensity(jpeg(segment(0xe1)), 300), null, 'no JFIF header to stamp');
});
