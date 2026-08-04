import test from 'node:test';
import assert from 'node:assert/strict';

import { runBatch } from '../js/lib/batch.js';
import { defaultSettings } from '../js/lib/settings.js';

const makeItem = (name, size = 1000) => ({
  id: name,
  file: new File([new Uint8Array(size)], name, { type: 'image/png' }),
});

/**
 * A pipeline stand-in. `behaviour` maps a filename to what should happen:
 * a result patch, or an Error to throw.
 */
function fakePipeline(behaviour = {}, concurrency = 2) {
  const active = { current: 0, peak: 0 };

  return {
    active,
    concurrency,
    async convert(file, settings, { signal, onStart } = {}) {
      onStart?.();
      active.current++;
      active.peak = Math.max(active.peak, active.current);

      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

        const outcome = behaviour[file.name];
        if (outcome instanceof Error) throw outcome;

        return {
          blob: new Blob([new Uint8Array(500)]),
          mime: 'image/webp',
          formatLabel: 'WebP',
          extension: 'webp',
          width: 100,
          height: 50,
          sourceWidth: 200,
          sourceHeight: 100,
          withinBudget: true,
          ...outcome,
        };
      } finally {
        active.current--;
      }
    },
    cancelAll() {},
    dispose() {},
  };
}

test('a clean batch converts everything and totals the bytes', async () => {
  const items = [makeItem('a.png'), makeItem('b.png'), makeItem('c.png')];
  const done = [];

  const summary = await runBatch({
    items,
    settings: defaultSettings(),
    pipeline: fakePipeline(),
    onDone: (item, result) => done.push(result.name),
  });

  assert.equal(summary.converted, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.cancelled, false);
  assert.equal(summary.bytesIn, 3000);
  assert.equal(summary.bytesOut, 1500);
  assert.deepEqual(done.sort(), ['a.webp', 'b.webp', 'c.webp']);
});

test('one bad file does not stop the rest', async () => {
  const items = [makeItem('good.png'), makeItem('bad.png'), makeItem('alsogood.png')];
  const errors = [];

  const summary = await runBatch({
    items,
    settings: defaultSettings(),
    pipeline: fakePipeline({ 'bad.png': new Error('Unsupported or corrupt image file') }),
    onError: (item, error) => errors.push([item.file.name, error.message]),
  });

  assert.equal(summary.converted, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(errors, [['bad.png', 'Unsupported or corrupt image file']]);
});

test('concurrency is capped at the pipeline width', async () => {
  const items = Array.from({ length: 8 }, (unused, i) => makeItem(`img-${i}.png`));
  const pipeline = fakePipeline({}, 3);

  await runBatch({ items, settings: defaultSettings(), pipeline });

  assert.ok(pipeline.active.peak <= 3, `peak concurrency was ${pipeline.active.peak}`);
  assert.equal(pipeline.active.peak, 3, 'and the lanes are actually used');
});

test('a single-lane pipeline runs strictly one at a time', async () => {
  const items = Array.from({ length: 4 }, (unused, i) => makeItem(`img-${i}.png`));
  const pipeline = fakePipeline({}, 1);

  await runBatch({ items, settings: defaultSettings(), pipeline });
  assert.equal(pipeline.active.peak, 1);
});

test('output names follow the template and stay unique', async () => {
  // Same stem, different source extensions: both want "photo.webp".
  const items = [makeItem('photo.png'), makeItem('photo.jpg')];
  const names = [];

  await runBatch({
    items,
    settings: { ...defaultSettings(), template: '{name}-{w}x{h}.{ext}' },
    pipeline: fakePipeline({}, 1),
    onDone: (item, result) => names.push(result.name),
  });

  assert.deepEqual(names, ['photo-100x50.webp', 'photo-100x50-2.webp']);
});

test('the batch index token counts from one, in item order', async () => {
  const items = [makeItem('a.png'), makeItem('b.png')];
  const names = [];

  await runBatch({
    items,
    settings: { ...defaultSettings(), template: '{index}-{name}.{ext}' },
    pipeline: fakePipeline({}, 1),
    onDone: (item, result) => names.push(result.name),
  });

  assert.deepEqual(names, ['1-a.webp', '2-b.webp']);
});

test('an abort mid-batch is reported as cancelled, not failed', async () => {
  const items = Array.from({ length: 6 }, (unused, i) => makeItem(`img-${i}.png`));
  const controller = new AbortController();

  const summary = await runBatch({
    items,
    settings: defaultSettings(),
    pipeline: fakePipeline({}, 1),
    signal: controller.signal,
    onDone: () => controller.abort(),
  });

  assert.equal(summary.cancelled, true);
  assert.equal(summary.failed, 0);
  assert.ok(summary.converted < items.length, 'stopped early');
});

test('a signal that is already aborted converts nothing', async () => {
  const controller = new AbortController();
  controller.abort();

  const summary = await runBatch({
    items: [makeItem('a.png')],
    settings: defaultSettings(),
    pipeline: fakePipeline(),
    signal: controller.signal,
  });

  assert.equal(summary.converted, 0);
  assert.equal(summary.cancelled, true);
});

test('an empty batch is a no-op', async () => {
  const summary = await runBatch({
    items: [],
    settings: defaultSettings(),
    pipeline: fakePipeline(),
  });
  assert.deepEqual(summary, {
    converted: 0, failed: 0, cancelled: false, bytesIn: 0, bytesOut: 0,
  });
});

test('the extension comes from the format the pipeline actually chose', async () => {
  const names = [];
  await runBatch({
    items: [makeItem('a.png')],
    settings: defaultSettings(),
    pipeline: fakePipeline({
      'a.png': { mime: 'image/avif', extension: 'avif', formatLabel: 'AVIF' },
    }),
    onDone: (item, result) => names.push(result.name),
  });

  assert.deepEqual(names, ['a.avif']);
});
