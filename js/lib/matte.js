/**
 * Separating a portrait from a plain backdrop, and painting that backdrop a
 * flat colour.
 *
 * There is no neural network here and there is not going to be one: the app
 * ships no build step, no dependencies and no network requests after load, and
 * a segmentation model is megabytes of weights and WASM. What it does instead
 * is the thing that actually works for the photo the standards ask for — a
 * subject in front of an evenly lit plain wall. The matte floods in from the
 * edges of the frame, keeps going while the colour stays close to the wall it
 * started on, and stops at the person. Anything the flood never reaches is
 * kept, so a dark jacket is safe even though it is nowhere near the wall
 * colour.
 *
 * Consequences worth stating plainly, because they are the difference between
 * a useful tool and a magic one:
 *   - a busy background is not separable this way, and the coverage figure is
 *     how the caller finds out;
 *   - clothing the same colour as the wall, touching the wall, is part of the
 *     wall.
 *
 * Everything is arithmetic over an `{data, width, height}` object — the shape
 * `ImageData` has — so it runs in a worker, on the main thread, and in a test.
 */

/** Edge tolerance the UI starts at, on its 0–100 scale. */
export const DEFAULT_TOLERANCE = 30;

/**
 * Fraction of the frame height down which the side edges are still treated as
 * background. Shoulders reach the bottom corners of every portrait ever taken,
 * so seeding there would flood the flood into the subject's shirt.
 */
const SEED_DEPTH = 0.55;

/** A tolerance of 100 allows this much RGB distance — loose, but not absurd. */
const MAX_DISTANCE = 120;

/**
 * Parse `#rrggbb`. Returns null for anything else, which is the caller's
 * signal to leave the image alone rather than paint it black.
 *
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}|null}
 */
export function parseHexColour(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!match) return null;

  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

const distanceLimit = (tolerance) => {
  const t = Math.min(100, Math.max(0, Number(tolerance) || 0));
  const distance = (t / 100) * MAX_DISTANCE;
  return distance * distance;
};

function squaredDistance(data, offset, r, g, b) {
  const dr = data[offset] - r;
  const dg = data[offset + 1] - g;
  const db = data[offset + 2] - b;
  return dr * dr + dg * dg + db * db;
}

/**
 * The colour the flood starts from: the median of the pixels along the top
 * edge and the upper sides.
 *
 * A median rather than a mean because a stray dark pixel — a picture frame, a
 * light switch, the top of a very tall head — should not drag the reference
 * off the wall it is supposed to describe.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @returns {{r: number, g: number, b: number}|null}
 */
export function borderReference(image) {
  const { data, width, height } = image;
  if (!width || !height) return null;

  const reds = [];
  const greens = [];
  const blues = [];

  const sample = (x, y) => {
    const offset = (y * width + x) * 4;
    reds.push(data[offset]);
    greens.push(data[offset + 1]);
    blues.push(data[offset + 2]);
  };

  for (let x = 0; x < width; x++) sample(x, 0);

  const depth = Math.max(1, Math.round(height * SEED_DEPTH));
  for (let y = 1; y < depth; y++) {
    sample(0, y);
    sample(width - 1, y);
  }

  const median = (values) => {
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  };

  return { r: median(reds), g: median(greens), b: median(blues) };
}

/**
 * Flood the background in from the edges.
 *
 * A pixel joins the background when it is close to the wall's reference colour
 * *or* close to the pixel that reached it. The second test is what carries the
 * matte across a wall that shades off towards a corner; it is half as generous
 * as the first, so it follows a gradient without walking into hair.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @param {object} [options]
 * @param {number} [options.tolerance] 0–100
 * @returns {{mask: Uint8Array, coverage: number}|null} 255 marks background
 */
export function buildBackgroundMask(image, { tolerance = DEFAULT_TOLERANCE } = {}) {
  const { data, width, height } = image;
  const reference = borderReference(image);
  if (!reference) return null;

  const pixels = width * height;
  const mask = new Uint8Array(pixels);
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  const limit = distanceLimit(tolerance);
  const neighbourLimit = limit / 4; // half the distance, squared

  let tail = 0;
  let filled = 0;

  const consider = (index, fromOffset) => {
    if (visited[index]) return;
    visited[index] = 1;

    const offset = index * 4;
    const toReference = squaredDistance(data, offset, reference.r, reference.g, reference.b);
    const joins = toReference <= limit
      || (fromOffset >= 0 && squaredDistance(
        data,
        offset,
        data[fromOffset],
        data[fromOffset + 1],
        data[fromOffset + 2],
      ) <= neighbourLimit);

    if (!joins) return;

    mask[index] = 255;
    queue[tail++] = index;
    filled++;
  };

  for (let x = 0; x < width; x++) consider(x, -1);

  const depth = Math.max(1, Math.round(height * SEED_DEPTH));
  for (let y = 1; y < depth; y++) {
    consider(y * width, -1);
    consider(y * width + width - 1, -1);
  }

  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    const offset = index * 4;
    const x = index % width;
    const y = (index - x) / width;

    if (x > 0) consider(index - 1, offset);
    if (x < width - 1) consider(index + 1, offset);
    if (y > 0) consider(index - width, offset);
    if (y < height - 1) consider(index + width, offset);
  }

  return { mask, coverage: pixels ? filled / pixels : 0 };
}

