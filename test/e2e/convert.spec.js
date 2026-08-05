import { test, expect } from '@playwright/test';

import { pngUpload } from './fixtures.js';

/** Parse a card's "1920 × 1080 · WebP · 40 KB" line. */
function parseConverted(text) {
  const match = /(\d+)\s*×\s*(\d+)\s*·\s*(\w+)/.exec(text || '');
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]), format: match[3] };
}

const firstCard = (page) => page.locator('.card').first();

async function addImages(page, uploads) {
  await page.setInputFiles('#file-input', uploads);
  await expect(page.locator('.card')).toHaveCount(uploads.length);
}

async function convert(page) {
  await page.click('#convert');
  await expect(page.locator('#convert')).toBeEnabled({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));

  await page.goto('/index.html');
  // Every test starts from a clean slate rather than a previous run's settings.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');

  page.problems = problems;
});

test.afterEach(async ({ page }) => {
  expect(page.problems ?? []).toEqual([]);
});

test('loads and reports the worker pipeline', async ({ page }) => {
  await expect(page).toHaveTitle(/Image Converter/);
  await expect(page.locator('h1')).toHaveText('Image Converter');
  await expect(page.locator('#engine')).toContainText('background thread');
  await expect(page.locator('#convert')).toBeDisabled();
});

test('converts a single image to WebP', async ({ page }) => {
  await addImages(page, [pngUpload('photo.png', { width: 320, height: 240 })]);

  await expect(firstCard(page).locator('.original')).toContainText('320 × 240');
  await expect(page.locator('#convert')).toBeEnabled();

  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');

  const converted = parseConverted(await card.locator('.converted').textContent());
  expect(converted).toEqual({ width: 320, height: 240, format: 'WebP' });

  await expect(card.locator('.download')).toHaveAttribute('download', 'photo.webp');
  await expect(page.locator('#status')).toContainText('Converted 1 image');
  await expect(page.locator('#savings')).toBeVisible();
});

test('honours the chosen output format', async ({ page }) => {
  await addImages(page, [pngUpload('a.png')]);
  await page.selectOption('#format', 'image/jpeg');
  await convert(page);

  const card = firstCard(page);
  expect(parseConverted(await card.locator('.converted').textContent()).format).toBe('JPEG');
  await expect(card.locator('.download')).toHaveAttribute('download', 'a.jpg');
});

test('limits the longest edge', async ({ page }) => {
  await addImages(page, [pngUpload('wide.png', { width: 800, height: 400 })]);

  await page.selectOption('#resize-mode', 'longest');
  await page.fill('#edge', '200');
  await convert(page);

  const converted = parseConverted(await firstCard(page).locator('.converted').textContent());
  expect(converted.width).toBe(200);
  expect(converted.height).toBe(100);
});

test('fills and crops to an exact box', async ({ page }) => {
  await addImages(page, [pngUpload('wide.png', { width: 800, height: 400 })]);

  await page.selectOption('#resize-mode', 'cover');
  await page.fill('#target-width', '300');
  await page.fill('#target-height', '300');
  await convert(page);

  const converted = parseConverted(await firstCard(page).locator('.converted').textContent());
  expect(converted).toMatchObject({ width: 300, height: 300 });
});

test('rotation swaps the output dimensions', async ({ page }) => {
  await addImages(page, [pngUpload('wide.png', { width: 800, height: 400 })]);

  await page.click('[data-rotate="90"]');
  await convert(page);

  const converted = parseConverted(await firstCard(page).locator('.converted').textContent());
  expect(converted).toMatchObject({ width: 400, height: 800 });
});

test('reaches a target file size', async ({ page }) => {
  await addImages(page, [pngUpload('big.png', { width: 1200, height: 900 })]);

  await page.selectOption('#format', 'image/jpeg');
  await page.check('#target-enabled');
  await page.fill('#target-size', '20 KB');
  await page.locator('#target-size').blur();
  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');

  const text = await card.locator('.converted').textContent();
  const size = /·\s*([\d.]+)\s*(B|KB|MB)\s*$/m.exec(text.replace(/[−+]\d+%/, '').trim());
  expect(size, `could not read a size from "${text}"`).not.toBeNull();

  const bytes = Number(size[1]) * ({ B: 1, KB: 1024, MB: 1024 ** 2 })[size[2]];
  expect(bytes).toBeLessThanOrEqual(20 * 1024 * 1.05);
});

