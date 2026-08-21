/**
 * UI controller: intake, settings binding, the batch run, and downloads.
 *
 * All the interesting logic lives in `js/lib/`; this file is deliberately the
 * only place that knows about the DOM.
 */

import { AUTO_FORMAT, AUTO_MIME, FORMATS, formatByMime, supportedFormats } from './lib/formats.js';
import { formatBytes, parseByteSize, sizeDelta } from './lib/bytes.js';
import {
  BASE64_FORMATS,
  base64FormatById,
  base64Length,
  base64Snippet,
  blobToBase64,
  snippetFilename,
} from './lib/base64.js';
import { MIN_SEARCH_QUALITY } from './lib/encode.js';
import { createZip } from './lib/zip.js';
import { createPipeline } from './lib/pipeline.js';
import { runBatch } from './lib/batch.js';
import { filesFromDataTransfer, filterImages } from './lib/intake.js';
import {
  PRESETS,
  THEMES,
  applyPreset,
  applyStandard,
  defaultSettings,
  isPassthrough,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './lib/settings.js';
import {
  COMMON_RULES,
  NO_STANDARD,
  PHOTO_STANDARDS,
  checkPhoto,
  matchesStandard,
  standardById,
} from './lib/documents.js';
import { centeredCrop, cropCoversStandard, guideGeometry } from './lib/framing.js';
import { backgroundWeights, paintBackground, parseHexColour } from './lib/matte.js';
import { createSegmenter } from './lib/segmenter.js';
import { maskCoverage } from './lib/tensor.js';

const $ = (id) => document.getElementById(id);

const el = {
  dropzone: $('dropzone'),
  dropOverlay: $('drop-overlay'),
  fileInput: $('file-input'),
  presets: $('presets'),
  documentStandard: $('document-standard'),
  documentHint: $('document-hint'),
  documentReapply: $('document-reapply'),
  documentAppliedField: $('document-applied-field'),
  documentApplied: $('document-applied'),
  documentRulesField: $('document-rules-field'),
  documentRules: $('document-rules'),
  documentDrift: $('document-drift'),
  documentCaveat: $('document-caveat'),
  backgroundRemoval: $('background-removal'),
  removeBackground: $('remove-background'),
  toleranceRow: $('tolerance-row'),
  backgroundTolerance: $('background-tolerance'),
  toleranceValue: $('tolerance-value'),
  toleranceHint: $('tolerance-hint'),
  cameraOpen: $('camera-open'),
  camera: $('camera'),
  cameraTitle: $('camera-title'),
  cameraHelp: $('camera-help'),
  cameraStage: $('camera-stage'),
  cameraVideo: $('camera-video'),
  cameraStill: $('camera-still'),
  cameraGuide: $('camera-guide'),
  cameraError: $('camera-error'),
  cameraNote: $('camera-note'),
  cameraDeviceField: $('camera-device-field'),
  cameraDevice: $('camera-device'),
  cameraShoot: $('camera-shoot'),
  cameraRetake: $('camera-retake'),
  cameraUse: $('camera-use'),
  cameraClose: $('camera-close'),
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
  base64: $('base64'),
  base64Title: $('base64-title'),
  base64Format: $('base64-format'),
  base64Summary: $('base64-summary'),
  base64Text: $('base64-text'),
  base64Note: $('base64-note'),
  base64Meta: $('base64-meta'),
  base64Copy: $('base64-copy'),
  base64Save: $('base64-save'),
  base64Close: $('base64-close'),
  base64Status: $('base64-status'),
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
let segmenter = null;
/** null until the model has been tried: true it works, false use the flood fill. */
let modelUsable = null;

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
    base64Format: el.base64Format.value,
    documentId: el.documentStandard.value,
    // Set by the chosen standard rather than by a control of its own.
    dpi: settings.dpi,
    removeBackground: el.removeBackground.checked,
    backgroundTolerance: Number(el.backgroundTolerance.value),
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
  el.base64Format.value = next.base64Format;
  el.documentStandard.value = next.documentId;
  el.removeBackground.checked = next.removeBackground;
  el.backgroundTolerance.value = String(next.backgroundTolerance);

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
  el.qualityLabel.textContent = settings.targetEnabled ? 'Quality ceiling' : 'Quality';
  // With a budget in play this slider is a limit, not the quality that gets
  // used — and lowering it does nothing at all once the search has bottomed
  // out, which reads as a broken control unless the hint says so outright.
  el.qualityHint.textContent = settings.targetEnabled
    ? `A limit, not the quality used: the search starts here and works down to `
      + `${MIN_SEARCH_QUALITY.toFixed(2)}, then shrinks the image. Lowering it will not `
      + 'shrink a file that already misses the target.'
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

  syncDocumentPanel();
  for (const item of items) renderCheck(item);
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
        // A preset rewrites format and size, so whatever document standard was
        // in force is no longer the one being produced.
        commitSettings(applyStandard(applyPreset(readSettings(), preset.settings), null));
        setStatus(`Preset applied: ${preset.label}.`);
      });
      return button;
    }),
  );
}

