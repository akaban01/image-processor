/**
 * Image decoding, resizing and re-encoding — all via the Canvas API.
 */

export const FORMATS = [
  { mime: 'image/png',  ext: 'png',  label: 'PNG',  lossy: false, alpha: true  },
  { mime: 'image/jpeg', ext: 'jpg',  label: 'JPEG', lossy: true,  alpha: false },
  { mime: 'image/webp', ext: 'webp', label: 'WebP', lossy: true,  alpha: true  },
  { mime: 'image/avif', ext: 'avif', label: 'AVIF', lossy: true,  alpha: true  },
];

export function formatByMime(mime) {
  return FORMATS.find((f) => f.mime === mime);
}

/**
 * Browsers silently fall back to PNG when asked to encode a format they don't
 * support, so probe each one with a 1x1 canvas and keep only the real ones.
 */
export async function supportedFormats() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const checks = FORMATS.map(async (format) => {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, format.mime, 0.9));
    return blob && blob.type === format.mime ? format : null;
  });
  const results = await Promise.all(checks);
  return results.filter(Boolean);
}

/** Decode a file, honouring any EXIF orientation flag. */
export async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* Safari < 15 and friends — fall through to the <img> path. */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Unsupported or corrupt image file'));
      img.src = url;
    });
  } finally {
    // The decoded bitmap is retained by the <img>, so the URL can go now.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const clampDim = (n) => Math.max(1, Math.min(20000, Math.round(n)));

/**
 * Work out the destination canvas size plus the source rectangle to sample
 * from (only "exact + keep aspect ratio" needs a crop; everything else reads
 * the whole image).
 */
export function computeGeometry(srcW, srcH, opts) {
  const full = { sx: 0, sy: 0, sw: srcW, sh: srcH };
  const width = Number(opts.width) || 0;
  const height = Number(opts.height) || 0;

  switch (opts.mode) {
    case 'percent': {
      const scale = (Number(opts.scale) || 100) / 100;
      return { ...full, dw: clampDim(srcW * scale), dh: clampDim(srcH * scale) };
    }

    case 'fit': {
      if (!width && !height) return { ...full, dw: srcW, dh: srcH };
      let ratio = Math.min(
        width ? width / srcW : Infinity,
        height ? height / srcH : Infinity,
      );
      if (opts.noUpscale) ratio = Math.min(ratio, 1);
      return { ...full, dw: clampDim(srcW * ratio), dh: clampDim(srcH * ratio) };
    }

    case 'exact': {
      if (!width && !height) return { ...full, dw: srcW, dh: srcH };

      if (!opts.keepAspect) {
        return {
          ...full,
          dw: clampDim(width || srcW * (height / srcH)),
          dh: clampDim(height || srcH * (width / srcW)),
        };
      }
      // Only one side given: derive the other from the source aspect ratio.
      if (!width || !height) {
        const ratio = width ? width / srcW : height / srcH;
        return { ...full, dw: clampDim(srcW * ratio), dh: clampDim(srcH * ratio) };
      }
      // Both sides given: cover the box and centre-crop the overflow.
      const dw = clampDim(width);
      const dh = clampDim(height);
      const scale = Math.max(dw / srcW, dh / srcH);
      const sw = Math.min(srcW, dw / scale);
      const sh = Math.min(srcH, dh / scale);
      return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, dw, dh };
    }

    default:
      return { ...full, dw: srcW, dh: srcH };
  }
}

/**
 * Downscaling in one step produces aliasing, so halve repeatedly until the
 * remaining reduction is under 2x and let the browser filter the last hop.
 */
function drawScaled(source, geo) {
  let canvas = document.createElement('canvas');
  let { sx, sy, sw, sh } = geo;
  let w = Math.max(1, Math.round(sw));
  let h = Math.max(1, Math.round(sh));

  canvas.width = w;
  canvas.height = h;
  let ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);

  while (w > geo.dw * 2 && h > geo.dh * 2) {
    const next = document.createElement('canvas');
    next.width = w = Math.max(geo.dw, Math.round(w / 2));
    next.height = h = Math.max(geo.dh, Math.round(h / 2));
    ctx = next.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    canvas = next;
  }
  return canvas;
}

/**
 * @param {File} file
 * @param {object} settings mime, quality, background and resize options
 * @returns {Promise<{blob: Blob, width: number, height: number,
 *                    sourceWidth: number, sourceHeight: number}>}
 */
export async function convertImage(file, settings) {
  const source = await loadImage(file);
  const srcW = source.width;
  const srcH = source.height;

  try {
    const geo = computeGeometry(srcW, srcH, settings.resize);
    const stage = drawScaled(source, geo);

    const canvas = document.createElement('canvas');
    canvas.width = geo.dw;
    canvas.height = geo.dh;
    const ctx = canvas.getContext('2d');

    const format = formatByMime(settings.mime);
    if (format && !format.alpha) {
      ctx.fillStyle = settings.background || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(stage, 0, 0, stage.width, stage.height, 0, 0, geo.dw, geo.dh);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Encoding failed'))),
        settings.mime,
        format && format.lossy ? settings.quality : undefined,
      );
    });

    return { blob, width: geo.dw, height: geo.dh, sourceWidth: srcW, sourceHeight: srcH };
  } finally {
    if (typeof source.close === 'function') source.close();
  }
}
