import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZip, crc32, crc32Update, dosDateTime } from '../js/lib/zip.js';

const encoder = new TextEncoder();
const bytesOf = (text) => encoder.encode(text);

/** Minimal reader for the parts of the format the writer emits. */
function readArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // The end-of-central-directory record is the last 22 bytes when, as here,
  // there is no archive comment.
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'EOCD signature');

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  assert.equal(centralOffset + centralSize, eocd, 'central directory abuts the EOCD');

  const entries = [];
  let cursor = centralOffset;

  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, 'central header signature');

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    assert.equal(view.getUint32(localOffset, true), 0x04034b50, 'local header signature');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      flags,
      method,
      crc,
      size,
      compressed,
      data: bytes.subarray(dataStart, dataStart + size),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { count, entries };
}

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(bytesOf('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('crc32Update composes across chunk boundaries', () => {
  const whole = crc32(bytesOf('hello world'));

  let running = 0xffffffff;
  running = crc32Update(running, bytesOf('hello '));
  running = crc32Update(running, bytesOf('world'));

  assert.equal((running ^ 0xffffffff) >>> 0, whole);
});

test('dosDateTime packs a date into the DOS fields', () => {
  const { date, time } = dosDateTime(new Date(2024, 4, 6, 13, 30, 20));
  assert.equal((date >> 9) + 1980, 2024);
  assert.equal((date >> 5) & 0x0f, 5, 'May');
  assert.equal(date & 0x1f, 6);
  assert.equal(time >> 11, 13);
  assert.equal((time >> 5) & 0x3f, 30);
});

test('dosDateTime clamps dates the format cannot hold', () => {
  assert.equal(dosDateTime(new Date(1970, 0, 1)).date >> 9, 0, 'floors at 1980');
  assert.equal(dosDateTime(new Date(2200, 0, 1)).date >> 9, 2107 - 1980);
});

test('a built archive round-trips through a reader', async () => {
  const files = [
    { name: 'first.txt', body: 'hello world' },
    { name: 'nested/second.bin', body: 'x'.repeat(5000) },
    { name: 'unicode-café-🖼.txt', body: 'accents and emoji' },
  ];

  const zip = await createZip(
    files.map((file) => ({ name: file.name, blob: new Blob([file.body]) })),
  );
  assert.equal(zip.type, 'application/zip');

  const parsed = readArchive(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(parsed.count, files.length);

  for (const [index, entry] of parsed.entries.entries()) {
    const expected = bytesOf(files[index].body);
    assert.equal(entry.name, files[index].name);
    assert.equal(entry.method, 0, 'stored, not deflated');
    assert.equal(entry.flags & 0x0800, 0x0800, 'UTF-8 name flag is set');
    assert.equal(entry.size, expected.length);
    assert.equal(entry.compressed, entry.size, 'stored entries report equal sizes');
    assert.equal(entry.crc, crc32(expected));
    assert.deepEqual(entry.data, expected);
  }
});

test('an empty archive is still a valid archive', async () => {
  const zip = await createZip([]);
  const parsed = readArchive(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(parsed.count, 0);
  assert.equal(zip.size, 22);
});

test('progress is reported once per entry, in order', async () => {
  const seen = [];
  await createZip(
    ['a', 'b', 'c'].map((name) => ({ name, blob: new Blob([name]) })),
    { onProgress: (done, total) => seen.push([done, total]) },
  );
  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
});

test('an abort signal stops the build', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => createZip([{ name: 'a', blob: new Blob(['a']) }], { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('the CRC is computed over chunked reads of a large blob', async () => {
  // Comfortably past the 1 MiB read window, so the streaming path is exercised.
  const payload = new Uint8Array(3 * 1024 * 1024 + 17);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;

  const zip = await createZip([{ name: 'big.bin', blob: new Blob([payload]) }]);
  const parsed = readArchive(new Uint8Array(await zip.arrayBuffer()));

  assert.equal(parsed.entries[0].crc, crc32(payload));
  assert.equal(parsed.entries[0].size, payload.length);
});

test('the archive is readable by the system unzip', async (t) => {
  let unzip;
  try {
    unzip = execFileSync('which', ['unzip']).toString().trim();
  } catch {
    t.skip('unzip is not installed');
    return;
  }

  const zip = await createZip([
    { name: 'one.txt', blob: new Blob(['first file']) },
    { name: 'dir/two.txt', blob: new Blob(['second file']) },
  ]);

  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    const path = join(dir, 'out.zip');
    writeFileSync(path, Buffer.from(await zip.arrayBuffer()));

    // -t verifies every CRC in the archive.
    const output = execFileSync(unzip, ['-t', path]).toString();
    assert.match(output, /No errors detected in compressed data/);

    execFileSync(unzip, ['-o', '-q', path, '-d', dir]);
    assert.equal(
      execFileSync('cat', [join(dir, 'dir/two.txt')]).toString(),
      'second file',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
