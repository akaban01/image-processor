import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TOLERANCE,
  PLAUSIBLE_COVERAGE,
  borderReference,
  buildBackgroundMask,
  featherMask,
  featherRadiusFor,
  paintBackground,
  parseHexColour,
  replaceBackground,
} from '../js/lib/matte.js';

/**
 * A stand-in portrait: a flat wall with an oval head in the middle and
 * shoulders running off the bottom edge, which is the shape every document
 * photo has and the shape the matte has to survive.
 */
function portrait({
  width = 60,
  height = 60,
  wall = [235, 235, 235],
  subject = [40, 40, 60],
  noise = 0,
} = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;

  const headCx = width / 2;
  const headCy = height * 0.45;
  const headRx = width * 0.22;
  const headRy = height * 0.3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inHead = ((x - headCx) / headRx) ** 2 + ((y - headCy) / headRy) ** 2 <= 1;
      const inShoulders = y > height * 0.82
        && Math.abs(x - headCx) < width * 0.36;

      const colour = inHead || inShoulders ? subject : wall;
      const offset = (y * width + x) * 4;

      // A deterministic wobble, so "an evenly lit wall" is not a perfectly
      // uniform one — real walls never are.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const jitter = noise ? ((seed >> 16) % (noise * 2 + 1)) - noise : 0;

      data[offset] = colour[0] + jitter;
      data[offset + 1] = colour[1] + jitter;
      data[offset + 2] = colour[2] + jitter;
      data[offset + 3] = 255;
    }
  }

  return { data, width, height };
}

const pixelAt = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
};

const maskAt = (mask, image, x, y) => mask[y * image.width + x];

test('a hex colour parses, and anything else refuses to', () => {
  assert.deepEqual(parseHexColour('#ffffff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColour('#102030'), { r: 16, g: 32, b: 48 });
  assert.equal(parseHexColour('#fff'), null);
  assert.equal(parseHexColour('white'), null);
  assert.equal(parseHexColour(''), null);
  assert.equal(parseHexColour(null), null);
});

test('the reference colour is the wall, not the subject', () => {
  const image = portrait();
  const reference = borderReference(image);

  assert.ok(Math.abs(reference.r - 235) <= 2, `got ${reference.r}`);
  assert.ok(Math.abs(reference.b - 235) <= 2);
});

test('the reference survives a blemish on the edge', () => {
  const image = portrait();
  // A light switch in the top corner: three pixels of something very dark.
  for (let x = 0; x < 3; x++) {
    const offset = x * 4;
    image.data[offset] = 0;
    image.data[offset + 1] = 0;
    image.data[offset + 2] = 0;
  }

  const reference = borderReference(image);
  assert.ok(reference.r > 200, 'a median ignores the outlier');
});

test('an empty image has no reference to give', () => {
  assert.equal(borderReference({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), null);
});

test('the flood takes the wall and leaves the person', () => {
  const image = portrait();
  const { mask, coverage } = buildBackgroundMask(image, { tolerance: DEFAULT_TOLERANCE });

  assert.equal(maskAt(mask, image, 0, 0), 255, 'the top corner is wall');
  assert.equal(maskAt(mask, image, 59, 0), 255);
  assert.equal(maskAt(mask, image, 30, 27), 0, 'the middle of the head is kept');
  assert.equal(maskAt(mask, image, 30, 58), 0, 'the shoulders are kept');
  assert.ok(coverage > 0.3 && coverage < 0.85, `coverage was ${coverage}`);
});

test('the flood follows an unevenly lit wall', () => {
  const image = portrait({ noise: 6 });
  const { mask } = buildBackgroundMask(image, { tolerance: DEFAULT_TOLERANCE });

  assert.equal(maskAt(mask, image, 0, 0), 255);
  assert.equal(maskAt(mask, image, 59, 30), 255, 'still wall halfway down the side');
  assert.equal(maskAt(mask, image, 30, 27), 0, 'the head is still the head');
});

test('the shoulders are safe even though they reach the bottom edge', () => {
  const image = portrait();
  const { mask } = buildBackgroundMask(image);

  // The bottom edge is deliberately not seeded: a shoulder there would
  // otherwise be the starting point for eating the subject.
  for (let x = 22; x < 38; x++) {
    assert.equal(maskAt(mask, image, x, 59), 0, `bottom pixel ${x} kept`);
  }
});

test('a subject the same colour as the wall cannot be separated', () => {
  // Stated as a test because it is the feature's real limit, not a bug to be
  // discovered later: this is why the UI warns instead of promising.
  const image = portrait({ subject: [232, 232, 232] });
  const { coverage } = buildBackgroundMask(image);

  assert.ok(coverage > PLAUSIBLE_COVERAGE.max, `coverage was ${coverage}`);
});

test('a busy background is reported rather than mangled', () => {
  const image = portrait({ width: 40, height: 40 });
  // Scribble over the wall so no contiguous run of it survives.
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] > 200) image.data[index] = (index * 37) % 255;
  }

  const { coverage } = buildBackgroundMask(image, { tolerance: 10 });
  assert.ok(coverage < PLAUSIBLE_COVERAGE.min, `coverage was ${coverage}`);
});

