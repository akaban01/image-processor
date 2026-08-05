/**
 * Main-thread client for the matting worker.
 *
 * Keeps one worker, one job at a time, and a plain answer to "can this browser
 * do it at all" — because every caller needs a fallback path, and finding out
 * by catching an exception three layers down is not one.
 */

const WORKER_URL = new URL('../segment-worker.js', import.meta.url);

/** Anything older than this cannot run the model, and should not be asked to. */
export function supportsSegmentation() {
  return (
    typeof Worker === 'function'
    && typeof OffscreenCanvas === 'function'
    && typeof createImageBitmap === 'function'
    && typeof WebAssembly === 'object'
  );
}

/**
 * @typedef {object} Segmenter
 * @property {boolean} supported
 * @property {() => Promise<void>} warmup   load the runtime and weights early
 * @property {(bitmap: ImageBitmap) => Promise<object>} segment  → greyscale mask
 * @property {() => void} dispose
 */

/**
 * @returns {Segmenter}
 */
export function createSegmenter() {
  const supported = supportsSegmentation();
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  const spawn = () => {
    if (worker) return worker;

    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.addEventListener('message', (event) => {
      const message = event.data;
      const job = pending.get(message?.id);
      if (!job) return;

      pending.delete(message.id);
      if (message.type === 'error') job.reject(new Error(message.message));
      else job.resolve(message.mask);
    });
    worker.addEventListener('error', (event) => {
      // A module worker that fails to parse reports here and nowhere else, so
      // every waiting caller has to be released or they hang for ever.
      const error = new Error(event.message || 'The matting worker failed to start');
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
    });

    return worker;
  };

  const send = (message, transfer = []) => new Promise((resolve, reject) => {
    if (!supported) {
      reject(new Error('This browser cannot run the background model'));
      return;
    }

    const id = nextId++;
    pending.set(id, { resolve, reject });
    spawn().postMessage({ ...message, id }, transfer);
  });

  return {
    supported,
    warmup: () => send({ type: 'warmup' }),
    segment: (bitmap) => send({ type: 'segment', bitmap }, [bitmap]),
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
