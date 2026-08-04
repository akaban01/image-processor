/**
 * Output filenames: templating, sanitising and collision handling.
 */

/** Tokens accepted in the filename template, for the UI hint and the docs. */
export const TOKENS = [
  { token: '{name}', description: 'original name without its extension' },
  { token: '{ext}', description: 'new file extension' },
  { token: '{w}', description: 'output width in pixels' },
  { token: '{h}', description: 'output height in pixels' },
  { token: '{format}', description: 'format label, e.g. WebP' },
  { token: '{index}', description: 'position in the batch, starting at 1' },
  { token: '{date}', description: "today's date as YYYY-MM-DD" },
];

export const DEFAULT_TEMPLATE = '{name}.{ext}';

/** Everything before the final dot; a leading dot is part of the name. */
export function baseName(filename) {
  const dot = String(filename).lastIndexOf('.');
  return dot > 0 ? String(filename).slice(0, dot) : String(filename);
}

/** Windows keeps a handful of device names reserved, extension or not. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Control characters and the characters Windows rejects in a filename. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f<>:"|?*]/g;

/**
 * Make a string safe to hand to a download attribute or a ZIP entry.
 *
 * Path traversal is defused by splitting on separators and dropping the `.`
 * and `..` segments outright rather than substituting characters: flattening
 * `../../etc/passwd` to `etc_passwd` keeps something recognisable while making
 * it impossible for the name to climb out of an extraction directory.
 *
 * @param {string} name
 * @returns {string} always non-empty, never containing a path separator
 */
export function sanitizeFilename(name) {
  let safe = String(name ?? '')
    .split(/[/\\]+/)
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('_')
    .replace(ILLEGAL, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  if (RESERVED.test(baseName(safe))) safe = `_${safe}`;

  // Most filesystems cap a single component at 255 bytes; keep the extension.
  if (safe.length > 200) {
    const dot = safe.lastIndexOf('.');
    const ext = dot > 0 ? safe.slice(dot) : '';
    safe = safe.slice(0, 200 - ext.length) + ext;
  }

  return safe || 'image';
}

/**
 * Render a filename template.
 *
 * Unknown tokens are left alone rather than blanked, so a typo is visible in
 * the result instead of silently swallowing part of the name.
 *
 * @param {string} template
 * @param {object} context
 * @param {string} context.name original filename (extension included or not)
 * @param {string} context.ext output extension, without the dot
 * @param {number} [context.width]
 * @param {number} [context.height]
 * @param {string} [context.format] format label
 * @param {number} [context.index] 1-based position in the batch
 * @param {Date} [context.date]
 * @returns {string}
 */
export function applyTemplate(template, context) {
  const date = context.date instanceof Date ? context.date : new Date();
  const values = {
    name: baseName(context.name || 'image'),
    ext: context.ext || 'img',
    w: String(context.width ?? ''),
    h: String(context.height ?? ''),
    format: context.format || '',
    index: String(context.index ?? 1),
    date: date.toISOString().slice(0, 10),
  };

  const rendered = String(template || DEFAULT_TEMPLATE).replace(
    /\{(\w+)\}/g,
    (whole, key) => (key in values ? values[key] : whole),
  );

  const withExtension = rendered.toLowerCase().endsWith(`.${values.ext.toLowerCase()}`)
    ? rendered
    : `${rendered}.${values.ext}`;

  return sanitizeFilename(withExtension);
}

/**
 * Ensure a name has not been used yet, suffixing `-2`, `-3`, … before the
 * extension when it has. Mutates `used` so it can be threaded through a batch.
 *
 * @param {string} name
 * @param {Set<string>} used lower-cased names already taken
 * @returns {string}
 */
export function uniqueName(name, used) {
  const key = name.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}