/* ══ Document photo standards ══════════════════════════════════ */

function buildStandards() {
  el.documentStandard.replaceChildren(
    new Option('None — my own settings', NO_STANDARD),
    ...PHOTO_STANDARDS.map((standard) => new Option(standard.label, standard.id)),
  );
}

function buildBase64Formats() {
  el.base64Format.replaceChildren(
    ...BASE64_FORMATS.map((format) => new Option(format.label, format.id)),
  );
}

function fillList(list, entries) {
  list.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement('li');
      item.textContent = entry;
      return item;
    }),
  );
}

/** Switch standards, or switch back to hand-picked settings. */
function chooseStandard(id) {
  const standard = standardById(id);
  clearPresetHighlight();
  commitSettings(applyStandard(readSettings(), standard));
  setStatus(
    standard
      ? `Photo standard applied: ${standard.label}.`
      : 'Photo standard cleared — the settings are yours again.',
  );
}

const DEFAULT_DOC_HINT =
  'Pick a standard to size, crop and compress every photo to that document’s rules.';

function syncDocumentPanel() {
  const standard = standardById(settings.documentId);

  el.documentHint.textContent = standard ? standard.summary : DEFAULT_DOC_HINT;
  el.documentAppliedField.hidden = !standard;
  el.documentRulesField.hidden = !standard;
  el.documentCaveat.hidden = !standard;
  el.cameraOpen.hidden = !standard || !cameraSupported();
  el.backgroundRemoval.hidden = !standard;
  // Tolerance is the flood fill's only knob, and the flood fill only runs when
  // the model cannot. Showing the slider before then would be offering a
  // control over something that is not happening.
  el.toleranceRow.hidden = !settings.removeBackground || modelUsable !== false;
  el.toleranceHint.hidden = el.toleranceRow.hidden;
  el.toleranceValue.textContent = String(settings.backgroundTolerance);

  // Dropping the standard while the viewfinder is open would leave a guide on
  // screen for a shape nothing is being cropped to.
  if (!standard && el.camera?.open) closeCamera();

  if (standard) {
    fillList(el.documentApplied, standard.requirements);
    fillList(el.documentRules, [...standard.rules, ...COMMON_RULES]);
  }

  // Manual edits are allowed to win — the panel says so instead of undoing them.
  const drifted = Boolean(standard) && !matchesStandard(settings, standard);
  el.documentDrift.hidden = !drifted;
  el.documentDrift.textContent = drifted
    ? 'The settings below no longer produce a photo that meets this standard.'
    : '';
  el.documentReapply.hidden = !drifted;
}

