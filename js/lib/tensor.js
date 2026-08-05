/**
 * Turning pixels into what MODNet wants, and its answer back into pixels.
 *
 * The model is the only part of the background matte that cannot be tested
 * without a browser, so everything around it lives here instead: the two
 * conversions where an off-by-one or a transposed channel would quietly ruin
 * the result, expressed as plain array maths.
 */

/**
 * Side of the square the model is fed.
 *
 * MODNet accepts any multiple of 32. 512 is the size the published examples
 * use; 384 runs about three times quicker and visibly loses hair detail,
 * which is the one thing this feature exists to get right.
 */
export const INPUT_SIZE = 512;

/** MODNet is trained on inputs scaled to −1…1 rather than 0…1. */
const MEAN = 0.5;
const DEVIATION = 0.5;

/**
 * RGBA pixels → the model's input tensor.
 *
 * Two things change at once: interleaved RGBA becomes planar RGB (all the
 * reds, then all the greens, then all the blues — "CHW"), and 0…255 bytes
 * become −1…1 floats. Alpha is dropped; the model has no use for it.
 *
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} image
 * @returns {Float32Array} length 3 × width × height
 */
export function toModelInput(image) {
  const { data, width, height } = image;
  const pixels = width * height;
  const out = new Float32Array(pixels * 3);

  for (let index = 0, offset = 0; index < pixels; index++, offset += 4) {
    out[index] = (data[offset] / 255 - MEAN) / DEVIATION;
    out[pixels + index] = (data[offset + 1] / 255 - MEAN) / DEVIATION;
    out[pixels * 2 + index] = (data[offset + 2] / 255 - MEAN) / DEVIATION;
  }

  return out;
}

/**
 * The model's alpha channel → a greyscale image.
 *
 * Grey rather than an alpha channel because the mask then survives being
 * drawn through a canvas: `drawImage` on a transparent image premultiplies
 * and resamples the colour underneath it, while a grey opaque image scales
 * cleanly and can be read back exactly.
 *
 * @param {Float32Array|number[]} alpha values in 0…1, one per pixel
 * @param {number} width
 * @param {number} height
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function alphaToMask(alpha, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < width * height; index++) {
    // NaN — which a broken model export will happily produce — must not read
    // as "keep this pixel", so the clamp is written to reject it.
    const value = alpha[index] > 0 ? Math.min(1, alpha[index]) : 0;
    const grey = Math.round(value * 255);
    const offset = index * 4;

    data[offset] = grey;
    data[offset + 1] = grey;
    data[offset + 2] = grey;
    data[offset + 3] = 255;
  }

  return { data, width, height };
}

/**
 * How much of the frame the model kept, 0…1.
 *
 * The same sanity check the flood fill reports: a matte that keeps almost
 * nothing, or almost everything, did not find a person.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} mask
 * @returns {number}
 */
export function maskCoverage(mask) {
  const pixels = mask.width * mask.height;
  if (!pixels) return 0;

  let kept = 0;
  for (let index = 0; index < pixels; index++) {
    if (mask.data[index * 4] >= 128) kept++;
  }

  return kept / pixels;
}
