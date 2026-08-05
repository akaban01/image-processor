# Image Converter

A client-side image converter: change format, resize, transform, and hit a target file
size — entirely in the browser. No build step, no runtime dependencies, no server. Files
never leave the device.

```
index.html                markup and the settings form
css/styles.css            styling, light/dark themes
sw.js                     service worker (offline support)
js/app.js                 the only file that touches the DOM
js/worker.js              conversion worker (OffscreenCanvas)
js/lib/
  batch.js                runs a set of images with bounded concurrency
  bytes.js                size formatting and parsing
  convert.js              orient → resize → encode, for one image
  documents.js            visa/ID photo standards and compliance checks
  dpi.js                  print resolution stamping for JPEG output
  encode.js               canvas → Blob, and the target-size search
  formats.js              format registry and capability probing
  framing.js              head placement and the capture crop
  geometry.js             pure resize/crop maths
  intake.js               drops, folders, paste, de-duplication
  matte.js                separating a portrait from a plain backdrop
  naming.js               filename templates and collision handling
  pipeline.js             worker pool vs. main-thread fallback
  pool.js                 the worker pool itself
  render.js               canvas drawing and multi-step downscaling
  settings.js             defaults, validation, presets, persistence
  zip.js                  streaming ZIP writer
test/                     unit tests (node:test)
test/e2e/                 browser tests (Playwright)
```

## Features

**Formats** — WebP, AVIF, JPEG and PNG. The list is probed at load time by encoding a
1×1 canvas, so only formats the browser can genuinely produce are offered; the rest are
shown greyed out with a reason. A **Smallest** mode encodes every available format and
keeps whichever came out smallest, per image.

**Target file size** — ask for "under 500 KB" and the quality is binary-searched to the
highest value that fits, typically in 4–8 encodes. If even the lowest quality overshoots,
the image is progressively scaled down instead of being pushed into blocking artefacts.

**Resize** — five modes: limit the longest edge, fit inside a box, fill a box and crop to
a nine-point anchor, scale by percentage, or stretch to exact dimensions. "Never enlarge"
leaves already-small images alone.

**Transform** — rotate in quarter turns and flip on either axis. EXIF orientation is
applied on decode, so photos shot in portrait convert the way they were taken.

**Batch** — drop files *or folders*, browse, or paste. Conversions run in parallel across
a pool of workers, one per core (up to four), with per-image progress and a cancel button
that stops work immediately. Download individually or as a single `.zip`.

**Quality-preserving downscale** — large reductions are done in halving steps rather than
one jump, which is what stops a 4000px photo turning crunchy at 200px.

**Filename patterns** — `{name}`, `{ext}`, `{w}`, `{h}`, `{format}`, `{index}`, `{date}`.
Collisions get a `-2` suffix; path separators and reserved names are stripped.

**Presets** for the common jobs: web page, thumbnail, email attachment, social card,
archive quality.

**Visa & ID photos** — pick a standard and the format, dimensions, background and size
limit are set for you. Included: the **Umrah / Hajj eVisa** photo for Saudi Arabia
(600 × 600 JPEG, white background, under 200 KB), the same photo sized for a **2 × 2 in
print**, and a **35 × 45 mm** passport-style photo for agency paperwork. Each converted
image is then checked against the standard and marked pass or fail, alongside the rules
only a person can judge — background, lighting, how the face is framed. **Take a photo**
opens the device camera with a head outline drawn on the standard's own grid — crown
ticks, an eye line, and a shaded band the chin has to land in — and captures exactly the
rectangle you framed, so the crop holds no surprises. The preview is mirrored, the way a
mirror is, so leaning right moves you right; the file never is, because a document photo
has to be a true likeness. The capture is converted
immediately, giving a finished photo in two clicks. **Replace the background** floods in
from the edges of the frame and repaints everything it reaches — the wall goes white while
the person stays put. It is a matte, not a segmentation model: it works on a plain, evenly
lit backdrop, and when the flood finds something else the card says so rather than shipping
a mangled photo quietly. Print standards
stamp the JPEG with its resolution, so 600 × 600 at 300 DPI prints at exactly 2 × 2 in
rather than at whatever size the print shop guesses.

