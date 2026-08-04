/**
 * A small worker pool.
 *
 * Workers are spawned lazily — a single-image conversion never pays to start
 * four of them — and each handles one job at a time. Cancellation terminates
 * the workers outright rather than asking them politely: a half-finished AVIF
 * encode has no value, and termination is the only way to stop one instantly.
 */

/** Leave a core for the UI, and stop at 4 — encoders are memory-hungry. */
export function defaultPoolSize() {
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, cores - 1));
}

/** Can this browser run the off-thread pipeline at all? */
export function supportsWorkerPipeline() {
  return (
    typeof Worker === 'function'
    && typeof OffscreenCanvas === 'function'
    && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
    && typeof createImageBitmap === 'function'
  );
}

const abortError = () => new DOMException('Cancelled', 'AbortError');

export class WorkerPool {
  /**
   * @param {URL|string} url worker entry point
   * @param {object} [options]
   * @param {number} [options.size]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.size = Math.max(1, options.size || defaultPoolSize());
    /** @type {Array<{worker: Worker, busy: boolean}>} */
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.disposed = false;
  }

  /** Number of jobs queued or running. */
  get load() {
    return this.queue.length + this.pending.size;
  }

  #spawn() {
    const worker = new Worker(this.url, { type: 'module' });
    const slot = { worker, busy: false };

    worker.addEventListener('message', (event) => {
      const message = event.data;
      const job = this.pending.get(message?.id);
      if (!job) return;

      this.pending.delete(message.id);
      slot.busy = false;

      if (message.type === 'done') {
        job.resolve(message.result);
      } else if (message.type === 'error') {
        // An abort has to keep its identity across the message boundary, or
        // callers would count a cancelled image as a failed one.
        if (message.code === 'AbortError') {
          job.reject(abortError());
        } else {
          const error = new Error(message.message);
          error.code = message.code;
          job.reject(error);
        }
      }

      this.#drain();
    });

    worker.addEventListener('error', (event) => {
      // A worker that failed to boot (bad URL, syntax error) would otherwise
      // leave its jobs hanging forever.
      event.preventDefault?.();
      this.#failWorker(slot, new Error(event.message || 'The conversion worker crashed'));
    });

    this.workers.push(slot);
    return slot;
  }

  #failWorker(slot, error) {
    for (const [id, job] of this.pending) {
      if (job.slot === slot) {
        this.pending.delete(id);
        job.reject(error);
      }
    }
    slot.busy = false;
    slot.worker.terminate();
    this.workers = this.workers.filter((entry) => entry !== slot);
    this.#drain();
  }

  #idleSlot() {
    const free = this.workers.find((slot) => !slot.busy);
    if (free) return free;
    return this.workers.length < this.size ? this.#spawn() : null;
  }

  #drain() {
    while (this.queue.length) {
      const slot = this.#idleSlot();
      if (!slot) return;

      const job = this.queue.shift();
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }

      slot.busy = true;
      job.slot = slot;
      this.pending.set(job.id, job);
      job.onStart?.();

      try {
        slot.worker.postMessage({ ...job.payload, type: 'convert', id: job.id }, job.transfer || []);
      } catch (error) {
        this.pending.delete(job.id);
        slot.busy = false;
        job.reject(error);
      }
    }
  }

  /**
   * Queue a job.
   *
   * @param {object} payload structured-cloneable message body
   * @param {object} [options]
   * @param {Transferable[]} [options.transfer]
   * @param {AbortSignal} [options.signal]
   * @param {() => void} [options.onStart] fired when a worker picks the job up
   * @returns {Promise<any>}
   */
  run(payload, options = {}) {
    if (this.disposed) return Promise.reject(new Error('The worker pool was disposed'));

    return new Promise((resolve, reject) => {
      const job = {
        id: this.nextId++,
        payload,
        transfer: options.transfer,
        signal: options.signal,
        onStart: options.onStart,
        resolve,
        reject,
        slot: null,
      };

      if (options.signal) {
        if (options.signal.aborted) {
          reject(abortError());
          return;
        }
        options.signal.addEventListener('abort', () => {
          if (this.pending.has(job.id)) {
            job.slot?.worker.postMessage({ type: 'cancel', id: job.id });
          } else {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(abortError());
            }
          }
        }, { once: true });
      }

      this.queue.push(job);
      this.#drain();
    });
  }

  /** Drop every queued job and kill anything already running. */
  cancelAll() {
    const queued = this.queue.splice(0);
    for (const job of queued) job.reject(abortError());

    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const job of inFlight) job.reject(abortError());

    for (const slot of this.workers) slot.worker.terminate();
    this.workers = [];
  }

  /** Release every worker. The pool cannot be used again afterwards. */
  dispose() {
    this.cancelAll();
    this.disposed = true;
  }
}
