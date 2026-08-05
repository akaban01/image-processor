/**
 * One image, start to finish: orient → resize → encode.
 *
 * This module is context-free. It never touches the DOM and never assumes a
 * worker; the caller supplies a `createCanvas` factory. That is what lets the
 * worker and the main-thread fallback share a single implementation instead of
 * drifting apart.
 */

import { computeGeometry, orientedSize, scaleGeometry } from './geometry.js';
import { renderImage, releaseCanvas } from './render.js';
import { encodeCanvas, searchQuality, pickSmallest } from './encode.js';
import { AUTO_MIME, formatByMime, supportedFormats } from './formats.js';
import { stampJpegDensity } from './dpi.js';
import { replaceBackground } from './matte.js';

/** How far the size search may shrink an image before giving up. */
const RESCALE_FACTOR = 0.8;
const MAX_RESCALES = 4;

function assertLive(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

/**
 * Formats to try for a given request. `auto` means "every format this browser
 * can encode"; anything else is taken literally.
 */
async function candidateFormats(mime) {
  if (mime !== AUTO_MIME) {
    const format = formatByMime(mime);
    if (!format) throw new Error(`Unknown output format: ${mime}`);
    return [format];
  }
  return supportedFormats();
}

/**
 * Encode one format, honouring a size budget when there is one.
 *
 * When quality alone cannot get under the budget the image is progressively
 * scaled down — reducing dimensions preserves far more perceived quality than
 * pushing a JPEG below q≈0.2, where blocking artefacts take over.
 */
/**
 * Paint out the backdrop on a freshly drawn canvas.
 *
 * This happens after the resize rather than before it: the matte then works on
 * the pixels that are actually going to be encoded — a fraction of the source
 * for a 40-megapixel photo — and its soft edge lands on output pixels instead
 * of being resampled into a halo.
 *
 * @returns {{applied: boolean, coverage: number, plausible: boolean}}
 */
function matteCanvas(canvas, settings) {
  const idle = { applied: false, coverage: 0, plausible: false };
  if (!settings.removeBackground) return idle;

  const context = canvas.getContext('2d');
  if (!context) return idle;

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const report = replaceBackground(image, {
    background: settings.background,
    tolerance: settings.backgroundTolerance,
  });

  if (report.applied) context.putImageData(image, 0, 0);
  return report;
}

async function encodeFormat({ source, settings, geo, format, createCanvas, signal }) {
  const background = format.alpha ? null : settings.background;
  const renderOptions = {
    geo,
    rotate: settings.rotate,
    flipH: settings.flipH,
    flipV: settings.flipV,
    background,
  };

  const quality = format.lossy ? settings.quality : undefined;
  // A stale byte figure can sit in the settings while the toggle is off; only
  // the toggle decides whether a budget is in play.
  const targeting = settings.targetEnabled && settings.targetBytes > 0;

  if (!targeting || !format.lossy) {
    const canvas = renderImage(source, renderOptions, createCanvas);
    try {
      assertLive(signal);
      const matte = matteCanvas(canvas, settings);
      const blob = await encodeCanvas(canvas, format.mime, quality);
      return {
        blob,
        format,
        quality,
        matte,
        width: geo.dw,
        height: geo.dh,
        // A lossless format under a budget is the one case worth reporting on
        // here: there is no quality knob left to turn.
        withinBudget: !targeting || blob.size <= settings.targetBytes,
        rescales: 0,
      };
    } finally {
      releaseCanvas(canvas);
    }
  }

  let currentGeo = geo;
  let last = null;

  for (let attempt = 0; attempt <= MAX_RESCALES; attempt++) {
    assertLive(signal);
    const canvas = renderImage(source, { ...renderOptions, geo: currentGeo }, createCanvas);

    try {
      const matte = matteCanvas(canvas, settings);
      const result = await searchQuality({
        encode: (q) => encodeCanvas(canvas, format.mime, q),
        budget: settings.targetBytes,
        max: settings.quality,
        signal,
      });

      last = {
        blob: result.blob,
        format,
        quality: result.quality,
        matte,
        width: currentGeo.dw,
        height: currentGeo.dh,
        withinBudget: result.withinBudget,
        rescales: attempt,
      };

      if (result.withinBudget) return last;
    } finally {
      releaseCanvas(canvas);
    }

    const next = scaleGeometry(currentGeo, RESCALE_FACTOR);
    if (next.dw === currentGeo.dw && next.dh === currentGeo.dh) break;
    currentGeo = next;
  }

  return last;
}

/**
 * Mark a JPEG with its intended print resolution.
 *
 * Only JPEG carries the field, and only the winning blob is stamped — the
 * rewrite is byte-for-byte, so a file that just squeezed under a size budget
 * stays under it. Failure here is never worth losing a conversion over.
 */
async function stampDensity(blob, mime, dpi) {
  if (!dpi || mime !== 'image/jpeg') return { blob, dpi: 0 };

  try {
    const stamped = stampJpegDensity(await blob.arrayBuffer(), dpi);
    if (!stamped) return { blob, dpi: 0 };
    return { blob: new Blob([stamped], { type: mime }), dpi };
  } catch {
    return { blob, dpi: 0 };
  }
}

/**
 * Convert a decoded image.
 *
 * @param {CanvasImageSource & {width: number, height: number}} source
 * @param {object} settings a normalized settings object
 * @param {object} deps
 * @param {(w: number, h: number) => any} deps.createCanvas
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<object>} blob plus everything the UI needs to describe it
 */
export async function convertSource(source, settings, { createCanvas, signal }) {
  assertLive(signal);

  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const oriented = orientedSize(sourceWidth, sourceHeight, settings.rotate);
  const geo = computeGeometry(oriented.width, oriented.height, settings.resize);

  const formats = await candidateFormats(settings.format);
  if (!formats.length) throw new Error('This browser cannot encode any image format');

  const results = [];
  for (const format of formats) {
    try {
      const result = await encodeFormat({ source, settings, geo, format, createCanvas, signal });
      if (result) results.push(result);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // In `auto` mode one dud encoder must not sink the whole conversion.
      if (formats.length === 1) throw error;
    }
  }

  if (!results.length) throw new Error('Every encoder failed for this image');

  // Prefer a result that met the budget; among equals, the smallest file.
  const withinBudget = results.filter((result) => result.withinBudget);
  const chosen = pickSmallest(withinBudget.length ? withinBudget : results);
  const printed = await stampDensity(chosen.blob, chosen.format.mime, settings.dpi);

  return {
    blob: printed.blob,
    dpi: printed.dpi,
    mime: chosen.format.mime,
    formatLabel: chosen.format.label,
    extension: chosen.format.ext,
    quality: chosen.quality,
    width: chosen.width,
    height: chosen.height,
    sourceWidth,
    sourceHeight,
    withinBudget: chosen.withinBudget,
    backgroundReplaced: Boolean(chosen.matte?.applied),
    backgroundCoverage: chosen.matte?.coverage || 0,
    backgroundPlausible: Boolean(chosen.matte?.plausible),
    rescaled: chosen.rescales > 0,
    clamped: Boolean(geo.clamped),
    triedFormats: results.length,
  };
}
