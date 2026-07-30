# Image Converter

A front-end-only image converter: change format, resize, and tune quality entirely in the
browser. No build step, no dependencies, no server — files never leave the device.

## Features

- **Formats** — convert to PNG, JPEG, WebP or AVIF. The format list is probed at load time,
  so only formats the current browser can actually encode are offered.
- **Quality** — a 0.05–1.00 slider for lossy formats (JPEG/WebP/AVIF).
- **Resize** — four modes:
  - *Keep original size*
  - *Scale by percentage* (1–200%)
  - *Fit within box* — constrain width, height or both, with an optional "don't enlarge" guard
  - *Exact dimensions* — stretch to the given size, or keep the aspect ratio and centre-crop
- **Batch** — drop, browse or paste up to 200 images at once; download them individually or
  as a single `.zip`.
- **Quality-preserving downscale** — large reductions are done in halving steps to avoid the
  aliasing a single-pass `drawImage` produces.
- **Transparency handling** — pick the background colour used when saving an image with an
  alpha channel to a format without one (JPEG).
- EXIF orientation is honoured, settings persist in `localStorage`, and the UI follows the
  system light/dark theme.

## Running locally

ES modules need a real HTTP origin, so open it through any static server rather than
`file://`:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying to GitHub Pages

The site is plain static files at the repository root, so it can be published either way:

- **GitHub Actions** (what `.github/workflows/deploy.yml` does): in
  *Settings → Pages → Build and deployment*, set **Source** to **GitHub Actions**. Every push
  to `main` then publishes the site.
- **Branch**: set **Source** to **Deploy from a branch**, pick the branch and the `/ (root)`
  folder. The included `.nojekyll` file keeps Jekyll from touching the assets.

## Project layout

```
index.html          markup and the settings form
css/styles.css      styling, light/dark themes
js/app.js           UI wiring: file intake, list rendering, batch run, downloads
js/converter.js     decode → resize geometry → canvas draw → encode
js/zip.js           minimal store-only ZIP writer for "Download all"
```

## Browser support

Needs `canvas.toBlob`, ES modules and `createImageBitmap` — Chrome/Edge 79+, Firefox 90+,
Safari 15+. WebP encoding is available in all current browsers; AVIF encoding is not
universal and is hidden automatically where it is missing.
