import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeGeometry,
  downscaleSteps,
  normalizeRotation,
  orientedSize,
  scaleGeometry,
  MAX_DIMENSION,
  MAX_PIXELS,
} from '../js/lib/geometry.js';

test('unknown and "none" modes pass the image through untouched', () => {
  for (const mode of ['none', 'nonsense', undefined]) {
    const geo = computeGeometry(800, 600, { mode });
    assert.deepEqual(
      { sx: geo.sx, sy: geo.sy, sw: geo.sw, sh: geo.sh, dw: geo.dw, dh: geo.dh },
      { sx: 0, sy: 0, sw: 800, sh: 600, dw: 800, dh: 600 },
    );
  }
});

test('percent scales both sides and rounds to whole pixels', () => {
  assert.partialDeepStrictEqual(
    computeGeometry(800, 600, { mode: 'percent', scale: 50 }),
    { dw: 400, dh: 300 },
  );
  assert.partialDeepStrictEqual(
    computeGeometry(801, 601, { mode: 'percent', scale: 33 }),
    { dw: 264, dh: 198 },
  );
  // A nonsensical scale must not produce a zero-sized canvas.
  assert.partialDeepStrictEqual(
    computeGeometry(800, 600, { mode: 'percent', scale: 0 }),
    { dw: 800, dh: 600 },
  );
});

test('percent above 100 enlarges', () => {
  assert.partialDeepStrictEqual(
    computeGeometry(400, 300, { mode: 'percent', scale: 200 }),
    { dw: 800, dh: 600 },
  );
});

test('fit constrains whichever side binds first', () => {
  // Landscape into a square box: width binds.
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'fit', width: 1000, height: 1000 }),
    { dw: 1000, dh: 500 },
  );
  // Portrait into the same box: height binds.
  assert.partialDeepStrictEqual(
    computeGeometry(2000, 4000, { mode: 'fit', width: 1000, height: 1000 }),
    { dw: 500, dh: 1000 },
  );
});

test('fit with one side blank constrains only that axis', () => {
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'fit', width: 1000, height: 0 }),
    { dw: 1000, dh: 500 },
  );
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'fit', width: 0, height: 500 }),
    { dw: 1000, dh: 500 },
  );
});

test('fit with no box at all is a no-op', () => {
  assert.partialDeepStrictEqual(
    computeGeometry(640, 480, { mode: 'fit', width: 0, height: 0 }),
    { dw: 640, dh: 480 },
  );
});

test('noUpscale stops small images being blown up', () => {
  const box = { mode: 'fit', width: 4000, height: 4000 };
  assert.partialDeepStrictEqual(computeGeometry(800, 600, box), { dw: 4000, dh: 3000 });
  assert.partialDeepStrictEqual(
    computeGeometry(800, 600, { ...box, noUpscale: true }),
    { dw: 800, dh: 600 },
  );
});

test('longest edge caps the larger side either way round', () => {
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'longest', edge: 1000 }),
    { dw: 1000, dh: 500 },
  );
  assert.partialDeepStrictEqual(
    computeGeometry(2000, 4000, { mode: 'longest', edge: 1000 }),
    { dw: 500, dh: 1000 },
  );
  assert.partialDeepStrictEqual(
    computeGeometry(500, 400, { mode: 'longest', edge: 1000, noUpscale: true }),
    { dw: 500, dh: 400 },
  );
});

test('cover fills the box exactly and crops the overflow', () => {
  const geo = computeGeometry(4000, 2000, { mode: 'cover', width: 1000, height: 1000 });
  assert.equal(geo.dw, 1000);
  assert.equal(geo.dh, 1000);
  // The crop is a centred square taken from the middle of the landscape source.
  assert.equal(Math.round(geo.sw), 2000);
  assert.equal(Math.round(geo.sh), 2000);
  assert.equal(Math.round(geo.sx), 1000);
  assert.equal(Math.round(geo.sy), 0);
});

test('cover honours the crop anchor', () => {
  const opts = { mode: 'cover', width: 1000, height: 1000 };
  const left = computeGeometry(4000, 2000, { ...opts, position: 'left' });
  const right = computeGeometry(4000, 2000, { ...opts, position: 'right' });

  assert.equal(Math.round(left.sx), 0);
  assert.equal(Math.round(right.sx), 2000);
  assert.equal(left.dw, right.dw);
});

