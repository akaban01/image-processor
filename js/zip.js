/**
 * Minimal ZIP writer (store method, no compression) so "Download all" needs no
 * third-party library. Already-compressed images gain nothing from deflate.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Pack a Date into the DOS date/time pair used by the ZIP headers. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * @param {Array<{name: string, blob: Blob}>} entries
 * @returns {Promise<Blob>} a ZIP archive
 */
export async function createZip(entries) {
  const encoder = new TextEncoder();
  const now = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, 0x0800, true);     // flags: UTF-8 file names
    lv.setUint16(8, 0, true);          // method: store
    lv.setUint16(10, now.time, true);
    lv.setUint16(12, now.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    chunks.push(local, data);

    const header = new Uint8Array(46 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x02014b50, true); // central directory header signature
    hv.setUint16(4, 20, true);         // version made by
    hv.setUint16(6, 20, true);         // version needed
    hv.setUint16(8, 0x0800, true);
    hv.setUint16(10, 0, true);
    hv.setUint16(12, now.time, true);
    hv.setUint16(14, now.date, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, data.length, true);
    hv.setUint32(24, data.length, true);
    hv.setUint16(28, name.length, true);
    hv.setUint32(42, offset, true);    // offset of local header
    header.set(name, 46);
    central.push(header);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);   // end of central directory signature
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
