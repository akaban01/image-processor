/**
 * Conversion worker.
 *
 * Decoding a 40-megapixel JPEG and re-encoding it as AVIF is hundreds of
 * milliseconds of blocking work. Doing it here keeps the main thread free to
 * paint progress, and running several of these in parallel is what turns a
 * 200-image batch from a coffee break into a few seconds.
 */

import { convertSource } from './lib/convert.js';

const createCanvas = (width, height) => new OffscreenCanvas(width, height);

/** In-flight jobs, so `cancel` can interrupt work already under way. */
const running = new Map();

/**
 * Decode to an ImageBitmap. `from-image` applies the EXIF orientation flag, so
 * a photo shot in portrait converts the way it was taken.
 */
async function decode(payload) {
  if (payload.bitmap) return payload.bitmap;
  try {
    return await createImageBitmap(payload.file, { imageOrientation: 'from-image' });
  } catch {
    // SVG and a few exotic containers cannot be decoded off the main thread.
    // The caller retries these with an <img> element.
    const error = new Error('Could not decode this image in a worker');
    error.code = 'DECODE_FAILED';
    throw error;
  }
}

async function handleConvert(payload) {
  const controller = new AbortController();
  running.set(payload.id, controller);

  let source = null;
  try {
    source = await decode(payload);
    const result = await convertSource(source, payload.settings, {
      createCanvas,
      signal: controller.signal,
      matted: Boolean(payload.matted),
    });
    self.postMessage({ type: 'done', id: payload.id, result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: payload.id,
      // A DOMException carries a numeric legacy `code`, so only a string one
      // is ours; otherwise the name is what identifies an abort.
      code: typeof error?.code === 'string' ? error.code : error?.name || 'ERROR',
      message: error?.message || 'Conversion failed',
    });
  } finally {
    running.delete(payload.id);
    if (source && typeof source.close === 'function') source.close();
  }
}

self.addEventListener('message', (event) => {
  const payload = event.data;
  if (!payload || typeof payload !== 'object') return;

  switch (payload.type) {
    case 'convert':
      handleConvert(payload);
      break;
    case 'cancel':
      running.get(payload.id)?.abort();
      break;
    case 'ping':
      self.postMessage({ type: 'pong', id: payload.id });
      break;
    default:
      break;
  }
});
