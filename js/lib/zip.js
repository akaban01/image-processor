/**
 * A ZIP writer with no third-party code.
 *
 * Two properties matter here and both are deliberate:
 *
 * 1. **Store, no deflate.** Every format we emit is already entropy-coded.
 *    Deflating a WebP costs CPU and typically *adds* bytes.
 * 2. **Blobs stay Blobs.** Entry data is never held as a `Uint8Array`; only
 *    the CRC pass reads it, in chunks, and the archive is assembled by handing
 *    the original Blob references to the `Blob` constructor. A 2 GB batch is
 *    backed by the browser's blob store rather than the JS heap.
 *
 * Zip64 records are emitted when — and only when — the archive outgrows the
 * original 32-bit fields, so ordinary archives stay maximally compatible.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

/** Read in 1 MiB slices: big enough to amortise the calls, small enough to hold. */
const CRC_CHUNK = 1024 * 1024;

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Fold more bytes into a running CRC-32.
 * @param {number} crc previous value, or `0xffffffff` to start
 * @param {Uint8Array} bytes
 */
export function crc32Update(crc, bytes) {
  let value = crc;
  for (let i = 0; i < bytes.length; i++) {
    value = CRC_TABLE[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

/** CRC-32 of a byte array. */
export function crc32(bytes) {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/** CRC-32 of a Blob, read in slices so the whole file is never resident. */
async function crc32Blob(blob) {
  let crc = 0xffffffff;

  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32Update(crc, value);
    }
  } else {
    for (let offset = 0; offset < blob.size; offset += CRC_CHUNK) {
      const slice = blob.slice(offset, Math.min(offset + CRC_CHUNK, blob.size));
      crc = crc32Update(crc, new Uint8Array(await slice.arrayBuffer()));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pack a Date into the MS-DOS date/time pair the ZIP headers use.
 * The format cannot represent anything before 1980 or after 2107.
 */
export function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** Tiny little-endian writer so the header layouts read top to bottom. */
class ByteWriter {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.offset = 0;
  }

  u16(value) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  u32(value) {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  u64(value) {
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
    return this;
  }

  raw(bytes) {
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.length;
    return this;
  }
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{name: string, blob: Blob, date?: Date}>} entries
 * @param {object} [options]
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Blob>}
 */
export async function createZip(entries, options = {}) {
  const { onProgress, signal } = options;
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [index, entry] of entries.entries()) {
    if (signal?.aborted) throw new DOMException('Archive cancelled', 'AbortError');

    const name = encoder.encode(entry.name);
    const size = entry.blob.size;
    const crc = await crc32Blob(entry.blob);
    const stamp = dosDateTime(entry.date instanceof Date ? entry.date : new Date());

    // A single entry needs Zip64 if it is ≥ 4 GiB, or if it starts past the
    // 4 GiB mark within the archive.
    const bigEntry = size > U32_MAX;
    const bigOffset = offset > U32_MAX;
    const localExtra = bigEntry ? 20 : 0;

    const local = new ByteWriter(30 + name.length + localExtra);
    local
      .u32(LOCAL_SIG)
      .u16(bigEntry ? 45 : 20) // version needed to extract
      .u16(0x0800) // flags: UTF-8 filenames
      .u16(0) // method: store
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(crc)
      .u32(bigEntry ? U32_MAX : size) // compressed size
      .u32(bigEntry ? U32_MAX : size) // uncompressed size
      .u16(name.length)
      .u16(localExtra)
      .raw(name);

    if (bigEntry) {
      local.u16(ZIP64_EXTRA_ID).u16(16).u64(size).u64(size);
    }

    parts.push(local.bytes, entry.blob);

    // The central directory repeats whichever oversized fields apply, in the
    // fixed order the spec gives: size, compressed size, then local offset.
    const centralExtraFields = (bigEntry ? 2 : 0) + (bigOffset ? 1 : 0);
    const centralExtra = centralExtraFields ? 4 + centralExtraFields * 8 : 0;

    const header = new ByteWriter(46 + name.length + centralExtra);
    header
      .u32(CENTRAL_SIG)
      .u16(bigEntry || bigOffset ? 45 : 20) // version made by
      .u16(bigEntry || bigOffset ? 45 : 20) // version needed
      .u16(0x0800)
      .u16(0)
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(crc)
      .u32(bigEntry ? U32_MAX : size)
      .u32(bigEntry ? U32_MAX : size)
      .u16(name.length)
      .u16(centralExtra)
      .u16(0) // file comment length
      .u16(0) // disk number start
      .u16(0) // internal attributes
      .u32(0) // external attributes
      .u32(bigOffset ? U32_MAX : offset)
      .raw(name);

    if (centralExtra) {
      header.u16(ZIP64_EXTRA_ID).u16(centralExtraFields * 8);
      if (bigEntry) header.u64(size).u64(size);
      if (bigOffset) header.u64(offset);
    }

    central.push(header.bytes);
    offset += local.bytes.length + size;

    onProgress?.(index + 1, entries.length);
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const count = entries.length;
  const needsZip64 = count > U16_MAX || centralOffset > U32_MAX || centralSize > U32_MAX;

  if (needsZip64) {
    const record = new ByteWriter(56);
    record
      .u32(ZIP64_EOCD_SIG)
      .u64(44) // size of this record, excluding the first 12 bytes
      .u16(45)
      .u16(45)
      .u32(0) // this disk
      .u32(0) // disk holding the central directory
      .u64(count)
      .u64(count)
      .u64(centralSize)
      .u64(centralOffset);

    const locator = new ByteWriter(20);
    locator
      .u32(ZIP64_LOCATOR_SIG)
      .u32(0)
      .u64(centralOffset + centralSize)
      .u32(1);

    central.push(record.bytes, locator.bytes);
  }

  const end = new ByteWriter(22);
  end
    .u32(EOCD_SIG)
    .u16(0)
    .u16(0)
    .u16(Math.min(count, U16_MAX))
    .u16(Math.min(count, U16_MAX))
    .u32(Math.min(centralSize, U32_MAX))
    .u32(Math.min(centralOffset, U32_MAX))
    .u16(0); // archive comment length

  return new Blob([...parts, ...central, end.bytes], { type: 'application/zip' });
}
