/**
 * Canvas → Blob encoding, plus the search that hits a target file size.
 */

/**
 * Encode a canvas, refusing a silent format fallback.
 *
 * `HTMLCanvasElement.toBlob` answers with a PNG when it does not know the
 * requested type, which would otherwise hand the user a `.avif` file that is
 * really a PNG.
 *
 * @param {OffscreenCanvas|HTMLCanvasElement} canvas
 * @param {string} mime
 * @param {number} [quality] ignored by lossless encoders
 * @returns {Promise<Blob>}
 */
export async function encodeCanvas(canvas, mime, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: mime, quality })
    : await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('The encoder returned nothing'))),
        mime,
        quality,
      );
    });

  if (!blob) throw new Error('The encoder returned nothing');
  if (blob.type && blob.type !== mime) {
    throw new Error(`This browser cannot encode ${mime}`);
  }
  return blob;
}

const QUALITY_PRECISION = 100;
const quantize = (q) => Math.round(q * QUALITY_PRECISION) / QUALITY_PRECISION;

/**
 * Find the highest quality whose encoded size fits a byte budget.
 *
 * The search is deliberately encoder-agnostic — `encode` is injected — because
 * the interesting behaviour (does it stop early? does it ever return something
 * over budget?) is worth testing without a browser.
 *
 * @param {object} options
 * @param {(quality: number) => Promise<Blob>} options.encode
 * @param {number} options.budget maximum bytes
 * @param {number} [options.min] lowest quality worth trying
 * @param {number} [options.max] starting/ceiling quality
 * @param {number} [options.steps] bisection rounds after the two probes
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{blob: Blob, quality: number, attempts: number, withinBudget: boolean}>}
 */
export async function searchQuality({ encode, budget, min = 0.2, max = 0.95, steps = 6, signal }) {
  let attempts = 0;
  const seen = new Map();

  const run = async (quality) => {
    const key = quantize(quality);
    if (seen.has(key)) return seen.get(key);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    attempts++;
    const blob = await encode(key);
    const result = { blob, quality: key };
    seen.set(key, result);
    return result;
  };

  // Best case: the requested quality already fits, and one encode is enough.
  const top = await run(max);
  if (top.blob.size <= budget) {
    return { ...top, attempts, withinBudget: true };
  }

  // Worst case: even the floor overshoots. Report it so the caller can decide
  // whether to shrink the image instead of degrading it further.
  const floor = await run(min);
  if (floor.blob.size > budget) {
    return { ...floor, attempts, withinBudget: false };
  }

  let lo = min;
  let hi = max;
  let best = floor;

  for (let i = 0; i < steps; i++) {
    const mid = quantize((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;

    const candidate = await run(mid);
    if (candidate.blob.size <= budget) {
      best = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { ...best, attempts, withinBudget: true };
}

/**
 * Pick the smallest of several encodes, preferring the earlier entry on a tie
 * so the registry order acts as a tiebreaker.
 *
 * @template {{blob: Blob}} T
 * @param {T[]} candidates
 * @returns {T|null}
 */
export function pickSmallest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate || !candidate.blob) continue;
    if (!best || candidate.blob.size < best.blob.size) best = candidate;
  }
  return best;
}
