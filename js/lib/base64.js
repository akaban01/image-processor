/**
 * Base64 text output.
 *
 * Every format here is a data URL underneath — the differences are only in the
 * wrapping, so the expensive part (turning the blob into base64) happens once
 * and the snippets are cheap string joins over the result.
 */

import { baseName, sanitizeFilename } from './naming.js';

/**
 * The wrappings on offer. `extension` is what a saved text file gets, so a
 * pasted-out snippet lands in an editor with the right syntax highlighting.
 *
 * @typedef {object} Base64Format
 * @property {string} id
 * @property {string} label
 * @property {string} extension
 * @property {string} summary shown next to the picker
 */

/** @type {Base64Format[]} */
export const BASE64_FORMATS = [
  {
    id: 'data-url',
    label: 'Data URL',
    extension: 'txt',
    summary: 'data:image/webp;base64,… — ready for a src or a fetch',
  },
  {
    id: 'raw',
    label: 'Base64 only',
    extension: 'txt',
    summary: 'The encoded bytes alone, with no data: prefix',
  },
  {
    id: 'html',
    label: 'HTML <img>',
    extension: 'html',
    summary: 'A complete tag, with the output dimensions filled in',
  },
  {
    id: 'css',
    label: 'CSS background',
    extension: 'css',
    summary: 'A background-image declaration',
  },
  {
    id: 'markdown',
    label: 'Markdown',
    extension: 'md',
    summary: 'An inline image, for READMEs and issues',
  },
];

export const BASE64_FORMAT_IDS = BASE64_FORMATS.map((format) => format.id);

export const DEFAULT_BASE64_FORMAT = 'data-url';

/** @returns {Base64Format} the named format, or the default one. */
export function base64FormatById(id) {
  return BASE64_FORMATS.find((format) => format.id === id)
    ?? BASE64_FORMATS.find((format) => format.id === DEFAULT_BASE64_FORMAT);
}

// `String.fromCharCode(...bytes)` blows the argument limit somewhere around a
// hundred thousand bytes, which is a small photo. Chunking keeps it to stack
// frames the engine is happy with while still being one `btoa` per chunk.
const CHUNK = 0x8000;

/**
 * Encode raw bytes as standard (padded, non-URL-safe) base64.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {string}
 */
export function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }

  return btoa(binary);
}

/**
 * Encode a blob's bytes as base64.
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * How long the base64 of `byteLength` bytes will be, without encoding it.
 * Used to warn about the size before spending the memory.
 *
 * @param {number} byteLength
 * @returns {number} characters
 */
export function base64Length(byteLength) {
  const n = Math.max(0, Math.floor(Number(byteLength) || 0));
  return 4 * Math.ceil(n / 3);
}

/**
 * @param {string} mime
 * @param {string} base64
 * @returns {string}
 */
export function dataUrl(mime, base64) {
  return `data:${mime || 'application/octet-stream'};base64,${base64}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);

// Brackets and backslashes are the only characters that can end a Markdown alt
// text early; everything else survives inside one.
const escapeMarkdown = (text) => String(text ?? '').replace(/[\\[\]]/g, '\\$&');

/**
 * Wrap an encoded image in the chosen snippet.
 *
 * @param {string} formatId one of `BASE64_FORMAT_IDS`
 * @param {object} image
 * @param {string} image.base64
 * @param {string} image.mime
 * @param {string} [image.name] used as alt text
 * @param {number} [image.width]
 * @param {number} [image.height]
 * @returns {string}
 */
export function base64Snippet(formatId, image) {
  const { base64 = '', mime = '', name = 'image', width, height } = image || {};
  const url = dataUrl(mime, base64);

  switch (base64FormatById(formatId).id) {
    case 'raw':
      return base64;

    case 'html': {
      const size = Number.isFinite(width) && Number.isFinite(height)
        ? ` width="${Math.round(width)}" height="${Math.round(height)}"`
        : '';
      return `<img src="${url}" alt="${escapeHtml(baseName(name))}"${size}>`;
    }

    case 'css':
      return `background-image: url("${url}");`;

    case 'markdown':
      return `![${escapeMarkdown(baseName(name))}](${url})`;

    default:
      return url;
  }
}

/**
 * Filename for saving a snippet as text: the image's own name with the
 * snippet's extension appended, so `photo.webp` becomes `photo.webp.txt` and
 * stays recognisable next to the image it came from.
 *
 * @param {string} name the converted image's filename
 * @param {string} formatId
 * @returns {string}
 */
export function snippetFilename(name, formatId) {
  const safe = sanitizeFilename(name || 'image');
  return `${safe}.${base64FormatById(formatId).extension}`;
}