/** Annotate one result with how it measures up to the chosen standard. */
function renderCheck(item) {
  const checkEl = item.node?.querySelector('.card-check');
  if (!checkEl) return;

  const standard = standardById(settings.documentId);
  if (!standard || !item.result) {
    checkEl.hidden = true;
    checkEl.textContent = '';
    return;
  }

  const check = checkPhoto(standard, {
    mime: item.result.mime,
    width: item.result.width,
    height: item.result.height,
    bytes: item.result.blob.size,
  });

  checkEl.hidden = false;
  checkEl.dataset.ok = String(check.ok);
  checkEl.textContent = check.ok
    ? `Fits the ${standard.short} spec — now check the photo itself against the list above.`
    : `Does not meet the ${standard.short} spec: ${check.issues.join(' ')}`;
}

/* ══ Guided camera capture ═════════════════════════════════════ */

let cameraStream = null;
/** @type {{blob: Blob, url: string, crop: object}|null} */
let cameraShot = null;
/** Is the preview being shown back to front, the way a mirror would? */
let cameraMirrored = false;

const cameraSupported = () => Boolean(navigator.mediaDevices?.getUserMedia)
  && typeof el.camera?.showModal === 'function';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Draw the head outline over the preview.
 *
 * The SVG shares the standard's pixel grid, so every number comes straight
 * from `guideGeometry` with no scaling maths in the middle.
 */
function drawGuide(standard) {
  const g = guideGeometry(standard);
  const unit = g.height / 150;

  el.cameraGuide.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
  el.cameraStage.style.setProperty('--shot-aspect', `${g.width} / ${g.height}`);

  const label = (x, y, text, anchor = 'start') => {
    const node = svg('text', {
      x, y, class: 'guide-label', 'text-anchor': anchor, 'font-size': unit * 5,
    });
    node.textContent = text;
    return node;
  };

  el.cameraGuide.replaceChildren(
    // The band the chin has to land in for the head to be 70–80% of the frame.
    svg('rect', {
      x: 0, y: g.chinMin, width: g.width, height: g.chinMax - g.chinMin, class: 'guide-band',
    }),
    svg('line', {
      x1: 0, y1: g.chinMin, x2: g.width, y2: g.chinMin, class: 'guide-edge',
    }),
    svg('line', {
      x1: 0, y1: g.chinMax, x2: g.width, y2: g.chinMax, class: 'guide-edge',
    }),
    // Crown ticks rather than a full line: the top of the head is a point to
    // hit, not a horizon to sit on.
    svg('line', { x1: 0, y1: g.crown, x2: g.width * 0.14, y2: g.crown, class: 'guide-tick' }),
    svg('line', {
      x1: g.width * 0.86, y1: g.crown, x2: g.width, y2: g.crown, class: 'guide-tick',
    }),
    svg('line', { x1: 0, y1: g.eyeLine, x2: g.width, y2: g.eyeLine, class: 'guide-eyes' }),
    svg('ellipse', { cx: g.head.cx, cy: g.head.cy, rx: g.head.rx, ry: g.head.ry, class: 'guide-head' }),
    // Clear of the crown tick, which occupies the same corner.
    label(g.width * 0.16, g.crown - unit * 2, 'crown'),
    label(unit * 2, g.eyeLine - unit * 2, 'eyes'),
    label(unit * 2, g.chinMax + unit * 6, 'chin'),
  );
}

function setCameraError(message) {
  el.cameraError.hidden = !message;
  el.cameraError.textContent = message || '';
}

function setCameraNote(message) {
  el.cameraNote.hidden = !message;
  el.cameraNote.textContent = message || '';
}

/** Turn a getUserMedia rejection into something worth reading. */
function cameraMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was refused. Allow it in the browser’s address bar, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is already in use by another app.';
    default:
      return `The camera could not be started: ${error?.message || 'unknown error'}`;
  }
}

function stopStream() {
  for (const track of cameraStream?.getTracks() || []) track.stop();
  cameraStream = null;
  el.cameraVideo.srcObject = null;
}