/**
 * Soften a hard 0/255 mask with a separable box blur, so the join between
 * subject and backdrop is a blend rather than a staircase. Hair is the reason:
 * a binary matte cuts it into a paper doll.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius in pixels; 0 leaves the mask alone
 * @returns {Uint8Array}
 */
export function featherMask(mask, width, height, radius) {
  const r = Math.max(0, Math.round(radius) || 0);
  if (!r || !width || !height) return mask;

  const span = r * 2 + 1;
  const horizontal = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let dx = -r; dx <= r; dx++) {
        const sx = Math.min(width - 1, Math.max(0, x + dx));
        total += mask[row + sx];
      }
      horizontal[row + x] = total / span;
    }
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let total = 0;
      for (let dy = -r; dy <= r; dy++) {
        const sy = Math.min(height - 1, Math.max(0, y + dy));
        total += horizontal[sy * width + x];
      }
      out[y * width + x] = total / span;
    }
  }

  return out;
}

/**
 * Paint the masked area, in place.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @param {Uint8Array} mask
 * @param {{r: number, g: number, b: number}} colour
 */
export function paintBackground(image, mask, colour) {
  const { data } = image;

  for (let index = 0; index < mask.length; index++) {
    const alpha = mask[index];
    if (!alpha) continue;

    const offset = index * 4;
    if (alpha === 255) {
      data[offset] = colour.r;
      data[offset + 1] = colour.g;
      data[offset + 2] = colour.b;
      data[offset + 3] = 255;
      continue;
    }

    const weight = alpha / 255;
    const keep = 1 - weight;
    data[offset] = data[offset] * keep + colour.r * weight;
    data[offset + 1] = data[offset + 1] * keep + colour.g * weight;
    data[offset + 2] = data[offset + 2] * keep + colour.b * weight;
    data[offset + 3] = data[offset + 3] * keep + 255 * weight;
  }
}

/**
 * A greyscale foreground mask → the per-pixel background weights that
 * {@link paintBackground} paints with.
 *
 * The model says how much of each pixel is *person*; the painter asks how much
 * is *wall*. One subtraction, but in its own function because getting it
 * backwards produces a photo of a wall with a person-shaped hole in it — the
 * sort of mistake a test should be able to state plainly.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} mask
 * @returns {Uint8Array}
 */
export function backgroundWeights(mask) {
  const out = new Uint8Array(mask.width * mask.height);
  for (let index = 0; index < out.length; index++) {
    out[index] = 255 - mask.data[index * 4];
  }
  return out;
}

/**
 * Feather radius for an image of this size: subtle, never zero, and capped.
 * The blur is O(pixels × radius), so the ceiling is what keeps a very large
 * image from turning a soft edge into a long wait.
 */
export const featherRadiusFor = (width, height) =>
  Math.min(6, Math.max(1, Math.round(Math.min(width, height) / 400)));

/**
 * A coverage figure outside this range means the flood found something other
 * than a wall — a busy room at one end, a frame that is nearly all wall at the
 * other. Worth telling the user about; not worth refusing to convert over.
 */
export const PLAUSIBLE_COVERAGE = { min: 0.12, max: 0.9 };

/**
 * Replace a plain backdrop with a flat colour, in place.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @param {object} options
 * @param {string} options.background `#rrggbb`
 * @param {number} [options.tolerance] 0–100
 * @returns {{applied: boolean, coverage: number, plausible: boolean}}
 */
export function replaceBackground(image, { background, tolerance = DEFAULT_TOLERANCE } = {}) {
  const colour = parseHexColour(background);
  const idle = { applied: false, coverage: 0, plausible: false };
  if (!colour || !image?.width || !image?.height) return idle;

  const built = buildBackgroundMask(image, { tolerance });
  if (!built) return idle;

  const feathered = featherMask(
    built.mask,
    image.width,
    image.height,
    featherRadiusFor(image.width, image.height),
  );
  paintBackground(image, feathered, colour);

  return {
    applied: true,
    coverage: built.coverage,
    plausible: built.coverage >= PLAUSIBLE_COVERAGE.min && built.coverage <= PLAUSIBLE_COVERAGE.max,
  };
}
