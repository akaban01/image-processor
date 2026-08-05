/**
 * The settings object: defaults, validation and presets.
 *
 * Anything read back from `localStorage` is attacker-adjacent in the sense
 * that it may simply be stale or hand-edited, so `normalizeSettings` is the
 * single gate every stored value passes through before the UI trusts it.
 */

import { RESIZE_MODES, ANCHOR_NAMES, MAX_DIMENSION } from './geometry.js';
import { DEFAULT_TEMPLATE } from './naming.js';
import { NO_STANDARD, STANDARD_IDS, standardSettings } from './documents.js';
import { MAX_DPI } from './dpi.js';

export const THEMES = ['auto', 'light', 'dark'];

export const MIN_QUALITY = 0.05;
export const MAX_QUALITY = 1;

/** @returns {object} a fresh copy — callers mutate their settings freely. */
export function defaultSettings() {
  return {
    format: 'image/webp',
    quality: 0.82,
    targetEnabled: false,
    targetBytes: 0,
    background: '#ffffff',
    template: DEFAULT_TEMPLATE,
    // Which document-photo standard the output is being held to, if any.
    documentId: NO_STANDARD,
    // Print resolution stamped into JPEG output; 0 leaves the file unmarked.
    dpi: 0,
    rotate: 0,
    flipH: false,
    flipV: false,
    resize: {
      mode: 'none',
      scale: 50,
      width: 1920,
      height: 1080,
      edge: 1920,
      noUpscale: true,
      position: 'center',
    },
  };
}

/**
 * Clamp a number into a range, falling back when the input is not a number at
 * all. The distinction matters: an out-of-range 20000 should become the
 * maximum, but `null` — which `Number()` would happily turn into 0 — means the
 * field was absent and should keep its previous value.
 */
const clamp = (value, low, high, fallback) => {
  const usable = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '');
  if (!usable) return fallback;

  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Coerce arbitrary input into a settings object that every other module can
 * rely on. Never throws, never returns a partial object.
 *
 * @param {any} input
 * @param {object} [base] defaults to fall back to, field by field
 * @returns {object}
 */
export function normalizeSettings(input, base = defaultSettings()) {
  const raw = input && typeof input === 'object' ? input : {};
  const rawResize = raw.resize && typeof raw.resize === 'object' ? raw.resize : {};

  return {
    // The format is checked against the browser's real capabilities later; a
    // string is all that can be validated here.
    format: typeof raw.format === 'string' && raw.format ? raw.format : base.format,
    quality: clamp(raw.quality, MIN_QUALITY, MAX_QUALITY, base.quality),
    targetEnabled: typeof raw.targetEnabled === 'boolean' ? raw.targetEnabled : base.targetEnabled,
    targetBytes: Math.max(0, Math.round(clamp(raw.targetBytes, 0, Number.MAX_SAFE_INTEGER, base.targetBytes))),
    background: HEX_COLOR.test(raw.background) ? raw.background : base.background,
    template: typeof raw.template === 'string' && raw.template.trim()
      ? raw.template.trim()
      : base.template,
    documentId: oneOf(raw.documentId, STANDARD_IDS, base.documentId),
    dpi: Math.round(clamp(raw.dpi, 0, MAX_DPI, base.dpi)),
    rotate: oneOf(Math.round(Number(raw.rotate)) || 0, [0, 90, 180, 270], base.rotate),
    flipH: typeof raw.flipH === 'boolean' ? raw.flipH : base.flipH,
    flipV: typeof raw.flipV === 'boolean' ? raw.flipV : base.flipV,
    resize: {
      mode: oneOf(rawResize.mode, RESIZE_MODES, base.resize.mode),
      scale: Math.round(clamp(rawResize.scale, 1, 400, base.resize.scale)),
      width: Math.round(clamp(rawResize.width, 0, MAX_DIMENSION, base.resize.width)),
      height: Math.round(clamp(rawResize.height, 0, MAX_DIMENSION, base.resize.height)),
      edge: Math.round(clamp(rawResize.edge, 1, MAX_DIMENSION, base.resize.edge)),
      noUpscale: typeof rawResize.noUpscale === 'boolean'
        ? rawResize.noUpscale
        : base.resize.noUpscale,
      position: oneOf(rawResize.position, ANCHOR_NAMES, base.resize.position),
    },
  };
}

/**
 * Ready-made configurations for the jobs people actually arrive with.
 * `settings` is a partial patch applied over the current defaults.
 */
export const PRESETS = [
  {
    id: 'web',
    label: 'Web page',
    summary: '1920px WebP, good quality',
    settings: {
      format: 'image/webp',
      quality: 0.82,
      targetEnabled: false,
      resize: { mode: 'longest', edge: 1920, noUpscale: true },
    },
  },
  {
    id: 'thumbnail',
    label: 'Thumbnail',
    summary: '400×400 square crop',
    settings: {
      format: 'image/webp',
      quality: 0.8,
      targetEnabled: false,
      resize: { mode: 'cover', width: 400, height: 400, position: 'center', noUpscale: false },
    },
  },
  {
    id: 'email',
    label: 'Email attachment',
    summary: 'JPEG under 500 KB',
    settings: {
      format: 'image/jpeg',
      targetEnabled: true,
      targetBytes: 500 * 1024,
      resize: { mode: 'longest', edge: 2048, noUpscale: true },
    },
  },
  {
    id: 'social',
    label: 'Social card',
    summary: '1200×630 JPEG',
    settings: {
      format: 'image/jpeg',
      quality: 0.85,
      targetEnabled: false,
      resize: { mode: 'cover', width: 1200, height: 630, position: 'center', noUpscale: false },
    },
  },
  {
    id: 'archive',
    label: 'Archive quality',
    summary: 'Lossless PNG, original size',
    settings: {
      format: 'image/png',
      targetEnabled: false,
      resize: { mode: 'none' },
    },
  },
];

/**
 * Merge a preset patch over the current settings.
 *
 * @param {object} current
 * @param {object} patch
 * @returns {object} a normalized settings object
 */
export function applyPreset(current, patch) {
  return normalizeSettings(
    {
      ...current,
      ...patch,
      resize: { ...current.resize, ...(patch.resize || {}) },
    },
    current,
  );
}

/**
 * Switch to (or away from) a document-photo standard.
 *
 * @param {object} current
 * @param {import('./documents.js').PhotoStandard|null} standard
 * @returns {object} a normalized settings object
 */
export function applyStandard(current, standard) {
  return applyPreset(current, standardSettings(standard));
}

/**
 * Does this settings object leave the image untouched apart from re-encoding?
 * Used to warn when "convert" would be a no-op re-save.
 */
export function isPassthrough(settings, sourceMime) {
  return (
    settings.format === sourceMime
    && settings.resize.mode === 'none'
    && !settings.rotate
    && !settings.flipH
    && !settings.flipV
    && !settings.targetEnabled
  );
}

const STORAGE_KEY = 'image-converter:settings:v2';

/** Persist settings, tolerating private mode and full quotas. */
export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Nothing to do — the app works fine without persistence. */
  }
}

/** Load settings, falling back to defaults on anything unexpected. */
export function loadSettings(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (!stored) return defaultSettings();
    return normalizeSettings(JSON.parse(stored));
  } catch {
    return defaultSettings();
  }
}
