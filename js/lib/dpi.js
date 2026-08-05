/**
 * Print resolution for JPEG output.
 *
 * A canvas encoder writes a JFIF header that claims no physical resolution, so
 * a 600 × 600 photo prints at whatever size the print shop's software guesses.
 * Document photos are specified in millimetres — "2 × 2 inch at 300 DPI" only
 * means something once the density field says so.
 *
 * The density lives in the APP0/JFIF segment that canvas JPEGs begin with, and
 * rewriting it in place changes no byte count. That matters: the blob has
 * already been measured against the user's size budget by the time it gets
 * here, and a stamp that grew the file could push it back over.
 */

/** Above this a "DPI" is almost certainly a typo, and JFIF caps at 65535. */
export const MAX_DPI = 2400;

const MARKER = 0xff;
const SOI = 0xd8;
const SOS = 0xda;
const APP0 = 0xe0;

/** Markers with no length field, so nothing to skip past. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

/** 'J' 'F' 'I' 'F' NUL — the identifier that opens a JFIF APP0 payload. */
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00];

const toBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input));

/**
 * Offset of the JFIF APP0 segment, or -1 when the file has none.
 *
 * Walking the marker chain rather than assuming APP0 sits at offset 2 keeps
 * this correct for encoders that emit an EXIF APP1 first.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function findJfifSegment(bytes) {
  if (bytes.length < 4 || bytes[0] !== MARKER || bytes[1] !== SOI) return -1;

  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== MARKER) return -1;

    // Any number of 0xFF bytes may pad the gap before a marker.
    let marker = bytes[offset + 1];
    while (marker === MARKER && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }

    if (marker === SOS) return -1; // Entropy-coded data from here on.
    if (STANDALONE.has(marker)) {
      offset += 2;
      continue;
    }

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return -1;

    // 16 = 2 length + 5 identifier + 2 version + 1 units + 4 density + 2 thumb.
    if (marker === APP0 && length >= 16 && JFIF.every((b, i) => bytes[offset + 4 + i] === b)) {
      return offset;
    }

    offset += 2 + length;
  }

  return -1;
}

/**
 * Rewrite a JPEG's pixel density so printers know its intended physical size.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {number} dpi dots per inch, 1…{@link MAX_DPI}
 * @returns {Uint8Array|null} a stamped copy, or null when the input carries no
 *   JFIF header to stamp — in which case the caller keeps the original bytes.
 */
export function stampJpegDensity(input, dpi) {
  const density = Math.round(Number(dpi) || 0);
  if (!Number.isFinite(density) || density < 1 || density > MAX_DPI) return null;

  const bytes = toBytes(input);
  const segment = findJfifSegment(bytes);
  if (segment === -1) return null;

  const out = bytes.slice();
  out[segment + 11] = 1; // Units: dots per inch.
  out[segment + 12] = (density >> 8) & 0xff;
  out[segment + 13] = density & 0xff;
  out[segment + 14] = (density >> 8) & 0xff;
  out[segment + 15] = density & 0xff;

  return out;
}

/**
 * Read back the density a JPEG declares. Used by the tests, and cheap enough
 * to be worth exporting for anyone debugging a print job.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{units: number, x: number, y: number}|null}
 */
export function readJpegDensity(input) {
  const bytes = toBytes(input);
  const segment = findJfifSegment(bytes);
  if (segment === -1) return null;

  return {
    units: bytes[segment + 11],
    x: (bytes[segment + 12] << 8) | bytes[segment + 13],
    y: (bytes[segment + 14] << 8) | bytes[segment + 15],
  };
}