test('no size warning appears when the size target is switched off', async ({ page }) => {
  // The byte figure lingers in the settings after the toggle is cleared; it
  // must not be treated as a budget the conversion failed to meet.
  await page.check('#target-enabled');
  await page.fill('#target-size', '10 KB');
  await page.uncheck('#target-enabled');

  await addImages(page, [pngUpload('noisy.png', { width: 900, height: 700 })]);
  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');
  await expect(card.locator('.card-note')).toBeHidden();
});

test('the smallest-format mode picks a format for you', async ({ page }) => {
  await addImages(page, [pngUpload('auto.png', { width: 400, height: 300 })]);

  await page.selectOption('#format', 'auto');
  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');

  const converted = parseConverted(await card.locator('.converted').textContent());
  expect(['WebP', 'AVIF', 'JPEG', 'PNG']).toContain(converted.format);

  const name = await card.locator('.download').getAttribute('download');
  expect(name).toMatch(/^auto\.(webp|avif|jpg|png)$/);
});

test('falls back to the main thread for SVG, which no worker can decode', async ({ page }) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
      <rect width="200" height="100" fill="#3355ff"/>
      <circle cx="60" cy="50" r="30" fill="#ffcc00"/>
    </svg>`;

  await page.setInputFiles('#file-input', [
    { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) },
  ]);
  await expect(page.locator('.card')).toHaveCount(1);

  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');
  expect(parseConverted(await card.locator('.converted').textContent()))
    .toMatchObject({ width: 200, height: 100, format: 'WebP' });
  await expect(card.locator('.download')).toHaveAttribute('download', 'logo.webp');
});

test('applies a preset', async ({ page }) => {
  await addImages(page, [pngUpload('p.png', { width: 900, height: 600 })]);

  await page.locator('.preset', { hasText: 'Thumbnail' }).click();
  await expect(page.locator('#resize-mode')).toHaveValue('cover');

  await convert(page);
  const converted = parseConverted(await firstCard(page).locator('.converted').textContent());
  expect(converted).toMatchObject({ width: 400, height: 400 });
});

test('the photo standard picker offers every standard', async ({ page }) => {
  // An empty picker is what a stale cached script looks like, so the count is
  // asserted rather than just the app not crashing.
  const options = page.locator('#document-standard option');
  await expect(options).toHaveCount(4);
  await expect(options.first()).toHaveAttribute('value', 'none');
  await expect(options.nth(1)).toHaveAttribute('value', 'umrah-hajj-evisa');
  await expect(page.locator('#document-standard')).toHaveValue('none');
});

test('the quality slider says it is only a ceiling once a target is set', async ({ page }) => {
  await expect(page.locator('#quality-label')).toHaveText('Quality');
  await expect(page.locator('#quality-hint')).toHaveText('Lower quality, smaller file.');

  await page.check('#target-enabled');
  await expect(page.locator('#quality-label')).toHaveText('Quality ceiling');
  await expect(page.locator('#quality-hint')).toContainText('not the quality used');
  await expect(page.locator('#quality-hint')).toContainText('0.20');
  await expect(page.locator('#quality-hint')).toContainText('will not shrink a file');

  await page.uncheck('#target-enabled');
  await expect(page.locator('#quality-label')).toHaveText('Quality');
});

test('a target that cannot be met says what to do about it', async ({ page }) => {
  await addImages(page, [pngUpload('noisy.png', { width: 1400, height: 1000 })]);

  await page.selectOption('#format', 'image/jpeg');
  await page.check('#target-enabled');
  await page.fill('#target-size', '1 KB');
  await page.locator('#target-size').blur();
  await convert(page);

  const note = firstCard(page).locator('.card-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Could not reach the target size');
  await expect(note).toContainText('Reduce the dimensions');
});

test('the Umrah / Hajj eVisa standard produces a photo that meets the spec', async ({ page }) => {
  await addImages(page, [pngUpload('pilgrim.png', { width: 900, height: 1200 })]);

  await page.selectOption('#document-standard', 'umrah-hajj-evisa');
  await expect(page.locator('#format')).toHaveValue('image/jpeg');
  await expect(page.locator('#resize-mode')).toHaveValue('cover');
  await expect(page.locator('#target-size')).toHaveValue('200 KB');
  await expect(page.locator('#document-applied')).toContainText('600 × 600');

  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');
  expect(parseConverted(await card.locator('.converted').textContent()))
    .toMatchObject({ width: 600, height: 600, format: 'JPEG' });
  await expect(card.locator('.card-check')).toHaveAttribute('data-ok', 'true');
  await expect(card.locator('.download')).toHaveAttribute('download', 'pilgrim.jpg');
});

test('a standard survives a reload, and settings that drift from it are flagged', async ({ page }) => {
  await page.selectOption('#document-standard', 'umrah-hajj-evisa');
  await expect(page.locator('#document-drift')).toBeHidden();

  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('#document-standard')).toHaveValue('umrah-hajj-evisa');

  await page.fill('#target-width', '400');
  await expect(page.locator('#document-drift')).toBeVisible();

  await page.click('#document-reapply');
  await expect(page.locator('#target-width')).toHaveValue('600');
  await expect(page.locator('#document-drift')).toBeHidden();
});

test('the camera button appears only while a standard is selected', async ({ page }) => {
  await expect(page.locator('#camera-open')).toBeHidden();

  await page.selectOption('#document-standard', 'umrah-hajj-print');
  await expect(page.locator('#camera-open')).toBeVisible();

  await page.selectOption('#document-standard', 'none');
  await expect(page.locator('#camera-open')).toBeHidden();
});

test('the guided capture converts straight into a compliant photo', async ({ page }) => {
  await page.selectOption('#document-standard', 'umrah-hajj-evisa');
  await page.click('#camera-open');

  await expect(page.locator('#camera')).toBeVisible();
  await expect(page.locator('#camera-title')).toHaveText('Take a photo for Umrah / Hajj eVisa');
  await expect(page.locator('#camera-error')).toBeHidden();
  // The guide is drawn on the standard's own grid, so a square standard puts
  // the head outline dead centre.
  await expect(page.locator('#camera-guide')).toHaveAttribute('viewBox', '0 0 600 600');
  await expect(page.locator('#camera-guide ellipse')).toHaveAttribute('cx', '300');

  await page.click('#camera-shoot');
  await expect(page.locator('#camera-still')).toBeVisible();
  await expect(page.locator('#camera-video')).toBeHidden();

  // A retake goes back to the live view rather than stacking captures.
  await page.click('#camera-retake');
  await expect(page.locator('#camera-video')).toBeVisible();
  await expect(page.locator('#camera-still')).toBeHidden();

  await page.click('#camera-shoot');
  await page.click('#camera-use');

  await expect(page.locator('#camera')).toBeHidden();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('#convert')).toBeEnabled({ timeout: 30_000 });

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');
  expect(parseConverted(await card.locator('.converted').textContent()))
    .toMatchObject({ width: 600, height: 600, format: 'JPEG' });
  await expect(card.locator('.card-check')).toHaveAttribute('data-ok', 'true');
});

test('closing the viewfinder releases the camera', async ({ page }) => {
  await page.selectOption('#document-standard', 'umrah-hajj-evisa');
  await page.click('#camera-open');
  await expect(page.locator('#camera-shoot')).toBeEnabled();

  await page.click('#camera-close');
  await expect(page.locator('#camera')).toBeHidden();

  // Every track stopped means the camera light goes out; a live track here is
  // the difference between a tool and something people uninstall.
  const live = await page.evaluate(() => {
    const video = document.getElementById('camera-video');
    return (video.srcObject?.getTracks() || []).filter((track) => track.readyState === 'live').length;
  });
  expect(live).toBe(0);
});

test('the print standard records the photo’s physical size', async ({ page }) => {
  await addImages(page, [pngUpload('print.png', { width: 500, height: 500 })]);

  await page.selectOption('#document-standard', 'umrah-hajj-print');
  await convert(page);

  const card = firstCard(page);
  await expect(card).toHaveAttribute('data-state', 'done');
  await expect(card.locator('.converted')).toContainText('51 × 51 mm @ 300 DPI');
  await expect(card.locator('.card-check')).toHaveAttribute('data-ok', 'true');
});

test('converts a batch and keeps output names unique', async ({ page }) => {
  await addImages(page, [
    pngUpload('shot.png', { width: 200, height: 200 }),
    pngUpload('shot.jpg', { width: 200, height: 200 }),
    pngUpload('other.png', { width: 200, height: 200 }),
  ]);

  await convert(page);

  await expect(page.locator('.card[data-state="done"]')).toHaveCount(3);
  const names = await page.locator('.download').evaluateAll(
    (links) => links.map((link) => link.getAttribute('download')),
  );
  expect(new Set(names).size).toBe(3);
  expect(names).toContain('shot.webp');
  expect(names).toContain('shot-2.webp');
});

test('applies the filename pattern', async ({ page }) => {
  await addImages(page, [pngUpload('beach.png', { width: 640, height: 480 })]);

  await page.locator('.advanced > summary').click();
  await page.fill('#template', '{name}-{w}x{h}.{ext}');
  await convert(page);

  await expect(firstCard(page).locator('.download'))
    .toHaveAttribute('download', 'beach-640x480.webp');
});

test('downloads a ZIP for a batch', async ({ page }) => {
  await addImages(page, [
    pngUpload('one.png', { width: 120, height: 120 }),
    pngUpload('two.png', { width: 120, height: 120 }),
  ]);
  await convert(page);

  const download = await Promise.race([
    page.waitForEvent('download'),
    page.click('#download-all').then(() => page.waitForEvent('download')),
  ]);

  expect(download.suggestedFilename()).toMatch(/^converted-images-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.locator('#status')).toContainText('Archive ready');
});

test('a single converted image downloads directly', async ({ page }) => {
  await addImages(page, [pngUpload('solo.png', { width: 100, height: 100 })]);
  await convert(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download-all'),
  ]);
  expect(download.suggestedFilename()).toBe('solo.webp');
});

test('rejects non-images', async ({ page }) => {
  await page.setInputFiles('#file-input', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  ]);

  await expect(page.locator('#status')).toContainText('No image files');
  await expect(page.locator('.card')).toHaveCount(0);
});

test('de-duplicates a file picked twice', async ({ page }) => {
  // `setInputFiles` stamps a fresh lastModified on every upload, which makes
  // two picks of the same file look like two different files. Driving the
  // input directly keeps the identity stable, as a real file picker would.
  const pick = () => page.evaluate(() => {
    const file = new File([new Uint8Array([1, 2, 3])], 'dup.png', {
      type: 'image/png',
      lastModified: 1_700_000_000_000,
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    const input = document.getElementById('file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });

  await pick();
  await expect(page.locator('.card')).toHaveCount(1);

  await pick();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('Already added');
});

test('warns when the settings would leave the images unchanged', async ({ page }) => {
  await expect(page.locator('#advice')).toBeHidden();

  await page.selectOption('#format', 'image/png');
  await addImages(page, [pngUpload('already.png', { width: 100, height: 100 })]);
  await expect(page.locator('#advice')).toBeVisible();

  // Any real change to the output clears the warning.
  await page.selectOption('#format', 'image/webp');
  await expect(page.locator('#advice')).toBeHidden();

  await page.selectOption('#format', 'image/png');
  await expect(page.locator('#advice')).toBeVisible();
  await page.click('[data-rotate="90"]');
  await expect(page.locator('#advice')).toBeHidden();
});

test('clear and remove empty the list', async ({ page }) => {
  await addImages(page, [pngUpload('a.png'), pngUpload('b.png')]);

  await firstCard(page).locator('.remove').click();
  await expect(page.locator('.card')).toHaveCount(1);

  await page.click('#clear');
  await expect(page.locator('.card')).toHaveCount(0);
  await expect(page.locator('#results-panel')).toBeHidden();
});

test('the before/after comparison opens', async ({ page }) => {
  await addImages(page, [pngUpload('compare.png', { width: 400, height: 300 })]);
  await convert(page);

  await firstCard(page).locator('.thumb').click();
  const dialog = page.locator('#compare');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#compare-title')).toHaveText('compare.png');
  await expect(page.locator('#compare-after-meta')).toContainText('400 × 300');

  await page.click('#compare-close');
  await expect(dialog).toBeHidden();
});

test('settings and theme persist across a reload', async ({ page }) => {
  await page.selectOption('#format', 'image/png');
  await page.selectOption('#resize-mode', 'percent');
  await page.fill('#scale', '25');
  await page.click('.theme-toggle button[data-theme="light"]');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload();

  await expect(page.locator('#format')).toHaveValue('image/png');
  await expect(page.locator('#resize-mode')).toHaveValue('percent');
  await expect(page.locator('#scale')).toHaveValue('25');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('restoring defaults resets the form', async ({ page }) => {
  await page.selectOption('#resize-mode', 'percent');
  await page.locator('.advanced > summary').click();
  await page.click('#reset');

  await expect(page.locator('#resize-mode')).toHaveValue('none');
  await expect(page.locator('#format')).toHaveValue('image/webp');
});

test('quality is hidden for a lossless format and shown again after', async ({ page }) => {
  await expect(page.locator('#quality-field')).toBeVisible();

  await page.selectOption('#format', 'image/png');
  await expect(page.locator('#quality-field')).toBeHidden();

  await page.selectOption('#format', 'image/webp');
  await expect(page.locator('#quality-field')).toBeVisible();
});

test('a corrupt file fails on its own without stopping the batch', async ({ page }) => {
  await page.setInputFiles('#file-input', [
    pngUpload('good.png', { width: 100, height: 100 }),
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a png at all') },
  ]);
  await expect(page.locator('.card')).toHaveCount(2);

  await convert(page);

  await expect(page.locator('.card[data-state="done"]')).toHaveCount(1);

  const failed = page.locator('.card[data-state="error"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.locator('.card-error')).toBeVisible();
  await expect(failed.locator('.download')).toBeHidden();
  await expect(page.locator('#status')).toContainText('failure');
});

test('cancelling leaves the app usable and nothing spinning', async ({ page }) => {
  await addImages(page, Array.from(
    { length: 8 },
    (unused, i) => pngUpload(`batch-${i}.png`, { width: 800, height: 600 }),
  ));

  // Lossless output at 4x is the slowest work the app can be asked to do,
  // which keeps the run alive long enough for the cancel click to land.
  await page.selectOption('#format', 'image/png');
  await page.selectOption('#resize-mode', 'percent');
  await page.fill('#scale', '400');

  await page.click('#convert');
  await expect(page.locator('#cancel')).toBeVisible();

  // Tolerate the batch finishing first: the invariants below are what matter,
  // and asserting them either way keeps this test off the flaky list.
  const clicked = await page.click('#cancel', { timeout: 10_000 }).then(() => true, () => false);

  await expect(page.locator('#convert')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#cancel')).toBeHidden();
  await expect(page.locator('.card[data-state="running"]')).toHaveCount(0);
  await expect(page.locator('#convert')).toBeEnabled();
  await expect(page.locator('#status')).not.toHaveClass(/error/);
  await expect(page.locator('#status')).toContainText(clicked ? /Cancelled|Converted/ : /Converted/);

  // And the app still works afterwards.
  await page.selectOption('#resize-mode', 'none');
  await convert(page);
  await expect(page.locator('.card[data-state="done"]')).toHaveCount(8);
});

test('the keyboard shortcut converts', async ({ page }) => {
  await addImages(page, [pngUpload('key.png', { width: 100, height: 100 })]);

  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.card[data-state="done"]')).toHaveCount(1, { timeout: 30_000 });
});
