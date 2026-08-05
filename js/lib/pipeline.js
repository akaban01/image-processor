/**
 * Picks how each image gets converted and hides the difference from the UI.
 *
 * Fast path: a pool of workers with `OffscreenCanvas`.
 * Fallback:  the main thread, used when the browser lacks the fast path and
 *            for the handful of inputs — SVG, mostly — that no browser can
 *            decode off-thread.
 */

import { convertSource } from './convert.js';
import { WorkerPool, supportsWorkerPipeline, defaultPoolSize } from './pool.js';

const WORKER_URL = new URL('../worker.js', import.meta.url);

/** SVGs with no intrinsic size need a concrete one before they can be drawn. */
const DEFAULT_VECTOR_SIZE = 1024;

const createDomCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const nextFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

/**
 * Decode with an `<img>` element. Slower than `createImageBitmap` and stuck on
 * the main thread, but it is the only path that handles SVG.
 *
 * @returns {Promise<{source: HTMLImageElement, release: () => void}>}
 */
async function decodeWithImageElement(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';

  try {
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Unsupported or corrupt image file'));
      img.src = url;
    });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }

  // A vector with only a viewBox reports no natural size; give it one so the
  // resize maths has something to work with.
  if (!img.naturalWidth || !img.naturalHeight) {
    img.width = DEFAULT_VECTOR_SIZE;
    img.height = DEFAULT_VECTOR_SIZE;
  }

  return { source: img, release: () => URL.revokeObjectURL(url) };
}

async function convertOnMainThread(file, settings, signal, bitmap = null) {
  await nextFrame();

  if (bitmap) {
    try {
      return await convertSource(bitmap, settings, {
        createCanvas: createDomCanvas,
        signal,
        matted: true,
      });
    } finally {
      bitmap.close?.();
    }
  }

  const { source, release } = await decodeWithImageElement(file);
  try {
    return await convertSource(source, settings, { createCanvas: createDomCanvas, signal });
  } finally {
    release();
  }
}

/**
 * @typedef {object} Pipeline
 * @property {'worker'|'main'} mode
 * @property {number} concurrency
 * @property {(file: File, settings: object, options?: object) => Promise<object>} convert
 * @property {() => void} cancelAll
 * @property {() => void} dispose
 */

/**
 * @param {object} [options]
 * @param {boolean} [options.forceMainThread] escape hatch, used by the tests
 * @returns {Pipeline}
 */
export function createPipeline(options = {}) {
  const useWorkers = !options.forceMainThread && supportsWorkerPipeline();
  const pool = useWorkers ? new WorkerPool(WORKER_URL, { size: options.size }) : null;

  return {
    mode: useWorkers ? 'worker' : 'main',
    concurrency: useWorkers ? (options.size || defaultPoolSize()) : 1,

    async convert(file, settings, { signal, onStart, bitmap = null } = {}) {
      if (pool) {
        try {
          return await pool.run(
            { file, bitmap, settings, matted: Boolean(bitmap) },
            // The bitmap is transferred rather than copied: it can be tens of
            // megabytes, and nothing on this side needs it afterwards.
            { signal, onStart, transfer: bitmap ? [bitmap] : [] },
          );
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          // Only a decode failure is worth a second attempt; an encoder that
          // does not exist will not appear on the main thread either. A
          // transferred bitmap is also gone by now, so there is nothing left
          // to retry with.
          if (error?.code !== 'DECODE_FAILED' || bitmap) throw error;
        }
      } else {
        onStart?.();
      }

      return convertOnMainThread(file, settings, signal, bitmap);
    },

    cancelAll() {
      pool?.cancelAll();
    },

    dispose() {
      pool?.dispose();
    },
  };
}
