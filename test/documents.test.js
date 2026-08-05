import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMON_RULES,
  NO_STANDARD,
  PHOTO_STANDARDS,
  STANDARD_IDS,
  checkPhoto,
  matchesStandard,
  standardById,
  standardSettings,
} from '../js/lib/documents.js';
import { applyStandard, defaultSettings, normalizeSettings } from '../js/lib/settings.js';

const umrah = standardById('umrah-hajj-evisa');

test('the Umrah / Hajj eVisa standard carries the published numbers', () => {
  assert.equal(umrah.width, 600);
  assert.equal(umrah.height, 600);
  assert.equal(umrah.mime, 'image/jpeg');
  assert.equal(umrah.maxBytes, 200 * 1024);
  assert.equal(umrah.background, '#ffffff');
});

test('standard ids are unique and include the off switch', () => {
  assert.equal(new Set(STANDARD_IDS).size, STANDARD_IDS.length);
  assert.equal(STANDARD_IDS[0], NO_STANDARD);
  assert.equal(STANDARD_IDS.length, PHOTO_STANDARDS.length + 1);
});

test('unknown ids resolve to no standard at all', () => {
  assert.equal(standardById(NO_STANDARD), null);
  assert.equal(standardById('passport-of-narnia'), null);
  assert.equal(standardById(undefined), null);
});

test('every standard is fully described', () => {
  for (const standard of PHOTO_STANDARDS) {
    assert.ok(standard.label && standard.short && standard.summary, `${standard.id} reads well`);
    assert.ok(standard.width > 0 && standard.height > 0, `${standard.id} has dimensions`);
    assert.ok(standard.requirements.length, `${standard.id} says what it sets`);
    assert.ok(standard.rules.length, `${standard.id} says what to check by hand`);
    assert.ok(standard.quality > 0 && standard.quality <= 1, `${standard.id} has a quality`);
  }
});

test('applying a standard produces settings that satisfy it', () => {
  for (const standard of PHOTO_STANDARDS) {
    const settings = applyStandard(defaultSettings(), standard);

    assert.equal(settings.documentId, standard.id);
    assert.ok(matchesStandard(settings, standard), `${standard.id} matches after applying`);
    assert.deepEqual(settings, normalizeSettings(settings), `${standard.id} is stable`);
    assert.equal(settings.resize.mode, 'cover');
    assert.equal(settings.resize.noUpscale, false, 'a small photo must be allowed to grow');
  }
});

test('the eVisa standard turns on a 200 KB budget; the print ones do not', () => {
  const evisa = applyStandard(defaultSettings(), umrah);
  assert.equal(evisa.targetEnabled, true);
  assert.equal(evisa.targetBytes, 200 * 1024);
  assert.equal(evisa.dpi, 0, 'a screen upload needs no print resolution');

  const print = applyStandard(defaultSettings(), standardById('umrah-hajj-print'));
  assert.equal(print.targetEnabled, false);
  assert.equal(print.dpi, 300);
});

test('clearing the standard keeps the pixels but drops the marker', () => {
  const applied = applyStandard(defaultSettings(), standardById('umrah-hajj-print'));
  const cleared = applyStandard(applied, null);

  assert.equal(cleared.documentId, NO_STANDARD);
  assert.equal(cleared.dpi, 0);
  assert.equal(cleared.resize.width, 600, 'the size the user can now edit is still there');
  assert.deepEqual(standardSettings(null), { documentId: NO_STANDARD, dpi: 0 });
});

test('rotation and flips survive applying a standard', () => {
  const crooked = { ...defaultSettings(), rotate: 90, flipH: true };
  const settings = applyStandard(crooked, umrah);

  assert.equal(settings.rotate, 90);
  assert.equal(settings.flipH, true);
});

test('editing away from the standard is noticed', () => {
  const settings = applyStandard(defaultSettings(), umrah);

  assert.equal(matchesStandard({ ...settings, format: 'image/png' }, umrah), false);
  assert.equal(matchesStandard({ ...settings, background: '#00ff00' }, umrah), false);
  assert.equal(matchesStandard({ ...settings, targetEnabled: false }, umrah), false);
  assert.equal(
    matchesStandard({ ...settings, resize: { ...settings.resize, width: 400 } }, umrah),
    false,
  );
});

test('moving the crop anchor is not a departure from the standard', () => {
  const settings = applyStandard(defaultSettings(), umrah);
  const nudged = { ...settings, resize: { ...settings.resize, position: 'top' } };

  assert.equal(matchesStandard(nudged, umrah), true);
});

test('anything matches when no standard is in force', () => {
  assert.equal(matchesStandard(defaultSettings(), null), true);
});

const ok = { mime: 'image/jpeg', width: 600, height: 600, bytes: 90 * 1024 };

test('a conforming file passes the check', () => {
  assert.deepEqual(checkPhoto(umrah, ok), { ok: true, issues: [] });
  assert.deepEqual(checkPhoto(null, { ...ok, width: 3 }), { ok: true, issues: [] });
});

test('the check reports each way a file misses the spec', () => {
  const wrongFormat = checkPhoto(umrah, { ...ok, mime: 'image/webp' });
  assert.equal(wrongFormat.ok, false);
  assert.match(wrongFormat.issues[0], /JPEG/);

  const wrongSize = checkPhoto(umrah, { ...ok, width: 400, height: 600 });
  assert.equal(wrongSize.ok, false);
  assert.match(wrongSize.issues[0], /400 × 600/);
  assert.match(wrongSize.issues[0], /600 × 600/);

  const tooBig = checkPhoto(umrah, { ...ok, bytes: 260 * 1024 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.issues[0], /over the 200 KB limit/);

  const hopeless = checkPhoto(umrah, { mime: 'image/png', width: 100, height: 100, bytes: 1e6 });
  assert.equal(hopeless.issues.length, 3);
});

test('a standard with no size limit never fails on file size', () => {
  const print = standardById('umrah-hajj-print');
  const check = checkPhoto(print, { mime: 'image/jpeg', width: 600, height: 600, bytes: 5e6 });

  assert.equal(check.ok, true);
});

test('the human rules are stated for every standard', () => {
  assert.ok(COMMON_RULES.some((rule) => /white/i.test(rule)));
  assert.ok(COMMON_RULES.some((rule) => /head/i.test(rule)));
});
