/**
 * Canvas drawing: orientation, cropping and high-quality downscaling.
 *
 * Every canvas is obtained through an injected `createCanvas(w, h)` so the same
 * code runs against `OffscreenCanvas` inside a worker and `HTMLCanvasElement`
 * on the main thread.
 */

import { downscaleSteps, normalizeRotation } from './geometry.js';

/** Free an intermediate canvas immediately instead of waiting for the GC. */
function release(canvas) {
  if (canvas && typeof canvas.width === 'number') {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function context2d(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
  if (!ctx) throw new Error('Could not get a 2D drawing context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/**
 * Apply rotation and flips, returning a drawable the caller can sample from.
 * When the transform is the identity the source is handed straight back, so
 * the common path allocates nothing.
 */
function orient(source, rotate, flipH, flipV, createCanvas) {
  const angle = normalizeRotation(rotate);
  if (!angle && !flipH && !flipV) return { drawable: source, owned: false };

  const w = source.width;
  const h = source.height;
  const swap = angle % 180 !== 0;
  const canvas = createCanvas(swap ? h : w, swap ? w : h);
  const ctx = context2d(canvas);

  // Flips are applied in the *output* frame — "flip horizontal" mirrors what
  // the user is looking at, whatever rotation is already in play.
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (flipH) ctx.scale(-1, 1);
  if (flipV) ctx.scale(1, -1);
  if (angle) ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);

  return { drawable: canvas, owned: true };
}

/**
 * Draw a decoded image into its final canvas.
 *
 * @param {CanvasImageSource & {width: number, height: number}} source
 * @param {object} options
 * @param {object} options.geo result of `computeGeometry`, in oriented space
 * @param {number} [options.rotate]
 * @param {boolean} [options.flipH]
 * @param {boolean} [options.flipV]
 * @param {string|null} [options.background] fill applied under the image
 * @param {(w: number, h: number) => any} createCanvas
 * @returns {any} the finished canvas
 */
export function renderImage(source, options, createCanvas) {
  const { geo, rotate = 0, flipH = false, flipV = false, background = null } = options;
  const { drawable, owned } = orient(source, rotate, flipH, flipV, createCanvas);

  let current = drawable;
  let currentOwned = owned;
  let rect = { sx: geo.sx, sy: geo.sy, sw: geo.sw, sh: geo.sh };

  // A 4000→200 reduction becomes five clean halvings instead of one lossy
  // jump. The first step also applies the crop; the rest read a full canvas.
  for (const { width, height } of downscaleSteps(geo.sw, geo.sh, geo.dw, geo.dh)) {
    const step = createCanvas(width, height);

    context2d(step).drawImage(current, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);

    if (currentOwned) release(current);
    current = step;
    currentOwned = true;
    rect = { sx: 0, sy: 0, sw: width, sh: height };
  }

  const out = createCanvas(geo.dw, geo.dh);
  const ctx = context2d(out);

  // Flattening happens before the draw so semi-transparent pixels blend
  // against the chosen colour rather than against black.
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, geo.dw, geo.dh);
  }

  ctx.drawImage(current, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, geo.dw, geo.dh);
  if (currentOwned) release(current);

  return out;
}

export { release as releaseCanvas };