/** Warn when the camera cannot fill the standard without being enlarged. */
function checkResolution(width, height) {
  const standard = standardById(settings.documentId);
  if (!standard || !width || !height) return;

  const crop = centeredCrop(width, height, standard.width / standard.height);
  setCameraNote(
    cropCoversStandard(crop, standard)
      ? ''
      : `This camera only offers ${crop.sw} × ${crop.sh} inside the frame, so the photo `
        + `will be enlarged to ${standard.width} × ${standard.height} and may look soft.`,
  );
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }

  // Labels stay empty until permission is granted, which is why this runs
  // after the stream is live rather than before.
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  el.cameraDeviceField.hidden = cameras.length < 2;
  if (cameras.length < 2) return;

  const active = cameraStream?.getVideoTracks()[0]?.getSettings?.().deviceId;
  el.cameraDevice.replaceChildren(
    ...cameras.map((device, index) => new Option(device.label || `Camera ${index + 1}`, device.deviceId)),
  );
  if (active) el.cameraDevice.value = active;
}

async function startStream(deviceId) {
  stopStream();
  setCameraError('');
  setCameraNote('');
  el.cameraShoot.disabled = true;

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        // A front camera at as many pixels as it will give: the frame gets
        // cropped to the standard's aspect, so height is what runs out first.
        : { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1920 } },
    });
  } catch (error) {
    setCameraError(cameraMessage(error));
    return;
  }

  el.cameraVideo.srcObject = cameraStream;
  try {
    await el.cameraVideo.play();
  } catch {
    /* Autoplay of a muted local stream is allowed; a refusal is not fatal. */
  }

  // A rear camera is pointed at the world, and the world does not need
  // mirroring. Anything else — a phone's front camera, or a laptop webcam,
  // which reports no facing mode at all — is pointed at the person looking.
  const facing = cameraStream.getVideoTracks()[0]?.getSettings?.().facingMode;
  cameraMirrored = facing !== 'environment';
  el.cameraVideo.classList.toggle('mirrored', cameraMirrored);
  setCameraHelp('live');

  el.cameraShoot.disabled = false;
  checkResolution(el.cameraVideo.videoWidth, el.cameraVideo.videoHeight);
  await listCameras();
}

/**
 * What to say under the viewfinder.
 *
 * A front camera preview is mirrored, because a preview that is not is
 * genuinely disorienting — lean right and the person on screen leans left.
 * The file is never mirrored: a document photo has to be a true likeness, and
 * a flipped one gets rejected. Both halves of that need saying, at the moment
 * each one matters.
 */
function setCameraHelp(view) {
  if (view === 'still') {
    el.cameraHelp.textContent = cameraMirrored
      ? 'This is the photo as it will be saved — not mirrored, unlike the preview. '
        + 'Check it reads the right way round before using it.'
      : 'This is the photo as it will be saved.';
    return;
  }

  el.cameraHelp.textContent =
    'Line the top of the head up with the side ticks and put the chin inside the shaded '
    + 'band. Face the camera square on, against a plain white wall, in even light.'
    + (cameraMirrored ? ' The preview is mirrored, like a mirror; the saved photo is not.' : '');
}

function showLiveView() {
  if (cameraShot) URL.revokeObjectURL(cameraShot.url);
  cameraShot = null;

  setCameraHelp('live');
  el.cameraStill.hidden = true;
  el.cameraStill.removeAttribute('src');
  el.cameraVideo.hidden = false;
  el.cameraShoot.hidden = false;
  el.cameraRetake.hidden = true;
  el.cameraUse.hidden = true;
}

async function openCamera() {
  const standard = standardById(settings.documentId);
  if (!standard || !cameraSupported()) return;

  el.cameraTitle.textContent = `Take a photo for ${standard.short}`;
  drawGuide(standard);
  showLiveView();
  setCameraError('');
  setCameraNote('');

  el.camera.showModal();
  await startStream();
}

function closeCamera() {
  // Synchronously, before the dialog is even dismissed: `dialog.close()` fires
  // its `close` event in a queued task, and "the camera light goes out when I
  // press Close" should not be waiting behind whatever else is on the queue.
  // The listener below still runs — `stopStream` is idempotent — because
  // Escape and the backdrop never come through here.
  stopStream();
  if (el.camera.open) el.camera.close();
}

