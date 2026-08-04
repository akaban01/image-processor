/**
 * The output-format registry, plus a runtime probe for what this browser can
 * actually encode.
 */

/**
 * @typedef {object} ImageFormat
 * @property {string} mime
 * @property {string} ext
 * @property {string} label
 * @property {boolean} lossy  honours a quality argument
 * @property {boolean} alpha  can store transparency
 * @property {string} blurb   one line shown under the format picker
 */

/** @type {ImageFormat[]} */
export const FORMATS = [
  {
    mime: 'image/webp',
    ext: 'webp',
    label: 'WebP',
    lossy: true,
    alpha: true,
    blurb: 'Transparency plus lossy compression — usually 25–35% smaller than JPEG.',
  },
  {
    mime: 'image/avif',
    ext: 'avif',
    label: 'AVIF',
    lossy: true,
    alpha: true,
    blurb: 'The smallest files of the four, at the cost of slower encoding.',
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    label: 'JPEG',
    lossy: true,
    alpha: false,
    blurb: 'Universally supported. No transparency — alpha is flattened onto the background colour.',
  },
  {
    mime: 'image/png',
    ext: 'png',
    label: 'PNG',
    lossy: false,
    alpha: true,
    blurb: 'Lossless and transparent. Best for flat graphics, oversized for photos.',
  },
];

/** Pseudo-format: encode every candidate and keep whichever came out smallest. */
export const AUTO_MIME = 'auto';

export const AUTO_FORMAT = {
  mime: AUTO_MIME,
  ext: '',
  label: 'Smallest (try all)',
  lossy: true,
  alpha: true,
  blurb: 'Encodes each supported format and keeps the smallest result for every image.',
};

/** File extensions we accept on intake when a drop has no MIME type. */
export const INPUT_EXTENSIONS = /\.(png|jpe?g|jfif|webp|avif|gif|bmp|ico|svg|tiff?)$/i;

/**
 * @param {string} mime
 * @returns {ImageFormat|undefined}
 */
export function formatByMime(mime) {
  if (mime === AUTO_MIME) return AUTO_FORMAT;
  return FORMATS.find((format) => format.mime === mime);
}

/**
 * Map a MIME type to a file extension, falling back to the type's subtype so
 * unknown inputs still get a sensible name.
 */
export function extensionFor(mime) {
  const known = formatByMime(mime);
  if (known && known.ext) return known.ext;
  const subtype = String(mime || '').split('/')[1] || 'img';
  return subtype.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'img';
}

/**
 * A 1x1 canvas in whichever flavour the current context provides.
 *
 * The 2D context is not optional: `OffscreenCanvas.convertToBlob()` throws
 * `InvalidStateError` on a canvas that has never had one, which would make
 * every probe below fail and leave the app offering PNG alone.
 */
function scratchCanvas() {
  let canvas = null;

  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(1, 1);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
  }

  if (canvas && !canvas.getContext('2d')) return null;
  return canvas;
}

async function canEncode(canvas, mime) {
  try {
    // `convertToBlob` rejects for unknown types; `toBlob` quietly hands back a
    // PNG instead. Checking the resulting type catches both.
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: mime, quality: 0.9 })
      : await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.9));
    return Boolean(blob) && blob.type === mime;
  } catch {
    return false;
  }
}

let probed = null;

/**
 * Formats this browser can genuinely encode, in registry order.
 * The result is cached — probing costs four encodes.
 *
 * @returns {Promise<ImageFormat[]>}
 */
export function supportedFormats() {
  if (!probed) {
    probed = (async () => {
      const canvas = scratchCanvas();
      if (!canvas) return [];
      const results = await Promise.all(
        FORMATS.map(async (format) => ((await canEncode(canvas, format.mime)) ? format : null)),
      );
      const usable = results.filter(Boolean);
      // PNG is mandated by the canvas spec; if the probe found nothing at all
      // we are better off trusting the spec than showing an empty picker.
      return usable.length ? usable : FORMATS.filter((f) => f.mime === 'image/png');
    })();
  }
  return probed;
}

/** Test seam: forget the cached probe. */
export function resetFormatProbe() {
  probed = null;
}
