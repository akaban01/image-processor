/**
 * Portrait matting worker.
 *
 * Holds the one copy of ONNX Runtime and the one copy of MODNet, off the main
 * thread because a forward pass is hundreds of milliseconds at best and
 * several seconds on a phone — long enough that doing it on the UI thread
 * would look like a crash.
 *
 * Both are loaded the first time a mask is asked for, never on page load: the
 * pair is about 25 MB, and most people never tick the box.
 *
 * Pinned to onnxruntime-web 1.27.0 — see vendor/README.md.
 */

import { INPUT_SIZE, alphaToMask, toModelInput } from './lib/tensor.js';

const ORT_URL = new URL('../vendor/onnxruntime/ort.wasm.min.mjs', import.meta.url);
const MODEL_URL = new URL('../vendor/models/modnet-fp16.onnx', import.meta.url);

/** @type {Promise<{ort: any, session: any}>|null} */
let loading = null;

function load() {
  if (loading) return loading;

  loading = (async () => {
    const ort = await import(ORT_URL.href);

    // The runtime looks for its .wasm next to a prefix, not next to itself,
    // and the app may be served from a subpath — GitHub Pages always is.
    ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime/', import.meta.url).href;
    // No COOP/COEP headers on a static host means no SharedArrayBuffer, so
    // asking for threads would only produce a warning and a fallback.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';

    const session = await ort.InferenceSession.create(MODEL_URL.href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    return { ort, session };
  })().catch((error) => {
    // A failed load must not poison every later attempt: the usual cause is a
    // first visit with no network, and the next try may well succeed.
    loading = null;
    throw error;
  });

  return loading;
}

/**
 * Square the image off to the model's input size.
 *
 * Deliberately not letterboxed: MODNet copes with the distortion of a squashed
 * portrait far better than it copes with grey bars, which it will happily
 * decide are part of the background and cut into.
 */
function toSquare(bitmap) {
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  return context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
}

async function segment(bitmap) {
  const { ort, session } = await load();

  const input = toModelInput(toSquare(bitmap));
  const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const output = await session.run({ [session.inputNames[0]]: tensor });
  const alpha = output[session.outputNames[0]];

  // The mask comes back at the size it was computed at. Stretching it to the
  // photo is the caller's job, and a canvas does it better than a loop here.
  return alphaToMask(alpha.data, alpha.dims[3], alpha.dims[2]);
}

self.addEventListener('message', async (event) => {
  const payload = event.data;
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'warmup') {
    try {
      await load();
      self.postMessage({ type: 'ready', id: payload.id });
    } catch (error) {
      self.postMessage({ type: 'error', id: payload.id, message: String(error?.message || error) });
    }
    return;
  }

  if (payload.type !== 'segment') return;

  try {
    const mask = await segment(payload.bitmap);
    self.postMessage({ type: 'mask', id: payload.id, mask }, [mask.data.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', id: payload.id, message: String(error?.message || error) });
  } finally {
    payload.bitmap?.close?.();
  }
});
