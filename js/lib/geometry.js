/**
 * Pure resize/crop math.
 *
 * Nothing here touches a canvas: given a source size and the user's settings it
 * returns the source rectangle to sample and the destination size to draw into.
 * Keeping it side-effect free is what makes the resize behaviour testable in
 * plain Node, away from a browser.
 */

/** Widest side any browser will reliably allocate a canvas for. */
export const MAX_DIMENSION = 16384;

/** Total pixel budget. Chrome refuses canvases above ~268 megapixels. */
export const MAX_PIXELS = 16384 * 16384;

export const RESIZE_MODES = ['none', 'percent', 'fit', 'cover', 'exact', 'longest'];

/** Crop anchors, as fractions of the leftover space on each axis. */
const ANCHORS = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
};

export const ANCHOR_NAMES = Object.keys(ANCHORS);

function anchorOf(name) {
  return ANCHORS[name] || ANCHORS.center;
}

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Round to whole pixels and keep the result inside the single-axis limit. */
function clampDim(n) {
  return Math.max(1, Math.min(MAX_DIMENSION, Math.round(n)));
}

/**
 * Fit a destination size inside the canvas limits without distorting it.
 * Returns the (possibly reduced) size plus whether anything had to give.
 */
function clampOutput(dw, dh) {
  let w = Math.max(1, Math.round(dw));
  let h = Math.max(1, Math.round(dh));
  let clamped = false;

  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
    w = clampDim(w * ratio);
    h = clampDim(h * ratio);
    clamped = true;
  }

  if (w * h > MAX_PIXELS) {
    const ratio = Math.sqrt(MAX_PIXELS / (w * h));
    w = clampDim(w * ratio);
    h = clampDim(h * ratio);
    clamped = true;
  }

  return { dw: w, dh: h, clamped };
}

/**
 * Size of an image after a rotation. Quarter turns swap the axes.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} rotate degrees, any multiple of 90 (negatives fine)
 */
export function orientedSize(width, height, rotate = 0) {
  const turns = normalizeRotation(rotate) / 90;
  return turns % 2 === 0 ? { width, height } : { width: height, height: width };
}

/** Fold any angle into one of 0, 90, 180, 270. */
export function normalizeRotation(rotate) {
  const degrees = Math.round(Number(rotate) || 0);
  const snapped = Math.round(degrees / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

/**
 * Work out the source rectangle and destination size for one image.
 *
 * `srcW`/`srcH` must already account for rotation — callers rotate first and
 * resize the oriented image, which is the order users expect.
 *
 * @param {number} srcW
 * @param {number} srcH
 * @param {object} opts
 * @param {'none'|'percent'|'fit'|'cover'|'exact'|'longest'} opts.mode
 * @param {number} [opts.scale] percentage, for `percent`
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.edge] longest-edge target, for `longest`
 * @param {boolean} [opts.noUpscale] never produce more pixels than the source
 * @param {string} [opts.position] crop anchor, for `cover`
 * @returns {{sx: number, sy: number, sw: number, sh: number,
 *            dw: number, dh: number, clamped: boolean}}
 */
export function computeGeometry(srcW, srcH, opts = {}) {
  const source = { sx: 0, sy: 0, sw: srcW, sh: srcH };
  const identity = () => ({ ...source, ...clampOutput(srcW, srcH) });

  const width = positive(opts.width);
  const height = positive(opts.height);

  switch (opts.mode) {
    case 'percent': {
      const scale = positive(opts.scale) / 100;
      if (!scale) return identity();
      return { ...source, ...clampOutput(srcW * scale, srcH * scale) };
    }

    case 'longest': {
      const edge = positive(opts.edge) || Math.max(width, height);
      if (!edge) return identity();
      let ratio = edge / Math.max(srcW, srcH);
      if (opts.noUpscale) ratio = Math.min(ratio, 1);
      return { ...source, ...clampOutput(srcW * ratio, srcH * ratio) };
    }

    case 'fit': {
      if (!width && !height) return identity();
      let ratio = Math.min(
        width ? width / srcW : Infinity,
        height ? height / srcH : Infinity,
      );
      if (opts.noUpscale) ratio = Math.min(ratio, 1);
      return { ...source, ...clampOutput(srcW * ratio, srcH * ratio) };
    }

    case 'cover': {
      // With only one side given there is nothing to crop against, so `cover`
      // degrades to `fit` rather than guessing the other side.
      if (!width || !height) {
        return computeGeometry(srcW, srcH, { ...opts, mode: 'fit' });
      }

      let boxW = width;
      let boxH = height;
      let scale = Math.max(boxW / srcW, boxH / srcH);

      if (opts.noUpscale && scale > 1) {
        boxW /= scale;
        boxH /= scale;
        scale = 1;
      }

      const out = clampOutput(boxW, boxH);
      // Re-derive the scale from the clamped box so the crop stays consistent.
      scale = Math.max(out.dw / srcW, out.dh / srcH);

      const sw = Math.min(srcW, out.dw / scale);
      const sh = Math.min(srcH, out.dh / scale);
      const [fx, fy] = anchorOf(opts.position);

      return {
        sx: (srcW - sw) * fx,
        sy: (srcH - sh) * fy,
        sw,
        sh,
        ...out,
      };
    }

    case 'exact': {
      if (!width && !height) return identity();
      // One side blank means "match the source ratio" — a stretch needs both.
      return {
        ...source,
        ...clampOutput(
          width || srcW * (height / srcH),
          height || srcH * (width / srcW),
        ),
      };
    }

    default:
      return identity();
  }
}

/**
 * Scale a geometry down by a factor, keeping the same crop. Used when an
 * encoder cannot reach a size budget on quality alone.
 *
 * @param {object} geo result of {@link computeGeometry}
 * @param {number} factor 0 < factor <= 1
 */
export function scaleGeometry(geo, factor) {
  const safe = Math.max(0.05, Math.min(1, Number(factor) || 1));
  return { ...geo, ...clampOutput(geo.dw * safe, geo.dh * safe) };
}

/**
 * The intermediate sizes to step through when shrinking an image a long way.
 *
 * A single `drawImage` from 4000px to 200px throws away most of the source
 * pixels and produces a crunchy result. Halving repeatedly until the remaining
 * reduction is under 2x — where the browser's own filtering is good — is the
 * classic fix.
 *
 * The final size is *not* included: the caller draws that hop itself, since it
 * is the one that also applies the background fill.
 *
 * @param {number} sw source width
 * @param {number} sh source height
 * @param {number} dw destination width
 * @param {number} dh destination height
 * @returns {Array<{width: number, height: number}>} possibly empty
 */
export function downscaleSteps(sw, sh, dw, dh) {
  const steps = [];
  let width = sw;
  let height = sh;

  // Both axes must still be oversized; stepping on one alone would distort a
  // stretched (non-proportional) resize.
  while (width > dw * 2 && height > dh * 2) {
    width = Math.max(dw, Math.round(width / 2));
    height = Math.max(dh, Math.round(height / 2));
    steps.push({ width, height });
  }

  return steps;
}
