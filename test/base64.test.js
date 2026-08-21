import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE64_FORMATS,
  BASE64_FORMAT_IDS,
  base64FormatById,
  base64Length,
  base64Snippet,
  blobToBase64,
  bytesToBase64,
  dataUrl,
  snippetFilename,
} from '../js/lib/base64.js';

const bytes = (...values) => new Uint8Array(values);

test('bytesToBase64 matches the reference encoding', () => {
  assert.equal(bytesToBase64(bytes()), '');
  assert.equal(bytesToBase64(bytes(77)), 'TQ==');
  assert.equal(bytesToBase64(bytes(77, 97)), 'TWE=');
  assert.equal(bytesToBase64(bytes(77, 97, 110)), 'TWFu');
  // The bytes a PNG starts with — high bits and all.
  assert.equal(bytesToBase64(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'iVBORw0KGgo=');
});

test('bytesToBase64 handles blobs far past the argument limit', () => {
  const big = new Uint8Array(500_000);
  for (let at = 0; at < big.length; at++) big[at] = at % 256;

  const encoded = bytesToBase64(big);
  assert.equal(encoded, Buffer.from(big).toString('base64'));
  assert.equal(encoded.length, base64Length(big.length));
});

test('bytesToBase64 accepts a raw ArrayBuffer', () => {
  assert.equal(bytesToBase64(bytes(77, 97, 110).buffer), 'TWFu');
});

test('blobToBase64 encodes the blob it is given', async () => {
  const blob = new Blob([bytes(0xff, 0xd8, 0xff)], { type: 'image/jpeg' });
  assert.equal(await blobToBase64(blob), '/9j/');
});

test('base64Length predicts the encoded size without encoding', () => {
  assert.equal(base64Length(0), 0);
  assert.equal(base64Length(1), 4);
  assert.equal(base64Length(3), 4);
  assert.equal(base64Length(4), 8);
  assert.equal(base64Length(1024), 1368);
  // Nonsense in, zero out, rather than NaN reaching a size label.
  assert.equal(base64Length(undefined), 0);
  assert.equal(base64Length(-10), 0);
});

test('dataUrl names the type it carries', () => {
  assert.equal(dataUrl('image/webp', 'TWFu'), 'data:image/webp;base64,TWFu');
  assert.equal(dataUrl('', 'TWFu'), 'data:application/octet-stream;base64,TWFu');
});

const image = { base64: 'TWFu', mime: 'image/webp', name: 'holiday.webp', width: 800, height: 600 };

test('every advertised format produces its snippet', () => {
  assert.deepEqual(BASE64_FORMAT_IDS, ['data-url', 'raw', 'html', 'css', 'markdown']);

  assert.equal(base64Snippet('data-url', image), 'data:image/webp;base64,TWFu');
  assert.equal(base64Snippet('raw', image), 'TWFu');
  assert.equal(
    base64Snippet('html', image),
    '<img src="data:image/webp;base64,TWFu" alt="holiday" width="800" height="600">',
  );
  assert.equal(
    base64Snippet('css', image),
    'background-image: url("data:image/webp;base64,TWFu");',
  );
  assert.equal(base64Snippet('markdown', image), '![holiday](data:image/webp;base64,TWFu)');
});

test('the HTML snippet drops the size when it is unknown', () => {
  assert.equal(
    base64Snippet('html', { ...image, width: undefined, height: undefined }),
    '<img src="data:image/webp;base64,TWFu" alt="holiday">',
  );
});

test('snippets escape the filename they embed', () => {
  const hostile = { ...image, name: 'a "<b> & c".webp' };
  assert.equal(
    base64Snippet('html', hostile),
    '<img src="data:image/webp;base64,TWFu" alt="a &quot;&lt;b&gt; &amp; c&quot;" width="800" height="600">',
  );
  assert.equal(
    base64Snippet('markdown', { ...image, name: 'a [b] c.webp' }),
    '![a \\[b\\] c](data:image/webp;base64,TWFu)',
  );
});

test('an unknown format falls back to the data URL', () => {
  assert.equal(base64Snippet('nonsense', image), 'data:image/webp;base64,TWFu');
  assert.equal(base64FormatById('nonsense').id, 'data-url');
  assert.equal(base64FormatById('css').label, 'CSS background');
});

test('every format carries the fields the UI reads', () => {
  for (const format of BASE64_FORMATS) {
    assert.ok(format.id && format.label && format.extension && format.summary, format.id);
  }
});

test('snippetFilename keeps the image name and adds the text extension', () => {
  assert.equal(snippetFilename('holiday.webp', 'data-url'), 'holiday.webp.txt');
  assert.equal(snippetFilename('holiday.webp', 'raw'), 'holiday.webp.txt');
  assert.equal(snippetFilename('holiday.webp', 'html'), 'holiday.webp.html');
  assert.equal(snippetFilename('holiday.webp', 'css'), 'holiday.webp.css');
  assert.equal(snippetFilename('holiday.webp', 'markdown'), 'holiday.webp.md');
});

test('snippetFilename sanitises the name it was handed', () => {
  assert.equal(snippetFilename('../../etc/passwd.png', 'data-url'), 'etc_passwd.png.txt');
  assert.equal(snippetFilename('', 'data-url'), 'image.txt');
});
