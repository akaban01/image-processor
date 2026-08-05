/**
 * Photo standards for travel documents — the Umrah and Hajj visa photo first
 * of all.
 *
 * A visa photo is a handful of hard numbers (square, so many pixels, JPEG,
 * white behind the head, under so many kilobytes) wrapped in a set of rules
 * only a human can judge (eyes open, no shadows, face not covered). This
 * module owns the numbers: it turns a standard into a settings patch, and
 * checks a finished file against it afterwards. The human rules travel
 * alongside as plain text so the UI can show them without inventing its own.
 *
 * Nothing here inspects pixels. The app never claims a photo is *accepted* —
 * only that its format, dimensions and file size fit the published spec.
 */

import { formatBytes } from './bytes.js';

/** Millimetres to pixels at a given print resolution. */
const mm = (millimetres, dpi) => Math.round((millimetres / 25.4) * dpi);

/** Rules that hold for every standard below, and that only a person can check. */
export const COMMON_RULES = [
  'Plain white or very light background, evenly lit and free of shadows.',
  'Full face, front view, eyes open, neutral expression, mouth closed.',
  'Head fills roughly 70–80% of the frame height, centred, with a little space above.',
  'Taken within the last six months, in colour, against a matte finish.',
  'No sunglasses, no glare on lenses, nothing covering the face.',
  'Religious head covering is fine as long as the whole face stays visible.',
];

/**
 * @typedef {object} PhotoStandard
 * @property {string} id
 * @property {string} label            shown in the picker
 * @property {string} short            shown in tight spots, e.g. result cards
 * @property {string} summary          one line under the picker
 * @property {number} width            output pixels
 * @property {number} height
 * @property {string} mime             required output format
 * @property {string} formatLabel      how that format is written for people
 * @property {number} quality          encoder quality ceiling
 * @property {number} maxBytes         size limit, 0 when the standard sets none
 * @property {string} background       fill behind transparent pixels
 * @property {number} dpi              print resolution to stamp, 0 for screen
 * @property {string[]} requirements   what applying the standard sets
 * @property {string[]} rules          extra human checks, on top of COMMON_RULES
 */

/** @type {PhotoStandard[]} */
export const PHOTO_STANDARDS = [
  {
    id: 'umrah-hajj-evisa',
    label: 'Umrah / Hajj eVisa (Saudi Arabia)',
    short: 'Umrah / Hajj eVisa',
    summary: '600 × 600 square JPEG, white background, under 200 KB',
    width: 600,
    height: 600,
    mime: 'image/jpeg',
    formatLabel: 'JPEG',
    quality: 0.92,
    maxBytes: 200 * 1024,
    background: '#ffffff',
    dpi: 0,
    requirements: [
      'Square 600 × 600 pixels',
      'JPEG, kept under 200 KB',
      'White background behind any transparency',
    ],
    rules: [
      'The portal accepts squares from 200 × 200 upwards; 600 × 600 is the safe maximum.',
      'Upload the photo on its own — a scan of a printed photo is usually rejected.',
    ],
  },
  {
    id: 'umrah-hajj-print',
    label: 'Umrah / Hajj photo for printing (2 × 2 in)',
    short: '2 × 2 in print',
    summary: '51 × 51 mm at 300 DPI — 600 × 600 JPEG, white background',
    width: 600,
    height: 600,
    mime: 'image/jpeg',
    formatLabel: 'JPEG',
    quality: 0.95,
    maxBytes: 0,
    background: '#ffffff',
    dpi: 300,
    requirements: [
      '600 × 600 pixels, stamped as 300 DPI',
      'Prints at exactly 2 × 2 in (51 × 51 mm)',
      'JPEG at high quality, no size limit',
    ],
    rules: [
      'Ask the print shop for matte photo paper and no auto-enhancement.',
      'Print at 100% — any “fit to page” scaling breaks the 2 × 2 in size.',
    ],
  },
  {
    id: 'passport-35x45',
    label: 'Passport size 35 × 45 mm (agency forms)',
    short: '35 × 45 mm',
    summary: `35 × 45 mm at 300 DPI — ${mm(35, 300)} × ${mm(45, 300)} JPEG, white background`,
    width: mm(35, 300),
    height: mm(45, 300),
    mime: 'image/jpeg',
    formatLabel: 'JPEG',
    quality: 0.95,
    maxBytes: 0,
    background: '#ffffff',
    dpi: 300,
    requirements: [
      `${mm(35, 300)} × ${mm(45, 300)} pixels, stamped as 300 DPI`,
      'Prints at exactly 35 × 45 mm',
      'JPEG at high quality, no size limit',
    ],
    rules: [
      'Used by many Umrah and Hajj tour operators for their own paperwork.',
      'Check with your agency first — the eVisa itself wants the square photo.',
    ],
  },
];

