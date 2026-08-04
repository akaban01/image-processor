/**
 * UI controller: intake, settings binding, the batch run, and downloads.
 *
 * All the interesting logic lives in `js/lib/`; this file is deliberately the
 * only place that knows about the DOM.
 */

import { AUTO_FORMAT, AUTO_MIME, FORMATS, formatByMime, supportedFormats } from './lib/formats.js';
import { formatBytes, parseByteSize, sizeDelta } from './lib/bytes.js';
import { createZip } from './lib/zip.js';
import { createPipeline } from './lib/pipeline.js';
import { runBatch } from './lib/batch.js';
import { filesFromDataTransfer, filterImages } from './lib/intake.js';
import {
  PRESETS,
  THEMES,
  applyPreset,
  defaultSettings,
  isPassthrough,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './lib/settings.js';

const $ = (id) => document.getElementById(id);

const el = {
  dropzone: $('dropzone'),
  dropOverlay: $('drop-overlay'),
  fileInput: $('file-input'),
  presets: $('presets'),
  format: $('format'),
  formatHint: $('format-hint'),
  quality: $('quality'),
  qualityLabel: $('quality-label'),
  qualityValue: $('quality-value'),
  qualityField: $('quality-field'),
  qualityHint: $('quality-hint'),
  targetEnabled: $('target-enabled'),
  targetRow: $('target-row'),
  targetSize: $('target-size'),
  resizeMode: $('resize-mode'),
  resizeHint: $('resize-hint'),
  edge: $('edge'),
  scale: $('scale'),
  scaleValue: $('scale-value'),
  width: $('target-width'),
  height: $('target-height'),
  position: $('position'),
  noUpscale: $('no-upscale'),
  flipH: $('flip-h'),
  flipV: $('flip-v'),
  background: $('background'),
  backgroundField: $('background-field'),
  template: $('template'),
  reset: $('reset'),
  convert: $('convert'),
  cancel: $('cancel'),
  downloadAll: $('download-all'),
  clear: $('clear'),
  status: $('status'),
  advice: $('advice'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  resultsPanel: $('results-panel'),
  results: $('results'),
  count: $('count'),
  savings: $('savings'),
  cardTemplate: $('card-template'),
  install: $('install'),
  engine: $('engine'),
  compare: $('compare'),
  compareTitle: $('compare-title'),
  compareBefore: $('compare-before'),
  compareAfter: $('compare-after'),
  compareStage: $('compare-stage'),
  compareRange: $('compare-range'),
  compareClose: $('compare-close'),
  compareBeforeMeta: $('compare-before-meta'),
  compareAfterMeta: $('compare-after-meta'),
};

const THEME_KEY = 'image-converter:theme';
const MAX_FILES = 500;

/**
 * @typedef {object} Item
 * @property {number} id
 * @property {File} file
 * @property {string} previewUrl
 * @property {HTMLElement} node
 * @property {'pending'|'running'|'done'|'error'} state
 * @property {?object} result
 * @property {?string} error
 */

/** @type {Item[]} */
const items = [];
const seenFiles = new Set();
let nextId = 1;
let settings = defaultSettings();
let pipeline = null;
let runController = null;
let busy = false;
let installPrompt = null;

/* ══ Status & progress ══════════════════════════════════════════ */

function setStatus(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`.trim();
}

function setProgress(done, total) {
  if (!total) {
    el.progress.hidden = true;
    return;
  }
  const percent = Math.round((done / total) * 100);
  el.progress.hidden = false;
  el.progress.setAttribute('aria-valuenow', String(percent));
  el.progressBar.style.width = `${percent}%`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ══ Theme ═════════════════════════════════════════════════════ */

function applyTheme(theme) {
  const chosen = THEMES.includes(theme) ? theme : 'auto';
  if (chosen === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', chosen);

  for (const button of document.querySelectorAll('.theme-toggle button')) {
    button.setAttribute('aria-checked', String(button.dataset.theme === chosen));
  }

  try {
    localStorage.setItem(THEME_KEY, chosen);
  } catch {
    /* Theme just won't stick; not worth surfacing. */
  }
}

/* ══ Settings ⇄ DOM ════════════════════════════════════════════ */

function readSettings() {
  return normalizeSettings({
    format: el.format.value,
    quality: Number(el.quality.value),
    targetEnabled: el.targetEnabled.checked,
    targetBytes: parseByteSize(el.targetSize.value),
    background: el.background.value,
    template: el.template.value,
    rotate: Number(document.querySelector('[data-rotate][aria-checked="true"]')?.dataset.rotate || 0),
    flipH: el.flipH.getAttribute('aria-pressed') === 'true',
    flipV: el.flipV.getAttribute('aria-pressed') === 'true',
    resize: {
      mode: el.resizeMode.value,
      scale: Number(el.scale.value),
      width: Number(el.width.value) || 0,
      height: Number(el.height.value) || 0,
      edge: Number(el.edge.value) || 0,
      noUpscale: el.noUpscale.checked,
      position: el.position.value,
    },
  }, settings);
}

function writeSettings(next) {
  settings = next;

  if ([...el.format.options].some((option) => option.value === next.format)) {
    el.format.value = next.format;
  }
  el.quality.value = String(next.quality);
  el.targetEnabled.checked = next.targetEnabled;
  el.targetSize.value = next.targetBytes ? formatBytes(next.targetBytes) : '500 KB';
  el.background.value = next.background;
  el.template.value = next.template;

  for (const button of document.querySelectorAll('[data-rotate]')) {
    button.setAttribute('aria-checked', String(Number(button.dataset.rotate) === next.rotate));
  }
  el.flipH.setAttribute('aria-pressed', String(next.flipH));
  el.flipV.setAttribute('aria-pressed', String(next.flipV));

  el.resizeMode.value = next.resize.mode;
  el.scale.value = String(next.resize.scale);
  el.width.value = next.resize.width ? String(next.resize.width) : '';
  el.height.value = next.resize.height ? String(next.resize.height) : '';
  el.edge.value = String(next.resize.edge);
  el.noUpscale.checked = next.resize.noUpscale;
  el.position.value = next.resize.position;
}

const RESIZE_HINTS = {
  none: 'Pixels are untouched; only the format and quality change.',
  longest: 'Scales so neither side exceeds this length. Aspect ratio is kept.',
  fit: 'Scales to sit inside the box. Leave a field blank to constrain one side only.',
  cover: 'Fills the box exactly and centre-crops the overflow.',
  percent: 'Multiplies both sides. 100% keeps the original dimensions.',
  exact: 'Stretches to exactly this size. Blank one side to derive it from the ratio.',
};

function syncUI() {
  const format = formatByMime(settings.format);
  const isAuto = settings.format === AUTO_MIME;
  const lossy = isAuto || Boolean(format?.lossy);
  const needsBackground = isAuto || !format?.alpha;

  el.qualityField.hidden = !lossy;
  el.backgroundField.hidden = !needsBackground;
  el.qualityValue.textContent = Number(settings.quality).toFixed(2);
  el.qualityLabel.textContent = settings.targetEnabled ? 'Maximum quality' : 'Quality';
  el.qualityHint.textContent = settings.targetEnabled
    ? 'The search never goes above this, and stops as soon as the file fits.'
    : 'Lower quality, smaller file.';
  el.scaleValue.textContent = `${settings.resize.scale}%`;
  el.formatHint.textContent = format?.blurb || '';
  el.targetRow.hidden = !settings.targetEnabled;
  el.resizeHint.textContent = RESIZE_HINTS[settings.resize.mode] || '';

  for (const field of document.querySelectorAll('.resize-opt')) {
    field.hidden = !field.dataset.modes.split(' ').includes(settings.resize.mode);
  }

  for (const button of el.presets.children) {
    button.setAttribute('aria-pressed', String(button.dataset.active === 'true'));
  }

  updateAdvice();
}

function commitSettings(next = readSettings()) {
  writeSettings(next);
  syncUI();
  saveSettings(settings);
}

/** Any manual change drops the "this preset is active" highlight. */
function clearPresetHighlight() {
  for (const button of el.presets.children) button.dataset.active = 'false';
}

async function populateFormats() {
  const available = await supportedFormats();

  const auto = new Option(AUTO_FORMAT.label, AUTO_MIME);
  const group = document.createElement('optgroup');
  group.label = 'Formats';
  for (const format of available) group.append(new Option(format.label, format.mime));

  el.format.replaceChildren(auto, group);

  const missing = FORMATS.filter((format) => !available.includes(format));
  if (missing.length) {
    const note = document.createElement('optgroup');
    note.label = `Unavailable here: ${missing.map((format) => format.label).join(', ')}`;
    note.disabled = true;
    el.format.append(note);
  }

  // Keep the stored choice when the browser still supports it.
  const stored = settings.format;
  const usable = stored === AUTO_MIME || available.some((format) => format.mime === stored);
  settings.format = usable ? stored : (available[0]?.mime ?? 'image/png');
}

function buildPresets() {
  el.presets.replaceChildren(
    ...PRESETS.map((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.dataset.id = preset.id;
      button.dataset.active = 'false';
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = '<strong></strong><span></span>';
      button.firstChild.textContent = preset.label;
      button.lastChild.textContent = preset.summary;
      button.addEventListener('click', () => {
        clearPresetHighlight();
        button.dataset.active = 'true';
        commitSettings(applyPreset(readSettings(), preset.settings));
        setStatus(`Preset applied: ${preset.label}.`);
      });
      return button;
    }),
  );
}

/* ══ Items ═════════════════════════════════════════════════════ */

function refreshControls() {
  const hasItems = items.length > 0;
  const hasResults = items.some((item) => item.result);

  el.convert.disabled = busy || !hasItems;
  el.convert.hidden = busy;
  el.cancel.hidden = !busy;
  el.downloadAll.disabled = busy || !hasResults;
  el.clear.disabled = busy || !hasItems;
  el.resultsPanel.hidden = !hasItems;
  el.count.textContent = hasItems ? `(${items.length})` : '';
  el.fileInput.disabled = busy;

  updateSavings();
  updateAdvice();
}

/** Warn when the current settings would only re-save the files unchanged. */
function updateAdvice() {
  const pointless = items.length > 0
    && items.every((item) => isPassthrough(settings, item.file.type));

  el.advice.hidden = !pointless;
  el.advice.textContent = pointless
    ? 'These settings would re-encode without changing format, size or orientation.'
    : '';
}

function updateSavings() {
  const done = items.filter((item) => item.result);
  if (!done.length) {
    el.savings.hidden = true;
    return;
  }

  const before = done.reduce((sum, item) => sum + item.file.size, 0);
  const after = done.reduce((sum, item) => sum + item.result.blob.size, 0);
  const delta = sizeDelta(before, after);

  el.savings.hidden = false;
  el.savings.style.color = delta.direction === 'up' ? 'var(--danger)' : 'var(--ok)';
  el.savings.textContent = `${formatBytes(before)} → ${formatBytes(after)} (${delta.label})`;
}

function setItemState(item, state) {
  item.state = state;
  item.node.dataset.state = state;
}

function renderItem(item) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  const name = node.querySelector('.card-name');
  name.textContent = item.file.name;
  name.title = item.file.name;

  const thumb = node.querySelector('.thumb');
  thumb.disabled = true;

  const img = thumb.querySelector('img');
  img.src = item.previewUrl;
  img.alt = `Preview of ${item.file.name}`;
  img.addEventListener('load', () => {
    item.sourceWidth = img.naturalWidth;
    item.sourceHeight = img.naturalHeight;
    if (!item.result) {
      node.querySelector('.original').textContent =
        `${img.naturalWidth} × ${img.naturalHeight} · ${formatBytes(item.file.size)}`;
    }
  }, { once: true });
  img.addEventListener('error', () => {
    // Only the preview is in question here — the listener stays attached when
    // the src is later swapped for the converted image, and hiding a finished
    // result would be wrong.
    if (item.result) return;
    // An undecodable file has no preview to show; the empty checkerboard reads
    // better than a broken-image glyph and its alt text.
    img.hidden = true;
    node.querySelector('.original').textContent = formatBytes(item.file.size);
  });

  node.querySelector('.original').textContent = formatBytes(item.file.size);
  node.querySelector('.remove').addEventListener('click', () => removeItem(item.id));
  thumb.addEventListener('click', () => openCompare(item));

  item.node = node;
  el.results.append(node);
}

function updateItem(item) {
  const node = item.node;
  const errorEl = node.querySelector('.card-error');
  const noteEl = node.querySelector('.card-note');
  const link = node.querySelector('.download');
  const converted = node.querySelector('.converted');
  const thumb = node.querySelector('.thumb');

  if (item.error) {
    setItemState(item, 'error');
    errorEl.hidden = false;
    errorEl.textContent = item.error;
    noteEl.hidden = true;
    link.hidden = true;
    converted.textContent = '';
    return;
  }

  if (!item.result) return;

  setItemState(item, 'done');
  errorEl.hidden = true;
  thumb.disabled = false;

  const result = item.result;
  node.querySelector('.thumb img').src = result.url;
  node.querySelector('.original').textContent =
    `${result.sourceWidth} × ${result.sourceHeight} · ${formatBytes(item.file.size)}`;

  const delta = sizeDelta(item.file.size, result.blob.size);
  converted.replaceChildren(
    document.createTextNode(
      `${result.width} × ${result.height} · ${result.formatLabel} · ${formatBytes(result.blob.size)}`,
    ),
  );
  const badge = document.createElement('span');
  badge.className = `delta ${delta.direction}`;
  badge.textContent = delta.label;
  converted.append(badge);

  const notes = [];
  if (result.withinBudget === false) notes.push('Could not reach the target size.');
  if (result.rescaled) notes.push('Scaled down further to fit the size budget.');
  if (result.clamped) notes.push('Reduced to stay within this browser’s canvas limit.');
  noteEl.hidden = !notes.length;
  noteEl.textContent = notes.join(' ');

  link.hidden = false;
  link.href = result.url;
  link.download = result.name;
  link.setAttribute('aria-label', `Download ${result.name}`);
}

function addFiles(files) {
  const { accepted, rejected, duplicates } = filterImages(files, seenFiles);

  if (!accepted.length) {
    const reason = duplicates
      ? `Already added ${plural(duplicates, 'file')}.`
      : 'No image files in that selection.';
    setStatus(reason, duplicates ? '' : 'error');
    return;
  }

  const room = Math.max(0, MAX_FILES - items.length);
  const taken = accepted.slice(0, room);

  for (const file of taken) {
    const item = {
      id: nextId++,
      file,
      previewUrl: URL.createObjectURL(file),
      node: null,
      state: 'pending',
      result: null,
      error: null,
    };
    items.push(item);
    renderItem(item);
  }

  const notes = [];
  if (duplicates) notes.push(`${plural(duplicates, 'duplicate')} skipped`);
  if (rejected) notes.push(`${plural(rejected, 'non-image')} skipped`);
  if (accepted.length > taken.length) {
    notes.push(`${accepted.length - taken.length} over the ${MAX_FILES}-file limit`);
  }

  setStatus(
    `Added ${plural(taken.length, 'image')}${notes.length ? ` — ${notes.join(', ')}` : ''}.`,
    notes.length ? 'warn' : '',
  );
  refreshControls();
}

function releaseItem(item) {
  URL.revokeObjectURL(item.previewUrl);
  if (item.result) URL.revokeObjectURL(item.result.url);
  seenFiles.delete(`${item.file.name} ${item.file.size} ${item.file.lastModified || 0}`);
}

function removeItem(id) {
  if (busy) return;
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;

  const [item] = items.splice(index, 1);
  releaseItem(item);
  item.node.remove();
  refreshControls();
}

function clearAll() {
  if (busy) return;
  for (const item of items) releaseItem(item);
  items.length = 0;
  seenFiles.clear();
  el.results.replaceChildren();
  setProgress(0, 0);
  setStatus('');
  refreshControls();
}

/* ══ Conversion ════════════════════════════════════════════════ */

async function convertAll() {
  if (busy || !items.length) return;

  busy = true;
  runController = new AbortController();
  refreshControls();
  setProgress(0, items.length);

  const startedAt = performance.now();
  let finished = 0;

  for (const item of items) {
    item.error = null;
    setItemState(item, 'pending');
    item.node.querySelector('.card-error').hidden = true;
  }

  const summary = await runBatch({
    items,
    settings,
    pipeline,
    signal: runController.signal,
    onStart: (item) => setItemState(item, 'running'),
    onDone: (item, result) => {
      if (item.result) URL.revokeObjectURL(item.result.url);
      item.result = { ...result, url: URL.createObjectURL(result.blob) };
      item.error = null;
      updateItem(item);
      setProgress(++finished, items.length);
      updateSavings();
    },
    onError: (item, error) => {
      item.result = null;
      item.error = error?.message || 'Conversion failed';
      updateItem(item);
      setProgress(++finished, items.length);
    },
  });

  busy = false;
  runController = null;
  refreshControls();

  if (summary.cancelled) {
    // Anything caught mid-flight goes back to pending rather than spinning
    // forever, so a second Convert picks it up cleanly.
    for (const item of items) {
      if (item.state === 'running') setItemState(item, 'pending');
    }
    setProgress(0, 0);
    setStatus(`Cancelled after ${plural(summary.converted, 'image')}.`, 'warn');
    return;
  }

  if (!summary.converted) {
    setStatus(`Nothing converted — ${plural(summary.failed, 'image')} failed.`, 'error');
    return;
  }

  const seconds = (performance.now() - startedAt) / 1000;
  const delta = sizeDelta(summary.bytesIn, summary.bytesOut);
  const parts = [
    `Converted ${plural(summary.converted, 'image')} in ${seconds.toFixed(1)}s`,
    `${formatBytes(summary.bytesIn)} → ${formatBytes(summary.bytesOut)} (${delta.label})`,
  ];
  if (summary.failed) parts.push(`${plural(summary.failed, 'failure')}`);

  setStatus(`${parts.join(' · ')}.`, summary.failed ? 'warn' : 'done');
}

function cancelRun() {
  if (!busy) return;
  runController?.abort();
  pipeline.cancelAll();
  setStatus('Cancelling…', 'warn');
}

/* ══ Downloads ═════════════════════════════════════════════════ */

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Safari needs the URL to outlive the click by a comfortable margin.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function downloadAll() {
  const converted = items.filter((item) => item.result);
  if (!converted.length) return;

  if (converted.length === 1) {
    saveBlob(converted[0].result.blob, converted[0].result.name);
    setStatus(`Saved ${converted[0].result.name}.`, 'done');
    return;
  }

  busy = true;
  refreshControls();
  setStatus('Building archive…');
  setProgress(0, converted.length);

  try {
    const zip = await createZip(
      converted.map((item) => ({ name: item.result.name, blob: item.result.blob })),
      { onProgress: (done, total) => setProgress(done, total) },
    );
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(zip, `converted-images-${stamp}.zip`);
    setStatus(`Archive ready — ${plural(converted.length, 'image')}, ${formatBytes(zip.size)}.`, 'done');
  } catch (error) {
    setStatus(`Could not build the archive: ${error.message}`, 'error');
  } finally {
    busy = false;
    refreshControls();
  }
}

/* ══ Compare dialog ════════════════════════════════════════════ */

function setComparePosition(percent) {
  el.compareStage.style.setProperty('--pos', `${percent}%`);
}

function openCompare(item) {
  if (!item.result || typeof el.compare.showModal !== 'function') return;

  el.compareTitle.textContent = item.file.name;
  el.compareBefore.src = item.previewUrl;
  el.compareAfter.src = item.result.url;
  el.compareBeforeMeta.textContent =
    `Original · ${item.result.sourceWidth} × ${item.result.sourceHeight} · ${formatBytes(item.file.size)}`;
  el.compareAfterMeta.textContent =
    `${item.result.formatLabel} · ${item.result.width} × ${item.result.height} · ${formatBytes(item.result.blob.size)}`;

  el.compareRange.value = '50';
  setComparePosition(50);
  el.compare.showModal();
}

/* ══ Events ════════════════════════════════════════════════════ */

function bindIntake() {
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

  let dragDepth = 0;
  const showOverlay = (show) => {
    el.dropOverlay.hidden = !show;
    el.dropzone.classList.toggle('dragover', show);
  };

  // Counting enter/leave pairs is the only reliable way to know when a drag
  // has really left the window — children fire leave events constantly.
  window.addEventListener('dragenter', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    showOverlay(true);
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showOverlay(false);
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    showOverlay(false);
    if (busy) {
      setStatus('Finish or cancel the current run before adding more.', 'warn');
      return;
    }
    const files = await filesFromDataTransfer(event.dataTransfer);
    if (files.length) addFiles(files);
  });

  document.addEventListener('paste', (event) => {
    const files = event.clipboardData?.files;
    if (files?.length) {
      event.preventDefault();
      addFiles(files);
    }
  });
}

function bindSettings() {
  const inputs = [
    el.format, el.quality, el.targetEnabled, el.targetSize, el.resizeMode, el.scale,
    el.width, el.height, el.edge, el.position, el.noUpscale, el.background, el.template,
  ];

  for (const input of inputs) {
    input.addEventListener('input', () => {
      clearPresetHighlight();
      commitSettings();
    });
  }

  // Reformat the typed budget once the user is done with the field.
  el.targetSize.addEventListener('change', () => {
    const bytes = parseByteSize(el.targetSize.value);
    el.targetSize.value = bytes ? formatBytes(bytes) : '500 KB';
    commitSettings();
  });

  for (const button of document.querySelectorAll('[data-rotate]')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[data-rotate]')) {
        other.setAttribute('aria-checked', String(other === button));
      }
      clearPresetHighlight();
      commitSettings();
    });
  }

  for (const button of [el.flipH, el.flipV]) {
    button.addEventListener('click', () => {
      button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
      clearPresetHighlight();
      commitSettings();
    });
  }

  for (const button of document.querySelectorAll('.theme-toggle button')) {
    button.addEventListener('click', () => applyTheme(button.dataset.theme));
  }

  el.reset.addEventListener('click', () => {
    clearPresetHighlight();
    const fresh = defaultSettings();
    // Keep a format the browser can actually produce.
    if (![...el.format.options].some((option) => option.value === fresh.format)) {
      fresh.format = AUTO_MIME;
    }
    commitSettings(fresh);
    setStatus('Settings restored to defaults.');
  });
}

function bindActions() {
  el.convert.addEventListener('click', convertAll);
  el.cancel.addEventListener('click', cancelRun);
  el.downloadAll.addEventListener('click', downloadAll);
  el.clear.addEventListener('click', clearAll);

  el.compareRange.addEventListener('input', () => setComparePosition(el.compareRange.value));
  el.compareClose.addEventListener('click', () => el.compare.close());

  document.addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);

    if (modifier && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      el.fileInput.click();
    } else if (modifier && event.key === 'Enter') {
      event.preventDefault();
      convertAll();
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!el.downloadAll.disabled) downloadAll();
    } else if (event.key === 'Escape' && busy && !typing && !el.compare.open) {
      cancelRun();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (busy) event.preventDefault();
  });

  // Object URLs are per-document, but releasing them early keeps memory flat
  // during long sessions in a persistent tab.
  window.addEventListener('pagehide', () => {
    for (const item of items) releaseItem(item);
  });
}

/* ══ Progressive web app ═══════════════════════════════════════ */

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    el.install.hidden = false;
  });

  el.install.addEventListener('click', async () => {
    if (!installPrompt) return;
    el.install.hidden = true;
    installPrompt.prompt();
    installPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    el.install.hidden = true;
    installPrompt = null;
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* Offline support is a bonus, never a requirement. */
      });
    });
  }
}

/* ══ Start ═════════════════════════════════════════════════════ */

(async function init() {
  let storedTheme = 'auto';
  try {
    storedTheme = localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    /* Storage is off; auto it is. */
  }
  applyTheme(storedTheme);

  settings = loadSettings();
  buildPresets();

  pipeline = createPipeline();
  el.engine.textContent = pipeline.mode === 'worker'
    ? `Converting on ${plural(pipeline.concurrency, 'background thread')}.`
    : 'Converting on the main thread — this browser has no OffscreenCanvas.';

  // Everything above is synchronous, and the listeners go on before the format
  // probe is awaited: files dropped during those first few milliseconds are
  // picked up rather than silently lost.
  bindIntake();
  bindSettings();
  bindActions();
  writeSettings(settings);
  syncUI();
  refreshControls();

  // Probing the encoders costs four encodes, so it happens last. It can change
  // the chosen format, hence the second write.
  await populateFormats();
  writeSettings(settings);
  syncUI();

  document.documentElement.dataset.ready = 'true';
})();
