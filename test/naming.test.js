import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplate,
  baseName,
  sanitizeFilename,
  uniqueName,
} from '../js/lib/naming.js';

test('baseName strips the final extension only', () => {
  assert.equal(baseName('photo.jpg'), 'photo');
  assert.equal(baseName('photo.final.jpg'), 'photo.final');
  assert.equal(baseName('noextension'), 'noextension');
  assert.equal(baseName('.hidden'), '.hidden', 'a leading dot is part of the name');
});

test('sanitizeFilename removes path separators', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeFilename('a/b\\c.png'), 'a_b_c.png');
  assert.equal(sanitizeFilename('/absolute.png'), 'absolute.png');
});

test('sanitizeFilename removes control characters and illegal punctuation', () => {
  assert.equal(sanitizeFilename('bad\u0000name.png'), 'bad_name.png');
  assert.equal(sanitizeFilename('a:b*c?d".png'), 'a_b_c_d_.png');
});

test('sanitizeFilename trims trailing dots and spaces', () => {
  assert.equal(sanitizeFilename('trailing.  '), 'trailing');
  assert.equal(sanitizeFilename('  leading.png'), 'leading.png');
});

test('sanitizeFilename dodges Windows device names', () => {
  assert.equal(sanitizeFilename('con.png'), '_con.png');
  assert.equal(sanitizeFilename('LPT1.webp'), '_LPT1.webp');
  assert.equal(sanitizeFilename('console.png'), 'console.png', 'only exact matches');
});

test('sanitizeFilename never returns an empty string', () => {
  assert.equal(sanitizeFilename(''), 'image');
  assert.equal(sanitizeFilename('...'), 'image');
  assert.equal(sanitizeFilename(null), 'image');
});

test('sanitizeFilename caps the length but keeps the extension', () => {
  const long = `${'x'.repeat(400)}.webp`;
  const safe = sanitizeFilename(long);
  assert.ok(safe.length <= 200);
  assert.ok(safe.endsWith('.webp'));
});

test('applyTemplate fills in every token', () => {
  const name = applyTemplate('{name}-{w}x{h}-{format}-{index}-{date}.{ext}', {
    name: 'beach.jpg',
    ext: 'webp',
    width: 1920,
    height: 1080,
    format: 'WebP',
    index: 3,
    date: new Date('2024-05-06T00:00:00Z'),
  });
  assert.equal(name, 'beach-1920x1080-WebP-3-2024-05-06.webp');
});

test('applyTemplate appends the extension when the pattern omits it', () => {
  assert.equal(applyTemplate('{name}', { name: 'a.png', ext: 'webp' }), 'a.webp');
  assert.equal(applyTemplate('{name}.{ext}', { name: 'a.png', ext: 'webp' }), 'a.webp');
  assert.equal(applyTemplate('fixed', { name: 'a.png', ext: 'jpg' }), 'fixed.jpg');
});

test('applyTemplate does not double up an extension the user typed', () => {
  assert.equal(applyTemplate('{name}.webp', { name: 'a.png', ext: 'webp' }), 'a.webp');
  assert.equal(applyTemplate('{name}.WEBP', { name: 'a.png', ext: 'webp' }), 'a.WEBP');
});

test('applyTemplate leaves unknown tokens visible', () => {
  assert.equal(applyTemplate('{name}-{bogus}.{ext}', { name: 'a', ext: 'png' }), 'a-{bogus}.png');
});

test('applyTemplate sanitises what the template produces', () => {
  assert.equal(
    applyTemplate('{name}.{ext}', { name: '../../evil.png', ext: 'webp' }),
    'evil.webp',
  );
  assert.equal(applyTemplate('a/b/{name}.{ext}', { name: 'c', ext: 'png' }), 'a_b_c.png');
});

test('applyTemplate falls back sensibly on missing context', () => {
  assert.equal(applyTemplate('', {}), 'image.img');
  assert.equal(applyTemplate(undefined, { name: 'x.png', ext: 'jpg' }), 'x.jpg');
});

test('uniqueName suffixes collisions before the extension', () => {
  const used = new Set();
  assert.equal(uniqueName('a.webp', used), 'a.webp');
  assert.equal(uniqueName('a.webp', used), 'a-2.webp');
  assert.equal(uniqueName('a.webp', used), 'a-3.webp');
  assert.equal(uniqueName('b.webp', used), 'b.webp');
});

test('uniqueName compares case-insensitively, as Windows and macOS do', () => {
  const used = new Set();
  assert.equal(uniqueName('Photo.webp', used), 'Photo.webp');
  assert.equal(uniqueName('photo.webp', used), 'photo-2.webp');
});

test('uniqueName skips a suffix that is itself already taken', () => {
  const used = new Set();
  uniqueName('a.webp', used);
  uniqueName('a-2.webp', used);
  assert.equal(uniqueName('a.webp', used), 'a-3.webp');
});