/**
 * Freeze the frame that is on screen.
 *
 * The preview is `object-fit: cover` inside a box of the standard's aspect
 * ratio, so cutting the same centred rectangle out of the video is what makes
 * the file match what the person was looking at.
 */
function takeShot() {
  const standard = standardById(settings.documentId);
  const video = el.cameraVideo;
  if (!standard || !video.videoWidth || !video.videoHeight) return;

  const crop = centeredCrop(video.videoWidth, video.videoHeight, standard.width / standard.height);
  const canvas = document.createElement('canvas');
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  canvas.getContext('2d').drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);

  canvas.toBlob((blob) => {
    if (!blob) {
      setCameraError('The frame could not be captured. Try again.');
      return;
    }

    cameraShot = { blob, url: URL.createObjectURL(blob), crop };
    // `drawImage` reads the track, not the CSS, so the capture is already the
    // real way round — the still just has to be shown without the mirror.
    setCameraHelp('still');
    el.cameraStill.src = cameraShot.url;
    el.cameraStill.hidden = false;
    el.cameraVideo.hidden = true;
    el.cameraShoot.hidden = true;
    el.cameraRetake.hidden = false;
    el.cameraUse.hidden = false;
    // PNG keeps the capture lossless, so the only lossy step is the single
    // encode the conversion does afterwards.
  }, 'image/png');
}

/** Hand the capture to the normal pipeline and convert it straight away. */
function useShot() {
  if (!cameraShot) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = new File([cameraShot.blob], `photo-${stamp}.png`, {
    type: 'image/png',
    lastModified: Date.now(),
  });

  closeCamera();
  addFiles([file]);
  convertAll();
}

