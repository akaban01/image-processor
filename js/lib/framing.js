/**
 * Where the head belongs inside a document photo, and how to cut a camera
 * frame down to it.
 *
 * Every standard in `documents.js` states the same thing in words — "head
 * fills roughly 70–80% of the frame height, centred, with a little space
 * above" — and words are no help to someone holding a phone. These numbers
 * turn that sentence into an outline that can be drawn over a live preview,
 * so the framing is right before the shutter rather than argued about after.
 *
 * Everything here is arithmetic on the standard's own pixel grid: no canvas,
 * no DOM, no camera.
 */

/**
 * Proportions used when a standard names none of its own.
 *
 * `headTop` and `headHeight` are fractions of the photo's height; `headWidth`
 * is relative to the head's own height, an adult head being noticeably taller
 * than it is wide. The eye line at 45% of the way down the head is where eyes
 * actually sit on a face, not the midpoint of the skull.
 */
export const DEFAULT_FRAMING = {
  headTop: 0.09,
  headHeight: 0.75,
  headMin: 0.70,
  headMax: 0.80,
  headWidth: 0.72,
  eyeLine: 0.45,
};

/**
 * @param {object|null} standard
 * @returns {typeof DEFAULT_FRAMING}
 */
export function framingFor(standard) {
  return { ...DEFAULT_FRAMING, ...(standard?.framing || {}) };
}

/**
 * The guide to draw over a preview, in the standard's own pixels so an SVG
 * can take the same numbers as its `viewBox`.
 *
 * @param {{width: number, height: number, framing?: object}} standard
 * @returns {{
 *   width: number, height: number,
 *   head: {cx: number, cy: number, rx: number, ry: number},
 *   crown: number, chin: number, chinMin: number, chinMax: number,
 *   eyeLine: number, shoulders: number,
 * }}
 */
export function guideGeometry(standard) {
  const framing = framingFor(standard);
  const width = Math.max(1, Number(standard?.width) || 1);
  const height = Math.max(1, Number(standard?.height) || 1);

  const crown = framing.headTop * height;
  const headHeight = framing.headHeight * height;
  const headWidth = headHeight * framing.headWidth;

  return {
    width,
    height,
    head: {
      cx: width / 2,
      cy: crown + headHeight / 2,
      rx: headWidth / 2,
      ry: headHeight / 2,
    },
    crown,
    chin: crown + headHeight,
    // The tolerance band: where the chin lands for the smallest and largest
    // head the standard allows, with the crown held on its line.
    chinMin: crown + framing.headMin * height,
    chinMax: crown + framing.headMax * height,
    eyeLine: crown + headHeight * framing.eyeLine,
    // Roughly where the shoulders enter the frame, drawn only as a hint that
    // the subject should be square to the camera.
    shoulders: crown + headHeight * 1.32,
  };
}

/**
 * The largest centred rectangle of a given aspect ratio inside a source frame.
 *
 * This is what `object-fit: cover` shows on screen, so cutting the capture to
 * the same rectangle gives back exactly the picture that was framed — no
 * surprise crop between the preview and the file.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} aspect wanted width ÷ height
 * @returns {{sx: number, sy: number, sw: number, sh: number}}
 */
export function centeredCrop(sourceWidth, sourceHeight, aspect) {
  const sw0 = Math.max(0, Math.floor(Number(sourceWidth) || 0));
  const sh0 = Math.max(0, Math.floor(Number(sourceHeight) || 0));
  const ratio = Number(aspect);

  if (!sw0 || !sh0 || !Number.isFinite(ratio) || ratio <= 0) {
    return { sx: 0, sy: 0, sw: sw0, sh: sh0 };
  }

  let sw = sw0;
  let sh = Math.round(sw0 / ratio);

  if (sh > sh0) {
    sh = sh0;
    sw = Math.round(sh0 * ratio);
  }

  return {
    sx: Math.round((sw0 - sw) / 2),
    sy: Math.round((sh0 - sh) / 2),
    sw: Math.max(1, Math.min(sw0, sw)),
    sh: Math.max(1, Math.min(sh0, sh)),
  };
}

/**
 * Is a camera frame big enough to fill this standard without upscaling?
 *
 * A capture below the required size still works — the pipeline will enlarge
 * it — but it is worth saying so out loud, because an upscaled visa photo
 * looks soft in a way that gets photos rejected.
 *
 * @param {{sw: number, sh: number}} crop
 * @param {{width: number, height: number}} standard
 * @returns {boolean}
 */
export function cropCoversStandard(crop, standard) {
  return crop.sw >= standard.width && crop.sh >= standard.height;
}
