import test from 'node:test';
import assert from 'node:assert/strict';

import { INPUT_SIZE, alphaToMask, maskCoverage, toModelInput } from '../js/lib/tensor.js';
import { backgroundWeights, paintBackground } from '../js/lib/matte.js';

const image = (pixels, width, height) => ({
  data: Uint8ClampedArray.from(pixels.flat()),
  width,
  height,
});

test('the model input size is a multiple of 32, as MODNet requires', () => {
  assert.equal(INPUT_SIZE % 32, 0);
});

test('pixels become planar RGB scaled to −1…1', () => {
  const source = image([
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [128, 64, 192, 255],
    [255, 0, 0, 255],
  ], 2, 2);

  const tensor = toModelInput(source);

  assert.equal(tensor.length, 12, 'three planes of four pixels');
  assert.equal(tensor[0], -1, 'black is the bottom of the range');
  assert.equal(tensor[1], 1, 'white is the top');
  // Planar: reds 0-3, greens 4-7, blues 8-11.
  assert.ok(Math.abs(tensor[2] - (128 / 255 - 0.5) / 0.5) < 1e-6, 'red plane');
  assert.ok(Math.abs(tensor[4 + 2] - (64 / 255 - 0.5) / 0.5) < 1e-6, 'green plane');
  assert.ok(Math.abs(tensor[8 + 2] - (192 / 255 - 0.5) / 0.5) < 1e-6, 'blue plane');
});

test('the alpha channel is dropped, not folded into the colours', () => {
  const opaque = toModelInput(image([[10, 20, 30, 255]], 1, 1));
  const transparent = toModelInput(image([[10, 20, 30, 0]], 1, 1));

  assert.deepEqual([...opaque], [...transparent]);
});

test('the model output becomes an opaque greyscale mask', () => {
  const mask = alphaToMask(Float32Array.from([0, 0.5, 1, 0.25]), 2, 2);

  assert.equal(mask.width, 2);
  assert.equal(mask.height, 2);
  assert.deepEqual([...mask.data.slice(0, 4)], [0, 0, 0, 255], 'background, still opaque');
  assert.deepEqual([...mask.data.slice(8, 12)], [255, 255, 255, 255], 'foreground');
  assert.equal(mask.data[4], 128, 'halfway is halfway');
});

test('a broken model export cannot smuggle NaN through as opacity', () => {
  const mask = alphaToMask([NaN, undefined, -3, 4], 4, 1);

  assert.deepEqual([...mask.data.filter((_, index) => index % 4 === 0)], [0, 0, 0, 255]);
});

test('coverage counts the pixels the model decided to keep', () => {
  assert.equal(maskCoverage(alphaToMask([1, 1, 0, 0], 2, 2)), 0.5);
  assert.equal(maskCoverage(alphaToMask([0, 0, 0, 0], 2, 2)), 0, 'found nobody');
  assert.equal(maskCoverage(alphaToMask([1, 1, 1, 1], 2, 2)), 1, 'kept everything');
  assert.equal(maskCoverage({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), 0);
});

test('a foreground mask inverts into background weights', () => {
  // The model says how much is person; the painter asks how much is wall.
  const weights = backgroundWeights(alphaToMask([1, 0, 0.5], 3, 1));

  assert.deepEqual([...weights], [0, 255, 127]);
});

test('the model mask and the painter agree on which way round they are', () => {
  // End to end over the two modules: a person on the left, wall on the right,
  // painted white. Getting the inversion wrong here would white out the face.
  const photo = image([
    [10, 20, 30, 255],
    [200, 200, 200, 255],
  ], 2, 1);

  paintBackground(photo, backgroundWeights(alphaToMask([1, 0], 2, 1)), { r: 255, g: 255, b: 255 });

  assert.deepEqual([...photo.data.slice(0, 3)], [10, 20, 30], 'the person is untouched');
  assert.deepEqual([...photo.data.slice(4, 7)], [255, 255, 255], 'the wall is white');
});