test('cover with only one side falls back to fit', () => {
  assert.deepEqual(
    computeGeometry(4000, 2000, { mode: 'cover', width: 1000, height: 0 }),
    computeGeometry(4000, 2000, { mode: 'fit', width: 1000, height: 0 }),
  );
});

test('cover with noUpscale shrinks the box rather than enlarging the image', () => {
  const geo = computeGeometry(500, 500, {
    mode: 'cover', width: 1000, height: 1000, noUpscale: true,
  });
  assert.equal(geo.dw, 500);
  assert.equal(geo.dh, 500);
});

test('exact stretches, and derives a blank side from the source ratio', () => {
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'exact', width: 300, height: 300 }),
    { dw: 300, dh: 300 },
  );
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'exact', width: 300, height: 0 }),
    { dw: 300, dh: 150 },
  );
  assert.partialDeepStrictEqual(
    computeGeometry(4000, 2000, { mode: 'exact', width: 0, height: 150 }),
    { dw: 300, dh: 150 },
  );
});

test('output is clamped to the canvas limits without distorting the aspect', () => {
  const geo = computeGeometry(20000, 10000, { mode: 'percent', scale: 100 });
  assert.ok(geo.dw <= MAX_DIMENSION && geo.dh <= MAX_DIMENSION);
  assert.ok(geo.dw * geo.dh <= MAX_PIXELS);
  assert.equal(geo.clamped, true);
  assert.ok(Math.abs(geo.dw / geo.dh - 2) < 0.01, 'aspect ratio survives clamping');
});

test('ordinary sizes are not flagged as clamped', () => {
  assert.equal(computeGeometry(1920, 1080, { mode: 'none' }).clamped, false);
});

test('rotation swaps the axes only on quarter turns', () => {
  assert.deepEqual(orientedSize(800, 600, 0), { width: 800, height: 600 });
  assert.deepEqual(orientedSize(800, 600, 90), { width: 600, height: 800 });
  assert.deepEqual(orientedSize(800, 600, 180), { width: 800, height: 600 });
  assert.deepEqual(orientedSize(800, 600, 270), { width: 600, height: 800 });
});

test('rotation is folded into 0/90/180/270', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation('180'), 180);
  assert.equal(normalizeRotation(undefined), 0);
});

test('scaleGeometry keeps the crop and shrinks the output', () => {
  const geo = computeGeometry(4000, 2000, { mode: 'cover', width: 1000, height: 1000 });
  const smaller = scaleGeometry(geo, 0.5);

  assert.equal(smaller.dw, 500);
  assert.equal(smaller.dh, 500);
  assert.equal(smaller.sx, geo.sx);
  assert.equal(smaller.sw, geo.sw);
});

test('downscaleSteps halves until the last hop is under 2x', () => {
  assert.deepEqual(
    downscaleSteps(4000, 2000, 200, 100),
    [
      { width: 2000, height: 1000 },
      { width: 1000, height: 500 },
      { width: 500, height: 250 },
      { width: 250, height: 125 },
    ],
  );
});

test('downscaleSteps returns nothing when there is little to remove', () => {
  // Under a 2x reduction the browser's own filtering is good enough.
  assert.deepEqual(downscaleSteps(300, 300, 200, 200), []);
  assert.deepEqual(downscaleSteps(200, 200, 200, 200), []);
  assert.deepEqual(downscaleSteps(100, 100, 400, 400), [], 'enlarging needs no steps');
});

test('downscaleSteps never drops below the destination size', () => {
  for (const [sw, sh, dw, dh] of [[4000, 4000, 3, 3], [1024, 768, 100, 75], [999, 111, 100, 11]]) {
    const steps = downscaleSteps(sw, sh, dw, dh);
    assert.ok(
      steps.every((step) => step.width >= dw && step.height >= dh),
      `steps stayed above the target for ${sw}x${sh} → ${dw}x${dh}`,
    );
    // The last step must be close enough that one more draw finishes the job.
    const last = steps.at(-1) ?? { width: sw, height: sh };
    assert.ok(last.width <= dw * 2 || last.height <= dh * 2);
  }
});

test('downscaleSteps stops when either axis is close enough', () => {
  // A stretched resize: the height barely changes, so halving must not run on
  // width alone and squash the image.
  assert.deepEqual(downscaleSteps(4000, 100, 100, 100), []);
});
