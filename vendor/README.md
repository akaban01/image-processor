# Vendored binaries

Everything in here is a third-party file committed as-is. The app has no build
step and makes no third-party network requests, so anything it needs at runtime
has to live in the repository and be served from this origin.

Nothing here is loaded on page load. The background matte fetches it the first
time someone asks for it, and the service worker caches it from then on.

## onnxruntime/ — ONNX Runtime Web 1.27.0

MIT licence. From the npm package `onnxruntime-web@1.27.0`, `dist/`:

| File | Why |
| --- | --- |
| `ort.wasm.min.mjs` | the ES module entry point, WASM backend only |
| `ort-wasm-simd-threaded.mjs` | Emscripten glue, loaded by the above |
| `ort-wasm-simd-threaded.wasm` | the runtime itself |

The WebGPU and WebGL builds are deliberately absent: they add ~25 MB and this
model runs acceptably on WASM. Threads are switched off at runtime — GitHub
Pages sends no COOP/COEP headers, so `SharedArrayBuffer` is unavailable anyway.

To update: `npm pack onnxruntime-web@<version>`, copy those three files, and
re-run the browser tests. The version is pinned in `js/segment-worker.js`'s
comment as well, so both should move together.

## models/ — MODNet (fp16)

Apache 2.0. `modnet-fp16.onnx` is the fp16 ONNX export of MODNet, taken from
the Hugging Face repository [`Xenova/modnet`][xenova] (`onnx/model_fp16.onnx`),
which is an export of [ZHKKKe/MODNet][modnet] — "MODNet: Real-Time Trimap-Free
Portrait Matting via Objective Decomposition", Ke et al., AAAI 2022.

Input `input`: float32 `[1, 3, H, W]`, RGB, scaled to −1…1, with H and W any
multiple of 32. Output `output`: float32 `[1, 1, H, W]` alpha in 0…1.

fp16 rather than the other exports for a measured reason: the int8 quantized
export (6.5 MB) produces a visibly broken matte — a washed-out mask with holes
through the face — while fp16 is indistinguishable from the 25 MB fp32 export
at half its size. If you swap this file, look at the output on a real photo
before believing it.

[xenova]: https://huggingface.co/Xenova/modnet
[modnet]: https://github.com/ZHKKKe/MODNet
