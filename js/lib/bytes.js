/**
 * Byte formatting and parsing.
 *
 * Sizes are reported in binary units (KiB shown as "KB", as every file manager
 * does) because that is what `Blob.size` comparisons feel like to a user.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Human-readable size. Keeps one decimal below 10 of a unit so "9.4 MB" and
 * "12 MB" both read cleanly, and never shows a fractional byte count.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';

  const sign = n < 0 ? '-' : '';
  let value = Math.abs(n);
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  if (unit === 0) return `${sign}${Math.round(value)} B`;
  return `${sign}${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

const SIZE_PATTERN = /^\s*([0-9]*\.?[0-9]+)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?\s*$/i;

const MULTIPLIER = {
  b: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
};

/**
 * Parse a size the user typed: "500", "500kb", "1.5 MB", "2m".
 * A bare number is read as kilobytes, which is the unit people mean when they
 * say "keep it under 200".
 *
 * @param {string|number} input
 * @param {string} [defaultUnit] unit assumed when the input has none
 * @returns {number} bytes, or 0 when the input is not a usable size
 */
export function parseByteSize(input, defaultUnit = 'kb') {
  if (typeof input === 'number') return input > 0 ? Math.round(input) : 0;

  const match = SIZE_PATTERN.exec(String(input ?? ''));
  if (!match) return 0;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const unit = (match[2] || defaultUnit).toLowerCase();
  return Math.round(amount * (MULTIPLIER[unit] ?? 1024));
}

/**
 * Size change between two byte counts, ready to render.
 *
 * @param {number} before
 * @param {number} after
 * @returns {{direction: 'down'|'up'|'same', percent: number, label: string}}
 */
export function sizeDelta(before, after) {
  if (!before || !Number.isFinite(before) || !Number.isFinite(after)) {
    return { direction: 'same', percent: 0, label: '±0%' };
  }

  const percent = Math.round(Math.abs(1 - after / before) * 100);
  if (percent === 0) return { direction: 'same', percent: 0, label: '±0%' };

  const direction = after < before ? 'down' : 'up';
  return { direction, percent, label: `${direction === 'down' ? '−' : '+'}${percent}%` };
}
