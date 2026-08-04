import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, parseByteSize, sizeDelta } from '../js/lib/bytes.js';

test('formatBytes picks a readable unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024), '10 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
});

test('formatBytes keeps one decimal only below ten of a unit', () => {
  assert.equal(formatBytes(9.4 * 1024), '9.4 KB');
  assert.equal(formatBytes(12.6 * 1024), '13 KB');
});

test('formatBytes survives nonsense input', () => {
  assert.equal(formatBytes(NaN), '—');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(Infinity), '—');
  assert.equal(formatBytes(-2048), '-2.0 KB');
});

test('parseByteSize understands the units people type', () => {
  assert.equal(parseByteSize('500'), 500 * 1024, 'a bare number means kilobytes');
  assert.equal(parseByteSize('500kb'), 500 * 1024);
  assert.equal(parseByteSize('500 KB'), 500 * 1024);
  assert.equal(parseByteSize('500KiB'), 500 * 1024);
  assert.equal(parseByteSize('1.5 MB'), Math.round(1.5 * 1024 ** 2));
  assert.equal(parseByteSize('2m'), 2 * 1024 ** 2);
  assert.equal(parseByteSize('900b'), 900);
  assert.equal(parseByteSize('1g'), 1024 ** 3);
});

test('parseByteSize rejects what it cannot read', () => {
  for (const input of ['', '   ', 'abc', '-5', '0', 'MB', null, undefined, {}]) {
    assert.equal(parseByteSize(input), 0, `expected 0 for ${JSON.stringify(input)}`);
  }
});

test('parseByteSize passes numbers straight through as bytes', () => {
  assert.equal(parseByteSize(2048), 2048);
  assert.equal(parseByteSize(0), 0);
  assert.equal(parseByteSize(-1), 0);
});

test('parseByteSize honours a caller-chosen default unit', () => {
  assert.equal(parseByteSize('4', 'mb'), 4 * 1024 ** 2);
  assert.equal(parseByteSize('4', 'b'), 4);
});

test('sizeDelta describes the direction of the change', () => {
  assert.deepEqual(sizeDelta(1000, 500), { direction: 'down', percent: 50, label: '−50%' });
  assert.deepEqual(sizeDelta(1000, 1500), { direction: 'up', percent: 50, label: '+50%' });
  assert.deepEqual(sizeDelta(1000, 1000), { direction: 'same', percent: 0, label: '±0%' });
});

test('sizeDelta does not divide by zero', () => {
  assert.equal(sizeDelta(0, 500).direction, 'same');
  assert.equal(sizeDelta(NaN, 500).direction, 'same');
});
