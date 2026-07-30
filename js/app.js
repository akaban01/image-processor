import { FORMATS, supportedFormats, formatByMime, convertImage } from './converter.js';
import { createZip } from './zip.js';

const $ = (id) => document.getElementById(id);

const el = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  format: $('format'),
  formatHint: $('format-hint'),
  quality: $('quality'),
  qualityValue: $('quality-value'),
  qualityField: $('quality-field'),
  resizeMode: $('resize-mode'),
  scale: $('scale'),
  scaleValue: $('scale-value'),
  width: $('target-width'),
  height: $('target-height'),
  noUpscale: $('no-upscale'),
  keepAspect: $('keep-aspect'),
  background: $('background'),
  backgroundField: $('background-field'),
  convert: $('convert'),
  downloadAll: $('download-all'),
  clear: $('clear'),
  status: $('status'),
  resultsPanel: $('results-panel'),
  results: $('results'),
  count: $('count'),
  cardTemplate: $('card-template'),
};

const SETTINGS_KEY = 'image-converter:settings';
const MAX_FILES = 200;

/** @type {Array<{id: number, file: File, previewUrl: string, node: HTMLElement,
 *                result: ?{blob: Blob, url: string, name: string, width: number,
 *                          height: number, sourceWidth: number, sourceHeight: number},
 *                error: ?string}>} */
const items = [];
let nextId = 1;
let busy = false;