/** The picker's "off" value, and the default for `settings.documentId`. */
export const NO_STANDARD = 'none';

export const STANDARD_IDS = [NO_STANDARD, ...PHOTO_STANDARDS.map((standard) => standard.id)];

/**
 * @param {string} id
 * @returns {PhotoStandard|null} null for `none` and for anything unknown
 */
export function standardById(id) {
  return PHOTO_STANDARDS.find((standard) => standard.id === id) || null;
}

/**
 * The settings patch that makes the converter produce this standard.
 *
 * Rotation and flips are left alone on purpose: a photo held sideways still
 * needs straightening, and that choice belongs to the user, not the standard.
 *
 * @param {PhotoStandard|null} standard
 * @returns {object} a partial settings object, ready for `applyPreset`
 */
export function standardSettings(standard) {
  // Clearing the standard also puts away the controls that only exist inside
  // that workflow, so the settings they drive go with them.
  if (!standard) return { documentId: NO_STANDARD, dpi: 0, removeBackground: false };

  return {
    documentId: standard.id,
    format: standard.mime,
    quality: standard.quality,
    targetEnabled: standard.maxBytes > 0,
    // Keeping the byte figure even when the standard sets no limit means the
    // number in the field survives a trip through a limit-free standard.
    ...(standard.maxBytes > 0 ? { targetBytes: standard.maxBytes } : {}),
    background: standard.background,
    dpi: standard.dpi,
    resize: {
      mode: 'cover',
      width: standard.width,
      height: standard.height,
      // Undersized snaps must be allowed to grow, or the output would come out
      // smaller than the standard demands.
      noUpscale: false,
    },
  };
}

/**
 * Do the current settings still produce this standard?
 *
 * The crop anchor is deliberately not compared — moving it is how a user
 * fixes a crop that cuts off the top of the head, and that must not read as
 * "you have broken the standard".
 *
 * @param {object} settings normalized settings
 * @param {PhotoStandard|null} standard
 * @returns {boolean}
 */
export function matchesStandard(settings, standard) {
  if (!standard) return true;
  const resize = settings.resize || {};

  return (
    settings.format === standard.mime
    && settings.background === standard.background
    && Number(settings.dpi || 0) === standard.dpi
    && settings.targetEnabled === standard.maxBytes > 0
    && (standard.maxBytes === 0 || settings.targetBytes === standard.maxBytes)
    && resize.mode === 'cover'
    && resize.width === standard.width
    && resize.height === standard.height
    && resize.noUpscale === false
  );
}

/**
 * Check a converted file against a standard.
 *
 * @param {PhotoStandard|null} standard
 * @param {{mime: string, width: number, height: number, bytes: number}} result
 * @returns {{ok: boolean, issues: string[]}}
 */
export function checkPhoto(standard, result) {
  if (!standard) return { ok: true, issues: [] };

  const issues = [];

  if (result.mime !== standard.mime) {
    issues.push(`Saved as something other than ${standard.formatLabel}.`);
  }

  if (result.width !== standard.width || result.height !== standard.height) {
    issues.push(
      `${result.width} × ${result.height} — the standard wants ${standard.width} × ${standard.height}.`,
    );
  }

  if (standard.maxBytes > 0 && result.bytes > standard.maxBytes) {
    issues.push(
      `${formatBytes(result.bytes)} is over the ${formatBytes(standard.maxBytes)} limit.`,
    );
  }

  return { ok: issues.length === 0, issues };
}