test('a tolerance of zero keeps almost everything', () => {
  const image = portrait({ noise: 6 });
  const tight = buildBackgroundMask(image, { tolerance: 0 });
  const loose = buildBackgroundMask(image, { tolerance: 60 });

  assert.ok(tight.coverage < loose.coverage, 'tolerance is the size of the flood');
});

test('feathering turns a hard edge into a ramp', () => {
  const image = portrait();
  const { mask } = buildBackgroundMask(image);
  const soft = featherMask(mask, image.width, image.height, 2);

  const values = new Set(soft);
  assert.ok(values.size > 2, 'more than just 0 and 255');
  assert.equal(soft[0], 255, 'deep inside the wall is untouched');
  assert.equal(soft[image.width * 27 + 30], 0, 'deep inside the head is untouched');
});

test('a feather radius of zero is a no-op', () => {
  const mask = Uint8Array.from([0, 255, 0, 255]);
  assert.equal(featherMask(mask, 2, 2, 0), mask);
});

test('the feather radius grows with the image', () => {
  assert.equal(featherRadiusFor(600, 600), 2);
  assert.equal(featherRadiusFor(100, 100), 1, 'never zero');
  assert.equal(featherRadiusFor(4000, 3000), 6, 'capped, so a huge image stays quick');
});

test('painting fills the masked pixels and blends the soft ones', () => {
  const image = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
  };

  paintBackground(image, Uint8Array.from([255, 128, 0]), { r: 255, g: 255, b: 255 });

  assert.deepEqual(pixelAt(image, 0, 0), [255, 255, 255, 255], 'fully background');
  assert.equal(pixelAt(image, 1, 0)[0], 128, 'halfway blended');
  assert.deepEqual(pixelAt(image, 2, 0), [0, 0, 0, 255], 'untouched');
});

test('replacing the background whitens the wall and keeps the face', () => {
  const image = portrait({ noise: 4 });
  const report = replaceBackground(image, { background: '#ffffff' });

  assert.equal(report.applied, true);
  assert.equal(report.plausible, true);

  for (const [x, y] of [[0, 0], [59, 0], [0, 20], [59, 20]]) {
    assert.deepEqual(pixelAt(image, x, y), [255, 255, 255, 255], `corner ${x},${y} is white`);
  }
  assert.ok(pixelAt(image, 30, 27)[0] < 80, 'the head is still dark');
});

test('replacing the background can paint any colour, not just white', () => {
  const image = portrait();
  replaceBackground(image, { background: '#ff0000' });

  assert.deepEqual(pixelAt(image, 0, 0), [255, 0, 0, 255]);
});

test('an unusable request changes nothing', () => {
  const image = portrait();
  const before = image.data.slice();

  assert.deepEqual(
    replaceBackground(image, { background: 'white' }),
    { applied: false, coverage: 0, plausible: false },
  );
  assert.deepEqual(image.data, before, 'the pixels were left alone');

  assert.equal(replaceBackground(image, {}).applied, false);
  assert.equal(
    replaceBackground({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, { background: '#fff' })
      .applied,
    false,
  );
});

test('an already-transparent pixel becomes opaque once painted', () => {
  const image = portrait();
  image.data[3] = 0;

  replaceBackground(image, { background: '#ffffff' });
  assert.equal(pixelAt(image, 0, 0)[3], 255);
});