/* ── Helpers ───────────────────────────────────────────────────── */

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function baseName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function setStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`.trim();
}

function currentSettings() {
  return {
    mime: el.format.value,
    quality: Number(el.quality.value),
    background: el.background.value,
    resize: {
      mode: el.resizeMode.value,
      scale: Number(el.scale.value),
      width: el.width.value ? Number(el.width.value) : 0,
      height: el.height.value ? Number(el.height.value) : 0,
      noUpscale: el.noUpscale.checked,
      keepAspect: el.keepAspect.checked,
    },
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
  } catch {
    /* Private mode or a full quota — settings just won't persist. */
  }
}

function restoreSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
  } catch {
    return;
  }
  if (!saved) return;

  if (saved.mime && [...el.format.options].some((o) => o.value === saved.mime)) {
    el.format.value = saved.mime;
  }
  if (saved.quality) el.quality.value = saved.quality;
  if (saved.background) el.background.value = saved.background;

  const resize = saved.resize || {};
  if (resize.mode) el.resizeMode.value = resize.mode;
  if (resize.scale) el.scale.value = resize.scale;
  if (resize.width) el.width.value = resize.width;
  if (resize.height) el.height.value = resize.height;
  if (typeof resize.noUpscale === 'boolean') el.noUpscale.checked = resize.noUpscale;
  if (typeof resize.keepAspect === 'boolean') el.keepAspect.checked = resize.keepAspect;
}

/* ── Settings UI ───────────────────────────────────────────────── */

function syncSettingsUI() {
  const format = formatByMime(el.format.value);
  const lossy = Boolean(format && format.lossy);

  el.qualityField.hidden = !lossy;
  el.backgroundField.hidden = Boolean(format && format.alpha);
  el.qualityValue.textContent = Number(el.quality.value).toFixed(2);
  el.scaleValue.textContent = `${el.scale.value}%`;
  el.formatHint.textContent = lossy
    ? `${format.label} is lossy — use the quality slider to trade detail for file size.`
    : 'PNG is lossless: quality is fixed and transparency is preserved.';

  const mode = el.resizeMode.value;
  for (const field of document.querySelectorAll('.resize-opt')) {
    field.hidden = !field.dataset.modes.split(' ').includes(mode);
  }
}

async function populateFormats() {
  const available = await supportedFormats();
  const usable = available.length ? available : FORMATS.filter((f) => f.mime === 'image/png');

  el.format.replaceChildren(
    ...usable.map((format) => {
      const option = document.createElement('option');
      option.value = format.mime;
      option.textContent = format.label;
      return option;
    }),
  );

  const missing = FORMATS.filter((f) => !usable.includes(f));
  if (missing.length) {
    const note = document.createElement('optgroup');
    note.label = `Not supported by this browser: ${missing.map((f) => f.label).join(', ')}`;
    note.disabled = true;
    el.format.append(note);
  }
  el.format.value = usable.some((f) => f.mime === 'image/webp') ? 'image/webp' : usable[0].mime;
}

/* ── Item list ─────────────────────────────────────────────────── */

function refreshControls() {
  const hasItems = items.length > 0;
  const hasResults = items.some((item) => item.result);
  el.convert.disabled = busy || !hasItems;
  el.downloadAll.disabled = busy || !hasResults;
  el.clear.disabled = busy || !hasItems;
  el.resultsPanel.hidden = !hasItems;
  el.count.textContent = hasItems ? `(${items.length})` : '';
}

function renderItem(item) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  const name = node.querySelector('.card-name');
  name.textContent = item.file.name;
  name.title = item.file.name;

  const img = node.querySelector('.thumb img');
  img.src = item.previewUrl;
  img.alt = `Preview of ${item.file.name}`;
  img.addEventListener('load', () => {
    if (!item.result) {
      node.querySelector('.original').textContent =
        `${img.naturalWidth} × ${img.naturalHeight} · ${formatBytes(item.file.size)}`;
    }
  }, { once: true });

  node.querySelector('.original').textContent = formatBytes(item.file.size);
  node.querySelector('.remove').addEventListener('click', () => removeItem(item.id));

  item.node = node;
  el.results.append(node);
}

function updateItem(item) {
  const node = item.node;
  const errorEl = node.querySelector('.card-error');
  const link = node.querySelector('.download');
  const converted = node.querySelector('.converted');

  if (item.error) {
    errorEl.hidden = false;
    errorEl.textContent = item.error;
    link.hidden = true;
    converted.textContent = '';
    return;
  }
  if (!item.result) return;

  errorEl.hidden = true;
  const { blob, url, name, width, height, sourceWidth, sourceHeight } = item.result;

  node.querySelector('.thumb img').src = url;
  node.querySelector('.original').textContent =
    `From ${sourceWidth} × ${sourceHeight} · ${formatBytes(item.file.size)}`;

  const ratio = item.file.size ? blob.size / item.file.size : 1;
  const percent = Math.round(Math.abs(1 - ratio) * 100);
  const direction = ratio <= 1 ? 'down' : 'up';
  const arrow = ratio <= 1 ? '−' : '+';

  converted.replaceChildren(
    document.createTextNode(`${width} × ${height} · ${formatBytes(blob.size)} `),
  );
  const delta = document.createElement('span');
  delta.className = `delta ${direction}`;
  delta.textContent = `(${arrow}${percent}%)`;
  converted.append(delta);

  link.hidden = false;
  link.href = url;
  link.download = name;
  link.textContent = 'Download';
}

function addFiles(fileList) {
  const images = [...fileList].filter(
    (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|gif|bmp|svg)$/i.test(file.name),
  );
  if (!images.length) {
    setStatus('No image files found in that selection.', 'error');
    return;
  }

  const room = MAX_FILES - items.length;
  const accepted = images.slice(0, Math.max(0, room));

  for (const file of accepted) {
    const item = { id: nextId++, file, previewUrl: URL.createObjectURL(file), node: null, result: null, error: null };
    items.push(item);
    renderItem(item);
  }

  const skipped = images.length - accepted.length;
  setStatus(
    skipped
      ? `Added ${accepted.length} image${accepted.length === 1 ? '' : 's'} — ${skipped} skipped (limit is ${MAX_FILES}).`
      : `Added ${accepted.length} image${accepted.length === 1 ? '' : 's'}. Ready to convert.`,
    skipped ? 'error' : '',
  );
  refreshControls();
}

function releaseItem(item) {
  URL.revokeObjectURL(item.previewUrl);
  if (item.result) URL.revokeObjectURL(item.result.url);
}

function removeItem(id) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [item] = items.splice(index, 1);
  releaseItem(item);
  item.node.remove();
  refreshControls();
}

function clearAll() {
  for (const item of items) releaseItem(item);
  items.length = 0;
  el.results.replaceChildren();
  setStatus('');
  refreshControls();
}

/* ── Conversion ────────────────────────────────────────────────── */

/** Give the browser a frame to paint between images so the UI stays responsive. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function convertAll() {
  if (busy || !items.length) return;
  busy = true;
  refreshControls();

  const settings = currentSettings();
  const format = formatByMime(settings.mime);
  const usedNames = new Map();
  let done = 0;
  let failed = 0;

  for (const item of items) {
    setStatus(`Converting ${done + 1} of ${items.length} — ${item.file.name}…`);
    await nextFrame();

    try {
      const output = await convertImage(item.file, settings);

      let name = `${baseName(item.file.name)}.${format.ext}`;
      const seen = usedNames.get(name) || 0;
      usedNames.set(name, seen + 1);
      if (seen) name = `${baseName(item.file.name)}-${seen + 1}.${format.ext}`;

      if (item.result) URL.revokeObjectURL(item.result.url);
      item.result = { ...output, url: URL.createObjectURL(output.blob), name };
      item.error = null;
    } catch (error) {
      item.result = null;
      item.error = error && error.message ? error.message : 'Conversion failed';
      failed++;
    }
    updateItem(item);
    done++;
  }

  busy = false;
  refreshControls();

  const succeeded = done - failed;
  const totalIn = items.reduce((sum, item) => (item.result ? sum + item.file.size : sum), 0);
  const totalOut = items.reduce((sum, item) => (item.result ? sum + item.result.blob.size : sum), 0);
  const summary = succeeded
    ? `Converted ${succeeded} image${succeeded === 1 ? '' : 's'} to ${format.label} — ${formatBytes(totalIn)} → ${formatBytes(totalOut)}.`
    : 'Nothing was converted.';

  setStatus(failed ? `${summary} ${failed} failed.` : summary, failed ? 'error' : 'done');
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadAll() {
  const converted = items.filter((item) => item.result);
  if (!converted.length) return;

  if (converted.length === 1) {
    saveBlob(converted[0].result.blob, converted[0].result.name);
    return;
  }

  busy = true;
  refreshControls();
  setStatus('Building archive…');
  try {
    const zip = await createZip(
      converted.map((item) => ({ name: item.result.name, blob: item.result.blob })),
    );
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(zip, `converted-images-${stamp}.zip`);
    setStatus(`Archive ready — ${converted.length} images, ${formatBytes(zip.size)}.`, 'done');
  } catch (error) {
    setStatus(`Could not build the archive: ${error.message}`, 'error');
  } finally {
    busy = false;
    refreshControls();
  }
}

/* ── Events ────────────────────────────────────────────────────── */

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener('change', () => {
  addFiles(el.fileInput.files);
  el.fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('dragover'));
}
el.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
});
// Dropping anywhere else should not navigate away from the page.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

document.addEventListener('paste', (event) => {
  const files = event.clipboardData && event.clipboardData.files;
  if (files && files.length) {
    event.preventDefault();
    addFiles(files);
  }
});

el.convert.addEventListener('click', convertAll);
el.downloadAll.addEventListener('click', downloadAll);
el.clear.addEventListener('click', clearAll);

for (const input of [el.format, el.quality, el.resizeMode, el.scale, el.width, el.height, el.noUpscale, el.keepAspect, el.background]) {
  input.addEventListener('input', () => {
    syncSettingsUI();
    saveSettings();
  });
}

window.addEventListener('beforeunload', () => {
  for (const item of items) releaseItem(item);
});

/* ── Start ─────────────────────────────────────────────────────── */

(async function init() {
  await populateFormats();
  restoreSettings();
  syncSettingsUI();
  refreshControls();
})();
