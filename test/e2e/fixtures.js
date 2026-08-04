import { deflateSync } from 'node:zlib';

import { crc32 } from '../../js/lib/zip.js';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);

  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/**
 * Build a real RGBA PNG so the end-to-end tests exercise the browser's actual
 * decoder rather than a stub.
 *
 * The default pattern is a gradient plus deterministic noise: flat colour
 * would compress to almost nothing and make the size-budget test meaningless.
 *
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {boolean} [options.noise]
 * @param {number} [options.alpha] 0–255, applied to every pixel
 * @returns {Buffer}
 */
export function makePng({ width = 240, height = 160, noise = true, alpha = 255 } = {}) {
  // Each scanline is prefixed with a filter-type byte; 0 means "no filter".
  const raw = new Uint8Array(height * (1 + width * 4));
  let offset = 0;
  let seed = 12345;

  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      // A cheap deterministic PRNG keeps fixtures identical between runs.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const jitter = noise ? (seed >> 16) & 0x7f : 0;

      raw[offset++] = (x * 255 / width + jitter) & 0xff;
      raw[offset++] = (y * 255 / height + jitter) & 0xff;
      raw[offset++] = ((x + y) * 127 / (width + height) + jitter) & 0xff;
      raw[offset++] = alpha;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;  // bit depth
  header[9] = 6;  // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A Playwright `setInputFiles` payload. */
export function pngUpload(name, options) {
  return { name, mimeType: 'image/png', buffer: makePng(options) };
}
