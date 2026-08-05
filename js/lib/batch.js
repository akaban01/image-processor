/**
 * Runs a set of images through the pipeline with bounded concurrency,
 * reporting each result as it lands.
 */

import { applyTemplate, uniqueName } from './naming.js';
import { extensionFor } from './formats.js';

/**
 * Run `worker` over `values`, `limit` at a time, preserving nothing about
 * order — callers react to results as they arrive.
 *
 * @template T
 * @param {T[]} values
 * @param {number} limit
 * @param {(value: T, index: number) => Promise<void>} worker
 */
async function mapLimit(values, limit, worker) {
  const width = Math.max(1, Math.min(limit, values.length));
  let cursor = 0;

  const lane = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      await worker(values[index], index);
    }
  };

  await Promise.all(Array.from({ length: width }, lane));
}

/**
 * Convert a batch.
 *
 * Failures are reported per item and never stop the run: one corrupt file in a
 * folder of two hundred should cost you that one file.
 *
 * @param {object} options
 * @param {Array<{id: number, file: File}>} options.items
 * @param {object} options.settings
 * @param {import('./pipeline.js').Pipeline} options.pipeline
 * @param {AbortSignal} [options.signal]
 * @param {(item: object) => void} [options.onStart]
 * @param {(item: object, result: object) => void} [options.onDone]
 * @param {(item: object, error: Error) => void} [options.onError]
 * @returns {Promise<{converted: number, failed: number, cancelled: boolean,
 *                    bytesIn: number, bytesOut: number}>}
 */
export async function runBatch({
  items,
  settings,
  pipeline,
  signal,
  onStart,
  onDone,
  onError,
}) {
  const used = new Set();
  const date = new Date();
  const summary = { converted: 0, failed: 0, cancelled: false, bytesIn: 0, bytesOut: 0 };

  await mapLimit(items, pipeline.concurrency, async (item, index) => {
    if (signal?.aborted) {
      summary.cancelled = true;
      return;
    }

    try {
      const result = await pipeline.convert(item.file, settings, {
        signal,
        onStart: () => onStart?.(item),
        // Set when the background has already been replaced upstream, on a
        // decoded bitmap the pipeline should use instead of the file.
        bitmap: item.bitmap || null,
      });

      const extension = result.extension || extensionFor(result.mime);
      const name = uniqueName(
        applyTemplate(settings.template, {
          name: item.file.name,
          ext: extension,
          width: result.width,
          height: result.height,
          format: result.formatLabel,
          index: index + 1,
          date,
        }),
        used,
      );

      summary.converted++;
      summary.bytesIn += item.file.size;
      summary.bytesOut += result.blob.size;
      onDone?.(item, { ...result, name });
    } catch (error) {
      if (error?.name === 'AbortError') {
        summary.cancelled = true;
        return;
      }
      summary.failed++;
      onError?.(item, error);
    }
  });

  return summary;
}
