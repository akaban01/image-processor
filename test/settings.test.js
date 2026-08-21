import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  applyPreset,
  defaultSettings,
  isPassthrough,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from '../js/lib/settings.js';

/** Enough of the Storage interface for the round-trip tests. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() {
      return map.size;
    },
  };
}

test('defaults are independent copies', () => {
  const a = defaultSettings();
  const b = defaultSettings();
  a.resize.width = 1;
  assert.notEqual(b.resize.width, 1);
});

test('normalizeSettings survives junk without throwing', () => {
  for (const junk of [null, undefined, 0, 'nope', [], { resize: 'no' }]) {
    const result = normalizeSettings(junk);
    assert.deepEqual(result, defaultSettings(), `junk input: ${JSON.stringify(junk)}`);
  }
});

test('normalizeSettings clamps out-of-range numbers', () => {
  const settings = normalizeSettings({
    quality: 99,
    resize: { scale: -5, width: 1e9, height: -1, edge: 0 },
  });

  assert.equal(settings.quality, 1);
  assert.equal(settings.resize.scale, 1, 'a negative scale clamps to the minimum');
  assert.equal(settings.resize.width, 16384);
  assert.equal(settings.resize.height, 0);
});

test('normalizeSettings falls back rather than clamping when a number is not a number', () => {
  const settings = normalizeSettings({ quality: 'loads', resize: { scale: null, width: {} } });

  assert.equal(settings.quality, defaultSettings().quality);
  assert.equal(settings.resize.scale, defaultSettings().resize.scale);
  assert.equal(settings.resize.width, defaultSettings().resize.width);
});

test('normalizeSettings rejects unknown enum values', () => {
  const settings = normalizeSettings({
    rotate: 47,
    resize: { mode: 'squish', position: 'nowhere' },
  });

  assert.equal(settings.resize.mode, 'none');
  assert.equal(settings.resize.position, 'center');
  assert.equal(settings.rotate, 0);
});

test('normalizeSettings only accepts a known photo standard', () => {
  assert.equal(normalizeSettings({ documentId: 'umrah-hajj-evisa' }).documentId, 'umrah-hajj-evisa');
  assert.equal(normalizeSettings({ documentId: 'made-up' }).documentId, 'none');
  assert.equal(normalizeSettings({}).documentId, 'none');
});

test('normalizeSettings clamps the print resolution', () => {
  assert.equal(normalizeSettings({ dpi: 300 }).dpi, 300);
  assert.equal(normalizeSettings({ dpi: 1e6 }).dpi, 2400);
  assert.equal(normalizeSettings({ dpi: -300 }).dpi, 0);
  assert.equal(normalizeSettings({ dpi: 'print it big' }).dpi, 0);
});

test('normalizeSettings accepts a valid rotation', () => {
  assert.equal(normalizeSettings({ rotate: 270 }).rotate, 270);
  assert.equal(normalizeSettings({ rotate: '90' }).rotate, 90);
});

test('normalizeSettings only takes well-formed colours', () => {
  assert.equal(normalizeSettings({ background: '#123abc' }).background, '#123abc');
  assert.equal(normalizeSettings({ background: 'red' }).background, '#ffffff');
  assert.equal(normalizeSettings({ background: '#fff' }).background, '#ffffff');
});

test('normalizeSettings will not accept an empty filename template', () => {
  assert.equal(normalizeSettings({ template: '   ' }).template, '{name}.{ext}');
  assert.equal(normalizeSettings({ template: '  {name}-x.{ext} ' }).template, '{name}-x.{ext}');
});

test('normalizeSettings only takes a known base64 format', () => {
  assert.equal(normalizeSettings({ base64Format: 'markdown' }).base64Format, 'markdown');
  assert.equal(normalizeSettings({ base64Format: 'yaml' }).base64Format, 'data-url');
  assert.equal(normalizeSettings({}).base64Format, 'data-url');
});

test('normalizeSettings falls back field by field to the supplied base', () => {
  const base = { ...defaultSettings(), quality: 0.4, format: 'image/png' };
  const settings = normalizeSettings({ quality: 'bogus' }, base);

  assert.equal(settings.quality, 0.4);
  assert.equal(settings.format, 'image/png');
});

test('every preset produces valid settings', () => {
  for (const preset of PRESETS) {
    const settings = applyPreset(defaultSettings(), preset.settings);
    assert.deepEqual(settings, normalizeSettings(settings), `${preset.id} is stable`);
    assert.ok(settings.format, `${preset.id} sets a format`);
  }
});

test('applyPreset merges resize fields instead of replacing the object', () => {
  const current = { ...defaultSettings(), resize: { ...defaultSettings().resize, position: 'top' } };
  const settings = applyPreset(current, { resize: { mode: 'cover', width: 400, height: 400 } });

  assert.equal(settings.resize.mode, 'cover');
  assert.equal(settings.resize.width, 400);
  assert.equal(settings.resize.position, 'top', 'untouched fields survive');
});

test('the email preset targets a real byte budget', () => {
  const preset = PRESETS.find((entry) => entry.id === 'email');
  const settings = applyPreset(defaultSettings(), preset.settings);

  assert.equal(settings.targetEnabled, true);
  assert.equal(settings.targetBytes, 500 * 1024);
});

test('isPassthrough spots a conversion that would change nothing', () => {
  const settings = { ...defaultSettings(), format: 'image/png' };
  assert.equal(isPassthrough(settings, 'image/png'), true);
  assert.equal(isPassthrough(settings, 'image/jpeg'), false);
  assert.equal(isPassthrough({ ...settings, rotate: 90 }, 'image/png'), false);
  assert.equal(isPassthrough({ ...settings, targetEnabled: true }, 'image/png'), false);
  assert.equal(
    isPassthrough({ ...settings, resize: { ...settings.resize, mode: 'fit' } }, 'image/png'),
    false,
  );
});

test('settings round-trip through storage', () => {
  const storage = memoryStorage();
  const settings = { ...defaultSettings(), quality: 0.42, format: 'image/avif' };

  saveSettings(settings, storage);
  assert.deepEqual(loadSettings(storage), settings);
});

test('loading returns defaults when storage is empty or corrupt', () => {
  assert.deepEqual(loadSettings(memoryStorage()), defaultSettings());
  assert.deepEqual(
    loadSettings(memoryStorage({ 'image-converter:settings:v2': '{not json' })),
    defaultSettings(),
  );
});

test('storage failures never escape', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
  };

  assert.doesNotThrow(() => saveSettings(defaultSettings(), hostile));
  assert.deepEqual(loadSettings(hostile), defaultSettings());
  assert.doesNotThrow(() => saveSettings(defaultSettings(), undefined));
  assert.deepEqual(loadSettings(undefined), defaultSettings());
});