Settings and theme persist in `localStorage`, the UI follows the system theme unless told
otherwise, and the whole app works offline once visited.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>O</kbd> | Add files |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>V</kbd> | Paste images |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> | Convert |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>S</kbd> | Download all |
| <kbd>Esc</kbd> | Cancel a running batch |

## How it works

Decoding a large photo and re-encoding it as AVIF is hundreds of milliseconds of blocking
work, so it happens off the main thread:

```
File ──► WorkerPool ──► worker.js ──► createImageBitmap (EXIF-aware)
                                 └──► rotate/flip ──► crop ──► halving downscale
                                 └──► encode (+ size search)  ──► Blob
```

Two fallbacks keep it honest. A browser without `OffscreenCanvas` runs the identical
pipeline on the main thread — `js/lib/convert.js` takes a `createCanvas` factory precisely
so there is one implementation rather than two. And SVG, which no browser can decode in a
worker, is decoded with an `<img>` element on the main thread and converted there.

`canvas.toBlob` silently returns a PNG when asked for a format it does not know, which
would hand you a `.avif` file that is really a PNG. Every encode checks the resulting
blob's type and fails loudly instead.

The ZIP writer stores rather than deflates — every format here is already entropy-coded,
so deflate would cost CPU and usually add bytes. Entry data is never read into a
`Uint8Array`: only the CRC pass touches it, in 1 MiB slices, and the archive is assembled
from the original `Blob` references, so a multi-gigabyte batch stays backed by the
browser's blob store rather than the JS heap. Zip64 records are emitted when the archive
outgrows the 32-bit fields.

## Running locally

ES modules and workers both need a real HTTP origin, so serve it rather than opening
`file://`:

```bash
python3 -m http.server 8000   # or: npm run serve
# then visit http://localhost:8000
```

## Tests

```bash
npm test          # unit tests — no dependencies, no browser
npm run test:e2e  # browser tests (installs Playwright's Chromium on first run)
```

The unit suite covers the pure modules: resize geometry across every mode and edge case,
the target-size search, filename templating and sanitisation, settings validation, the
photo standards and their compliance checks, JPEG density stamping, batch concurrency and
cancellation, and the ZIP writer — whose output is additionally verified
by the system `unzip` when it is installed.

The browser suite drives the real app in Chromium against real PNG fixtures generated by
a small encoder in `test/e2e/fixtures.js`, and asserts on actual output dimensions,
formats and filenames. The guided capture is driven end to end against Chromium's fake
camera device, down to checking that closing the viewfinder stops every track. It fails
the run on any console error.

Both run in CI on every push (`.github/workflows/ci.yml`), and the unit suite gates
deployment.

## Deploying to GitHub Pages

The site is plain static files at the repository root:

- **GitHub Actions** (what `.github/workflows/deploy.yml` does): in *Settings → Pages →
  Build and deployment*, set **Source** to **GitHub Actions**. Every push to the default
  branch publishes the site once the unit tests pass.
- **Branch**: set **Source** to **Deploy from a branch**, pick the branch and `/ (root)`.
  The `.nojekyll` file keeps Jekyll from touching the assets.

The service worker registers only over HTTPS, so offline support is live on Pages and
inert on a plain-HTTP local server.

## Browser support

Needs `canvas.toBlob`, ES modules and `createImageBitmap`: Chrome/Edge 79+, Firefox 90+,
Safari 15+. The parallel worker pipeline additionally needs `OffscreenCanvas`
(Chrome 69+, Firefox 105+, Safari 16.4+); older browsers fall back to the main thread and
say so in the footer. WebP encoding is available everywhere current; AVIF encoding is not,
and is hidden automatically where it is missing. The guided camera needs `getUserMedia`
and a secure origin (HTTPS or localhost); where either is missing the button simply does
not appear and files can still be added the usual ways.

## Privacy

There is no server, no analytics, no network request of any kind after the page loads.
Conversions run on the CPU in the tab. The camera stream is drawn straight to a canvas in
the same tab and every track is stopped when the viewfinder closes; no frame is uploaded,
stored or kept after you close the window. As a side effect of going through a canvas, all
metadata — EXIF, GPS coordinates, camera serial numbers — is dropped from the output.
