import test from 'node:test';
import assert from 'node:assert/strict';

import { pickSmallest, searchQuality } from '../js/lib/encode.js';

/**
 * A stand-in encoder whose output size rises with quality, which is how every
 * real lossy encoder behaves. Records the qualities it was asked for.
 */
function fakeEncoder({ scale = 1_000_000, floor = 0 } = {}) {
  const calls = [];
  return {
    calls,
    encode: async (quality) => {
      calls.push(quality);
      return { size: Math.round(floor + quality * scale) };
    },
  };
}

test('one encode is enough when the requested quality already fits', async () => {
  const encoder = fakeEncoder();
  const result = await searchQuality({ encode: encoder.encode, budget: 1_000_000, max: 0.9 });

  assert.equal(result.attempts, 1);
  assert.equal(result.quality, 0.9);
  assert.equal(result.withinBudget, true);
  assert.deepEqual(encoder.calls, [0.9]);
});

test('the search lands on the highest quality that fits', async () => {
  const encoder = fakeEncoder({ scale: 1_000_000 });
  // A budget of 500 KB corresponds to quality 0.5 exactly.
  const result = await searchQuality({
    encode: encoder.encode,
    budget: 500_000,
    min: 0.2,
    max: 0.95,
    steps: 8,
  });

  assert.equal(result.withinBudget, true);
  assert.ok(result.blob.size <= 500_000);
  assert.ok(result.quality > 0.45, `expected to get close to 0.5, got ${result.quality}`);
});

test('a budget nothing can meet is reported rather than hidden', async () => {
  const encoder = fakeEncoder({ floor: 900_000 });
  const result = await searchQuality({ encode: encoder.encode, budget: 100_000, min: 0.2, max: 0.95 });

  assert.equal(result.withinBudget, false);
  assert.equal(result.quality, 0.2, 'gives back the smallest it managed');
  assert.equal(result.attempts, 2, 'stops after probing the ceiling and the floor');
});

test('the search is bounded and never repeats a quality', async () => {
  const encoder = fakeEncoder();
  const result = await searchQuality({
    encode: encoder.encode,
    budget: 613_000,
    min: 0.05,
    max: 1,
    steps: 6,
  });

  assert.ok(result.attempts <= 8, `expected at most 8 encodes, got ${result.attempts}`);
  assert.equal(new Set(encoder.calls).size, encoder.calls.length, 'no duplicate encodes');
});

test('every quality tried is rounded to two decimals', async () => {
  const encoder = fakeEncoder();
  await searchQuality({ encode: encoder.encode, budget: 333_333, min: 0.05, max: 1, steps: 8 });

  for (const quality of encoder.calls) {
    assert.equal(quality, Math.round(quality * 100) / 100);
  }
});

test('an aborted search rejects instead of encoding again', async () => {
  const controller = new AbortController();
  const encoder = fakeEncoder();

  const encode = async (quality) => {
    controller.abort();
    return encoder.encode(quality);
  };

  await assert.rejects(
    () => searchQuality({ encode, budget: 1, min: 0.2, max: 0.95, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('pickSmallest returns the smallest candidate', () => {
  const small = { blob: { size: 10 } };
  const large = { blob: { size: 99 } };

  assert.equal(pickSmallest([large, small]), small);
  assert.equal(pickSmallest([small, large]), small);
});

test('pickSmallest keeps the earlier entry on a tie', () => {
  const first = { blob: { size: 10 }, id: 'first' };
  const second = { blob: { size: 10 }, id: 'second' };
  assert.equal(pickSmallest([first, second]).id, 'first');
});

test('pickSmallest ignores holes and empty input', () => {
  assert.equal(pickSmallest([]), null);
  assert.equal(pickSmallest([null, undefined, {}]), null);
  assert.deepEqual(pickSmallest([null, { blob: { size: 5 } }]), { blob: { size: 5 } });
});
