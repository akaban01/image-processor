import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FRAMING,
  centeredCrop,
  cropCoversStandard,
  framingFor,
  guideGeometry,
} from '../js/lib/framing.js';
import { PHOTO_STANDARDS, standardById } from '../js/lib/documents.js';

const square = standardById('umrah-hajj-evisa');
const tall = standardById('passport-35x45');

test('the default framing sits inside what the standards ask for', () => {
  // "Head fills roughly 70–80% of the frame height" — the drawn head is the
  // middle of that band, not an edge of it.
  assert.ok(DEFAULT_FRAMING.headHeight > DEFAULT_FRAMING.headMin);
  assert.ok(DEFAULT_FRAMING.headHeight < DEFAULT_FRAMING.headMax);
  assert.ok(DEFAULT_FRAMING.headTop + DEFAULT_FRAMING.headMax <= 1, 'the chin stays in frame');
});

test('a standard can override the framing it inherits', () => {
  assert.deepEqual(framingFor(null), DEFAULT_FRAMING);
  assert.equal(framingFor({ framing: { headTop: 0.2 } }).headTop, 0.2);
  assert.equal(framingFor({ framing: { headTop: 0.2 } }).headHeight, DEFAULT_FRAMING.headHeight);
});

test('the guide is drawn on the standard’s own pixel grid', () => {
  const g = guideGeometry(square);

  assert.equal(g.width, 600);
  assert.equal(g.height, 600);
  assert.equal(g.head.cx, 300, 'the head is centred horizontally');
  assert.equal(g.crown, 0.09 * 600);
  assert.equal(g.chin, (0.09 + 0.75) * 600);
  assert.equal(g.head.ry, (0.75 * 600) / 2);
  assert.equal(g.head.cy, g.crown + g.head.ry);
});

test('the head outline is taller than it is wide', () => {
  const g = guideGeometry(square);
  assert.ok(g.head.rx < g.head.ry);
});

test('the tolerance band brackets the drawn chin', () => {
  for (const standard of PHOTO_STANDARDS) {
    const g = guideGeometry(standard);
    assert.ok(g.chinMin < g.chin, `${standard.id}: the band opens above the chin`);
    assert.ok(g.chinMax > g.chin, `${standard.id}: the band closes below the chin`);
    assert.ok(g.chinMax <= g.height, `${standard.id}: the band stays in frame`);
  }
});

test('every guide line falls between the crown and the chin', () => {
  for (const standard of PHOTO_STANDARDS) {
    const g = guideGeometry(standard);
    assert.ok(g.eyeLine > g.crown && g.eyeLine < g.chin, `${standard.id}: eyes on the face`);
    assert.ok(g.crown > 0, `${standard.id}: space above the head`);
  }
});

test('a portrait standard puts the head lower down in absolute pixels', () => {
  const squareGuide = guideGeometry(square);
  const tallGuide = guideGeometry(tall);

  assert.equal(tallGuide.width, 413);
  assert.equal(tallGuide.height, 531);
  assert.ok(tallGuide.chin > squareGuide.chin * (531 / 600) - 1);
});

test('nonsense dimensions produce a guide rather than NaNs', () => {
  const g = guideGeometry({ width: 0, height: -5 });

  for (const value of [g.width, g.height, g.crown, g.chin, g.head.rx, g.head.ry]) {
    assert.ok(Number.isFinite(value), `${value} is a number`);
  }
});

test('a centred crop keeps the requested aspect ratio', () => {
  const crop = centeredCrop(1920, 1080, 1);

  assert.deepEqual(crop, { sx: 420, sy: 0, sw: 1080, sh: 1080 });
});

test('a centred crop takes the full frame when the ratio already matches', () => {
  assert.deepEqual(centeredCrop(600, 600, 1), { sx: 0, sy: 0, sw: 600, sh: 600 });
  assert.deepEqual(centeredCrop(1600, 900, 16 / 9), { sx: 0, sy: 0, sw: 1600, sh: 900 });
});

test('a centred crop trims the taller axis when the source is narrow', () => {
  const crop = centeredCrop(1080, 1920, 1);

  assert.equal(crop.sw, 1080);
  assert.equal(crop.sh, 1080);
  assert.equal(crop.sx, 0);
  assert.equal(crop.sy, 420, 'the same margin is left top and bottom');
});

test('a centred crop matches a portrait standard', () => {
  const crop = centeredCrop(1920, 1080, tall.width / tall.height);

  assert.equal(crop.sh, 1080, 'height is what runs out first');
  assert.equal(crop.sw, Math.round(1080 * (413 / 531)));
  assert.equal(crop.sx, Math.round((1920 - crop.sw) / 2));
});

test('a centred crop never invents pixels the source does not have', () => {
  for (const [w, h, aspect] of [[640, 480, 1], [1, 1, 1], [320, 240, 3 / 4], [200, 900, 2]]) {
    const crop = centeredCrop(w, h, aspect);
    assert.ok(crop.sw <= w && crop.sh <= h, `${w}×${h} @ ${aspect}`);
    assert.ok(crop.sx >= 0 && crop.sy >= 0);
    assert.ok(crop.sx + crop.sw <= w && crop.sy + crop.sh <= h, 'stays inside the frame');
  }
});

test('a centred crop survives a camera that reports nothing useful', () => {
  assert.deepEqual(centeredCrop(0, 0, 1), { sx: 0, sy: 0, sw: 0, sh: 0 });
  assert.deepEqual(centeredCrop(640, 480, 0), { sx: 0, sy: 0, sw: 640, sh: 480 });
  assert.deepEqual(centeredCrop(640, 480, NaN), { sx: 0, sy: 0, sw: 640, sh: 480 });
});

test('the resolution check is about pixels, not aspect', () => {
  assert.equal(cropCoversStandard(centeredCrop(1920, 1080, 1), square), true, '1080 ≥ 600');
  assert.equal(cropCoversStandard(centeredCrop(640, 480, 1), square), false, '480 < 600');
  assert.equal(cropCoversStandard(centeredCrop(640, 480, 413 / 531), tall), false);
  assert.equal(cropCoversStandard(centeredCrop(1280, 720, 413 / 531), tall), true);
});