function bindCamera() {
  if (!cameraSupported()) return;

  el.cameraOpen.addEventListener('click', openCamera);
  el.cameraShoot.addEventListener('click', takeShot);
  el.cameraRetake.addEventListener('click', showLiveView);
  el.cameraUse.addEventListener('click', useShot);
  el.cameraClose.addEventListener('click', closeCamera);
  el.cameraDevice.addEventListener('change', () => startStream(el.cameraDevice.value));

  // Covers the close button, Escape, and anything else that dismisses the
  // dialog — the camera light must never outlive the window that opened it.
  el.camera.addEventListener('close', () => {
    stopStream();
    showLiveView();
  });

  el.cameraVideo.addEventListener('loadedmetadata', () => {
    checkResolution(el.cameraVideo.videoWidth, el.cameraVideo.videoHeight);
  });

  window.addEventListener('pagehide', stopStream);
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

/** Physical size of a stamped result, in millimetres. */
function printSize(result) {
  const mm = (pixels) => Math.round((pixels / result.dpi) * 25.4);
  return `${mm(result.width)} × ${mm(result.height)} mm`;
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
  node.querySelector('.base64').addEventListener('click', () => openBase64(item));
  thumb.addEventListener('click', () => openCompare(item));

  item.node = node;
  el.results.append(node);
}

function updateItem(item) {
  const node = item.node;
  const errorEl = node.querySelector('.card-error');
  const noteEl = node.querySelector('.card-note');
  const link = node.querySelector('.download');
  const base64Button = node.querySelector('.base64');
  const converted = node.querySelector('.converted');
  const thumb = node.querySelector('.thumb');

  if (item.error) {
    setItemState(item, 'error');
    errorEl.hidden = false;
    errorEl.textContent = item.error;
    noteEl.hidden = true;
    link.hidden = true;
    base64Button.hidden = true;
    converted.textContent = '';
    renderCheck(item);
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
  const line = [
    `${result.width} × ${result.height}`,
    result.formatLabel,
    formatBytes(result.blob.size),
  ];
  // A stamped density is the only thing that gives the pixels a physical size,
  // so it belongs next to them rather than in a footnote.
  if (result.dpi) line.push(`${printSize(result)} @ ${result.dpi} DPI`);
  converted.replaceChildren(document.createTextNode(line.join(' · ')));
  const badge = document.createElement('span');
  badge.className = `delta ${delta.direction}`;
  badge.textContent = delta.label;
  converted.append(badge);

  const notes = [];
  if (result.withinBudget === false) {
    notes.push(
      'Could not reach the target size, even at the lowest quality the search will use. '
      + 'Reduce the dimensions under Resize, or try WebP.',
    );
  }
  if (result.rescaled) notes.push('Scaled down further to fit the size budget.');
  if (result.clamped) notes.push('Reduced to stay within this browser’s canvas limit.');
  if (result.backgroundMethod === 'flood' && !result.backgroundPlausible) {
    // Either almost nothing was flooded or almost everything was: both mean
    // the picture was not a subject in front of a plain wall.
    notes.push(
      `The background could not be separated cleanly — ${Math.round(result.backgroundCoverage * 100)}% `
      + 'of the frame was repainted. Compare before and after before using this one.',
    );
  }
  noteEl.hidden = !notes.length;
  noteEl.textContent = notes.join(' ');

  renderCheck(item);

  link.hidden = false;
  link.href = result.url;
  link.download = result.name;
  link.setAttribute('aria-label', `Download ${result.name}`);

  base64Button.hidden = false;
  base64Button.setAttribute('aria-label', `Base64 text for ${result.name}`);
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
      // Filled in only when the background is being replaced: the model's
      // mask, and the matted bitmap handed to the pipeline for one run.
      mask: null,
      bitmap: null,
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
  item.mask = null;
  item.bitmap = null;
  URL.revokeObjectURL(item.previewUrl);
  if (item.result) URL.revokeObjectURL(item.result.url);
  seenFiles.delete(`${item.file.name} ${item.file.size} ${item.file.lastModified || 0}`);
}

function removeItem(id) {
  if (busy) return;
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;

  const [item] = items.splice(index, 1);
  closeBase64(item);
  releaseItem(item);
  item.node.remove();
  refreshControls();
}

function clearAll() {
  if (busy) return;
  closeBase64();
  for (const item of items) releaseItem(item);
  items.length = 0;
  seenFiles.clear();
  el.results.replaceChildren();
  setProgress(0, 0);
  setStatus('');
  refreshControls();
}

/* ══ Background matting ════════════════════════════════════════ */

const MODEL_SIZE = '25 MB';

function ensureSegmenter() {
  if (!segmenter) segmenter = createSegmenter();
  return segmenter;
}

/** Start the download when the box is ticked, rather than at Convert. */
async function warmSegmenter() {
  const client = ensureSegmenter();
  if (!client.supported) {
    modelUsable = false;
    syncUI();
    return;
  }

  setStatus(`Loading the background model — ${MODEL_SIZE}, once.`);
  try {
    await client.warmup();
    modelUsable = true;
    setStatus('Background model ready.');
  } catch {
    modelUsable = false;
    setStatus('The background model could not be loaded; using the simple matte.', 'warn');
  }
  syncUI();
}

/**
 * Replace one item's background, returning a bitmap for the pipeline to
 * convert in place of the file.
 *
 * The matte is applied here, at full source resolution, rather than inside the
 * conversion: the model sees the whole photo instead of a 600 px crop of it,
 * and the mask it produces is reusable — pressing Convert again re-composites
 * from the cached mask instead of paying for inference twice.
 */
async function matteItem(item) {
  const colour = parseHexColour(settings.background);
  if (!colour) return null;

  const source = await createImageBitmap(item.file, { imageOrientation: 'from-image' });

  try {
    if (!item.mask) {
      // The model consumes its input, so it gets the copy.
      item.mask = await ensureSegmenter().segment(await createImageBitmap(source));
    }

    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);

    paintBackground(image, backgroundWeights(scaleMask(item.mask, canvas.width, canvas.height)), colour);
    context.putImageData(image, 0, 0);

    return await createImageBitmap(canvas);
  } finally {
    source.close?.();
  }
}

/** Stretch the model's small square mask over the photo it came from. */
function scaleMask(mask, width, height) {
  const small = document.createElement('canvas');
  small.width = mask.width;
  small.height = mask.height;
  small.getContext('2d').putImageData(new ImageData(mask.data, mask.width, mask.height), 0, 0);

  const full = document.createElement('canvas');
  full.width = width;
  full.height = height;
  const context = full.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(small, 0, 0, width, height);

  return context.getImageData(0, 0, width, height);
}

/**
 * Matte every item before the batch runs.
 *
 * A failure here is never fatal: the item simply arrives at the pipeline
 * without a bitmap, and the flood fill takes over for that one image.
 *
 * @returns {Promise<{attempted: number, failed: number, poor: number}>}
 */
async function matteAll(signal) {
  const summary = { attempted: 0, failed: 0, poor: 0 };
  if (!settings.removeBackground || modelUsable === false) return summary;
  if (!ensureSegmenter().supported) {
    modelUsable = false;
    return summary;
  }

  for (const item of items) {
    if (signal?.aborted) break;
    summary.attempted++;
    setStatus(`Separating the subject — ${summary.attempted} of ${items.length}…`);

    try {
      item.bitmap = await matteItem(item);
      modelUsable = true;
      const coverage = maskCoverage(item.mask);
      // The same sanity check the flood fill applies: a mask that keeps almost
      // nothing found no one to keep.
      if (coverage < 0.05 || coverage > 0.98) summary.poor++;
    } catch {
      item.bitmap = null;
      item.mask = null;
      summary.failed++;
    }
  }

  // One failure is this photo's problem; every failure is the model's.
  if (summary.failed === summary.attempted && summary.attempted > 0) modelUsable = false;
  return summary;
}

/** Bitmaps are transferred to the worker, so nothing survives a run. */
function releaseBitmaps() {
  for (const item of items) item.bitmap = null;
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

  closeBase64();
  for (const item of items) {
    item.error = null;
    setItemState(item, 'pending');
    item.node.querySelector('.card-error').hidden = true;
  }

  const matte = await matteAll(runController.signal);
  if (matte.failed) {
    setStatus(
      matte.failed === matte.attempted
        ? 'The background model could not run; using the simple matte instead.'
        : `The background model could not run on ${plural(matte.failed, 'image')}.`,
      'warn',
    );
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

  releaseBitmaps();
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

/* ══ Base64 dialog ═════════════════════════════════════════════ */

/**
 * Beyond this many characters the textarea stops being a preview and starts
 * being a rendering job: a 6 MB single-token line makes the dialog crawl. Copy
 * and Save still use the whole string.
 */
const BASE64_PREVIEW = 200_000;

/** The item whose text is on screen, and the wrapped text itself. */
let base64Item = null;
let snippetText = '';

/**
 * The text on screen describes one particular result, so it stops being true
 * the moment that result is removed or reconverted.
 *
 * @param {Item} [item] close only if this item's text is showing
 */
function closeBase64(item) {
  if (el.base64.open && (!item || base64Item === item)) el.base64.close();
}

function setBase64Status(message, kind = '') {
  el.base64Status.textContent = message;
  el.base64Status.dataset.kind = kind;
}

function setBase64Busy(busyNow) {
  el.base64Copy.disabled = busyNow;
  el.base64Save.disabled = busyNow;
  el.base64Format.disabled = busyNow;
}

/** Re-wrap the already-encoded bytes; cheap enough to run on every change. */
function renderBase64() {
  const result = base64Item?.result;
  if (!result?.base64) return;

  const formatId = el.base64Format.value;
  snippetText = base64Snippet(formatId, {
    base64: result.base64,
    mime: result.mime,
    name: result.name,
    width: result.width,
    height: result.height,
  });

  const oversized = snippetText.length > BASE64_PREVIEW;
  el.base64Text.value = oversized
    ? `${snippetText.slice(0, BASE64_PREVIEW)}…`
    : snippetText;
  el.base64Note.hidden = !oversized;
  el.base64Note.textContent = oversized
    ? `Showing the first ${BASE64_PREVIEW.toLocaleString()} characters. Copy and `
      + 'Save use the whole thing.'
    : '';

  el.base64Summary.textContent = base64FormatById(formatId).summary;
  el.base64Meta.textContent =
    `${snippetText.length.toLocaleString()} characters · `
    + `${formatBytes(snippetText.length)} of text · `
    + `${formatBytes(result.blob.size)} as a file`;
  setBase64Busy(false);
}

async function openBase64(item) {
  if (!item.result || typeof el.base64.showModal !== 'function') return;

  base64Item = item;
  snippetText = '';
  el.base64Title.textContent = item.result.name;
  el.base64Note.hidden = true;
  setBase64Status('');
  el.base64.showModal();

  if (item.result.base64) {
    renderBase64();
    return;
  }

  // Encoding a large image takes a moment, and the dialog is already open.
  setBase64Busy(true);
  el.base64Text.value = '';
  el.base64Summary.textContent = base64FormatById(el.base64Format.value).summary;
  el.base64Meta.textContent =
    `About ${base64Length(item.result.blob.size).toLocaleString()} characters`;
  setBase64Status('Encoding…');

  const result = item.result;
  try {
    const encoded = await blobToBase64(result.blob);
    // A second conversion while this ran would have replaced the result the
    // text belongs to, so cache onto that object rather than the item.
    result.base64 = encoded;
    if (base64Item !== item || item.result !== result || !el.base64.open) return;
    setBase64Status('');
    renderBase64();
  } catch (error) {
    if (base64Item !== item || !el.base64.open) return;
    setBase64Busy(false);
    el.base64Copy.disabled = true;
    el.base64Save.disabled = true;
    setBase64Status(`Could not encode this image: ${error.message}`, 'error');
  }
}

async function copyBase64() {
  if (!snippetText) return;

  try {
    await navigator.clipboard.writeText(snippetText);
    setBase64Status(`Copied ${snippetText.length.toLocaleString()} characters.`, 'done');
  } catch {
    // Denied permission, or a page served over plain HTTP. Selecting the text
    // at least leaves the user one keystroke away — unless it was truncated,
    // in which case only saving gives them all of it.
    el.base64Text.focus();
    el.base64Text.select();
    setBase64Status(
      snippetText.length > BASE64_PREVIEW
        ? 'The clipboard is unavailable here, and the preview is shortened — use Save as text.'
        : 'The clipboard is unavailable here — the text is selected, press Ctrl/⌘ + C.',
      'warn',
    );
  }
}

function saveBase64() {
  if (!snippetText || !base64Item?.result) return;

  const name = snippetFilename(base64Item.result.name, el.base64Format.value);
  saveBlob(new Blob([snippetText], { type: 'text/plain;charset=utf-8' }), name);
  setBase64Status(`Saved ${name}.`, 'done');
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
    el.removeBackground, el.backgroundTolerance,
  ];

  for (const input of inputs) {
    input.addEventListener('input', () => {
      clearPresetHighlight();
      commitSettings();
    });
  }

  el.removeBackground.addEventListener('change', () => {
    if (el.removeBackground.checked && modelUsable === null) warmSegmenter();
  });

  // Not part of any preset — it changes the text on offer, never the image.
  el.base64Format.addEventListener('change', () => {
    commitSettings();
    setBase64Status('');
    renderBase64();
  });

  el.documentStandard.addEventListener('change', () => chooseStandard(el.documentStandard.value));
  el.documentReapply.addEventListener('click', () => chooseStandard(settings.documentId));

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

  el.base64Copy.addEventListener('click', copyBase64);
  el.base64Save.addEventListener('click', saveBase64);
  el.base64Close.addEventListener('click', () => el.base64.close());
  // Holding a multi-megabyte string open costs real memory once the dialog is
  // gone; the encoded bytes stay cached on the result for the next open.
  el.base64.addEventListener('close', () => {
    base64Item = null;
    snippetText = '';
    el.base64Text.value = '';
  });

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
    } else if (event.key === 'Escape' && busy && !typing && !el.compare.open && !el.camera.open
               && !el.base64.open) {
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
  buildStandards();
  buildBase64Formats();

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
  bindCamera();
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
